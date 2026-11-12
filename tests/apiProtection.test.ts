// Protection of the API routes: same-site Origin, signed session cookie, per-minute limits, daily
// budgets (including the billed web search), content-free monitoring, and the usage stores.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

type Handler = (url: string, body: any) => Response;
let upstream: Handler = () => new Response("down", { status: 503 });
const calls: { url: string; body: any }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  calls.push({ url: String(url), body });
  return upstream(String(url), body);
}) as typeof fetch;

process.env.GEMINI_API_KEY = "gem-SECRET-1";
process.env.GEMINI_VISION_MODELS = "model-a";
process.env.OPENROUTER_API_KEY = "";
const logs: string[] = [];
console.warn = (...a: unknown[]) => void logs.push(a.join(" "));
console.info = (...a: unknown[]) => void logs.push(a.join(" "));

const vision = await import("../src/app/api/vision/route.ts");
const session = await import("../src/app/api/session/route.ts");
const reportRoute = await import("../src/app/api/report/route.ts");
const health = await import("../src/app/api/health/route.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");
const { MemoryStore, UpstashStore, setUsageStore, usageStore } = await import("../src/lib/server/usageStore.ts");
const { issueSessionToken, verifySessionToken, SESSION_COOKIE } = await import("../src/lib/server/session.ts");
const { resetMonitor, snapshot } = await import("../src/lib/server/monitor.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const gemini = (json: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200 });
const scan = { mode: "scan", image: JPEG, cameraFacing: "outward" };

const post = (body: unknown, headers: Record<string, string>) =>
  vision.POST(new Request("http://app.test/api/vision", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }));

const ENV = { ...process.env };
beforeEach(() => {
  process.env = { ...ENV };
  setUsageStore(new MemoryStore());
  resetVisionCooldowns();
  resetMonitor();
  calls.length = 0;
  logs.length = 0;
  upstream = () => gemini({ spoken: "قدّامك باب.", changed: true });
});

test("a request without an Origin (a script) or from another site never reaches the model", async () => {
  const h = browserHeaders();
  delete h.origin;
  assert.equal((await post(scan, h)).status, 403);
  assert.equal((await post(scan, { ...browserHeaders(), origin: "https://evil.example" })).status, 403);
  assert.equal((await post(scan, { ...browserHeaders(), origin: "null" })).status, 403);
  assert.equal(calls.length, 0);
});

test("a request without a valid session cookie is refused with 'session', so the page can open one", async () => {
  const h = browserHeaders();
  const noCookie = { host: h.host, origin: h.origin };
  const res = await post(scan, noCookie);
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "session" });

  const { token } = issueSessionToken();
  const forged = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
  assert.equal((await post(scan, { ...noCookie, cookie: `${SESSION_COOKIE}=${forged}` })).status, 401);
  const old = issueSessionToken(Date.now() - 8 * 24 * 3600 * 1000).token; // expired a day ago
  assert.equal((await post(scan, { ...noCookie, cookie: `${SESSION_COOKIE}=${old}` })).status, 401);
  assert.equal(calls.length, 0);

  assert.equal((await post(scan, h)).status, 200);
});

test("session tokens: signed, expiring, and tied to the server's secret", () => {
  const { token, id } = issueSessionToken();
  assert.equal(verifySessionToken(token), id);
  assert.equal(verifySessionToken(token.replace(id, "AAAAAAAAAAAAAAAA")), null);
  assert.equal(verifySessionToken("v1.x.1.y"), null);
  assert.equal(verifySessionToken(""), null);
  process.env.SESSION_SECRET = "another-secret-that-is-long-enough";
  assert.equal(verifySessionToken(token), null, "a different secret doesn't accept it");
});

test("/api/session sets an HttpOnly, SameSite=Strict cookie (Secure on https) and refuses other sites", async () => {
  const res = await session.GET(new Request("https://app.test/api/session", { headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "10.9.0.1" } }));
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=v1\\.`));
  for (const attr of ["HttpOnly", "SameSite=Strict", "Secure", "Path=/api"]) assert.ok(cookie.includes(attr), attr);

  const dev = await session.GET(new Request("http://localhost/api/session", { headers: { "x-forwarded-for": "10.9.0.2" } }));
  assert.ok(!(dev.headers.get("set-cookie") ?? "").includes("Secure"), "plain http for local development");

  const cross = await session.GET(new Request("https://app.test/api/session", { headers: { "sec-fetch-site": "cross-site" } }));
  assert.equal(cross.status, 403);
});

test("one address can't open endless sessions (each would be a fresh budget)", async () => {
  process.env.SESSIONS_PER_ADDRESS_PER_HOUR = "3";
  const open = () => session.GET(new Request("http://app.test/api/session", { headers: { "x-forwarded-for": "10.9.9.9" } }));
  for (let i = 0; i < 3; i++) assert.equal((await open()).status, 200);
  assert.equal((await open()).status, 429);
  const other = await session.GET(new Request("http://app.test/api/session", { headers: { "x-forwarded-for": "10.9.9.10" } }));
  assert.equal(other.status, 200);
});

test("per-minute limit per session", async () => {
  process.env.VISION_RATE_LIMIT_PER_MIN = "2";
  const h = browserHeaders();
  assert.equal((await post(scan, { ...h, "x-forwarded-for": "10.3.0.1" })).status, 200);
  assert.equal((await post(scan, { ...h, "x-forwarded-for": "10.3.0.2" })).status, 200);
  const third = await post(scan, { ...h, "x-forwarded-for": "10.3.0.3" });
  assert.equal(third.status, 429, "changing the address doesn't help");
  assert.ok(Number(third.headers.get("retry-after")) > 0);
});

test("daily budgets: per session, then for the whole service; the model is never called past them", async () => {
  process.env.DAILY_VISION_PER_SESSION = "2";
  process.env.DAILY_VISION_GLOBAL = "3";
  const a = browserHeaders();
  assert.equal((await post(scan, a)).status, 200);
  assert.equal((await post(scan, a)).status, 200);
  const spent = await post(scan, a);
  assert.equal(spent.status, 503);
  assert.deepEqual(await spent.json(), { error: "quota-exhausted" });

  assert.equal((await post(scan, browserHeaders())).status, 200, "another session still has budget");
  const global = await post(scan, browserHeaders());
  assert.equal(global.status, 503, "the service's daily total is reached");
  assert.equal(calls.length, 3);
});

test("web search (the only billed call) has its own daily budget; without it the question is answered without search", async () => {
  process.env.DAILY_SEARCH_PER_SESSION = "1";
  upstream = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "الطقس اليوم مشمس." }] } }] }), { status: 200 });
  const h = browserHeaders();
  const ask = () => post({ mode: "chat", question: "شنوة الطقس اليوم؟", cameraFacing: "outward" }, h);
  assert.equal((await ask()).status, 200);
  assert.ok(calls[0].body.tools?.[0]?.google_search, "first question may search");
  calls.length = 0;
  assert.equal((await ask()).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.tools, undefined, "budget spent: no search tool offered");
});

test("reports: only known events are counted, codes can't carry content, and nothing is echoed to logs", async () => {
  const send = (events: unknown) =>
    reportRoute.POST(new Request("http://app.test/api/report", { method: "POST", headers: { "Content-Type": "application/json", ...browserHeaders() }, body: JSON.stringify({ events }) }));
  const res = await send([
    { e: "camera-error", c: "denied" },
    { e: "question-failed", c: "شنوة قدّامي؟ my secret question" },
    { e: "made-up-event", c: "x" },
  ]);
  assert.deepEqual(await res.json(), { accepted: 2 });
  const counters = snapshot().counters;
  assert.equal(counters["client.camera-error:denied"], 1);
  assert.equal(counters["client.question-failed:other"], 1);
  assert.ok(!JSON.stringify(counters).includes("made-up"));
  assert.ok(!logs.join("\n").includes("secret"), "content never reaches the log");

  const h = browserHeaders();
  delete h.origin;
  assert.equal((await reportRoute.POST(new Request("http://app.test/api/report", { method: "POST", headers: h, body: "{}" }))).status, 403);
});

test("health: public answer says only ok; with the token, aggregate usage and counters", async () => {
  await post(scan, browserHeaders());
  const open = await (await health.GET(new Request("http://app.test/api/health"))).json();
  assert.deepEqual(open, { ok: true });

  process.env.HEALTH_TOKEN = "health-token-0123456789";
  const wrong = await (await health.GET(new Request("http://app.test/api/health", { headers: { authorization: "Bearer nope" } }))).json();
  assert.deepEqual(wrong, { ok: true });
  const full = await (await health.GET(new Request("http://app.test/api/health", { headers: { authorization: "Bearer health-token-0123456789" } }))).json();
  assert.equal(full.usage.vision.used, 1);
  assert.ok(full.usage.vision.budget > 0);
  assert.equal(full.store, "memory");
  assert.ok(full.counters["vision.request:scan"] >= 1);
  assert.ok(!JSON.stringify(full).includes("10."), "no addresses");
});

test("memory store: counters expire after their window", async () => {
  let now = 1_000_000;
  const s = new MemoryStore(100, () => now);
  assert.deepEqual(await s.incr([{ key: "a", ttlSec: 60 }, { key: "a", ttlSec: 60 }]), [1, 2]);
  now += 59_000;
  assert.deepEqual(await s.peek(["a", "b"]), [2, 0]);
  now += 2_000;
  assert.deepEqual(await s.incr([{ key: "a", ttlSec: 60 }]), [1]);
});

test("Upstash store: one pipeline request with INCR and a fixed expiry; failures fall back to memory", async () => {
  const sent: any[] = [];
  upstream = (url, body) => {
    sent.push({ url, body });
    return new Response(JSON.stringify([{ result: 5 }, { result: 1 }, { result: 2 }, { result: 0 }]), { status: 200 });
  };
  const s = new UpstashStore("https://example.upstash.io/", "tok");
  assert.deepEqual(await s.incr([{ key: "k1", ttlSec: 120 }, { key: "k2", ttlSec: 60 }]), [5, 2]);
  assert.equal(sent[0].url, "https://example.upstash.io/pipeline");
  assert.deepEqual(sent[0].body, [["INCR", "k1"], ["EXPIRE", "k1", 120, "NX"], ["INCR", "k2"], ["EXPIRE", "k2", 60, "NX"]]);

  setUsageStore(null);
  process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
  process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
  upstream = () => new Response("down", { status: 500 });
  const store = usageStore();
  assert.equal(store.kind, "upstash");
  assert.deepEqual(await store.incr([{ key: "x", ttlSec: 60 }]), [1], "the instance's memory answers instead");
  setUsageStore(null);
});
