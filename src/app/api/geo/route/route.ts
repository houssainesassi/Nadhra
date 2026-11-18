// A walking route between two positions (OSRM, foot profile, on OpenStreetMap data).
// POST { from: { lat, lon }, to: { lat, lon } }.
import { walkingRoute } from "../../../../lib/server/geo.ts";
import { attribution, failure, geoRequest, json, readPoint } from "../../../../lib/server/geoRoute.ts";
import { record } from "../../../../lib/server/monitor.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(req: Request) {
  const r = await geoRequest(req, "geo.route");
  if (r instanceof Response) return r;
  const from = readPoint(r.body.from);
  const to = readPoint(r.body.to);
  if (!from || !to) return json({ error: "bad-position" }, 400);
  const res = await walkingRoute(from, to);
  if (!res.ok) return failure("geo.route", res.error);
  record("geo.route", res.cached ? "cached" : "ok");
  return json({ route: res.value, ...attribution });
}
