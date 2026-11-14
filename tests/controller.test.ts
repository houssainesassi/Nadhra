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
// Consent to the camera notice and to the notice about documents (tests of those notices remove them).
const storage = new Map<string, string>([["assistant.consent.v3", "1"], ["assistant.readConsent.v1", "1"]]);
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
/** The next POSTs fail with these errors instead. */
let failures: { status: number; error: string }[] = [];
g.fetch = async (url: string, init?: { method?: string; body?: string }) => {
  // The page's own error reports aren't vision requests: they mustn't take a prepared reply.
  if (init?.method === "POST" && String(url).includes("/api/report")) return new Response(null, { status: 204 });
  if (init?.method === "POST") {
    posts.push(JSON.parse(init.body ?? "{}"));
    const fail = failures.shift();
    if (fail) return new Response(JSON.stringify({ error: fail.error }), { status: fail.status });
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
  detects = 0;
  /** What every frame shows. */
  sees: { label: string; score: number; x: number; y: number; w: number; h: number }[] = [];
  private behaviour: "ok" | "reject" | "hang" | "crash";
  constructor(behaviour: "ok" | "reject" | "hang" | "crash" = "ok") { this.behaviour = behaviour; }
  load() {
    this.loads++;
    if (this.behaviour === "reject") return Promise.reject(new Error("wasm fetch failed"));
    if (this.behaviour === "hang") return new Promise<void>(() => {});
    return Promise.resolve();
  }
  detect() {
    this.detects++;
    if (this.behaviour === "crash") throw new Error("WebGL context lost");
    return this.sees;
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
  failures = [];
  storage.set("assistant.consent.v3", "1");
  storage.set("assistant.readConsent.v1", "1");
  storage.delete("assistant.settings"); // each test starts from the defaults
});

/**
 * Most of these tests are about the automatic scans, so they turn automatic descriptions on, as a
 * user would; `auto: false` keeps the default (off). See the "automatic descriptions" tests.
 */
function setup(opts: { detector?: FakeDetector; voice?: FakeVoice; auto?: boolean } = {}) {
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
  if (opts.auto !== false) c.store.set({ ...c.state, settings: { ...c.state.settings, autoDescribe: true } });
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

// --- questions: answered at the time they are asked, streamed, cancellable ----------------------

/** A server reply as server-sent events, written in the given pieces with a pause between them. */
function sseResponse(events: unknown[], opts: { endWithoutDone?: boolean } = {}) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      for (const e of events) {
        c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        await new Promise((r) => setTimeout(r, 5));
      }
      c.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
async function withFetch(fake: typeof fetch, run: () => Promise<void>) {
  const real = g.fetch;
  g.fetch = fake;
  try {
    await run();
  } finally {
    g.fetch = real;
  }
}
const until = async (cond: () => boolean, ms = 1000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
};

test("camera off: a general question is answered by the model without a picture", async () => {
  const h = setup();
  replies.push(scene({ spoken: "عاصمة تونس هي مدينة تونس.", changed: true }));
  await h.c.ask("شنية عاصمة تونس؟");
  const sent = posts[0] as Record<string, unknown>;
  assert.equal(sent.mode, "chat");
  assert.equal(sent.image, undefined, "no frame is sent with the camera off");
  assert.equal(sent.stream, true);
  assert.ok(h.engine.said.includes(T.thinkingNoCamera), "it doesn't claim to be looking");
  h.drain();
  assert.ok(h.engine.said.includes("عاصمة تونس هي مدينة تونس."));
  assert.equal(h.c.state.answer.text, "عاصمة تونس هي مدينة تونس.");
});

test("camera off: a question about the surroundings asks for the camera instead of guessing", async () => {
  const h = setup();
  replies.push(scene({ spoken: "", needsCamera: true }));
  await h.c.ask("شنوة الحاجة اللي في يدي؟");
  h.drain();
  assert.ok(h.engine.said.includes(T.cameraNeeded));
  assert.equal(h.c.state.answer.text, "");
});

test("camera on: the frame captured for the question goes with it, and the answer streams sentence by sentence", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const bodies: Record<string, unknown>[] = [];
  const analysis = scene({ spoken: "قدّامك باب. فوقه كتابة EXIT.", changed: true });
  await withFetch((async (_url: string, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}"));
    return sseResponse([{ type: "sentence", text: "قدّامك باب." }, { type: "sentence", text: "فوقه كتابة EXIT." }, { type: "done", analysis, provider: "fake", latencyMs: 1, rest: "" }]);
  }) as typeof fetch, async () => {
    const asking = h.c.ask("شنوة قدّامي؟");
    await until(() => h.engine.said.includes("قدّامك باب."));
    assert.equal(h.c.state.answer.live, true, "the first sentence plays while the rest is still coming");
    assert.ok(!h.engine.said.includes("فوقه كتابة EXIT."));
    await asking;
  });
  assert.equal(bodies[0].mode, "question");
  assert.equal(bodies[0].image, "/9j/AAAA");
  h.drain();
  assert.deepEqual(h.engine.said.filter((t) => t.startsWith("قدّامك") || t.startsWith("فوقه")), ["قدّامك باب.", "فوقه كتابة EXIT."], "each sentence once, in order");
  assert.equal(h.c.state.answer.live, false);
});

test("a new question cancels the previous one, here and on the server; the old answer is never spoken", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const signals: AbortSignal[] = [];
  await withFetch((async (_url: string, init?: { body?: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init?.body ?? "{}");
    signals.push(init!.signal!);
    if (body.question === "first") {
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    return sseResponse([{ type: "done", analysis: scene({ spoken: "جواب جديد." }), provider: "fake", latencyMs: 1, rest: "جواب جديد." }]);
  }) as typeof fetch, async () => {
    const first = h.c.ask("first");
    await flush();
    await h.c.ask("second");
    await first;
  });
  assert.equal(signals[0].aborted, true, "the first request was aborted");
  h.drain();
  assert.ok(h.engine.said.includes("جواب جديد."));
  assert.equal(h.engine.said.filter((t) => t === T.questionFailed).length, 0, "a cancelled question isn't reported as a failure");
});

test("an answer cut off part-way (connection lost) says so after what was already said", async () => {
  const h = setup();
  await h.start();
  h.drain();
  await withFetch((async () => sseResponse([{ type: "sentence", text: "قدّامك طاولة." }])) as typeof fetch, () => h.c.ask("صفلي الصورة"));
  h.drain();
  const i = h.engine.said.indexOf("قدّامك طاولة.");
  assert.ok(i >= 0);
  assert.equal(h.engine.said[i + 1], T.answerCut);
  assert.ok(!h.engine.said.includes(T.questionFailed));
});

test("a connection that fails before any answer is retried once, then reported", async () => {
  const h = setup();
  await h.start();
  h.drain();
  let calls = 0;
  await withFetch((async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  }) as typeof fetch, () => h.c.ask("شنوة اللون متاع الحيط؟"));
  assert.equal(calls, 2);
  h.drain();
  assert.ok(h.engine.said.includes(T.questionFailed));
});

test("a question in French gets a French answer request and a French 'one moment', with Derja chosen", async () => {
  const h = setup();
  await h.start();
  h.drain();
  replies.push(scene({ spoken: "Il y a une porte devant vous.", changed: true }));
  await h.c.ask("Qu'est-ce qu'il y a devant moi ?");
  assert.equal((posts.at(-1) as Record<string, unknown>).lang, "fr");
  assert.ok(h.engine.said.includes(speech("fr").thinking));
  assert.equal(h.c.state.answer.lang, "fr");
});

test("multi-turn: a short follow-up keeps the conversation's language and carries the earlier exchange", async () => {
  const h = setup();
  replies.push(scene({ spoken: "It's ten o'clock.", changed: true }));
  await h.c.ask("What time is it?");
  replies.push(scene({ spoken: "Half past ten.", changed: true }));
  await h.c.ask("OK");
  const sent = posts.at(-1) as Record<string, unknown>;
  assert.equal(sent.lang, "en", "«OK» after an English answer stays English, with Derja chosen");
  assert.deepEqual(sent.history, [{ q: "What time is it?", a: "It's ten o'clock." }]);
  replies.push(scene({ spoken: "الساعة 10 و نص.", changed: true }));
  await h.c.ask("w ba3d?");
  assert.equal((posts.at(-1) as Record<string, unknown>).lang, "tn", "a clear switch to Arabizi is followed");
});

test("multi-turn: changing the language setting starts the conversation afresh", async () => {
  const h = setup();
  replies.push(scene({ spoken: "It's ten o'clock.", changed: true }));
  await h.c.ask("What time is it?");
  h.c.updateSettings({ language: "fr" });
  replies.push(scene({ spoken: "D'accord.", changed: true }));
  await h.c.ask("OK");
  const sent = posts.at(-1) as Record<string, unknown>;
  assert.equal(sent.lang, "fr", "the old answer's language no longer counts");
  assert.deepEqual(sent.history, []);
});

test("a phone that doesn't say which camera it opened is not treated as a mirror", async () => {
  const h = setup();
  const prevMatch = g.matchMedia;
  g.matchMedia = () => ({ matches: true });
  Object.defineProperty(globalThis.navigator, "maxTouchPoints", { configurable: true, get: () => 5 });
  h.any.makeSource = () => Object.assign(new FakeSource(), { facing: "unknown" });
  try {
    await h.start();
    assert.equal(h.c.state.facing, "outward", "left and right must not be swapped on a phone");
  } finally {
    g.matchMedia = prevMatch;
    Object.defineProperty(globalThis.navigator, "maxTouchPoints", { configurable: true, get: () => 0 });
  }
});

test("a task asked with the camera off waits for the camera to settle before capturing", async () => {
  const h = setup();
  replies.push(scene({ spoken: "قدّامك باب.", changed: true }));
  const t0 = Date.now();
  await h.c.runTask("describe");
  const asked = () => posts.some((p) => (p as Record<string, unknown>).mode === "question");
  await until(asked, 3000);
  assert.ok(asked() && Date.now() - t0 >= 750, `question captured after ${Date.now() - t0} ms`);
});

// --- Phase 1: safety and privacy ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A person filling the middle of the picture: near and ahead. */
const NEAR_PERSON = { label: "person", score: 0.9, x: 0.35, y: 0.1, w: 0.3, h: 0.85 };

/** A live conversation as far as the controller can tell, without a socket or audio. */
function fakeLive(h: ReturnType<typeof setup>) {
  const audio = { flushed: 0, played: 0, flush() { this.flushed++; }, play() { this.played++; }, close() {}, setVolume() {}, setDucked() {}, isPlaying: false };
  const session = { isOpen: true, stopped: 0, frames: 0, model: "m", voice: "Sulafat", sendFrame() { this.frames++; return true; }, sendText() {}, stop() { this.stopped++; } };
  h.any.liveSession = session;
  h.any.liveAudio = audio;
  h.c.store.set({ ...h.c.state, live: { ...h.c.state.live, status: "open" } });
  return { audio, session };
}

test("pause stops descriptions and cloud scans, but on-device warnings keep running and say so", async () => {
  const detector = new FakeDetector();
  const h = setup({ detector });
  await h.start();
  h.drain();
  h.c.pause();
  assert.equal(h.engine.last, T.paused, "the user hears that warnings are still on");
  h.drain();
  const before = posts.length;
  h.any.lastScanAt = Date.now() - 60_000;
  h.tick();
  await flush();
  assert.equal(posts.length, before, "no cloud scan while paused");

  detector.sees = [NEAR_PERSON];
  const detects = detector.detects;
  await sleep(1_300); // the detector runs every 250 ms; a track needs 3 sightings
  assert.ok(detector.detects > detects, "the detector keeps running while paused");
  assert.ok(h.engine.said.slice(2).some((t) => t.includes("شخص") && t.includes("قدّامك")), `warning spoken while paused: ${h.engine.said.join(" | ")}`);
});

test("pause with a failed detector says plainly that no warnings are running", async () => {
  const h = setup({ detector: new FakeDetector("reject") });
  await h.start();
  await sleep(80);
  h.drain();
  h.c.pause();
  assert.equal(h.engine.last, T.pausedNoWarnings);
});

test("during a live conversation the cloud scans keep running for hazards only, at a slower pace", async () => {
  const h = setup();
  await h.start();
  h.drain();
  fakeLive(h);
  const before = posts.length;
  h.any.lastScanAt = Date.now() - 5_000; // would be due in normal mode (4 s), not in live mode (8 s)
  h.tick();
  await flush();
  assert.equal(posts.length, before, "not as often as without the conversation");

  h.any.lastScanAt = Date.now() - 9_000;
  replies.push(scene({ hazards: [stairs], spoken: "فمّا درج قدّامك وباب على اليمين.", changed: true }));
  h.tick();
  await flush();
  assert.equal(posts.length, before + 1);
  assert.equal((posts[posts.length - 1] as { mode: string }).mode, "scan");
  assert.equal(h.engine.last, warningPhrase(stairs, "tn"), "the stairs warning is spoken");
  h.drain();
  assert.ok(!h.engine.said.includes("فمّا درج قدّامك وباب على اليمين."), "the description isn't: the conversation describes");
});

test("a live answer that promises safety is cut, and the correction is said instead", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const { audio } = fakeLive(h);
  const check = (ai: string, final = false) => {
    h.c.store.set({ ...h.c.state, live: { ...h.c.state.live, ai } });
    (h.any.checkLiveSafety as (f: boolean) => void).call(h.c, final);
  };
  h.any.liveCheckedChars = 0;
  check("فمّا طاولة على يمينك.");
  assert.equal(audio.flushed, 0);
  check("فمّا طاولة على يمينك. الطريق فارغ، تنجم تعدّي");
  assert.equal(audio.flushed, 0, "an unfinished sentence waits");
  check("فمّا طاولة على يمينك. الطريق فارغ، تنجم تعدّي.");
  assert.ok(audio.flushed >= 1, "the live answer stops");
  assert.equal(h.engine.last, T.pathCaveat);
  assert.equal(h.any.liveMuted, true, "the rest of that answer isn't played");

  h.drain();
  const flushed = audio.flushed;
  const said = h.engine.said.length;
  h.any.liveMuted = false;
  h.any.liveCheckedChars = 0;
  check("ما نجمش نأكّدلك إلي الطريق آمن.", true);
  assert.equal(audio.flushed, flushed, "a sentence that warns rather than promises is fine");
  assert.equal(h.engine.said.length, said);
});

test("saying «نجدة» in a live conversation opens the Emergency page instead of being answered", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const { session } = fakeLive(h);
  h.c.store.set({ ...h.c.state, live: { ...h.c.state.live, user: "نجدة" } });
  h.any.liveCommandChecked = false;
  assert.equal(parseCommand("نجدة"), "emergency");
  assert.equal((h.any.checkLiveCommand as () => boolean).call(h.c), true);
  assert.equal(session.stopped, 1, "the conversation ends");
  assert.equal(h.c.state.sheet, "emergency");
  assert.equal(h.c.state.live.status, "off");

  // An ordinary question is left to the conversation.
  const h2 = setup();
  await h2.start();
  fakeLive(h2);
  h2.c.store.set({ ...h2.c.state, live: { ...h2.c.state.live, user: "شنوة قدّامي؟" } });
  h2.any.liveCommandChecked = false;
  assert.equal((h2.any.checkLiveCommand as () => boolean).call(h2.c), false);
  assert.equal(h2.c.state.sheet, "none");
});

test("withdrawing consent stops the camera, forgets it, and asks again before the next start", async () => {
  const h = setup();
  await h.start();
  assert.equal(h.c.state.consentGiven, true);
  h.c.withdrawConsent();
  assert.equal(h.c.state.camera, "off");
  assert.equal(h.sources[0].stopped, true);
  assert.equal(h.c.state.consentGiven, false);
  assert.equal(localStorage.getItem("assistant.consent.v3"), null);
  assert.equal(h.engine.last, T.consentWithdrawn);

  await h.c.startCamera();
  assert.equal(h.c.state.needsConsent, true, "the notice comes back");
  assert.equal(h.sources.length, 1, "no camera started without consent");
  h.c.acceptConsent();
  await flush();
  assert.equal(localStorage.getItem("assistant.consent.v3"), "1");
});

test("a spent daily budget is said once, and scans wait instead of retrying every few seconds", async () => {
  const h = setup();
  await h.start();
  h.drain();
  failures.push({ status: 503, error: "quota-exhausted" });
  h.any.lastScanAt = -Infinity;
  h.tick();
  await flush();
  assert.equal(h.engine.last, T.quotaExhausted);
  assert.ok((h.any.backoffUntil as number) - Date.now() > 10 * 60_000);
  h.drain();
  const sent = posts.length;
  h.tick();
  await flush();
  assert.equal(posts.length, sent, "no new request during the wait");

  failures.push({ status: 503, error: "quota-exhausted" });
  await h.c.ask("شنوة قدّامي؟");
  await flush();
  assert.ok(h.engine.said.includes(T.quotaExhausted));
});

// --- Open camera / Stop assistance (the main screen's two buttons) ------------------------------

test("Open camera starts the camera, on-device warnings and voice commands; Stop ends them all", async () => {
  const voice = new FakeVoice(() => new Promise<VoiceResult>(() => {}));
  const h = setup({ voice });
  await h.c.startAssistance();
  await flush();
  assert.equal(h.c.state.camera, "on");
  assert.equal(h.c.state.analysis, "watching", "the cloud analysis is scheduled");
  assert.notEqual(h.c.state.detector, "off", "the on-device detector is started");
  assert.equal(h.c.state.assistantOn, true, "hands-free voice commands are on");
  assert.ok(h.engine.said.includes(T.cameraOn), "and the camera says it is on");

  h.c.stopAssistance();
  assert.equal(h.c.state.camera, "off");
  assert.equal(h.sources[0].stopped, true, "the camera is released");
  assert.equal(h.c.state.assistantOn, false, "the microphone is closed");
  assert.ok(voice.aborted > 0, "the open recognition is aborted");
  assert.equal(h.c.state.live.status, "off");
  assert.equal(h.engine.last, T.cameraOff);
});

test("Open camera without consent shows the notice first; nothing starts until it is accepted", async () => {
  storage.delete("assistant.consent.v3");
  try {
    const h = setup({ voice: new FakeVoice(() => new Promise<VoiceResult>(() => {})) });
    await h.c.startAssistance();
    assert.equal(h.c.state.needsConsent, true);
    assert.equal(h.sources.length, 0, "no camera before consent");
    assert.equal(h.c.state.assistantOn, false, "no microphone before consent");

    h.c.declineConsent();
    assert.equal(h.c.state.assistantOn, false, "declining starts nothing");
    await h.c.startAssistance();
    h.c.acceptConsent();
    await flush();
    assert.equal(h.c.state.camera, "on");
    assert.equal(h.c.state.assistantOn, true, "voice commands follow the camera once consent is given");
  } finally {
    storage.set("assistant.consent.v3", "1");
  }
});

test("Open camera with a refused camera turns nothing else on", async () => {
  const h = setup({ voice: new FakeVoice(() => new Promise<VoiceResult>(() => {})) });
  const { CameraError } = await import("../src/lib/camera/camera.ts");
  h.any.makeSource = () => Object.assign(new FakeSource(), { start: async () => { throw new CameraError("denied", "Permission denied"); } });
  await h.c.startAssistance();
  await flush();
  assert.equal(h.c.state.camera, "error");
  assert.equal(h.c.state.cameraError, "denied");
  assert.equal(h.c.state.assistantOn, false);
});

test("Stop with only voice commands left on (the camera was closed by voice) turns them off", async () => {
  const h = setup({ voice: new FakeVoice(() => new Promise<VoiceResult>(() => {})) });
  await h.c.startAssistance();
  await flush();
  h.c.stopCamera(); // «سكّر الكاميرا»
  assert.equal(h.c.state.assistantOn, true);
  h.c.stopAssistance();
  assert.equal(h.c.state.assistantOn, false);
  assert.equal(h.engine.last, T.assistantOff);
});

test("after Open camera, saying «نجدة» then «عيّط» opens the Emergency page and selects the call button", async () => {
  const heard = ["نجدة", "عيّط"];
  const voice = new FakeVoice(async () => { const text = heard.shift(); return text ? { kind: "text", text } : new Promise<VoiceResult>(() => {}); });
  const h = setup({ voice });
  h.c.updateSettings({ emergencyPhone: "+216 20 000 000" });
  h.drain();
  await h.c.startAssistance();
  for (let i = 0; i < 30 && h.c.state.focus.target !== "call"; i++) {
    h.drain();
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(h.c.state.sheet, "emergency");
  assert.equal(h.c.state.focus.target, "call", "«عيّط» selects the call button (the user's tap places the call)");
  assert.equal(h.c.state.camera, "on", "the camera and its warnings keep running");
  h.c.updateSettings({ emergencyPhone: "" });
});

// --- reading documents ---------------------------------------------------------------------------------

const { sanitizeDocument } = await import("../src/lib/assistant/document.ts");
const DOC_NOW = new Date("2026-11-13T10:00:00+01:00");
const L = (text: string, confidence = "confirmed") => ({ text, confidence });
const BOX_RAW = {
  doc_type: "medicine", legibility: "clear",
  lines: [L("FEBRALIX 500 mg"), L("16 comprimés"), L("EXP 03/2027")],
  medicine: { name: "FEBRALIX", strength: "500 mg", expiry: "EXP 03/2027" },
};
/** What the server answers when both readings agree. */
const WHOLE = { first: () => null, second: () => null };
const boxReading = () => sanitizeDocument(BOX_RAW, { lang: "tn", now: DOC_NOW, confirm: BOX_RAW, inspect: WHOLE });
const D = speech("tn").doc;

/** A camera whose picture is uniformly dark, or uniformly flat (no detail at all: unreadable). */
class PlainSource extends FakeSource {
  level: number;
  constructor(level: number) { super(); this.level = level; }
  thumbnail(width: number, height: number): GrayFrame {
    const px = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) px.set([this.level, this.level, this.level, 255], i * 4);
    return { rgba: px, width, height };
  }
}

function langsOf(engine: FakeEngine) {
  const spoken: { text: string; lang: string }[] = [];
  let lang = "tn";
  (engine as unknown as { setLanguage: (l: string) => void }).setLanguage = (l) => (lang = l);
  const speak = engine.speak.bind(engine);
  engine.speak = (text, opts) => { spoken.push({ text, lang }); speak(text, opts); };
  return spoken;
}

test("«اقرالي الدوا»: a reading is requested with a sharp still, and said with the box's text in the French voice", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const spoken = langsOf(h.engine);
  replies.push(boxReading());
  assert.equal(parseCommand("اقرالي الدوا"), "read");
  await h.c.readDocument();
  const sent = posts.at(-1) as Record<string, unknown>;
  assert.equal(sent.mode, "read");
  assert.equal(sent.image, "/9j/AAAA");
  assert.equal(sent.secondImage, "/9j/AAAA", "a second frame, for the independent second reading");
  assert.equal(sent.question, undefined);
  assert.equal((h.any.history as unknown[]).length, 0, "readings stay out of the general conversation history");
  h.drain();
  const name = spoken.find((s) => s.text.includes("FEBRALIX"))!;
  assert.equal(name.lang, "fr", "the printed name is read by the French voice");
  assert.equal(spoken.find((s) => s.text.includes(D.name))!.lang, "tn", "the labels are the assistant's, in Derja");
  assert.ok(h.engine.said.some((s) => s.includes(D.notExpired)));
  assert.match(h.c.state.answer.text, /FEBRALIX/);
});

test("a dark picture is refused on the device: nothing is sent, and the user hears why", async () => {
  const h = setup();
  h.any.makeSource = () => { const s = new PlainSource(8); h.sources.push(s); return s; };
  h.any.readSteadyWaitMs = 50;
  await h.start();
  h.drain();
  const before = posts.length;
  await h.c.readDocument();
  assert.equal(posts.length, before, "no image left the phone");
  h.drain();
  assert.ok(h.engine.said.includes(D.tooDark), h.engine.said.join(" | "));
});

test("a picture without any sharp detail is refused as blurred after waiting for a steadier one", async () => {
  const h = setup();
  h.any.makeSource = () => { const s = new PlainSource(140); h.sources.push(s); return s; };
  h.any.readSteadyWaitMs = 300;
  await h.start();
  h.drain();
  const before = posts.length;
  const t0 = Date.now();
  await h.c.readDocument();
  assert.ok(Date.now() - t0 >= 250, "it waited for a sharper frame first");
  assert.equal(posts.length, before);
  h.drain();
  assert.ok(h.engine.said.some((s) => s.includes(D.tip.blurry.split(".")[0])));
});

test("questions after a reading are about the paper, with its text; one that isn't is asked normally", async () => {
  const h = setup();
  await h.start();
  h.drain();
  replies.push(boxReading());
  await h.c.readDocument();
  h.drain();

  replies.push(sanitizeDocument({ lines: [], answer: { about_document: true, found: true, quote: "EXP 03/2027" } }, { lang: "tn", question: "وقتاش يوفى؟", context: { kind: "medicine", lines: ["FEBRALIX 500 mg", "16 comprimés", "EXP 03/2027"] }, now: DOC_NOW }));
  await h.c.ask("وقتاش يوفى؟");
  const follow = posts.at(-1) as Record<string, unknown>;
  assert.equal(follow.mode, "read");
  assert.deepEqual((follow.document as { lines: string[] }).lines, ["FEBRALIX 500 mg", "16 comprimés", "EXP 03/2027"]);
  h.drain();
  assert.ok(h.engine.said.includes(D.quote));

  const n = posts.length;
  replies.push(sanitizeDocument({ lines: [], answer: { about_document: false } }, { lang: "tn", question: "شنوة لون الحيط؟", context: { kind: "medicine", lines: ["x"] }, now: DOC_NOW }));
  replies.push(scene({ spoken: "الحيط أبيض.", changed: true }));
  await h.c.ask("شنوة لون الحيط؟");
  assert.deepEqual(posts.slice(n).map((p) => (p as Record<string, unknown>).mode), ["read", "question"]);
  h.drain();
  assert.ok(h.engine.said.includes("الحيط أبيض."));
});

test("«اقرا الكل» reads the whole text from memory: no new picture is sent", async () => {
  const h = setup();
  await h.start();
  h.drain();
  replies.push(boxReading());
  await h.c.readDocument();
  h.drain();
  const n = posts.length;
  assert.equal(parseCommand("اقرا الكل"), "read-all");
  h.c.readAll();
  h.drain();
  assert.equal(posts.length, n);
  assert.ok(h.engine.said.some((s) => s.includes("16 comprimés")));
});

test("«اقرا الكل» with nothing read and the camera off says so", async () => {
  const h = setup();
  h.c.readAll();
  h.drain();
  assert.ok(h.engine.said.includes(D.nothingRead));
});

test("a reading whose connection drops is sent once more; a second failure is said", async () => {
  const h = setup();
  await h.start();
  h.drain();
  let calls = 0;
  await withFetch((async () => {
    calls++;
    throw new TypeError("Failed to fetch");
  }) as typeof fetch, () => h.c.readDocument());
  assert.equal(calls, 2);
  h.drain();
  assert.ok(h.engine.said.includes(T.questionFailed));
});

test("withdrawing consent forgets the document read", async () => {
  const h = setup();
  await h.start();
  h.drain();
  replies.push(boxReading());
  await h.c.readDocument();
  assert.ok(h.any.document);
  h.c.withdrawConsent();
  assert.equal(h.any.document, null);
  assert.equal(localStorage.getItem("assistant.readConsent.v1"), null, "the notice about documents is asked again too");
});

test("before the first document leaves the phone, the notice naming Google is said; only «موافق» sends it", async () => {
  const h = setup();
  await h.start();
  h.drain();
  storage.delete("assistant.readConsent.v1");
  const before = posts.length;
  await h.c.readDocument();
  assert.equal(posts.length, before, "nothing sent before the answer");
  assert.equal(h.engine.last.slice(0, 20), D.notice.slice(0, 20));
  // «رجّع» cancels: still nothing sent.
  assert.equal(parseCommand("رجّع"), "back");
  h.c.goBack();
  assert.ok(h.engine.said.includes(D.noticeRefused));
  assert.equal(posts.length, before);
  // Asked again, then «موافق»: the reading goes ahead, and the notice isn't repeated next time.
  await h.c.readDocument();
  replies.push(boxReading());
  assert.equal(parseCommand("موافق"), "yes");
  assert.equal((h.any.runCommand as (c: string) => boolean).call(h.c, "yes"), true);
  await until(() => posts.length > before);
  assert.equal((posts.at(-1) as Record<string, unknown>).mode, "read");
  assert.equal(localStorage.getItem("assistant.readConsent.v1"), "1");
});

test("F6: a medicine question never gets an ordinary answer: read under the reading rules, or declined", async () => {
  const off = setup();
  await off.c.ask("قداش من حبة ناخذ في النهار؟");
  off.drain();
  assert.equal(posts.length, 0, "camera off: nothing sent at all");
  assert.ok(off.engine.said.includes(D.medicalDeclined));

  const h = setup();
  await h.start();
  h.drain();
  replies.push(boxReading());
  await h.c.ask("combien de comprimés par jour ?");
  const sent = posts.at(-1) as Record<string, unknown>;
  assert.equal(sent.mode, "read", "camera on: the reading mode, with its double reading and checks");
  assert.equal(sent.question, "combien de comprimés par jour ?");
});

test("F6: in a live conversation, a medicine question is taken from the live model and read under the rules", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const { audio } = fakeLive(h);
  replies.push(boxReading());
  h.c.store.set({ ...h.c.state, live: { ...h.c.state.live, user: "قداش من حبة ناخذ؟" } });
  h.any.liveCommandChecked = false;
  assert.equal((h.any.checkLiveCommand as () => boolean).call(h.c), true);
  assert.ok(audio.flushed >= 1, "the live answer is cut");
  assert.equal(h.any.liveMuted, true);
  await until(() => posts.some((p) => (p as Record<string, unknown>).mode === "read"));
  assert.ok(posts.some((p) => (p as Record<string, unknown>).mode === "read"));
});

test("F6: a dose in a live answer is cut at once and the refusal is said", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const { audio } = fakeLive(h);
  h.any.liveCheckedChars = 0;
  h.c.store.set({ ...h.c.state, live: { ...h.c.state.live, ai: "هاذي علبة باراسيتامول. خوذ 2 حبات في النهار." } });
  (h.any.checkLiveSafety as (f: boolean) => void).call(h.c, false);
  assert.ok(audio.flushed >= 1);
  assert.equal(h.engine.last, D.liveMedical);
  assert.equal(h.any.liveMuted, true);
});

/** A camera whose view stays the same until `seed` changes. */
class StillSource extends FakeSource {
  view = 7;
  thumbnail(width: number, height: number): GrayFrame { return { rgba: noise(width, height, this.view), width, height }; }
}

test("a document in view stops automatic frames (scans and live) until it is put away", async () => {
  const h = setup();
  const cam = new StillSource();
  h.any.makeSource = () => { h.sources.push(cam); return cam; };
  await h.start();
  h.drain();
  h.any.lastScanAt = Date.now() - 60_000;
  replies.push({ ...scene({}), documentInView: true });
  h.tick();
  await flush();
  assert.equal(posts.length, 1);
  assert.ok(h.engine.said.includes(D.inView), "the user is told why descriptions stopped");
  const { session } = fakeLive(h);
  for (let i = 0; i < 5; i++) {
    h.any.lastScanAt = Date.now() - 60_000;
    h.tick();
    await flush();
  }
  assert.equal(posts.length, 1, "no automatic scan of the document");
  assert.equal((h.any.sendLiveFrame as (f: boolean) => boolean).call(h.c, true), false, "nor a live frame");
  assert.equal(session.frames, 0);
  // Put away: the view changes, and after two ticks frames go out again.
  h.any.liveSession = null;
  cam.view = 99;
  for (let i = 0; i < 3; i++) {
    h.any.lastScanAt = Date.now() - 60_000;
    h.tick();
    await flush();
  }
  assert.ok(posts.length > 1, "scans resume");
});

// --- automatic descriptions: off by default ---------------------------------------------------------------

test("by default no picture leaves the phone by itself: no automatic scan, and the user is told what that means", async () => {
  const h = setup({ auto: false });
  await h.start();
  for (let i = 0; i < 5; i++) {
    h.any.lastScanAt = Date.now() - 60_000;
    h.tick();
    await flush();
  }
  assert.equal(posts.length, 0, "nothing sent");
  assert.equal(h.c.state.analysis, "manual");
  assert.equal(h.c.state.settings.autoDescribe, false);
  h.drain();
  assert.ok(h.engine.said.includes(T.autoOffNotice), "said: no picture unless asked, and no stairs or drops");
  // Asking still works: an explicit question sends its picture.
  h.drain();
  replies.push(scene({ spoken: "قدّامك باب.", changed: true }));
  await h.c.ask("شنوة قدّامي؟");
  assert.equal((posts.at(-1) as Record<string, unknown>).mode, "question");
});

test("«شعّل الوصف التلقائي» turns scans on, with the notice; «سكّر الوصف التلقائي» turns them off", async () => {
  const h = setup({ auto: false });
  await h.start();
  h.drain();
  assert.equal(parseCommand("شعّل الوصف التلقائي"), "auto-on");
  assert.equal(parseCommand("turn off automatic descriptions"), "auto-off");
  (h.any.runCommand as (c: string) => boolean).call(h.c, "auto-on");
  assert.ok(h.engine.said.includes(T.autoOn), "it says pictures go to Google every few seconds, papers included");
  assert.equal(h.c.state.settings.autoDescribe, true);
  h.tick();
  await flush();
  assert.equal(posts.length, 1, "scans start");
  (h.any.runCommand as (c: string) => boolean).call(h.c, "auto-off");
  assert.ok(h.engine.said.includes(T.autoOff));
  const n = posts.length;
  for (let i = 0; i < 3; i++) {
    h.any.lastScanAt = Date.now() - 60_000;
    h.tick();
    await flush();
  }
  assert.equal(posts.length, n, "and stop");
});

test("a prescription with several doses: the check is actually spoken after every one of them", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const raw = { doc_type: "prescription", legibility: "clear", lines: [L("1) FEBRALIX 500 mg"), L("1 comprimé 3 fois par jour"), L("2) GASTRONIL 20 mg"), L("1 gélule le matin")] };
  replies.push(sanitizeDocument(raw, { lang: "tn", now: DOC_NOW, confirm: raw, inspect: WHOLE }));
  await h.c.readDocument();
  h.drain();
  for (const dose of ["1) FEBRALIX 500 mg.", "1 comprimé 3 fois par jour.", "2) GASTRONIL 20 mg.", "1 gélule le matin."]) {
    const i = h.engine.said.indexOf(dose);
    assert.ok(i >= 0, dose);
    assert.equal(h.engine.said[i + 1], D.checkDose, `after ${dose}`);
  }
});

// --- live conversation privacy ---------------------------------------------------------------------------

test("live: its own spoken notice first; nothing starts until «موافق» or a second press, and «رجّع» cancels", async () => {
  const h = setup();
  await h.start();
  h.drain();
  storage.delete("assistant.liveConsent.v1");
  await h.c.startLive();
  assert.equal(h.c.state.liveNotice, true);
  assert.equal(h.any.liveSession, null, "no session, nothing sent");
  assert.ok(h.engine.said.some((x) => x.length > 20 && T.liveNotice.startsWith(x)), "the notice is being said");
  assert.match(T.liveNotice, /Google Gemini/);
  h.c.goBack();
  assert.equal(h.c.state.liveNotice, false);
  assert.ok(h.engine.said.includes(T.liveNoticeRefused));
  assert.equal(localStorage.getItem("assistant.liveConsent.v1"), null);
  // Asked again, then «موافق»: remembered, and the start goes ahead.
  await h.c.startLive();
  assert.equal((h.any.runCommand as (c: string) => boolean).call(h.c, "yes"), true);
  await flush();
  assert.equal(localStorage.getItem("assistant.liveConsent.v1"), "1");
  assert.equal(h.c.state.liveNotice, false);
});

test("live: «وقّف المحادثة» on the partial transcript stops sending at once", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const { session } = fakeLive(h);
  assert.equal(parseCommand("وقّف المحادثة"), "live-off");
  assert.equal(parseCommand("stop sending"), "live-off");
  assert.equal((h.any.checkLiveStop as (u: string) => boolean).call(h.c, "شنوة قدّامي"), false, "other words don't");
  assert.equal(session.stopped, 0);
  assert.equal((h.any.checkLiveStop as (u: string) => boolean).call(h.c, "وقّف المحادثة"), true);
  assert.equal(session.stopped, 1);
  assert.equal(h.any.liveSession, null);
  h.drain();
  assert.ok(h.engine.said.includes(T.liveOff));
  assert.match(T.liveOff, /ما عادش يتبعث/);
});

test("live: a spoken reminder every few minutes that voice and pictures are going to Google", async () => {
  const h = setup();
  await h.start();
  h.drain();
  fakeLive(h);
  h.any.lastLiveReminderAt = Date.now() - 6 * 60_000;
  h.tick();
  h.drain();
  assert.ok(h.engine.said.includes(T.liveReminder));
  const n = h.engine.said.filter((x) => x === T.liveReminder).length;
  h.tick();
  h.drain();
  assert.equal(h.engine.said.filter((x) => x === T.liveReminder).length, n, "not again at once");
});

test("withdrawing consent also forgets the live conversation's consent", async () => {
  const h = setup();
  storage.set("assistant.liveConsent.v1", "1");
  h.c.withdrawConsent();
  assert.equal(localStorage.getItem("assistant.liveConsent.v1"), null);
});

// --- no guarantee about stairs, holes or obstacles ---------------------------------------------------------

test("the safety notice says stairs, holes and obstacles can't be guaranteed; later camera starts repeat it briefly", async () => {
  for (const lang of ["tn", "ar", "fr", "en"] as const) assert.match(speech(lang).disclaimer, /الدروج|الدرج|escaliers|stairs/);
  const h = setup();
  await h.start();
  h.drain();
  assert.ok(!h.engine.said.includes(T.noGuarantee), "the first start has the full notice instead");
  h.c.stopCamera();
  await h.start();
  h.drain();
  assert.ok(h.engine.said.includes(T.noGuarantee));
});

test("walking with automatic descriptions off: a reminder that stairs and holes aren't seen, not repeated at once", async () => {
  const h = setup({ auto: false });
  await h.start(); // the fake camera's picture changes on every frame: like walking
  h.drain();
  h.tick();
  h.any.movingSince = Date.now() - 5_000;
  h.tick();
  h.drain();
  assert.ok(h.engine.said.includes(T.walkingNoScan));
  const n = h.engine.said.filter((x) => x === T.walkingNoScan).length;
  h.tick();
  h.drain();
  assert.equal(h.engine.said.filter((x) => x === T.walkingNoScan).length, n);
  // With automatic descriptions on, no such reminder.
  const on = setup();
  await on.start();
  on.drain();
  on.any.movingSince = Date.now() - 5_000;
  on.tick();
  on.drain();
  assert.ok(!on.engine.said.includes(T.walkingNoScan));
});

test("«شنوة قدّامي؟» is followed by the no-guarantee sentence, at most every few minutes", async () => {
  const h = setup({ auto: false });
  await h.start();
  h.drain();
  replies.push(scene({ spoken: "قدّامك باب.", changed: true }));
  await h.c.runTask("front");
  h.drain();
  const i = h.engine.said.indexOf("قدّامك باب.");
  assert.ok(i >= 0 && h.engine.said.slice(i).includes(T.noGuarantee));
  const n = h.engine.said.filter((x) => x === T.noGuarantee).length;
  replies.push(scene({ spoken: "قدّامك طاولة.", changed: true }));
  await h.c.runTask("front");
  h.drain();
  assert.equal(h.engine.said.filter((x) => x === T.noGuarantee).length, n);
});

test("live: the notice says the voice stop is recognised by Google, and the screen button stops without sending; Stop assistance ends it", async () => {
  for (const lang of ["tn", "ar", "fr", "en"] as const) assert.match(speech(lang).liveNotice, /Google/);
  assert.match(T.liveNotice, /تفهمها Google/);
  assert.match(T.liveNotice, /زر الإيقاف في الشاشة يوقّف في التليفون من غير ما يبعث شي/);
  assert.match(speech("en").liveNotice, /stop button on the screen stops on the phone without sending anything/);
  const h = setup();
  await h.start();
  const { session } = fakeLive(h);
  h.c.stopAssistance();
  assert.equal(session.stopped, 1, "the manual button ends the live conversation");
  assert.equal(h.any.liveSession, null);
});

// --- AI_MODE (offline track, Phase 2) ------------------------------------------------------------

test("offline mode on the server: a scan says why once, and scans wait instead of retrying", async () => {
  const h = setup();
  await h.start();
  h.drain();
  failures.push({ status: 503, error: "offline-mode" });
  h.any.lastScanAt = -Infinity;
  h.tick();
  await flush();
  assert.equal(h.engine.last, T.offlineMode);
  assert.ok((h.any.backoffUntil as number) - Date.now() > 4 * 60_000);
  h.drain();
  const sent = posts.length;
  h.tick();
  await flush();
  assert.equal(posts.length, sent, "no new request during the wait");
});

test("a question refused by offline mode or a missing internet says that reason, not 'failed'", async () => {
  const h = setup();
  await h.start();
  h.drain();
  failures.push({ status: 503, error: "offline-mode" });
  await h.c.ask("شنوة قدّامي؟");
  await flush();
  assert.ok(h.engine.said.includes(T.offlineMode));
  h.drain();
  failures.push({ status: 503, error: "no-internet" });
  await h.c.ask("شنوة قدّامي؟");
  await flush();
  const expected = h.c.state.detector === "ready" ? T.offline : T.analysisDown;
  assert.ok(h.engine.said.includes(expected), "only claims on-device warnings work when they do");
  assert.ok(!h.engine.said.includes(T.questionFailed));
});

test("offline mode never picks the browser's speech recognition (a cloud service)", () => {
  const h = setup();
  const pick = () => (h.any.pickVoiceInput as () => { kind: string } | null).call(h.c);
  h.any.voiceInput = null;
  h.c.store.set({ ...h.c.state, status: { mode: "offline", available: false, providers: [], canTranscribe: false } });
  assert.equal(pick(), null, "no local transcription yet: no voice input rather than a cloud one");
  h.c.store.set({ ...h.c.state, status: { mode: "offline", available: true, providers: [], canTranscribe: true } });
  assert.notEqual(pick()?.kind, "recognition");
});
