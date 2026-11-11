// Short-lived token for a live voice + camera conversation with Gemini. The browser then connects to
// Gemini directly; no audio or image passes through this route.
// Relative imports (not "@/") so the route can be unit-tested with plain Node.
import { liveStatus, mintLiveToken } from "../../../../lib/server/liveToken.ts";
import { clientKey, isSameOrigin, RateLimiter, readJsonBody } from "../../../../lib/server/http.ts";
import { isSpeechLang } from "../../../../lib/assistant/lang.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// A conversation reconnects about every 10 minutes, and after network drops: this is plenty.
const limiter = new RateLimiter(Number(process.env.LIVE_TOKEN_RATE_LIMIT_PER_MIN) || 12);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export function GET() {
  return json(liveStatus());
}

export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: "forbidden" }, 403);
  const body = await readJsonBody<Record<string, unknown>>(req, 4096);
  if (!body.ok) return json({ error: body.error }, body.status);
  const raw = body.value && typeof body.value === "object" ? body.value : {};
  if (!limiter.hit(clientKey(req))) return json({ error: "too many requests" }, 429, { "Retry-After": "10" });
  const handle = typeof raw.handle === "string" && /^[\w.~+/=-]{1,2048}$/.test(raw.handle) ? raw.handle : undefined;
  const modelIndex = typeof raw.modelIndex === "number" && Number.isInteger(raw.modelIndex) ? Math.min(Math.max(raw.modelIndex, 0), 5) : 0;
  const result = await mintLiveToken({
    lang: isSpeechLang(raw.lang) ? raw.lang : "tn",
    facing: raw.facing === "user" ? "user" : "outward",
    modelIndex,
    handle,
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  const { ok: _ok, ...rest } = result;
  return json(rest);
}
