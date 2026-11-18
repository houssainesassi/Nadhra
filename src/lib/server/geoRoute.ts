// SERVER-ONLY. What the three map routes (/api/geo/reverse, /nearby, /route) check before calling a
// map service, in this order: the page's own origin and session (guard.ts), the AI mode and the
// provider (Nadhra AI and offline mode send nothing anywhere), the per-minute and daily limits, and
// the body. Positions are validated but never logged.
import "server-only";
import { charge, checkRequest } from "./guard.ts";
import { readJsonBody } from "./http.ts";
import { record } from "./monitor.ts";
import { geoEnabled, type GeoFailure } from "./geo.ts";
import { aiMode, requestedFamily } from "../ai/router.ts";
import { isValidLatLon } from "../geo/math.ts";
import { isSpeechLang, type SpeechLang } from "../assistant/lang.ts";
import { OSM_ATTRIBUTION, type LatLon } from "../geo/types.ts";

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export interface GeoRequest {
  body: Record<string, unknown>;
  lang: SpeechLang;
}

/** The request, or the response to send instead. */
export async function geoRequest(req: Request, route: string): Promise<GeoRequest | Response> {
  const ctx = checkRequest(req, route);
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody<Record<string, unknown>>(req, 2048);
  if (!body.ok) return json({ error: body.error }, body.status);
  const raw = body.value && typeof body.value === "object" ? body.value : {};
  if (requestedFamily(raw.provider) === "nadhra") return json({ error: "nadhra-unavailable" }, 503);
  if (aiMode() === "offline") return json({ error: "offline-mode" }, 503);
  if (!geoEnabled()) return json({ error: "not-configured" }, 503);
  const limited = await charge(ctx, "geo");
  if (limited) return limited;
  return { body: raw, lang: isSpeechLang(raw.lang) ? raw.lang : "tn" };
}

export function readPoint(v: unknown): LatLon | null {
  const p = v as { lat?: unknown; lon?: unknown } | null;
  return p && isValidLatLon(p.lat, p.lon) ? { lat: p.lat as number, lon: p.lon as number } : null;
}

const STATUS: Record<GeoFailure, number> = { timeout: 504, "rate-limited": 503, upstream: 502, "no-route": 422, "too-far": 422 };

export function failure(route: string, error: GeoFailure): Response {
  record(`${route}.failed`, error, error === "no-route" || error === "too-far" ? "info" : "warn");
  return json({ error }, STATUS[error]);
}

export const attribution = { attribution: OSM_ATTRIBUTION };
