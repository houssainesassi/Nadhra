// DeviceCapabilities (src/lib/server/deviceCapabilities.ts): machine facts, the hybrid-only internet
// probe, and how the router uses it. Every network call is replaced.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

const calls: string[] = [];
let network: "up" | "down" = "up";
globalThis.fetch = (async (url: string) => {
  calls.push(String(url));
  if (network === "down") throw new TypeError("fetch failed");
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ spoken: "قدّامك باب." }) }] } }] }), { status: 200 });
}) as typeof fetch;

process.env.GEMINI_API_KEY = "gem-test";
process.env.GEMINI_VISION_MODELS = "model-a";
process.env.VISION_RATE_LIMIT_PER_MIN = "1000";
process.env.HEALTH_TOKEN = "health-token-0123456789";
process.env.INTERNET_PROBE_URL = "https://probe.test/";
console.warn = () => {};

const dc = await import("../src/lib/server/deviceCapabilities.ts");
const vision = await import("../src/app/api/vision/route.ts");
const health = await import("../src/app/api/health/route.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
let n = 0;
const scan = () =>
  vision.POST(new Request("http://app.test/api/vision", { method: "POST", headers: { "Content-Type": "application/json", ...browserHeaders(), "x-forwarded-for": `10.7.0.${++n % 250}` }, body: JSON.stringify({ mode: "scan", image: JPEG }) }));

beforeEach(() => {
  calls.length = 0;
  network = "up";
  dc.resetDeviceCapabilities();
  resetVisionCooldowns();
});
afterEach(() => {
  delete process.env.AI_MODE;
});

test("memory: MemAvailable is read from /proc/meminfo", () => {
  assert.equal(dc.parseMemAvailableMB("MemTotal:  8000000 kB\nMemFree:  100000 kB\nMemAvailable:    2516582 kB\n"), 2458);
  assert.equal(dc.parseMemAvailableMB("MemTotal: 1 kB\n"), null);
});

test("temperature: the hottest plausible zone, null when the system has none", () => {
  const files: Record<string, string> = {
    "/sys/class/thermal/thermal_zone0/temp": "41000\n",
    "/sys/class/thermal/thermal_zone1/temp": "67500\n",
    "/sys/class/thermal/thermal_zone2/temp": "999999\n", // broken sensor
  };
  const deps = { readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]; }, readDir: () => ["thermal_zone0", "thermal_zone1", "thermal_zone2", "cooling_device0"] };
  assert.equal(dc.hottestZoneC(deps), 67.5);
  assert.equal(dc.hottestZoneC({ readDir: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(dc.hottestZoneC({ readDir: () => [] }), null);
});

test("deviceInfo on this machine: real numbers, AI mode, and no probe in cloud mode", () => {
  const d = dc.deviceInfo();
  assert.ok(["x64", "arm64"].includes(d.arch), d.arch);
  assert.ok(d.cpuCount >= 1);
  assert.ok(d.memTotalMB > 0 && d.memAvailableMB > 0 && d.memAvailableMB <= d.memTotalMB);
  assert.equal(d.aiMode, "cloud");
  assert.equal(d.internet, null);
  assert.deepEqual(calls, []);
});

test("probe: any HTTP answer is reachable, a network failure is not; concurrent callers share one probe", async () => {
  let hits = 0;
  const ok = (async () => { hits++; return new Response("", { status: 404 }); }) as unknown as typeof fetch;
  const [a, b] = await Promise.all([dc.probeInternet(ok), dc.probeInternet(ok)]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(hits, 1);
  assert.equal(dc.internetKnown(), true);
  const fail = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.equal(await dc.probeInternet(fail), false);
  assert.equal(dc.internetKnown(), false);
});

test("cloud and offline modes never probe; hybrid probes in the background and reuses the answer", async () => {
  assert.equal(dc.internetForRouting("cloud"), undefined);
  assert.equal(dc.internetForRouting("offline"), undefined);
  await flush();
  assert.deepEqual(calls, [], "no probe outside hybrid mode");

  network = "down";
  assert.equal(dc.internetForRouting("hybrid"), undefined, "unknown until the first probe ends");
  await flush();
  assert.deepEqual(calls, ["https://probe.test/"]);
  assert.equal(dc.internetForRouting("hybrid"), false);
  await flush();
  assert.equal(calls.length, 1, "a fresh answer is reused");
  network = "up";
  dc.internetForRouting("hybrid", Date.now() + 31_000); // stale: probe again
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(dc.internetForRouting("hybrid"), true);
});

test("hybrid, internet known to be down, nothing local: the scan is refused as no-internet without trying the cloud", async () => {
  process.env.AI_MODE = "hybrid";
  dc.resetDeviceCapabilities({ internet: false });
  const res = await scan();
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "no-internet" });
  assert.ok(!calls.some((u) => u.includes("generativelanguage")), "no cloud call");
});

test("hybrid, internet up: the scan goes to the cloud as usual", async () => {
  process.env.AI_MODE = "hybrid";
  dc.resetDeviceCapabilities({ internet: true });
  const res = await scan();
  assert.equal(res.status, 200);
  assert.ok(calls.some((u) => u.includes("model-a")));
});

test("health: device facts and per-task routing only with the token", async () => {
  const pub = await (await health.GET(new Request("http://app.test/api/health"))).json();
  assert.deepEqual(pub, { ok: true });
  process.env.AI_MODE = "offline";
  const res = await health.GET(new Request("http://app.test/api/health", { headers: { authorization: "Bearer health-token-0123456789" } }));
  const d = await res.json();
  assert.equal(d.device.aiMode, "offline");
  assert.ok(d.device.memTotalMB > 0);
  assert.equal(d.ai.mode, "offline");
  assert.deepEqual(d.ai.tasks.scan, { providers: [], refusal: "offline-mode" });
  assert.equal(JSON.stringify(d).includes("gem-test"), false, "no key in the output");
  delete process.env.AI_MODE;
  const cloud = await (await health.GET(new Request("http://app.test/api/health", { headers: { authorization: "Bearer health-token-0123456789" } }))).json();
  assert.deepEqual(cloud.ai.tasks.read.providers, [{ id: "gemini:model-a", locality: "cloud", support: "full" }]);
  assert.deepEqual(calls, [], "health never probes or calls a provider");
});
