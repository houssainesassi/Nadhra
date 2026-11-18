// SERVER-ONLY. Mints short-lived Gemini Live tokens for the browser. The API key stays here; the
// token can open one session, only within about a minute, and only with the setup locked into it
// (model, female voice, instructions). Audio and frames then go from the browser to Gemini directly
// and never pass through this server.
import "server-only";
import { LIVE_WS_URL, liveSystemPrompt, parseLiveModels, pickLiveVoice } from "../live/config.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { CameraFacing } from "../assistant/types.ts";
import { aiMode } from "../ai/router.ts";
import type { LivePricing, TokenModality } from "../live/metrics.ts";
import { geoEnabled } from "./geo.ts";
import { GEO_FUNCTION_DECLARATIONS } from "../geo/tools.ts";

const AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

export interface LiveConfig {
  enabled: boolean;
  models: string[];
  voice: string;
  /** Milliseconds of silence that end the user's turn. Lower answers sooner but may cut slow speakers off. */
  silenceMs: number;
  /** How readily a pause counts as the end of the user's turn. */
  endSensitivity: "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW" | undefined;
  /**
   * Gemini's own "proactive audio" (the model may choose not to answer input that isn't for it).
   * Off unless GEMINI_LIVE_PROACTIVE_AUDIO=1: not every Live model or API version accepts it, and a
   * refused setup would make every connection fall back. Speaking first works without it.
   */
  proactiveAudio: boolean;
  /**
   * Context compression: once the context reaches `triggerTokens` before a turn, the oldest part is
   * dropped down to `targetTokens`. Every turn re-reads (and is billed for) the whole context, so
   * this caps the cost of a turn in a long session. Google's default trigger is 80% of the model's
   * context window (~100k tokens a turn); 25,600 / 12,800 is the example in Google's documentation
   * (about 8 minutes of a live conversation at the ~48 tokens a second measured). 0 = Google's default.
   */
  contextTriggerTokens: number;
  contextTargetTokens: number;
  /** The location tools (GPS, nearby places, walking routes) are in the session. See geo.ts. */
  geo: boolean;
}

const intEnv = (v: string | undefined, def: number, min: number, max: number) => {
  if (v == null || v.trim() === "") return def;
  const n = Number(v);
  return Number.isInteger(n) && (n === 0 || (n >= min && n <= max)) ? n : def;
};

export function liveConfig(): LiveConfig {
  const silence = Number(process.env.GEMINI_LIVE_SILENCE_MS);
  return {
    // Gemini Live is cloud only: there is no local equivalent, so offline mode turns it off.
    enabled: !!process.env.GEMINI_API_KEY?.trim() && !/^(1|true|yes)$/i.test(process.env.GEMINI_LIVE_DISABLED?.trim() ?? "") && aiMode() !== "offline",
    models: parseLiveModels(process.env.GEMINI_LIVE_MODELS),
    voice: pickLiveVoice(process.env.GEMINI_LIVE_VOICE),
    silenceMs: Number.isFinite(silence) && silence >= 200 && silence <= 2000 ? Math.round(silence) : 500,
    proactiveAudio: /^(1|true|yes)$/i.test(process.env.GEMINI_LIVE_PROACTIVE_AUDIO?.trim() ?? ""),
    contextTriggerTokens: intEnv(process.env.GEMINI_LIVE_CONTEXT_TRIGGER_TOKENS, 25_600, 4_000, 1_000_000),
    contextTargetTokens: intEnv(process.env.GEMINI_LIVE_CONTEXT_TARGET_TOKENS, 12_800, 2_000, 1_000_000),
    endSensitivity: ({ high: "END_SENSITIVITY_HIGH", low: "END_SENSITIVITY_LOW" } as const)[process.env.GEMINI_LIVE_END_SENSITIVITY?.trim().toLowerCase() ?? ""],
    geo: geoEnabled(),
  };
}

export function liveStatus() {
  const c = liveConfig();
  return { configured: c.enabled, models: c.models, voice: c.voice, pricing: livePricing(), geo: c.geo };
}

/**
 * Prices for the cost estimate, per million tokens, from the environment only: nothing is assumed.
 * GEMINI_LIVE_PRICE_IN_AUDIO / _IN_IMAGE / _IN_TEXT / _IN_OTHER, GEMINI_LIVE_PRICE_OUT_AUDIO /
 * _OUT_TEXT / _OUT_OTHER, and GEMINI_LIVE_PRICE_CURRENCY (default USD). Null when none is set.
 */
export function livePricing(env: Record<string, string | undefined> = process.env): LivePricing | null {
  const read = (dir: "IN" | "OUT") => {
    const out: Partial<Record<TokenModality, number>> = {};
    for (const m of ["audio", "image", "text", "other"] as const) {
      const raw = env[`GEMINI_LIVE_PRICE_${dir}_${m.toUpperCase()}`]?.trim();
      if (!raw) continue;
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0 && n < 10_000) out[m] = n;
    }
    return out;
  };
  const input = read("IN");
  const output = read("OUT");
  if (!Object.keys(input).length && !Object.keys(output).length) return null;
  const cur = env.GEMINI_LIVE_PRICE_CURRENCY?.trim().toUpperCase();
  return { currency: cur && /^[A-Z]{3}$/.test(cur) ? cur : "USD", input, output };
}

export interface MintOptions {
  lang: SpeechLang;
  facing: CameraFacing;
  /** Index into the model list: the browser asks for the next one when a model fails to connect. */
  modelIndex: number;
  /** Session resumption handle from the previous connection, to continue the same conversation. */
  handle?: string;
}

/** The BidiGenerateContentSetup message. The browser sends exactly this; the token enforces it. */
export function buildLiveSetup(o: MintOptions, c: LiveConfig = liveConfig()) {
  const model = c.models[Math.min(Math.max(0, o.modelIndex), c.models.length - 1)];
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice } } },
    },
    systemInstruction: { parts: [{ text: liveSystemPrompt(o.lang, o.facing, c.geo) }] },
    // The phone runs these (src/lib/geo/geoController.ts) and answers with what the maps say.
    ...(c.geo ? { tools: [{ functionDeclarations: GEO_FUNCTION_DECLARATIONS }] } : {}),
    realtimeInputConfig: {
      automaticActivityDetection: { silenceDurationMs: c.silenceMs, prefixPaddingMs: 100, ...(c.endSensitivity ? { endOfSpeechSensitivity: c.endSensitivity } : {}) },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Audio + video sessions end after 2 minutes without this. See LiveConfig.contextTriggerTokens.
    contextWindowCompression: c.contextTriggerTokens > 0
      ? { triggerTokens: c.contextTriggerTokens, slidingWindow: { targetTokens: Math.min(c.contextTargetTokens || c.contextTriggerTokens / 2, c.contextTriggerTokens - 1) } }
      : { slidingWindow: {} },
    sessionResumption: o.handle ? { handle: o.handle } : {},
    ...(c.proactiveAudio ? { proactivity: { proactiveAudio: true } } : {}),
  };
}

export type MintResult =
  | { ok: true; token: string; url: string; setup: ReturnType<typeof buildLiveSetup>; model: string; voice: string; lastModel: boolean; pricing: LivePricing | null }
  | { ok: false; status: number; error: string };

export async function mintLiveToken(o: MintOptions, signal?: AbortSignal): Promise<MintResult> {
  const c = liveConfig();
  if (!c.enabled) return { ok: false, status: 503, error: "not-configured" };
  const setup = buildLiveSetup(o, c);
  let res: Response;
  try {
    res = await fetch(AUTH_TOKENS_URL, {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY!.trim(), "Content-Type": "application/json" },
      // Expiry times are left to Google (1 min to connect, 30 min of messages): our clock may be off.
      body: JSON.stringify({ uses: 1, bidiGenerateContentSetup: setup }),
      signal: signal ?? AbortSignal.timeout(8_000),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 502, error: "upstream-unavailable" };
  }
  const data = (await res.json().catch(() => null)) as { name?: unknown; error?: { message?: unknown; status?: unknown } } | null;
  if (!res.ok || typeof data?.name !== "string") {
    // Google's own reason (e.g. a setup field it doesn't accept), for the server log only. It never
    // contains the key; it is cut short and kept on one line.
    const why = [data?.error?.status, data?.error?.message].filter((x) => typeof x === "string").join(": ").replace(/\s+/g, " ").slice(0, 300);
    console.warn(`[live/token] Gemini refused a token: HTTP ${res.status}${why ? ` (${why})` : ""}`);
    return { ok: false, status: res.status === 429 ? 429 : 502, error: res.status === 429 ? "rate-limited" : "upstream-unavailable" };
  }
  const idx = Math.min(Math.max(0, o.modelIndex), c.models.length - 1);
  return { ok: true, token: data.name, url: LIVE_WS_URL, setup, model: c.models[idx], voice: c.voice, lastModel: idx >= c.models.length - 1, pricing: livePricing() };
}
