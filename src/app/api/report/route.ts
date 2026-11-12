// The page reports its own failures here (camera error, detector failure, live drop…) as fixed
// event names and short codes, never content. See src/lib/server/monitor.ts.
import { charge, checkRequest } from "../../../lib/server/guard.ts";
import { readJsonBody } from "../../../lib/server/http.ts";
import { CLIENT_EVENTS, record, safeCode } from "../../../lib/server/monitor.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const ctx = checkRequest(req, "report");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody<{ events?: unknown }>(req, 4096);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  const limited = await charge(ctx, "report");
  if (limited) return limited;
  const events = Array.isArray(body.value?.events) ? body.value.events.slice(0, 20) : [];
  let accepted = 0;
  for (const e of events) {
    const name = (e as { e?: unknown })?.e;
    if (typeof name !== "string" || !CLIENT_EVENTS.has(name)) continue;
    record(`client.${name}`, safeCode((e as { c?: unknown }).c), "warn");
    accepted++;
  }
  return Response.json({ accepted }, { headers: { "Cache-Control": "no-store" } });
}
