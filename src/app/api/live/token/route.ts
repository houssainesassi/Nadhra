// Short-lived token for a live voice + camera conversation with Gemini. The browser then connects to
// Gemini directly; no audio or image passes through this route.
// Relative imports (not "@/") so the route can be unit-tested with plain Node.
import { liveStatus, mintLiveToken } from "../../../../lib/server/liveToken.ts";
import { readJsonBody } from "../../../../lib/server/http.ts";
import { charge, checkRequest } from "../../../../lib/server/guard.ts";
import { record } from "../../../../lib/server/monitor.ts";
import { isSpeechLang } from "../../../../lib/assistant/lang.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

// A conversation reconnects about every 10 minutes, and after network drops: the per-minute and
// daily limits in guard.ts leave plenty of room for that. A token opens one connection only (uses: 1),
// must be used within about a minute, and has the model, voice and instructions locked into it.
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export function GET() {
  return json(liveStatus());
}

export async function POST(req: Request) {
  const ctx = checkRequest(req, "live");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody<Record<string, unknown>>(req, 4096);
  if (!body.ok) return json({ error: body.error }, body.status);
  const raw = body.value && typeof body.value === "object" ? body.value : {};
  if (!liveStatus().configured) return json({ error: "not-configured" }, 503);
  const limited = await charge(ctx, "live");
  if (limited) return limited;
  const handle = typeof raw.handle === "string" && /^[\w.~+/=-]{1,2048}$/.test(raw.handle) ? raw.handle : undefined;
  const modelIndex = typeof raw.modelIndex === "number" && Number.isInteger(raw.modelIndex) ? Math.min(Math.max(raw.modelIndex, 0), 5) : 0;
  const result = await mintLiveToken({
    lang: isSpeechLang(raw.lang) ? raw.lang : "tn",
    facing: raw.facing === "user" ? "user" : "outward",
    modelIndex,
    handle,
  });
  if (!result.ok) {
    record("live.token-failed", result.error, "warn");
    return json({ error: result.error }, result.status);
  }
  record("live.token");
  const { ok: _ok, ...rest } = result;
  return json(rest);
}
