// The location tools and walking guidance on the phone (geoController.ts), with a fake GPS and fake
// map routes: consent before anything, what the model gets (never coordinates), the confirmation
// before guidance, the GPS watched only during guidance, signal loss, recalculation, errors.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GeoController, GEO_TIMING, type GeoSayKind } from "../src/lib/geo/geoController.ts";
import { GeoApiError, PositionError, type GeoApi, type PositionErrorCode, type PositionSource } from "../src/lib/geo/client.ts";
import { parseOsrm } from "../src/lib/geo/osm.ts";
import { GEO_PHRASES } from "../src/lib/geo/phrases.ts";
import type { Fix, LatLon, Place, WalkingRoute } from "../src/lib/geo/types.ts";

const route = parseOsrm(JSON.parse(readFileSync(new URL("./fixtures/geo/osrm-foot.json", import.meta.url), "utf8"))) as WalkingRoute;
const START: Fix = { lat: route.geometry[0].lat, lon: route.geometry[0].lon, accuracy: 9, at: 0 };

class FakePosition implements PositionSource {
  fix: Fix | null = START;
  error: PositionErrorCode | null = null;
  calls = 0;
  watching = 0;
  stops = 0;
  onFix: ((f: Fix) => void) | null = null;
  onError: ((c: PositionErrorCode) => void) | null = null;
  async current() {
    this.calls++;
    if (this.error) throw new PositionError(this.error);
    return { ...this.fix! };
  }
  watch(onFix: (f: Fix) => void, onError: (c: PositionErrorCode) => void) {
    this.watching++;
    this.onFix = onFix;
    this.onError = onError;
    return () => {
      this.stops++;
      this.onFix = null;
    };
  }
}

const place = (id: number, lat: number, lon: number, name: string | null): Place => ({ osmId: `n${id}`, lat, lon, name, category: "pharmacy", kind: "pharmacy", address: name ? "Rue du Caire" : null, openingHours: null, phone: null, wheelchair: null });
// The map's own order isn't by distance: Centrale, the far one, then the nearest (no name).
const PLACES = [place(1, 36.802851, 10.182755, "Pharmacie Centrale"), place(2, 36.8035, 10.1840, "Pharmacie Loin"), place(3, 36.7995, 10.1805, null)];

class FakeApi implements GeoApi {
  calls: string[] = [];
  fail: string | null = null;
  partial = false;
  async reverse(at: LatLon) {
    this.calls.push(`reverse:${at.lat}`);
    if (this.fail) throw new GeoApiError(this.fail);
    return { label: "نهج اليونان، باب البحر، تونس", road: "نهج اليونان", houseNumber: null, neighbourhood: "باب البحر", city: "تونس", name: null };
  }
  async nearby(_at: LatLon, category: string) {
    this.calls.push(`nearby:${category}`);
    if (this.fail) throw new GeoApiError(this.fail);
    return { places: PLACES, source: "overpass" as const, partial: this.partial, radius: 1000 };
  }
  async route() {
    this.calls.push("route");
    if (this.fail) throw new GeoApiError(this.fail);
    return route;
  }
}

const made: GeoController[] = [];
test.afterEach(() => {
  for (const g of made.splice(0)) g.destroy();
});

function setup(opts: { consent?: boolean } = {}) {
  let consent = opts.consent ?? true;
  let now = 1_000;
  const said: { text: string; kind: GeoSayKind }[] = [];
  const live: string[] = [];
  const position = new FakePosition();
  const api = new FakeApi();
  const geo = new GeoController({
    lang: () => "tn",
    say: (text, kind) => said.push({ text, kind }),
    onChange: () => {},
    position,
    api,
    consent: { get: () => consent, set: (v) => void (consent = v) },
    toLive: (t) => live.push(t),
    now: () => now,
  });
  made.push(geo);
  return { geo, said, live, position, api, tick: (ms: number) => (now += ms), get now() { return now; }, get consent() { return consent; } };
}
const T = GEO_PHRASES.tn;
const flush = () => new Promise((r) => setTimeout(r, 0));
/** Every number in a tool answer that looks like a coordinate. */
const coordinates = (o: unknown): string[] => [...(JSON.stringify(o).match(/\b(36|10)\.\d{3,}/g) ?? [])];

test("no consent: nothing is located; the notice is said and the model is told to stay quiet; «yes» locates and resumes the conversation", async () => {
  const h = setup({ consent: false });
  const out = await h.geo.runTool("get_current_location", {}, { userTurn: 1 });
  assert.equal(out.response.ok, false);
  assert.equal(out.response.error, "permission_pending");
  assert.equal(out.appSpoke, true, "the phone speaks: the model's words are cut");
  assert.equal(h.position.calls, 0, "the GPS is not touched before consent");
  assert.equal(h.said[0].text, T.consentNotice);
  assert.match(T.consentNotice, /OpenStreetMap/);
  assert.match(T.consentNotice, /جيميني/);
  assert.match(T.consentNotice, /«موافق»/);
  assert.equal(h.geo.state.asking, true);
  h.geo.acceptConsent();
  await flush();
  assert.equal(h.consent, true, "kept on the device");
  assert.equal(h.position.calls, 1, "the browser's own permission is asked right after the yes");
  assert.equal(h.live.length, 1);
  assert.match(h.live[0], /^\[app\] location-allowed/);
});

test("refused: the model's next tools don't ask again for a while, and say so", async () => {
  const h = setup({ consent: false });
  await h.geo.runTool("search_nearby_places", { category: "pharmacy" }, { userTurn: 1 });
  h.geo.declineConsent();
  assert.equal(h.said.at(-1)!.text, T.consentRefused);
  const again = await h.geo.runTool("search_nearby_places", { category: "pharmacy" }, { userTurn: 2 });
  assert.equal(again.response.error, "permission_refused");
  assert.equal(again.appSpoke, false);
  assert.equal(h.said.filter((s) => s.text === T.consentNotice).length, 1, "not asked twice");
  h.tick(GEO_TIMING.REFUSED_QUIET_MS + 1);
  assert.equal((await h.geo.runTool("search_nearby_places", { category: "pharmacy" }, { userTurn: 3 })).response.error, "permission_pending");
  assert.equal(h.position.calls, 0);
});

test("where am I: accuracy and address from the map, no coordinates for the model; one GPS reading reused", async () => {
  const h = setup();
  const loc = await h.geo.runTool("get_current_location", {}, { userTurn: 1 });
  assert.deepEqual({ ...loc.response }, { ok: true, accuracy_m: 9, age_s: 1, quality: "good", navigating: false });
  const rev = await h.geo.runTool("reverse_geocode", {}, { userTurn: 1 });
  assert.equal(rev.response.address, "نهج اليونان، باب البحر، تونس");
  assert.equal(rev.response.approximate, false);
  assert.equal(h.position.calls, 1, "the recent position is reused for the address");
  assert.deepEqual(coordinates(loc.response).concat(coordinates(rev.response)), []);
  assert.equal(h.geo.state.fix?.lat, START.lat, "the phone keeps the position, for its own screen");
});

test("nearby: real names, rounded straight-line distances, nearest first, ids instead of positions; nothing found is said honestly", async () => {
  const h = setup();
  const r = (await h.geo.runTool("search_nearby_places", { category: "pharmacy", limit: 2 }, { userTurn: 1 })).response as any;
  assert.equal(r.ok, true);
  assert.equal(r.places.length, 2);
  assert.deepEqual(r.places.map((p: any) => p.place_id), ["p3", "p1"], "nearest first, whatever order the map gave");
  assert.equal(r.places[0].name, null, "no name stays null: never invented");
  assert.equal(r.places[1].name, "Pharmacie Centrale");
  assert.ok(r.places.every((p: any) => p.distance_m % 10 === 0 && p.distance_m > 0));
  assert.match(r.distances, /straight line/);
  assert.equal(r.list_may_be_incomplete, false);
  assert.deepEqual(coordinates(r), []);
  h.api.partial = true;
  const partial = (await h.geo.runTool("search_nearby_places", { category: "pharmacy" }, { userTurn: 2 })).response as any;
  assert.equal(partial.list_may_be_incomplete, true);
  assert.deepEqual(partial.places.map((p: any) => p.place_id).sort(), ["p1", "p2", "p3"], "the same place keeps its id across searches");
  const details = (await h.geo.runTool("get_place_details", { place_id: "p1" }, { userTurn: 2 })).response as any;
  assert.equal(details.name, "Pharmacie Centrale");
  assert.equal(details.opening_hours, null);
  assert.equal((await h.geo.runTool("get_place_details", { place_id: "p99" }, { userTurn: 2 })).response.error, "unknown_place");
});

test("guidance needs the user's yes in a later turn; then the phone speaks, the GPS is watched, and stopping releases it", async () => {
  const h = setup();
  await h.geo.runTool("search_nearby_places", { category: "pharmacy" }, { userTurn: 1 });
  const calc = (await h.geo.runTool("calculate_walking_route", { place_id: "p1" }, { userTurn: 2 })).response as any;
  assert.equal(calc.ok, true);
  assert.equal(calc.walking_distance_m, 600);
  assert.equal(calc.walking_minutes, 8);
  assert.match(calc.first_direction, /^ابدا امشي/);
  assert.match(calc.note, /ask if they want to start/);
  const early = await h.geo.runTool("start_navigation", { route_id: calc.route_id }, { userTurn: 2 });
  assert.equal(early.response.error, "needs_user_confirmation", "the model can't start in the turn it announced the route");
  assert.equal(h.position.watching, 0);
  const started = await h.geo.runTool("start_navigation", { route_id: calc.route_id }, { userTurn: 3 });
  assert.equal(started.response.started, true);
  assert.equal(started.appSpoke, true);
  assert.equal(h.position.watching, 1, "the GPS is watched only now");
  assert.match(h.said.at(-1)!.text, /^نبداو\. Pharmacie Centrale، حوالي 600 متر على ساقيك، حوالي 8 دقايق\. ابدا امشي/);
  assert.match(h.said.at(-1)!.text, /ما نجّمش نضمن إلي الثنية آمنة/);
  const status = (await h.geo.runTool("get_navigation_status", {}, { userTurn: 4 })).response as any;
  assert.equal(status.active, true);
  assert.equal(status.destination, "Pharmacie Centrale");
  const stop = await h.geo.runTool("stop_navigation", {}, { userTurn: 5 });
  assert.equal(stop.response.was_running, true);
  assert.equal(h.position.stops, 1, "the GPS watch ends with the guidance");
  assert.equal(h.said.at(-1)!.text, T.stopped);
  const again = await h.geo.runTool("stop_navigation", {}, { userTurn: 6 });
  assert.equal(again.response.was_running, false);
  assert.equal(again.appSpoke, false, "nothing said when nothing was running");
  // «go there»: the place discussed last.
  const there = (await h.geo.runTool("calculate_walking_route", {}, { userTurn: 7 })).response as any;
  assert.equal(there.destination, "Pharmacie Centrale");
});

test("during guidance: turns spoken at the turn, signal loss said once and its return, arrival ends the watch", async () => {
  const h = setup();
  await h.geo.search("pharmacy");
  const v = await h.geo.calculateRoute("p1");
  h.geo.startNavigation(v.id);
  const said = () => h.said.map((s) => s.text);
  // Walk to the first turn (~100 m along the route).
  const g = route.geometry;
  for (let k = 0; k <= 30; k++) {
    h.tick(1_100);
    const f = k / 30;
    const seg = Math.min(g.length - 2, Math.floor(f * 3));
    h.position.onFix!({ lat: g[0].lat + (g[seg + 1].lat - g[0].lat) * Math.min(1, f * 1.05), lon: g[0].lon + (g[seg + 1].lon - g[0].lon) * Math.min(1, f * 1.05), accuracy: 6, at: h.now });
  }
  // No position for a while: once, not repeatedly.
  h.tick(GEO_TIMING.SIGNAL_LOST_MS + 1);
  (h.geo as any).checkSignal();
  (h.geo as any).checkSignal();
  assert.equal(said().filter((t) => t === T.signalLost).length, 1);
  assert.equal(h.geo.state.nav?.signal, "lost");
  h.tick(1_000);
  h.position.onFix!({ ...route.geometry.at(-1)!, accuracy: 6, at: h.now });
  assert.ok(said().includes(T.signalBack));
  assert.ok(said().some((t) => t.startsWith("وصلت تقريباً لـPharmacie Centrale")), said().join(" | "));
  assert.equal(h.geo.navigating, false);
  assert.equal(h.position.stops, 1);
  assert.equal(h.geo.state.nav, null);
});

test("off the route: one recalculation, then the new first direction; a failed one is said, and retried later, not on every position", async () => {
  const h = setup();
  await h.geo.search("pharmacy");
  h.geo.startNavigation((await h.geo.calculateRoute("p1")).id);
  const routesBefore = h.api.calls.filter((c) => c === "route").length;
  h.api.fail = "upstream";
  const off = () => {
    h.tick(2_100);
    h.position.onFix!({ lat: START.lat + 0.0007, lon: START.lon + 0.0007, accuracy: 6, at: h.now });
  };
  for (let i = 0; i < 6; i++) off();
  await flush();
  assert.ok(h.said.some((s) => s.text === T.offRoute));
  assert.ok(h.said.some((s) => s.text === T.rerouteFailed));
  assert.equal(h.api.calls.filter((c) => c === "route").length - routesBefore, 1, "one request, not one per position");
  h.api.fail = null;
  for (let i = 0; i < 15; i++) off();
  await flush();
  assert.equal(h.api.calls.filter((c) => c === "route").length - routesBefore, 2, "retried after the gap");
  assert.ok(h.said.some((s) => s.text.startsWith("لقيت طريق جديد.")));
});

test("errors become short answers the model can say: GPS refused, no fix, map service down, too far", async () => {
  const h = setup();
  h.position.error = "denied";
  const d = (await h.geo.runTool("get_current_location", {}, { userTurn: 1 })).response;
  assert.deepEqual([d.ok, d.error, d.user_message], [false, "permission_denied", T.denied]);
  h.position.error = "timeout";
  assert.equal((await h.geo.runTool("reverse_geocode", {}, { userTurn: 1 })).response.user_message, T.timeout);
  h.position.error = null;
  h.api.fail = "upstream";
  const s = (await h.geo.runTool("search_nearby_places", { category: "hospital" }, { userTurn: 1 })).response;
  assert.deepEqual([s.error, s.user_message], ["map_service_unavailable", T.serviceDown]);
  assert.equal(h.geo.state.search.status, "error");
  h.api.fail = null;
  await h.geo.search("pharmacy");
  h.api.fail = "too-far";
  const far = (await h.geo.runTool("calculate_walking_route", { place_id: "p1" }, { userTurn: 2 })).response;
  assert.deepEqual([far.error, far.user_message], ["too_far_to_walk", T.tooFar]);
  assert.equal((await h.geo.runTool("start_navigation", { route_id: "r42" }, { userTurn: 9 })).response.error, "unknown_route");
});

test("GPS permission withdrawn during guidance: it stops and says why; stop tracking forgets the position and the places", async () => {
  const h = setup();
  await h.geo.search("pharmacy");
  h.geo.startNavigation((await h.geo.calculateRoute("p1")).id);
  h.position.onError!("denied");
  assert.equal(h.geo.navigating, false);
  assert.equal(h.said.at(-1)!.text, T.denied);
  h.geo.stopTracking();
  assert.equal(h.geo.state.fix, null);
  assert.deepEqual(h.geo.state.search.places, []);
  assert.equal(h.geo.state.consent, true, "stopping isn't withdrawing consent");
  assert.equal((await h.geo.runTool("get_place_details", { place_id: "p1" }, { userTurn: 3 })).response.error, "unknown_place");
  h.geo.withdrawConsent();
  assert.equal(h.consent, false);
});

test("buttons: the app says the results itself, in the user's language", async () => {
  const h = setup();
  await h.geo.whereAmIByUser();
  assert.equal(h.said.at(-1)!.text, "إنت في نهج اليونان، باب البحر، تونس.");
  await h.geo.searchByUser("pharmacy");
  assert.match(h.said.at(-1)!.text, /^لقيت 3 بلايص\. الأقرب: بلاصة ما عندهاش اسم على الخريطة، حوالي \d+ متر في خط مستقيم\.$/);
  await h.geo.routeByUser("p1");
  assert.match(h.said.at(-1)!.text, /^Pharmacie Centrale: حوالي 600 متر على ساقيك، حوالي 8 دقايق\. اضغط «ابدا التوجيه»/);
  h.position.fix = { ...START, accuracy: 120 };
  await h.geo.refreshByUser();
  await h.geo.whereAmIByUser();
  assert.match(h.said.at(-1)!.text, /البلاصة تقريبية، بفرق حوالي 100 متر\./, "a poor fix is said to be approximate");
});
