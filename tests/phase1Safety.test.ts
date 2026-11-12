// Pure pieces of the Phase 1 safety fixes: a warning dropped unheard can be said again, live
// answers are checked for safety promises, and the slower scan pace during a live conversation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpeechQueue } from "../src/lib/assistant/speechQueue.ts";
import { hazardKey, WarningGate } from "../src/lib/assistant/hazards.ts";
import { isSafetyClaim } from "../src/lib/assistant/schema.ts";
import { decideScan } from "../src/lib/assistant/scheduler.ts";
import type { SpeakOptions, TtsEngine } from "../src/lib/speech/tts.ts";
import type { Hazard } from "../src/lib/assistant/types.ts";

class Engine implements TtsEngine {
  readonly name = "fake";
  said: string[] = [];
  current: SpeakOptions | null = null;
  available() { return true; }
  voiceInfo() { return null; }
  speak(text: string, o: SpeakOptions) { this.said.push(text); this.current = o; }
  stop() { this.current = null; }
  end() { const c = this.current; this.current = null; c?.onEnd?.(); }
}

test("a warning that goes stale in the queue is reported by key, so its hazard can be announced again", () => {
  let now = 0;
  const dropped: string[] = [];
  const engine = new Engine();
  const q = new SpeechQueue(engine, { rate: () => 1, now: () => now, onDropped: (key, _p, why) => dropped.push(`${key}/${why}`) });
  q.setHold(true); // the user is talking
  q.say("فمّا شخص قدّامك.", "warning", undefined, "person:center");
  now += 9_000; // older than the warning's 8 s
  q.setHold(false);
  assert.deepEqual(dropped, ["person:center/stale"]);
  assert.equal(engine.said.length, 0);

  const gate = new WarningGate();
  const p: Hazard = { kind: "person", label: "", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown" };
  assert.equal(gate.admit(p, "caution", 0), true);
  assert.equal(gate.admit(p, "caution", 1_000), false, "normally held back for 45 s");
  gate.forget(hazardKey(p));
  assert.equal(gate.admit(p, "caution", 2_000), true, "after it was dropped unheard it is said again");
});

test("stopping the voice reports waiting warnings, but not the one already playing", () => {
  const dropped: string[] = [];
  const engine = new Engine();
  const q = new SpeechQueue(engine, { rate: () => 1, onDropped: (key, _p, why) => dropped.push(`${key}/${why}`) });
  q.say("رد بالك، فمّا درج قدّامك.", "urgent", undefined, "stairs:center");
  q.say("فمّا شخص على يمينك.", "warning", undefined, "person:right");
  q.stop();
  assert.deepEqual(dropped, ["person:right/stopped"]);
});

test("isSafetyClaim: promises and 'nothing ahead' are caught in all four languages; warnings aren't", () => {
  for (const s of [
    "الطريق فارغ.",
    "تنجم تعدّي توّا.",
    "ما فمّا شي قدّامك.",
    "Le chemin est libre.",
    "Vous pouvez traverser.",
    "The path is clear.",
    "You can cross now.",
    "There's nothing in front of you.",
    "لا يوجد أي خطر.",
  ]) assert.equal(isSafetyClaim(s), true, s);
  for (const s of [
    "ما نجمش نأكّدلك إلي الطريق آمن.",
    "فمّا طاولة على يمينك.",
    "I can't confirm the way is safe.",
    "Il y a une porte devant vous.",
    "شنوة تحب نقرالك؟",
  ]) assert.equal(isSafetyClaim(s), false, s);
});

test("scheduler: the live-conversation pace is slower but hazards are still checked", () => {
  const base = { now: 100_000, lastScanAt: 94_000, changed: 0.5, quality: "ok" as const, inFlight: false, paused: false, hidden: false, backoffUntil: 0, unchangedStreak: 0, newObject: false, blurSince: null };
  assert.equal(decideScan(base).send, true);
  assert.equal(decideScan({ ...base, minIntervalMs: 8_000 }).send, false);
  assert.equal(decideScan({ ...base, lastScanAt: 91_000, minIntervalMs: 8_000 }).send, true);
});
