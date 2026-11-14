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
import { buildChatText, buildLocateText, buildReadText, buildUserText, chatSystemPrompt, LOCATE_SYSTEM_PROMPT, readSystemPrompt, transcribePrompt, visionSystemPrompt } from "../assistant/prompts.ts";
import { isMedicalQuestion, sanitizeDocument } from "../assistant/document.ts";
import { inspectLine, parseBox, toGray, type GrayImage } from "../assistant/lineCheck.ts";
import jpeg from "jpeg-js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { speech } from "../assistant/phrases.ts";
import { internetForRouting } from "../server/deviceCapabilities.ts";
import { AI_TASKS, aiMode, nadhraOffered, nadhraTasks, routeProviders, routeRefusal, type AiTask, type Locality, type RouteContext, type RouteRefusal, type TaskSupport } from "./router.ts";
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
  /** 0.2 by default. Reading uses 0: a transcription has one right answer. */
  temperature?: number;
}

export interface VisionProvider {
  /** Unique per model: a rate limit or outage on one model doesn't affect the others. */
  id: string;
  /** The service, as reported to the browser. */
  family: string;
  /** Who receives the images. Shown to the user in the privacy notice. */
  label: string;
  model: string;
  /** Where the data goes: "cloud" sends it over the internet to `label`, "local" keeps it on the device. */
  locality: Locality;
  /** The only tasks the router will give this provider (router.ts). */
  tasks: Partial<Record<AiTask, TaskSupport>>;
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
      locality: "cloud",
      tasks: { scan: "full", question: "full", chat: "full", read: "full", transcribe: "full" },
      configured: !!geminiKey && process.env.GEMINI_ENABLED !== "false",
      disabledReason: /pro/i.test(model) ? `Gemini vision model "${model}" looks like a Pro model, which has no free tier` : null,
      canSearch: searchOn,
      analyze: async ({ system, text, images, maxTokens, signal, json = true, search, onDelta, onGrounded, temperature = 0.2 }) => {
        const keyHeaders = search ? { "x-goog-api-key": searchKey } : headers;
        const body = {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [...images.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } })), { text }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens, ...(json ? { responseMimeType: "application/json" } : {}) },
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
      locality: "cloud",
      // No "read": documents never go to OpenRouter (see readDocument). No transcribe method either.
      tasks: { scan: "full", question: "full", chat: "full" },
      configured: !!orKey,
      disabledReason: isFreeOpenRouterModel(orModel) ? null : `OPENROUTER_VISION_MODEL "${orModel}" is not a free model (must be openrouter/free or end with ":free")`,
      // Not streamed: the whole answer is passed on at once, so a fallback still speaks normally.
      analyze: async ({ system, text, images, maxTokens, signal, onDelta, temperature = 0.2 }) => {
        const data = await postJson("https://openrouter.ai/api/v1/chat/completions", {
          Authorization: `Bearer ${orKey}`,
          "HTTP-Referer": process.env.APP_URL || "http://localhost:3000",
          "X-Title": "Nadhra",
        }, {
          model: orModel,
          temperature,
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

/** AI_MODE and what is known about the internet (probed in hybrid mode only), for routing. */
/** `probe: false` (the status request): never starts an opt-in probe, only reads what is known. */
function routeContext({ probe = true }: { probe?: boolean } = {}): RouteContext {
  const mode = aiMode();
  return { mode, internet: internetForRouting(mode, Date.now(), { probe }) };
}

/** The providers that may do `task`, in the order to try them (router.ts). */
export function providersFor(task: AiTask): VisionProvider[] {
  return routeProviders(getVisionProviders(), task, routeContext());
}

/**
 * "offline-mode" or "no-internet" when the mode or the connection rules `task` out (nothing local can
 * do it), so the user hears that reason instead of "the service is down". null otherwise.
 */
export function refusalFor(task: AiTask): RouteRefusal | null {
  return routeRefusal(getVisionProviders().filter(usable), task, routeContext());
}

/**
 * For /api/health: per task, the providers the current mode would try (in order), where each runs,
 * and why a task would be refused. Ids only, no keys.
 */
export function capabilitySummary(): { mode: string; tasks: Record<AiTask, { providers: { id: string; locality: Locality; support: TaskSupport }[]; refusal: RouteRefusal | null }> } {
  const ctx = routeContext();
  const ok = getVisionProviders().filter(usable);
  const tasks = Object.fromEntries(AI_TASKS.map((t) => [t, {
    providers: routeProviders(ok, t, ctx).map((p) => ({ id: p.id, locality: p.locality, support: p.tasks[t]! })),
    refusal: routeRefusal(ok, t, ctx),
  }])) as ReturnType<typeof capabilitySummary>["tasks"];
  return { mode: ctx.mode, tasks };
}

/** The task a request needs. A medicine question is read under the reading rules, or answered without a picture. */
export function taskOf(req: Pick<VisionRequestBody, "mode" | "image" | "question">): AiTask {
  if ((req.mode === "question" || req.mode === "chat") && isMedicalQuestion(req.question ?? "")) return req.image ? "read" : "chat";
  if (req.mode === "read") return "read";
  if (req.mode === "chat" || !req.image) return "chat";
  return req.mode === "scan" ? "scan" : "question";
}
// Search quota belongs to the key, not the model (every model got 429 together in our tests).
const searchUsable = (p: VisionProvider) => !!p.canSearch && (searchCooldownUntil.get(p.family) ?? 0) <= Date.now();

export function visionStatus(): VisionStatus {
  const ctx = routeContext({ probe: false });
  // Only providers the current mode may use: in offline mode no company is listed as a recipient.
  const ok = getVisionProviders().filter(usable).filter((p) => AI_TASKS.some((t) => routeProviders([p], t, ctx).length > 0));
  return {
    // Only when it isn't the default, so the cloud status stays exactly what it was.
    ...(ctx.mode !== "cloud" ? { mode: ctx.mode } : {}),
    available: ok.length > 0,
    providers: [...new Map(ok.map((p) => [p.family, { id: p.family, label: p.label }])).values()],
    canTranscribe: ok.some((p) => p.transcribe && routeProviders([p], "transcribe", ctx).length > 0),
    canSearch: ok.some(searchUsable),
    // Only when this server offers Nadhra AI: the default status stays exactly what it was.
    ...(nadhraOffered() ? { nadhra: { experimental: true as const, tasks: nadhraTasks() } } : {}),
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
async function callWithOptionalSearch(p: VisionProvider, call: Omit<VisionCall, "search" | "system">, system: (search: boolean) => string, wantSearch: boolean, allow?: () => Promise<boolean>): Promise<{ raw: string; grounded: boolean }> {
  let grounded = false;
  const onGrounded = () => (grounded = true);
  // The daily search budget is checked last, so it is only counted when a search really runs.
  if (wantSearch && searchUsable(p) && (!allow || (await allow()))) {
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
  | { ok: false; attempts: Attempt[]; sent: string[]; refusal?: RouteRefusal };

export interface AnswerOptions {
  /** Aborted when the client goes away or asks something else. */
  signal?: AbortSignal;
  /** Streams the answer: each sentence that is safe to speak early is passed here, in order. */
  onSentence?: (text: string) => void;
  now?: Date;
  /** Filled in as the answer arrives: when the model's first text came, for latency measurements. */
  clock?: { firstTokenAt?: number };
  /** Asked right before a web search: false (daily search budget spent) answers without one. */
  allowSearch?: () => Promise<boolean>;
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
  const refusal = refusalFor(taskOf(req));
  if (refusal) return { ok: false, attempts: [], sent: [], refusal };
  if (req.mode === "read") return readDocument(req, opts);
  // A question about medicines never gets an ordinary answer: with a picture it is read under the
  // reading rules (one frame only, so no dose or date can be confirmed), without one it is declined.
  if ((req.mode === "question" || req.mode === "chat") && isMedicalQuestion(req.question ?? "")) {
    if (req.image) return readDocument({ ...req, mode: "read", previousImage: undefined, previousAgeMs: undefined }, opts);
    const declined = speech(req.lang ?? "tn").doc.medicalDeclined;
    return { ok: true, analysis: { spoken: declined, changed: true, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false }, provider: "none", attempts: [], sent: [] };
  }
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
  const out = await withFallback(providersFor(req.mode === "scan" ? "scan" : "question"), { ...timeouts(), signal: opts.signal, committed: () => sent.length > 0 }, async (p, signal, progress) => {
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

/**
 * Reads a document or package, or answers a question about one read earlier (`req.document`, then
 * the image is optional). Not streamed: what is said is assembled and checked from the whole
 * transcription (document.ts), so no sentence can be spoken before its checks.
 */
async function readDocument(req: VisionRequestBody, opts: AnswerOptions): Promise<AnalyzeResult> {
  const now = opts.now ?? new Date();
  const lang = req.lang ?? "tn";
  const text = buildReadText({ question: req.question, document: req.document, hasImage: !!req.image, now });
  const t = timeouts();
  // A full page of text takes longer to write out than a scene description (about 3 s on the fast
  // models, measured Nov 2026). An attempt that takes longer is usually a busy model: better to
  // move on to the next one while the overall budget still allows it.
  const limits = { timeoutMs: Math.max(t.timeoutMs, num(process.env.READ_TIMEOUT_MS, 10_000)), budgetMs: t.budgetMs, signal: opts.signal };
  // Documents go to Gemini only: OpenRouter's free routing passes images on to providers whose
  // handling of them is unknown, which is not acceptable for prescriptions and medicine boxes.
  const gemini = providersFor("read").filter((p) => p.family === "gemini");
  const read = (image: string | undefined) => async (p: VisionProvider, signal: AbortSignal) =>
    parseModelJson(await p.analyze({ system: readSystemPrompt(lang), text, images: image ? [image] : [], maxTokens: 4000, signal, temperature: 0 }));
  // The second reading: another frame, at the same time as the first, starting from another model
  // when there is one, then falling back to the first model before the slow ones (gemini-3.5-flash
  // took 13-14 s for a prescription in Nov 2026). It decides only whether the numbers of a medical
  // paper may be said (document.ts); if it fails, they aren't.
  const secondOrder = gemini.length > 1 ? [gemini[1], gemini[0], ...gemini.slice(2)] : gemini;
  // The model whose line boxes are accurate (gemini-3.1-flash-lite: 98 % of lines placed well, against
  // 84 % for gemini-3.5-flash-lite, e2e/read/boxvariants.ts) locates the first reading's lines in the
  // first frame, as soon as that reading is in. It only says where each line is: the text, the
  // second reading and every check stay as they are (document.ts, checkFirst).
  const locator = gemini.find((p) => p.model === process.env.READ_LOCATE_MODEL) ?? gemini[1];
  const firstP = withFallback(gemini, limits, read(req.image));
  const locateP = firstP.then(async (f) => {
    const lines = Array.isArray(f.result?.lines) ? (f.result!.lines as Record<string, unknown>[]) : [];
    // Not needed when the first reading came from the locating model itself, or there is nothing to place.
    if (!req.image || !locator || !lines.length || f.attempts.some((a) => a.ok && a.provider === locator.id)) return null;
    return withFallback([locator], limits, async (p, signal) =>
      parseModelJson(await p.analyze({ system: LOCATE_SYSTEM_PROMPT, text: buildLocateText(lines.map((l) => String(l.text ?? ""))), images: [req.image!], maxTokens: 2000, signal, temperature: 0 })));
  });
  const [first, second, located] = await Promise.all([
    firstP,
    req.image && req.secondImage ? withFallback(secondOrder, limits, read(req.secondImage)) : Promise.resolve(null),
    locateP,
  ]);
  const attempts = [...first.attempts, ...(second?.attempts ?? []), ...(located?.attempts ?? [])];
  if (first.result && located?.result) first.result = withLocatedBoxes(first.result, located.result);
  if (!first.result) return { ok: false, attempts, sent: [] };
  try {
    // With a new picture, a missing second reading is null: numbers on a medical paper then can't be said.
    const frameA = lazyGray(req.image);
    const frameB = lazyGray(req.secondImage);
    const inspect = (frame: () => GrayImage | null) => (box: unknown, text: string) => {
      const img = frame();
      return img ? inspectLine(img, box, text) : "no-box";
    };
    const analysis = sanitizeDocument(first.result, {
      lang, question: req.question, context: req.document, now,
      confirm: req.image ? (second?.result ?? null) : undefined,
      inspect: { first: inspect(frameA), second: inspect(frameB) },
    });
    captureReading(req, first.result, second?.result ?? null, analysis);
    return { ok: true, analysis, provider: first.provider, attempts, sent: [] };
  } catch {
    return { ok: false, attempts, sent: [] };
  }
}

/**
 * The locating model's answer, put on the first reading's lines as `located_box`: a box, or null
 * when it gave null (not fully visible) or nothing usable for that line. If its answer has no usable
 * "boxes" list at all, the reading is left as it was (the first reading's own boxes are used).
 */
export function withLocatedBoxes(reading: Record<string, unknown>, locate: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(locate.boxes) || !Array.isArray(reading.lines)) return reading;
  const byIndex = new Map<number, unknown>();
  for (const b of locate.boxes as Record<string, unknown>[]) if (b && typeof b.i === "number") byIndex.set(b.i, b.box_2d ?? null);
  const lines = reading.lines as Record<string, unknown>[];
  const boxes = lines.map((_, i) => parseBox(byIndex.get(i)));
  // Two different lines placed in the same spot: at least one placement is wrong, so neither counts.
  const clash = boxes.map((b, i) => !!b && boxes.some((o, j) => j !== i && !!o && overlap(b, o) > 0.5));
  return { ...reading, lines: lines.map((l, i) => ({ ...l, located_box: boxes[i] && !clash[i] ? boxes[i] : null })) };
}

/** Intersection over the smaller box, for [ymin, xmin, ymax, xmax] boxes. */
function overlap(a: number[], b: number[]): number {
  const h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (h <= 0 || w <= 0) return 0;
  const area = (x: number[]) => (x[2] - x[0]) * (x[3] - x[1]);
  return (h * w) / Math.min(area(a), area(b));
}

/**
 * TESTING ONLY, for the real-camera sessions with synthetic documents (docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md):
 * with READ_CAPTURE_DIR set on a local server, each reading's two frames, both raw readings and the
 * result are saved there, so the session can be scored afterwards without new requests. Never on
 * Vercel (refused), off unless set, and only ever for mock documents: it stores what the camera saw.
 */
const captureDir = () => (process.env.READ_CAPTURE_DIR && !process.env.VERCEL ? process.env.READ_CAPTURE_DIR : null);
let captureWarned = false;
function captureReading(req: VisionRequestBody, first: unknown, second: unknown, analysis: unknown) {
  const dir = captureDir();
  if (!dir) return;
  if (!captureWarned) {
    captureWarned = true;
    console.warn(`[vision] READ_CAPTURE_DIR is set: readings are saved to ${dir}. Testing with synthetic documents only.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  void (async () => {
    try {
      await mkdir(dir, { recursive: true });
      if (req.image) await writeFile(join(dir, `${stamp}_a.jpg`), Buffer.from(req.image, "base64"));
      if (req.secondImage) await writeFile(join(dir, `${stamp}_b.jpg`), Buffer.from(req.secondImage, "base64"));
      await writeFile(join(dir, `${stamp}.json`), JSON.stringify({ at: new Date().toISOString(), lang: req.lang, question: req.question ?? null, document: req.document ?? null, first, second, analysis }, null, 1));
    } catch (e) {
      console.warn("[vision] capture failed:", (e as Error).message);
    }
  })();
}

/**
 * A frame as brightness, for the pixel check of printed lines, or null if it can't be decoded
 * (then no line of a medical paper can be checked, so none is read). Decoded once, when first needed.
 */
function lazyGray(base64: string | undefined): () => GrayImage | null {
  let done = false;
  let img: GrayImage | null = null;
  return () => {
    if (done) return img;
    done = true;
    if (!base64) return null;
    try {
      const d = jpeg.decode(Buffer.from(base64, "base64"), { useTArray: true, maxMemoryUsageInMB: 256, maxResolutionInMP: 30 });
      img = toGray(d.data, d.width, d.height);
    } catch {
      img = null;
    }
    return img;
  };
}

/** A question without a picture: the camera is off, or the question needs the web, not the camera. */
export async function answerChat(req: VisionRequestBody, opts: AnswerOptions = {}, extra: { cameraOn?: boolean; budgetMs?: number; scene?: string } = {}): Promise<AnalyzeResult> {
  const question = (req.question ?? "").trim();
  const now = opts.now ?? new Date();
  const text = buildChatText({ question, history: req.history, now, scene: extra.scene });
  const sent: string[] = [];
  const out = await withFallback(providersFor("chat"), { ...timeouts(), ...(extra.budgetMs ? { budgetMs: extra.budgetMs } : {}), signal: opts.signal, committed: () => sent.length > 0 }, async (p, signal, progress) => {
    const streamer = opts.onSentence ? new SentenceStreamer({ mode: "chat", cameraFacing: req.cameraFacing, question }) : null;
    const { raw, grounded } = await callWithOptionalSearch(p, {
      text,
      images: [],
      maxTokens: 1500,
      signal,
      json: false,
      onDelta: sentenceSink(opts, streamer, sent, progress),
    }, (search) => chatSystemPrompt(req.lang, { search, cameraOn: extra.cameraOn }), true, opts.allowSearch);
    return sanitizeChat(raw, { question, lang: req.lang, usedWeb: grounded });
  });
  return out.result ? { ok: true, analysis: out.result, provider: out.provider, attempts: out.attempts, sent } : { ok: false, attempts: out.attempts, sent };
}

/** The part of a streamed answer that wasn't sent sentence by sentence: the rest, or a caveat. */
export const restOfAnswer = (analysis: SceneAnalysis, sent: string[]) => remainingSpeech(analysis.spoken, sent);

export type TranscribeResult = { ok: true; text: string; attempts: Attempt[] } | { ok: false; attempts: Attempt[]; refusal?: RouteRefusal };

/** `signal`: the page's request. Once it is aborted, no further provider is tried (no fallback). */
export async function transcribeAudio(wavBase64: string, lang: SpeechLang = "tn", { signal }: { signal?: AbortSignal } = {}): Promise<TranscribeResult> {
  const refusal = refusalFor("transcribe");
  if (refusal) return { ok: false, attempts: [], refusal };
  const providers = providersFor("transcribe").filter((p) => p.transcribe);
  const out = await withFallback(providers, { timeoutMs: num(process.env.VISION_TIMEOUT_MS, 9_000), budgetMs: 15_000, signal }, async (p, s) => parseTranscript(await p.transcribe!(wavBase64, s, lang)));
  return out.result !== null ? { ok: true, text: out.result, attempts: out.attempts } : { ok: false, attempts: out.attempts };
}

/** For tests. */
export function resetVisionCooldowns() {
  cooldownUntil.clear();
  overloadedUntil.clear();
  searchCooldownUntil.clear();
}
