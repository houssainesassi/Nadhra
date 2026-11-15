// Offline replay of "speaking first" with the app's own ProactiveGate: how many cues, how many
// spoken, and the tokens they cost, under the old rules (S2: 4 a minute, no backoff) and the new ones
// (2 a minute, 12 → 24 → 48 s after SILENT). No network, no quota.
//
//   node --experimental-strip-types e2e/live/simulate_cues.ts
//
// Token model from the real Nov 2026 session (e2e/live/out/real5/result.json): every turn re-reads
// the whole context, whose size grew from ~2,000 tokens by about 48 a second; answers 30-270 tokens.
// The model speaks about a scene it hasn't mentioned in the last 2 minutes, else says SILENT — what
// the real model did in that session (4 of 17 cues spoken: each scene twice, then only SILENT).
// Scenario "S6 as run" is what the real session's camera did (four scenes every ~19 s): the old rules
// should give about the 17 cues and ~188k tokens measured there.
import { PROACTIVE, ProactiveGate, type ProactiveConfig } from "../../src/lib/live/proactive.ts";

const OLD: ProactiveConfig = { ...PROACTIVE, maxPerMinute: 4, maxGapMs: PROACTIVE.minGapMs };
const NEW: ProactiveConfig = PROACTIVE;

type Scene = "mech" | "stairs";
const fixed = (t: number): Scene => (t < 70 ? "mech" : t < 150 ? "stairs" : t < 230 ? "mech" : "stairs");
// 290 frames of the 2-fps .mjpeg played at ~30 fps: the 70/80/80/70 s timeline every ~19.3 s.
const asRun = (t: number): Scene => { const c = (t % 19.3) / 19.3 * 290; return c < 70 ? "mech" : c < 150 ? "stairs" : c < 230 ? "mech" : "stairs"; };
// The five questions: [start, end of speech] in seconds (from the real session's timeline).
const QUESTIONS: [number, number][] = [[4, 5.8], [15.9, 18.4], [28.5, 31.2], [32.8, 36.8], [46.9, 49.3]];

function run(cfg: ProactiveConfig, sceneAt: (t: number) => Scene, durationS = 290) {
  const gate = new ProactiveGate(cfg);
  const prompt = (t: number) => Math.round(2000 + 48 * t);
  let tokens = 0, cues = 0, spoken = 0, userTurns = 0;
  let lastTalkAt = 0, busyUntil = -1, baseline: Scene = sceneAt(0), newObject = false;
  const mentioned: Partial<Record<Scene, number>> = {};
  const isNew = (sc: Scene, t: number) => mentioned[sc] == null || t - mentioned[sc]! > 120;
  let prevScene = sceneAt(0);
  const pending: { at: number; fn: () => void }[] = [];
  for (let ms = 0; ms <= durationS * 1000; ms += 500) {
    const t = ms / 1000;
    for (const p of pending.filter((p) => p.at <= t)) { p.fn(); pending.splice(pending.indexOf(p), 1); }
    const scene = sceneAt(t);
    if (scene !== prevScene && scene === "mech") newObject = true; // a person comes into view: the detector's new object
    prevScene = scene;
    const q = QUESTIONS.find(([a, b]) => t >= a && t < b);
    for (const [, end] of QUESTIONS) if (Math.abs(t - end) < 0.25) {
      userTurns++; lastTalkAt = t; gate.resetBackoff(); busyUntil = t + 6; mentioned[scene] = t;
      tokens += prompt(t) + 150;
      pending.push({ at: t + 6, fn: () => { lastTalkAt = t + 6; baseline = sceneAt(t + 6); } });
    }
    const reason = gate.decide({
      now: ms, enabled: true, ready: true, userTalking: !!q, modelBusy: t < busyUntil, appSpeaking: false,
      lastTalkAt: lastTalkAt * 1000, changed: scene !== baseline ? 1 : 0, sharp: true, documentHeld: false, newObject,
    });
    if (!reason) continue;
    gate.sentAt(ms);
    cues++;
    newObject = false;
    baseline = scene;
    busyUntil = t + 1.5;
    const speak = isNew(scene, t);
    if (speak) { spoken++; mentioned[scene] = t; }
    tokens += prompt(t) + (speak ? 60 : 30);
    pending.push({ at: t + 1.5, fn: () => { gate.answered(); if (speak) gate.spoke(); else gate.silent(); lastTalkAt = t + 1.5; baseline = sceneAt(t + 1.5); } });
  }
  return { cues, spoken, silent: cues - spoken, userTurns, tokens };
}

const rows = [];
for (const [name, scene] of [["S6 as run (scenes every ~19 s)", asRun], ["fixed timeline (70/80/80/70 s)", fixed]] as const) {
  const o = run(OLD, scene);
  const n = run(NEW, scene);
  rows.push({ scenario: name, rules: "old", ...o });
  rows.push({ scenario: name, rules: "new", ...n, tokenChange: `${(((n.tokens - o.tokens) / o.tokens) * 100).toFixed(0)}%` });
}
console.table(rows);

// --- long session: 30 minutes walking --------------------------------------------------------------
// The view changes every 20 s; the user asks something every 3 minutes; the model speaks on one cue in
// four (as in the real session). The context grows by ~40 tokens a second of audio and pictures, plus
// each turn's text (old cue text ~150 tokens, new ~35; a user turn ~60). Compression: Google's default
// trigger is 80% of the context window (assumed 128k → ~102k), the new setting 25,600 → 12,800.
function longRun(cfg: ProactiveConfig, cueTextTokens: number, trigger: number, target: number, minutes = 30) {
  const gate = new ProactiveGate(cfg);
  let context = 2000, tokens = 0, cues = 0, spoken = 0, maxTurn = 0;
  let lastTalkAt = 0, busyUntil = -1, baselineScene = 0;
  const turn = (t: number, textTokens: number, out: number) => {
    if (context >= trigger) context = target;
    tokens += context + out;
    maxTurn = Math.max(maxTurn, context);
    context += textTokens + out;
  };
  for (let ms = 0; ms <= minutes * 60_000; ms += 500) {
    const t = ms / 1000;
    context += 40 * 0.5;
    const scene = Math.floor(t / 20);
    if (t > 0 && t % 180 === 0) { turn(t, 60, 150); lastTalkAt = t + 5; busyUntil = t + 5; gate.resetBackoff(); baselineScene = scene; }
    const reason = gate.decide({ now: ms, enabled: true, ready: true, userTalking: false, modelBusy: t < busyUntil, appSpeaking: false,
      lastTalkAt: lastTalkAt * 1000, changed: scene !== baselineScene ? 1 : 0, sharp: true, documentHeld: false, newObject: false });
    if (!reason) continue;
    gate.sentAt(ms);
    cues++;
    baselineScene = scene;
    const speak = cues % 4 === 0;
    if (speak) spoken++;
    turn(t, cueTextTokens, speak ? 60 : 30);
    busyUntil = t + 1.5;
    gate.answered();
    if (speak) gate.spoke(); else gate.silent();
    lastTalkAt = t + 1.5;
  }
  return { cues, spoken, tokens, maxTurnPrompt: maxTurn };
}
const longRows = [
  { rules: "S2 rules, default compression, long cue", ...longRun(OLD, 150, 102_000, 51_000) },
  { rules: "new rules, default compression, short cue", ...longRun(NEW, 35, 102_000, 51_000) },
  { rules: "new rules, 25.6k compression, short cue (now)", ...longRun(NEW, 35, 25_600, 12_800) },
];
console.log("\n30-minute walking session:");
console.table(longRows.map((r) => ({ ...r, vsS2: `${(((r.tokens - longRows[0].tokens) / longRows[0].tokens) * 100).toFixed(0)}%` })));
