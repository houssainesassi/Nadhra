// Relative imports (not "@/") so the route can be unit-tested with plain Node (tests/visionRoute.test.ts).
import { analyzeImage, refusalFor, restOfAnswer, taskOf, visionStatus, type AnalyzeResult, type Attempt } from "../../../lib/ai/vision.ts";
import { readJsonBody } from "../../../lib/server/http.ts";
import { allowSearch, charge, checkRequest, type RequestContext } from "../../../lib/server/guard.ts";
import { record } from "../../../lib/server/monitor.ts";
import type { CameraFacing, DocumentContext, VisionMode, VisionRequestBody, VisionStreamEvent } from "../../../lib/assistant/types.ts";
import { DOC_KINDS, MAX_CONTEXT_LINES } from "../../../lib/assistant/document.ts";
import { isSpeechLang } from "../../../lib/assistant/lang.ts";
import { requestedFamily } from "../../../lib/ai/router.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The provider chain stops after VISION_TOTAL_BUDGET_MS (22 s by default).
export const maxDuration = 30;

// Under Vercel's 4.5 MB request limit. A reading sends two frames, together up to about 4 MB of base64.
const MAX_BODY_BYTES = 4.2 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 2 * 1024 * 1024;
const MAX_QUESTION_CHARS = 300;
const MAX_NOTE_CHARS = 500;
const NO_STORE = { "Cache-Control": "no-store" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** Base64 that decodes to a JPEG. Only the start is decoded: the whole image is the provider's job. */
function isJpegBase64(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 16 || v.length > MAX_IMAGE_BASE64) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  const head = Buffer.from(v.slice(0, 8), "base64");
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

const MAX_CONTEXT_LINE = 300;

/** A document read earlier, sent back with a follow-up question. Anything malformed is dropped. */
function documentContext(v: unknown): DocumentContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const d = v as Record<string, unknown>;
  if (!DOC_KINDS.includes(d.kind as DocumentContext["kind"]) || !Array.isArray(d.lines)) return undefined;
  const lines = d.lines.filter((l): l is string => typeof l === "string" && !!l.trim()).map((l) => l.slice(0, MAX_CONTEXT_LINE)).slice(0, MAX_CONTEXT_LINES);
  return lines.length ? { kind: d.kind as DocumentContext["kind"], lines } : undefined;
}

const shortStrings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, MAX_NOTE_CHARS)).slice(-max) : [];

export function GET() {
  return json(visionStatus());
}

export async function POST(req: Request) {
  const ctx = checkRequest(req, "vision");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);
  const raw = body.value && typeof body.value === "object" ? body.value : {};

  // Nadhra AI selected: handled only by local engines, never by Gemini or another cloud provider.
  // None is connected yet (N1), so the request is refused here, before any budget or network call,
  // and nothing in it is read further.
  if (requestedFamily(raw.provider) === "nadhra") {
    record("vision.refused", "nadhra-unavailable");
    return json({ error: "nadhra-unavailable" }, 503);
  }

  const mode: VisionMode = raw.mode === "question" ? "question" : raw.mode === "chat" ? "chat" : raw.mode === "read" ? "read" : "scan";
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  // A follow-up question about a document read earlier may come without a new picture.
  const document = mode === "read" ? documentContext(raw.document) : undefined;
  const imageOptional = mode === "chat" || (mode === "read" && !!document && !!question && raw.image === undefined);
  // Chat is a question asked with the camera off: no image is sent, and none is accepted.
  if (!imageOptional && !isJpegBase64(raw.image)) return json({ error: "image must be a base64 JPEG" }, 400);
  if ((mode === "question" || mode === "chat") && !question) return json({ error: "question required" }, 400);
  if (question.length > MAX_QUESTION_CHARS) return json({ error: "question too long" }, 400);
  const cameraFacing: CameraFacing = raw.cameraFacing === "user" ? "user" : "outward";
  const previousAgeMs = typeof raw.previousAgeMs === "number" && raw.previousAgeMs > 0 && raw.previousAgeMs < 30_000 ? raw.previousAgeMs : undefined;

  const request: VisionRequestBody = {
    mode,
    image: mode === "chat" || (imageOptional && raw.image === undefined) ? undefined : (raw.image as string),
    // An invalid second frame is ignored rather than refused: it only means no motion claims.
    previousImage: (mode === "question" || mode === "scan") && isJpegBase64(raw.previousImage) && previousAgeMs ? raw.previousImage : undefined,
    previousAgeMs,
    cameraFacing,
    lang: isSpeechLang(raw.lang) ? raw.lang : "tn",
    question: question || undefined,
    recent: shortStrings(raw.recent, 4),
    history: Array.isArray(raw.history)
      ? raw.history
          .filter((h): h is { q: string; a: string } => !!h && typeof h.q === "string" && typeof h.a === "string")
          .map((h) => ({ q: h.q.slice(0, MAX_NOTE_CHARS), a: h.a.slice(0, MAX_NOTE_CHARS) }))
          .slice(-3)
      : [],
    ...(document ? { document } : {}),
    // Read mode: the frame for the independent second reading. An invalid one only means no second reading.
    ...(mode === "read" && isJpegBase64(raw.secondImage) && isJpegBase64(raw.image) ? { secondImage: raw.secondImage } : {}),
  };

  // Offline mode (or hybrid without internet) and nothing on the device can do this: said as such,
  // before any budget is counted. Never answered by an engine that doesn't declare the task.
  const refusal = refusalFor(taskOf(request));
  if (refusal) {
    record("vision.refused", refusal);
    return json({ error: refusal }, 503);
  }
  if (!visionStatus().available) return json({ error: "not-configured" }, 503);
  const limited = await charge(ctx, "vision");
  if (limited) return limited;
  record("vision.request", mode);

  const t0 = Date.now();
  // The user asked something else, or closed the page: the model call stops too.
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const search = searchGate(ctx);
  // Readings are checked as a whole before anything is said (document.ts), so they are never streamed.
  if (raw.stream === true && (mode === "question" || mode === "chat")) return streamAnswer(request, abort, t0, search);

  const result = await analyzeImage(request, { signal: abort.signal, allowSearch: search });
  logFailures(result.attempts);
  if (!result.ok) return failure(result);
  return json({ analysis: result.analysis, provider: result.provider, latencyMs: Date.now() - t0 });
}

/** Web search is the only billed call: it has its own daily budget, counted only when it runs. */
const searchGate = (ctx: RequestContext) => () => allowSearch(ctx);

/** Everything failed. Say so: the client tells the user, and no description is made up. */
function failure(result: AnalyzeResult) {
  if (!result.ok && result.refusal) return json({ error: result.refusal }, 503);
  const limited = result.attempts.length > 0 && result.attempts.every((a) => /cooling down|HTTP 429|HTTP 402/.test(a.error ?? ""));
  record("vision.failed", limited ? "rate-limited" : "ai-unavailable", "warn");
  return limited ? json({ error: "rate-limited" }, 503, { "Retry-After": "30" }) : json({ error: "ai-unavailable" }, 503);
}

/**
 * The answer as server-sent events, one sentence at a time while the model writes it. The response
 * starts only with the first sentence (or the whole answer): if every provider fails before that,
 * the client gets the same JSON errors as without streaming.
 */
async function streamAnswer(request: VisionRequestBody, abort: AbortController, t0: number, search: () => Promise<boolean>): Promise<Response> {
  const encoder = new TextEncoder();
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  const pending: Uint8Array[] = [];
  let firstSentence!: () => void;
  const started = new Promise<"sentence">((resolve) => (firstSentence = () => resolve("sentence")));
  const send = (event: VisionStreamEvent) => {
    const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    if (!sink) return void pending.push(bytes);
    try {
      sink.enqueue(bytes);
    } catch {} // the client has gone
  };

  const clock: { firstTokenAt?: number } = {};
  let firstSentenceAt: number | undefined;
  const since = (at?: number) => (at === undefined ? undefined : at - t0);
  const work = analyzeImage(request, {
    signal: abort.signal,
    allowSearch: search,
    clock,
    onSentence: (text) => {
      firstSentenceAt ??= Date.now();
      send({ type: "sentence", text });
      firstSentence();
    },
  }).then((result) => {
    logFailures(result.attempts);
    return result;
  });

  const first = await Promise.race([started, work]);
  if (first !== "sentence" && !first.ok) return failure(first);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
      for (const bytes of pending.splice(0)) controller.enqueue(bytes);
      void work
        .then((result) => {
          if (result.ok) {
            const totalMs = Date.now() - t0;
            const timing = { firstTokenMs: since(clock.firstTokenAt), firstSentenceMs: since(firstSentenceAt), totalMs };
            send({ type: "done", analysis: result.analysis, provider: result.provider, latencyMs: totalMs, timing, rest: restOfAnswer(result.analysis, result.sent) });
          }
          // Part of the answer was already spoken: the client says it was cut off.
          else send({ type: "error", error: "interrupted" });
        })
        .catch(() => send({ type: "error", error: "interrupted" }))
        .finally(() => {
          try {
            controller.close();
          } catch {}
        });
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { ...NO_STORE, "Cache-Control": "no-store, no-transform", "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" },
  });
}

/** Server log only, and never content: the HTTP status, or the reason before ":" (drops response bodies). */
function logFailures(attempts: Attempt[]) {
  for (const a of attempts) {
    // A question replaced by a newer one isn't a failure.
    if (!a.ok && a.error !== "cancelled" && !a.error?.startsWith("skipped")) console.warn(`[vision] ${a.provider} failed: ${(a.error?.match(/^HTTP \d+/)?.[0] ?? a.error?.split(":")[0] ?? "").slice(0, 80)}`);
  }
}
