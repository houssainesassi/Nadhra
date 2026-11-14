// Nadhra AI step N1 in the page: the setting, the network guard and the controller. With Nadhra AI
// selected nothing leaves the page (no question, picture, recording, live token, cloud voice or
// report), every AI feature is refused out loud, and nothing is quietly handed to Gemini. Switching
// is explicit and persistent; Gemini comes back unchanged. Fake camera, voice and server only.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { SpeakOptions, TtsEngine } from "../src/lib/speech/tts.ts";
import type { CameraSource, CapturedFrame, GrayFrame } from "../src/lib/assistant/cameraSource.ts";
import type { SceneAnalysis } from "../src/lib/assistant/types.ts";
import type { VoiceInput, VoiceResult } from "../src/lib/assistant/voiceInput.ts";
import { speech } from "../src/lib/assistant/phrases.ts";
import { providerOf, sanitizeVisionSettings, DEFAULT_VISION_SETTINGS } from "../src/lib/assistant/settings.ts";

// --- a minimal browser -------------------------------------------------------------------------
const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = () => {};
g.removeEventListener = () => {};
const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
g.document = doc;
const storage = new Map<string, string>();
const consent = () => (storage.set("assistant.consent.v3", "1"), storage.set("assistant.readConsent.v1", "1"), storage.set("assistant.liveConsent.v1", "1"));
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});
Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [] } });
Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, get: () => true });
g.SpeechRecognition = function () {};

/** Every request the page makes. Only the status GET (no user data) is expected with Nadhra AI. */
const requests: { url: string; method: string; body: string }[] = [];
const sent = () => requests.filter((r) => !(r.method === "GET" && r.url === "/api/vision"));
g.fetch = async (url: string, init?: { method?: string; body?: string }) => {
  requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ?? "" });
  if (String(url).includes("/api/report") || String(url).includes("/api/session")) return new Response("{}", { status: 200 });
  if (init?.method === "POST") return new Response(JSON.stringify({ analysis: scene(), provider: "fake", latencyMs: 1 }), { status: 200 });
  return new Response(JSON.stringify({ available: true, providers: [], canTranscribe: true, nadhra: { experimental: true, tasks: [] } }), { status: 200 });
};

const { SmartVisionController } = await import("../src/lib/assistant/controller.ts");
const api = await import("../src/lib/assistant/api.ts");
const client = await import("../src/lib/assistant/client.ts");

class FakeEngine implements TtsEngine {
  readonly name = "fake";
  said: string[] = [];
  localOnly: boolean[] = [];
  private live: SpeakOptions | null = null;
  available() { return true; }
  voiceInfo() { return null; }
  setLocalOnly(on: boolean) { this.localOnly.push(on); }
  speak(text: string, opts: SpeakOptions) { this.said.push(text); this.live = opts; }
  stop() { this.live = null; }
  end() { const l = this.live; this.live = null; l?.onEnd?.(); }
}
class FakeSource implements CameraSource {
  readonly kind = "fake";
  readonly facing = "environment" as const;
  started = false;
  stopped = false;
  private seed = 1;
  async start() { this.started = true; }
  stop() { this.stopped = true; }
  isLive() { return this.started && !this.stopped; }
  capture(): CapturedFrame { return { base64: "/9j/AAAA", at: Date.now() }; }
  thumbnail(width: number, height: number): GrayFrame {
    const px = new Uint8ClampedArray(width * height * 4);
    let x = this.seed++;
    for (let i = 0; i < width * height; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; const v = 60 + (x % 121); px.set([v, v, v, 255], i * 4); }
    return { rgba: px, width, height };
  }
  videoElement() { return {} as HTMLVideoElement; }
  onEnded() {}
}
class FakeDetector { load() { return Promise.resolve(); } detect() { return []; } close() {} }
class FakeVoice implements VoiceInput {
  readonly kind = "recognition" as const;
  aborted = 0;
  listen(): Promise<VoiceResult> { return new Promise(() => {}); }
  abort() { this.aborted++; }
  finish() {}
}
function scene(p: Partial<SceneAnalysis> = {}): SceneAnalysis {
  return { spoken: "قدّامك باب.", changed: true, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false, ...p };
}
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const T = speech("tn");
const REFUSAL = `${T.nadhra.unavailable} ${T.nadhra.needsGemini}`;

const open: InstanceType<typeof SmartVisionController>[] = [];
afterEach(() => {
  for (const c of open.splice(0)) c.detach();
  api.setLocalOnly(false);
  storage.clear();
  requests.length = 0;
});

function setup(opts: { provider?: "nadhra"; autoDescribe?: boolean; voice?: FakeVoice } = {}) {
  if (opts.provider || opts.autoDescribe) storage.set("assistant.settings", JSON.stringify({ ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.autoDescribe ? { autoDescribe: true } : {}) }));
  const c = new SmartVisionController();
  const engine = new FakeEngine();
  const sources: FakeSource[] = [];
  const any = c as unknown as Record<string, unknown>;
  any.makeSource = () => { const s = new FakeSource(); sources.push(s); return s; };
  any.detector = new FakeDetector();
  any.detectorLoadTimeoutMs = 50;
  if (opts.voice) any.voiceInput = opts.voice;
  c.attach({} as HTMLVideoElement, { tts: engine });
  open.push(c);
  return {
    c, engine, sources, any,
    async start() {
      await c.startCamera();
      clearInterval(any.tickTimer as ReturnType<typeof setInterval>);
      any.tickTimer = null;
      await flush();
    },
    tick: () => (any.tick as () => void).call(c),
    drain() { for (let i = 0; i < 30 && c.state.speaking; i++) engine.end(); },
  };
}

// --- the setting ---------------------------------------------------------------------------------

test("settings: Gemini by default (field absent); only an explicit \"nadhra\" is kept", () => {
  assert.equal("provider" in DEFAULT_VISION_SETTINGS, false);
  assert.equal(providerOf(DEFAULT_VISION_SETTINGS), "gemini");
  assert.equal(sanitizeVisionSettings({ provider: "nadhra" }).provider, "nadhra");
  for (const v of ["gemini", "Nadhra", "cloud", 1, null, undefined]) {
    const s = sanitizeVisionSettings({ provider: v });
    assert.equal("provider" in s, false, String(v));
    assert.equal(providerOf(s), "gemini");
  }
});

// --- the network guard ---------------------------------------------------------------------------

test("guard: with Nadhra selected no API request leaves the page, and reports aren't queued", async () => {
  api.setLocalOnly(true);
  await assert.rejects(api.apiFetch("/api/vision", { method: "POST", body: "{}" }), (e: unknown) => e instanceof api.LocalOnlyError);
  for (const call of [
    () => client.analyzeFrame({ mode: "scan", image: "x", cameraFacing: "outward", lang: "tn" }),
    () => client.askStreaming({ mode: "chat", question: "?", cameraFacing: "outward", lang: "tn" }, () => {}),
    () => client.transcribeWav("UklGRg==", "tn"),
  ]) {
    await assert.rejects(call(), (e: unknown) => e instanceof client.VisionApiError && e.code === "nadhra-unavailable");
  }
  api.report("question-failed", "x");
  api.flushReports();
  assert.deepEqual(requests, [], "nothing at all was fetched");
  api.setLocalOnly(false);
});

// --- Nadhra selected on an earlier visit ---------------------------------------------------------

test("nadhra: the camera starts without the Google notice, only on-device warnings run, nothing is sent", async () => {
  const h = setup({ provider: "nadhra", autoDescribe: true }); // no consent stored at all
  assert.equal(api.isLocalOnly(), true, "the guard is closed as soon as the page loads");
  assert.deepEqual(h.engine.localOnly, [true], "the voice is local only");
  await h.start();
  assert.equal(h.c.state.camera, "on");
  assert.equal(h.c.state.needsConsent, false);
  assert.equal(h.c.state.analysis, "local");
  assert.ok(h.engine.said.includes(T.nadhra.cameraNotice) || (h.drain(), h.engine.said.includes(T.nadhra.cameraNotice)), "says what works and that nothing is sent");
  assert.ok(!h.engine.said.includes(T.privacy), "no notice about Google");
  for (let i = 0; i < 6; i++) {
    h.any.lastScanAt = -Infinity;
    h.tick();
    await flush();
  }
  assert.deepEqual(sent(), [], "automatic descriptions stored as on still send nothing");
});

test("nadhra: questions, readings, medicine questions, tasks and live are refused out loud; nothing sent", async () => {
  const h = setup({ provider: "nadhra" });
  // A task with the camera off: refused without even starting the camera.
  await h.c.runTask("front");
  assert.equal(h.sources.length, 0);
  assert.equal(h.engine.said.at(-1), REFUSAL);

  await h.start();
  for (const action of [
    () => h.c.ask("شنوة قدّامي؟"),
    () => h.c.ask("قدّاش من حبة نشرب من الدوا؟"),
    () => h.c.readDocument(),
    () => h.c.readDocument("شنوة مكتوب؟"),
    () => h.c.runTask("read"),
    () => h.c.startLive(),
  ]) {
    h.engine.said.length = 0;
    await action();
    await flush();
    assert.equal(h.engine.said.at(-1), REFUSAL);
  }
  assert.equal(h.c.state.live.status, "off");
  assert.equal(h.c.state.liveNotice, false);
  // English question: refused in English.
  await h.c.ask("What is in front of me?");
  assert.equal(h.engine.said.at(-1), `${speech("en").nadhra.unavailable} ${speech("en").nadhra.needsGemini}`);
  assert.deepEqual(sent(), []);
});

test("nadhra: voice commands are off (the browser's recognition would send the voice to Google)", async () => {
  const voice = new FakeVoice();
  const h = setup({ provider: "nadhra", voice });
  h.c.toggleAssistant();
  assert.equal(h.c.state.assistantOn, false);
  assert.equal(h.c.state.mic, "unavailable");
  assert.equal(h.engine.said.at(-1), T.nadhra.noVoice);
  await h.c.askByVoice();
  assert.equal(h.engine.said.at(-1), T.nadhra.noVoice);
  assert.deepEqual(sent(), []);
});

test("nadhra: automatic descriptions can't be turned on (said why); other settings still change", () => {
  const h = setup({ provider: "nadhra" });
  h.c.updateSettings({ autoDescribe: true });
  assert.equal(h.c.state.settings.autoDescribe, false);
  assert.equal(h.engine.said.at(-1), REFUSAL);
  h.c.updateSettings({ autoDescribe: true, rate: 0.8 });
  assert.equal(h.c.state.settings.autoDescribe, false);
  assert.equal(h.c.state.settings.rate, 0.8);
});

// --- switching -----------------------------------------------------------------------------------

test("switch to Nadhra mid-use: everything that sends stops at once, the choice is saved", async () => {
  consent();
  const voice = new FakeVoice();
  const h = setup({ autoDescribe: true, voice });
  await h.start();
  h.c.toggleAssistant();
  assert.equal(h.c.state.assistantOn, true);
  assert.equal(h.c.state.analysis, "watching");

  h.c.updateSettings({ provider: "nadhra" });
  assert.equal(h.engine.said.at(-1), T.nadhra.selected);
  assert.equal(h.c.state.assistantOn, false, "voice commands off");
  assert.ok(voice.aborted > 0, "the open microphone was closed");
  assert.equal(h.c.state.analysis, "local");
  assert.equal(api.isLocalOnly(), true);
  assert.deepEqual(h.engine.localOnly, [false, true]);
  assert.equal(JSON.parse(storage.get("assistant.settings")!).provider, "nadhra", "persisted");

  requests.length = 0;
  h.any.lastScanAt = -Infinity;
  h.tick();
  await h.c.ask("شنوة قدّامي؟");
  await flush();
  assert.deepEqual(sent(), []);

  // A new visit keeps the choice.
  const again = setup();
  assert.equal(providerOf(again.c.state.settings), "nadhra");
  assert.equal(api.isLocalOnly(), true);
});

test("switch back to Gemini with consent: today's behaviour, and the request carries no provider field", async () => {
  consent();
  const h = setup({ provider: "nadhra" });
  await h.start();
  h.c.updateSettings({ provider: "gemini" });
  assert.equal(h.engine.said.at(-1), T.nadhra.geminiSelected);
  assert.equal(api.isLocalOnly(), false);
  assert.equal(h.c.state.analysis, "manual");
  assert.equal(h.c.state.camera, "on");
  requests.length = 0;
  await h.c.ask("شنوة قدّامي؟");
  await flush();
  const posts = sent().filter((r) => r.url === "/api/vision" && r.method === "POST");
  assert.equal(posts.length, 1, "Gemini answers again");
  assert.equal("provider" in JSON.parse(posts[0].body), false, "a Gemini request is exactly today's");
});

test("switch to Gemini without the Google notice accepted: the camera stops and the notice is asked first", async () => {
  const h = setup({ provider: "nadhra" });
  await h.start();
  assert.equal(h.c.state.camera, "on");
  h.c.updateSettings({ provider: "gemini" });
  assert.equal(h.c.state.camera, "off", "no picture can go out before consent");
  assert.equal(h.c.state.needsConsent, true);
  h.drain(); // the notice plays after the confirmation
  assert.deepEqual(h.engine.said.slice(-2), [T.nadhra.geminiSelected, T.privacy]);
  assert.deepEqual(sent(), []);
});

test("Gemini (default): no Nadhra wording, no guard, the voice is not local-only", async () => {
  consent();
  const h = setup();
  assert.equal(api.isLocalOnly(), false);
  assert.deepEqual(h.engine.localOnly, [false]);
  await h.start();
  assert.equal(h.c.state.analysis, "manual");
  h.drain();
  const nadhraWords = Object.values(T.nadhra);
  assert.ok(h.engine.said.every((s) => !nadhraWords.includes(s)));
});
