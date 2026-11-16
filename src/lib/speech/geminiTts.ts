// SERVER-ONLY. The assistant's voice: Google Gemini TTS, voice Sulafat (the same voice as the live
// conversation). The only voice the app speaks with: there is no other cloud voice and no browser
// voice to fall back to, so a failure is reported to the page, which shows it and lets the screen
// reader read the sentence. Sentences are synthesized and returned; they are never stored or logged.
import "server-only";
import { clientKey, RateLimiter, readJsonBody } from "../server/http.ts";
import { charge, checkRequest } from "../server/guard.ts";
import { aiMode } from "../ai/router.ts";

export const MAX_TTS_CHARS = 500; // a spoken sentence is far shorter
/** The one voice. Not configurable: the client chooses nothing, the environment can't change it. */
export const TTS_VOICE = "Sulafat";
/** The model the Sulafat samples were made with (Nov 2026). GEMINI_TTS_MODEL overrides it. */
export const DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts";
const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,80}$/;
const FAILURES_BEFORE_COOLDOWN = 3;

export interface TtsConfig {
  enabled: boolean;
  model: string;
  endpoint: string;
  timeoutMs: number;
  maxPerMin: number;
  cooldownMs: number;
}

export function ttsConfig(): TtsConfig {
  const envModel = process.env.GEMINI_TTS_MODEL?.trim() ?? "";
  return {
    // A cloud service: off without a key, when disabled, and in offline mode.
    enabled: !!process.env.GEMINI_API_KEY?.trim() && !/^(1|true|yes)$/i.test(process.env.GEMINI_TTS_DISABLED?.trim() ?? "") && aiMode() !== "offline",
    model: MODEL_RE.test(envModel) ? envModel : DEFAULT_TTS_MODEL,
    // Test hook only (points the server at a local mock). Leave unset in production.
    endpoint: process.env.GEMINI_TTS_ENDPOINT || GEMINI_MODELS_URL,
    // Measured Nov 2026: 2.3-5 s for a short sentence, 18 s for 17 s of audio.
    timeoutMs: Number(process.env.GEMINI_TTS_TIMEOUT_MS ?? 20_000),
    maxPerMin: Number(process.env.TTS_RATE_LIMIT_PER_MIN ?? 30),
    cooldownMs: Number(process.env.AI_RATE_LIMIT_COOLDOWN_MS ?? 60_000),
  };
}

export function ttsStatus() {
  const c = ttsConfig();
  return { configured: c.enabled, provider: "gemini", voice: TTS_VOICE, maxChars: MAX_TTS_CHARS };
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

export class UpstreamError extends Error {
  kind: "rate-limited" | "http" | "no-audio";
  status: number;
  constructor(kind: UpstreamError["kind"], message: string, status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

/** 16-bit mono PCM (what Gemini TTS returns) in a WAV container the browser can decode. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const ascii = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

type GeminiAudioResponse = { candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[] };

/**
 * One sentence -> WAV. The bare text only: a style instruction in front of it is read aloud too.
 * `voice` is for test tooling only; the route always uses TTS_VOICE.
 */
export async function synthesize(text: string, c: TtsConfig, signal: AbortSignal, voice: string = TTS_VOICE): Promise<Uint8Array> {
  if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
  const res = await fetch(`${c.endpoint}/${encodeURIComponent(c.model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY?.trim() ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
    signal,
  });
  if (res.status === 429) throw new UpstreamError("rate-limited", "Gemini TTS rate limited", 429);
  if (!res.ok) throw new UpstreamError("http", `Gemini TTS HTTP ${res.status}`, res.status);
  const d = (await res.json().catch(() => null)) as GeminiAudioResponse | null;
  const part = d?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!part?.data) throw new UpstreamError("no-audio", "Gemini TTS returned no audio");
  const pcm = Uint8Array.from(Buffer.from(part.data, "base64"));
  if (!pcm.byteLength) throw new UpstreamError("no-audio", "Gemini TTS returned no audio");
  const rate = Number(/rate=(\d+)/.exec(part.mimeType ?? "")?.[1] ?? 24_000);
  return pcmToWav(pcm, rate);
}

// Per-instance protection (serverless instances don't share memory): per-client limit + back off
// after repeated upstream failures.
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
  // `rate` and `lang` may still be sent: Sulafat speaks every language at its own pace, so both are ignored.
  const parsed = await readJsonBody<{ text?: unknown } | null>(req, 4096);
  if (!parsed.ok) return json(parsed.status, { error: parsed.error });
  const v = validateTtsText(parsed.value?.text);
  if (!v.ok) return json(400, { error: v.error });

  const now = Date.now();
  if (cooldownUntil > now) {
    return json(503, { error: "upstream-unavailable" }, { "Retry-After": String(Math.ceil((cooldownUntil - now) / 1000)) });
  }
  if (!rateLimiter(c.maxPerMin).hit(clientKey(req), now)) return json(429, { error: "too many requests" }, { "Retry-After": "30" });
  const limited = await charge(ctx, "tts", now);
  if (limited) return limited;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs);
  // The page aborted (closed, or switched to Nadhra): stop.
  const onGone = () => ctrl.abort();
  if (req.signal?.aborted) ctrl.abort();
  else req.signal?.addEventListener("abort", onGone, { once: true });
  try {
    const audio = await synthesize(v.text, c, ctrl.signal);
    consecutiveFailures = 0;
    return new Response(audio as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(audio.byteLength),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    const err = e as Error;
    // Cancelled by the page: not an upstream failure, and nobody is waiting for an answer.
    if (req.signal?.aborted) return json(499, { error: "cancelled" });
    if (++consecutiveFailures >= FAILURES_BEFORE_COOLDOWN) {
      cooldownUntil = Date.now() + c.cooldownMs; // upstream down or limiting us: stop hammering it
      consecutiveFailures = 0;
    }
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      console.error("[tts] Gemini TTS timeout");
      return json(504, { error: "upstream-timeout" });
    }
    console.error(`[tts] ${err.message}`); // never logs the sentence
    if (e instanceof UpstreamError && e.kind === "rate-limited") return json(429, { error: "rate-limited" }, { "Retry-After": "60" });
    return json(502, { error: "upstream-error" });
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener("abort", onGone);
  }
}
