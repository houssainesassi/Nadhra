// Speaking first in a live conversation. Gemini Live only answers after the user says something,
// so when the user is silent the app itself decides that the view has changed enough to be worth a
// look, and sends the model a short cue with a fresh frame. The model then says one short sentence
// about anything important and new (a hazard first), or answers with a fixed word that is never
// played. Pure logic with explicit times, tested in Node.
//
// The cues are rare on purpose: each one is a model turn, which re-reads the conversation (cost),
// and a voice that keeps talking is worse than one that speaks when it matters.

export const PROACTIVE = {
  /**
   * At least this long between two cues. After each «nothing new» answer the gap doubles, up to
   * maxGapMs (12 s → 24 s → 48 s); it is back to 12 s when the user speaks or the model actually
   * speaks about something new (the on-device detector can't tell a new person from the same one
   * coming back into view: the model's answer decides what is genuinely new). Measured on a real session (Nov 2026): 13 of 17 cues were «nothing new», and
   * cue turns were 90% of the session's tokens.
   */
  minGapMs: 12_000,
  maxGapMs: 48_000,
  /** A new object found by the on-device detector may be checked sooner; this gap backs off too (7 → 14 → 28 s). */
  newObjectGapMs: 7_000,
  /** At most this many cues in any minute, whatever the reason (a hard cap). */
  maxPerMinute: 2,
  /** Quiet this long after the user or the model last spoke: the conversation comes first. */
  quietAfterTalkMs: 4_000,
  /** Share of changed pixels, compared with the view when the model last spoke or was cued. */
  sceneChange: 0.25,
  /** A cue with no answer at all after this long is forgotten. */
  answerTimeoutMs: 8_000,
  /** Audio of a cued answer is held until its words show it isn't the "nothing new" word; at most this long. */
  holdAudioMs: 1_200,
};

export type ProactiveConfig = { readonly [K in keyof typeof PROACTIVE]: number };

/** The word the model says when nothing important is new. Caught from the transcript, never played. */
export const SILENT_WORD = "SILENT";

export type CueReason = "new-object" | "scene";

export interface CueInput {
  now: number;
  enabled: boolean;
  /** The live connection is open and the camera is on. */
  ready: boolean;
  userTalking: boolean;
  /** The model is answering (audio playing, or a turn in progress). */
  modelBusy: boolean;
  /** The app's own voice is speaking (a warning, a status sentence). */
  appSpeaking: boolean;
  /** When the user or the model last spoke. */
  lastTalkAt: number;
  /** Changed share of the view since the baseline. */
  changed: number;
  /** The picture is usable (not blurry, dark or covered). */
  sharp: boolean;
  /** A document is held in view: reading is never left to the live model. */
  documentHeld: boolean;
  /** The on-device detector found a new object since the last cue. */
  newObject: boolean;
}

export class ProactiveGate {
  private sent: number[] = [];
  /** A cue waiting for its answer. */
  pendingSince: number | null = null;
  /** «Nothing new» answers in a row since the last reset: each one doubles the gap. */
  private silentStreak = 0;
  private readonly cfg: ProactiveConfig;

  constructor(cfg: ProactiveConfig = PROACTIVE) {
    this.cfg = cfg;
  }

  /** The gap before the next scene cue, with the backoff. */
  get gapMs(): number {
    return Math.min(this.cfg.maxGapMs, this.cfg.minGapMs * 2 ** this.silentStreak);
  }

  /** The gap before a cue for a new object, with the same backoff. */
  get newObjectGapMs(): number {
    return Math.min(this.cfg.maxGapMs, this.cfg.newObjectGapMs * 2 ** this.silentStreak);
  }

  decide(i: CueInput): CueReason | null {
    if (!i.enabled || !i.ready || i.documentHeld || !i.sharp) return null;
    if (this.pendingSince != null) {
      if (i.now - this.pendingSince < this.cfg.answerTimeoutMs) return null;
      this.pendingSince = null; // never answered: forgotten
    }
    if (i.userTalking || i.modelBusy || i.appSpeaking) return null;
    if (i.now - i.lastTalkAt < this.cfg.quietAfterTalkMs) return null;
    this.sent = this.sent.filter((t) => i.now - t < 60_000);
    if (this.sent.length >= this.cfg.maxPerMinute) return null;
    const last = this.sent[this.sent.length - 1] ?? -Infinity;
    const since = i.now - last;
    if (i.newObject && since >= this.newObjectGapMs) return "new-object";
    if (i.changed >= this.cfg.sceneChange && since >= this.gapMs) return "scene";
    return null;
  }

  sentAt(now: number) {
    this.sent.push(now);
    this.pendingSince = now;
  }

  answered() {
    this.pendingSince = null;
  }

  /** The model said «nothing new»: wait longer before the next cue. */
  silent() {
    if (this.cfg.minGapMs * 2 ** this.silentStreak < this.cfg.maxGapMs) this.silentStreak++;
  }

  /** The model spoke about something genuinely new: back to the short gap. */
  spoke() {
    this.silentStreak = 0;
  }

  /** The user spoke: the conversation is active again, so is the short gap. */
  resetBackoff() {
    this.silentStreak = 0;
  }

  reset() {
    this.sent = [];
    this.pendingSince = null;
    this.silentStreak = 0;
  }
}

/**
 * Which on-device detections count as a new object for speaking first. The tracker reports a new
 * object whenever it starts a new track, and a track is restarted when an object is lost for a
 * moment (flicker, camera sway, the same person stepping back into view). Only a kind of object not
 * seen at all for `windowMs` counts; every sighting keeps its kind fresh.
 */
export class NewObjectFilter {
  private seen = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs = 60_000) {
    this.windowMs = windowMs;
  }

  /** `labels`: the kinds in view now. True when the tracker's new object is genuinely new. */
  update(labels: string[], trackerNew: boolean, now: number): boolean {
    let fresh = false;
    for (const label of new Set(labels)) {
      const last = this.seen.get(label);
      if (trackerNew && (last == null || now - last > this.windowMs)) fresh = true;
      this.seen.set(label, now);
    }
    // Forget kinds not seen for long, so the map can't grow over a long session.
    for (const [label, at] of this.seen) if (now - at > this.windowMs * 2) this.seen.delete(label);
    return fresh;
  }

  clear() {
    this.seen.clear();
  }
}

/**
 * The cue sent to the model. In English (instructions), whatever the conversation language: the
 * system prompt says the answer is in the user's language. `alreadyWarned`: what the phone's own
 * detector said a moment ago, so the model doesn't repeat it.
 */
export function cueText(reason: CueReason, alreadyWarned?: string, lastSaid?: string): string {
  // Short on purpose: every cue stays in the conversation and is re-read on every later turn. How to
  // answer it (one sentence, hazards first, no repeats, never "safe", SILENT) is in the system prompt.
  return [
    `[camera-update] ${reason === "new-object" ? "New object in view." : "View changed."}`,
    alreadyWarned ? `Phone said: «${alreadyWarned.slice(0, 80)}».` : "",
    lastSaid ? `You last said: «${lastSaid.slice(0, 100)}».` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const SILENT_FORMS = ["silent", "سايلنت", "سايلانت", "سيلنت", "سايلينت"];

/**
 * What a cued answer's words so far mean: "silent" (only the fixed word), "speak" (real words), or
 * "wait" (nothing yet, or a beginning of the fixed word).
 */
export function classifyCueAnswer(text: string, final: boolean): "silent" | "speak" | "wait" {
  const t = norm(text);
  if (!t) return final ? "silent" : "wait";
  if (SILENT_FORMS.includes(t)) return "silent";
  if (!final && SILENT_FORMS.some((f) => f.startsWith(t))) return "wait";
  return "speak";
}
