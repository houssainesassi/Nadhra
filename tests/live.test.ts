// Live conversation: female voice only, locked token setup, audio helpers, and the session's
// reconnect / resume / interrupt behaviour against a fake WebSocket. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIVE_VOICE, FEMALE_LIVE_VOICES, liveSystemPrompt, parseLiveModels, pickLiveVoice } from "../src/lib/live/config.ts";
import { base64ToBytes, bytesToBase64, floatToPcm16, pcm16ToFloat, rms } from "../src/lib/live/pcm.ts";
import { LevelVad } from "../src/lib/live/audioIO.ts";
import { LiveSession, type LiveStatus } from "../src/lib/live/session.ts";
import { buildLiveSetup, liveConfig } from "../src/lib/server/liveToken.ts";
import { browserHeaders } from "./helpers/browser.ts";

test("voice: only female voices, whatever the environment says", () => {
  assert.equal(pickLiveVoice(undefined), DEFAULT_LIVE_VOICE);
  assert.equal(pickLiveVoice("Kore"), "Kore");
  for (const male of ["Puck", "Charon", "Fenrir", "Orus", "Algenib", "Iapetus", "Umbriel", "Rasalgethi", "Alnilam", "x'; drop"]) assert.equal(pickLiveVoice(male), DEFAULT_LIVE_VOICE, male);
  assert.ok((FEMALE_LIVE_VOICES as readonly string[]).includes(DEFAULT_LIVE_VOICE));
});

test("models: comma list, junk dropped, defaults when empty", () => {
  assert.deepEqual(parseLiveModels("gemini-3.8-live, gemini-3.8-live ,evil/../x"), ["gemini-3.8-live"]);
  assert.deepEqual(parseLiveModels(""), ["gemini-3.1-flash-live-preview", "gemini-3.8-live"]);
});

test("prompt: Derja by default, safety rules, mirrored sides for a user-facing webcam", () => {
  const p = liveSystemPrompt("tn", "outward");
  assert.match(p, /Tunisian Arabic \(Derja/);
  assert.match(p, /Never speak Modern Standard Arabic, Egyptian/);
  assert.match(p, /never tell them to cross/);
  assert.match(p, /Never say who a person is/);
  assert.match(p, /left of the image is their left/);
  assert.match(liveSystemPrompt("tn", "user"), /LEFT of the image is the user's RIGHT/);
  assert.match(liveSystemPrompt("fr", "outward"), /Speak French/);
});

test("token setup: model, female voice, instructions, VAD, transcripts, resumption, compression", () => {
  const saved = { ...process.env };
  try {
    process.env.GEMINI_API_KEY = "k";
    process.env.GEMINI_LIVE_VOICE = "Puck"; // male: refused
    process.env.GEMINI_LIVE_MODELS = "gemini-3.1-flash-live-preview,gemini-3.8-live";
    const c = liveConfig();
    assert.equal(c.voice, DEFAULT_LIVE_VOICE);
    const s = buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 1, handle: "abc" }, c);
    assert.equal(s.model, "models/gemini-3.8-live");
    assert.deepEqual(s.generationConfig.responseModalities, ["AUDIO"]);
    assert.equal(s.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, DEFAULT_LIVE_VOICE);
    assert.match(s.systemInstruction.parts[0].text, /Derja/);
    assert.deepEqual(s.sessionResumption, { handle: "abc" });
    assert.deepEqual(s.contextWindowCompression, { slidingWindow: {} });
    assert.equal(s.realtimeInputConfig.automaticActivityDetection.silenceDurationMs, 500);
    assert.equal(buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 9 }, c).model, "models/gemini-3.8-live", "index clamped");
    assert.deepEqual(buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 0 }, c).sessionResumption, {});
  } finally {
    process.env = saved;
  }
});

test("token route: locked setup sent to Google, key never returned, cross-site refused", async () => {
  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: any; headers: any }[] = [];
  try {
    process.env.GEMINI_API_KEY = "secret-key";
    delete process.env.GEMINI_LIVE_MODELS;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
      return new Response(JSON.stringify({ name: "auth_tokens/xyz" }));
    }) as typeof fetch;
    const { POST } = await import("../src/app/api/live/token/route.ts");
    const res = await POST(new Request("http://localhost/api/live/token", { method: "POST", headers: browserHeaders("localhost"), body: JSON.stringify({ lang: "tn", facing: "user", handle: "h1" }) }));
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.token, "auth_tokens/xyz");
    assert.ok(!JSON.stringify(d).includes("secret-key"));
    assert.equal(d.voice, DEFAULT_LIVE_VOICE);
    assert.equal(d.model, "gemini-3.1-flash-live-preview");
    assert.equal(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/auth_tokens");
    assert.equal(sent[0].body.uses, 1);
    assert.deepEqual(sent[0].body.bidiGenerateContentSetup, d.setup, "the browser sends exactly the locked setup");
    assert.deepEqual(sent[0].body.bidiGenerateContentSetup.sessionResumption, { handle: "h1" });
    assert.match(sent[0].body.bidiGenerateContentSetup.systemInstruction.parts[0].text, /user's RIGHT/);

    const bad = await POST(new Request("http://localhost/api/live/token", { method: "POST", headers: browserHeaders("localhost"), body: JSON.stringify({ handle: "x y\"<>" }) }));
    assert.deepEqual((await bad.json()).setup.sessionResumption, {}, "malformed handle ignored");

    const cross = await POST(new Request("http://localhost/api/live/token", { method: "POST", headers: { ...browserHeaders("localhost"), origin: "https://evil.example" }, body: "{}" }));
    assert.equal(cross.status, 403);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test("pcm: 48 kHz float to 16 kHz int16 and back", () => {
  const n = 4800;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
  const pcm = floatToPcm16(f, 48000, 16000);
  assert.equal(pcm.length, 1600);
  const back = pcm16ToFloat(new Uint8Array(pcm.buffer));
  assert.ok(Math.abs(rms(back) - rms(f)) < 0.02);
  assert.deepEqual(floatToPcm16(new Float32Array([2, -2]), 16000, 16000), new Int16Array([32767, -32768]), "clipped");
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
});

test("level detector: speech start and end, a click doesn't count", () => {
  const ev: string[] = [];
  const vad = new LevelVad(() => ev.push("start"), (at) => ev.push(`end@${at}`));
  let t = 0;
  const feed = (level: number, ms: number) => {
    for (let i = 0; i < ms / 40; i++) vad.feed(level, 40, (t += 40));
  };
  feed(0.002, 400);
  feed(0.2, 40); // a click
  feed(0.002, 400);
  assert.deepEqual(ev, []);
  feed(0.1, 600);
  assert.deepEqual(ev, ["start"]);
  const lastVoice = t;
  feed(0.002, 600);
  assert.deepEqual(ev, ["start", `end@${lastVoice}`]);
});

// ---------------------------------------------------------------------------------------------
// LiveSession against a fake socket

class FakeWs {
  static all: FakeWs[] = [];
  static failSetupFor = new Set<string>();
  readyState = 0;
  binaryType = "";
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
    }, 1);
  }
  send(data: string) {
    const m = JSON.parse(data);
    this.sent.push(m);
    if (m.setup) {
      if (FakeWs.failSetupFor.has(m.setup.model)) return setTimeout(() => this.drop(1011, "unavailable"), 1);
      setTimeout(() => this.serve({ setupComplete: {} }), 1);
    }
  }
  /** Server messages arrive as binary frames, like Gemini's. */
  serve(m: unknown) {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(m)).buffer });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  close() {
    this.readyState = 3;
  }
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function makeSession(over: Partial<ConstructorParameters<typeof LiveSession>[0]> = {}) {
  const tokens: any[] = [];
  const log: string[] = [];
  const statuses: LiveStatus[] = [];
  const audio: Uint8Array[] = [];
  let now = 1000;
  const models = ["m-fast", "m-slow"];
  const s = new LiveSession(
    {
      lang: "tn",
      facing: "outward",
      WebSocketImpl: FakeWs as unknown as typeof WebSocket,
      now: () => now,
      fetchImpl: (async (_u: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        tokens.push(body);
        const model = models[Math.min(body.modelIndex, 1)];
        return new Response(JSON.stringify({ token: `t${tokens.length}`, url: "wss://x", setup: { model, sessionResumption: body.handle ? { handle: body.handle } : {} }, model, voice: "Sulafat", lastModel: body.modelIndex >= 1 }));
      }) as typeof fetch,
      ...over,
    },
    {
      status: (st) => statuses.push(st),
      audio: (b) => audio.push(b),
      interrupted: () => log.push("interrupted"),
      turnComplete: () => log.push("turn"),
      userText: (t) => log.push(`user:${t}`),
      aiText: (t) => log.push(`ai:${t}`),
      userSpeechStart: () => log.push("speech-start"),
      latency: (ms) => log.push(`latency:${ms}`),
    },
  );
  return { s, tokens, log, statuses, audio, setNow: (t: number) => (now = t) };
}

test("session: connects with the token and sends exactly the locked setup", async () => {
  FakeWs.all = [];
  const { s, statuses } = makeSession();
  await s.start();
  assert.equal(s.status, "open");
  assert.equal(s.model, "m-fast");
  assert.equal(s.voice, "Sulafat");
  assert.match(FakeWs.all[0].url, /^wss:\/\/x\?access_token=t1$/);
  assert.deepEqual(FakeWs.all[0].sent[0], { setup: { model: "m-fast", sessionResumption: {} } });
  assert.deepEqual(statuses, ["connecting", "open"]);
  s.stop();
});

test("session: a model that can't be reached falls back to the next", async () => {
  FakeWs.all = [];
  FakeWs.failSetupFor = new Set(["m-fast"]);
  const { s, tokens } = makeSession();
  await s.start();
  assert.equal(s.model, "m-slow");
  assert.deepEqual(tokens.map((t) => t.modelIndex), [0, 1]);
  FakeWs.failSetupFor = new Set();
  s.stop();
});

test("session: audio, transcripts, interruption and latency", async () => {
  FakeWs.all = [];
  const { s, log, audio, setNow } = makeSession();
  await s.start();
  const ws = FakeWs.all[0];
  s.sendAudio(new Uint8Array([1, 2]));
  s.sendFrame("/9j/AAA");
  assert.deepEqual(ws.sent[1], { realtimeInput: { audio: { data: "AQI=", mimeType: "audio/pcm;rate=16000" } } });
  assert.deepEqual(ws.sent[2], { realtimeInput: { video: { data: "/9j/AAA", mimeType: "image/jpeg" } } });
  ws.serve({ voiceActivity: { type: "ACTIVITY_START" } });
  s.markSpeechEnd(1200); // our detector saw the end first
  setNow(1500);
  ws.serve({ voiceActivity: { type: "ACTIVITY_END" } }); // later: must not move the end
  setNow(1450 + 230);
  ws.serve({ serverContent: { inputTranscription: { text: "شنوة" } } });
  ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAEC", mimeType: "audio/pcm;rate=24000" } }] }, outputTranscription: { text: "توّا" } } });
  ws.serve({ serverContent: { modelTurn: { parts: [{ inlineData: { data: "AwQ=" } }] } } });
  ws.serve({ serverContent: { interrupted: true } });
  ws.serve({ serverContent: { turnComplete: true } });
  await wait();
  assert.equal(audio.length, 2);
  assert.deepEqual([...audio[0]], [0, 1, 2]);
  assert.deepEqual(log, ["speech-start", "user:شنوة", "latency:480", "ai:توّا", "interrupted", "turn"]);
  s.stop();
});

test("session: a dropped connection resumes the same conversation, keeping what was said meanwhile", async () => {
  FakeWs.all = [];
  const { s, tokens, statuses } = makeSession();
  await s.start();
  FakeWs.all[0].serve({ sessionResumptionUpdate: { newHandle: "H1", resumable: true } });
  await wait();
  FakeWs.all[0].drop(1006);
  assert.equal(s.status, "reconnecting");
  s.sendAudio(new Uint8Array([9, 9])); // the user keeps talking during the drop
  await wait(600);
  assert.equal(s.status, "open");
  assert.equal(tokens[1].handle, "H1");
  assert.equal(tokens[1].modelIndex, 0, "same model: the handle belongs to it");
  const ws2 = FakeWs.all[1];
  assert.deepEqual(ws2.sent[0].setup.sessionResumption, { handle: "H1" });
  assert.deepEqual(ws2.sent[1], { realtimeInput: { audio: { data: "CQk=", mimeType: "audio/pcm;rate=16000" } } }, "buffered audio sent after resuming");
  assert.deepEqual(statuses, ["connecting", "open", "reconnecting", "open"]);
  s.stop();
});

test("session: go-away opens the next connection before the old one closes", async () => {
  FakeWs.all = [];
  const { s, tokens } = makeSession();
  await s.start();
  FakeWs.all[0].serve({ sessionResumptionUpdate: { newHandle: "H2", resumable: true } });
  FakeWs.all[0].serve({ goAway: { timeLeft: "5s" } });
  await wait(30);
  assert.equal(s.status, "open");
  assert.equal(FakeWs.all.length, 2);
  assert.equal(tokens[1].handle, "H2");
  FakeWs.all[0].drop(1000); // the old one closing must not trigger another reconnect
  await wait(30);
  assert.equal(FakeWs.all.length, 2);
  s.stop();
});

test("session: not configured fails at once; stop sends nothing more", async () => {
  FakeWs.all = [];
  const { s, statuses } = makeSession({ fetchImpl: (async () => new Response(JSON.stringify({ error: "not-configured" }), { status: 503 })) as typeof fetch });
  await assert.rejects(s.start());
  assert.equal(s.status, "failed");
  assert.deepEqual(statuses, ["connecting", "failed"]);
  const ok = makeSession();
  await ok.s.start();
  ok.s.stop();
  ok.s.sendAudio(new Uint8Array([1]));
  assert.equal(ok.s.sendFrame("x"), false);
  assert.equal(FakeWs.all.at(-1)!.sent.length, 1, "only the setup");
  assert.equal(ok.s.status, "closed");
});
