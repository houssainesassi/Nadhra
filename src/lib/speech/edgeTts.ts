// SERVER-ONLY. Free Arabic cloud voice through Microsoft Edge's online "Read aloud" TTS service,
// spoken over WebSocket (protocol ported from the open-source edge-tts project, rany2/edge-tts).
// No API key, no account, no billing. Used only when the browser has no Arabic voice.
// Sentences are synthesized and returned; they are never stored or logged.
//
// Caveat: this is an unofficial, undocumented endpoint (the one the Edge browser uses). It has no
// SLA and Microsoft may change or restrict it at any time; see README "Cloud voice".
import "server-only";
import { CHROMIUM_MAJOR_VERSION, SEC_MS_GEC_VERSION, TRUSTED_CLIENT_TOKEN, secMsGec } from "./edgeDrm.ts";
import { clientKey, RateLimiter, readJsonBody } from "../server/http.ts";
import { charge, checkRequest } from "../server/guard.ts";
import { CLOUD_VOICES, isSpeechLang } from "../assistant/lang.ts";

export const MAX_TTS_CHARS = 500; // a recognized sentence is far shorter; the service splits at 4096 bytes
/** Tunisian Arabic, female. The assistant speaks with a female voice only. */
export const DEFAULT_VOICE = "ar-TN-ReemNeural";
/**
 * The only voices this server will use: all female (pitch measured Nov 2026: Reem 183 Hz, Zariyah
 * 211 Hz; the male ar-TN-HediNeural measured 121 Hz and is refused). EDGE_TTS_VOICE outside this
 * list is ignored.
 */
export const FEMALE_EDGE_VOICES = ["ar-TN-ReemNeural", "ar-SA-ZariyahNeural", "ar-EG-SalmaNeural", "fr-FR-DeniseNeural", "en-US-JennyNeural"] as const;
const EDGE_WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]{1,40}Neural$/;
const FAILURES_BEFORE_COOLDOWN = 3;

export interface TtsConfig {
  enabled: boolean;
  voice: string;
  languageCode: string;
  endpoint: string;
  timeoutMs: number;
  maxPerMin: number;
  cooldownMs: number;
}

export function ttsConfig(): TtsConfig {
  const envVoice = process.env.EDGE_TTS_VOICE?.trim() ?? "";
  const voice = VOICE_RE.test(envVoice) && (FEMALE_EDGE_VOICES as readonly string[]).includes(envVoice) ? envVoice : DEFAULT_VOICE;
  return {
    enabled: !/^(1|true|yes)$/i.test(process.env.EDGE_TTS_DISABLED?.trim() ?? ""),
    voice,
    languageCode: voice.split("-").slice(0, 2).join("-"),
    // Test hook only (points the server at a local mock). Leave unset in production.
    endpoint: process.env.EDGE_TTS_ENDPOINT || EDGE_WSS_URL,
    timeoutMs: Number(process.env.EDGE_TTS_TIMEOUT_MS ?? 10_000),
    maxPerMin: Number(process.env.TTS_RATE_LIMIT_PER_MIN ?? 30),
    cooldownMs: Number(process.env.AI_RATE_LIMIT_COOLDOWN_MS ?? 60_000),
  };
}

export function ttsStatus() {
  const c = ttsConfig();
  return { configured: c.enabled, provider: "edge", voice: c.voice, languageCode: c.languageCode, maxChars: MAX_TTS_CHARS };
}

/** Normalize and validate the text to synthesize. */
export function validateTtsText(input: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof input !== "string") return { ok: false, error: "text must be a string" };
  const text = input.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return { ok: false, error: "text is empty" };
  if (text.length > MAX_TTS_CHARS) return { ok: false, error: `text longer than ${MAX_TTS_CHARS} characters` };
  if (!/[\p{L}\p{N}]/u.test(text)) return { ok: false, error: "text has no letters" };
  return { ok: true, text };
}

/** Speaking rate from the app setting (0.5–1.5), rounded so identical requests stay identical. */
export function normalizeRate(input: unknown): number {
  const r = typeof input === "number" && Number.isFinite(input) ? input : 1;
  return Math.round(Math.min(1.5, Math.max(0.5, r)) * 10) / 10;
}

/** 0.9 -> "-10%", 1.2 -> "+20%" (SSML prosody rate relative to the voice's default). */
export function prosodyRate(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? "+" : "-"}${Math.abs(pct)}%`;
}

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[ch]!);

export function buildSsml(text: string, voice: string, rate: number): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='+0Hz' rate='${prosodyRate(rate)}' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`
  );
}

const jsDate = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) /, "$1 $3 $2 $4 ").replace("GMT", "GMT+0000 (Coordinated Universal Time)");
const connectId = () => crypto.randomUUID().replaceAll("-", "");
const muid = () => connectId().toUpperCase();

export class UpstreamError extends Error {
  /** "handshake" = connection refused before open (token rejected, blocked, DNS). */
  kind: "handshake" | "protocol" | "no-audio";
  constructor(kind: UpstreamError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Minimal WebSocket surface we use (lets tests inject a fake). */
export interface WsLike {
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(): void;
}
export type WsFactory = (url: string, headers: Record<string, string>) => WsLike;

// Node's built-in WebSocket (undici) accepts { headers }; the DOM typings don't know that option.
type NodeWsCtor = new (url: string, init: { headers: Record<string, string> }) => WsLike;
const defaultWs: WsFactory = (url, headers) => {
  // Node >= 22 has a global WebSocket (undici) that accepts custom headers; Node 20 does not.
  if (typeof globalThis.WebSocket !== "function") throw new Error("no global WebSocket in this runtime (Node >= 22 required)");
  return new (globalThis.WebSocket as unknown as NodeWsCtor)(url, { headers });
};
let wsFactory: WsFactory = defaultWs;

/** Test helper. */
export function setWsFactory(f: WsFactory | null) {
  wsFactory = f ?? defaultWs;
}

function parseHeaders(block: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const line of block.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) h[line.slice(0, i)] = line.slice(i + 1);
  }
  return h;
}

/** One synthesis over one WebSocket: speech.config + ssml -> MP3 chunks until turn.end. */
export function synthesize(text: string, rate: number, c: TtsConfig, signal: AbortSignal): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const url = `${c.endpoint}&ConnectionId=${connectId()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`;
    const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
    let ws: WsLike;
    try {
      ws = wsFactory(url, {
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent": ua,
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: `muid=${muid()};`,
      });
    } catch (e) {
      return reject(new UpstreamError("handshake", `Edge TTS connect failed: ${(e as Error).message}`));
    }
    ws.binaryType = "arraybuffer";
    const chunks: Uint8Array[] = [];
    let opened = false;
    let settled = false;
    const finish = (err: Error | null) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      try {
        ws.close();
      } catch {}
      if (err) return reject(err);
      const total = chunks.reduce((n, ch) => n + ch.byteLength, 0);
      if (!total) return reject(new UpstreamError("no-audio", "Edge TTS returned no audio"));
      const out = new Uint8Array(total);
      let o = 0;
      for (const ch of chunks) {
        out.set(ch, o);
        o += ch.byteLength;
      }
      resolve(out);
    };
    const onAbort = () => finish(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);

    ws.onopen = () => {
      opened = true;
      ws.send(
        `X-Timestamp:${jsDate()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
          `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`,
      );
      ws.send(
        `X-RequestId:${connectId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${jsDate()}Z\r\nPath:ssml\r\n\r\n` +
          buildSsml(text, c.voice, rate),
      );
    };
    ws.onmessage = ({ data }) => {
      if (typeof data === "string") {
        const sep = data.indexOf("\r\n\r\n");
        const path = parseHeaders(sep >= 0 ? data.slice(0, sep) : data).Path;
        if (path === "turn.end") finish(null);
        return; // turn.start / response / audio.metadata: nothing to do
      }
      const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
      if (!buf || buf.byteLength < 2) return finish(new UpstreamError("protocol", "Edge TTS sent a malformed binary frame"));
      const hl = (buf[0] << 8) | buf[1];
      if (hl + 2 > buf.byteLength) return finish(new UpstreamError("protocol", "Edge TTS header length out of range"));
      const h = parseHeaders(new TextDecoder().decode(buf.subarray(2, 2 + hl)));
      if (h.Path !== "audio") return finish(new UpstreamError("protocol", `Edge TTS unexpected binary path ${String(h.Path).slice(0, 40)}`));
      const audio = buf.subarray(2 + hl);
      if (audio.byteLength && h["Content-Type"] !== "audio/mpeg") return finish(new UpstreamError("protocol", "Edge TTS unexpected content type"));
      if (audio.byteLength) chunks.push(audio.slice());
    };
    ws.onerror = () => finish(new UpstreamError(opened ? "protocol" : "handshake", opened ? "Edge TTS socket error" : "Edge TTS handshake refused"));
    ws.onclose = ({ code }) => finish(new UpstreamError(opened ? "protocol" : "handshake", `Edge TTS closed early (code ${code})`));
  });
}

// Per-instance protection (serverless instances don't share memory). The upstream has no published
// quota, so we stay polite: per-client limit + back off after repeated upstream failures.
let limiter: RateLimiter | null = null;
let limiterMax = 0;
let cooldownUntil = 0;
let consecutiveFailures = 0;

/** Test helper. */
export function resetTtsState() {
  limiter = null;
  cooldownUntil = 0;
  consecutiveFailures = 0;
}

function rateLimiter(maxPerMin: number): RateLimiter {
  if (!limiter || limiterMax !== maxPerMin) {
    limiter = new RateLimiter(maxPerMin);
    limiterMax = maxPerMin;
  }
  return limiter;
}

function json(status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

export async function handleTtsPost(req: Request): Promise<Response> {
  const c = ttsConfig();
  if (!c.enabled) return json(503, { error: "not-configured" });
  const ctx = checkRequest(req, "tts");
  if (ctx instanceof Response) return ctx;
  const parsed = await readJsonBody<{ text?: unknown; rate?: unknown; lang?: unknown } | null>(req, 4096);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const body = parsed.value;
  const v = validateTtsText(body?.text);
  if (!v.ok) return json(400, { error: v.error });
  const rate = normalizeRate(body?.rate);
  // Only voices from a fixed list: the client chooses a language, never a voice name.
  const lang = isSpeechLang(body?.lang) ? body.lang : "tn";
  const voice = lang === "tn" ? c.voice : CLOUD_VOICES[lang];
  const vc: TtsConfig = { ...c, voice, languageCode: voice.split("-").slice(0, 2).join("-") };

  const now = Date.now();
  if (cooldownUntil > now) {
    return json(503, { error: "upstream-unavailable" }, { "Retry-After": String(Math.ceil((cooldownUntil - now) / 1000)) });
  }
  if (!rateLimiter(c.maxPerMin).hit(clientKey(req), now)) return json(429, { error: "too many requests" }, { "Retry-After": "30" });
  const limited = await charge(ctx, "tts", now);
  if (limited) return limited;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  try {
    let audio: Uint8Array;
    try {
      audio = await synthesize(v.text, rate, vc, ctrl.signal);
    } catch (e) {
      // A refused handshake is often transient (or a token window edge): one fresh attempt.
      if (!(e instanceof UpstreamError && e.kind === "handshake")) throw e;
      audio = await synthesize(v.text, rate, vc, ctrl.signal);
    }
    consecutiveFailures = 0;
    return new Response(audio as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const err = e as Error;
    if (++consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) {
      cooldownUntil = Date.now() + c.cooldownMs; // upstream down or blocking us: stop hammering it
      consecutiveFailures = 0;
    }
    if (err.name === "AbortError") {
      console.error("[tts] Edge TTS timeout");
      return json(504, { error: "upstream-timeout" });
    }
    console.error(`[tts] ${err.message}`); // never logs the sentence
    return json(502, { error: "upstream-error" });
  } finally {
    clearTimeout(timer);
  }
}
