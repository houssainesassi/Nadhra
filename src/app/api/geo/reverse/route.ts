// The street address of a position (OpenStreetMap Nominatim). POST { lat, lon, lang }.
// Relative imports (not "@/") so the route can be unit-tested with plain Node.
import { reverseGeocode } from "../../../../lib/server/geo.ts";
import { attribution, failure, geoRequest, json, readPoint } from "../../../../lib/server/geoRoute.ts";
import { record } from "../../../../lib/server/monitor.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

export async function POST(req: Request) {
  const r = await geoRequest(req, "geo.reverse");
  if (r instanceof Response) return r;
  const at = readPoint(r.body);
  if (!at) return json({ error: "bad-position" }, 400);
  const res = await reverseGeocode(at, r.lang);
  if (!res.ok) return failure("geo.reverse", res.error);
  record("geo.reverse", res.cached ? "cached" : "ok");
  return json({ ...res.value, ...attribution });
}
