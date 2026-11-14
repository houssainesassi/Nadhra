// Frame selection, speech order, object tracking, voice commands, audio encoding, settings.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { changedFraction, classifyQuality, frameStats, rgbaToGray } from "../src/lib/assistant/frameAnalysis.ts";
import { backoffMs, decideScan, heartbeatFor, SCHEDULE, type ScanInput } from "../src/lib/assistant/scheduler.ts";
import { isRepeat, similarity, SpeechQueue, speechChunks } from "../src/lib/assistant/speechQueue.ts";
import { HazardTracker, type RawDetection } from "../src/lib/assistant/hazardTracker.ts";
import { parseCommand } from "../src/lib/assistant/commands.ts";
import { bytesToBase64, downsample, encodeWav } from "../src/lib/assistant/wav.ts";
import { sanitizeVisionSettings } from "../src/lib/assistant/settings.ts";
import type { SpeakOptions, TtsEngine } from "../src/lib/speech/tts.ts";

const W = 64, H = 48;
const flat = (v: number) => new Uint8Array(W * H).fill(v);
function textured(mean: number, amp: number, seed = 1) {
  const g = new Uint8Array(W * H);
  let x = seed;
  for (let i = 0; i < g.length; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    g[i] = Math.max(0, Math.min(255, mean + (x % (2 * amp + 1)) - amp));
  }
  return g;
}

test("frame quality: dark, blank and blurred frames are recognised", () => {
  const q = (g: Uint8Array) => classifyQuality(frameStats(g, W, H));
  assert.equal(q(textured(10, 8)), "dark");
  assert.equal(q(flat(120)), "flat");
  assert.equal(q(textured(250, 4)), "bright");
  assert.equal(q(textured(120, 60)), "ok");
  const smooth = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) smooth[y * W + x] = 60 + x * 2;
  assert.equal(q(smooth), "blurry");
});

test("rgbaToGray and changedFraction", () => {
  assert.deepEqual([...rgbaToGray(new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]))], [255, 0]);
  const a = textured(120, 5), b = a.slice();
  assert.equal(changedFraction(a, b), 0);
  for (let i = 0; i < a.length / 4; i++) b[i] = 250; // something entered a quarter of the view
  assert.ok(Math.abs(changedFraction(a, b) - 0.25) < 0.01);
  assert.ok(changedFraction(textured(120, 5, 1), textured(120, 5, 2)) < 0.01, "sensor noise is not a change");
  assert.equal(changedFraction(new Uint8Array(4), new Uint8Array(8)), 1);
});

const base: ScanInput = { now: 100_000, lastScanAt: 90_000, changed: 0, quality: "ok", inFlight: false, paused: false, hidden: false, backoffUntil: 0, unchangedStreak: 0, newObject: false, blurSince: null };
const decide = (p: Partial<ScanInput>) => decideScan({ ...base, ...p });

test("scheduler: a still scene sends nothing until the heartbeat, a change sends at once", () => {
  assert.deepEqual(decide({}), { send: false, reason: "no-change" });
  assert.deepEqual(decide({ changed: 0.2 }), { send: true, reason: "change" });
  assert.deepEqual(decide({ lastScanAt: base.now - SCHEDULE.heartbeatMs }), { send: true, reason: "heartbeat" });
  assert.deepEqual(decide({ lastScanAt: -Infinity }), { send: true, reason: "first" });
});

test("scheduler: never overlaps or exceeds the rate, and respects pause, hidden and backoff", () => {
  const changed = { changed: 0.9 };
  assert.equal(decide({ ...changed, inFlight: true }).send, false);
  assert.equal(decide({ ...changed, paused: true }).send, false);
  assert.equal(decide({ ...changed, hidden: true }).send, false);
  assert.equal(decide({ ...changed, backoffUntil: base.now + 1 }).send, false);
  assert.equal(decide({ ...changed, lastScanAt: base.now - SCHEDULE.minIntervalMs + 1 }).send, false);
  assert.equal(decide({ ...changed, newObject: true, lastScanAt: base.now - 100 }).send, false, "a new object still respects the rate");
});

test("scheduler: unusable frames aren't sent; blurred ones wait, but not forever", () => {
  for (const quality of ["dark", "bright", "flat"] as const) assert.equal(decide({ changed: 1, quality }).send, false);
  assert.equal(decide({ changed: 1, quality: "blurry", blurSince: base.now - 1000 }).send, false);
  assert.equal(decide({ changed: 1, quality: "blurry", blurSince: base.now - SCHEDULE.blurWaitMs }).send, true);
});

test("scheduler: heartbeat slows while nothing changes, and backoff is bounded", () => {
  assert.equal(heartbeatFor(0), SCHEDULE.heartbeatMs);
  assert.equal(heartbeatFor(1), SCHEDULE.heartbeatMs * 2);
  assert.equal(heartbeatFor(50), SCHEDULE.maxHeartbeatMs);
  assert.ok(backoffMs(2) > backoffMs(1));
  assert.equal(backoffMs(50), SCHEDULE.maxBackoffMs);
  assert.equal(backoffMs(1, 90_000), 90_000, "Retry-After wins when longer");
});

test("speech chunks: long readings split at sentences and stay within the voice limit", () => {
  assert.deepEqual(speechChunks("جملة. جملة أخرى."), ["جملة. جملة أخرى."]);
  const long = Array.from({ length: 30 }, (_, i) => `هذي الجملة رقم ${i} متاع الورقة.`).join(" ");
  const chunks = speechChunks(long, 100);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join(" "), long);
  assert.ok(speechChunks("ك".repeat(950), 400).every((c) => c.length <= 400));
  assert.deepEqual(speechChunks("   "), []);
});

class FakeEngine implements TtsEngine {
  readonly name = "fake";
  said: string[] = [];
  stops = 0;
  live: SpeakOptions | null = null;
  concurrent = 0;
  maxConcurrent = 0;
  available() { return true; }
  voiceInfo() { return null; }
  speak(text: string, opts: SpeakOptions) {
    this.said.push(text);
    this.live = opts;
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
  }
  stop() {
    this.stops++;
    if (this.live) this.concurrent--;
    const live = this.live;
    this.live = null;
    live?.onEnd?.(); // like a browser reporting the cancelled sentence as finished
  }
  end() {
    const live = this.live;
    this.live = null;
    this.concurrent--;
    live?.onEnd?.();
  }
  fail() {
    const live = this.live;
    this.live = null;
    this.concurrent--;
    live?.onError?.("boom");
  }
}

const queues: SpeechQueue[] = [];
after(() => queues.forEach((q) => q.stop())); // clears their watchdog timers

function queue(extra = {}) {
  const engine = new FakeEngine();
  let now = 0;
  const q = new SpeechQueue(engine, { rate: () => 0.9, now: () => now, watchdogBaseMs: 100_000, ...extra });
  queues.push(q);
  return { engine, q, advance: (ms: number) => (now += ms) };
}

test("speech: one voice at a time, in priority order, and status messages aren't lost", () => {
  const { engine, q } = queue();
  q.say("حالة.", "status");
  q.say("وصف.", "narration");
  q.say("جواب.", "answer");
  assert.deepEqual(engine.said, ["حالة."], "an answer doesn't cut a status message: it may be the safety notice");
  engine.end();
  assert.deepEqual(engine.said, ["حالة.", "جواب."]);
  engine.end();
  assert.deepEqual(engine.said, ["حالة.", "جواب.", "وصف."]);
  assert.equal(engine.maxConcurrent, 1);
});

test("speech: an answer cuts narration, and narration isn't resumed", () => {
  const { engine, q } = queue();
  q.say("وصف.", "narration");
  q.say("جواب.", "answer");
  assert.deepEqual(engine.said, ["وصف.", "جواب."]);
  engine.end();
  assert.equal(q.busy, false);
});

test("speech: a warning cuts a status message, which then resumes", () => {
  const { engine, q } = queue();
  q.say("حالة.", "status");
  q.say("رد بالك.", "urgent");
  engine.end();
  assert.deepEqual(engine.said, ["حالة.", "رد بالك.", "حالة."]);
});

test("speech: an urgent warning interrupts at once, and an interrupted answer resumes", () => {
  const { engine, q } = queue();
  q.say("جواب.", "answer");
  q.say("رد بالك.", "urgent");
  assert.deepEqual(engine.said, ["جواب.", "رد بالك."]);
  engine.end();
  assert.deepEqual(engine.said, ["جواب.", "رد بالك.", "جواب."], "the answer resumes");
  assert.equal(engine.maxConcurrent, 1, "never two voices");
});

test("speech: a caution warning cuts into a long reading, which resumes; it never cuts an urgent one", () => {
  const { engine, q } = queue();
  q.say(Array.from({ length: 40 }, (_, i) => `هذا السطر رقم ${i} من الورقة.`).join(" "), "answer"); // several distinct chunks
  const chunk = engine.said[0];
  q.say("فمّا عبد قدّامك.", "warning");
  assert.deepEqual(engine.said, [chunk, "فمّا عبد قدّامك."], "played at once, not after the whole reading");
  engine.end();
  assert.equal(engine.said[2], chunk, "the cut chunk is read again");
  q.say("رد بالك، درج.", "urgent");
  q.say("فمّا كرهبة.", "warning");
  assert.equal(engine.said[engine.said.length - 1], "رد بالك، درج.", "a warning waits for the urgent one");
  engine.end();
  assert.equal(engine.said[engine.said.length - 1], "فمّا كرهبة.", "then plays before the rest of the reading");
  assert.equal(engine.maxConcurrent, 1);
});

test("speech: a caution warning goes stale quickly: an old warning is wrong about now", () => {
  const { engine, q, advance } = queue();
  q.setHold(true); // the user is talking
  q.say("فمّا عبد قدّامك.", "warning");
  advance(9_000);
  q.setHold(false);
  assert.equal(engine.said.length, 0);
});

test("scheduler: speech playing never holds a scan back", () => {
  // Formerly scans paused during any speech, so a long reading also paused stairs and drop warnings.
  assert.equal(Object.hasOwn(base, "speaking"), false);
  assert.deepEqual(decide({ changed: 0.2 }), { send: true, reason: "change" });
});

test("speech: narration is replaced by newer narration, and goes stale", () => {
  const { engine, q, advance } = queue();
  q.say("جواب.", "answer");
  q.say("قديم.", "narration");
  q.say("جديد.", "narration");
  engine.end();
  assert.deepEqual(engine.said, ["جواب.", "جديد."]);
  engine.end();
  q.say("جواب ثاني.", "answer");
  q.say("وصف.", "narration");
  advance(60_000);
  engine.end();
  assert.deepEqual(engine.said, ["جواب.", "جديد.", "جواب ثاني."], "stale narration is dropped");
});

test("speech: the same sentence isn't queued twice", () => {
  const { engine, q } = queue();
  q.say("فمّا درج.", "urgent");
  q.say("فمّا درج.", "urgent");
  engine.end();
  assert.equal(engine.said.length, 1);
  assert.equal(q.busy, false);
});

test("speech: stop silences everything; hold lets only urgent through", () => {
  const { engine, q } = queue();
  q.say("جواب.", "answer");
  q.say("جواب آخر.", "status");
  q.stop();
  assert.equal(q.busy, false);
  assert.equal(engine.said.length, 1);
  q.setHold(true);
  q.say("وصف.", "narration");
  assert.equal(engine.said.length, 1);
  q.say("رد بالك.", "urgent");
  assert.equal(engine.said[1], "رد بالك.");
  engine.end();
  assert.equal(engine.said.length, 2);
  q.setHold(false);
  assert.equal(engine.said[2], "وصف.");
});

test("speech: a failing engine reports the text and doesn't jam the queue", () => {
  const failed: string[] = [];
  const { engine, q } = queue({ onFailure: (t: string) => failed.push(t) });
  q.say("واحد.", "answer");
  q.say("زوز.", "status");
  engine.fail();
  assert.deepEqual(failed, ["واحد."]);
  assert.equal(engine.said[1], "زوز.");
});

test("speech: an engine that never reports the end doesn't block forever", async () => {
  const { engine, q } = queue({ watchdogBaseMs: 10 });
  q.say("واحد.", "status");
  q.say("زوز.", "status");
  await new Promise((r) => setTimeout(r, 1200)); // the limit also grows with the sentence length
  assert.deepEqual(engine.said, ["واحد.", "زوز."]);
  q.stop();
});

test("similarity: a rewording counts as a repeat, a new scene doesn't", () => {
  assert.equal(similarity("قدّامك باب على اليمين.", "قدّامك باب على اليمين"), 1);
  assert.ok(isRepeat("قدّامك باب على اليمين توّة.", ["قدّامك باب على اليمين."]));
  assert.ok(!isRepeat("فمّا كرهبة في الشارع.", ["قدّامك باب على اليمين."]));
  assert.ok(!isRepeat("", ["x y"]));
});

const det = (p: Partial<RawDetection>): RawDetection => ({ label: "car", score: 0.8, x: 0.4, y: 0.4, w: 0.2, h: 0.2, ...p });
const still = { cameraMoving: false, facing: "outward" } as const;

test("tracker: one or two sightings are not believed", () => {
  const t = new HazardTracker();
  assert.deepEqual(t.update([det({})], 0, still), { hazards: [], newObject: false });
  assert.equal(t.update([det({})], 300, still).hazards.length, 0);
  const third = t.update([det({})], 600, still);
  assert.equal(third.hazards.length, 1);
  assert.equal(third.newObject, true);
  assert.equal(third.hazards[0].confidence, "likely");
  assert.equal(t.update([det({})], 900, still).newObject, false, "reported once");
  assert.equal(t.update([det({})], 1200, still).hazards[0].confidence, "confirmed");
});

test("tracker: a flicker that disappears never reports; low scores and unknown classes are ignored", () => {
  const t = new HazardTracker();
  t.update([det({})], 0, still);
  t.update([det({})], 300, still);
  assert.equal(t.update([], 3000, still).hazards.length, 0);
  assert.equal(t.update([det({})], 3300, still).hazards.length, 0, "starts counting again");
  const u = new HazardTracker();
  for (let i = 0; i < 6; i++) {
    assert.equal(u.update([det({ score: 0.3 }), det({ label: "banana" }), det({ label: "chair", score: 0.55, x: 0 })], i * 300, still).hazards.length, 0);
  }
});

test("tracker: approaching needs growth over time and a still camera", () => {
  const grow = (moving: boolean) => {
    const t = new HazardTracker();
    let last;
    for (let i = 0; i < 8; i++) {
      const s = 0.2 + i * 0.03;
      last = t.update([det({ x: 0.5 - s / 2, y: 0.5 - s / 2, w: s, h: s })], i * 300, { ...still, cameraMoving: moving });
    }
    return last!.hazards[0].motion;
  };
  assert.equal(grow(false), "approaching");
  assert.equal(grow(true), "unknown", "the camera itself moved");

  const shrink = new HazardTracker();
  let last;
  for (let i = 0; i < 8; i++) {
    const s = 0.45 - i * 0.03;
    last = shrink.update([det({ x: 0.5 - s / 2, y: 0.5 - s / 2, w: s, h: s })], i * 300, still);
  }
  assert.equal(last!.hazards[0].motion, "moving_away");

  const steady = new HazardTracker();
  for (let i = 0; i < 8; i++) last = steady.update([det({ w: 0.2 + (i % 2) * 0.005 })], i * 300, still);
  assert.equal(last!.hazards[0].motion, "stationary");

  const short = new HazardTracker();
  for (let i = 0; i < 4; i++) last = short.update([det({ w: 0.1 + i * 0.1, h: 0.1 + i * 0.1 })], i * 100, still);
  assert.equal(last!.hazards[0].motion, "unknown", "too short a time to tell");
});

test("tracker: side and proximity, and left/right for a webcam facing the user", () => {
  const seen = (d: RawDetection, facing: "outward" | "user" = "outward") => {
    const t = new HazardTracker();
    let last;
    for (let i = 0; i < 3; i++) last = t.update([d], i * 300, { cameraMoving: false, facing });
    return last!.hazards[0];
  };
  assert.equal(seen(det({ x: 0, w: 0.2 })).side, "left");
  assert.equal(seen(det({ x: 0.8, w: 0.2 })).side, "right");
  assert.equal(seen(det({ x: 0.4, w: 0.2 })).side, "center");
  assert.equal(seen(det({ x: 0, w: 0.2 }), "user").side, "right");
  assert.equal(seen(det({ w: 0.6, h: 0.5, x: 0.2 })).proximity, "near");
  assert.equal(seen(det({ w: 0.1, h: 0.1 })).proximity, "far");
  assert.equal(seen(det({ label: "person", h: 0.8, y: 0.1, w: 0.3 })).proximity, "near");
});

test("tracker: a desk webcam doesn't warn about the user or their room, but vehicles still count", () => {
  const seen = (d: RawDetection) => {
    const t = new HazardTracker();
    let last;
    for (let i = 0; i < 3; i++) last = t.update([d], i * 300, { cameraMoving: false, facing: "user" });
    return last!.hazards.length;
  };
  assert.equal(seen(det({ label: "person", h: 0.8, y: 0.1, w: 0.4 })), 0);
  assert.equal(seen(det({ label: "chair", w: 0.5, h: 0.6, y: 0.4 })), 0);
  assert.equal(seen(det({ label: "person", h: 0.4, w: 0.2 })), 1);
  assert.equal(seen(det({ label: "car" })), 1);
});

test("voice commands: short phrases match, questions don't", () => {
  assert.equal(parseCommand("اسكت"), "stop-speech");
  assert.equal(parseCommand("اُسكت!"), "stop-speech");
  assert.equal(parseCommand("عاود"), "repeat");
  assert.equal(parseCommand("وقّف التحليل"), "pause");
  assert.equal(parseCommand("كمّل"), "resume");
  assert.equal(parseCommand("سكّر الكاميرا"), "camera-off");
  assert.equal(parseCommand("شعّل الكاميرا"), "camera-on");
  assert.equal(parseCommand("موافق"), "yes");
  assert.equal(parseCommand("شنوة قدّامي؟"), "front", "a main task: it can start the camera first");
  assert.equal(parseCommand("وين الكاميرا اللي سكرتها"), null);
});

test("WAV encoding: valid header, length, clipping and resampling", () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const v = new DataView(wav.buffer);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), "WAVE");
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(wav.length, 52);
  assert.deepEqual([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true), v.getInt16(50, true)], [0, 32767, -32768, 32767]);
  assert.equal(downsample(new Float32Array(48000), 48000, 16000).length, 16000);
  assert.deepEqual([...downsample(new Float32Array([0.5, 0.5, 0.5, 1, 1, 1]), 48000, 16000)], [0.5, 1]);
  assert.equal(bytesToBase64(new Uint8Array([72, 105])), "SGk=");
  assert.equal(atob(bytesToBase64(new Uint8Array(100_000).fill(65))).length, 100_000);
});

test("settings: corrupted values fall back to defaults", () => {
  assert.deepEqual(
    sanitizeVisionSettings({ rate: "fast", facing: "up", autoDescribe: 1, screenReaderEcho: null, volume: "max", language: 3, vibration: "yes", textScale: [], emergencyName: {}, emergencyPhone: 5 }),
    { rate: 1, volume: 1, facing: "auto", autoDescribe: false, screenReaderEcho: false, language: "tn", vibration: true, textScale: 1, emergencyName: "", emergencyPhone: "" },
  );
  // Automatic descriptions are off unless chosen; the old «narration» setting doesn't turn them on.
  assert.equal(sanitizeVisionSettings({ narration: true }).autoDescribe, false);
  assert.equal(sanitizeVisionSettings({ autoDescribe: true }).autoDescribe, true);
  assert.equal(sanitizeVisionSettings({ rate: 99 }).rate, 1.5);
  assert.equal(sanitizeVisionSettings(null).facing, "auto");
});

test("speech: an answer sentence said twice is spoken twice (the check after each dose), a status isn't", async () => {
  const { SpeechQueue } = await import("../src/lib/assistant/speechQueue.ts");
  const said: string[] = [];
  let end: (() => void) | undefined;
  const engine = { name: "fake", available: () => true, voiceInfo: () => null, speak: (t: string, o: { onEnd?: () => void }) => { said.push(t); end = o.onEnd; }, stop: () => {} };
  const q = new SpeechQueue(engine as never, { rate: () => 1 });
  for (const t of ["500 mg.", "ثبّت فيها مع الصيدلي.", "20 mg.", "ثبّت فيها مع الصيدلي."]) q.say(t, "answer");
  for (let i = 0; i < 6; i++) end?.();
  assert.deepEqual(said, ["500 mg.", "ثبّت فيها مع الصيدلي.", "20 mg.", "ثبّت فيها مع الصيدلي."]);
  said.length = 0;
  q.say("الكاميرا خدّامة.", "status");
  q.say("الكاميرا خدّامة.", "status");
  for (let i = 0; i < 3; i++) end?.();
  assert.deepEqual(said, ["الكاميرا خدّامة."]);
});
