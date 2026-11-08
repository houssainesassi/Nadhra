// SERVER-ONLY. Image understanding with ordered provider fallback.
// To add a provider, add one entry to getVisionProviders(): callers only use this interface.
// Frames are forwarded to the provider and never stored or logged here. Models without a free tier
// are refused, so requests can't be billed.
import "server-only";
import { HttpError, isFreeOpenRouterModel, postJson } from "./http.ts";
import { parseModelJson, sanitizeAnalysis, swapSides } from "../assistant/schema.ts";
import { buildUserText, TRANSCRIBE_PROMPT, VISION_SYSTEM_PROMPT } from "../assistant/prompts.ts";
import type { SceneAnalysis, VisionRequestBody, VisionStatus } from "../assistant/types.ts";

export interface VisionCall {
  system: string;
  text: string;
  /** Base64 JPEGs; the first is the current view. */
  images: string[];
  maxTokens: number;
  signal: AbortSignal;
}

export interface VisionProvider {
  /** Unique per model: a rate limit or outage on one model doesn't affect the others. */
  id: string;
  /** The service, as reported to the browser. */
  family: string;
  /** Who receives the images. Shown to the user in the privacy notice. */
  label: string;
  model: string;
  configured: boolean;
  disabledReason: string | null;
  analyze(call: VisionCall): Promise<string>;
  /** Optional: speech to text, for browsers without speech recognition. */
  transcribe?(wavBase64: string, signal: AbortSignal): Promise<string>;
}

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const COOLDOWN_MS = () => num(process.env.AI_RATE_LIMIT_COOLDOWN_MS, 60_000);
const cooldownUntil = new Map<string, number>();

const geminiText = (data: unknown): string => {
  const parts = (data as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
};

export function getVisionProviders(): VisionProvider[] {
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  // Measured in Nov 2026: 3.5-flash-lite answers in 2-3 s. The others are slower, but free-tier
  // capacity is per model, so they still help when the first one reports "high demand".
  const geminiModels = (process.env.GEMINI_VISION_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash").split(",").map((m) => m.trim()).filter(Boolean);
  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  const orModel = process.env.OPENROUTER_VISION_MODEL || "openrouter/free";

  const gemini = geminiModels.map((model): VisionProvider => {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return {
      id: `gemini:${model}`,
      family: "gemini",
      label: "Google Gemini",
      model,
      configured: !!geminiKey && process.env.GEMINI_ENABLED !== "false",
      disabledReason: /pro/i.test(model) ? `Gemini vision model "${model}" looks like a Pro model, which has no free tier` : null,
      analyze: async ({ system, text, images, maxTokens, signal }) => {
        const data = await postJson(url, { "x-goog-api-key": geminiKey }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [...images.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })), { text }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, responseMimeType: "application/json" },
        }, signal);
        return geminiText(data);
      },
      transcribe: async (wavBase64, signal) => {
        const data = await postJson(url, { "x-goog-api-key": geminiKey }, {
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: wavBase64 } }, { text: TRANSCRIBE_PROMPT }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 300 },
        }, signal);
        return geminiText(data);
      },
    };
  });

  return [
    ...gemini,
    {
      id: "openrouter",
      family: "openrouter",
      label: "OpenRouter",
      model: orModel,
      configured: !!orKey,
      disabledReason: isFreeOpenRouterModel(orModel) ? null : `OPENROUTER_VISION_MODEL "${orModel}" is not a free model (must be openrouter/free or end with ":free")`,
      analyze: async ({ system, text, images, maxTokens, signal }) => {
        const data = await postJson("https://openrouter.ai/api/v1/chat/completions", {
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": "Basira",
        }, {
          model: orModel,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: [...images.map((data) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } })), { type: "text", text }] },
          ],
        }, signal);
        return String((data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content ?? "");
      },
    },
  ];
}

const usable = (p: VisionProvider) => p.configured && !p.disabledReason;

export function visionStatus(): VisionStatus {
  const ok = getVisionProviders().filter(usable);
  return {
    available: ok.length > 0,
    providers: [...new Map(ok.map((p) => [p.family, { id: p.family, label: p.label }])).values()],
    canTranscribe: ok.some((p) => p.transcribe),
  };
}

export interface Attempt {
  provider: string;
  ok: boolean;
  error?: string;
  ms: number;
}

/** Tries each usable provider until `run` succeeds or the time budget is spent. */
async function withFallback<T>(
  providers: VisionProvider[],
  timeoutMs: number,
  budgetMs: number,
  run: (p: VisionProvider, signal: AbortSignal) => Promise<T>,
): Promise<{ result: T; provider: string; attempts: Attempt[] } | { result: null; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const deadline = Date.now() + budgetMs;
  for (const p of providers) {
    if (!usable(p)) continue;
    if ((cooldownUntil.get(p.id) ?? 0) > Date.now()) {
      attempts.push({ provider: p.id, ok: false, error: "rate-limited (cooling down)", ms: 0 });
      continue;
    }
    const left = deadline - Date.now();
    if (left < 1000) {
      attempts.push({ provider: p.id, ok: false, error: "skipped: time budget used up", ms: 0 });
      continue;
    }
    const timeout = Math.min(timeoutMs, left);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const t0 = Date.now();
    try {
      const result = await run(p, ctrl.signal);
      attempts.push({ provider: p.id, ok: true, ms: Date.now() - t0 });
      return { result, provider: p.family, attempts };
    } catch (e) {
      const err = e as Error;
      if (err instanceof HttpError && (err.status === 429 || err.status === 402)) cooldownUntil.set(p.id, Date.now() + COOLDOWN_MS());
      attempts.push({ provider: p.id, ok: false, error: err.name === "AbortError" ? `timeout after ${timeout}ms` : err.message, ms: Date.now() - t0 });
    } finally {
      clearTimeout(timer);
    }
  }
  return { result: null, attempts };
}

export type AnalyzeResult =
  | { ok: true; analysis: SceneAnalysis; provider: string; attempts: Attempt[] }
  | { ok: false; attempts: Attempt[] };

export async function analyzeImage(req: VisionRequestBody): Promise<AnalyzeResult> {
  const mirrored = req.cameraFacing === "user";
  const hasMotionEvidence = !!req.previousImage;
  // The model reasons in image sides. For a webcam facing the user, "on my right" in the question
  // is the left of the image, so the words are swapped going in and out (schema.ts swaps them back).
  const question = req.question ? (mirrored ? swapSides(req.question) : req.question) : undefined;
  const text = buildUserText({
    mode: req.mode,
    cameraFacing: req.cameraFacing,
    question,
    recent: req.recent,
    history: req.history,
    previousAgeMs: hasMotionEvidence ? req.previousAgeMs : undefined,
  });
  const images = req.previousImage ? [req.image, req.previousImage] : [req.image];
  const out = await withFallback(
    getVisionProviders(),
    num(process.env.VISION_TIMEOUT_MS, 9_000),
    num(process.env.VISION_TOTAL_BUDGET_MS, 22_000),
    async (p, signal) => {
      const raw = await p.analyze({ system: VISION_SYSTEM_PROMPT, text, images, maxTokens: req.mode === "scan" ? 1200 : 2500, signal });
      // Unusable output counts as a provider failure: the next provider gets a chance, and nothing is made up.
      return sanitizeAnalysis(parseModelJson(raw), { mode: req.mode, cameraFacing: req.cameraFacing, hasMotionEvidence, question: req.question });
    },
  );
  return out.result ? { ok: true, analysis: out.result, provider: out.provider, attempts: out.attempts } : { ok: false, attempts: out.attempts };
}

export type TranscribeResult = { ok: true; text: string; attempts: Attempt[] } | { ok: false; attempts: Attempt[] };

export async function transcribeAudio(wavBase64: string): Promise<TranscribeResult> {
  const providers = getVisionProviders().filter((p) => p.transcribe);
  const out = await withFallback(providers, num(process.env.VISION_TIMEOUT_MS, 9_000), 15_000, (p, signal) => p.transcribe!(wavBase64, signal));
  return out.result !== null ? { ok: true, text: out.result.trim().slice(0, 300), attempts: out.attempts } : { ok: false, attempts: out.attempts };
}

/** For tests. */
export function resetVisionCooldowns() {
  cooldownUntil.clear();
}
