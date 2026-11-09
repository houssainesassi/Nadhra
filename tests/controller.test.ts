// The controller itself, with a fake camera, voice, detector and server. Covers the safety fixes:
// scans keep running during a long reading, warnings cut into it, detector failure is spoken,
// "Stop listening" never turns listening on, and the camera is released when the page is hidden.
// Nothing here touches a real camera, microphone, network or the Gemini quota.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import type { SpeakOptions, TtsEngine } from "../src/lib/speech/tts.ts";
import type { CameraSource, CapturedFrame, GrayFrame } from "../src/lib/assistant/cameraSource.ts";
import type { Hazard, SceneAnalysis } from "../src/lib/assistant/types.ts";
import type { VoiceInput, VoiceResult } from "../src/lib/assistant/voiceInput.ts";
import { speech, warningPhrase } from "../src/lib/assistant/phrases.ts";
import { parseCommand } from "../src/lib/assistant/commands.ts";

// --- a minimal browser -------------------------------------------------------------------------

type Listener = () => void;
const windowListeners = new Map<string, Set<Listener>>();
const docListeners = new Map<string, Set<Listener>>();
const on = (m: Map<string, Set<Listener>>) => (type: string, fn: Listener) => void (m.get(type) ?? m.set(type, new Set()).get(type)!).add(fn);
const off = (m: Map<string, Set<Listener>>) => (type: string, fn: Listener) => void m.get(type)?.delete(fn);
const fire = (m: Map<string, Set<Listener>>, type: string) => [...(m.get(type) ?? [])].forEach((fn) => fn());

const g = globalThis as Record<string, unknown>;
g.window = globalThis;
g.addEventListener = on(windowListeners);
g.removeEventListener = off(windowListeners);
const doc = { hidden: false, addEventListener: on(docListeners), removeEventListener: off(docListeners) };
g.document = doc;
const storage = new Map<string, string>([["assistant.consent.v1", "1"]]);
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
});
Object.defineProperty(globalThis.navigator, "mediaDevices", { configurable: true, value: { enumerateDevices: async () => [] } });
Object.defineProperty(globalThis.navigator, "onLine", { configurable: true, get: () => true });
g.SpeechRecognition = function () {}; // so the fake recognition input below is kept

function setHidden(hidden: boolean) {
  doc.hidden = hidden;
  fire(docListeners, "visibilitychange");
}

// The server: GET is the status, each POST takes the next prepared analysis.
const posts: unknown[] = [];
let replies: SceneAnalysis[] = [];
g.fetch = async (url: string, init?: { method?: string; body?: string }) => {
  if (init?.method === "POST") {
    posts.push(JSON.parse(init.body ?? "{}"));
    const analysis = replies.shift() ?? scene({});
    return new Response(JSON.stringify({ analysis, provider: "fake", latencyMs: 1 }), { status: 200 });
  }
  return new Response(JSON.stringify({ available: true, providers: [], canTranscribe: false }), { status: 200 });
};

const { SmartVisionController } = await import("../src/lib/assistant/controller.ts");

// --- fakes -------------------------------------------------------------------------------------

class FakeEngine implements TtsEngine {
  readonly name = "fake";
  said: string[] = [];
  stops = 0;
  private live: SpeakOptions | null = null;
  available() { return true; }
  voiceInfo() { return null; }
  speak(text: string, opts: SpeakOptions) {
    this.said.push(text);
    this.live = opts;
  }
  stop() {
    this.stops++;
    this.live = null;
  }
  /** The sentence playing now finishes. */
  end() {
    const live = this.live;
    this.live = null;
    live?.onEnd?.();
  }
  get last() { return this.said[this.said.length - 1]; }
}

function noise(w: number, h: number, seed: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  let x = seed;
  for (let i = 0; i < w * h; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const v = 60 + (x % 121);
    px.set([v, v, v, 255], i * 4);
  }
  return px;
}

class FakeSource implements CameraSource {
  readonly kind = "fake";
  readonly facing = "environment" as const;
  started = false;
  stopped = false;
  private seed = 1;
  private ended: (() => void) | null = null;
  async start() { this.started = true; }
  stop() { this.stopped = true; }
  isLive() { return this.started && !this.stopped; }
  capture(): CapturedFrame { return { base64: "/9j/AAAA", at: Date.now() }; }
  thumbnail(width: number, height: number): GrayFrame { return { rgba: noise(width, height, this.seed++), width, height }; }
  videoElement() { return {} as HTMLVideoElement; }
  onEnded(fn: () => void) { this.ended = fn; }
}

class FakeDetector {
  loads = 0;
  closed = 0;
  private behaviour: "ok" | "reject" | "hang" | "crash";
  constructor(behaviour: "ok" | "reject" | "hang" | "crash" = "ok") { this.behaviour = behaviour; }
  load() {
    this.loads++;
    if (this.behaviour === "reject") return Promise.reject(new Error("wasm fetch failed"));
    if (this.behaviour === "hang") return new Promise<void>(() => {});
    return Promise.resolve();
  }
  detect() {
    if (this.behaviour === "crash") throw new Error("WebGL context lost");
    return [];
  }
  close() { this.closed++; }
}

class FakeVoice implements VoiceInput {
  readonly kind = "recognition" as const;
  aborted = 0;
  private result: VoiceResult | (() => Promise<VoiceResult>);
  constructor(result: VoiceResult | (() => Promise<VoiceResult>)) { this.result = result; }
  listen() { return typeof this.result === "function" ? this.result() : Promise.resolve(this.result); }
  abort() { this.aborted++; }
  finish() {}
}

function scene(p: Partial<SceneAnalysis>): SceneAnalysis {
  return { spoken: "", changed: false, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false, ...p };
}
const stairs: Hazard = { kind: "stairs", label: "stairs", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown" };
const person: Hazard = { kind: "person", label: "person", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown" };

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const T = speech("tn");

const live: { c: InstanceType<typeof SmartVisionController> }[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.c.detach();
  doc.hidden = false;
  posts.length = 0;
  replies = [];
});

function setup(opts: { detector?: FakeDetector; voice?: FakeVoice } = {}) {
  const c = new SmartVisionController();
  const engine = new FakeEngine();
  const sources: FakeSource[] = [];
  const feedback: string[] = [];
  const any = c as unknown as Record<string, unknown>;
  any.makeSource = () => { const s = new FakeSource(); sources.push(s); return s; };
  any.detector = opts.detector ?? new FakeDetector();
  any.detectorLoadTimeoutMs = 50;
  if (opts.voice) any.voiceInput = opts.voice;
  const feedbackOrig = (any.feedback as (n: string) => void).bind(c);
  any.feedback = (name: string) => { feedback.push(name); feedbackOrig(name); };
  c.attach({} as HTMLVideoElement, { tts: engine });
  const h = {
    c,
    engine,
    sources,
    feedback,
    any,
    /** Starts the camera; the automatic 500 ms tick is stopped so tests drive frames themselves. */
    async start() {
      await c.startCamera();
      clearInterval(any.tickTimer as ReturnType<typeof setInterval>);
      any.tickTimer = null;
      await flush();
    },
    tick: () => (any.tick as () => void).call(c),
    say: (text: string, priority: string) => (any.say as (t: string, p: string) => void).call(c, text, priority),
    /** Speech is quiet: everything waiting gets played and finished. */
    drain() { for (let i = 0; i < 20 && c.state.speaking; i++) engine.end(); },
  };
  live.push(h);
  return h;
}

// --- 1. camera frames keep being checked while the assistant speaks ------------------------------

test("a long reading doesn't stop hazard scans, and an urgent warning interrupts it at once", async () => {
  const h = await (async () => { const h = setup(); await h.start(); h.drain(); return h; })();
  const reading = Array.from({ length: 40 }, (_, i) => `هذي الجملة رقم ${i} متاع الورقة.`).join(" "); // several distinct chunks
  h.say(reading, "answer");
  assert.equal(h.c.state.speaking, true);
  const chunk = h.engine.last;

  h.any.lastScanAt = Date.now() - 10_000;
  replies.push(scene({ hazards: [stairs], spoken: "درج قدّامك.", changed: true }));
  h.tick();
  await flush();
  assert.equal(posts.length, 1, "a frame is sent while the reading plays");

  const warning = warningPhrase(stairs, "tn");
  assert.equal(h.engine.last, warning, "the warning plays now, not after the reading");
  assert.ok(h.engine.stops > 0, "the reading was cut");
  assert.ok(h.feedback.includes("urgent"), "with the urgent tone and vibration");
  assert.ok(!h.engine.said.includes("درج قدّامك."), "the scan's description isn't queued behind the reading");
  h.engine.end();
  assert.equal(h.engine.last, chunk, "then the reading resumes where it was cut");
});

test("a caution warning (a person nearby) also cuts into a reading, which then resumes", async () => {
  const h = setup();
  await h.start();
  h.drain();
  h.say(Array.from({ length: 40 }, (_, i) => `سطر رقم ${i} من الورقة.`).join(" "), "answer");
  const chunk = h.engine.last;
  h.any.lastScanAt = Date.now() - 10_000;
  replies.push(scene({ hazards: [person] }));
  h.tick();
  await flush();
  assert.equal(h.engine.last, warningPhrase(person, "tn"));
  h.engine.end();
  assert.equal(h.engine.last, chunk);
});

// --- 2. detector failure is spoken ----------------------------------------------------------------

test("a detector that fails to load is announced, not shown silently", async () => {
  const detector = new FakeDetector("reject");
  const h = setup({ detector });
  await h.start();
  assert.equal(h.c.state.detector, "failed");
  assert.ok(h.engine.said.includes(T.detectorFailed), h.engine.said.join(" | "));
  assert.ok(h.feedback.includes("error"));
  assert.equal(detector.closed, 1, "the broken instance is dropped, so a restart tries again");
});

test("a detector that never finishes loading counts as failed after the timeout", async () => {
  const h = setup({ detector: new FakeDetector("hang") });
  await h.start();
  assert.equal(h.c.state.detector, "loading");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(h.c.state.detector, "failed");
  assert.ok(h.engine.said.includes(T.detectorFailed));
});

test("a detector that crashes while running is announced", async () => {
  const h = setup({ detector: new FakeDetector("crash") });
  await h.start();
  assert.equal(h.c.state.detector, "failed");
  assert.ok(h.engine.said.includes(T.detectorFailed));
});

test("offline with a failed detector, nothing claims on-device warnings still work", async () => {
  const h = setup({ detector: new FakeDetector("reject") });
  fire(windowListeners, "offline");
  await h.start();
  h.drain();
  assert.ok(h.engine.said.includes(T.analysisDown), h.engine.said.join(" | "));
  assert.ok(!h.engine.said.includes(T.offline), "the offline notice that promises on-device warnings is never said");
});

test("a restart after a failure loads the detector again", async () => {
  const detector = new FakeDetector("reject");
  const h = setup({ detector });
  await h.start();
  h.c.stopCamera();
  await h.start();
  assert.equal(detector.loads, 2);
});

// --- 3. "Stop listening" -------------------------------------------------------------------------

test("'Stop listening' said through Ask, with voice commands off, keeps them off", async () => {
  assert.equal(parseCommand("Stop listening"), "assistant-off");
  for (const words of ["Stop listening", "سكّر الميكرو"]) {
    const h = setup({ voice: new FakeVoice({ kind: "text", text: words }) });
    assert.equal(h.c.state.assistantOn, false);
    await h.c.askByVoice();
    await flush();
    assert.equal(h.c.state.assistantOn, false, `${words} turned voice commands on`);
    assert.equal(h.engine.last, T.assistantOff, "and it confirms the microphone is off");
    h.c.detach();
  }
});

test("'Stop listening' with voice commands on turns them off, and only off", async () => {
  // The first listen hears the command, then the loop must end rather than listen again.
  let calls = 0;
  const voice = new FakeVoice(async () => (++calls === 1 ? { kind: "text", text: "Stop listening" } : new Promise<VoiceResult>(() => {})));
  const h = setup({ voice });
  h.c.toggleAssistant();
  assert.equal(h.c.state.assistantOn, true);
  h.drain();
  await new Promise((r) => setTimeout(r, 400)); // the loop polls every 200 ms
  assert.equal(h.c.state.assistantOn, false);
  h.drain();
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(calls, 1, "the loop stopped listening");
});

// --- 4. camera lifecycle --------------------------------------------------------------------------

test("hiding the page releases the camera and microphone; returning turns the camera back on", async () => {
  let resolveListen: (r: VoiceResult) => void = () => {};
  const voice = new FakeVoice(() => new Promise<VoiceResult>((r) => (resolveListen = r)));
  const h = setup({ voice });
  await h.start();
  const first = h.sources[0];
  void h.c.askByVoice(); // the microphone is open
  await flush();
  assert.equal(h.c.state.mic, "listening");

  setHidden(true);
  assert.equal(first.stopped, true, "camera hardware released");
  assert.equal(h.c.state.camera, "off");
  assert.equal(voice.aborted, 1, "microphone released");
  resolveListen({ kind: "none" }); // what an aborted recognition session reports
  await flush();
  assert.equal(h.c.state.speaking, false, "nothing keeps talking over another app, not even \"I didn't hear\"");
  const sent = posts.length;
  h.tick();
  await flush();
  assert.equal(posts.length, sent, "no frame is sent while away");

  setHidden(false);
  await flush();
  assert.equal(h.sources.length, 2, "a new camera stream on return");
  assert.equal(h.c.state.camera, "on");
  assert.ok(h.engine.said.includes(T.wasAway), "the user is told the camera was off");
});

test("a camera the user stopped doesn't come back on by itself", async () => {
  const h = setup();
  await h.start();
  h.c.stopCamera();
  setHidden(true);
  setHidden(false);
  await flush();
  assert.equal(h.sources.length, 1);
  assert.equal(h.c.state.camera, "off");
});

test("hidden while the camera is still starting: it's released, then restarts on return", async () => {
  const h = setup();
  const starting = h.c.startCamera();
  setHidden(true);
  await starting;
  await flush();
  assert.equal(h.sources[0].stopped, true);
  assert.equal(h.c.state.camera, "off");
  setHidden(false);
  await flush();
  assert.equal(h.c.state.camera, "on");
});

test("closing the page releases everything and nothing restarts", async () => {
  const h = setup();
  await h.start();
  fire(windowListeners, "pagehide");
  assert.equal(h.sources[0].stopped, true);
  setHidden(false);
  await flush();
  assert.equal(h.sources.length, 1);
});
