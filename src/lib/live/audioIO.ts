// Browser audio for the live conversation: microphone capture as 16 kHz PCM, gapless playback of the
// model's 24 kHz PCM, and a small level-based voice detector. One AudioContext for both, created in
// a user gesture (iOS Safari only plays audio from a context resumed in a gesture).
import { floatToPcm16, pcm16ToFloat, rms } from "./pcm.ts";
import { LIVE_INPUT_RATE, LIVE_OUTPUT_RATE } from "./config.ts";

export type MicErrorCode = "denied" | "not-found" | "busy" | "insecure" | "unsupported" | "unknown";

export class MicError extends Error {
  readonly code: MicErrorCode;
  constructor(code: MicErrorCode) {
    super(code);
    this.code = code;
  }
}

// Collects the 128-frame render quanta into ~40 ms blocks before posting, to keep messages few.
const WORKLET = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("nadhra-mic-tap", Tap);
`;

function audioContextClass(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export interface MicEvents {
  /** 16-bit PCM at 16 kHz, about every 40 ms. */
  chunk(pcm: Uint8Array): void;
  /** The user started talking (level above the noise floor for a moment). */
  speechStart?(): void;
  /** The user stopped talking. `at` is when the speech actually ended. */
  speechEnd?(at: number): void;
}

/** Local voice detection: start after ~120 ms above the threshold, end after ~450 ms below it. */
export class LevelVad {
  speaking = false;
  private above = 0;
  private below = 0;
  private lastVoiceAt = 0;
  private floor = 0.004;
  private readonly onStart: () => void;
  private readonly onEnd: (at: number) => void;
  constructor(onStart: () => void, onEnd: (at: number) => void) {
    this.onStart = onStart;
    this.onEnd = onEnd;
  }

  feed(level: number, ms: number, now: number) {
    // The noise floor follows quiet input slowly, so a noisy street doesn't count as speech.
    if (!this.speaking) this.floor = this.floor * 0.98 + Math.min(level, 0.05) * 0.02;
    const threshold = Math.max(0.012, this.floor * 3);
    if (level > threshold) {
      this.above += ms;
      this.below = 0;
      this.lastVoiceAt = now;
      if (!this.speaking && this.above >= 120) {
        this.speaking = true;
        this.onStart();
      }
    } else {
      this.below += ms;
      if (this.below >= 120) this.above = 0;
      if (this.speaking && this.below >= 450) {
        this.speaking = false;
        this.onEnd(this.lastVoiceAt);
      }
    }
  }
}

export class LiveAudio {
  readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private tap: AudioNode | null = null;
  private mute: GainNode | null = null;
  private out: GainNode;
  private playing = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private volume = 1;
  private ducked = false;
  private onPlaying: (playing: boolean) => void;

  constructor(onPlaying: (playing: boolean) => void = () => {}) {
    const Ctx = audioContextClass();
    if (!Ctx) throw new MicError("unsupported");
    this.ctx = new Ctx();
    void this.ctx.resume().catch(() => {});
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.onPlaying = onPlaying;
  }

  /** Opens the microphone. Echo cancellation keeps the assistant's own voice out of it. */
  async startMic(events: MicEvents): Promise<void> {
    if (typeof window !== "undefined" && !window.isSecureContext) throw new MicError("insecure");
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError("unsupported");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") throw new MicError("denied");
      if (name === "NotFoundError" || name === "OverconstrainedError") throw new MicError("not-found");
      if (name === "NotReadableError" || name === "AbortError") throw new MicError("busy");
      throw new MicError("unknown");
    }
    const rate = this.ctx.sampleRate;
    const vad = new LevelVad(() => events.speechStart?.(), (at) => events.speechEnd?.(at));
    const onBlock = (block: Float32Array) => {
      const level = rms(block);
      vad.feed(level, (block.length / rate) * 1000, Date.now());
      const pcm = floatToPcm16(block, rate, LIVE_INPUT_RATE);
      events.chunk(new Uint8Array(pcm.buffer));
    };
    this.source = this.ctx.createMediaStreamSource(this.stream);
    // The tap must reach the destination to run in some browsers: through a muted gain.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.mute.connect(this.ctx.destination);
    try {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const node = new AudioWorkletNode(this.ctx, "nadhra-mic-tap");
      node.port.onmessage = (ev) => onBlock(ev.data as Float32Array);
      this.tap = node;
    } catch {
      // Older Safari: no AudioWorklet.
      const node = this.ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (ev) => onBlock(new Float32Array(ev.inputBuffer.getChannelData(0)));
      this.tap = node;
    }
    this.source.connect(this.tap);
    this.tap.connect(this.mute);
    await this.ctx.resume().catch(() => {});
  }

  /** Plays a chunk of the answer right after the previous one, without gaps. */
  play(pcm: Uint8Array) {
    const samples = pcm16ToFloat(pcm);
    if (!samples.length) return;
    const buf = this.ctx.createBuffer(1, samples.length, LIVE_OUTPUT_RATE);
    buf.copyToChannel(samples, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    // A small lead absorbs network jitter; after a pause the answer starts almost at once.
    const startAt = Math.max(this.ctx.currentTime + 0.04, this.nextAt);
    src.start(startAt);
    this.nextAt = startAt + buf.duration;
    const wasIdle = this.playing.size === 0;
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      if (this.playing.size === 0) this.onPlaying(false);
    };
    if (wasIdle) this.onPlaying(true);
  }

  /** Stops the answer at once and drops what was queued (the user interrupted). */
  flush() {
    for (const src of this.playing) {
      src.onended = null;
      try {
        src.stop();
      } catch {}
    }
    const had = this.playing.size > 0;
    this.playing.clear();
    this.nextAt = 0;
    this.setDucked(false);
    if (had) this.onPlaying(false);
  }

  get isPlaying() {
    return this.playing.size > 0;
  }

  setVolume(v: number) {
    this.volume = Math.min(1, Math.max(0, v));
    this.applyGain();
  }

  /** Quieter while the user talks over the answer, until Gemini confirms the interruption. */
  setDucked(d: boolean) {
    if (this.ducked === d) return;
    this.ducked = d;
    this.applyGain();
  }

  private applyGain() {
    const target = this.volume * (this.ducked ? 0.25 : 1);
    try {
      this.out.gain.setTargetAtTime(target, this.ctx.currentTime, 0.03);
    } catch {
      this.out.gain.value = target;
    }
  }

  close() {
    this.flush();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.source?.disconnect();
      this.tap?.disconnect();
      this.mute?.disconnect();
    } catch {}
    if (this.tap instanceof AudioWorkletNode) this.tap.port.onmessage = null;
    void this.ctx.close().catch(() => {});
  }
}
