// The map routes (/api/geo/*) and the live token's tools, with the map services replaced by a fake
// fetch that answers like the real ones (recorded answers in tests/fixtures/geo). Checks: the same
// guard as every paid route, Nadhra and offline mode send nothing, Overpass falls back to Nominatim
// (and says the list may be incomplete), caching, the identifying User-Agent, errors, and that no
// position ever reaches the logs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browserHeaders } from "./helpers/browser.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/geo/${name}`, import.meta.url), "utf8");
const { setUsageStore, MemoryStore } = await import("../src/lib/server/usageStore.ts");
const { clearGeoCaches } = await import("../src/lib/server/geo.ts");
const reverseRoute = await import("../src/app/api/geo/reverse/route.ts");
const nearbyRoute = await import("../src/app/api/geo/nearby/route.ts");
const routeRoute = await import("../src/app/api/geo/route/route.ts");
const { buildLiveSetup, liveConfig } = await import("../src/lib/server/liveToken.ts");

interface Sent { url: string; method: string; ua: string; body: string }
const realFetch = globalThis.fetch;
const saved = { ...process.env };
let sent: Sent[] = [];
let answer: (url: string) => Response | Promise<Response>;
const logs: string[] = [];
const realWarn = console.warn;
const realInfo = console.info;

test.beforeEach(() => {
  process.env = { ...saved, GEMINI_API_KEY: "k", AI_MODE: "cloud", MONITOR_LOG_ALL: "1" };
  delete process.env.GEO_DISABLED;
  setUsageStore(new MemoryStore());
  clearGeoCaches();
  sent = [];
  logs.length = 0;
  console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
  console.info = (...a: unknown[]) => void logs.push(a.join(" "));
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const h = new Headers(init.headers);
    sent.push({ url: String(url), method: init.method ?? "GET", ua: h.get("user-agent") ?? "", body: String(init.body ?? "") });
    return answer(String(url));
  }) as typeof fetch;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  console.info = realInfo;
  process.env = { ...saved };
});

const post = (body: unknown, headers: Record<string, string> = browserHeaders("localhost")) =>
  new Request("http://localhost/api/geo/x", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const ok = (text: string) => new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
const HERE = { lat: 36.7993, lon: 10.1802 };

test("reverse: Nominatim with an identifying User-Agent, a short address back, cached for the same spot", async () => {
  answer = () => ok(fixture("nominatim-reverse.json"));
  const res = await reverseRoute.POST(post({ ...HERE, lang: "tn" }));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.road, "نهج اليونان");
  assert.equal(d.attribution, "© OpenStreetMap contributors");
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?format=jsonv2&zoom=18/);
  assert.match(sent[0].url, /accept-language=ar%2Cfr/);
  assert.match(sent[0].ua, /^Nadhra\/0\.1 \(accessibility assistant/);
  await reverseRoute.POST(post({ lat: 36.79931, lon: 10.18021, lang: "tn" }));
  assert.equal(sent.length, 1, "a position within a few metres is answered from the cache");
});

test("the guard: another site, no session, Nadhra, offline mode and GEO_DISABLED never reach a map service", async () => {
  answer = () => ok(fixture("nominatim-reverse.json"));
  const { cookie } = browserHeaders("localhost");
  assert.equal((await reverseRoute.POST(post(HERE, { host: "localhost", origin: "https://evil.example", cookie }))).status, 403);
  assert.equal((await reverseRoute.POST(post(HERE, { host: "localhost", origin: "http://localhost" }))).status, 401);
  assert.equal((await reverseRoute.POST(post({ ...HERE, provider: "nadhra" }))).status, 503);
  process.env.AI_MODE = "offline";
  assert.equal((await (await nearbyRoute.POST(post({ ...HERE, category: "pharmacy" }))).json()).error, "offline-mode");
  process.env.AI_MODE = "cloud";
  process.env.GEO_DISABLED = "1";
  assert.equal((await routeRoute.POST(post({ from: HERE, to: HERE }))).status, 503);
  assert.equal(sent.length, 0);
});

test("bad input is refused before any call: positions, categories", async () => {
  answer = () => ok("[]");
  assert.equal((await reverseRoute.POST(post({ lat: 91, lon: 10 }))).status, 400);
  assert.equal((await reverseRoute.POST(post({ lat: "36.8", lon: 10 }))).status, 400);
  assert.equal((await reverseRoute.POST(post({ lat: 0, lon: 0 }))).status, 400, "0,0 is a GPS failure, not a place");
  assert.equal((await nearbyRoute.POST(post({ ...HERE, category: "casino" }))).status, 400);
  assert.equal((await routeRoute.POST(post({ from: HERE }))).status, 400);
  assert.equal(sent.length, 0);
});

test("nearby: Overpass first, places nearest first within the radius", async () => {
  answer = (url) =>
    url.includes("overpass")
      ? ok(JSON.stringify({ elements: [
          { type: "node", id: 1, lat: 36.8030, lon: 10.1830, tags: { amenity: "pharmacy", name: "Pharmacie A" } },
          { type: "node", id: 2, lat: 36.7995, lon: 10.1803, tags: { amenity: "pharmacy", name: "Pharmacie B" } },
          { type: "node", id: 3, lat: 36.9, lon: 10.3, tags: { amenity: "pharmacy", name: "Far away" } },
        ] }))
      : ok("[]");
  const d = await (await nearbyRoute.POST(post({ ...HERE, category: "pharmacy", lang: "fr" }))).json();
  assert.equal(d.source, "overpass");
  assert.equal(d.partial, false);
  assert.equal(d.radius, 1000);
  assert.deepEqual(d.places.map((p: { name: string }) => p.name), ["Pharmacie B", "Pharmacie A"]);
  assert.equal(sent[0].method, "POST");
  assert.match(decodeURIComponent(sent[0].body), /nwr\(around:1000,36\.799300,10\.180200\)\["amenity"="pharmacy"\]/);
});

test("nearby: Overpass down → Nominatim, list marked incomplete; Overpass then skipped for a while", async () => {
  answer = (url) => (url.includes("overpass") ? new Response("", { status: 504 }) : ok(fixture("nominatim-pharmacy.json")));
  const d = await (await nearbyRoute.POST(post({ ...HERE, category: "pharmacy", lang: "fr" }))).json();
  assert.equal(d.source, "nominatim");
  assert.equal(d.partial, true);
  assert.ok(d.places.length >= 5);
  assert.ok(d.places.some((p: { name: string }) => p.name === "Pharmacie Centrale"));
  assert.equal(sent.filter((s) => s.url.includes("overpass")).length, 2, "both Overpass servers tried once");
  assert.match(sent.at(-1)!.url, /\/search\?format=jsonv2&amenity=pharmacy&viewbox=/);
  sent = [];
  await nearbyRoute.POST(post({ lat: 36.81, lon: 10.19, category: "pharmacy" }));
  assert.equal(sent.filter((s) => s.url.includes("overpass")).length, 0, "not hammered while it is down");
});

test("nearby: every service down is an error, not an empty list", async () => {
  answer = () => new Response("", { status: 500 });
  const res = await nearbyRoute.POST(post({ ...HERE, category: "hospital" }));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "upstream");
});

test("route: OSRM foot profile, steps and geometry back; no route and too far are distinct; nothing positional in the logs", async () => {
  answer = () => ok(fixture("osrm-foot.json"));
  const to = { lat: 36.802851, lon: 10.182755 };
  const d = await (await routeRoute.POST(post({ from: HERE, to }))).json();
  assert.equal(Math.round(d.route.distance), 618);
  assert.equal(d.route.steps[0].type, "depart");
  assert.match(sent[0].url, /^https:\/\/routing\.openstreetmap\.de\/routed-foot\/route\/v1\/foot\/10\.180200,36\.799300;10\.182755,36\.802851\?steps=true&overview=full&geometries=geojson/);
  answer = () => ok(JSON.stringify({ code: "NoRoute", routes: [] }));
  const none = await routeRoute.POST(post({ from: HERE, to: { lat: 36.81, lon: 10.2 } }));
  assert.equal((await none.json()).error, "no-route");
  sent = [];
  const far = await routeRoute.POST(post({ from: HERE, to: { lat: 36.4, lon: 10.6 } }));
  assert.equal((await far.json()).error, "too-far");
  assert.equal(sent.length, 0, "a place 50 km away isn't even asked about");
  assert.ok(logs.length > 0, "the routes do log their events");
  for (const l of logs) assert.doesNotMatch(l, /36\.\d|10\.\d/, `no position in: ${l}`);
});

test("route: the per-minute limit applies like on every paid route", async () => {
  answer = () => ok(fixture("osrm-foot.json"));
  process.env.GEO_RATE_LIMIT_PER_MIN = "2";
  const h = browserHeaders("localhost");
  const codes: number[] = [];
  for (let i = 0; i < 3; i++) codes.push((await routeRoute.POST(post({ from: HERE, to: { lat: 36.80285 + i / 1e4, lon: 10.182755 } }, h))).status);
  assert.deepEqual(codes, [200, 200, 429]);
});

test("live token: the eight location tools and their instructions are locked in, unless maps are off", () => {
  process.env.GEMINI_API_KEY = "k";
  const on = buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 0 }, liveConfig()) as any;
  const names = on.tools[0].functionDeclarations.map((f: { name: string }) => f.name);
  assert.deepEqual(names, ["get_current_location", "reverse_geocode", "search_nearby_places", "get_place_details", "calculate_walking_route", "start_navigation", "stop_navigation", "get_navigation_status"]);
  assert.match(on.systemInstruction.parts[0].text, /LOCATION AND WALKING DIRECTIONS \(tools\)/);
  assert.match(on.systemInstruction.parts[0].text, /Call start_navigation only after they clearly say yes, in a later turn/);
  process.env.GEO_DISABLED = "1";
  const off = buildLiveSetup({ lang: "tn", facing: "outward", modelIndex: 0 }, liveConfig()) as any;
  assert.equal(off.tools, undefined);
  assert.match(off.systemInstruction.parts[0].text, /You don't know where the user is and have no maps/);
});
