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
  if (!storage.has("assistant.settings")) storage.set("assistant.settings", JSON.stringify({ language: "tn" })); // the defaults, in Derja: these tests check the Tunisian phrases
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

// --- main-screen action buttons -------------------------------------------------------------------
// The buttons call the same controller methods as the voice commands and keys. These cover what a
// button press must do that a voice command never needed: Ask with voice commands on, and Pause's state.

class CountingVoice extends FakeVoice {
  finished = 0;
  finish() { this.finished++; }
}

test("Ask with voice commands on doesn't cut the open microphone; it plays the listening tone", async () => {
  const voice = new CountingVoice(() => new Promise<VoiceResult>(() => {})); // listens until told otherwise
  const h = setup({ voice });
  h.c.toggleAssistant();
  h.drain();
  await new Promise((r) => setTimeout(r, 400)); // the loop polls every 200 ms
  assert.equal(h.any.listening, true, "the hands-free loop is listening");
  const said = h.engine.said.length;
  h.feedback.length = 0;
  await h.c.askByVoice();
  assert.equal(voice.finished, 0, "the question being spoken isn't cut off");
  assert.deepEqual(h.feedback, ["listen"], "the press is answered by the listening tone");
  assert.equal(h.engine.said.length, said, "nothing is spoken into the open microphone");
  assert.equal(h.c.state.assistantOn, true);
});

test("Ask with voice commands on, while the assistant is talking: it stops and says it is listening", async () => {
  const voice = new CountingVoice(() => new Promise<VoiceResult>(() => {}));
  const h = setup({ voice });
  h.c.toggleAssistant();
  h.say("جملة طويلة برشا باش تاخو وقت.", "answer");
  assert.equal(h.c.state.speaking, true);
  assert.equal(h.any.listening, false, "the loop waits while the assistant talks");
  await h.c.askByVoice();
  assert.equal(h.engine.last, T.listening);
  assert.ok(h.feedback.includes("listen"));
  assert.equal(voice.finished, 0);
});

test("Ask with voice commands off records one question; pressing it again sends it", async () => {
  const voice = new CountingVoice(() => new Promise<VoiceResult>(() => {}));
  const h = setup({ voice });
  void h.c.askByVoice();
  await flush();
  assert.equal(h.c.state.mic, "listening");
  await h.c.askByVoice();
  assert.equal(voice.finished, 1, "the second press ends the recording");
});

test("Pause's state stays 'paused' while a question asked during the pause is answered", async () => {
  const h = setup();
  await h.start();
  h.drain();
  assert.equal(h.c.state.paused, false);
  h.c.pause();
  assert.equal(h.c.state.paused, true);
  assert.equal(h.c.state.analysis, "paused");
  replies.push(scene({ spoken: "بيت فيها طاولة.", changed: true }));
  const asked = h.c.runTask("describe");
  await flush(2);
  assert.equal(h.c.state.paused, true, "the Resume button doesn't flip back to Pause during the answer");
  await asked;
  await flush();
  assert.equal(h.c.state.analysis, "paused", "the answer leaves the pause in place");
  h.c.resume();
  assert.equal(h.c.state.paused, false);
  h.c.stopCamera();
  await h.start();
  assert.equal(h.c.state.paused, false, "a new camera session starts unpaused");
});

// --- Emergency page: the location ------------------------------------------------------------------
// The location is looked up when the page opens. When there is none, the page's voice says so (after
// the opening sentence, never over it), so a user who relies on the voice knows the message won't
// carry it. Nothing is ever sent or opened by the app itself.

type Geo = { ok: true } | { ok: false; code: number } | "unsupported";
function setGeolocation(geo: Geo) {
  if (geo === "unsupported") {
    delete (navigator as unknown as Record<string, unknown>).geolocation;
    return;
  }
  Object.defineProperty(navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition(ok: (p: unknown) => void, fail: (e: unknown) => void) {
        // Answers later, as a real lookup does.
        setImmediate(() => (geo.ok ? ok({ coords: { latitude: 36.80649, longitude: 10.18153, accuracy: 12 } }) : fail({ code: geo.code, message: "" })));
      },
    },
  });
}
afterEach(() => setGeolocation("unsupported"));

function emergencySetup(geo: Geo, contact = true) {
  setGeolocation(geo);
  const h = setup();
  if (contact) h.c.updateSettings({ emergencyName: "Amina", emergencyPhone: "+216 98 123 456" });
  h.drain();
  h.engine.said.length = 0;
  h.engine.stops = 0;
  return h;
}

const geoFailures: [string, Geo][] = [
  ["the lookup fails (position unavailable)", { ok: false, code: 2 }],
  ["permission is denied", { ok: false, code: 1 }],
  ["location isn't supported", "unsupported"],
];
for (const [what, geo] of geoFailures) {
  test(`Emergency: when ${what}, "no location" is said after the opening sentence, and nothing is sent`, async () => {
    const h = emergencySetup(geo);
    h.c.openSheet("emergency");
    const opening = h.engine.said[0];
    assert.ok(T.emergency.startsWith(opening), "the opening sentence plays first");
    const stops = h.engine.stops;
    await flush();
    assert.equal(h.c.state.location.status, "failed");
    assert.equal(h.engine.stops, stops, "the opening sentence isn't cut");
    assert.ok(!h.engine.said.includes(T.noLocation), "it waits for the opening sentence to finish");
    h.drain();
    const at = h.engine.said.indexOf(T.noLocation);
    assert.ok(at > 0, "then it is said");
    assert.equal(h.engine.said.filter((s) => s === T.noLocation).length, 1, "once");
    assert.equal(h.c.emergencyMessage(), T.smsNoLocation, "the message asks them to call");
    assert.equal(posts.length, 0, "nothing was sent");
  });
}

test("Emergency: location found: nothing extra is said, and the message carries the map link", async () => {
  const h = emergencySetup({ ok: true });
  h.c.openSheet("emergency");
  await flush();
  h.drain();
  assert.equal(h.c.state.location.status, "ready");
  assert.ok(!h.engine.said.includes(T.noLocation));
  assert.equal(h.c.emergencyMessage(), `${T.sms} https://maps.google.com/?q=36.80649,10.18153`);
  assert.equal(posts.length, 0);
});

test("Emergency: no contact saved: no message to warn about, so 'no location' isn't said", async () => {
  const h = emergencySetup({ ok: false, code: 1 }, false);
  h.c.openSheet("emergency");
  await flush();
  h.drain();
  assert.equal(h.c.state.location.status, "failed");
  assert.ok(h.engine.said.includes(T.noContact));
  assert.ok(!h.engine.said.includes(T.noLocation));
});

test("Emergency: a page closed before the lookup ends says nothing about the location", async () => {
  const h = emergencySetup({ ok: false, code: 3 });
  h.c.openSheet("emergency");
  h.c.closeSheet("emergency");
  await flush();
  h.drain();
  assert.equal(h.c.state.location.status, "idle");
  assert.ok(!h.engine.said.includes(T.noLocation));
});

test("Emergency: the 'no location' sentence tells the truth in every language (the message asks them to call)", () => {
  for (const l of ["tn", "ar", "fr", "en"] as const) {
    const t = speech(l);
    assert.doesNotMatch(t.noLocation, /open the message|J'ouvre|سأفتح|نحلّك/, `${l}: the app never opens the message itself`);
  }
  assert.match(speech("en").noLocation, /ask them to call you/);
  assert.match(speech("fr").noLocation, /demandera de vous appeler/);
  assert.match(speech("tn").noLocation, /يعيّطلك/);
  assert.match(speech("ar").noLocation, /يتصل بك/);
});

// --- live measurements -----------------------------------------------------------------------------------

test("live measurements: kept on screen when the conversation ends, added to this device's totals, reported without content", async () => {
  const h = setup();
  await h.start();
  h.drain();
  storage.delete("nadhra.liveTotals.v1");
  fakeLive(h);
  const { LiveMetrics } = await import("../src/lib/live/metrics.ts");
  const m = new LiveMetrics();
  h.any.liveMetrics = m;
  m.opened();
  m.answerLatency(1050);
  m.usage({ promptTokenCount: 2000, responseTokenCount: 300, totalTokenCount: 2300 });
  m.pricing = { currency: "USD", input: { other: 1 }, output: { other: 2 } };
  h.c.stopLive();
  const s = h.c.state.liveStats!;
  assert.equal(s.answers, 1);
  assert.equal(s.tokens.total, 2300);
  assert.ok(Math.abs(s.cost! - (2000 * 1 + 300 * 2) / 1e6) < 1e-12);
  assert.equal(h.c.state.liveTotals?.sessions, 1);
  assert.equal(JSON.parse(localStorage.getItem("nadhra.liveTotals.v1")!).tokens, 2300);
  // A start that never connected isn't counted.
  fakeLive(h);
  h.any.liveMetrics = new LiveMetrics();
  h.c.stopLive(true);
  assert.equal(h.c.state.liveTotals?.sessions, 1);
});

// --- speaking first in a live conversation -------------------------------------------------------------

/** A live conversation through startLive, with a fake session and audio that record what happens. */
function startFakeLive(h: ReturnType<typeof setup>) {
  const ev: any = {};
  const mic: any = {};
  const audio = {
    played: [] as Uint8Array[], flushed: 0, isPlaying: false, closed: 0,
    play(p: Uint8Array) { this.played.push(p); }, flush() { this.flushed++; }, close() { this.closed++; }, setVolume() {}, setDucked() {},
    async startMic(e: object) { Object.assign(mic, e); },
  };
  const session = {
    status: "idle", isOpen: false, pricing: null, model: "m", voice: "Sulafat", frames: 0, stopped: 0,
    texts: [] as { text: string; opts: { measure?: boolean } }[],
    async start() { this.status = "open"; this.isOpen = true; ev.status("open"); },
    stop() { this.stopped++; this.isOpen = false; }, sendAudio() {}, sendFrame() { this.frames++; return true; },
    sendText(text: string, opts = {}) { this.texts.push({ text, opts }); return true; }, markSpeechEnd() {}, nudge() {},
  };
  h.any.makeLiveAudio = () => audio;
  h.any.makeLiveSession = (_o: unknown, e: object) => { Object.assign(ev, e); return session; };
  storage.set("assistant.liveConsent.v1", "1");
  const quiet = () => { h.drain(); h.any.lastLiveTalkAt = Date.now() - 10_000; h.any.liveBaseline ??= new Uint8Array(160 * 120); };
  const cues = () => session.texts.filter((t) => t.text.startsWith("[camera-update]"));
  return { ev, mic, audio, session, quiet, cues };
}
const pcm = (n: number) => new Uint8Array([n, n]);

test("speaking first: a changed view while the user is silent sends a cue; «SILENT» is never played or shown, real words are, from their first sound", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  assert.equal(h.c.state.live.status, "open");
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1, "the noisy fake camera is a changed view");
  assert.equal(L.cues()[0].opts.measure, false, "not counted as the user's waiting time");
  h.tick();
  assert.equal(L.cues().length, 1, "one at a time");
  // Nothing new.
  L.ev.audio(pcm(1));
  L.ev.aiText("SIL");
  L.ev.audio(pcm(2));
  L.ev.aiText("ENT.");
  L.ev.audio(pcm(3));
  L.ev.turnComplete();
  assert.equal(L.audio.played.length, 0, "never played");
  assert.doesNotMatch(h.c.state.live.ai + h.c.state.lastSpoken, /SILENT/i, "never shown or repeated");
  // «Nothing new»: the next look waits longer (12 s → 24 s).
  (h.any.proactive as { sent: number[] }).sent = [Date.now() - 13_000];
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1, "backoff after SILENT: 13 s is not enough any more");
  // Later, something important.
  (h.any.proactive as { sent: number[] }).sent = [Date.now() - 25_000];
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 2);
  assert.doesNotMatch(L.cues()[1].text, /You last said/, "nothing was said aloud yet");
  L.ev.audio(pcm(4));
  assert.equal(L.audio.played.length, 0, "held until its words are known");
  L.ev.aiText("ردّ بالك، فمّا دروج ");
  assert.deepEqual(L.audio.played, [pcm(4)], "played from its first sound");
  L.ev.audio(pcm(5));
  L.ev.aiText("قدّامك.");
  L.ev.turnComplete();
  assert.equal(L.audio.played.length, 2);
  assert.equal(h.c.state.lastSpoken, "ردّ بالك، فمّا دروج قدّامك.");
  assert.equal(h.c.state.liveStats?.proactiveCues, 2);
  assert.equal(h.c.state.liveStats?.proactiveSpoken, 1);
  h.c.stopLive(true);
});

test("speaking first: not while the user talks or just spoke, not when turned off, and a held answer is dropped when the user starts talking", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  h.drain();
  L.mic.speechStart();
  h.tick();
  assert.equal(L.cues().length, 0, "the user is talking");
  L.mic.speechEnd(Date.now());
  h.tick();
  assert.equal(L.cues().length, 0, "the user has just spoken");
  h.c.updateSettings({ liveProactive: false });
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 0, "turned off");
  h.c.updateSettings({ liveProactive: true });
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1);
  L.ev.audio(pcm(7));
  L.mic.speechStart(); // the user talks over it
  L.ev.aiText("فمّا باب");
  assert.ok(!L.audio.played.includes(pcm(7)) && !L.audio.played.some((p) => p[0] === 7), "the held sound is never played");
  h.c.stopLive(true);
});

test("speaking first: a held answer whose words are late is played after a moment, not lost", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1);
  L.ev.audio(pcm(9));
  assert.equal(L.audio.played.length, 0);
  await sleep(1_300);
  assert.equal(L.audio.played.length, 1);
  h.c.stopLive(true);
});

test("speaking first: a cued answer that promises the way is clear is cut like any other, and the correction is said", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1);
  L.ev.audio(pcm(1));
  L.ev.aiText("الطريق فارغ، تنجم تعدّي.");
  assert.ok(L.audio.flushed >= 1, "cut");
  assert.equal(h.any.liveMuted, true);
  L.ev.audio(pcm(2));
  assert.ok(!L.audio.played.some((p) => p[0] === 2), "the rest isn't played");
  assert.equal(L.audio.played.length, 0, "not even its first sound: its words were checked before it was played");
  h.drain();
  assert.ok(h.engine.said.includes(T.pathCaveat));
  h.c.stopLive(true);
});

// --- ending a live conversation: camera and microphone ---------------------------------------------------

test("ending live: a camera the conversation opened closes with it (tracks stopped, microphone closed), and the user is told", async () => {
  const h = setup({ auto: false });
  const L = startFakeLive(h);
  assert.equal(h.c.state.camera, "off");
  await h.c.startLive();
  assert.equal(h.c.state.camera, "on", "opened for the conversation");
  h.drain();
  h.c.toggleLive(); // End live conversation
  assert.equal(h.c.state.camera, "off");
  assert.equal(h.sources[0].stopped, true, "camera tracks stopped");
  assert.equal(L.audio.closed, 1, "microphone closed");
  assert.equal(L.session.stopped, 1);
  h.drain();
  assert.ok(h.engine.said.includes(T.liveOff) && h.engine.said.includes(T.cameraOff));
});

test("ending live: a camera that was already running stays on, with its on-device warnings", async () => {
  const h = setup({ auto: false });
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  h.c.toggleLive();
  assert.equal(h.c.state.camera, "on");
  assert.equal(h.sources[0].stopped, false);
  assert.equal(L.audio.closed, 1, "microphone closed all the same");
  h.c.stopAssistance();
});

test("ending live: voice commands taking over keep the camera; a language change restarts live and keeps it the conversation's", async () => {
  const h = setup({ auto: false, voice: new FakeVoice(() => new Promise<VoiceResult>(() => {})) });
  startFakeLive(h);
  await h.c.startLive();
  h.c.updateSettings({ language: "en" });
  await flush();
  assert.equal(h.c.state.camera, "on");
  assert.ok(h.any.liveSession, "restarted");
  assert.equal(h.any.liveOwnsCamera, true, "still the conversation's camera");
  h.c.toggleAssistant(); // voice commands need the microphone: live ends, the camera is theirs now
  assert.equal(h.any.liveSession, null);
  assert.equal(h.c.state.camera, "on");
  assert.equal(h.any.liveOwnsCamera, false);
  h.c.stopAssistance();
  h.c.updateSettings({ language: "tn" });
});

test("ending live: End pressed while the camera is still starting closes it", async () => {
  const h = setup({ auto: false });
  startFakeLive(h);
  let release!: () => void;
  h.any.makeSource = () => {
    const s = new FakeSource();
    s.start = () => new Promise<void>((r) => (release = () => { s.started = true; r(); }));
    h.sources.push(s);
    return s;
  };
  const starting = h.c.startLive();
  await flush();
  assert.equal(h.c.state.camera, "starting");
  h.c.toggleLive();
  release();
  await starting;
  await flush();
  assert.notEqual(h.c.state.camera, "on");
  assert.equal(h.sources[0].stopped, true, "the camera that finished starting is stopped at once");
});

test("ending live: hiding the page ends it; a camera it opened isn't reopened on return, and the user hears that live ended", async () => {
  const h = setup({ auto: false });
  const L = startFakeLive(h);
  await h.c.startLive();
  h.drain();
  (h.any.leaveWhileHidden as () => void).call(h.c);
  assert.equal(L.audio.closed, 1);
  assert.equal(h.c.state.camera, "off");
  (h.any.returnFromHidden as () => void).call(h.c);
  await flush();
  assert.equal(h.c.state.camera, "off", "not reopened");
  h.drain();
  assert.ok(h.engine.said.includes(T.liveOff));
});

// --- live frame selection --------------------------------------------------------------------------------

/** A smooth gradient: lit and with contrast, but no edges at all (what motion blur looks like). */
function gradient(w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const v = 60 + ((i % w) * 120) / w; px.set([v, v, v, 255], i * 4); }
  return px;
}

async function liveWithView(view: { kind: "blur" | "still" }) {
  const h = setup({ auto: false });
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  h.sources[0].thumbnail = (w: number, hh: number) => ({ rgba: view.kind === "blur" ? gradient(w, hh) : noise(w, hh, 42), width: w, height: hh });
  await h.c.startLive();
  h.drain();
  return { h, L };
}

test("live frames: a blurry picture isn't sent while a recent sharp one stands, but the model never goes long without any", async () => {
  const view = { kind: "blur" as "blur" | "still" };
  const { h, L } = await liveWithView(view);
  const sent = L.session.frames;
  h.any.lastLiveFrameAt = Date.now() - 2_000;
  h.tick();
  assert.equal(L.session.frames, sent, "blurry: skipped");
  h.any.lastLiveFrameAt = Date.now() - 7_000;
  h.tick();
  assert.equal(L.session.frames, sent + 1, "too long without a frame: sent, so the model can say it can't see well");
  // The user starts talking while the picture is blurry and the last frame is recent: not sent.
  h.any.lastLiveFrameAt = Date.now() - 1_000;
  L.mic.speechStart();
  assert.equal(L.session.frames, sent + 1);
  h.c.stopLive(true);
  assert.ok((h.c.state.liveStats?.framesSkipped.blurry ?? 0) >= 2, "counted in the measurements");
});

test("live frames: a still scene nobody talks about gets a copy every 6 s, every 3 s during a conversation", async () => {
  const view = { kind: "still" as "blur" | "still" };
  const { h, L } = await liveWithView(view);
  h.tick(); // the reference view
  const base = L.session.frames;
  h.any.lastLiveGray = (h.any.lastGray as Uint8Array).slice();
  h.any.lastLiveTalkAt = Date.now() - 30_000;
  h.any.lastLiveFrameAt = Date.now() - 4_000;
  h.tick();
  assert.equal(L.session.frames, base, "idle: 4 s is not stale yet");
  h.any.lastLiveFrameAt = Date.now() - 6_500;
  h.tick();
  assert.equal(L.session.frames, base + 1, "idle heartbeat");
  h.any.lastLiveTalkAt = Date.now();
  h.any.lastLiveFrameAt = Date.now() - 3_500;
  h.tick();
  assert.equal(L.session.frames, base + 2, "in conversation: every 3 s");
  h.c.stopLive(true);
});

test("speaking first: the user speaking resets the backoff, and the next cue tells the model what it last said", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  const gate = h.any.proactive as { sent: number[]; gapMs: number; silent(): void };
  gate.silent();
  gate.silent();
  assert.equal(gate.gapMs, 48_000);
  // The user asks something; the model answers.
  L.ev.userText("شنوّة قدّامي؟");
  assert.equal(gate.gapMs, 12_000, "back to the short gap");
  L.ev.audio(pcm(1));
  L.ev.aiText("فمّا باب على يمينك.");
  L.ev.turnComplete();
  gate.sent = [Date.now() - 13_000];
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1);
  assert.match(L.cues()[0].text, /You last said: «فمّا باب على يمينك\.»/);
  h.c.stopLive(true);
});

// --- final review regressions (mocked) ------------------------------------------------------------------

test("review: a warning cuts the live answer off for good — later chunks of that answer aren't played over it; the next answer is", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  h.drain();
  L.ev.userText("شنوّة قدّامي؟");
  L.ev.audio(pcm(1));
  assert.equal(L.audio.played.length, 1);
  h.say("ردّ بالك، كرهبة قدّامك", "urgent");
  assert.ok(L.audio.flushed >= 1, "what was playing stops");
  L.ev.audio(pcm(2));
  L.ev.aiText("فمّا طاولة.");
  assert.ok(!L.audio.played.some((p) => p[0] === 2), "the rest of that answer isn't played over the warning");
  L.ev.turnComplete();
  h.drain();
  L.ev.userText("وتوّا؟");
  L.ev.audio(pcm(3));
  assert.ok(L.audio.played.some((p) => p[0] === 3), "the next answer plays normally");
  h.c.stopLive(true);
});

test("review: a warning while a cue's answer is held drops it — it is never released over or after the warning", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1);
  L.ev.audio(pcm(4)); // held
  h.say("ردّ بالك، دروج", "warning");
  await sleep(1_400); // longer than the hold
  L.ev.audio(pcm(5));
  L.ev.aiText("فمّا دروج قدّامك.");
  L.ev.turnComplete();
  assert.ok(!L.audio.played.some((p) => p[0] === 4 || p[0] === 5), "nothing of the cue's answer is played");
  assert.equal(h.any.liveCue, null, "forgotten once its turn ended");
  h.c.stopLive(true);
});

test("review: the user speaking over a cue's answer that had begun discards the rest of it until its turn ends; then answers play", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  L.quiet();
  h.tick();
  L.ev.audio(pcm(6)); // the cue's answer has begun (held)
  L.ev.userText("استنّى");
  L.ev.audio(pcm(7)); // still the cue's turn
  assert.ok(!L.audio.played.some((p) => p[0] === 6 || p[0] === 7), "the old cue answer isn't played as if it were the user's");
  L.ev.interrupted(); // the service ends that turn
  L.ev.audio(pcm(8)); // the answer to the user
  assert.ok(L.audio.played.some((p) => p[0] === 8));
  h.c.stopLive(true);
});

test("review: a cue the model never answers doesn't block speaking first for the rest of the session", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1);
  // No answer at all. 9 s later (past answerTimeoutMs), and past the gap, another look is possible.
  (h.any.liveCue as { sentAt: number }).sentAt -= 9_000;
  (h.any.proactive as { sent: number[]; pendingSince: number | null }).sent = [Date.now() - 13_000];
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 2);
  h.c.stopLive(true);
});

test("review: a new object counts for a few seconds only, and not after the model has seen the view", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  // A still view, so only a new object could send a cue (live has just started: no cue yet).
  h.sources[0].thumbnail = (w: number, hh: number) => ({ rgba: noise(w, hh, 7), width: w, height: hh });
  h.tick();
  assert.equal(L.cues().length, 0);
  h.any.liveBaseline = (h.any.lastGray as Uint8Array).slice();
  h.any.liveNewObjectAt = Date.now() - 11_000; // seen while the user was talking, long ago
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 0, "stale");
  h.any.liveNewObjectAt = Date.now();
  L.ev.turnComplete(); // the model has just answered the user, with this view in front of it
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 0, "the model has seen it");
  h.any.liveNewObjectAt = Date.now();
  L.quiet();
  h.tick();
  assert.equal(L.cues().length, 1, "fresh");
  assert.match(L.cues()[0].text, /New object in view/);
  h.c.stopLive(true);
});

test("review: the same person flickering in and out of the detector doesn't count as new again", async () => {
  const detector = new FakeDetector();
  const h = setup({ detector });
  await h.start();
  h.drain();
  startFakeLive(h);
  await h.c.startLive();
  detector.sees = [NEAR_PERSON];
  await sleep(1_300); // the track is confirmed
  const first = h.any.liveNewObjectAt as number | null;
  assert.ok(first, "a person: new");
  h.any.liveNewObjectAt = null;
  detector.sees = [];
  await sleep(1_800); // longer than the tracker's timeout: the track is dropped
  detector.sees = [NEAR_PERSON];
  await sleep(1_300); // a new track for the same person
  assert.equal(h.any.liveNewObjectAt, null, "the same kind within a minute: not new");
  h.c.stopLive(true);
});

test("review: urgent warnings are never held — not by the user talking, not by the speaking-first backoff; other warnings wait at most a few seconds", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  h.any.liveHoldMaxMs = 150;
  await h.c.startLive();
  h.drain();
  const gate = h.any.proactive as { silent(): void; gapMs: number };
  gate.silent(); gate.silent(); gate.silent();
  assert.equal(gate.gapMs, 48_000);
  L.mic.speechStart(); // the user talks (or steady street noise looks like talking)
  const n = h.engine.said.length;
  h.say("ردّ بالك، كرهبة جاية", "urgent");
  assert.equal(h.engine.said.length, n + 1, "urgent: said at once");
  h.drain();
  h.say("فمّا شخص على يمينك", "warning");
  assert.ok(!h.engine.said.includes("فمّا شخص على يمينك"), "a lesser warning waits while the user talks...");
  await sleep(250);
  assert.ok(h.engine.said.includes("فمّا شخص على يمينك"), "...but not longer than the cap");
  L.mic.speechEnd(Date.now());
  assert.equal(h.any.liveHoldTimer, null, "timer cleared");
  h.c.stopLive(true);
});

test("review: no live timer survives the end of the conversation", async () => {
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  L.mic.speechStart();
  L.quiet();
  h.tick();
  L.ev.audio(pcm(1)); // a cue's held answer: its hold timer runs
  assert.ok(h.any.liveHoldTimer);
  h.c.stopLive(true);
  assert.equal(h.any.liveHoldTimer, null);
  assert.equal(h.any.liveCue, null);
  assert.equal(h.any.liveSession, null);
  assert.equal(L.audio.closed, 1);
});

test("a new live conversation: the AI greets with «عسلامة» once, after the phone's own notice", async () => {
  const { LIVE_GREETING, LIVE_GREETING_CUE, liveSystemPrompt } = await import("../src/lib/live/config.ts");
  assert.equal(LIVE_GREETING, "عسلامة");
  assert.ok(liveSystemPrompt("tn", "outward").includes(`${LIVE_GREETING_CUE} comes from the app when the call starts: answer it by saying only «عسلامة»`));
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  const greets = () => L.session.texts.filter((t) => t.text === LIVE_GREETING_CUE);
  assert.equal(h.engine.last, T.liveOn, "the phone's notice is unchanged");
  assert.equal(greets().length, 0, "not over the phone's notice");
  h.drain();
  assert.equal(greets().length, 1, "sent once the notice has been said");
  assert.equal(greets()[0].opts.measure, false, "not counted as the user's waiting time");
  (h.any.say as (t: string, p: string) => void).call(h.c, "x", "status");
  h.drain();
  assert.equal(greets().length, 1, "only once per conversation");
});

// --- the welcome when the app opens ------------------------------------------------------------------

test("the welcome «عسلامة» is said once per visit, and waits behind the camera's own sentences", async () => {
  const h = setup();
  h.c.greet("عسلامة");
  h.c.greet("عسلامة");
  assert.deepEqual(h.engine.said.filter((t) => t === "عسلامة"), ["عسلامة"], "once only");
  await h.start();
  h.drain();
  assert.ok(h.engine.said.includes(T.cameraOn), "the camera still says it is on");
  assert.equal(h.engine.said.filter((t) => t === "عسلامة").length, 1, "and the welcome isn't repeated");
});

test("an empty welcome says nothing", () => {
  const h = setup();
  h.c.greet("");
  assert.equal(h.engine.said.length, 0);
});

test("one greeting per visit: after the phone's «عسلامة», a live conversation doesn't greet again", async () => {
  const { LIVE_GREETING_CUE } = await import("../src/lib/live/config.ts");
  const h = setup();
  h.c.greet("عسلامة");
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  h.drain();
  assert.equal(L.session.texts.filter((t) => t.text === LIVE_GREETING_CUE).length, 0, "no second «عسلامة» from the AI");
});

test("one greeting per visit: a live conversation started first greets, and the phone stays quiet after it", async () => {
  const { LIVE_GREETING_CUE } = await import("../src/lib/live/config.ts");
  const h = setup();
  await h.start();
  h.drain();
  const L = startFakeLive(h);
  await h.c.startLive();
  h.drain();
  assert.equal(L.session.texts.filter((t) => t.text === LIVE_GREETING_CUE).length, 1, "the call's greeting is the one");
  h.c.greet("عسلامة");
  assert.ok(!h.engine.said.includes("عسلامة"), "the phone doesn't greet a second time");
});
