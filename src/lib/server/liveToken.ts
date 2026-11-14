// SERVER-ONLY. Mints short-lived Gemini Live tokens for the browser. The API key stays here; the
// token can open one session, only within about a minute, and only with the setup locked into it
// (model, female voice, instructions). Audio and frames then go from the browser to Gemini directly
// and never pass through this server.
import "server-only";
import { LIVE_WS_URL, liveSystemPrompt, parseLiveModels, pickLiveVoice } from "../live/config.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { CameraFacing } from "../assistant/types.ts";
import { aiMode } from "../ai/router.ts";

const AUTH_TOKENS_URL = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

export interface LiveConfig {
  enabled: boolean;
  models: string[];
  voice: string;
  /** Milliseconds of silence that end the user's turn. Lower answers sooner but may cut slow speakers off. */
  silenceMs: number;
  /** How readily a pause counts as the end of the user's turn. */
  endSensitivity: "END_SENSITIVITY_HIGH" | "END_SENSITIVITY_LOW" | undefined;
}

export function liveConfig(): LiveConfig {
  const silence = Number(process.env.GEMINI_LIVE_SILENCE_MS);
  return {
    // Gemini Live is cloud only: there is no local equivalent, so offline mode turns it off.
    enabled: !!process.env.GEMINI_API_KEY?.trim() && !/^(1|true|yes)$/i.test(process.env.GEMINI_LIVE_DISABLED?.trim() ?? "") && aiMode() !== "offline",
    models: parseLiveModels(process.env.GEMINI_LIVE_MODELS),
    voice: pickLiveVoice(process.env.GEMINI_LIVE_VOICE),
    silenceMs: Number.isFinite(silence) && silence >= 200 && silence <= 2000 ? Math.round(silence) : 500,
    endSensitivity: ({ high: "END_SENSITIVITY_HIGH", low: "END_SENSITIVITY_LOW" } as const)[process.env.GEMINI_LIVE_END_SENSITIVITY?.trim().toLowerCase() ?? ""],
  };
}

export function liveStatus() {
  const c = liveConfig();
  return { configured: c.enabled, models: c.models, voice: c.voice };
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
    systemInstruction: { parts: [{ text: liveSystemPrompt(o.lang, o.facing) }] },
    realtimeInputConfig: {
      automaticActivityDetection: { silenceDurationMs: c.silenceMs, prefixPaddingMs: 100, ...(c.endSensitivity ? { endOfSpeechSensitivity: c.endSensitivity } : {}) },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    // Audio + video sessions end after 2 minutes without this.
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: o.handle ? { handle: o.handle } : {},
  };
}

export type MintResult =
  | { ok: true; token: string; url: string; setup: ReturnType<typeof buildLiveSetup>; model: string; voice: string; lastModel: boolean }
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
  const data = (await res.json().catch(() => null)) as { name?: unknown } | null;
  if (!res.ok || typeof data?.name !== "string") {
    console.warn(`[live/token] Gemini refused a token: HTTP ${res.status}`);
    return { ok: false, status: res.status === 429 ? 429 : 502, error: res.status === 429 ? "rate-limited" : "upstream-unavailable" };
  }
  const idx = Math.min(Math.max(0, o.modelIndex), c.models.length - 1);
  return { ok: true, token: data.name, url: LIVE_WS_URL, setup, model: c.models[idx], voice: c.voice, lastModel: idx >= c.models.length - 1 };
}
