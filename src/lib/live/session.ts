// One live conversation with Gemini over a WebSocket: microphone audio and camera frames go up,
// spoken audio and transcripts come back as they are generated. No DOM or audio APIs here (see
// audioIO.ts), so this runs in Node against the real service in tests.
//
// - The token comes from our server (/api/live/token); the API key never reaches the browser.
// - The server detects when the user starts and stops talking. When the user talks over an answer,
//   Gemini stops generating and sends `interrupted`: playback must be flushed at once.
// - A connection lasts about 10 minutes and can drop at any time. The session keeps a resumption
//   handle and reconnects into the same conversation (same memory of what was seen and said).
import { bytesToBase64, base64ToBytes } from "./pcm.ts";
import { LIVE_INPUT_RATE } from "./config.ts";
import { apiFetch } from "../assistant/api.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { CameraFacing } from "../assistant/types.ts";

export type LiveStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "failed";

export interface LiveEvents {
  status?(s: LiveStatus, detail?: string): void;
  /** 16-bit PCM at 24 kHz, to play right away. */
  audio?(pcm: Uint8Array): void;
  /** The model was cut off by the user: drop everything not yet played. */
  interrupted?(): void;
  /** The model finished its answer. */
  turnComplete?(): void;
  /** What the user said, as recognized (pieces arrive while they talk). */
  userText?(piece: string): void;
  /** What the model is saying (pieces arrive with the audio). */
  aiText?(piece: string): void;
  /** The service heard the user start talking (send a fresh frame now). */
  userSpeechStart?(): void;
  /** Time from the end of the user's speech to the first audio of the answer. */
  latency?(ms: number): void;
}

interface TokenResponse {
  token: string;
  url: string;
  setup: unknown;
  model: string;
  voice: string;
  lastModel: boolean;
}

export interface LiveSessionOptions {
  lang: SpeechLang;
  facing: CameraFacing;
  /** Token route. Absolute in Node tests. */
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  /** Clock, replaceable in tests. */
  now?: () => number;
  setupTimeoutMs?: number;
  maxReconnects?: number;
}

/** About 3 s of 16 kHz 16-bit audio. */
const PENDING_AUDIO_BYTES = 3 * 16_000 * 2;

type WsData = string | ArrayBuffer | Blob | Uint8Array;

class TokenError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

export class LiveSession {
  status: LiveStatus = "idle";
  model = "";
  voice = "";
  private ws: WebSocket | null = null;
  private handle: string | undefined;
  private modelIndex = 0;
  private active = false;
  private gen = 0;
  private reconnects = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private speechEndAt = 0;
  private awaitingFirstAudio = false;
  private activityStartAt = 0;
  private pendingAudio: Uint8Array[] = [];
  private pendingBytes = 0;
  private opts: Required<Omit<LiveSessionOptions, "lang" | "facing">> & Pick<LiveSessionOptions, "lang" | "facing">;

  private events: LiveEvents;

  constructor(opts: LiveSessionOptions, events: LiveEvents = {}) {
    this.events = events;
    this.opts = {
      tokenUrl: "/api/live/token",
      fetchImpl: (url, init) => apiFetch(String(url), init),
      WebSocketImpl: globalThis.WebSocket,
      now: () => Date.now(),
      setupTimeoutMs: 10_000,
      maxReconnects: 8,
      ...opts,
    };
  }

  get isOpen() {
    return this.status === "open" && this.ws?.readyState === 1;
  }

  /** Resolves once the first connection is ready; rejects if none could be made. */
  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.reconnects = 0;
    this.setStatus("connecting");
    await this.connect(false);
  }

  stop() {
    this.active = false;
    this.gen++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, "done");
    } catch {}
    this.handle = undefined;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.setStatus("closed");
  }

  /** The network came back: reconnect now instead of waiting for the backoff. */
  nudge() {
    if (!this.active || this.status !== "reconnecting") return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.connect(true).catch(() => {});
  }

  /**
   * 16-bit PCM at 16 kHz. While reconnecting, the last few seconds are kept and sent once the
   * connection is back, so words said during a short drop aren't lost. Older audio is dropped.
   */
  sendAudio(pcm: Uint8Array) {
    if (!this.isOpen) {
      if (this.status !== "reconnecting" && this.status !== "connecting") return;
      this.pendingAudio.push(pcm);
      this.pendingBytes += pcm.length;
      while (this.pendingBytes > PENDING_AUDIO_BYTES && this.pendingAudio.length) this.pendingBytes -= this.pendingAudio.shift()!.length;
      return;
    }
    this.send({ realtimeInput: { audio: { data: bytesToBase64(pcm), mimeType: `audio/pcm;rate=${LIVE_INPUT_RATE}` } } });
  }

  private flushPendingAudio() {
    const chunks = this.pendingAudio.splice(0);
    this.pendingBytes = 0;
    for (const c of chunks) this.sendAudio(c);
  }

  /** A JPEG frame, base64 without the data: prefix. */
  sendFrame(jpegBase64: string) {
    if (!this.isOpen) return false;
    this.send({ realtimeInput: { video: { data: jpegBase64, mimeType: "image/jpeg" } } });
    return true;
  }

  /** A typed question or a quick-question button. */
  sendText(text: string) {
    if (!this.isOpen) return false;
    this.speechEndAt = this.opts.now();
    this.awaitingFirstAudio = true;
    this.send({ realtimeInput: { text } });
    return true;
  }

  /** The user stopped talking, by our own measure (the server's ACTIVITY_END also counts). */
  markSpeechEnd(at = this.opts.now()) {
    this.speechEndAt = at;
    this.awaitingFirstAudio = true;
  }

  private send(msg: unknown) {
    try {
      this.ws?.send(JSON.stringify(msg));
    } catch {}
  }

  private setStatus(s: LiveStatus, detail?: string) {
    if (this.status === s && !detail) return;
    this.status = s;
    this.events.status?.(s, detail);
  }

  private async fetchToken(): Promise<TokenResponse> {
    let res: Response;
    try {
      res = await this.opts.fetchImpl(this.opts.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lang: this.opts.lang, facing: this.opts.facing, modelIndex: this.modelIndex, handle: this.handle }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new TokenError("network", true);
    }
    const d = (await res.json().catch(() => null)) as (TokenResponse & { error?: string }) | null;
    if (!res.ok || !d?.token) {
      const code = d?.error ?? `http-${res.status}`;
      // A spent daily budget doesn't come back by retrying in a few seconds.
      throw new TokenError(code, code !== "not-configured" && code !== "forbidden" && code !== "quota-exhausted");
    }
    return d;
  }

  private async connect(resuming: boolean): Promise<void> {
    const gen = ++this.gen;
    let tok: TokenResponse;
    try {
      tok = await this.fetchToken();
    } catch (e) {
      if (gen !== this.gen) return;
      const err = e as TokenError;
      if (!resuming && !err.retryable) {
        this.active = false;
        this.setStatus("failed", err.code);
        throw err;
      }
      return this.scheduleReconnect(err.code, resuming);
    }
    if (gen !== this.gen || !this.active) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new this.opts.WebSocketImpl(`${tok.url}?access_token=${encodeURIComponent(tok.token)}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      const setupTimer = setTimeout(() => fail("setup-timeout"), this.opts.setupTimeoutMs);
      const fail = (why: string) => {
        clearTimeout(setupTimer);
        if (gen !== this.gen) return;
        try {
          ws.close();
        } catch {}
        if (this.ws === ws) this.ws = null;
        if (!settled) {
          settled = true;
          // A model that can't be reached at all: try the next one (only for a fresh conversation,
          // since a resumption handle belongs to the model that made it).
          if (!resuming && !this.handle && !tok.lastModel) {
            this.modelIndex++;
            this.connect(false).then(resolve, reject);
            return;
          }
          this.scheduleReconnect(why, true);
          resolve();
          return;
        }
        this.scheduleReconnect(why, true);
      };
      ws.onopen = () => ws.send(JSON.stringify({ setup: tok.setup }));
      ws.onerror = () => fail("socket-error");
      ws.onclose = (ev) => {
        if (gen !== this.gen || !this.active) return;
        fail(`closed-${ev.code}${ev.reason ? `:${ev.reason.slice(0, 80)}` : ""}`);
      };
      ws.onmessage = (ev) => {
        if (gen !== this.gen) return;
        const data = ev.data as WsData;
        // Decoded synchronously when possible, so arrival order and arrival time are kept.
        const handle = (m: ServerMessage | null) => {
          if (!m || gen !== this.gen) return;
          if (m.setupComplete) {
            clearTimeout(setupTimer);
            this.model = tok.model;
            this.voice = tok.voice;
            this.reconnects = 0;
            this.setStatus("open");
            this.flushPendingAudio();
            if (!settled) {
              settled = true;
              resolve();
            }
            return;
          }
          this.handleMessage(m);
        };
        if (typeof Blob !== "undefined" && data instanceof Blob) void data.text().then((t) => handle(parseMessage(t)));
        else handle(parseMessage(data as string | ArrayBuffer | Uint8Array));
      };
    });
  }

  private scheduleReconnect(why: string, resuming: boolean) {
    if (!this.active) return;
    if (++this.reconnects > this.opts.maxReconnects) {
      this.active = false;
      this.setStatus("failed", why);
      return;
    }
    this.setStatus("reconnecting", why);
    const delay = Math.min(8_000, 400 * 2 ** (this.reconnects - 1));
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(resuming).catch(() => {});
    }, delay);
  }

  private handleMessage(m: ServerMessage) {
    if (m.sessionResumptionUpdate) {
      const u = m.sessionResumptionUpdate;
      if (u.resumable !== false && typeof u.newHandle === "string" && u.newHandle) this.handle = u.newHandle;
    }
    if (m.goAway) {
      // The server will close this connection soon: open the next one now, in the same conversation.
      this.gen++;
      const old = this.ws;
      this.ws = null;
      setTimeout(() => {
        try {
          old?.close(1000, "go-away");
        } catch {}
      }, 1_500);
      this.setStatus("reconnecting", "go-away");
      void this.connect(true).catch(() => {});
      return;
    }
    if (m.voiceActivity?.type === "ACTIVITY_START") {
      this.activityStartAt = this.opts.now();
      this.events.userSpeechStart?.();
    }
    // Our own detector usually saw the end of this speech first, and earlier: the server's is the fallback.
    if (m.voiceActivity?.type === "ACTIVITY_END" && this.speechEndAt < this.activityStartAt) this.markSpeechEnd();
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) {
      this.awaitingFirstAudio = false;
      this.events.interrupted?.();
    }
    if (sc.inputTranscription?.text) this.events.userText?.(sc.inputTranscription.text);
    for (const p of sc.modelTurn?.parts ?? []) {
      const data = p.inlineData?.data;
      if (!data) continue;
      if (this.awaitingFirstAudio) {
        this.awaitingFirstAudio = false;
        if (this.speechEndAt) this.events.latency?.(Math.max(0, this.opts.now() - this.speechEndAt));
      }
      this.events.audio?.(base64ToBytes(data));
    }
    if (sc.outputTranscription?.text) this.events.aiText?.(sc.outputTranscription.text);
    if (sc.turnComplete) this.events.turnComplete?.();
  }
}

interface ServerMessage {
  setupComplete?: unknown;
  goAway?: { timeLeft?: string };
  sessionResumptionUpdate?: { newHandle?: string; resumable?: boolean };
  voiceActivity?: { type?: string };
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { data?: string; mimeType?: string }; text?: string }[] };
    interrupted?: boolean;
    turnComplete?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
}

function parseMessage(data: string | ArrayBuffer | Uint8Array): ServerMessage | null {
  try {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    return JSON.parse(text) as ServerMessage;
  } catch {
    return null;
  }
}
