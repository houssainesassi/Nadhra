// One voice at a time, most important sentence first. Sits on top of any TtsEngine.
//   urgent    interrupts everything; whatever it cut off (except narration) resumes afterwards
//   warning   a caution-level hazard: interrupts answers (a long reading) and below, which then
//             resume; it never interrupts an urgent warning, and goes stale fast
//   answer    interrupts narration only
//   status    waits its turn, and isn't lost: it can be the safety notice or "the analysis is back"
//   narration waits, is replaced by a newer description, and is dropped once stale
import { normalizeArabic, splitSentences } from "./schema.ts";
import type { TtsEngine } from "../speech/tts.ts";
import type { SpeechLang } from "./lang.ts";

export type SpeechPriority = "urgent" | "warning" | "answer" | "status" | "narration";
const RANK: Record<SpeechPriority, number> = { narration: 0, status: 1, answer: 2, warning: 3, urgent: 4 };

interface Item {
  text: string;
  priority: SpeechPriority;
  at: number;
  /** Spoken in this language's voice (an answer in the question's language). Default: lang(). */
  lang?: SpeechLang;
}

export interface SpeechQueueOptions {
  rate: () => number;
  /** 0..1, default 1. */
  volume?: () => number;
  onSpeakingChange?: (speaking: boolean) => void;
  /** The voice's language for items that don't name one. */
  lang?: () => SpeechLang;
  /** A sentence starts playing. */
  onUtterance?: (text: string, priority: SpeechPriority) => void;
  /** The engine could not speak. The text must then reach the user another way. */
  onFailure?: (text: string, message: string) => void;
  now?: () => number;
  ttlMs?: Partial<Record<SpeechPriority, number>>;
  /** Moves on if an engine never reports the end of a sentence (seen in some browsers). */
  watchdogBaseMs?: number;
}

/** The cloud voice accepts 500 characters, so long readings are cut at sentence boundaries. */
export function speechChunks(text: string, maxChars = 400): string[] {
  const chunks: string[] = [];
  let current = "";
  for (let sentence of splitSentences(text)) {
    while (sentence.length > maxChars) {
      const cut = sentence.lastIndexOf(" ", maxChars);
      const at = cut > 0 ? cut : maxChars;
      if (current) chunks.push(current), (current = "");
      chunks.push(sentence.slice(0, at).trim());
      sentence = sentence.slice(at).trim();
    }
    if (current && current.length + sentence.length + 1 > maxChars) chunks.push(current), (current = "");
    current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class SpeechQueue {
  private engine: TtsEngine;
  private opts: SpeechQueueOptions;
  private now: () => number;
  private ttl: Record<SpeechPriority, number>;
  private pending: Item[] = [];
  private current: Item | null = null;
  private token = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private hold = false;
  private wasSpeaking = false;
  /** The language last given to the engine; undefined when unknown (someone else changed it). */
  private engineLang: SpeechLang | undefined;

  constructor(engine: TtsEngine, opts: SpeechQueueOptions) {
    this.engine = engine;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.ttl = { narration: 15_000, status: 20_000, answer: 120_000, warning: 8_000, urgent: 6_000, ...opts.ttlMs };
  }

  get busy() {
    return !!this.current;
  }

  /** True while something at least this important is playing or waiting. */
  hasAtLeast(priority: SpeechPriority) {
    const rank = RANK[priority];
    return (!!this.current && RANK[this.current.priority] >= rank) || this.pending.some((i) => RANK[i.priority] >= rank);
  }

  /** The engine's language was changed elsewhere: the next sentence sets it again. */
  resetLanguage() {
    this.engineLang = undefined;
  }

  say(text: string, priority: SpeechPriority, lang?: SpeechLang) {
    const chunks = speechChunks(text);
    if (!chunks.length) return;
    const at = this.now();
    if (priority === "narration") this.pending = this.pending.filter((i) => i.priority !== "narration");
    const same = normalizeArabic(text);
    if (normalizeArabic(this.current?.text ?? "") === same || this.pending.some((i) => normalizeArabic(i.text) === same)) return;

    const items = chunks.map((chunk) => ({ text: chunk, priority, at, lang }));
    const rank = RANK[priority];
    let index = this.pending.findIndex((i) => RANK[i.priority] < rank);
    if (index < 0) index = this.pending.length;
    this.pending.splice(index, 0, ...items);

    const current = this.current;
    // Safety first: a warning never waits behind a reading. Below that, only narration gets cut.
    const interrupts = !!current && (rank >= RANK.warning ? RANK[current.priority] < rank : priority === "answer" && current.priority === "narration");
    if (current && interrupts) {
      this.cancelCurrent();
      // Resumes after the warning, in order: before the rest of its own reading, not after it.
      // Interrupted narration is simply dropped.
      if (current.priority !== "narration") {
        const after = this.pending.findIndex((i) => RANK[i.priority] <= RANK[current.priority]);
        this.pending.splice(after < 0 ? this.pending.length : after, 0, current);
      }
    }
    this.pump();
  }

  /** The user is talking: keep everything except urgent warnings waiting. */
  setHold(hold: boolean) {
    this.hold = hold;
    if (!hold) this.pump();
  }

  /** Silences the assistant now and forgets everything waiting. */
  stop() {
    this.pending = [];
    this.cancelCurrent();
    this.notify();
  }

  private cancelCurrent() {
    this.token++;
    this.clearWatchdog();
    if (this.current) {
      this.current = null;
      try {
        this.engine.stop();
      } catch {}
    }
  }

  private clearWatchdog() {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private notify() {
    const speaking = !!this.current;
    if (speaking !== this.wasSpeaking) {
      this.wasSpeaking = speaking;
      this.opts.onSpeakingChange?.(speaking);
    }
  }

  private next(): Item | null {
    const now = this.now();
    this.pending = this.pending.filter((i) => now - i.at <= this.ttl[i.priority]);
    const index = this.hold ? this.pending.findIndex((i) => i.priority === "urgent") : this.pending.length ? 0 : -1;
    return index < 0 ? null : this.pending.splice(index, 1)[0];
  }

  private pump() {
    if (this.current) return;
    const item = this.next();
    if (!item) return this.notify();
    this.current = item;
    this.notify();
    const token = ++this.token;
    const finish = () => {
      if (token !== this.token) return;
      this.clearWatchdog();
      this.current = null;
      this.pump();
    };
    const rate = this.opts.rate();
    // Long enough for the cloud voice to download and play the whole sentence.
    this.watchdog = setTimeout(finish, (this.opts.watchdogBaseMs ?? 18_000) + (item.text.length * 170) / rate);
    this.opts.onUtterance?.(item.text, item.priority);
    const lang = item.lang ?? this.opts.lang?.();
    if (lang && lang !== this.engineLang) {
      this.engineLang = lang;
      this.engine.setLanguage?.(lang);
    }
    try {
      this.engine.speak(item.text, {
        rate,
        volume: this.opts.volume?.() ?? 1,
        interrupt: true,
        onEnd: finish,
        onError: (message) => {
          if (token === this.token) this.opts.onFailure?.(item.text, message);
          finish();
        },
      });
    } catch (e) {
      this.opts.onFailure?.(item.text, (e as Error).message);
      finish();
    }
  }
}

/** Word overlap between two sentences, 0..1: catches a rewording of what was just said. */
export function similarity(a: string, b: string): number {
  const words = (t: string) => new Set(normalizeArabic(t).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 1));
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export const isRepeat = (text: string, recent: string[], threshold = 0.6) => recent.some((r) => similarity(text, r) >= threshold);
