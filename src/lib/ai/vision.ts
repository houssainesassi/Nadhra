// SERVER-ONLY. Image understanding and spoken answers, with ordered provider fallback.
// To add a provider, add one entry to getVisionProviders(): callers only use this interface.
// Frames are forwarded to the provider and never stored or logged here. Models without a free tier
// are refused, so requests can't be billed.
//
// Every answer is made by the model at request time, from the frame captured for that question
// (or, with the camera off, from the question alone). Nothing is cached or prepared in advance.
import "server-only";
import { HttpError, isFreeOpenRouterModel, postJson, postSse } from "./http.ts";
import { parseModelJson, parseTranscript, remainingSpeech, sanitizeAnalysis, sanitizeChat, SentenceStreamer, swapSides } from "../assistant/schema.ts";
import { buildChatText, buildUserText, chatSystemPrompt, transcribePrompt, visionSystemPrompt } from "../assistant/prompts.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { SceneAnalysis, VisionRequestBody, VisionStatus } from "../assistant/types.ts";

export interface VisionCall {
  system: string;
  text: string;
  /** Base64 JPEGs; the first is the current view. May be empty (chat). */
  images: string[];
  maxTokens: number;
  signal: AbortSignal;
  /** JSON output (the default). False for a plain spoken answer. */
  json?: boolean;
  /** Let the model use Google Search. Only providers with `canSearch` honour it. */
  search?: boolean;
  /** When set, the answer is streamed and each new piece of text is passed here as it arrives. */
  onDelta?: (text: string) => void;
  /** Called when the answer was grounded in web search results. */
  onGrounded?: () => void;
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
  /** Can ground answers in a web search. */
  canSearch?: boolean;
  analyze(call: VisionCall): Promise<string>;
  /** Optional: speech to text, for browsers without speech recognition. */
  transcribe?(wavBase64: string, signal: AbortSignal, lang?: SpeechLang): Promise<string>;
}

const num = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const COOLDOWN_MS = () => num(process.env.AI_RATE_LIMIT_COOLDOWN_MS, 60_000);
// A key without web-search quota answers every search with 429: don't pay that delay on every question.
const SEARCH_COOLDOWN_MS = () => num(process.env.SEARCH_COOLDOWN_MS, 30 * 60_000);
const cooldownUntil = new Map<string, number>();
// "High demand" (503) can take seconds to come back. Measured Nov 2026: about 3.5 s. Skipping that
// model for a short while sends the next questions straight to one that answers.
const OVERLOAD_COOLDOWN_MS = () => num(process.env.AI_OVERLOAD_COOLDOWN_MS, 20_000);
const overloadedUntil = new Map<string, number>();
const searchCooldownUntil = new Map<string, number>();

type GeminiEvent = { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; groundingMetadata?: { groundingChunks?: unknown[]; webSearchQueries?: unknown[] } }[] };
const geminiText = (data: unknown): string => {
  const parts = (data as GeminiEvent)?.candidates?.[0]?.content?.parts ?? [];
  return parts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
};
const geminiGrounded = (data: unknown) => {
  const g = (data as GeminiEvent)?.candidates?.[0]?.groundingMetadata;
  return !!(g?.groundingChunks?.length || g?.webSearchQueries?.length);
};

export function getVisionProviders(): VisionProvider[] {
  const geminiKey = process.env.GEMINI_API_KEY ?? "";
  // Measured in Nov 2026: 3.5-flash-lite answers in 1-3 s. The others are slower, but free-tier
  // capacity is per model, so they still help when the first one reports "high demand".
  const geminiModels = (process.env.GEMINI_VISION_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash").split(",").map((m) => m.trim()).filter(Boolean);
  const orKey = process.env.OPENROUTER_API_KEY ?? "";
  const orModel = process.env.OPENROUTER_VISION_MODEL || "openrouter/free";
  // Search grounding is not in the Gemini free tier (HTTP 429 on an unbilled project). A key from a
  // billed project can be given for search only, so camera frames keep going to the free key.
  const searchKey = process.env.GEMINI_SEARCH_API_KEY || geminiKey;
  const searchOn = process.env.GEMINI_SEARCH_ENABLED !== "false" && !!searchKey;

  const gemini = geminiModels.map((model): VisionProvider => {
    const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`;
    const headers = { "x-goog-api-key": geminiKey };
    return {
      id: `gemini:${model}`,
      family: "gemini",
      label: "Google Gemini",
      model,
      configured: !!geminiKey && process.env.GEMINI_ENABLED !== "false",
      disabledReason: /pro/i.test(model) ? `Gemini vision model "${model}" looks like a Pro model, which has no free tier` : null,
      canSearch: searchOn,
      analyze: async ({ system, text, images, maxTokens, signal, json = true, search, onDelta, onGrounded }) => {
        const keyHeaders = search ? { "x-goog-api-key": searchKey } : headers;
        const body = {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [...images.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })), { text }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
          ...(search ? { tools: [{ google_search: {} }] } : {}),
        };
        if (!onDelta) {
          const data = await postJson(`${base}:generateContent`, keyHeaders, body, signal);
          if (geminiGrounded(data)) onGrounded?.();
          return geminiText(data);
        }
        let out = "";
        await postSse(`${base}:streamGenerateContent?alt=sse`, keyHeaders, body, signal, (event) => {
          const piece = geminiText(event);
          if (geminiGrounded(event)) onGrounded?.();
          if (!piece) return;
          out += piece;
          onDelta(piece);
        });
        return out;
      },
      transcribe: async (wavBase64, signal, lang) => {
        const data = await postJson(`${base}:generateContent`, headers, {
          contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: wavBase64 } }, { text: transcribePrompt(lang) }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 300, responseMimeType: "application/json" },
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
      // Not streamed: the whole answer is passed on at once, so a fallback still speaks normally.
      analyze: async ({ system, text, images, maxTokens, signal, onDelta }) => {
        const data = await postJson("https://openrouter.ai/api/v1/chat/completions", {
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": "Nadhra",
        }, {
          model: orModel,
          temperature: 0.2,
          max_tokens: maxTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: images.length ? [...images.map((data) => ({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${data}` } })), { type: "text", text }] : text },
          ],
        }, signal);
        const out = String((data as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0]?.message?.content ?? "");
        if (out) onDelta?.(out);
        return out;
      },
    },
  ];
}

const usable = (p: VisionProvider) => p.configured && !p.disabledReason;
// Search quota belongs to the key, not the model (every model got 429 together in our tests).
const searchUsable = (p: VisionProvider) => !!p.canSearch && (searchCooldownUntil.get(p.family) ?? 0) <= Date.now();

export function visionStatus(): VisionStatus {
  const ok = getVisionProviders().filter(usable);
  return {
    available: ok.length > 0,
    providers: [...new Map(ok.map((p) => [p.family, { id: p.family, label: p.label }])).values()],
    canTranscribe: ok.some((p) => p.transcribe),
    canSearch: ok.some(searchUsable),
  };
}

export interface Attempt {
  provider: string;
  ok: boolean;
  error?: string;
  ms: number;
}

interface FallbackOptions {
  timeoutMs: number;
  budgetMs: number;
  /** The caller gave up (the user asked something else): stop, and stop the upstream request. */
  signal?: AbortSignal;
  /** Part of an answer already reached the user: another provider's answer can't follow it. */
  committed?: () => boolean;
}

/**
 * Tries each usable provider until `run` succeeds or the time budget is spent. `progress` tells it a
 * streamed answer is arriving: the attempt may then use the rest of the budget, not just its timeout.
 */
async function withFallback<T>(
  providers: VisionProvider[],
  opts: FallbackOptions,
  run: (p: VisionProvider, signal: AbortSignal, progress: () => void) => Promise<T>,
): Promise<{ result: T; provider: string; attempts: Attempt[] } | { result: null; attempts: Attempt[] }> {
  const attempts: Attempt[] = [];
  const deadline = Date.now() + opts.budgetMs;
  for (const p of providers) {
    if (opts.signal?.aborted) break;
    if (!usable(p)) continue;
    if ((cooldownUntil.get(p.id) ?? 0) > Date.now()) {
      attempts.push({ provider: p.id, ok: false, error: "rate-limited (cooling down)", ms: 0 });
      continue;
    }
    // Skipped only while another provider can still answer: never leaves a question with nothing to try.
    if ((overloadedUntil.get(p.id) ?? 0) > Date.now() && providers.some((o) => o !== p && usable(o) && (cooldownUntil.get(o.id) ?? 0) <= Date.now() && (overloadedUntil.get(o.id) ?? 0) <= Date.now())) {
      attempts.push({ provider: p.id, ok: false, error: "skipped: overloaded recently", ms: 0 });
      continue;
    }
    const left = deadline - Date.now();
    if (left < 1000) {
      attempts.push({ provider: p.id, ok: false, error: "skipped: time budget used up", ms: 0 });
      continue;
    }
    const timeout = Math.min(opts.timeoutMs, left);
    const ctrl = new AbortController();
    let timer = setTimeout(() => ctrl.abort(), timeout);
    let extended = false;
    const progress = () => {
      if (extended) return;
      extended = true;
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), Math.max(1000, deadline - Date.now()));
    };
    const onOuterAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const t0 = Date.now();
    try {
      const result = await run(p, ctrl.signal, progress);
      attempts.push({ provider: p.id, ok: true, ms: Date.now() - t0 });
      return { result, provider: p.family, attempts };
    } catch (e) {
      const err = e as Error;
      if (err instanceof HttpError && (err.status === 429 || err.status === 402)) cooldownUntil.set(p.id, Date.now() + COOLDOWN_MS());
      // A model that said nothing before the timeout is as busy as one that said "high demand".
      const timedOut = err.name === "AbortError" && !opts.signal?.aborted;
      if ((err instanceof HttpError && err.status === 503) || timedOut) overloadedUntil.set(p.id, Date.now() + OVERLOAD_COOLDOWN_MS());
      // A JSON SyntaxError quotes the model's output, which can contain text read from the camera
      // image: only the kind of failure is kept, since attempts end up in the server log.
      const reason = err.name === "AbortError" ? (opts.signal?.aborted ? "cancelled" : `timeout after ${timeout}ms`) : err.name === "SyntaxError" ? "unparseable model output" : err.message;
      attempts.push({ provider: p.id, ok: false, error: reason, ms: Date.now() - t0 });
      if (opts.committed?.()) break;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  return { result: null, attempts };
}

/**
 * Runs one model call with web search when the provider can, and without it when the search is
 * refused (a key without search quota): the question still gets an answer, which then says it
 * couldn't check live information.
 */
async function callWithOptionalSearch(p: VisionProvider, call: Omit<VisionCall, "search" | "system">, system: (search: boolean) => string, wantSearch: boolean): Promise<{ raw: string; grounded: boolean }> {
  let grounded = false;
  const onGrounded = () => (grounded = true);
  if (wantSearch && searchUsable(p)) {
    try {
      const raw = await p.analyze({ ...call, system: system(true), search: true, onGrounded });
      return { raw, grounded };
    } catch (e) {
      const err = e as Error;
      if (!(err instanceof HttpError) || ![400, 403, 429].includes(err.status)) throw err;
      searchCooldownUntil.set(p.family, Date.now() + SEARCH_COOLDOWN_MS());
      console.warn(`[vision] web search unavailable on ${p.id} (HTTP ${err.status}); answering without it`);
    }
  }
  const raw = await p.analyze({ ...call, system: system(false), onGrounded });
  return { raw, grounded };
}

export type AnalyzeResult =
  | { ok: true; analysis: SceneAnalysis; provider: string; attempts: Attempt[]; sent: string[] }
  | { ok: false; attempts: Attempt[]; sent: string[] };

export interface AnswerOptions {
  /** Aborted when the client goes away or asks something else. */
  signal?: AbortSignal;
  /** Streams the answer: each sentence that is safe to speak early is passed here, in order. */
  onSentence?: (text: string) => void;
  now?: Date;
  /** Filled in as the answer arrives: when the model's first text came, for latency measurements. */
  clock?: { firstTokenAt?: number };
}

/** Called with each piece of streamed model text: notes the first one, and passes on finished sentences. */
function sentenceSink(opts: AnswerOptions, streamer: SentenceStreamer | null, sent: string[], progress: () => void) {
  if (!streamer) return undefined;
  return (delta: string) => {
    progress();
    if (opts.clock && opts.clock.firstTokenAt === undefined) opts.clock.firstTokenAt = Date.now();
    for (const s of streamer.push(delta)) {
      sent.push(s);
      opts.onSentence?.(s);
    }
  };
}

const timeouts = () => ({ timeoutMs: num(process.env.VISION_TIMEOUT_MS, 9_000), budgetMs: num(process.env.VISION_TOTAL_BUDGET_MS, 22_000) });

export async function analyzeImage(req: VisionRequestBody, opts: AnswerOptions = {}): Promise<AnalyzeResult> {
  if (req.mode === "chat" || !req.image) return answerChat(req, opts);
  const started = Date.now();
  const now = opts.now ?? new Date();
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
    lang: req.lang,
    now: req.mode === "question" ? now : undefined,
  });
  const system = visionSystemPrompt(req.lang);
  const images = req.previousImage ? [req.image, req.previousImage] : [req.image];
  // A question that needs live information is answered by a web search instead, when one is possible.
  const webPossible = req.mode === "question" && visionStatus().canSearch === true;
  const sent: string[] = [];
  const out = await withFallback(getVisionProviders(), { ...timeouts(), signal: opts.signal, committed: () => sent.length > 0 }, async (p, signal, progress) => {
    const streamer = opts.onSentence ? new SentenceStreamer({ mode: req.mode, cameraFacing: req.cameraFacing, question: req.question, holdAll: (raw) => webPossible && /"needs_web"\s*:\s*true/.test(raw) }) : null;
    const raw = await p.analyze({
      system,
      text,
      images,
      maxTokens: req.mode === "scan" ? 1200 : 2500,
      signal,
      onDelta: sentenceSink(opts, streamer, sent, progress),
    });
    // Unusable output counts as a provider failure: the next provider gets a chance, and nothing is made up.
    const parsed = parseModelJson(raw);
    return { analysis: sanitizeAnalysis(parsed, { mode: req.mode, cameraFacing: req.cameraFacing, hasMotionEvidence, question: req.question, lang: req.lang }), needsWeb: parsed.needs_web === true };
  });
  if (!out.result) return { ok: false, attempts: out.attempts, sent };

  let analysis = out.result.analysis;
  const left = timeouts().budgetMs - (Date.now() - started);
  if (out.result.needsWeb && webPossible && sent.length === 0 && left > 3_000 && !opts.signal?.aborted) {
    // What the camera showed stays (detections, texts, hazards); the spoken answer comes from the web.
    // The search model gets what the picture showed (the analysis, not the image), so "the price of
    // this" is about the product actually in front of the camera.
    const scene = [analysis.spoken, ...analysis.texts.map((t) => `text: ${t.content}`), ...analysis.detections.map((d) => d.label)].filter(Boolean).join("; ");
    const web = await answerChat({ ...req, mode: "chat" }, { ...opts, now }, { cameraOn: true, budgetMs: left, scene });
    sent.push(...web.sent);
    if (web.ok && !web.analysis.needsCamera) analysis = { ...analysis, spoken: web.analysis.spoken, usedWeb: web.analysis.usedWeb };
    else if (web.sent.length) return { ok: false, attempts: [...out.attempts, ...web.attempts], sent };
    // Otherwise the picture's own answer stands: it says live information couldn't be checked.
  }
  return { ok: true, analysis, provider: out.provider, attempts: out.attempts, sent };
}

/** A question without a picture: the camera is off, or the question needs the web, not the camera. */
export async function answerChat(req: VisionRequestBody, opts: AnswerOptions = {}, extra: { cameraOn?: boolean; budgetMs?: number; scene?: string } = {}): Promise<AnalyzeResult> {
  const question = (req.question ?? "").trim();
  const now = opts.now ?? new Date();
  const text = buildChatText({ question, history: req.history, now, scene: extra.scene });
  const sent: string[] = [];
  const out = await withFallback(getVisionProviders(), { ...timeouts(), ...(extra.budgetMs ? { budgetMs: extra.budgetMs } : {}), signal: opts.signal, committed: () => sent.length > 0 }, async (p, signal, progress) => {
    const streamer = opts.onSentence ? new SentenceStreamer({ mode: "chat", cameraFacing: req.cameraFacing, question }) : null;
    const { raw, grounded } = await callWithOptionalSearch(p, {
      text,
      images: [],
      maxTokens: 1500,
      signal,
      json: false,
      onDelta: sentenceSink(opts, streamer, sent, progress),
    }, (search) => chatSystemPrompt(req.lang, { search, cameraOn: extra.cameraOn }), true);
    return sanitizeChat(raw, { question, lang: req.lang, usedWeb: grounded });
  });
  return out.result ? { ok: true, analysis: out.result, provider: out.provider, attempts: out.attempts, sent } : { ok: false, attempts: out.attempts, sent };
}

/** The part of a streamed answer that wasn't sent sentence by sentence: the rest, or a caveat. */
export const restOfAnswer = (analysis: SceneAnalysis, sent: string[]) => remainingSpeech(analysis.spoken, sent);

export type TranscribeResult = { ok: true; text: string; attempts: Attempt[] } | { ok: false; attempts: Attempt[] };

export async function transcribeAudio(wavBase64: string, lang: SpeechLang = "tn"): Promise<TranscribeResult> {
  const providers = getVisionProviders().filter((p) => p.transcribe);
  const out = await withFallback(providers, { timeoutMs: num(process.env.VISION_TIMEOUT_MS, 9_000), budgetMs: 15_000 }, async (p, signal) => parseTranscript(await p.transcribe!(wavBase64, signal, lang)));
  return out.result !== null ? { ok: true, text: out.result, attempts: out.attempts } : { ok: false, attempts: out.attempts };
}

/** For tests. */
export function resetVisionCooldowns() {
  cooldownUntil.clear();
  overloadedUntil.clear();
  searchCooldownUntil.clear();
}
