// Cloud TTS fallback (Microsoft Edge voice): server route (validation, limits, errors, no key leaks) and the
// client engines (browser-first priority, caching, queueing, retry, autoplay) with fakes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------- server
// Fake Microsoft Edge TTS WebSocket: records what we send, replies like the real service.
type Script = "ok" | "refuse" | "refuse-once" | "close-early" | "no-audio" | "hang" | "bad-frame";
const sockets: { url: string; headers: Record<string, string>; sent: string[] }[] = [];
let script: Script = "ok";
let refusals = 0;

function audioFrame(payload: string, contentType = true) {
  const head = new TextEncoder().encode(`X-RequestId:abc\r\n${contentType ? "Content-Type:audio/mpeg\r\n" : ""}Path:audio`);
  const body = new TextEncoder().encode(payload);
  const buf = new Uint8Array(2 + head.length + body.length);
  buf[0] = head.length >> 8;
  buf[1] = head.length & 0xff;
  buf.set(head, 2);
  buf.set(body, 2 + head.length);
  return buf.buffer;
}

class FakeWs {
  binaryType = "blob";
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  closed = false;
  rec: { url: string; headers: Record<string, string>; sent: string[] };
  constructor(url: string, headers: Record<string, string>) {
    this.rec = { url, headers, sent: [] };
    sockets.push(this.rec);
    setTimeout(() => {
      if (script === "refuse" || (script === "refuse-once" && refusals++ === 0)) {
        this.onerror?.({});
        this.onclose?.({ code: 1006, reason: "" });
      } else this.onopen?.({});
    }, 0);
  }
  send(data: string) {
    this.rec.sent.push(data);
    if (!data.includes("Path:ssml")) return;
    const emit = (d: unknown) => setTimeout(() => !this.closed && this.onmessage?.({ data: d }), 0);
    if (script === "hang") return;
    if (script === "close-early") return setTimeout(() => this.onclose?.({ code: 1007, reason: "" }), 0);
    emit("X-RequestId:abc\r\nPath:turn.start\r\n\r\n{}");
    if (script === "bad-frame") emit(new Uint8Array([0xff]).buffer);
    if (script !== "no-audio") {
      emit(audioFrame("MP3"));
      emit(audioFrame("DATA"));
    }
    emit(audioFrame("", false)); // end-of-stream frame without Content-Type
    emit("X-RequestId:abc\r\nPath:turn.end\r\n\r\n{}");
  }
  close() {
    this.closed = true;
  }
}

const { handleTtsPost, ttsStatus, validateTtsText, normalizeRate, prosodyRate, buildSsml, resetTtsState, setWsFactory, MAX_TTS_CHARS } = await import(
  "../src/lib/speech/edgeTts.ts"
);
const { secMsGec } = await import("../src/lib/speech/edgeDrm.ts");

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://app.test/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", host: "app.test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  setWsFactory((url, headers) => new FakeWs(url, headers));
  sockets.length = 0;
  script = "ok";
  refusals = 0;
  delete process.env.EDGE_TTS_VOICE;
  delete process.env.EDGE_TTS_DISABLED;
  delete process.env.EDGE_TTS_TIMEOUT_MS;
  process.env.TTS_RATE_LIMIT_PER_MIN = "30";
  resetTtsState();
});

test("drm: Sec-MS-GEC matches reference edge-tts 7.3.1 vectors", () => {
  // Generated with: python -c "from edge_tts.drm import generate_sec_ms_gec_v2 as g; print(g(t))"
  const vectors: Record<string, string> = {
    "0": "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6",
    "1700000000": "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
    "1762473600.5": "A291D20BB9AC0DB7-398C20FF99C0DAFDABADC909DC54FBF60F2C70D8EB7F7FDC50B40933E0E4322F",
    "1800000123": "99E54519B490BE5C-E162DB0977FBDCB9B86DD8148BF1BCDC3C0303176CE39852A42B415935C20654",
    "2000000000": "2D62557F1142BC5D-FD9C30C68FF194A5EE6B45FEFC5E2BA1D1239F88A90569AB55CFFFAA7799F40E",
  };
  for (const [t, expected] of Object.entries(vectors)) assert.equal(secMsGec(Number(t)), expected, `t=${t}`);
  assert.equal(secMsGec(1700000000), secMsGec(1700000000 - 100), "same 5-minute window -> same token");
});

test("server: synthesizes MP3 with the Tunisian voice, no key, Edge handshake", async () => {
  const res = await handleTtsPost(post({ text: "  عسلامة   لاباس. ", rate: 0.9 }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/mpeg");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "MP3DATA");
  assert.equal(sockets.length, 1);
  const s = sockets[0];
  assert.match(s.url, /^wss:\/\/speech\.platform\.bing\.com\/consumer\/speech\/synthesize\/readaloud\/edge\/v1\?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=[0-9a-f]{32}&Sec-MS-GEC=[0-9A-F]{16}-[0-9A-F]{64}&Sec-MS-GEC-Version=2-/);
  assert.equal(s.headers.Origin, "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold");
  assert.match(s.headers["User-Agent"], /Edg\/\d+/);
  assert.match(s.sent[0], /Path:speech\.config/);
  assert.match(s.sent[0], /audio-24khz-48kbitrate-mono-mp3/);
  assert.match(s.sent[1], /Path:ssml\r\n\r\n<speak /);
  assert.ok(s.sent[1].includes("<voice name='ar-TN-ReemNeural'><prosody pitch='+0Hz' rate='-10%' volume='+0%'>عسلامة لاباس.</prosody>"));
});

test("server: SSML escapes markup in the sentence; rate maps to prosody", () => {
  const ssml = buildSsml(`a<b>&'"`, "ar-TN-ReemNeural", 1);
  assert.ok(ssml.includes("a&lt;b&gt;&amp;&apos;&quot;"));
  assert.ok(!ssml.includes("<b>"));
  assert.equal(prosodyRate(1), "+0%");
  assert.equal(prosodyRate(1.5), "+50%");
  assert.equal(prosodyRate(0.5), "-50%");
});

test("server: status reports enabled + voice; custom voice honoured, invalid ignored; can be disabled", async () => {
  assert.deepEqual(ttsStatus(), { configured: true, provider: "edge", voice: "ar-TN-ReemNeural", languageCode: "ar-TN", maxChars: MAX_TTS_CHARS });
  process.env.EDGE_TTS_VOICE = "ar-SA-ZariyahNeural";
  assert.equal(ttsStatus().voice, "ar-SA-ZariyahNeural");
  assert.equal(ttsStatus().languageCode, "ar-SA");
  process.env.EDGE_TTS_VOICE = "x'/><evil";
  assert.equal(ttsStatus().voice, "ar-TN-ReemNeural");
  // The assistant's voice is female: a male voice in the environment is refused.
  for (const male of ["ar-TN-HediNeural", "ar-SA-HamedNeural", "fr-FR-HenriNeural"]) {
    process.env.EDGE_TTS_VOICE = male;
    assert.equal(ttsStatus().voice, "ar-TN-ReemNeural", male);
  }
  process.env.EDGE_TTS_DISABLED = "1";
  assert.equal(ttsStatus().configured, false);
  const res = await handleTtsPost(post({ text: "مرحبا" }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "not-configured" });
  assert.equal(sockets.length, 0);
});

test("server: input validation and length limits", async () => {
  assert.equal(validateTtsText(42).ok, false);
  assert.equal(validateTtsText("   ").ok, false);
  assert.equal(validateTtsText("...؟؟").ok, false);
  assert.equal(validateTtsText("ا".repeat(MAX_TTS_CHARS + 1)).ok, false);
  assert.deepEqual(validateTtsText("a\u0000b\n c"), { ok: true, text: "a b c" });
  assert.equal(normalizeRate(9), 1.5);
  assert.equal(normalizeRate("fast"), 1);
  assert.equal(normalizeRate(0.94), 0.9);
  for (const body of ["{not json", { text: "" }, { text: "ا".repeat(MAX_TTS_CHARS + 1) }, { nope: 1 }]) {
    assert.equal((await handleTtsPost(post(body))).status, 400);
  }
  const big = await handleTtsPost(post({ text: "x" }, { "content-length": "100000" }));
  assert.equal(big.status, 413);
  assert.equal(sockets.length, 0);
});

test("server: cross-origin requests are refused", async () => {
  const res = await handleTtsPost(post({ text: "مرحبا" }, { origin: "https://evil.example" }));
  assert.equal(res.status, 403);
  const ok = await handleTtsPost(post({ text: "مرحبا" }, { origin: "http://app.test" }));
  assert.equal(ok.status, 200);
});

test("server: per-client rate limit", async () => {
  process.env.TTS_RATE_LIMIT_PER_MIN = "2";
  const h = { "x-forwarded-for": "9.9.9.9" };
  assert.equal((await handleTtsPost(post({ text: "واحد" }, h))).status, 200);
  assert.equal((await handleTtsPost(post({ text: "اثنان" }, h))).status, 200);
  assert.equal((await handleTtsPost(post({ text: "ثلاثة" }, h))).status, 429);
  assert.equal((await handleTtsPost(post({ text: "ثلاثة" }, { "x-forwarded-for": "8.8.8.8" }))).status, 200);
});

test("server: a refused handshake is retried once", async () => {
  script = "refuse-once";
  const res = await handleTtsPost(post({ text: "مرحبا" }));
  assert.equal(res.status, 200);
  assert.equal(sockets.length, 2);
});

test("server: upstream failures map to clean errors; repeated failures trigger a cooldown", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const s of ["close-early", "no-audio", "bad-frame"] as Script[]) {
      resetTtsState();
      script = s;
      const res = await handleTtsPost(post({ text: "مرحبا" }));
      assert.equal(res.status, 502, s);
      assert.deepEqual(await res.json(), { error: "upstream-error" });
    }
    resetTtsState();
    sockets.length = 0;
    script = "refuse";
    for (let i = 0; i < 3; i++) assert.equal((await handleTtsPost(post({ text: "مرحبا" }))).status, 502);
    assert.equal(sockets.length, 6, "each refused request = 1 attempt + 1 retry");
    const res = await handleTtsPost(post({ text: "مرحبا" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "upstream-unavailable" });
    assert.ok(res.headers.get("retry-after"));
    assert.equal(sockets.length, 6, "no upstream call during cooldown");
  } finally {
    console.error = quiet;
  }
});

test("server: timeout -> 504; error logs never contain the sentence", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    process.env.EDGE_TTS_TIMEOUT_MS = "30";
    script = "hang";
    assert.equal((await handleTtsPost(post({ text: "جملة سرية جدا" }))).status, 504);
    script = "close-early";
    assert.equal((await handleTtsPost(post({ text: "جملة سرية جدا" }))).status, 502);
  } finally {
    console.error = orig;
  }
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((l) => !l.includes("جملة سرية")));
});

// ---------------------------------------------------------------- client
// Minimal fakes for window / speechSynthesis / AudioContext.
class FakeSource {
  buffer: unknown = null;
  onended: (() => void) | null = null;
  connect() {}
  start() {
    played.push(String(this.buffer));
    active.push(this);
  }
  stop() {
    this.onended?.();
  }
}
class FakeAudioContext {
  static allowResume = true;
  state: "suspended" | "running" = "suspended";
  destination = {};
  async resume() {
    if (FakeAudioContext.allowResume) this.state = "running";
    else await new Promise(() => {}); // never resolves without a gesture
  }
  createBufferSource() {
    return new FakeSource();
  }
  createBuffer() {
    return "silence";
  }
  async decodeAudioData(buf: ArrayBuffer) {
    return new TextDecoder().decode(buf);
  }
}
let played: string[] = [];
let active: FakeSource[] = [];
const browserSpoken: string[] = [];
let browserVoices: { name: string; lang: string }[] = [];
let browserFail: string | null = null;

class FakeUtterance {
  text: string;
  lang = "";
  voice: unknown = null;
  rate = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(t: string) {
    this.text = t;
  }
}
const g = globalThis as any;
g.window = g;
g.AudioContext = FakeAudioContext;
g.SpeechSynthesisUtterance = FakeUtterance;
g.speechSynthesis = {
  speaking: false,
  getVoices: () => browserVoices,
  addEventListener() {},
  cancel() {},
  speak(u: FakeUtterance) {
    browserSpoken.push(u.text);
    setTimeout(() => (browserFail ? u.onerror?.({ error: browserFail }) : (u.onstart?.(), u.onend?.())), 0);
  },
};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

let clientCalls: string[] = [];
let clientConfigured = true;
let clientPostStatus = 200;
const clientFetch = (async (_url: string, init?: RequestInit) => {
  if (!init?.method) return new Response(JSON.stringify({ configured: clientConfigured, voice: "ar-TN-ReemNeural", languageCode: "ar-TN" }));
  const { text } = JSON.parse(String(init.body));
  clientCalls.push(text);
  if (clientPostStatus !== 200) return new Response(JSON.stringify({ error: clientPostStatus === 503 ? "not-configured" : "upstream-error" }), { status: clientPostStatus });
  return new Response(`audio:${text}`);
}) as typeof fetch;

const { HybridTts, CloudTts } = await import("../src/lib/speech/tts.ts");
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function events() {
  const log: string[] = [];
  return {
    log,
    opts: (rate = 1, interrupt = true) => ({
      rate,
      interrupt,
      onPreparing: () => log.push("preparing"),
      onStart: () => log.push("start"),
      onEnd: () => log.push("end"),
      onError: (e: string) => log.push(`error:${e}`),
    }),
  };
}

function resetClient() {
  globalThis.fetch = clientFetch;
  clientCalls = [];
  clientConfigured = true;
  clientPostStatus = 200;
  played = [];
  active = [];
  browserSpoken.length = 0;
  browserVoices = [];
  browserFail = null;
  FakeAudioContext.allowResume = true;
}

test("client: the female cloud voice is used first, even with an Arabic voice installed", async () => {
  resetClient();
  browserVoices = [{ name: "Majed", lang: "ar-SA" }];
  const tts = new HybridTts();
  await tick();
  assert.deepEqual(tts.voiceInfo(), { name: "Microsoft Edge ar-TN-ReemNeural", lang: "ar-TN", exactDialect: true, source: "cloud" });
  const ev = events();
  tts.speak("عسلامة.", ev.opts());
  await tick(20);
  assert.deepEqual(clientCalls, ["عسلامة."]);
  assert.deepEqual(browserSpoken, []);
});

test("client: without the cloud voice, the installed voice speaks", async () => {
  resetClient();
  clientConfigured = false;
  browserVoices = [{ name: "Hoda", lang: "ar-EG" }];
  const tts = new HybridTts();
  await tick();
  assert.equal(tts.voiceInfo()?.source, "browser");
  const ev = events();
  tts.speak("عسلامة.", ev.opts());
  await tick();
  assert.deepEqual(browserSpoken, ["عسلامة."]);
  assert.deepEqual(clientCalls, []);
  assert.deepEqual(ev.log, ["start", "end"]);
});

test("client: a failing cloud voice hands the sentence to the installed voice", async () => {
  resetClient();
  browserVoices = [{ name: "Hoda", lang: "ar-EG" }];
  clientPostStatus = 502;
  const tts = new HybridTts();
  await tick();
  const ev = events();
  tts.speak("عسلامة.", ev.opts());
  await tick(30);
  assert.deepEqual(clientCalls, ["عسلامة."]);
  assert.deepEqual(browserSpoken, ["عسلامة."]);
  assert.ok(!ev.log.some((e) => e.startsWith("error")), ev.log.join());
});

test("client: no Arabic browser voice -> cloud voice plays", async () => {
  resetClient();
  browserVoices = [{ name: "English", lang: "en-US" }];
  const tts = new HybridTts();
  assert.equal(tts.checking(), true);
  await tick();
  assert.equal(tts.checking(), false);
  assert.equal(tts.voiceInfo()?.source, "cloud");
  assert.deepEqual(tts.voiceInfo(), { name: "Microsoft Edge ar-TN-ReemNeural", lang: "ar-TN", exactDialect: true, source: "cloud" });
  const ev = events();
  tts.speak("عسلامة لاباس.", ev.opts());
  await tick(20);
  assert.deepEqual(clientCalls, ["عسلامة لاباس."]);
  assert.deepEqual(played, ["audio:عسلامة لاباس."]);
  assert.deepEqual(ev.log, ["preparing", "start"]);
  active.at(-1)!.stop(); // playback finished
  assert.deepEqual(ev.log, ["preparing", "start", "end"]);
  assert.deepEqual(browserSpoken, []);
});

test("client: speaking before the availability check finishes waits for it", async () => {
  resetClient();
  const tts = new HybridTts();
  const ev = events();
  tts.speak("مرحبا.", ev.opts()); // probe still in flight
  await tick(20);
  assert.deepEqual(clientCalls, ["مرحبا."]);
  assert.equal(ev.log[0], "preparing");
});

test("client: browser voice failure falls back to the cloud voice", async () => {
  resetClient();
  browserVoices = [{ name: "Broken", lang: "ar" }];
  browserFail = "synthesis-failed";
  const tts = new HybridTts();
  await tick();
  const ev = events();
  tts.speak("مرحبا.", ev.opts());
  await tick(20);
  assert.deepEqual(clientCalls, ["مرحبا."]);
  assert.deepEqual(played, ["audio:مرحبا."]);
});

test("client: replaying the same sentence uses the cache (one request)", async () => {
  resetClient();
  const tts = new CloudTts();
  await tts.ready();
  tts.speak("نعاونك.", events().opts());
  await tick(10);
  tts.speak("نعاونك.", events().opts()); // 🔊 replay
  await tick(10);
  assert.deepEqual(clientCalls, ["نعاونك."]);
  assert.deepEqual(played, ["audio:نعاونك.", "audio:نعاونك."]);
});

test("client: automatic sentences queue instead of cutting each other off", async () => {
  resetClient();
  const tts = new CloudTts();
  await tts.ready();
  const a = events();
  const b = events();
  tts.speak("الأولى.", a.opts(1, false));
  await tick(10);
  tts.speak("الثانية.", b.opts(1, false));
  await tick(10);
  assert.deepEqual(played, ["audio:الأولى."], "second waits for the first");
  active.at(-1)!.stop(); // first finishes naturally
  await tick(10);
  assert.deepEqual(played, ["audio:الأولى.", "audio:الثانية."]);
  assert.deepEqual(a.log, ["preparing", "start", "end"]);
  assert.deepEqual(b.log, ["preparing", "start"]);
});

test("client: manual speak interrupts; stop() cancels queued sentences", async () => {
  resetClient();
  const tts = new CloudTts();
  await tts.ready();
  tts.speak("قديمة.", events().opts());
  await tick(10);
  tts.speak("جديدة.", events().opts()); // interrupt=true
  await tick(10);
  assert.deepEqual(played, ["audio:قديمة.", "audio:جديدة."]);
  tts.speak("في الطابور.", events().opts(1, false));
  tts.stop();
  await tick(10);
  assert.equal(played.length, 2, "queued sentence was cancelled");
});

test("client: failures show an error, are not cached, and retry works", async () => {
  resetClient();
  const tts = new CloudTts();
  await tts.ready();
  clientPostStatus = 502;
  const ev = events();
  tts.speak("خدمة.", ev.opts());
  await tick(10);
  assert.match(ev.log.at(-1)!, /^error:تعذّر/);
  assert.equal(played.length, 0);
  clientPostStatus = 200;
  const ev2 = events();
  tts.speak("خدمة.", ev2.opts()); // retry
  await tick(10);
  assert.deepEqual(clientCalls, ["خدمة.", "خدمة."]);
  assert.deepEqual(played, ["audio:خدمة."]);
  assert.deepEqual(ev2.log, ["preparing", "start"]);
});

test("client: offline -> clear error without a request", async () => {
  resetClient();
  const tts = new CloudTts();
  await tts.ready();
  (globalThis.navigator as any).onLine = false;
  const ev = events();
  tts.speak("اليوم.", ev.opts());
  await tick(10);
  (globalThis.navigator as any).onLine = true;
  assert.deepEqual(clientCalls, []);
  assert.match(ev.log.at(-1)!, /إنترنت/);
});

test("client: autoplay blocked -> asks for a tap instead of hanging", async () => {
  resetClient();
  FakeAudioContext.allowResume = false;
  const tts = new CloudTts();
  await tts.ready();
  const ev = events();
  tts.speak("مرحبا.", ev.opts());
  await tick(500);
  assert.match(ev.log.at(-1)!, /اضغط/);
  assert.equal(played.length, 0);
});

test("client: cloud voice disabled on the server -> unavailable, browser behaviour kept", async () => {
  resetClient();
  clientConfigured = false;
  const tts = new HybridTts();
  await tick();
  assert.equal(tts.voiceInfo(), null);
  assert.equal(tts.checking(), false);
  tts.speak("مرحبا.", events().opts());
  await tick();
  assert.deepEqual(browserSpoken, ["مرحبا."]);
  assert.deepEqual(clientCalls, []);
});

test("speechText: slash read as «أو», symbols removed, spacing cleaned", async () => {
  const { speechText } = await import("../src/lib/speech/tts.ts");
  assert.equal(speechText("خال / عم"), "خال أو عم");
  assert.equal(speechText("«مرحبا»  ( تاكسي ) ؟"), "مرحبا تاكسي؟");
});

test("voice choice: exact dialect first, installed voice preferred offline", async () => {
  const { pickArabicVoice } = await import("../src/lib/speech/tts.ts");
  const v = (name: string, lang: string, localService = false) => ({ name, lang, localService, default: false }) as unknown as SpeechSynthesisVoice;
  const voices = [v("Google العربية", "ar-SA"), v("Local SA", "ar-SA", true), v("Tunisia", "ar-TN"), v("English", "en-US", true)];
  assert.equal(pickArabicVoice(voices)?.name, "Tunisia");
  assert.equal(pickArabicVoice(voices, { offline: true })?.name, "Local SA");
  assert.equal(pickArabicVoice([v("x", "ar_EG")])?.name, "x");
  assert.equal(pickArabicVoice([v("English", "en-US")]), null);
});

test("client: after repeated cloud failures the cloud voice cools down", async () => {
  resetClient();
  clientPostStatus = 500;
  const tts = new CloudTts();
  await tts.ready();
  for (let i = 0; i < CloudTts.MAX_FAILURES; i++) {
    const ev = events();
    tts.speak(`جملة ${i}`, ev.opts());
    await tick(20);
    assert.ok(ev.log.some((l) => l.startsWith("error:")));
  }
  assert.equal(tts.usable(), false);
  assert.ok(tts.coolingDownMs() > 50_000);
});

test("client: dispose() removes every event listener and closes the AudioContext", async () => {
  resetClient();
  browserVoices = [{ name: "Majed", lang: "ar-SA" }];
  // track listeners on window and speechSynthesis
  const live = new Map<string, number>();
  const add = (k: string) => live.set(k, (live.get(k) ?? 0) + 1);
  const del = (k: string) => live.set(k, (live.get(k) ?? 0) - 1);
  const saved = { add: g.addEventListener, remove: g.removeEventListener, sAdd: g.speechSynthesis.addEventListener };
  g.addEventListener = (t: string) => add(`window:${t}`);
  g.removeEventListener = (t: string) => del(`window:${t}`);
  g.speechSynthesis.addEventListener = (t: string) => add(`speech:${t}`);
  g.speechSynthesis.removeEventListener = (t: string) => del(`speech:${t}`);
  let closed = 0;
  (FakeAudioContext.prototype as any).close = async function (this: { state: string }) {
    this.state = "closed";
    closed++;
  };
  try {
    const tts = new HybridTts();
    await tick();
    tts.unlock(); // creates the cloud AudioContext
    assert.ok([...live.values()].some((n) => n > 0), "listeners registered");
    tts.dispose();
    for (const [k, n] of live) assert.equal(n, 0, `listener ${k} left behind`);
    assert.equal(closed, 1, "AudioContext closed");
  } finally {
    g.addEventListener = saved.add;
    g.removeEventListener = saved.remove;
    g.speechSynthesis.addEventListener = saved.sAdd;
    delete g.speechSynthesis.removeEventListener;
    delete (FakeAudioContext.prototype as any).close;
  }
});

test("server: other languages use their own voice, from a fixed list only", async () => {
  sockets.length = 0;
  script = "ok";
  for (const [lang, voice] of [["fr", "fr-FR-DeniseNeural"], ["en", "en-US-JennyNeural"], ["ar", "ar-SA-ZariyahNeural"], ["xx", "ar-TN-ReemNeural"], [undefined, "ar-TN-ReemNeural"]] as const) {
    sockets.length = 0;
    const res = await handleTtsPost(post({ text: "Bonjour.", rate: 1, lang, voice: "en-US-EvilNeural" }));
    assert.equal(res.status, 200, String(lang));
    assert.ok(sockets[0].sent[1].includes(`<voice name='${voice}'>`), `${lang} -> ${voice}`);
  }
});

test("client: the voice follows the speech language, and the cloud gets the language", async () => {
  resetClient();
  browserVoices = [{ name: "Tunisia", lang: "ar-TN" }];
  const tts = new HybridTts();
  await tick();
  assert.equal(tts.voiceInfo()?.name, "Microsoft Edge ar-TN-ReemNeural");
  tts.setLanguage("fr");
  assert.equal(tts.voiceInfo()?.source, "cloud", "no French voice installed: the cloud voice");
  assert.deepEqual(tts.voiceInfo(), { name: "Microsoft Edge fr-FR-DeniseNeural", lang: "fr-FR", exactDialect: true, source: "cloud" });
  const bodies: unknown[] = [];
  const base = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method) bodies.push(JSON.parse(String(init.body)));
    return base(url, init);
  }) as typeof fetch;
  tts.speak("Une porte / un mur.", events().opts());
  await tick(20);
  assert.deepEqual(bodies, [{ text: "Une porte ou un mur.", rate: 1, lang: "fr" }]);
});

test("voice choice: by speech language", async () => {
  const { pickVoice, speechText } = await import("../src/lib/speech/tts.ts");
  const v = (name: string, lang: string, localService = false) => ({ name, lang, localService, default: false }) as unknown as SpeechSynthesisVoice;
  const voices = [v("Thomas", "fr-CA"), v("Amélie", "fr-FR"), v("Samantha", "en-US"), v("Tunisia", "ar-TN"), v("Maged", "ar-SA")];
  assert.equal(pickVoice(voices, "fr")?.name, "Amélie");
  assert.equal(pickVoice(voices, "en")?.name, "Samantha");
  assert.equal(pickVoice(voices, "ar")?.name, "Tunisia", "a known male voice loses to any other Arabic voice");
  assert.equal(pickVoice(voices, "tn")?.name, "Tunisia");
  // Female first, by name: browsers don't report a voice's gender.
  assert.equal(pickVoice([v("Microsoft Naayf", "ar-SA"), v("Microsoft Hoda", "ar-EG")], "tn")?.name, "Microsoft Hoda");
  assert.equal(pickVoice([v("Microsoft Naayf", "ar-SA"), v("Microsoft Hoda", "ar-EG")], "ar")?.name, "Microsoft Hoda");
  assert.equal(pickVoice([v("Microsoft Hamed", "ar-SA"), v("Zariyah", "ar-SA")], "ar")?.name, "Zariyah");
  assert.equal(pickVoice([v("Maged", "ar-SA")], "ar")?.name, "Maged", "a male voice only when it is the only one");
  assert.equal(pickVoice([v("Samantha", "en-US")], "fr"), null, "never an English voice for French");
  assert.equal(speechText("rouge / bleu", "fr"), "rouge ou bleu");
  assert.equal(speechText("red / blue", "en"), "red or blue");
});
