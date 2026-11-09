// Hearing the user. Two implementations behind one interface:
//   RecognitionInput  the browser's SpeechRecognition, in the chosen speech language (Chrome, Edge, Safari)
//   RecorderInput     records with the microphone and lets the server transcribe (Firefox, Brave,
//                     Chromium builds whose speech service doesn't answer)
import { bytesToBase64, downsample, encodeWav } from "./wav.ts";

export type VoiceResult = { kind: "text"; text: string } | { kind: "audio"; wavBase64: string } | { kind: "none" };
/** denied: no permission. missing: no microphone. service: this input can't work here, try the other. */
export type VoiceErrorCode = "denied" | "missing" | "service" | "unknown";

export class VoiceError extends Error {
  code: VoiceErrorCode;
  constructor(code: VoiceErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

export interface ListenHooks {
  /** The user started talking. */
  onSpeechStart?: () => void;
  onSpeechEnd?: () => void;
}

export interface VoiceInput {
  readonly kind: "recognition" | "recording";
  /** Resolves with what was heard, or {kind:"none"} after silence or abort(). */
  listen(hooks?: ListenHooks): Promise<VoiceResult>;
  /** Stops at once and discards what was heard. */
  abort(): void;
  /** Stops listening and keeps what was heard so far. */
  finish(): void;
}

interface RecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionClass(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const recognitionSupported = () => !!recognitionClass();
export const recordingSupported = () => typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

/**
 * Real silence takes seconds to time out. A session that keeps ending at once, with nothing heard
 * and no error, means the speech service isn't really there (seen in some Chromium builds).
 */
const INSTANT_END_MS = 1_000;
const INSTANT_ENDS_BEFORE_FAILURE = 2;

export class RecognitionInput implements VoiceInput {
  readonly kind = "recognition";
  private active: RecognitionLike | null = null;
  private aborted = false;
  private instantEnds = 0;
  private lang: () => string;

  /** lang: read at each listen(), so a language change applies to the next sentence. */
  constructor(lang: () => string = () => "ar-TN") {
    this.lang = lang;
  }

  listen(hooks: ListenHooks = {}): Promise<VoiceResult> {
    const Ctor = recognitionClass();
    if (!Ctor) return Promise.reject(new VoiceError("service"));
    return new Promise((resolve, reject) => {
      const rec = new Ctor();
      this.active = rec;
      rec.lang = this.lang();
      rec.continuous = false;
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      let text = "";
      let failure: VoiceError | null = null;
      this.aborted = false;
      const startedAt = Date.now();
      rec.onspeechstart = () => hooks.onSpeechStart?.();
      rec.onspeechend = () => hooks.onSpeechEnd?.();
      rec.onresult = (e) => {
        text = e.results[0]?.[0]?.transcript?.trim() ?? "";
      };
      rec.onerror = (e) => {
        if (e.error === "not-allowed") failure = new VoiceError("denied");
        else if (e.error === "audio-capture") failure = new VoiceError("missing");
        else if (e.error === "network" || e.error === "service-not-allowed" || e.error === "language-not-supported") failure = new VoiceError("service", e.error);
        // no-speech and aborted are normal: they end with nothing heard
      };
      rec.onend = () => {
        if (this.active === rec) this.active = null;
        hooks.onSpeechEnd?.();
        const instant = !text && !failure && !this.aborted && Date.now() - startedAt < INSTANT_END_MS;
        this.instantEnds = instant ? this.instantEnds + 1 : 0;
        if (this.instantEnds >= INSTANT_ENDS_BEFORE_FAILURE) failure = new VoiceError("service", "instant-end");
        if (failure) reject(failure);
        else resolve(text ? { kind: "text", text } : { kind: "none" });
      };
      try {
        rec.start();
      } catch (e) {
        this.active = null;
        reject(new VoiceError("unknown", (e as Error).message));
      }
    });
  }

  abort() {
    this.aborted = true;
    this.active?.abort();
  }

  finish() {
    this.aborted = true; // the user ended it: not a sign of a dead service
    this.active?.stop();
  }
}

export const RECORDER = { startSpeechTimeoutMs: 8_000, silenceMs: 1_200, maxMs: 12_000, minSpeechMs: 350, sampleRate: 16_000 };

export class RecorderInput implements VoiceInput {
  readonly kind = "recording";
  private cancel: ((keep: boolean) => void) | null = null;

  async listen(hooks: ListenHooks = {}): Promise<VoiceResult> {
    if (!recordingSupported()) throw new VoiceError("service");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") throw new VoiceError("denied");
      if (name === "NotFoundError" || name === "NotReadableError") throw new VoiceError("missing");
      throw new VoiceError("unknown", String(e));
    }

    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    const release = () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {});
      this.cancel = null;
    };

    try {
      // resume() can stay pending without a user gesture: never wait for it forever.
      await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise<void>((r) => recorder.addEventListener("stop", () => r(), { once: true }));
      recorder.start();

      const keep = await this.waitForSpeech(analyser, hooks);
      if (recorder.state !== "inactive") recorder.stop();
      await stopped;
      hooks.onSpeechEnd?.();
      if (!keep) return { kind: "none" };

      const decoded = await ctx.decodeAudioData(await new Blob(chunks).arrayBuffer());
      const pcm = downsample(decoded.getChannelData(0), decoded.sampleRate, RECORDER.sampleRate);
      return { kind: "audio", wavBase64: bytesToBase64(encodeWav(pcm, Math.min(decoded.sampleRate, RECORDER.sampleRate))) };
    } finally {
      release();
    }
  }

  /** Resolves true once someone spoke and then stopped. False for silence, noise bursts or abort. */
  private waitForSpeech(analyser: AnalyserNode, hooks: ListenHooks): Promise<boolean> {
    return new Promise((resolve) => {
      const data = new Float32Array(analyser.fftSize);
      const started = Date.now();
      let floor = 0.005;
      let speechAt = 0;
      let lastLoud = 0;
      const done = (keep: boolean) => {
        clearInterval(timer);
        this.cancel = null;
        resolve(keep);
      };
      this.cancel = (keep) => done(keep && speechAt > 0);
      const timer = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += v * v;
        const rms = Math.sqrt(sum / data.length);
        const now = Date.now();
        const loud = rms > Math.max(0.012, floor * 3);
        if (!speechAt && !loud) floor = floor * 0.95 + rms * 0.05; // follows the room's noise level
        if (loud) {
          if (!speechAt) {
            speechAt = now;
            hooks.onSpeechStart?.();
          }
          lastLoud = now;
        }
        if (!speechAt && now - started > RECORDER.startSpeechTimeoutMs) return done(false);
        if (speechAt && now - speechAt > RECORDER.maxMs) return done(true);
        if (speechAt && now - lastLoud > RECORDER.silenceMs) return done(lastLoud - speechAt >= RECORDER.minSpeechMs);
      }, 60);
    });
  }

  abort() {
    this.cancel?.(false);
  }

  finish() {
    this.cancel?.(true);
  }
}
