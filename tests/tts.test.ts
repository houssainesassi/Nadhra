// The assistant's voice (Google Gemini TTS, Sulafat, the only voice): server route (validation,
// limits, errors, no key or sentence leaks) and the client engine (no fallback voice, caching,
// queueing, retry, autoplay) with fakes.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

// ---------------------------------------------------------------- server
// Fake Gemini generateContent endpoint: records each request, replies like the real service.
type Script = "ok" | "rate-limited" | "server-error" | "no-audio" | "hang";
const upstream: { url: string; headers: Headers; body: any }[] = [];
let script: Script = "ok";
const PCM = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]);
const serverFetch = (async (url: string, init?: RequestInit) => {
  upstream.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
  if (script === "hang") {
    return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  }
  if (script === "rate-limited") return new Response("{}", { status: 429 });
  if (script === "server-error") return new Response("{}", { status: 500 });
  const parts = script === "no-audio" ? [{ text: "x" }] : [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: PCM.toString("base64") } }];
  return new Response(JSON.stringify({ candidates: [{ content: { parts } }] }));
}) as typeof fetch;

const { handleTtsPost, ttsStatus, validateTtsText, pcmToWav, resetTtsState, MAX_TTS_CHARS, TTS_VOICE } = await import("../src/lib/speech/geminiTts.ts");

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://app.test/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...browserHeaders(), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  globalThis.fetch = serverFetch;
  upstream.length = 0;
  script = "ok";
  process.env.GEMINI_API_KEY = "gem-secret";
  delete process.env.GEMINI_TTS_DISABLED;
  delete process.env.GEMINI_TTS_MODEL;
  delete process.env.GEMINI_TTS_TIMEOUT_MS;
  process.env.TTS_RATE_LIMIT_PER_MIN = "30";
  resetTtsState();
});

test("server: synthesizes WAV with Gemini TTS, voice Sulafat, the bare sentence only", async () => {
  const res = await handleTtsPost(post({ text: "  عسلامة   لاباس. ", rate: 0.9 }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "audio/wav");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const wav = Buffer.from(await res.arrayBuffer());
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000, "sample rate from the mime type");
  assert.deepEqual(wav.subarray(44), PCM);
  assert.equal(upstream.length, 1);
  const u = upstream[0];
  assert.equal(u.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash-tts:generateContent");
  assert.equal(u.headers.get("x-goog-api-key"), "gem-secret");
  assert.deepEqual(u.body.contents, [{ parts: [{ text: "عسلامة لاباس." }] }]);
  assert.deepEqual(u.body.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(u.body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Sulafat");
});

test("server: the voice is always Sulafat, whatever the client sends", async () => {
  for (const body of [{ text: "Bonjour.", lang: "fr" }, { text: "Hello.", lang: "en", voice: "Puck" }, { text: "مرحبا.", lang: "ar", voice: "ar-TN-ReemNeural" }]) {
    upstream.length = 0;
    assert.equal((await handleTtsPost(post(body))).status, 200);
    assert.equal(upstream[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Sulafat");
  }
  assert.equal(TTS_VOICE, "Sulafat");
});

test("server: status reports Sulafat; off without a key, when disabled, or in offline mode", async () => {
  assert.deepEqual(ttsStatus(), { configured: true, provider: "gemini", voice: "Sulafat", maxChars: MAX_TTS_CHARS });
  process.env.GEMINI_TTS_MODEL = "x'/><evil";
  await handleTtsPost(post({ text: "مرحبا" }));
  assert.match(upstream[0].url, /gemini-3\.8-flash-tts:/, "an invalid model name is ignored");
  process.env.GEMINI_TTS_DISABLED = "1";
  assert.equal(ttsStatus().configured, false);
  delete process.env.GEMINI_TTS_DISABLED;
  delete process.env.GEMINI_API_KEY;
  assert.equal(ttsStatus().configured, false);
  upstream.length = 0;
  const res = await handleTtsPost(post({ text: "مرحبا" }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "not-configured" });
  assert.equal(upstream.length, 0);
});

test("server: input validation and length limits", async () => {
  assert.equal(validateTtsText(42).ok, false);
  assert.equal(validateTtsText("   ").ok, false);
  assert.equal(validateTtsText("...؟؟").ok, false);
  assert.equal(validateTtsText("ا".repeat(MAX_TTS_CHARS + 1)).ok, false);
  assert.deepEqual(validateTtsText("a\u0000b\n c"), { ok: true, text: "a b c" });
  for (const body of ["{not json", { text: "" }, { text: "ا".repeat(MAX_TTS_CHARS + 1) }, { nope: 1 }]) {
    assert.equal((await handleTtsPost(post(body))).status, 400);
  }
  const big = await handleTtsPost(post({ text: "x" }, { "content-length": "100000" }));
  assert.equal(big.status, 413);
  assert.equal(upstream.length, 0);
});

test("server: WAV header", () => {
  const wav = Buffer.from(pcmToWav(new Uint8Array(10), 16000));
  assert.equal(wav.length, 54);
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(4), 46);
  assert.equal(wav.readUInt16LE(22), 1, "mono");
  assert.equal(wav.readUInt32LE(28), 32000, "byte rate");
  assert.equal(wav.readUInt16LE(34), 16, "16-bit");
  assert.equal(wav.readUInt32LE(40), 10);
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

test("server: upstream failures map to clean errors; repeated failures trigger a cooldown", async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const s of ["server-error", "no-audio"] as Script[]) {
      resetTtsState();
      script = s;
      const res = await handleTtsPost(post({ text: "مرحبا" }));
      assert.equal(res.status, 502, s);
      assert.deepEqual(await res.json(), { error: "upstream-error" });
    }
    resetTtsState();
    script = "rate-limited";
    const limited = await handleTtsPost(post({ text: "مرحبا" }));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate-limited" });
    resetTtsState();
    upstream.length = 0;
    script = "server-error";
    for (let i = 0; i < 3; i++) assert.equal((await handleTtsPost(post({ text: "مرحبا" }))).status, 502);
    assert.equal(upstream.length, 3, "no retry");
    const res = await handleTtsPost(post({ text: "مرحبا" }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "upstream-unavailable" });
    assert.ok(res.headers.get("retry-after"));
    assert.equal(upstream.length, 3, "no upstream call during cooldown");
  } finally {
    console.error = quiet;
  }
});

test("server: timeout -> 504; error logs never contain the sentence or the key", async () => {
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    process.env.GEMINI_TTS_TIMEOUT_MS = "30";
    script = "hang";
    assert.equal((await handleTtsPost(post({ text: "جملة سرية جدا" }))).status, 504);
    script = "server-error";
    const res = await handleTtsPost(post({ text: "جملة سرية جدا" }));
    assert.equal(res.status, 502);
    assert.ok(!(await res.text()).includes("gem-secret"));
  } finally {
    console.error = orig;
  }
  assert.ok(logs.length >= 2);
  assert.ok(logs.every((l) => !l.includes("جملة سرية") && !l.includes("gem-secret")));
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
// The browser has an Arabic voice: it must never be used, not even when Sulafat fails.
const browserSpoken: string[] = [];
const g = globalThis as any;
g.window = g;
g.AudioContext = FakeAudioContext;
g.SpeechSynthesisUtterance = class {
  text: string;
  constructor(t: string) {
    this.text = t;
  }
};
g.speechSynthesis = {
  speaking: false,
  getVoices: () => [{ name: "Hoda", lang: "ar-EG", localService: true }],
  addEventListener() {},
  cancel() {},
  speak(u: { text: string }) {
    browserSpoken.push(u.text);
  },
};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

let clientCalls: string[] = [];
let clientConfigured = true;
let clientPostStatus = 200;
const clientFetch = (async (_url: string, init?: RequestInit) => {
  if (!init?.method) return new Response(JSON.stringify({ configured: clientConfigured, provider: "gemini", voice: "Sulafat" }));
  const { text } = JSON.parse(String(init.body));
  clientCalls.push(text);
  if (clientPostStatus !== 200) return new Response(JSON.stringify({ error: clientPostStatus === 503 ? "not-configured" : "upstream-error" }), { status: clientPostStatus });
  return new Response(`audio:${text}`);
}) as typeof fetch;

const { SulafatTts } = await import("../src/lib/speech/tts.ts");
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
  FakeAudioContext.allowResume = true;
}

test("client: Sulafat is the voice, even with an Arabic voice installed in the browser", async () => {
  resetClient();
  const tts = new SulafatTts();
  assert.equal(tts.checking(), true);
  await tts.ready();
  assert.equal(tts.checking(), false);
  assert.deepEqual(tts.voiceInfo(), { name: "Google Gemini Sulafat", lang: "ar-TN", exactDialect: true, source: "cloud" });
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

test("client: a failing Sulafat gives a clear error, and no other voice says the sentence", async () => {
  resetClient();
  clientPostStatus = 502;
  const tts = new SulafatTts();
  await tts.ready();
  const ev = events();
  tts.speak("عسلامة.", ev.opts());
  await tick(30);
  assert.deepEqual(clientCalls, ["عسلامة."]);
  assert.deepEqual(browserSpoken, []);
  assert.match(ev.log.at(-1)!, /^error:.*Sulafat/);
});

test("client: Sulafat disabled on the server -> unavailable, a clear error, nothing else speaks", async () => {
  resetClient();
  clientConfigured = false;
  const tts = new SulafatTts();
  await tts.ready();
  assert.equal(tts.voiceInfo(), null);
  assert.equal(tts.available(), false);
  const ev = events();
  tts.speak("مرحبا.", ev.opts());
  await tick();
  assert.deepEqual(browserSpoken, []);
  assert.deepEqual(clientCalls, []);
  assert.match(ev.log.at(-1)!, /^error:.*Sulafat/);
});

test("client: speaking before the availability check finishes still uses Sulafat", async () => {
  resetClient();
  const tts = new SulafatTts();
  const ev = events();
  tts.speak("مرحبا.", ev.opts()); // probe still in flight
  await tick(20);
  assert.deepEqual(clientCalls, ["مرحبا."]);
  assert.equal(ev.log[0], "preparing");
  assert.deepEqual(browserSpoken, []);
});

test("client: replaying the same sentence uses the cache (one request)", async () => {
  resetClient();
  const tts = new SulafatTts();
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
  const tts = new SulafatTts();
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
  const tts = new SulafatTts();
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
  const tts = new SulafatTts();
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
  const tts = new SulafatTts();
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
  const tts = new SulafatTts();
  await tts.ready();
  const ev = events();
  tts.speak("مرحبا.", ev.opts());
  await tick(500);
  assert.match(ev.log.at(-1)!, /اضغط/);
  assert.equal(played.length, 0);
});

test("speechText: slash read as «أو», symbols removed, spacing cleaned", async () => {
  const { speechText } = await import("../src/lib/speech/tts.ts");
  assert.equal(speechText("خال / عم"), "خال أو عم");
  // Found in the browser test of document reading: dates, fractions and units must keep their slash.
  assert.equal(speechText("EXP : 03/2027", "fr"), "EXP : 03/2027");
  assert.equal(speechText("تاريخ الصلاحية 03 / 2027"), "تاريخ الصلاحية 03/2027");
  assert.equal(speechText("1/2 comprimé le soir", "fr"), "1/2 comprimé le soir");
  assert.equal(speechText("250 mg/5 ml", "fr"), "250 mg/5 ml");
  assert.equal(speechText("120 mg/ml", "fr"), "120 mg/ml");
  assert.equal(speechText("oui/non", "fr"), "oui ou non");
  assert.equal(speechText("left / right", "en"), "left or right");
  assert.equal(speechText("«مرحبا»  ( تاكسي ) ؟"), "مرحبا تاكسي؟");
});

test("client: after repeated cloud failures the cloud voice cools down", async () => {
  resetClient();
  clientPostStatus = 500;
  const tts = new SulafatTts();
  await tts.ready();
  for (let i = 0; i < SulafatTts.MAX_FAILURES; i++) {
    const ev = events();
    tts.speak(`جملة ${i}`, ev.opts());
    await tick(20);
    assert.ok(ev.log.some((l) => l.startsWith("error:")));
  }
  assert.equal(tts.usable(), false);
  assert.ok(tts.coolingDownMs() > 50_000);
  // While cooling down: a clear error at once, no request, no other voice.
  clientCalls = [];
  const ev = events();
  tts.speak("بعد.", ev.opts());
  await tick(10);
  assert.deepEqual(clientCalls, []);
  assert.deepEqual(browserSpoken, []);
  assert.match(ev.log.at(-1)!, /^error:.*Sulafat/);
});

test("client: dispose() closes the AudioContext", async () => {
  resetClient();
  let closed = 0;
  (FakeAudioContext.prototype as any).close = async function (this: { state: string }) {
    this.state = "closed";
    closed++;
  };
  try {
    const tts = new SulafatTts();
    await tts.ready();
    tts.unlock(); // creates the AudioContext
    tts.dispose();
    assert.equal(closed, 1, "AudioContext closed");
  } finally {
    delete (FakeAudioContext.prototype as any).close;
  }
});

test("client: every language is spoken by Sulafat; the server gets the language", async () => {
  resetClient();
  const tts = new SulafatTts();
  await tts.ready();
  tts.setLanguage("fr");
  assert.deepEqual(tts.voiceInfo(), { name: "Google Gemini Sulafat", lang: "fr", exactDialect: true, source: "cloud" });
  const bodies: unknown[] = [];
  const base = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (init?.method) bodies.push(JSON.parse(String(init.body)));
    return base(url, init);
  }) as typeof fetch;
  tts.speak("Une porte / un mur.", events().opts());
  await tick(20);
  assert.deepEqual(bodies, [{ text: "Une porte ou un mur.", rate: 1, lang: "fr" }]);
  assert.deepEqual(browserSpoken, []);
});

test("speechText: by speech language", async () => {
  const { speechText } = await import("../src/lib/speech/tts.ts");
  assert.equal(speechText("rouge / bleu", "fr"), "rouge ou bleu");
  assert.equal(speechText("red / blue", "en"), "red or blue");
});
