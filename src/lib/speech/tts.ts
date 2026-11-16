// Text-to-speech engine interface + the one implementation:
//   SulafatTts – Google Gemini TTS, voice Sulafat (MP3/WAV through our server route /api/tts).
// Sulafat is the only voice the app speaks with. There is no fallback voice: when Sulafat can't be
// used (offline, service down, Nadhra AI), speaking fails, the page shows it and the screen reader
// reads the sentence instead.
import { apiFetch } from "../assistant/api.ts";
import { LANGS, type SpeechLang } from "../assistant/lang.ts";

export interface SpeakOptions {
  rate: number;
  /** 0..1, default 1. */
  volume?: number;
  /** false = queue after the current sentence instead of cutting it off (default true). */
  interrupt?: boolean;
  onPreparing?: () => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (e: string) => void;
}

export interface VoiceInfo {
  name: string;
  lang: string;
  exactDialect: boolean;
  source: "cloud";
}

export interface TtsEngine {
  readonly name: string;
  available(): boolean;
  /** Best voice description for UI, or null if no voice for the language is usable. */
  voiceInfo(): VoiceInfo | null;
  /** True while the engine is still finding out which voice it can use. */
  checking?(): boolean;
  /** Call from a user gesture to allow later automatic playback (autoplay policies). */
  unlock?(): void;
  speak(text: string, opts: SpeakOptions): void;
  stop(): void;
  /** The language to speak from now on. Tunisian until called. */
  setLanguage?(lang: SpeechLang): void;
  /** Stop and release everything (event listeners, audio context). The engine is unusable afterwards. */
  dispose?(): void;
  /**
   * Nadhra AI: nothing may leave the device, so Sulafat (a cloud voice) is not used and speaking
   * fails: the screen reader takes over. No other voice is used instead.
   */
  setLocalOnly?(on: boolean): void;
}

/**
 * Text as it should be read aloud: labels like «خال / عم» are read «خال أو عم» (not "slash"),
 * Latin punctuation and symbols a voice would spell out are removed, whitespace collapsed.
 */
// A "/" between numbers or units is part of a date, a fraction or a unit (03/2027, 1/2, mg/ml):
// read as "or", "1/2 comprimé" would become "1 or 2 tablets". Only a slash between words is "or".
const UNIT = /^(?:mg|g|kg|µg|mcg|ml|l|dl|cl|mmol|ui|h|km|m|cm|j|jour|day|dose|cp|سم|كغ|مغ|مل)$/i;
const DIGIT = /[0-9٠-٩۰-۹]/;
function readSlash(text: string, or: string): string {
  return text.replace(/\s*\/\s*/g, (m, at: number) => {
    const before = text.slice(0, at);
    const after = text.slice(at + m.length);
    const left = /(\S+)$/.exec(before)?.[1] ?? "";
    const right = /^(\S+)/.exec(after)?.[1] ?? "";
    if (DIGIT.test(left.slice(-1)) || DIGIT.test(right[0] ?? "")) return "/";
    if (UNIT.test(left.replace(/^[0-9.,]+/, "")) || UNIT.test(right.replace(/[.,;:]+$/, ""))) return "/";
    return ` ${or} `;
  });
}

export function speechText(text: string, lang: SpeechLang = "tn"): string {
  return readSlash(text, LANGS[lang].or)
    .replace(/[()[\]{}<>«»"“”_*#|~^]/g, " ")
    .replace(/\s+([،؟.!,?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const clampVolume = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

// ---------------------------------------------------------------------------
// Sulafat (Google Gemini TTS)

type CloudState = "checking" | "ready" | "unavailable" | "unknown";

const CLOUD_ERRORS: Record<string, string> = {
  "not-configured": "صوت Sulafat غير مُفعّل على الخادم.",
  "rate-limited": "تم بلوغ حدّ استعمال صوت Sulafat مؤقتًا. أعد المحاولة بعد دقيقة.",
  "upstream-unavailable": "صوت Sulafat غير متاح مؤقتًا. أعد المحاولة بعد دقيقة.",
  "too many requests": "طلبات كثيرة في وقت قصير. أعد المحاولة بعد قليل.",
  autoplay: "المتصفح منع التشغيل التلقائي. اضغط على أي زر في الصفحة لتشغيل الصوت.",
  offline: "لا يوجد اتصال بالإنترنت لتحميل صوت Sulafat.",
  "local-only": "ذكاء نظرة لا يرسل شيئًا إلى الإنترنت، فصوت Sulafat غير مستعمل. قارئ الشاشة يقرأ الكلام.",
};
const CLOUD_GENERIC_ERROR = "تعذّر تشغيل صوت Sulafat. تحقّق من الاتصال ثم أعد المحاولة.";

class CloudError extends Error {
  code: string;
  constructor(code: string) {
    super(CLOUD_ERRORS[code] ?? CLOUD_GENERIC_ERROR);
    this.code = code;
  }
}

const CACHE_MAX = 30;

/** The assistant's only voice. */
export const VOICE_NAME = "Sulafat";

export class SulafatTts implements TtsEngine {
  readonly name = "gemini-tts-sulafat";
  private state: CloudState = "checking";
  private localOnly = false;
  private speechLang: SpeechLang = "tn";
  private readyPromise: Promise<void>;
  private ctx: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  // In-memory only (this tab): avoids re-requesting the same sentence (replay, retry, duplicates).
  private cache = new Map<string, Promise<ArrayBuffer>>();
  private chain: Promise<void> = Promise.resolve();
  private gen = 0;
  private onChange?: () => void;
  private endpoint: string;
  // client-side circuit breaker: after repeated failures, stop asking the cloud voice for a while
  private failures = 0;
  private openUntil = 0;
  static readonly MAX_FAILURES = 3;
  static readonly COOLDOWN_MS = 60_000;

  constructor(onChange?: () => void, endpoint = "/api/tts") {
    this.onChange = onChange;
    this.endpoint = endpoint;
    this.readyPromise = this.probe();
  }

  private async probe() {
    try {
      const res = await fetch(this.endpoint, { cache: "no-store" });
      const d = res.ok ? await res.json() : null;
      if (d && typeof d.configured === "boolean") {
        this.state = d.configured ? "ready" : "unavailable";
      } else this.state = "unknown";
    } catch {
      this.state = "unknown"; // offline or server down: try again when asked to speak
    }
    this.onChange?.();
  }

  ready() {
    return this.readyPromise;
  }

  checking() {
    return this.state === "checking";
  }

  /** Worth trying: configured (or not known yet, e.g. probe failed offline) and not cooling down after failures. */
  usable() {
    return !this.localOnly && this.state !== "unavailable" && Date.now() >= this.openUntil;
  }

  /** ms until the cloud voice is tried again after repeated failures (0 = not cooling down). */
  coolingDownMs() {
    return Math.max(0, this.openUntil - Date.now());
  }

  private noteResult(ok: boolean, code?: string) {
    if (ok) {
      this.failures = 0;
      return;
    }
    // user-side problems (autoplay, offline) say nothing about the service
    if (code === "autoplay" || code === "offline") return;
    if (++this.failures >= SulafatTts.MAX_FAILURES) {
      this.failures = 0;
      this.openUntil = Date.now() + SulafatTts.COOLDOWN_MS;
      this.onChange?.();
    }
  }

  available() {
    return !this.localOnly && this.state === "ready" && typeof window !== "undefined" && !!audioContextClass();
  }

  voiceInfo(): VoiceInfo | null {
    if (this.localOnly || this.state !== "ready") return null;
    // One voice for every language: Gemini speaks the language of the sentence.
    return { name: `Google Gemini ${VOICE_NAME}`, lang: LANGS[this.speechLang].bcp47, exactDialect: true, source: "cloud" };
  }

  setLocalOnly(on: boolean) {
    if (on === this.localOnly) return;
    this.stop();
    this.localOnly = on;
    this.onChange?.();
  }

  setLanguage(lang: SpeechLang) {
    if (lang === this.speechLang) return;
    this.speechLang = lang;
    this.onChange?.();
  }

  private context(): AudioContext {
    if (!this.ctx) {
      const Ctx = audioContextClass();
      if (!Ctx) throw new CloudError("unsupported");
      this.ctx = new Ctx();
    }
    return this.ctx;
  }

  unlock() {
    if (this.localOnly || this.state === "unavailable") return;
    try {
      const ctx = this.context();
      void ctx.resume().catch(() => {});
      // A silent one-sample buffer started inside the gesture unlocks iOS Safari.
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, 22050);
      src.connect(ctx.destination);
      src.start(0);
    } catch {}
  }

  private fetchAudio(text: string, rate: number): Promise<ArrayBuffer> {
    const lang = this.speechLang;
    const key = `${lang}|${rate.toFixed(1)}|${text}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // LRU: move to the end
      this.cache.set(key, hit);
      return hit;
    }
    const p = (async () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw new CloudError("offline");
      let res: Response;
      try {
        res = await apiFetch(this.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(lang === "tn" ? { text: speechText(text), rate } : { text: speechText(text, lang), rate, lang }),
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new CloudError("network");
      }
      if (!res.ok) {
        const code = await res.json().then((d) => String(d?.error ?? ""), () => "");
        if (code === "not-configured") {
          this.state = "unavailable";
          this.onChange?.();
        }
        throw new CloudError(code || `http-${res.status}`);
      }
      if (this.state !== "ready") {
        this.state = "ready";
        this.onChange?.();
      }
      return res.arrayBuffer();
    })();
    this.cache.set(key, p);
    p.catch(() => this.cache.delete(key)); // never cache failures: a retry must hit the network
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  speak(text: string, opts: SpeakOptions) {
    if (opts.interrupt !== false) this.stop();
    // No other voice exists to say it instead: fail at once, and the page shows it (screen reader).
    if (this.localOnly) return opts.onError?.(CLOUD_ERRORS["local-only"]);
    if (this.state === "unavailable") return opts.onError?.(CLOUD_ERRORS["not-configured"]);
    if (Date.now() < this.openUntil) return opts.onError?.(CLOUD_ERRORS["upstream-unavailable"]);
    try {
      // Synchronous part of a click: counts as a user gesture for resume() (iOS).
      const ctx = this.context();
      if (ctx.state !== "running") void ctx.resume().catch(() => {});
    } catch {}
    const gen = this.gen;
    const run = async () => {
      if (gen !== this.gen) return; // stopped while queued
      opts.onPreparing?.();
      try {
        const data = await this.fetchAudio(text, opts.rate);
        if (gen !== this.gen) return;
        const ctx = this.context();
        if (ctx.state !== "running") {
          // resume() stays pending without a user gesture: don't wait forever.
          await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 400))]);
        }
        if (ctx.state !== "running") throw new CloudError("autoplay");
        const buffer = await ctx.decodeAudioData(data.slice(0)); // slice: decoding detaches the buffer
        this.noteResult(true);
        if (gen !== this.gen) return;
        await new Promise<void>((resolve) => {
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          const volume = clampVolume(opts.volume);
          if (volume < 1) {
            const gain = ctx.createGain();
            gain.gain.value = volume;
            src.connect(gain).connect(ctx.destination);
          } else {
            src.connect(ctx.destination);
          }
          src.onended = () => {
            if (this.source === src) this.source = null;
            opts.onEnd?.();
            resolve();
          };
          this.source = src;
          src.start();
          opts.onStart?.();
        });
      } catch (e) {
        this.noteResult(false, e instanceof CloudError ? e.code : undefined);
        if (gen !== this.gen) return;
        opts.onError?.(e instanceof CloudError ? e.message : CLOUD_GENERIC_ERROR);
      }
    };
    this.chain = this.chain.then(run, run);
  }

  stop() {
    this.gen++;
    const src = this.source;
    this.source = null;
    if (src) {
      try {
        src.stop(); // fires onended -> onEnd + releases the queue
      } catch {}
    }
  }

  /** Browsers limit the number of live AudioContexts per page: close ours when the page unmounts. */
  dispose() {
    this.stop();
    this.onChange = undefined;
    this.cache.clear();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }
}

function audioContextClass(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}
