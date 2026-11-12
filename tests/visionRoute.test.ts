// /api/vision and its provider chain, with the upstream APIs replaced.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

type Handler = (url: string, body: any) => Response;
let upstream: Handler = () => new Response("down", { status: 503 });
const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  calls.push({ url: String(url), body, headers: init.headers as Record<string, string> });
  return upstream(String(url), body);
}) as typeof fetch;

process.env.GEMINI_API_KEY = "gem-SECRET-1";
process.env.OPENROUTER_API_KEY = "or-SECRET-2";
process.env.GEMINI_VISION_MODELS = "model-a,model-b";
process.env.OPENROUTER_VISION_MODEL = "";
process.env.VISION_RATE_LIMIT_PER_MIN = "1000";
console.warn = () => {};

const { POST, GET } = await import("../src/app/api/vision/route.ts");
const transcribe = await import("../src/app/api/vision/transcribe/route.ts");
const { getVisionProviders, resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(64, 7)]).toString("base64");
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(80, 1)]).toString("base64");

let n = 0;
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request("http://app.test/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...browserHeaders(), "x-forwarded-for": `10.1.0.${++n % 250}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));

const gemini = (json: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }] }), { status: 200 });
const openrouter = (json: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(json) } }] }), { status: 200 });
const scan = { mode: "scan", image: JPEG, cameraFacing: "outward" };

beforeEach(() => {
  calls.length = 0;
  resetVisionCooldowns();
  upstream = () => new Response("down", { status: 503 });
});

test("a valid frame goes to Gemini first, and the answer comes back cleaned", async () => {
  upstream = () => gemini({ spoken: "قدّامك باب. الطريق آمن.", detections: [{ label: "باب", side: "left", confidence: "confirmed" }] });
  const res = await post(scan);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.provider, "gemini");
  assert.equal(data.analysis.spoken, "قدّامك باب.");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const sent = calls[0].body.contents[0].parts;
  assert.equal(sent[0].inlineData.data, JPEG);
  assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
});

test("fallback: on a Gemini failure OpenRouter gets the frame", async () => {
  upstream = (url) => (url.includes("generativelanguage") ? new Response("nope", { status: 500 }) : openrouter({ spoken: "فمّا طاولة." }));
  const data = await (await post(scan)).json();
  assert.equal(data.provider, "openrouter");
  assert.equal(data.analysis.spoken, "فمّا طاولة.");
  assert.ok(calls.at(-1)!.body.messages[1].content[0].image_url.url.startsWith("data:image/jpeg;base64,"));
});

test("an overloaded Gemini model falls through to the next one, and the cooldown is per model", async () => {
  upstream = (url) => (url.includes("model-a") ? new Response("busy", { status: 429 }) : gemini({ spoken: "قدّامك باب." }));
  const data = await (await post(scan)).json();
  assert.equal(data.provider, "gemini");
  assert.equal(data.analysis.spoken, "قدّامك باب.");
  assert.deepEqual(calls.map((c) => c.url.match(/model-[ab]/)?.[0]), ["model-a", "model-b"]);
  calls.length = 0;
  await post(scan);
  assert.deepEqual(calls.map((c) => c.url.match(/model-[ab]/)?.[0]), ["model-b"], "model-a is cooling down");
});

test("unusable model output counts as a failure, and nothing is made up when all providers fail", async () => {
  upstream = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "I see a nice room!" }] } }], choices: [{ message: { content: "not json" } }] }));
  const res = await post(scan);
  assert.equal(res.status, 503);
  const data = await res.json();
  assert.deepEqual(data, { error: "ai-unavailable" });
});

test("upstream error details and keys never reach the client", async () => {
  upstream = () => new Response("Invalid key gem-SECRET-1 for hosayen", { status: 401 });
  const text = await (await post(scan)).text();
  assert.ok(!/SECRET|hosayen|Invalid/.test(text), text);
});

test("rate limits: 429 cools the provider and is reported as such", async () => {
  upstream = () => new Response("slow down", { status: 429 });
  const res = await post(scan);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "rate-limited" });
  assert.ok(res.headers.get("retry-after"));
  const count = calls.length;
  await post(scan);
  assert.equal(calls.length, count, "providers are not called again during the cooldown");
});

test("only a real second frame allows motion claims", async () => {
  upstream = () => gemini({ spoken: "شخص.", hazards: [{ kind: "person", label: "شخص", motion: "approaching", confidence: "likely" }] });
  const one = await (await post(scan)).json();
  assert.equal(one.analysis.hazards[0].motion, "unknown");
  assert.equal(calls[0].body.contents[0].parts.length, 2);
  const two = await (await post({ ...scan, previousImage: JPEG, previousAgeMs: 1500 })).json();
  assert.equal(two.analysis.hazards[0].motion, "approaching");
  assert.equal(calls[1].body.contents[0].parts.length, 3);
  const bad = await (await post({ ...scan, previousImage: PNG, previousAgeMs: 1500 })).json();
  assert.equal(bad.analysis.hazards[0].motion, "unknown");
});

test("webcam facing the user: the question's sides are swapped before the model and the answer's after", async () => {
  upstream = () => gemini({ spoken: "على يسارك طاولة." });
  const data = await (await post({ mode: "question", image: JPEG, cameraFacing: "user", question: "شنوة على يميني؟" })).json();
  assert.ok(calls[0].body.contents[0].parts.at(-1).text.includes("شنوة على يساري؟"));
  assert.equal(data.analysis.spoken, "على يمينك طاولة.");
});

test("input validation", async () => {
  assert.equal((await post("{oops")).status, 400);
  assert.equal((await post({ mode: "scan" })).status, 400);
  assert.equal((await post({ ...scan, image: PNG })).status, 400, "not a JPEG");
  assert.equal((await post({ ...scan, image: "not base64 !!!" + "x".repeat(20) })).status, 400);
  assert.equal((await post({ mode: "question", image: JPEG })).status, 400, "no question");
  assert.equal((await post({ mode: "question", image: JPEG, question: "س".repeat(301) })).status, 400);
  assert.equal((await post({ ...scan, pad: "x".repeat(3.1 * 1024 * 1024) })).status, 413);
  assert.equal((await post(scan, { origin: "https://evil.example" })).status, 403);
  assert.equal(calls.length, 0, "no bad request reached a provider");
});

test("paid models are refused and status names the receivers", async () => {
  assert.deepEqual(await GET().json(), {
    available: true,
    providers: [{ id: "gemini", label: "Google Gemini" }, { id: "openrouter", label: "OpenRouter" }],
    canTranscribe: true,
    canSearch: true,
  });
  process.env.OPENROUTER_VISION_MODEL = "openai/gpt-paid";
  process.env.GEMINI_VISION_MODELS = "gemini-3-pro";
  assert.ok(getVisionProviders().every((p) => p.disabledReason));
  assert.equal((await GET().json()).available, false);
  assert.equal((await post(scan)).status, 503);
  assert.equal(calls.length, 0);
  process.env.OPENROUTER_VISION_MODEL = "";
  process.env.GEMINI_VISION_MODELS = "model-a,model-b";
});

test("transcribe: WAV only, forwarded to the provider that supports audio", async () => {
  const call = (body: unknown) => transcribe.POST(new Request("http://app.test/api/vision/transcribe", {
    method: "POST", headers: { ...browserHeaders(), "x-forwarded-for": `10.2.0.${++n % 250}` }, body: JSON.stringify(body),
  }));
  assert.equal((await call({})).status, 400);
  assert.equal((await call({ audio: JPEG })).status, 400);
  upstream = () => gemini({ speech: true, text: "  شنوة قدّامي؟\n" });
  const res = await call({ audio: WAV });
  assert.deepEqual(await res.json(), { text: "شنوة قدّامي؟" });
  assert.equal(calls[0].body.contents[0].parts[0].inlineData.mimeType, "audio/wav");
  // Words invented for a clip judged to have no voice must not become a question.
  upstream = () => gemini({ speech: false, text: "شنوة قدّامي؟" });
  assert.deepEqual(await (await call({ audio: WAV })).json(), { text: "" });
  upstream = () => gemini({ text: "وينو" });
  assert.deepEqual(await (await call({ audio: WAV })).json(), { text: "" }, "no clear yes means no speech");
  upstream = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "وينو" }] } }] }));
  assert.equal((await call({ audio: WAV })).status, 503, "plain text output isn't trusted");
  upstream = () => new Response("down", { status: 500 });
  assert.equal((await call({ audio: WAV })).status, 503);
});
