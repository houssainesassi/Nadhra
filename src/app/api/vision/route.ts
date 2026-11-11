// Relative imports (not "@/") so the route can be unit-tested with plain Node (tests/visionRoute.test.ts).
import { analyzeImage, restOfAnswer, visionStatus, type AnalyzeResult, type Attempt } from "../../../lib/ai/vision.ts";
import { clientKey, isSameOrigin, RateLimiter, readJsonBody } from "../../../lib/server/http.ts";
import type { CameraFacing, VisionMode, VisionRequestBody, VisionStreamEvent } from "../../../lib/assistant/types.ts";
import { isSpeechLang } from "../../../lib/assistant/lang.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The provider chain stops after VISION_TOTAL_BUDGET_MS (22 s by default).
export const maxDuration = 30;

// Well under Vercel's 4.5 MB request limit. The browser sends frames far smaller than this.
const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_BASE64 = 2 * 1024 * 1024;
const MAX_QUESTION_CHARS = 300;
const MAX_NOTE_CHARS = 500;
const NO_STORE = { "Cache-Control": "no-store" };

const limiter = new RateLimiter(Number(process.env.VISION_RATE_LIMIT_PER_MIN) || 40);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

/** Base64 that decodes to a JPEG. Only the start is decoded: the whole image is the provider's job. */
function isJpegBase64(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 16 || v.length > MAX_IMAGE_BASE64) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return false;
  const head = Buffer.from(v.slice(0, 8), "base64");
  return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
}

const shortStrings = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").map((s) => s.slice(0, MAX_NOTE_CHARS)).slice(-max) : [];

export function GET() {
  return json(visionStatus());
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: "forbidden" }, 403);
  const body = await readJsonBody<Record<string, unknown>>(req, MAX_BODY_BYTES);
  if (!body.ok) return json({ error: body.error }, body.status);
  const raw = body.value && typeof body.value === "object" ? body.value : {};

  const mode: VisionMode = raw.mode === "question" ? "question" : raw.mode === "chat" ? "chat" : "scan";
  // Chat is a question asked with the camera off: no image is sent, and none is accepted.
  if (mode !== "chat" && !isJpegBase64(raw.image)) return json({ error: "image must be a base64 JPEG" }, 400);
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (mode !== "scan" && !question) return json({ error: "question required" }, 400);
  if (question.length > MAX_QUESTION_CHARS) return json({ error: "question too long" }, 400);
  const cameraFacing: CameraFacing = raw.cameraFacing === "user" ? "user" : "outward";
  const previousAgeMs = typeof raw.previousAgeMs === "number" && raw.previousAgeMs > 0 && raw.previousAgeMs < 30_000 ? raw.previousAgeMs : undefined;

  if (!limiter.hit(clientKey(req))) return json({ error: "too many requests" }, 429, { "Retry-After": "20" });

  const request: VisionRequestBody = {
    mode,
    image: mode === "chat" ? undefined : (raw.image as string),
    // An invalid second frame is ignored rather than refused: it only means no motion claims.
    previousImage: mode !== "chat" && isJpegBase64(raw.previousImage) && previousAgeMs ? raw.previousImage : undefined,
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
  };

  if (!visionStatus().available) return json({ error: "not-configured" }, 503);

  const t0 = Date.now();
  // The user asked something else, or closed the page: the model call stops too.
  const abort = new AbortController();
  req.signal?.addEventListener("abort", () => abort.abort(), { once: true });
  if (raw.stream === true && mode !== "scan") return streamAnswer(request, abort, t0);

  const result = await analyzeImage(request, { signal: abort.signal });
  logFailures(result.attempts);
  if (!result.ok) return failure(result);
  return json({ analysis: result.analysis, provider: result.provider, latencyMs: Date.now() - t0 });
}

/** Everything failed. Say so: the client tells the user, and no description is made up. */
function failure(result: AnalyzeResult) {
  const limited = result.attempts.length > 0 && result.attempts.every((a) => /cooling down|HTTP 429|HTTP 402/.test(a.error ?? ""));
  return limited ? json({ error: "rate-limited" }, 503, { "Retry-After": "30" }) : json({ error: "ai-unavailable" }, 503);
}

/**
 * The answer as server-sent events, one sentence at a time while the model writes it. The response
 * starts only with the first sentence (or the whole answer): if every provider fails before that,
 * the client gets the same JSON errors as without streaming.
 */
async function streamAnswer(request: VisionRequestBody, abort: AbortController, t0: number): Promise<Response> {
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
