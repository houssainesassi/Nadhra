// AI_MODE end to end on the server routes, with every upstream service replaced: offline mode must
// send nothing anywhere and say why; hybrid without local engines behaves like cloud; cloud is today.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

const calls: string[] = [];
globalThis.fetch = (async (url: string) => {
  calls.push(String(url));
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
const { handleTtsPost, ttsStatus, resetTtsState } = await import("../src/lib/speech/edgeTts.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(80, 1)]).toString("base64");
let n = 0;
const req = (path: string, body: unknown) =>
  new Request(`http://app.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...browserHeaders(), "x-forwarded-for": `10.9.0.${++n % 250}` }, body: JSON.stringify(body) });

beforeEach(() => {
  calls.length = 0;
  resetVisionCooldowns();
  resetTtsState?.();
});
afterEach(() => {
  delete process.env.AI_MODE;
});

const requests = [
  { mode: "scan", image: JPEG },
  { mode: "question", image: JPEG, question: "شنوة قدّامي؟" },
  { mode: "chat", question: "قدّاش الساعة؟" },
  { mode: "read", image: JPEG, secondImage: JPEG },
  { mode: "question", image: JPEG, question: "قدّاش من حبة نشرب من الدوا؟" }, // medicine question → reading rules
];

test("offline: every vision request is refused as offline-mode, before any network call or budget", async () => {
  process.env.AI_MODE = "offline";
  for (const body of requests) {
    const res = await vision.POST(req("/api/vision", body));
    assert.equal(res.status, 503, body.mode);
    assert.deepEqual(await res.json(), { error: "offline-mode" });
  }
  // Streamed questions too.
  const res = await vision.POST(req("/api/vision", { ...requests[1], stream: true }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "offline-mode" });
  assert.deepEqual(calls, [], "nothing left the server");
});

test("offline: status lists no company as a recipient, and says the mode", async () => {
  process.env.AI_MODE = "offline";
  const s = await vision.GET().json();
  assert.equal(s.mode, "offline");
  assert.equal(s.available, false);
  assert.deepEqual(s.providers, []);
  assert.equal(s.canTranscribe, false);
  assert.equal(s.canSearch, false);
});

test("offline: transcription, the cloud voice and live conversation are refused without sending anything", async () => {
  process.env.AI_MODE = "offline";
  const t = await transcribe.POST(req("/api/vision/transcribe", { audio: WAV, lang: "tn" }));
  assert.equal(t.status, 503);
  assert.deepEqual(await t.json(), { error: "offline-mode" });

  assert.equal(ttsStatus().configured, false);
  const tts = await handleTtsPost(req("/api/tts", { text: "مرحبا" }));
  assert.equal(tts.status, 503);

  const live = await liveToken.POST(new Request("http://localhost/api/live/token", { method: "POST", headers: browserHeaders("localhost"), body: "{}" }));
  assert.equal(live.status, 503);
  assert.deepEqual(await live.json(), { error: "offline-mode" });
  assert.equal(liveToken.GET().status, 200);
  assert.equal((await liveToken.GET().json()).configured, false);

  assert.deepEqual(calls, [], "nothing left the server");
});

test("hybrid with no local engine and the internet not known to be down: same as cloud", async () => {
  process.env.AI_MODE = "hybrid";
  const res = await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).provider, "gemini");
  assert.ok(calls.some((u) => /model-a/.test(u)), "Gemini answered");
  // Hybrid mode checks the internet in the background (no key, no quota); cloud mode never does.
  assert.ok(calls.every((u) => /model-a|^https:\/\/generativelanguage\.googleapis\.com\/$/.test(u)), calls.join(" "));
  assert.equal((await vision.GET().json()).mode, "hybrid");
});

test("cloud (default and unknown values): unchanged, the request goes to Gemini", async () => {
  for (const mode of [undefined, "nonsense"]) {
    if (mode) process.env.AI_MODE = mode;
    calls.length = 0;
    const res = await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
    assert.equal(res.status, 200);
    assert.match(calls[0], /generativelanguage\.googleapis\.com.*model-a/);
    const s = await vision.GET().json();
    assert.equal(s.mode, undefined, "the default status is unchanged");
    assert.equal(s.available, true);
    assert.deepEqual(s.providers.map((p: { id: string }) => p.id), ["gemini", "openrouter"]);
    assert.equal(ttsStatus().configured, true);
  }
});
