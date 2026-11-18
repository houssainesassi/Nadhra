// Location and walking guidance, the pure parts: distances, OpenStreetMap parsing (on answers recorded
// from the real services in tests/fixtures/geo), the spoken directions, and the navigator fed with
// simulated walks along a real OSRM foot route through central Tunis. No network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cumulativeLengths, haversine, projectOnLine, roundDistance } from "../src/lib/geo/math.ts";
import { classify, overpassQuery, parseNominatimSearch, parseOsrm, parseOverpass, parseReverse } from "../src/lib/geo/osm.ts";
import { GEO_PHRASES, stepAction } from "../src/lib/geo/phrases.ts";
import { NAV, RouteNavigator, type NavEvent } from "../src/lib/geo/navigator.ts";
import { isSafetyClaim, splitSentences } from "../src/lib/assistant/schema.ts";
import type { Fix, LatLon, RouteStep, WalkingRoute } from "../src/lib/geo/types.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/geo/${name}`, import.meta.url), "utf8"));
const LANGS = ["tn", "ar", "fr", "en"] as const;
const HERE: LatLon = { lat: 36.7993, lon: 10.1802 };

test("distances: haversine, projection on a line, rounding never more precise than GPS", () => {
  // One thousandth of a degree of latitude is about 111 m.
  assert.ok(Math.abs(haversine({ lat: 36.8, lon: 10.18 }, { lat: 36.801, lon: 10.18 }) - 111.2) < 0.5);
  const line = [{ lat: 36.8, lon: 10.18 }, { lat: 36.801, lon: 10.18 }, { lat: 36.801, lon: 10.181 }];
  const cum = cumulativeLengths(line);
  const p = projectOnLine({ lat: 36.8005, lon: 10.1801 }, line, cum); // ~9 m east of the first leg, half-way up
  assert.ok(Math.abs(p.distance - 8.9) < 0.5, String(p.distance));
  assert.ok(Math.abs(p.along - 55.6) < 1, String(p.along));
  assert.equal(p.segment, 0);
  assert.deepEqual([3, 14, 96, 104, 238, 1049, 1234].map(roundDistance), [10, 10, 100, 100, 250, 1000, 1200]);
});

test("categories: tag filters, classification, and an Overpass query around the exact point", () => {
  assert.equal(classify({ amenity: "pharmacy" }), "pharmacy");
  assert.equal(classify({ amenity: "bank", atm: "yes" }, ["atm", "bank"]), "atm", "a bank with a cash machine is found as an ATM when ATMs are asked");
  assert.equal(classify({ amenity: "bank" }, ["atm"]), null);
  assert.equal(classify({ highway: "bus_stop" }), "bus_stop");
  assert.equal(classify({ railway: "station" }), "train_station");
  assert.equal(classify({ shop: "supermarket" }), "supermarket");
  assert.equal(classify({ shop: "shoes" }), "shop");
  assert.equal(classify({ building: "yes" }), null);
  const q = overpassQuery(["pharmacy"], HERE, 800);
  assert.match(q, /^\[out:json\]\[timeout:10\];/);
  assert.match(q, /nwr\(around:800,36\.799300,10\.180200\)\["amenity"="pharmacy"\];/);
  assert.match(q, /out center tags 200;$/);
});

test("Overpass answer: real places only, nearest first, ways by their centre, names in the user's language, nothing made up", () => {
  const json = {
    elements: [
      { type: "node", id: 1, lat: 36.8010, lon: 10.1802, tags: { amenity: "pharmacy", name: "Pharmacie Centrale", "name:ar": "الصيدلية المركزية", "addr:street": "Rue du Caire", "addr:housenumber": "5", opening_hours: "Mo-Sa 08:00-20:00" } },
      { type: "way", id: 2, center: { lat: 36.7995, lon: 10.1803 }, tags: { amenity: "pharmacy" } },
      { type: "node", id: 3, lat: 36.8, lon: 10.18, tags: { amenity: "bench" } },
      { type: "node", id: 4, tags: { amenity: "pharmacy" } }, // no position: dropped
      { type: "node", id: 1, lat: 36.8010, lon: 10.1802, tags: { amenity: "pharmacy" } }, // duplicate
    ],
  };
  const fr = parseOverpass(json, ["pharmacy"], "fr", HERE);
  assert.deepEqual(fr.map((p) => p.osmId), ["w2", "n1"], "nearest first; the bench and the place without a position are not places");
  assert.equal(fr[0].name, null, "no name on the map stays null");
  assert.equal(fr[0].address, null);
  assert.equal(fr[1].name, "Pharmacie Centrale");
  assert.equal(fr[1].address, "5 Rue du Caire");
  assert.equal(fr[1].openingHours, "Mo-Sa 08:00-20:00");
  assert.equal(parseOverpass(json, ["pharmacy"], "tn", HERE)[1].name, "الصيدلية المركزية");
  assert.deepEqual(parseOverpass({ remark: "runtime error" }, ["pharmacy"], "tn", HERE), []);
  assert.deepEqual(parseOverpass(null, ["pharmacy"], "tn", HERE), []);
});

test("Nominatim search (recorded, central Tunis): pharmacies with their real names, sorted by distance", () => {
  const places = parseNominatimSearch(fixture("nominatim-pharmacy.json"), "pharmacy", "fr", HERE);
  assert.ok(places.length >= 5, String(places.length));
  assert.ok(places.every((p) => p.category === "pharmacy" && p.kind === "pharmacy"));
  for (let i = 1; i < places.length; i++) assert.ok(haversine(HERE, places[i - 1]) <= haversine(HERE, places[i]));
  assert.ok(places.some((p) => p.name === "Pharmacie Centrale"));
  // Results of another type are refused, whatever the search returned.
  assert.deepEqual(parseNominatimSearch(fixture("nominatim-pharmacy.json"), "bank", "fr", HERE), []);
});

test("Nominatim reverse (recorded): a short spoken address, and null instead of a guess", () => {
  const r = parseReverse(fixture("nominatim-reverse.json"))!;
  assert.equal(r.road, "نهج اليونان");
  assert.equal(r.name, "بنك تونس العربي الدولي");
  assert.match(r.label!, /^نهج اليونان، /);
  assert.ok(!r.label!.includes("1000"), "no postcode or country in what is said");
  assert.equal(parseReverse({ error: "Unable to geocode" }), null);
  const bare = parseReverse({ address: { country: "تونس" } })!;
  assert.equal(bare.road, null);
});

const route: WalkingRoute = parseOsrm(fixture("osrm-foot.json"))!;

test("OSRM (recorded foot route, 618 m): steps with manoeuvres, street names and a geometry", () => {
  assert.ok(route);
  assert.equal(Math.round(route.distance), 618);
  assert.deepEqual(route.steps.map((s) => `${s.type}:${s.modifier}`), ["depart:right", "turn:left", "turn:left", "turn:right", "turn:left", "arrive:right"]);
  assert.equal(route.steps[2].name, "Rue de Marseille");
  assert.ok(route.geometry.length > 10);
  assert.equal(parseOsrm({ code: "NoRoute" }), null);
  assert.equal(parseOsrm({ code: "Ok", routes: [] }), null);
});

test("directions in four languages, from the route only; no sentence promises safety", () => {
  const step = (type: string, modifier: string | null, name = "", exit: number | null = null): RouteStep => ({ type, modifier, name, distance: 50, duration: 40, location: HERE, exit });
  assert.equal(stepAction(step("turn", "right", "نهج القاهرة"), "tn"), "دور على يمينك في نهج القاهرة");
  assert.equal(stepAction(step("turn", "left"), "ar"), "انعطف إلى اليسار");
  assert.equal(stepAction(step("turn", "slight right", "Rue de Marseille"), "fr"), "serrez légèrement à droite sur Rue de Marseille");
  assert.equal(stepAction(step("end of road", "left"), "en"), "at the end of the street, turn left");
  assert.equal(stepAction(step("roundabout", null, "", 2), "en"), "at the roundabout, take exit number 2");
  assert.equal(stepAction(step("depart", "right", ""), "tn"), "ابدا امشي");
  assert.equal(stepAction(step("arrive", "right"), "tn"), null);
  assert.equal(stepAction(step("turn", "weird-thing"), "en"), "continue straight on", "an unknown modifier never becomes a turn");
  // Everything the app can say about routes, through the same check as the live model's words.
  for (const lang of LANGS) {
    const p = GEO_PHRASES[lang];
    const said: string[] = [];
    for (const v of Object.values(p)) {
      if (typeof v === "string") said.push(v);
      else if (typeof v === "function") said.push((v as (...a: unknown[]) => string)("X", "Y", "Z", "W"));
      else said.push(...Object.values(v as Record<string, string>));
    }
    for (const s of route.steps) said.push(stepAction(s, lang) ?? "");
    for (const text of said) for (const sentence of splitSentences(text)) assert.ok(!isSafetyClaim(sentence), `${lang}: ${sentence}`);
  }
});

// --- the navigator on simulated walks ---------------------------------------------------------------

/** A walk along a line at `speed` m/s, one position a second. */
function walk(line: LatLon[], opts: { speed?: number; accuracy?: number; from?: number; to?: number; t0?: number } = {}): Fix[] {
  const cum = cumulativeLengths(line);
  const total = cum[cum.length - 1];
  const speed = opts.speed ?? 1.2;
  const out: Fix[] = [];
  let i = 0;
  for (let d = opts.from ?? 0, t = opts.t0 ?? 0; d <= (opts.to ?? total); d += speed, t += 1000) {
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const f = (d - cum[i]) / Math.max(1e-9, cum[i + 1] - cum[i]);
    out.push({ lat: line[i].lat + f * (line[i + 1].lat - line[i].lat), lon: line[i].lon + f * (line[i + 1].lon - line[i].lon), accuracy: opts.accuracy ?? 8, at: t });
  }
  return out;
}
const dest = { lat: 36.802851, lon: 10.182755, name: "Pharmacie Centrale" };
const run = (nav: RouteNavigator, fixes: Fix[]) => fixes.flatMap((f) => nav.update(f).map((e) => ({ ...e, at: f.at })));
const instructions = (evs: NavEvent[]) => evs.filter((e): e is Extract<NavEvent, { kind: "instruction" }> => e.kind === "instruction");

test("navigator: a good-GPS walk gets each turn once, in order, «now» at the turn, then arrival", () => {
  const nav = new RouteNavigator(route, dest, "tn");
  assert.match(nav.firstInstruction(), /^ابدا امشي\. بعد حوالي \d+ متر، دور على يسارك\.$/);
  const evs = run(nav, walk(route.geometry));
  const ins = instructions(evs);
  const nows = ins.filter((e) => e.stage === "now");
  assert.deepEqual(nows.map((e) => e.step), [1, 2, 3, 4], "every turn, once, in order");
  assert.match(nows[1].text, /^توّا، دور على يسارك في Rue de Marseille\.$/);
  const keys = ins.map((e) => `${e.stage}:${e.step}`);
  assert.equal(new Set(keys).size, keys.length, "nothing said twice");
  assert.ok(ins.some((e) => e.stage === "destination-ahead"), "the destination is announced as it comes near");
  assert.equal(evs.at(-1)!.kind, "arrived");
  assert.equal(evs.filter((e) => e.kind === "arrived").length, 1);
  assert.ok(!evs.some((e) => e.kind === "off-route" || e.kind === "wrong-way"));
  assert.ok(nav.hasArrived);
  assert.deepEqual(nav.update(walk(route.geometry).at(-1)!), [], "after arrival, silence");
  // A long enough stretch gets «in about … metres» before its turn; never closer than «now».
  for (const n of nows) {
    const prep = ins.find((e) => e.stage === "prepare" && e.step === n.step);
    if (prep) assert.ok((prep as unknown as { at: number }).at < (n as unknown as { at: number }).at);
  }
});

test("navigator: in English, French and MSA the same walk gives the same turns", () => {
  for (const lang of ["en", "fr", "ar"] as const) {
    const ins = instructions(run(new RouteNavigator(route, dest, lang), walk(route.geometry))).filter((e) => e.stage === "now");
    assert.deepEqual(ins.map((e) => e.step), [1, 2, 3, 4], lang);
  }
  const en = instructions(run(new RouteNavigator(route, dest, "en"), walk(route.geometry)));
  assert.equal(en.find((e) => e.stage === "now" && e.step === 3)!.text, "Now, turn right onto نهج المختار عطية.");
});

test("navigator: imprecise GPS — approximate turns between 20 and 40 m, none at all beyond, said once", () => {
  const mid = new RouteNavigator(route, dest, "en");
  const ins = instructions(run(mid, walk(route.geometry, { accuracy: 30 })));
  assert.ok(!ins.some((e) => e.stage === "now"), "no «now» without precise GPS");
  assert.ok(ins.some((e) => e.stage === "approx" && /GPS isn't precise/.test(e.text)));
  const bad = new RouteNavigator(route, dest, "en");
  const evs = run(bad, walk(route.geometry, { accuracy: 80, to: 400 }));
  assert.deepEqual(evs.map((e) => e.kind), ["accuracy-poor"], "said once, then nothing is judged");
  const back = bad.update({ ...walk(route.geometry, { from: 400, to: 401 })[0], accuracy: 6 });
  assert.equal(back[0].kind, "accuracy-ok");
});

test("navigator: leaving the route needs several positions over several seconds, and is reported once", () => {
  const nav = new RouteNavigator(route, dest, "en");
  run(nav, walk(route.geometry, { to: 20 }));
  const off = (n: number, t: number): Fix => ({ lat: route.geometry[0].lat + 0.0006, lon: route.geometry[0].lon + 0.0006, accuracy: 8, at: t + n });
  assert.deepEqual(nav.update(off(0, 30_000)), [], "one wild position is not a deviation");
  assert.deepEqual(nav.update(off(2_000, 30_000)), []);
  const third = nav.update(off(4_000, 30_000));
  assert.deepEqual(third, [], "three positions, but not yet 6 s");
  const fourth = nav.update(off(7_000, 30_000));
  assert.equal(fourth[0]?.kind, "off-route");
  assert.deepEqual(nav.update(off(9_000, 30_000)), [], "not repeated while still off");
  assert.equal(nav.progress?.offRoute, true);
  // With 35 m accuracy the threshold grows (52 m): a position 40 m away is not "off".
  const loose = new RouteNavigator(route, dest, "en");
  const near = (t: number): Fix => ({ lat: route.geometry[0].lat, lon: route.geometry[0].lon + 0.00045, accuracy: 35, at: t });
  assert.ok(![0, 3000, 6000, 9000].flatMap((t) => loose.update(near(t))).some((e) => e.kind === "off-route"));
});

test("navigator: walking back along the route with precise GPS is the wrong way", () => {
  const nav = new RouteNavigator(route, dest, "en");
  run(nav, walk(route.geometry, { from: 0, to: 60 }));
  const back = walk(route.geometry, { from: 30, to: 31, t0: 100_000 });
  const evs = run(nav, [...walk(route.geometry, { from: 32, to: 33, t0: 90_000 }), ...back]);
  assert.ok(evs.some((e) => e.kind === "wrong-way"), JSON.stringify(evs));
  assert.equal(NAV.WRONG_WAY_M, 25);
});

test("addresses: the separator follows the language; a building at the address is «near», never «in»", async () => {
  const json = fixture("nominatim-reverse.json");
  assert.match(parseReverse(json, "en")!.label!, /^نهج اليونان, /);
  assert.match(parseReverse(json, "tn")!.label!, /^نهج اليونان، /);
  assert.equal(GEO_PHRASES.tn.near("البنك"), "قريب من البنك");
  assert.equal(GEO_PHRASES.en.near("the bank"), "near the bank");
});
