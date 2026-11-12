// Opens an anonymous session: a signed HttpOnly cookie the other API routes require (see
// src/lib/server/session.ts). No account, nothing personal: only a random id and an expiry.
// Relative imports (not "@/") so the route can be unit-tested with plain Node.
import { allowNewSession } from "../../../lib/server/guard.ts";
import { record } from "../../../lib/server/monitor.ts";
import { issueSessionToken, sessionCookieHeader, sessionIdFrom } from "../../../lib/server/session.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  // Browsers say where a request comes from; another site's page can't open sessions here.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  if (sessionIdFrom(req)) return Response.json({ ok: true, renewed: false }, { headers: NO_STORE });
  if (!(await allowNewSession(req))) {
    record("session.denied", "too-many");
    return Response.json({ error: "too many requests" }, { status: 429, headers: { ...NO_STORE, "Retry-After": "600" } });
  }
  const { token } = issueSessionToken();
  record("session.opened");
  return Response.json({ ok: true, renewed: true }, { headers: { ...NO_STORE, "Set-Cookie": sessionCookieHeader(req, token) } });
}
