// Real places around a position, nearest first (OpenStreetMap: Overpass, Nominatim as the fallback).
// POST { lat, lon, category, radius?, lang }.
import { nearbyPlaces } from "../../../../lib/server/geo.ts";
import { attribution, failure, geoRequest, json, readPoint } from "../../../../lib/server/geoRoute.ts";
import { record } from "../../../../lib/server/monitor.ts";
import { defaultRadius, MAX_RADIUS } from "../../../../lib/geo/osm.ts";
import { isPlaceCategory } from "../../../../lib/geo/types.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

export async function POST(req: Request) {
  const r = await geoRequest(req, "geo.nearby");
  if (r instanceof Response) return r;
  const at = readPoint(r.body);
  if (!at) return json({ error: "bad-position" }, 400);
  const category = isPlaceCategory(r.body.category) ? r.body.category : null;
  if (!category) return json({ error: "bad-category" }, 400);
  const asked = Number(r.body.radius);
  const radius = Number.isFinite(asked) && asked > 0 ? Math.round(Math.min(MAX_RADIUS, Math.max(100, asked))) : defaultRadius(category);
  const res = await nearbyPlaces(at, category, radius, r.lang);
  if (!res.ok) return failure("geo.nearby", res.error);
  record("geo.nearby", res.cached ? "cached" : res.value.source);
  return json({ ...res.value, ...attribution });
}
