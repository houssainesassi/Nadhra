// SERVER-ONLY. Maps for the location tools: reverse geocoding (Nominatim), nearby places (Overpass,
// with Nominatim as the fallback) and walking routes (OSRM, foot profile). All free OpenStreetMap
// services, no key. Their usage policies ask for an identifying User-Agent, light use and caching:
//   - Nominatim: at most 1 request a second (enforced here per server instance), cache results.
//   - Overpass: a few requests a minute per user; skipped for a while after it failed.
//   - routing.openstreetmap.de (FOSSGIS OSRM): fair use only.
// Positions are never logged or stored: only the answers are cached, in memory, keyed by a rounded
// position. Every call has a timeout and returns a typed failure instead of throwing.
import "server-only";
import { aiMode } from "../ai/router.ts";
import { haversine } from "../geo/math.ts";
import { acceptLanguage, categoriesFor, NOMINATIM_ANY, NOMINATIM_TYPES, overpassQuery, parseNominatimSearch, parseOsrm, parseOverpass, parseReverse, sortByDistance } from "../geo/osm.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { ConcreteCategory, LatLon, NearbyResult, Place, PlaceCategory, ReverseResult, WalkingRoute } from "../geo/types.ts";

export type GeoFailure = "timeout" | "rate-limited" | "upstream" | "no-route" | "too-far";
export type GeoResult<T> = { ok: true; value: T; cached?: boolean } | { ok: false; error: GeoFailure };

const truthy = (v: string | undefined) => /^(1|true|yes)$/i.test(v?.trim() ?? "");

/** Off with GEO_DISABLED=1, and in offline mode (nothing may leave the device). */
export function geoEnabled(): boolean {
  return !truthy(process.env.GEO_DISABLED) && aiMode() !== "offline";
}

const list = (v: string | undefined, def: string[]) => {
  const out = (v ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => /^https:\/\/[\w.-]+(:\d+)?(\/[\w.~/-]*)?$/.test(s));
  return out.length ? out : def;
};

export function geoConfig() {
  const e = process.env;
  return {
    nominatim: list(e.NOMINATIM_URL, ["https://nominatim.openstreetmap.org"])[0],
    overpass: list(e.OVERPASS_URLS, ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]),
    osrm: list(e.OSRM_FOOT_URL, ["https://routing.openstreetmap.de/routed-foot"])[0],
    /** Identifies the app to the map services, as their policies require. Never the user. */
    userAgent: `Nadhra/0.1 (accessibility assistant for blind people; ${e.APP_URL?.trim() || "https://nadhra-eight.vercel.app"}${e.GEO_CONTACT_EMAIL?.trim() ? `; ${e.GEO_CONTACT_EMAIL.trim()}` : ""})`,
    timeoutMs: Math.min(15_000, Math.max(2_000, Number(e.GEO_TIMEOUT_MS) || 8_000)),
    /** Walking routes longer than this are refused as "too far". */
    maxWalkM: Math.min(50_000, Math.max(1_000, Number(e.GEO_MAX_WALK_M) || 20_000)),
  };
}

// --- caching -----------------------------------------------------------------------------------------

class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }
  set(key: string, v: V, ttlMs: number) {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  clear() {
    this.map.clear();
  }
}

const reverseCache = new TtlCache<ReverseResult>(2_000);
const nearbyCache = new TtlCache<{ places: Place[]; source: NearbyResult["source"]; partial: boolean }>(1_000);
const routeCache = new TtlCache<WalkingRoute>(500);

/** For tests. */
export function clearGeoCaches() {
  reverseCache.clear();
  nearbyCache.clear();
  routeCache.clear();
  overpassDownUntil = 0;
  nominatimNext = 0;
}

/** About 11 m: a reverse-geocoding answer holds for anyone within it. */
const key4 = (p: LatLon) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
/** About 110 m: nearby lists are cached per cell; distances are recomputed from the exact position. */
const key3 = (p: LatLon) => `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;

// --- fetching ----------------------------------------------------------------------------------------

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<GeoResult<unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { "User-Agent": geoConfig().userAgent, Accept: "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
  } catch (e) {
    return { ok: false, error: (e as Error)?.name === "TimeoutError" ? "timeout" : "upstream" };
  }
  if (res.status === 429) return { ok: false, error: "rate-limited" };
  if (!res.ok) return { ok: false, error: "upstream" };
  try {
    return { ok: true, value: await res.json() };
  } catch {
    return { ok: false, error: "upstream" };
  }
}

/** Nominatim allows one request a second: callers wait their turn (per server instance). */
let nominatimNext = 0;
async function nominatimTurn() {
  const now = Date.now();
  const at = Math.max(now, nominatimNext);
  nominatimNext = at + 1_100;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

/** After Overpass failed, it is skipped this long (the fallback answers meanwhile). */
const OVERPASS_COOLDOWN_MS = 5 * 60_000;
let overpassDownUntil = 0;

// --- the three services ----------------------------------------------------------------------------------

export async function reverseGeocode(at: LatLon, lang: SpeechLang): Promise<GeoResult<ReverseResult>> {
  const key = `${key4(at)}:${lang}`;
  const hit = reverseCache.get(key);
  if (hit) return { ok: true, value: hit, cached: true };
  const c = geoConfig();
  await nominatimTurn();
  const url = `${c.nominatim}/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${at.lat.toFixed(6)}&lon=${at.lon.toFixed(6)}&accept-language=${encodeURIComponent(acceptLanguage(lang))}`;
  const r = await fetchJson(url, {}, c.timeoutMs);
  if (!r.ok) return r;
  const parsed = parseReverse(r.value, lang) ?? { label: null, road: null, houseNumber: null, neighbourhood: null, city: null, name: null };
  reverseCache.set(key, parsed, 24 * 3_600_000);
  return { ok: true, value: parsed };
}

async function overpassNearby(cats: ConcreteCategory[], at: LatLon, radius: number, lang: SpeechLang, deadline: number): Promise<Place[] | null> {
  if (Date.now() < overpassDownUntil) return null;
  const c = geoConfig();
  const body = `data=${encodeURIComponent(overpassQuery(cats, at, radius, 10))}`;
  for (const url of c.overpass) {
    const left = deadline - Date.now();
    if (left < 2_000) break;
    const r = await fetchJson(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }, Math.min(c.timeoutMs, left));
    if (r.ok) return parseOverpass(r.value, cats, lang, at);
  }
  overpassDownUntil = Date.now() + OVERPASS_COOLDOWN_MS;
  return null;
}

async function nominatimNearby(cats: ConcreteCategory[], at: LatLon, radius: number, lang: SpeechLang, deadline: number): Promise<Place[] | null> {
  const c = geoConfig();
  // A box around the point, as wide as the radius.
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.max(0.2, Math.cos((at.lat * Math.PI) / 180)));
  const box = [at.lon - dLon, at.lat + dLat, at.lon + dLon, at.lat - dLat].map((v) => v.toFixed(5)).join(",");
  const out: Place[] = [];
  let any = false;
  for (const cat of cats) {
    if (deadline - Date.now() < 2_500) break;
    await nominatimTurn();
    const url = `${c.nominatim}/search?format=jsonv2&amenity=${encodeURIComponent(NOMINATIM_TYPES[cat])}&viewbox=${box}&bounded=1&limit=20&addressdetails=1&extratags=1&namedetails=1&accept-language=${encodeURIComponent(acceptLanguage(lang))}`;
    const r = await fetchJson(url, {}, Math.min(c.timeoutMs, deadline - Date.now()));
    if (!r.ok) continue;
    any = true;
    out.push(...parseNominatimSearch(r.value, cat, lang, at));
  }
  if (!any) return null;
  const seen = new Set<string>();
  return sortByDistance(out.filter((p) => !seen.has(p.osmId) && seen.add(p.osmId) && haversine(at, p) <= radius * 1.45), at);
}

/** Places around `at`, nearest first. Overpass first; Nominatim (fewer kinds of place) when it fails. */
export async function nearbyPlaces(at: LatLon, category: PlaceCategory, radius: number, lang: SpeechLang): Promise<GeoResult<NearbyResult>> {
  const key = `${key3(at)}:${category}:${radius}:${lang}`;
  const hit = nearbyCache.get(key);
  const done = (v: { places: Place[]; source: NearbyResult["source"]; partial: boolean }, cached?: boolean): GeoResult<NearbyResult> => ({
    ok: true,
    cached,
    value: { ...v, radius, places: sortByDistance(v.places, at).filter((p) => haversine(at, p) <= radius * 1.1) },
  });
  if (hit) return done(hit, true);
  const deadline = Date.now() + 14_000;
  const cats = categoriesFor(category);
  const fromOverpass = await overpassNearby(cats, at, radius, lang, deadline);
  if (fromOverpass) {
    const v = { places: fromOverpass.slice(0, 60), source: "overpass" as const, partial: false };
    nearbyCache.set(key, v, 15 * 60_000);
    return done(v);
  }
  const fallbackCats = category === "any" ? NOMINATIM_ANY : cats;
  const fromNominatim = await nominatimNearby(fallbackCats, at, radius, lang, deadline);
  if (!fromNominatim) return { ok: false, error: "upstream" };
  // The fallback finds fewer places (and for "any", fewer kinds): say the list may be incomplete.
  const v = { places: fromNominatim.slice(0, 60), source: "nominatim" as const, partial: true };
  nearbyCache.set(key, v, 5 * 60_000);
  return done(v);
}

export async function walkingRoute(from: LatLon, to: LatLon): Promise<GeoResult<WalkingRoute>> {
  const c = geoConfig();
  if (haversine(from, to) > c.maxWalkM) return { ok: false, error: "too-far" };
  const key = `${from.lat.toFixed(5)},${from.lon.toFixed(5)}>${to.lat.toFixed(5)},${to.lon.toFixed(5)}`;
  const hit = routeCache.get(key);
  if (hit) return { ok: true, value: hit, cached: true };
  const url = `${c.osrm}/route/v1/foot/${from.lon.toFixed(6)},${from.lat.toFixed(6)};${to.lon.toFixed(6)},${to.lat.toFixed(6)}?steps=true&overview=full&geometries=geojson&alternatives=false`;
  const r = await fetchJson(url, {}, c.timeoutMs);
  if (!r.ok) return r;
  const code = (r.value as { code?: string } | null)?.code;
  const route = parseOsrm(r.value);
  if (!route) return { ok: false, error: code === "NoRoute" || code === "NoSegment" || code === "Ok" ? "no-route" : "upstream" };
  if (route.distance > c.maxWalkM) return { ok: false, error: "too-far" };
  routeCache.set(key, route, 10 * 60_000);
  return { ok: true, value: route };
}
