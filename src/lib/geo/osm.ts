// OpenStreetMap data: which map tags make a "pharmacy" or a "bus stop", the Overpass query for them,
// and parsers for the answers of Overpass, Nominatim and OSRM. Pure functions: the server routes do
// the fetching, and the tests feed recorded answers. Nothing here invents a field: what the map
// doesn't have stays null.
import { haversine, isValidLatLon } from "./math.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { ConcreteCategory, LatLon, Place, PlaceCategory, ReverseResult, RouteStep, WalkingRoute } from "./types.ts";

/** Overpass tag filters per category. Specific categories first: classify() takes the first match. */
const FILTERS: [ConcreteCategory, string[]][] = [
  ["pharmacy", ['["amenity"="pharmacy"]', '["healthcare"="pharmacy"]']],
  ["hospital", ['["amenity"="hospital"]', '["healthcare"="hospital"]']],
  ["clinic", ['["amenity"~"^(clinic|doctors)$"]', '["healthcare"~"^(clinic|doctor|centre)$"]']],
  ["atm", ['["amenity"="atm"]', '["amenity"="bank"]["atm"="yes"]']],
  ["bank", ['["amenity"="bank"]']],
  ["restaurant", ['["amenity"~"^(restaurant|fast_food)$"]']],
  ["cafe", ['["amenity"="cafe"]']],
  ["supermarket", ['["shop"="supermarket"]']],
  ["grocery", ['["shop"~"^(convenience|greengrocer|grocery|general|bakery)$"]']],
  ["bus_stop", ['["highway"="bus_stop"]', '["amenity"="bus_station"]', '["public_transport"="platform"]["bus"="yes"]']],
  ["train_station", ['["railway"~"^(station|halt|tram_stop)$"]', '["public_transport"="station"]["train"="yes"]']],
  ["hotel", ['["tourism"~"^(hotel|guest_house|hostel|motel)$"]']],
  ["public_place", ['["amenity"~"^(townhall|post_office|police|library|community_centre|marketplace|courthouse)$"]', '["leisure"="park"]', '["office"="government"]']],
  ["shop", ['["shop"]']],
];
const FILTER_MAP = new Map(FILTERS);

/** "What is near me?": the everyday places, not every shop. */
export const ANY_CATEGORIES: ConcreteCategory[] = ["pharmacy", "hospital", "clinic", "supermarket", "grocery", "restaurant", "cafe", "bank", "atm", "bus_stop", "train_station"];

export const categoriesFor = (c: PlaceCategory): ConcreteCategory[] => (c === "any" ? ANY_CATEGORIES : [c]);

/** Default search radius in metres: hospitals and stations are rarer, so further. */
export function defaultRadius(c: PlaceCategory): number {
  return c === "hospital" || c === "train_station" ? 3000 : c === "any" ? 500 : 1000;
}
export const MAX_RADIUS = 5000;

/** Does an OSM tag filter like ["amenity"~"^(a|b)$"]["atm"="yes"] match these tags? */
function matches(filter: string, tags: Record<string, string>): boolean {
  for (const m of filter.matchAll(/\["([^"]+)"(?:(=|~)"([^"]*)")?\]/g)) {
    const [, key, op, value] = m;
    const v = tags[key];
    if (v == null) return false;
    if (op === "=" && v !== value) return false;
    if (op === "~" && !new RegExp(value).test(v)) return false;
  }
  return true;
}

/** The category a map feature belongs to, among those asked for. */
export function classify(tags: Record<string, string>, among: ConcreteCategory[] = FILTERS.map(([c]) => c)): ConcreteCategory | null {
  for (const [cat, filters] of FILTERS) if (among.includes(cat) && filters.some((f) => matches(f, tags))) return cat;
  return null;
}

/** The Overpass QL query for these categories around a point. */
export function overpassQuery(cats: ConcreteCategory[], at: LatLon, radius: number, timeoutSec = 10): string {
  const around = `(around:${Math.round(radius)},${at.lat.toFixed(6)},${at.lon.toFixed(6)})`;
  const parts = cats.flatMap((c) => FILTER_MAP.get(c) ?? []).map((f) => `nwr${around}${f};`);
  return `[out:json][timeout:${timeoutSec}];(${parts.join("")});out center tags 200;`;
}

const nameKeys = (lang: SpeechLang) => (lang === "fr" ? ["name:fr", "name", "name:ar"] : lang === "en" ? ["name:en", "name", "name:fr"] : ["name:ar", "name", "name:fr"]);

export function pickName(tags: Record<string, string>, lang: SpeechLang): string | null {
  for (const k of nameKeys(lang)) {
    const v = tags[k]?.trim();
    if (v) return v.slice(0, 120);
  }
  return null;
}

/** "12 Rue de Rome, Tunis" from addr:* tags, or null when the map has no street. */
export function tagAddress(tags: Record<string, string>): string | null {
  const street = tags["addr:street"]?.trim();
  if (!street) return null;
  const num = tags["addr:housenumber"]?.trim();
  const city = (tags["addr:city"] ?? tags["addr:suburb"])?.trim();
  return [num ? `${num} ${street}` : street, city].filter(Boolean).join(", ").slice(0, 160);
}

/**
 * Names of organisations, not of the place someone would walk to: an order, union, ministry,
 * association, administration… Mapped with the tag of their field (a dentists' professional body in
 * Tunis is tagged amenity=hospital). Arabic and French, as Tunisian places are named.
 */
const ORGANISATION_NAME = new RegExp(
  // Not «معهد» / "Institut": in Tunisia that names real hospitals (Institut Salah-Azaïz, Hedi Raies…).
  "\\b(ordre|syndicat|association|f[ée]d[ée]ration|minist[eè]re|direction|conseil|union|chambre|si[eè]ge|administration|inspection|commissariat g[ée]n[ée]ral|caisse|mutuelle|soci[ée]t[ée] tunisienne de|[ée]cole|institut sup[ée]rieur|facult[ée])\\b" +
    "|عمادة|هيئة|نقابة|جمعية|وزارة|ادارة|إدارة|مديرية|اتحاد|مجلس|غرفة|صندوق|تعاضدية|المعهد العالي|كلية",
  "i",
);
/**
 * A smaller or different place mapped under a bigger category: a dentist's or doctor's practice or a
 * laboratory tagged as a hospital, a parapharmacy (no medicines) tagged as a pharmacy.
 */
const SMALLER_PLACE: Partial<Record<ConcreteCategory, RegExp>> = {
  hospital: /\b(cabinet|dentaire|dentiste|orthodont|laboratoire|labo|opticien|kin[ée]sith[ée]rap|radiologie priv[ée]e|pharmacie)\b|عيادة|مخبر|صيدلية|طبيب أسنان/i,
  pharmacy: /parapharm|بارافارم|شبه صيدلية/i,
};
const CATEGORY_WORD: Record<"pharmacy" | "hospital" | "clinic", RegExp> = {
  pharmacy: /pharmac|صيدل|فرمسي|فارمسي/i,
  hospital: /h[oô]pital|hospital|centre hospitalier|chu\b|مستشفى|مستشفي|سبيطار|مستشفيات/i,
  clinic: /clini|polyclini|cabinet|centre de sant[ée]|dispensaire|docteur|dr\.?\s|مصحة|مصحّة|عيادة|مستوصف|دكتور|طبيب/i,
};
/** Categories people walk to for care or help, where a wrong place matters most. */
const STRICT: ConcreteCategory[] = ["pharmacy", "hospital", "clinic"];

/** Why a place may not be what its category says, from its own tags and name. */
export function placeDoubt(tags: Record<string, string>, name: string | null, category: ConcreteCategory): Place["doubt"] {
  if (!STRICT.includes(category)) return null;
  if (tags.office || tags.government) return "office";
  const names = [name, tags.name, tags["name:fr"], tags["name:ar"], tags.official_name].filter(Boolean).join(" ");
  if (!names) return null;
  if (SMALLER_PLACE[category]?.test(names)) return "name";
  // A name that says what the category says («Pharmacie de l'Ordre», «مستشفى…») confirms it.
  if (CATEGORY_WORD[category as "pharmacy"]?.test(names)) return null;
  return ORGANISATION_NAME.test(names) ? "name" : null;
}

/** On the map but not in use: never offered. */
export function isDisused(tags: Record<string, string>): boolean {
  if (Object.keys(tags).some((k) => /^(disused|abandoned|demolished|was|razed|removed):/.test(k))) return true;
  if (/^(yes|true)$/i.test(tags.disused ?? "") || /^(yes|true)$/i.test(tags.abandoned ?? "")) return true;
  if (/^(closed|off)$/i.test(tags.opening_hours?.trim() ?? "")) return true;
  const end = tags.end_date?.match(/^(\d{4})(?:-(\d{2}))?/);
  return !!end && new Date(`${end[1]}-${end[2] ?? "12"}-28`).getTime() < Date.now();
}

/** Nearest first, but places whose tags or name contradict their category come after the others. */
export function rankPlaces<T extends LatLon & { doubt?: Place["doubt"] }>(places: T[], origin: LatLon): T[] {
  const sorted = sortByDistance(places, origin);
  return [...sorted.filter((p) => !p.doubt), ...sorted.filter((p) => p.doubt)];
}

const clean = (v: string | undefined) => (v?.trim() ? v.trim().slice(0, 120) : null);

interface OverpassElement {
  type?: string;
  id?: number;
  lat?: number;
  lon?: number;
  center?: { lat?: number; lon?: number };
  tags?: Record<string, string>;
}

/** Places from an Overpass answer, in the asked categories, nearest first. */
export function parseOverpass(json: unknown, cats: ConcreteCategory[], lang: SpeechLang, origin: LatLon): Place[] {
  const els = (json as { elements?: OverpassElement[] } | null)?.elements;
  if (!Array.isArray(els)) return [];
  const out: Place[] = [];
  const seen = new Set<string>();
  for (const e of els) {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    const tags = e.tags ?? {};
    if (!isValidLatLon(lat, lon) || typeof e.id !== "number") continue;
    const category = classify(tags, cats);
    if (!category || isDisused(tags)) continue;
    const osmId = `${(e.type ?? "n")[0]}${e.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);
    out.push({
      osmId,
      lat: lat!,
      lon: lon!,
      name: pickName(tags, lang),
      category,
      kind: tags.amenity ?? tags.shop ?? tags.highway ?? tags.railway ?? tags.tourism ?? tags.healthcare ?? tags.leisure ?? tags.public_transport ?? tags.office ?? category,
      address: tagAddress(tags),
      openingHours: clean(tags.opening_hours),
      phone: clean(tags.phone ?? tags["contact:phone"]),
      wheelchair: clean(tags.wheelchair),
      doubt: placeDoubt(tags, pickName(tags, lang), category),
    });
  }
  return rankPlaces(out, origin);
}

export function sortByDistance<T extends LatLon>(places: T[], origin: LatLon): T[] {
  return places
    .map((p) => [p, haversine(origin, p)] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([p]) => p);
}

/**
 * Nominatim's structured `amenity=` search, the fallback when Overpass can't be reached. It finds
 * points of interest by type, one type per request.
 */
// Checked against the live service in central Tunis, Nov 2026: "clinic" and "convenience" return
// nothing there, "doctors", "greengrocer" and "bakery" do. At most three words (one request each).
export const NOMINATIM_TYPES: Record<ConcreteCategory, string[]> = {
  pharmacy: ["pharmacy"],
  hospital: ["hospital"],
  clinic: ["doctors", "clinic"],
  restaurant: ["restaurant"],
  cafe: ["cafe"],
  supermarket: ["supermarket"],
  grocery: ["greengrocer", "bakery", "convenience"],
  atm: ["atm"],
  bank: ["bank"],
  bus_stop: ["bus stop"],
  train_station: ["station"],
  hotel: ["hotel"],
  public_place: ["post office", "townhall"],
  shop: ["mall", "department store", "supermarket"],
};
/** For "any" in the fallback: few requests, since Nominatim allows one a second. */
export const NOMINATIM_ANY: ConcreteCategory[] = ["pharmacy", "supermarket", "restaurant"];

interface NominatimItem {
  osm_type?: string;
  osm_id?: number;
  lat?: string;
  lon?: string;
  name?: string;
  category?: string;
  type?: string;
  address?: Record<string, string>;
  extratags?: Record<string, string> | null;
  namedetails?: Record<string, string> | null;
}

/** Places from a Nominatim search answer. Only results whose map tags really fit the category. */
export function parseNominatimSearch(json: unknown, cat: ConcreteCategory, lang: SpeechLang, origin: LatLon): Place[] {
  if (!Array.isArray(json)) return [];
  const out: Place[] = [];
  for (const it of json as NominatimItem[]) {
    const lat = Number(it.lat);
    const lon = Number(it.lon);
    if (!isValidLatLon(lat, lon) || typeof it.osm_id !== "number" || !it.category || !it.type) continue;
    const tags: Record<string, string> = { ...(it.extratags ?? {}), [it.category]: it.type };
    if (classify(tags, [cat]) !== cat || isDisused(tags)) continue;
    const names = it.namedetails ?? {};
    const name = pickName({ ...names, ...(it.name && !names.name ? { name: it.name } : {}) }, lang);
    const a = it.address ?? {};
    const road = a.road ?? a.pedestrian ?? a.footway;
    out.push({
      osmId: `${(it.osm_type ?? "n")[0]}${it.osm_id}`,
      lat,
      lon,
      name,
      category: cat,
      kind: it.type,
      address: road ? [a.house_number ? `${a.house_number} ${road}` : road, a.suburb ?? a.city_district ?? a.city ?? a.town].filter(Boolean).join(", ").slice(0, 160) : null,
      openingHours: clean(tags.opening_hours),
      phone: clean(tags.phone ?? tags["contact:phone"]),
      wheelchair: clean(tags.wheelchair),
      doubt: placeDoubt({ ...tags, ...names }, name, cat),
    });
  }
  return rankPlaces(out, origin);
}

/** A reverse-geocoding answer from Nominatim (jsonv2). */
export function parseReverse(json: unknown, lang: SpeechLang = "tn"): ReverseResult | null {
  const d = json as { name?: string; address?: Record<string, string>; error?: string } | null;
  if (!d || d.error || !d.address) return null;
  const a = d.address;
  const road = clean(a.road ?? a.pedestrian ?? a.footway ?? a.path ?? a.square ?? a.residential);
  const neighbourhood = clean(a.neighbourhood ?? a.quarter ?? a.suburb ?? a.city_district ?? a.hamlet);
  const city = clean(a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? a.state);
  const houseNumber = clean(a.house_number);
  const name = clean(d.name) && d.name !== road ? clean(d.name) : null;
  const parts = [road ? (houseNumber ? `${houseNumber} ${road}` : road) : null, neighbourhood, city].filter((x, i, all): x is string => !!x && all.indexOf(x) === i);
  return { label: parts.length ? parts.join(lang === "fr" || lang === "en" ? ", " : "، ") : null, road, houseNumber, neighbourhood, city, name };
}

interface OsrmStep {
  distance?: number;
  duration?: number;
  name?: string;
  ref?: string;
  maneuver?: { type?: string; modifier?: string; location?: [number, number]; exit?: number };
}

/** The first route of an OSRM answer (geometries=geojson, steps=true), or null. */
export function parseOsrm(json: unknown): WalkingRoute | null {
  const d = json as { code?: string; routes?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] }; legs?: { steps?: OsrmStep[] }[] }[] } | null;
  const r = d?.code === "Ok" ? d.routes?.[0] : undefined;
  if (!r || typeof r.distance !== "number" || typeof r.duration !== "number") return null;
  const geometry = (r.geometry?.coordinates ?? []).filter((c) => isValidLatLon(c[1], c[0])).map(([lon, lat]) => ({ lat, lon }));
  const steps: RouteStep[] = [];
  for (const leg of r.legs ?? []) {
    for (const s of leg.steps ?? []) {
      const loc = s.maneuver?.location;
      if (!loc || !isValidLatLon(loc[1], loc[0]) || !s.maneuver?.type) continue;
      steps.push({
        type: s.maneuver.type,
        modifier: s.maneuver.modifier ?? null,
        name: (s.name || s.ref || "").slice(0, 120),
        distance: Math.max(0, s.distance ?? 0),
        duration: Math.max(0, s.duration ?? 0),
        location: { lat: loc[1], lon: loc[0] },
        exit: typeof s.maneuver.exit === "number" ? s.maneuver.exit : null,
      });
    }
  }
  if (geometry.length < 2 || steps.length === 0) return null;
  return { distance: r.distance, duration: r.duration, geometry, steps };
}

/** Nominatim's accept-language for a speech language. Tunisian streets are named in Arabic and French. */
export const acceptLanguage = (lang: SpeechLang) => (lang === "fr" ? "fr,ar" : lang === "en" ? "en,fr" : "ar,fr");
