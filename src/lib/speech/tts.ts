// Text-to-speech engine interface + implementations:
//   BrowserTts – browser SpeechSynthesis (offline, free; needs an installed Arabic voice)
//   CloudTts   – free Microsoft Edge neural voice (MP3) through our server route /api/tts (no key)
//   HybridTts  – the female cloud voice first; the browser's installed voice only when the cloud
//                voice can't be used (offline, service down), preferring a female one
// Keep the interface small so another engine (e.g. a local neural TTS) can be plugged in.
import { apiFetch } from "../assistant/api.ts";
import { CLOUD_VOICES, LANGS, type SpeechLang } from "../assistant/lang.ts";

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
  source: "browser" | "cloud";
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
}

/**
 * Text as it should be read aloud: labels like «خال / عم» are read «خال أو عم» (not "slash"),
 * Latin punctuation and symbols a voice would spell out are removed, whitespace collapsed.
 */
export function speechText(text: string, lang: SpeechLang = "tn"): string {
  return text
    .replace(/\s*\/\s*/g, ` ${LANGS[lang].or} `)
    .replace(/[()[\]{}<>«»"“”_*#|~^]/g, " ")
    .replace(/\s+([،؟.!,?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// Browser failures after which the cloud voice is worth trying (not user cancellations).
const BROWSER_FAILURES = new Set(["synthesis-failed", "synthesis-unavailable", "language-unavailable", "voice-unavailable", "audio-hardware", "audio-busy", "network"]);

export class BrowserTts implements TtsEngine {
  readonly name = "browser-speechsynthesis";
  private voice: SpeechSynthesisVoice | null = null;
  private cleanup: (() => void)[] = [];
  private lang: SpeechLang = "tn";
  private repick: () => void = () => {};

  constructor(onVoicesChanged?: () => void) {
    if (!this.available()) return;
    const pick = () => (this.voice = pickVoice(speechSynthesis.getVoices(), this.lang, { offline: typeof navigator !== "undefined" && navigator.onLine === false }));
    pick();
    const repick = () => {
      pick();
      onVoicesChanged?.();
    };
    this.repick = repick;
    // Voices often load asynchronously (Chrome/Android): notify when they arrive.
    if (typeof speechSynthesis.addEventListener === "function") {
      speechSynthesis.addEventListener("voiceschanged", repick);
      this.cleanup.push(() => speechSynthesis.removeEventListener?.("voiceschanged", repick));
    }
    // Offline, a network voice (e.g. "Google العربية" on desktop Chrome) fails: prefer an installed one.
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      addEventListener("offline", repick);
      addEventListener("online", repick);
      this.cleanup.push(() => {
        removeEventListener("offline", repick);
        removeEventListener("online", repick);
      });
    }
  }

  dispose() {
    this.stop();
    for (const fn of this.cleanup.splice(0)) fn();
  }

  setLanguage(lang: SpeechLang) {
    if (lang === this.lang) return;
    this.lang = lang;
    this.repick();
  }

  available() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  voiceInfo(): VoiceInfo | null {
    if (!this.voice) return null;
    return { name: this.voice.name, lang: this.voice.lang, exactDialect: exactDialect(this.voice.lang, this.lang), source: "browser" };
  }

  /** onFailure: return true when the caller handles a real synthesis failure (e.g. cloud fallback). */
  speak(text: string, opts: SpeakOptions, onFailure?: (code: string) => boolean) {
    const { rate, onStart, onEnd, onError } = opts;
    if (!this.available()) return onError?.("Speech synthesis is not supported in this browser.");
    if (opts.interrupt !== false || !speechSynthesis.speaking) speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(speechText(text, this.lang));
    u.lang = this.voice?.lang ?? LANGS[this.lang].recognition;
    if (this.voice) u.voice = this.voice;
    u.rate = rate;
    u.volume = clampVolume(opts.volume);
    u.onstart = () => onStart?.();
    u.onend = () => onEnd?.();
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return onEnd?.();
      if (BROWSER_FAILURES.has(e.error) && onFailure?.(e.error)) return;
      onError?.(e.error === "not-allowed" ? "Tap anywhere on the page once to allow automatic speech." : `Speech error: ${e.error}`);
    };
    speechSynthesis.speak(u);
  }

  stop() {
    if (this.available()) speechSynthesis.cancel();
  }
}

const FEMALE_VOICE = /female|femme|\b(?:reem|hoda|salma|zariyah|laila|layla|amina|amany|mariam|maryam|fatima|sana|iman|mouna|rana|noura|sara|amira|hala|denise|julie|hortense|amelie|am[ée]lie|aurelie|aur[ée]lie|marie|virginie|jenny|aria|samantha|zira|susan|karen|moira|tessa|victoria|serena|allison|ava|joanna|kendra|kimberly|salli|ivy|emma|libby|sonia|natasha|google (?:us|uk english female))\b/i;
const MALE_VOICE = /\bmale\b|homme|\b(?:hedi|hamed|naayf|tarik|tarek|shakir|majed|maged|omar|ali|hamdan|rami|moaz|taim|bassel|jamal|laith|fahed|saleh|henri|paul|claude|thomas|nicolas|daniel|guy|david|mark|james|george|alex|fred|ryan|christopher|eric|matthew|brian|joey|justin|google uk english male)\b/i;

const norm = (l: string) => l.toLowerCase().replace("_", "-");
const clampVolume = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);

/** Tunisian needs an ar-TN voice to be exact. The other languages only need the same language. */
function exactDialect(voiceLang: string, lang: SpeechLang): boolean {
  const l = norm(voiceLang);
  return lang === "tn" ? l === "ar-tn" : l.split("-")[0] === LANGS[lang].bcp47.split("-")[0];
}

/** The best installed voice for a speech language, or null when there is none in that language. */
export function pickVoice(voices: SpeechSynthesisVoice[], lang: SpeechLang, { offline = false } = {}): SpeechSynthesisVoice | null {
  const prefs = LANGS[lang].voices;
  const base = prefs[prefs.length - 1];
  let same = voices.filter((v) => norm(v.lang).split("-")[0] === base);
  // offline: only voices installed on the device can speak
  if (offline && same.some((v) => v.localService)) same = same.filter((v) => v.localService);
  // The assistant's voice is female: among voices of the same language, a female one wins, and a
  // known male one comes last. Browsers don't report gender, so this goes by the voice's name.
  const rank = (v: SpeechSynthesisVoice) => (FEMALE_VOICE.test(v.name) ? 0 : MALE_VOICE.test(v.name) ? 2 : 1);
  for (const pref of prefs) {
    const match = same.filter((v) => norm(v.lang) === pref.toLowerCase());
    if (!match.length) continue;
    const best = Math.min(...match.map(rank));
    const top = match.filter((v) => rank(v) === best);
    // A known male voice of the exact dialect loses to a female voice of a close one.
    if (best === 2 && same.some((v) => rank(v) < 2)) continue;
    return top.find((v) => v.default) ?? top.find((v) => v.localService) ?? top[0];
  }
  return [...same].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

export const pickArabicVoice = (voices: SpeechSynthesisVoice[], opts: { offline?: boolean } = {}) => pickVoice(voices, "tn", opts);

// ---------------------------------------------------------------------------
// Cloud voice

type CloudState = "checking" | "ready" | "unavailable" | "unknown";

const CLOUD_ERRORS: Record<string, string> = {
  "not-configured": "الصوت السحابي غير مُفعّل على الخادم.",
  "rate-limited": "تم بلوغ حدّ استعمال الصوت السحابي مؤقتًا. أعد المحاولة بعد دقيقة.",
  "upstream-unavailable": "خدمة الصوت السحابي غير متاحة مؤقتًا. أعد المحاولة بعد دقيقة.",
  "too many requests": "طلبات كثيرة في وقت قصير. أعد المحاولة بعد قليل.",
  autoplay: "المتصفح منع التشغيل التلقائي. اضغط على أي زر في الصفحة لتشغيل الصوت.",
  offline: "لا يوجد اتصال بالإنترنت لتحميل الصوت السحابي.",
};
const CLOUD_GENERIC_ERROR = "تعذّر تشغيل الصوت السحابي. تحقّق من الاتصال ثم أعد المحاولة.";

class CloudError extends Error {
  code: string;
  constructor(code: string) {
    super(CLOUD_ERRORS[code] ?? CLOUD_GENERIC_ERROR);
    this.code = code;
  }
}

const CACHE_MAX = 30;

export class CloudTts implements TtsEngine {
  readonly name = "edge-cloud-tts";
  private state: CloudState = "checking";
  private voiceName = "";
  private lang = "ar";
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
        this.voiceName = String(d.voice ?? "");
        this.lang = String(d.languageCode ?? "ar");
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
    return this.state !== "unavailable" && Date.now() >= this.openUntil;
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
    if (++this.failures >= CloudTts.MAX_FAILURES) {
      this.failures = 0;
      this.openUntil = Date.now() + CloudTts.COOLDOWN_MS;
      this.onChange?.();
    }
  }

  available() {
    return this.state === "ready" && typeof window !== "undefined" && !!audioContextClass();
  }

  voiceInfo(): VoiceInfo | null {
    if (this.state !== "ready") return null;
    if (this.speechLang !== "tn") {
      const voice = CLOUD_VOICES[this.speechLang];
      return { name: `Microsoft Edge ${voice}`, lang: voice.split("-").slice(0, 2).join("-"), exactDialect: true, source: "cloud" };
    }
    return { name: `Microsoft Edge ${this.voiceName}`, lang: this.lang, exactDialect: this.lang.toLowerCase() === "ar-tn", source: "cloud" };
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
    if (this.state === "unavailable") return;
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

// ---------------------------------------------------------------------------
// Browser voice first, cloud voice as fallback.

export class HybridTts implements TtsEngine {
  readonly name = "hybrid";
  private browser: BrowserTts;
  private cloud: CloudTts;
  private gen = 0;

  constructor(onChange?: () => void, endpoint?: string) {
    this.browser = new BrowserTts(onChange);
    this.cloud = new CloudTts(onChange, endpoint);
  }

  available() {
    return this.cloud.available() || !!this.browser.voiceInfo();
  }

  voiceInfo() {
    return (this.cloud.usable() ? this.cloud.voiceInfo() : null) ?? this.browser.voiceInfo();
  }

  checking() {
    return this.cloud.checking();
  }

  unlock() {
    this.cloud.unlock();
  }

  setLanguage(lang: SpeechLang) {
    this.stop();
    this.browser.setLanguage(lang);
    this.cloud.setLanguage(lang);
  }

  speak(text: string, opts: SpeakOptions) {
    if (this.cloud.checking()) {
      // Startup race: wait for the availability check, then decide.
      const gen = this.gen;
      opts.onPreparing?.();
      void this.cloud.ready().then(() => {
        if (gen === this.gen) this.speak(text, opts);
      });
      return;
    }
    if (this.cloud.usable()) {
      // The female cloud voice. If it fails (network, service), the installed voice says it instead.
      this.browser.stop();
      this.cloud.speak(text, {
        ...opts,
        onError: (e) => {
          if (this.browser.voiceInfo()) this.browser.speak(text, opts);
          else opts.onError?.(e);
        },
      });
      return;
    }
    // No cloud voice: the installed voice for the language (female when there is one), or the default.
    this.browser.speak(text, opts);
  }

  stop() {
    this.gen++;
    this.browser.stop();
    this.cloud.stop();
  }

  dispose() {
    this.gen++;
    this.browser.dispose();
    this.cloud.dispose();
  }
}
