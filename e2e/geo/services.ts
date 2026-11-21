// The real map services from wherever this runs (dev machine, or a deployment's region via
// /api/health?geo=1): reachability, the Nominatim fallback for every category in central Tunis,
// misleading categories, and the one-request-a-second spacing under parallel load.
// About 25 Nominatim requests, spaced; run it rarely (the public servers are for light use).
//   node --experimental-strip-types --conditions=react-server e2e/geo/services.ts
import { clearGeoCaches, nearbyPlaces, probeGeoServices, reverseGeocode } from "../../src/lib/server/geo.ts";
import { PLACE_CATEGORIES } from "../../src/lib/geo/types.ts";
import { haversine } from "../../src/lib/geo/math.ts";

const HERE = { lat: 36.7993, lon: 10.1802 }; // Rue de Grèce, Tunis
console.log("PROBE (from this machine)");
for (const p of await probeGeoServices()) console.log(`  ${p.ok ? "OK  " : "FAIL"} ${p.service.padEnd(10)} ${String(p.status).padEnd(4)} ${String(p.ms).padStart(5)} ms  ${p.url}  ${p.ok ? "" : p.note}`);

// Every Nominatim request's start time, to check the spacing.
const starts: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: string, init?: RequestInit) => {
  if (String(url).includes("nominatim")) starts.push(Date.now());
  return realFetch(url, init);
}) as typeof fetch;

process.env.OVERPASS_URLS = "off"; // as it behaves today: the fallback answers
clearGeoCaches();
console.log("\nNEARBY via the Nominatim fallback (Overpass off)");
for (const cat of PLACE_CATEGORIES) {
  const t0 = Date.now();
  const r = await nearbyPlaces(HERE, cat, cat === "hospital" || cat === "train_station" ? 3000 : cat === "any" ? 500 : 1000, "fr");
  if (!r.ok) {
    console.log(`  ${cat.padEnd(14)} ERROR ${r.error}`);
    continue;
  }
  const v = r.value;
  const doubt = v.places.filter((p) => p.doubt);
  const first = v.places[0];
  console.log(`  ${cat.padEnd(14)} ${String(v.places.length).padStart(3)} found ${String(Date.now() - t0).padStart(5)} ms  nearest: ${first ? `${first.name ?? "(no name)"} ${Math.round(haversine(HERE, first))} m` : "—"}${doubt.length ? `  doubtful: ${doubt.map((p) => p.name).join(" / ")}` : ""}`);
}

console.log("\nRATE: 4 reverse requests at once (different spots, so no cache)");
starts.length = 0;
const pts = [0, 1, 2, 3].map((i) => ({ lat: HERE.lat + i * 0.002, lon: HERE.lon }));
const t0 = Date.now();
const res = await Promise.all(pts.map((p) => reverseGeocode(p, "fr")));
const gaps = starts.slice(1).map((t, i) => t - starts[i]);
console.log(`  results: ${res.map((r) => (r.ok ? "ok" : r.error)).join(", ")} in ${Date.now() - t0} ms; gaps between requests: ${gaps.join(", ")} ms (each must be ≥ 1000)`);
console.log(`  spacing respected: ${gaps.every((g) => g >= 1000)}`);
process.exit(0);
