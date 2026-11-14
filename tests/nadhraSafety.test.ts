// The three safety fixes before N2 (docs/NADHRA_N1_SAFETY_PROPOSAL.md), on the server side and in
// the live session:
//   2. no connectivity request by default (passive reachability; an external probe only when opted in)
//   3. a page that has gone (closed, or switched to Nadhra) stops the work: no next provider for a
//      recording or a question, no retry and no new connection for the cloud voice, and a live token
//      that arrives after the switch opens nothing.
// Every network call is replaced; nothing leaves the machine.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";

/** What the fake network does with calls to `model-a` (the first provider). */
let modelA: "ok" | "hang" | "network-error" | "http-500" = "ok";
/** Every cloud call fails at the network level (no connection at all). */
let networkDown = false;
const calls: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  calls.push(u);
  if (networkDown) throw new TypeError("fetch failed");
  const answer = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ spoken: "قدّامك باب.", text: "عسلامة" }) }] } }] }), { status: 200 });
  if (!u.includes("model-a")) return answer();
  if (modelA === "network-error") throw new TypeError("fetch failed");
  if (modelA === "http-500") return new Response("boom", { status: 500 });
  if (modelA === "hang") {
    return new Promise<Response>((_, reject) => {
      const s = init?.signal;
      if (s?.aborted) return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      s?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    });
  }
  return answer();
}) as typeof fetch;

process.env.GEMINI_API_KEY = "gem-test";
process.env.OPENROUTER_API_KEY = "or-test";
process.env.GEMINI_VISION_MODELS = "model-a,model-b";
process.env.VISION_RATE_LIMIT_PER_MIN = "1000";
delete process.env.INTERNET_PROBE_URL;
console.warn = () => {};
console.error = () => {};

const vision = await import("../src/app/api/vision/route.ts");
const transcribe = await import("../src/app/api/vision/transcribe/route.ts");
const dc = await import("../src/lib/server/deviceCapabilities.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");
const { handleTtsPost, resetTtsState, setWsFactory } = await import("../src/lib/speech/edgeTts.ts");
const { LiveSession } = await import("../src/lib/live/session.ts");
const api = await import("../src/lib/assistant/api.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(80, 1)]).toString("base64");
let n = 0;
const req = (path: string, body: unknown, signal?: AbortSignal) =>
  new Request(`http://app.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...browserHeaders(), "x-forwarded-for": `10.7.0.${++n % 250}` }, body: JSON.stringify(body), signal });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isGoogleRoot = (u: string) => /^https:\/\/generativelanguage\.googleapis\.com\/?$/.test(u);

beforeEach(() => {
  calls.length = 0;
  modelA = "ok";
  networkDown = false;
  resetVisionCooldowns();
  dc.resetDeviceCapabilities();
  resetTtsState?.();
});
afterEach(() => {
  delete process.env.AI_MODE;
  delete process.env.INTERNET_PROBE_URL;
  delete process.env.NADHRA_AI_ENABLED;
  api.setLocalOnly(false);
});

// --- 2. connectivity ----------------------------------------------------------------------------------

test("hybrid by default: no connectivity request at all (status, routing, Nadhra requests)", async () => {
  process.env.AI_MODE = "hybrid";
  process.env.NADHRA_AI_ENABLED = "1";
  for (let i = 0; i < 3; i++) await vision.GET().json();
  assert.equal(dc.internetForRouting("hybrid"), undefined);
  const nadhra = await vision.POST(req("/api/vision", { provider: "nadhra", mode: "scan", image: JPEG }));
  assert.equal(nadhra.status, 503);
  await wait(20);
  assert.deepEqual(calls, [], "nothing sent: no probe, no provider");
  // A Gemini request goes to Gemini only: still no separate connectivity request.
  const gemini = await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
  assert.equal(gemini.status, 200);
  await wait(20);
  assert.ok(calls.length > 0 && calls.every((u) => /model-a/.test(u)), calls.join(" "));
  assert.ok(!calls.some(isGoogleRoot));
});

test("passive: real Gemini requests failing at the network level mark the internet down; a minute later it is unknown again", async () => {
  process.env.AI_MODE = "hybrid";
  networkDown = true;
  await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
  assert.equal(dc.internetKnown(), false);
  calls.length = 0;
  const refused = await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
  assert.deepEqual(await refused.json(), { error: "no-internet" });
  assert.deepEqual(calls, [], "refused without trying the cloud, and without a probe");
  assert.equal(dc.internetForRouting("hybrid", Date.now() + 61_000), undefined, "expires: the cloud may be tried again");
});

test("passive: when one provider fails at the network level but the next one answers, the internet counts as up", async () => {
  process.env.AI_MODE = "hybrid";
  modelA = "network-error";
  await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
  assert.equal(dc.internetKnown(), true);
});

test("passive: any HTTP answer (even an error status) marks the internet up; an aborted request says nothing", async () => {
  process.env.AI_MODE = "hybrid";
  modelA = "http-500";
  await vision.POST(req("/api/vision", { mode: "scan", image: JPEG }));
  assert.equal(dc.internetKnown(), true);
  dc.resetDeviceCapabilities();
  dc.noteCloudReachable(false);
  assert.equal(dc.internetKnown(), false);
});

test("a Nadhra request never reads or changes the connectivity state", async () => {
  process.env.AI_MODE = "hybrid";
  process.env.NADHRA_AI_ENABLED = "1";
  await vision.POST(req("/api/vision", { provider: "nadhra", mode: "question", image: JPEG, question: "?" }));
  assert.equal(dc.internetKnown(), null);
});

test("opt-in INTERNET_PROBE_URL: probed by routing only (never by the status request), and only that URL", async () => {
  process.env.AI_MODE = "hybrid";
  process.env.INTERNET_PROBE_URL = "http://router.local/";
  await vision.GET().json();
  await wait(20);
  assert.deepEqual(calls, [], "the status request starts no probe");
  dc.internetForRouting("hybrid");
  await wait(20);
  assert.deepEqual(calls, ["http://router.local/"]);
});

test("cloud and offline modes: never any connectivity request", async () => {
  for (const mode of [undefined, "offline"]) {
    if (mode) process.env.AI_MODE = mode;
    else delete process.env.AI_MODE;
    calls.length = 0;
    await vision.GET().json();
    assert.equal(dc.internetForRouting(mode === "offline" ? "offline" : "cloud"), undefined);
    await wait(10);
    assert.deepEqual(calls, []);
  }
});

// --- 3. a page that has gone stops the work ---------------------------------------------------------------

test("transcription: aborted by the page while the first provider works → the recording goes to no other provider", async () => {
  modelA = "hang";
  const ac = new AbortController();
  const pending = transcribe.POST(req("/api/vision/transcribe", { audio: WAV, lang: "tn" }, ac.signal));
  await wait(30);
  assert.deepEqual(calls.map((u) => (/model-a/.test(u) ? "model-a" : u)), ["model-a"]);
  ac.abort();
  const res = await pending;
  await wait(30);
  assert.equal(res.status, 499);
  assert.ok(!calls.some((u) => /model-b|openrouter/.test(u)), calls.join(" "));
});

test("question: aborted by the page during the first provider → no fallback to Gemini's next model or OpenRouter", async () => {
  modelA = "hang";
  const ac = new AbortController();
  const pending = vision.POST(req("/api/vision", { mode: "question", image: JPEG, question: "شنوة قدّامي؟" }, ac.signal));
  await wait(30);
  ac.abort();
  await pending;
  await wait(30);
  assert.ok(calls.length >= 1 && calls.every((u) => /model-a/.test(u)), calls.join(" "));
});

// The cloud voice: a socket that is refused (a "handshake" failure, which is normally retried once).
const sockets: string[] = [];
class RefusingWs {
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(url: string) {
    sockets.push(url);
    setTimeout(() => {
      this.onerror?.({});
      this.onclose?.({ code: 1006, reason: "" });
    }, 40);
  }
  send() {}
  close() {}
}

test("cloud voice: aborted by the page during a refused handshake → no retry, no new connection", async () => {
  setWsFactory(() => new RefusingWs("wss://speech") as never);
  sockets.length = 0;
  const ac = new AbortController();
  const pending = handleTtsPost(req("/api/tts", { text: "قريت: دوا." }, ac.signal));
  await wait(10);
  ac.abort();
  const res = await pending;
  await wait(100);
  assert.equal(res.status, 499);
  assert.equal(sockets.length, 1, "the first connection only: no retry after the page went away");
});

test("cloud voice: a request already aborted opens no connection at all", async () => {
  setWsFactory(() => new RefusingWs("wss://speech") as never);
  sockets.length = 0;
  const ac = new AbortController();
  ac.abort();
  const res = await handleTtsPost(req("/api/tts", { text: "مرحبا" }, ac.signal));
  assert.equal(res.status, 499);
  assert.equal(sockets.length, 0);
});

test("cloud voice: without an abort, a refused handshake is still retried once (Gemini's behaviour unchanged)", async () => {
  setWsFactory(() => new RefusingWs("wss://speech") as never);
  sockets.length = 0;
  await handleTtsPost(req("/api/tts", { text: "مرحبا" }));
  assert.equal(sockets.length, 2);
});

// The live conversation: a token answer that arrives after the switch to Nadhra.
class CountingWs {
  static made = 0;
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  constructor() {
    CountingWs.made++;
  }
  send() {}
  close() {}
}

function lateTokenSession() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = new LiveSession({
    lang: "tn",
    facing: "outward",
    WebSocketImpl: CountingWs as unknown as typeof WebSocket,
    maxReconnects: 0,
    fetchImpl: (async () => {
      await gate;
      return new Response(JSON.stringify({ token: "t", url: "wss://live", setup: {}, model: "m", voice: "v", lastModel: true }));
    }) as typeof fetch,
  });
  return { s, release };
}

test("live: a token that arrives after the switch to Nadhra opens no connection (even if the session wasn't stopped)", async () => {
  CountingWs.made = 0;
  const { s, release } = lateTokenSession();
  const started = s.start();
  await wait(5);
  api.setLocalOnly(true); // the switch
  release();
  await assert.rejects(started, /nadhra-unavailable/);
  await wait(10);
  assert.equal(CountingWs.made, 0);
  assert.equal(s.status, "closed");
});

test("live: a token that arrives after the session was stopped opens no connection", async () => {
  CountingWs.made = 0;
  const { s, release } = lateTokenSession();
  const started = s.start();
  await wait(5);
  s.stop();
  release();
  await started;
  await wait(10);
  assert.equal(CountingWs.made, 0);
});
