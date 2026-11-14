// Nadhra AI step N1 on the server: `provider: "nadhra"` is refused before any network call or budget,
// in every AI_MODE, and is never answered by Gemini. A request without that exact value takes
// today's Gemini path with the same upstream calls. The status names Nadhra only when it is offered.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

const calls: { url: string; body: string }[] = [];
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  calls.push({ url: String(url), body: typeof init?.body === "string" ? init.body : "" });
  if (String(url).includes("auth_tokens")) return new Response(JSON.stringify({ name: "auth_tokens/x" }));
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ spoken: "قدّامك باب." }) }] } }] }), { status: 200 });
}) as typeof fetch;

process.env.GEMINI_API_KEY = "gem-test";
process.env.OPENROUTER_API_KEY = "or-test";
process.env.GEMINI_VISION_MODELS = "model-a,model-b";
process.env.VISION_RATE_LIMIT_PER_MIN = "1000";
console.warn = () => {};

const vision = await import("../src/app/api/vision/route.ts");
const transcribe = await import("../src/app/api/vision/transcribe/route.ts");
const liveToken = await import("../src/app/api/live/token/route.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");
const { requestedFamily, nadhraOffered, nadhraEnabled, nadhraTasks, NADHRA_TASKS } = await import("../src/lib/ai/router.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(80, 1)]).toString("base64");
let n = 0;
const req = (path: string, body: unknown, host = "app.test") =>
  new Request(`http://${host}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...browserHeaders(host === "app.test" ? undefined : host), "x-forwarded-for": `10.8.0.${++n % 250}` }, body: JSON.stringify(body) });

beforeEach(() => {
  calls.length = 0;
  resetVisionCooldowns();
});
afterEach(() => {
  delete process.env.AI_MODE;
  delete process.env.NADHRA_AI_ENABLED;
});

const requests = [
  { mode: "scan", image: JPEG },
  { mode: "question", image: JPEG, question: "شنوة قدّامي؟" },
  { mode: "chat", question: "قدّاش الساعة؟" },
  { mode: "read", image: JPEG, secondImage: JPEG },
  { mode: "question", image: JPEG, question: "قدّاش من حبة نشرب من الدوا؟" },
  { mode: "question", image: JPEG, question: "شنوة قدّامي؟", stream: true },
  { mode: "nonsense" }, // even a malformed request is refused as Nadhra, not validated and sent on
];

test("router: only the exact value \"nadhra\" selects Nadhra AI", () => {
  assert.equal(requestedFamily("nadhra"), "nadhra");
  for (const v of [undefined, null, "", "gemini", "Nadhra", " nadhra", "local", 1, {}, ["nadhra"]]) assert.equal(requestedFamily(v), "gemini", String(v));
});

test("router: Nadhra declares no task in N1", () => {
  assert.deepEqual(NADHRA_TASKS, {});
  assert.deepEqual(nadhraTasks(), []);
});

test("router: Nadhra is offered only when enabled, in any AI_MODE (production included)", () => {
  assert.equal(nadhraEnabled({}), false);
  assert.equal(nadhraEnabled({ NADHRA_AI_ENABLED: "0" }), false);
  assert.equal(nadhraEnabled({ NADHRA_AI_ENABLED: "true" }), true);
  assert.equal(nadhraOffered({}), false, "nothing set (default)");
  assert.equal(nadhraOffered({ NADHRA_AI_ENABLED: "0" }), false);
  assert.equal(nadhraOffered({ NADHRA_AI_ENABLED: "1" }), true, "cloud (default mode)");
  assert.equal(nadhraOffered({ NADHRA_AI_ENABLED: "1", AI_MODE: "cloud" }), true);
  assert.equal(nadhraOffered({ NADHRA_AI_ENABLED: "1", AI_MODE: "hybrid" }), true);
  assert.equal(nadhraOffered({ NADHRA_AI_ENABLED: "1", AI_MODE: "offline" }), true);
  assert.equal(nadhraOffered({ AI_MODE: "hybrid" }), false, "not enabled");
  assert.equal(nadhraOffered({ AI_MODE: "offline" }), false, "not enabled");
});

for (const mode of [undefined, "hybrid", "offline"] as const) {
  for (const enabled of [false, true]) {
    test(`provider nadhra (AI_MODE=${mode ?? "cloud"}, enabled=${enabled}): every request refused, nothing sent anywhere`, async () => {
      if (mode) process.env.AI_MODE = mode;
      if (enabled) process.env.NADHRA_AI_ENABLED = "1";
      for (const body of requests) {
        const res = await vision.POST(req("/api/vision", { ...body, provider: "nadhra" }));
        assert.equal(res.status, 503, JSON.stringify(body).slice(0, 60));
        assert.deepEqual(await res.json(), { error: "nadhra-unavailable" });
      }
      const t = await transcribe.POST(req("/api/vision/transcribe", { audio: WAV, lang: "tn", provider: "nadhra" }));
      assert.equal(t.status, 503);
      assert.deepEqual(await t.json(), { error: "nadhra-unavailable" });
      const live = await liveToken.POST(req("/api/live/token", { provider: "nadhra" }, "localhost"));
      assert.equal(live.status, 503);
      assert.deepEqual(await live.json(), { error: "nadhra-unavailable" });
      assert.deepEqual(calls, [], "no request left the server (Gemini, OpenRouter, Google Live, internet probe)");
    });
  }
}

test("without provider nadhra: the same upstream request as with no provider field at all (Gemini, unchanged)", async () => {
  const bodies: Record<string, { url: string; body: string }[]> = {};
  for (const variant of ["absent", "gemini", "other"] as const) {
    calls.length = 0;
    resetVisionCooldowns();
    const body = { mode: "scan", image: JPEG, ...(variant === "absent" ? {} : { provider: variant }) };
    const res = await vision.POST(req("/api/vision", body));
    assert.equal(res.status, 200, variant);
    const out = await res.json();
    assert.equal(out.provider, "gemini");
    assert.equal(out.analysis.spoken, "قدّامك باب.");
    bodies[variant] = calls.slice();
  }
  assert.ok(bodies.absent.length > 0 && /model-a/.test(bodies.absent[0].url));
  assert.deepEqual(bodies.gemini, bodies.absent);
  assert.deepEqual(bodies.other, bodies.absent);
  assert.ok(!bodies.absent[0].body.includes("nadhra"), "the provider field is not forwarded upstream");
});

test("status: unchanged without NADHRA_AI_ENABLED; with it, only the nadhra field is added (cloud included)", async () => {
  const cloudBefore = await vision.GET().json();
  assert.equal("nadhra" in cloudBefore, false);
  process.env.NADHRA_AI_ENABLED = "1";
  const { nadhra: cloudNadhra, ...cloudRest } = await vision.GET().json();
  assert.deepEqual(cloudNadhra, { experimental: true, tasks: [] }, "cloud: offered, experimental, no task");
  assert.deepEqual(cloudRest, cloudBefore, "cloud: everything else byte-identical (no mode, same providers)");

  process.env.AI_MODE = "hybrid";
  delete process.env.NADHRA_AI_ENABLED;
  assert.equal("nadhra" in (await vision.GET().json()), false, "hybrid, not enabled");
  process.env.NADHRA_AI_ENABLED = "1";
  const hybrid = await vision.GET().json();
  assert.deepEqual(hybrid.nadhra, { experimental: true, tasks: [] });
  assert.deepEqual(hybrid.providers.map((p: { id: string }) => p.id), ["gemini", "openrouter"], "Gemini still offered in hybrid");

  process.env.AI_MODE = "offline";
  const offline = await vision.GET().json();
  assert.deepEqual(offline.nadhra, { experimental: true, tasks: [] });
  assert.deepEqual(offline.providers, [], "offline: no company");
  assert.equal(calls.filter((c) => !/^https:\/\/generativelanguage\.googleapis\.com\/$/.test(c.url)).length, 0, "status calls nothing but hybrid's keyless probe");
});
