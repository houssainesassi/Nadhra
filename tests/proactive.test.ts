// Speaking first in a live conversation: when a cue may go out (quiet user, real change, rare),
// what the cue asks for, and how a cued answer is recognised as "nothing new".
import test from "node:test";
import assert from "node:assert/strict";
import { classifyCueAnswer, cueText, NewObjectFilter, PROACTIVE, ProactiveGate, type CueInput } from "../src/lib/live/proactive.ts";

const base = (over: Partial<CueInput> = {}): CueInput => ({
  now: 100_000, enabled: true, ready: true, userTalking: false, modelBusy: false, appSpeaking: false,
  lastTalkAt: 0, changed: 0.5, sharp: true, documentHeld: false, newObject: false, ...over,
});

test("gate: a real change while everyone is quiet sends a cue", () => {
  assert.equal(new ProactiveGate().decide(base()), "scene");
  assert.equal(new ProactiveGate().decide(base({ changed: PROACTIVE.sceneChange - 0.01 })), null, "small change: the same view");
  assert.equal(new ProactiveGate().decide(base({ changed: 0, newObject: true })), "new-object");
});

test("gate: never over the user, the model, the app's own voice, a document, a blurry picture, or when off", () => {
  const g = new ProactiveGate();
  for (const over of [{ enabled: false }, { ready: false }, { userTalking: true }, { modelBusy: true }, { appSpeaking: true }, { documentHeld: true }, { sharp: false }, { lastTalkAt: 100_000 - PROACTIVE.quietAfterTalkMs + 1 }]) {
    assert.equal(g.decide(base(over)), null, JSON.stringify(over));
  }
});

test("gate: rare — a gap between cues, one waiting at a time, at most a few a minute", () => {
  const g = new ProactiveGate();
  let now = 100_000;
  assert.equal(g.decide(base({ now })), "scene");
  g.sentAt(now);
  assert.equal(g.decide(base({ now: now + PROACTIVE.answerTimeoutMs - 1, newObject: true })), null, "waiting for its answer");
  g.answered();
  assert.equal(g.decide(base({ now: now + PROACTIVE.minGapMs - 1 })), null, "too soon");
  assert.equal(g.decide(base({ now: now + PROACTIVE.newObjectGapMs, newObject: true })), "new-object", "a new object may be looked at sooner");
  // Unanswered cues are forgotten after a while.
  const h = new ProactiveGate();
  h.sentAt(now);
  assert.equal(h.decide(base({ now: now + PROACTIVE.answerTimeoutMs + PROACTIVE.minGapMs })), "scene");
  // The per-minute cap.
  const c = new ProactiveGate();
  for (let i = 0; i < PROACTIVE.maxPerMinute; i++) {
    now += PROACTIVE.newObjectGapMs;
    assert.equal(c.decide(base({ now, newObject: true })), "new-object", `cue ${i}`);
    c.sentAt(now);
    c.answered();
  }
  now += PROACTIVE.newObjectGapMs;
  assert.ok(now - (now - PROACTIVE.newObjectGapMs * PROACTIVE.maxPerMinute) < 60_000);
  assert.equal(c.decide(base({ now, newObject: true })), null, "cap reached");
  c.reset();
  assert.equal(c.decide(base({ now, newObject: true })), "new-object");
});

test("cue: short (it stays in the context), says what changed, what the phone said and what the model last said", () => {
  const t = cueText("scene", "شخص قدّامك", "فمّا دروج قدّامك.");
  assert.match(t, /^\[camera-update\] View changed\./);
  assert.match(t, /Phone said: «شخص قدّامك»/);
  assert.match(t, /You last said: «فمّا دروج قدّامك\.»/);
  assert.equal(cueText("new-object"), "[camera-update] New object in view.");
  assert.ok(cueText("scene", "x".repeat(500), "y".repeat(500)).length < 260, "long quotes are cut");
});

test("cued answer: the fixed word is silent, its beginning waits, real words speak", () => {
  assert.equal(classifyCueAnswer("", false), "wait");
  assert.equal(classifyCueAnswer("", true), "silent", "nothing said at all");
  assert.equal(classifyCueAnswer("Sil", false), "wait");
  assert.equal(classifyCueAnswer(" SILENT.", false), "silent");
  assert.equal(classifyCueAnswer("silent", true), "silent");
  assert.equal(classifyCueAnswer("سايلنت", false), "silent");
  assert.equal(classifyCueAnswer("Sil", true), "speak", "a finished answer that isn't the word is spoken");
  assert.equal(classifyCueAnswer("ردّ بالك، فمّا", false), "speak");
  assert.equal(classifyCueAnswer("Silent night is on the poster", false), "speak");
});

test("token setup: Gemini's own proactive audio only when GEMINI_LIVE_PROACTIVE_AUDIO is set", async () => {
  const { buildLiveSetup, liveConfig } = await import("../src/lib/server/liveToken.ts");
  const saved = { ...process.env };
  try {
    process.env.GEMINI_API_KEY = "k";
    delete process.env.GEMINI_LIVE_PROACTIVE_AUDIO;
    assert.equal("proactivity" in buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 0 }, liveConfig()), false);
    process.env.GEMINI_LIVE_PROACTIVE_AUDIO = "1";
    assert.deepEqual((buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 0 }, liveConfig()) as { proactivity?: unknown }).proactivity, { proactiveAudio: true });
  } finally {
    process.env = saved;
  }
});

test("prompt: what to notice, reading as written in four languages, no 'nothing in the way', not a navigation system, cues", async () => {
  const { liveSystemPrompt } = await import("../src/lib/live/config.ts");
  for (const lang of ["tn", "ar", "fr", "en"] as const) {
    const p = liveSystemPrompt(lang, "outward");
    assert.match(p, /doors and entrances, signs, text, documents/);
    assert.match(p, /Arabic, Tunisian Arabic, French or English/);
    assert.match(p, /Don't translate unless asked/);
    assert.match(p, /Never say there is no obstacle/);
    assert.match(p, /Not seeing something doesn't mean it isn't there/);
    // Directions exist now, but only from the location tools, never estimated from the camera.
    assert.match(p, /not a collision-avoidance system/);
    assert.match(p, /never estimate distances in metres or steps from the camera/);
    assert.match(p, /You don't know where the user is and have no maps/, "without the tools, no location is ever guessed");
    assert.match(liveSystemPrompt(lang, "outward", true), /Never invent a place, a name, an address, a distance, a time or a direction/);
    assert.match(p, /\[camera-update\] come from the app/);
    assert.match(p, /only the word SILENT/);
    assert.match(p, /first a possible hazard \(stairs, a step or drop/, "how to answer a cue lives in the prompt now");
    assert.match(p, /say it in ONE short sentence/);
    assert.match(p, /Anything already said \(by you, or by the phone as quoted in the message\) is not new, unless it materially changed/);
    assert.match(p, /If the picture is unclear, don't guess/);
    assert.match(p, /don't describe again a view that hasn't changed/);
    assert.match(p, /Never read out or state a medicine's dose/, "medicine rule kept");
  }
});

test("backoff: 12 s → 24 s → 48 s after «nothing new», back to 12 s when the user or the model speaks; hard cap of 2 a minute", () => {
  const g = new ProactiveGate();
  assert.equal(PROACTIVE.maxPerMinute, 2);
  assert.equal(g.gapMs, 12_000);
  g.silent();
  assert.equal(g.gapMs, 24_000);
  g.silent();
  assert.equal(g.gapMs, 48_000);
  g.silent();
  assert.equal(g.gapMs, 48_000, "capped");
  let now = 100_000;
  g.sentAt(now);
  g.answered();
  assert.equal(g.decide(base({ now: now + 47_000 })), null, "a scene change waits for the longer gap");
  assert.equal(g.decide(base({ now: now + 48_000 })), "scene");
  // A new object is looked at sooner, but its gap backs off too (the same person coming back into
  // view isn't new); the backoff resets only when the model speaks about something, or the user does.
  const h = new ProactiveGate();
  h.silent();
  h.silent();
  h.sentAt(now);
  h.answered();
  assert.equal(h.newObjectGapMs, 28_000);
  assert.equal(h.decide(base({ now: now + PROACTIVE.newObjectGapMs, newObject: true, changed: 0 })), null);
  assert.equal(h.decide(base({ now: now + 28_000, newObject: true, changed: 0 })), "new-object");
  h.spoke();
  assert.equal(h.gapMs, 12_000);
  assert.equal(h.newObjectGapMs, PROACTIVE.newObjectGapMs);
  h.silent();
  h.resetBackoff();
  assert.equal(h.gapMs, 12_000);
  // The hard cap holds for new objects too.
  const c = new ProactiveGate();
  now = 0;
  for (let i = 0; i < 2; i++) { now += PROACTIVE.newObjectGapMs; assert.ok(c.decide(base({ now, newObject: true }))); c.sentAt(now); c.answered(); }
  now += PROACTIVE.newObjectGapMs;
  assert.equal(c.decide(base({ now, newObject: true })), null, "a third in the same minute is refused");
  assert.equal(c.decide(base({ now: 60_000 + PROACTIVE.newObjectGapMs + 1, newObject: true })), "new-object", "the window slides");
});

test("prompt: no repeats, no unrequested offers, newest important first, concise Derja, no certainty from a poor picture, hazards clearly", async () => {
  const { liveSystemPrompt } = await import("../src/lib/live/config.ts");
  const p = liveSystemPrompt("tn", "outward");
  assert.match(p, /Never repeat what you already said .* unless the user asks or something materially changed/);
  assert.match(p, /Never end an answer with an offer or a question nobody asked for, like «تحبّني نوصفلك أكثر؟»/);
  assert.match(p, /The newest important thing first/);
  assert.match(p, /Keep it short and natural, the way people talk in Tunis/);
  assert.match(p, /don't state anything with certainty from it/);
  assert.match(p, /Mention dangers first, clearly/);
  assert.match(p, /Never promise that a road or path is safe/);
  assert.doesNotMatch(liveSystemPrompt("en", "outward"), /people talk in Tunis/, "the Derja rule is for Derja");
});

test("new objects: the same kind seen again within a minute (flicker, the same person back in view) isn't new", () => {
  const f = new NewObjectFilter();
  assert.equal(f.update(["person"], true, 0), true, "a person, first time");
  assert.equal(f.update(["person"], false, 500), false, "still there");
  assert.equal(f.update([], false, 2_000), false, "lost for a moment");
  assert.equal(f.update(["person"], true, 4_000), false, "the tracker restarts the track: not new");
  for (let t = 5_000; t < 120_000; t += 5_000) assert.equal(f.update(["person"], t % 20_000 === 0, t), false, "flickering for two minutes");
  assert.equal(f.update(["person", "car"], true, 121_000), true, "a car is new");
  assert.equal(f.update([], false, 122_000), false);
  assert.equal(f.update(["person"], true, 175_000), false, "the person, last seen 54 s ago");
  assert.equal(f.update(["person"], true, 250_000), true, "not seen for more than a minute: new again");
  assert.equal(f.update(["bicycle"], false, 251_000), false, "the tracker didn't call it new");
  f.clear();
  assert.equal(f.update(["person"], true, 252_000), true);
});

test("new objects: the filter forgets old kinds, so a long session can't grow it", () => {
  const f = new NewObjectFilter(1_000);
  for (let i = 0; i < 500; i++) f.update([`kind${i}`], true, i * 10_000);
  assert.ok((f as unknown as { seen: Map<string, number> }).seen.size <= 2);
});
