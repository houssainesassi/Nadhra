// Streamed answers, camera-off (chat) questions and web search, with the upstream APIs replaced.
// Checks the guarantee that makes streaming safe: every sentence sent early is exactly the start of
// the final, fully checked answer, and nothing the safety checks would change is ever sent early.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { partialJsonString, remainingSpeech, sanitizeAnalysis, sanitizeChat, SentenceStreamer } from "../src/lib/assistant/schema.ts";
import { speech } from "../src/lib/assistant/phrases.ts";
import type { VisionMode } from "../src/lib/assistant/types.ts";
import { browserHeaders } from "./helpers/browser.ts";

type Upstream = (url: string, body: any, signal: AbortSignal) => Response | Promise<Response>;
let upstream: Upstream = () => new Response("down", { status: 503 });
const calls: { url: string; body: any; signal: AbortSignal }[] = [];
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  calls.push({ url: String(url), body, signal: init.signal! });
  return upstream(String(url), body, init.signal!);
}) as typeof fetch;

process.env.GEMINI_API_KEY = "gem-SECRET-1";
process.env.OPENROUTER_API_KEY = "or-SECRET-2";
process.env.GEMINI_VISION_MODELS = "model-a,model-b";
process.env.OPENROUTER_VISION_MODEL = "";
process.env.VISION_RATE_LIMIT_PER_MIN = "1000";
console.warn = () => {};

const { POST, GET } = await import("../src/app/api/vision/route.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]).toString("base64");
const T = speech("tn");
let n = 0;
const post = (body: unknown, signal?: AbortSignal) =>
  POST(new Request("http://app.test/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...browserHeaders(), "x-forwarded-for": `10.2.0.${++n % 250}` },
    body: JSON.stringify(body),
    signal,
  }));

/** Gemini's streaming reply: the text cut into the given pieces, one SSE event each. */
function geminiStream(pieces: string[], opts: { failAfter?: number; grounded?: boolean } = {}) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    async start(c) {
      for (let i = 0; i < pieces.length; i++) {
        if (opts.failAfter === i) return c.error(new Error("connection reset"));
        const last = i === pieces.length - 1;
        const event = { candidates: [{ content: { parts: [{ text: pieces[i] }] }, ...(last && opts.grounded ? { groundingMetadata: { webSearchQueries: ["q"], groundingChunks: [{}] } } : {}) }] };
        c.enqueue(enc.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
        await new Promise((r) => setTimeout(r, 2));
      }
      c.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
const gemini = (text: string) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
/** Cuts a string into pieces of varying size, as a model stream does. */
const cut = (s: string, size: number) => Array.from({ length: Math.ceil(s.length / size) }, (_, i) => s.slice(i * size, (i + 1) * size));

async function readEvents(res: Response) {
  const text = await res.text();
  return text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
}

beforeEach(() => {
  calls.length = 0;
  resetVisionCooldowns();
  upstream = () => new Response("down", { status: 503 });
});

// --- the streamer, on its own ------------------------------------------------------------------

test("partial JSON strings: decoded so far, escapes included, half an escape held back", () => {
  assert.deepEqual(partialJsonString('{"needs_web": false, "spoken": "قدّامك \\"باب\\". فو', "spoken"), { text: 'قدّامك "باب". فو', complete: false });
  assert.deepEqual(partialJsonString('{"spoken": "a\\nb\\u0041"}', "spoken"), { text: "a\nbA", complete: true });
  assert.deepEqual(partialJsonString('{"spoken": "ab\\', "spoken"), { text: "ab", complete: false });
  assert.deepEqual(partialJsonString('{"spoken": "ab\\u00', "spoken"), { text: "ab", complete: false });
  assert.equal(partialJsonString('{"changed": true', "spoken"), null);
});

/** Streams `raw` in pieces and checks: early sentences + rest = the final checked answer, exactly. */
function streamAndCheck(raw: Record<string, unknown>, ctx: { mode: VisionMode; cameraFacing: "outward" | "user"; question?: string }, size: number) {
  const s = new SentenceStreamer(ctx);
  const early: string[] = [];
  for (const piece of cut(JSON.stringify(raw), size)) early.push(...s.push(piece));
  const final = sanitizeAnalysis(raw, { ...ctx, hasMotionEvidence: false, lang: "tn" });
  const rest = remainingSpeech(final.spoken, s.sent);
  assert.equal([...early, rest].filter(Boolean).join(" "), final.spoken, `chunk size ${size}`);
  return { early, rest, final };
}

test("streamer: only finished sentences go early, and early + rest is always the final answer", () => {
  const raw = { needs_web: false, spoken: "قدّامك باب خشب. فوقه كتابة خضراء. على يسارك كرسي.", texts: [] };
  for (const size of [1, 3, 7, 20, 500]) {
    const { early } = streamAndCheck(raw, { mode: "question", cameraFacing: "outward", question: "شنوة قدّامي؟" }, size);
    if (size < 500) assert.deepEqual(early.slice(0, 2), ["قدّامك باب خشب.", "فوقه كتابة خضراء."]);
  }
});

test("streamer: a sentence the safety check would remove stops early sending; the final answer decides", () => {
  const raw = { spoken: "قدّامك شارع. الطريق فارغة. فمّا كرهبة بعيدة.", texts: [] };
  for (const size of [2, 9, 40]) {
    const { early, final } = streamAndCheck(raw, { mode: "question", cameraFacing: "outward", question: "صفلي" }, size);
    assert.deepEqual(early, ["قدّامك شارع."]);
    assert.ok(!final.spoken.includes("فارغة"));
  }
});

test("streamer: a distance read from a sign is held, then kept by the final check because it quotes the scene", () => {
  const raw = { spoken: "فمّا لافتة. مكتوب عليها سوسة 3 km. وفمّا سهم.", texts: [{ content: "سوسة 3 km", confidence: "confirmed" }] };
  const { early, rest, final } = streamAndCheck(raw, { mode: "question", cameraFacing: "outward", question: "شنوة مكتوب؟" }, 5);
  assert.deepEqual(early, ["فمّا لافتة."]);
  assert.ok(rest.includes("سوسة 3 km"));
  assert.ok(final.spoken.includes("سوسة 3 km"));
});

test("streamer: 'nothing in front of you' is never sent without its reminder", () => {
  const raw = { spoken: "ما فمّا حتى شي قدّامك. فمّا حيط بعيد.", texts: [] };
  const { early, rest } = streamAndCheck(raw, { mode: "question", cameraFacing: "outward", question: "صفلي الصورة" }, 4);
  assert.deepEqual(early, []);
  assert.ok(rest.endsWith(T.notSafe));
});

test("streamer: path questions are never streamed: the caveat always comes with the answer", () => {
  const raw = { spoken: "فمّا شارع وكراهب. فمّا ناس على التروتوار.", texts: [] };
  const { early, rest } = streamAndCheck(raw, { mode: "question", cameraFacing: "outward", question: "نجم نقطع الطريق؟" }, 3);
  assert.deepEqual(early, []);
  assert.ok(rest.endsWith(T.pathCaveat));
});

test("streamer: a webcam facing the user holds sentences with left/right until sides are swapped", () => {
  const raw = { spoken: "فمّا طاولة. على يسارك كرسي. فمّا باب.", texts: [] };
  const { early, final } = streamAndCheck(raw, { mode: "question", cameraFacing: "user", question: "صفلي" }, 3);
  assert.deepEqual(early, ["فمّا طاولة."]);
  assert.ok(final.spoken.includes("على يمينك كرسي."));
});

test("streamer: a JSON wrapped in an array, or with fields in another order, still streams", () => {
  const s = new SentenceStreamer({ mode: "question", cameraFacing: "outward", question: "?" });
  const early = cut('[{"changed": true, "spoken": "أول جملة. ثاني جملة. ثالث', 6).flatMap((p) => s.push(p));
  assert.deepEqual(early, ["أول جملة.", "ثاني جملة."]);
});

test("streamer: chat answers drop markdown, never send the camera marker or links early", () => {
  const s = new SentenceStreamer({ mode: "chat", cameraFacing: "outward", question: "عاصمة تونس؟" });
  assert.deepEqual(cut("**تونس** هي العاصمة. فيها برشة عباد. ", 4).flatMap((p) => s.push(p)), ["تونس هي العاصمة."]);
  const marker = new SentenceStreamer({ mode: "chat", cameraFacing: "outward", question: "شنوة قدّامي" });
  assert.deepEqual(cut("[CAMERA]", 2).flatMap((p) => marker.push(p)), []);
  assert.equal(sanitizeChat("[CAMERA]", { lang: "tn" }).needsCamera, true);
  assert.equal(sanitizeChat("شوف https://example.com/x للتفاصيل.", { lang: "tn" }).spoken, "شوف للتفاصيل.");
  assert.equal(sanitizeChat("سوسة على بعد 140 km من تونس.", { lang: "tn" }).spoken, "سوسة على بعد 140 km من تونس.", "facts with distances stay in chat");
  assert.throws(() => sanitizeChat("  ** ", { lang: "tn" }), "an empty answer is a failure, not a made-up one");
});

// --- the route, streaming ------------------------------------------------------------------------

test("stream: sentences arrive before the model has finished, and together they are the checked answer", async () => {
  const json = JSON.stringify({ needs_web: false, spoken: "هذي علبة دواء باراسيتامول. مكتوب عليها 500 mg. تاريخ الصلاحية 03/2027.", texts: [{ content: "PARACETAMOL 500 mg EXP 03/2027", confidence: "confirmed" }] });
  upstream = (url) => (url.includes(":streamGenerateContent?alt=sse") ? geminiStream(cut(json, 11)) : new Response("wrong endpoint", { status: 500 }));
  const res = await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "شنوة هذا؟", stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const events = await readEvents(res);
  const sentences = events.filter((e) => e.type === "sentence").map((e) => e.text);
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.ok(sentences.length >= 1, "at least the first sentence went early");
  assert.equal([...sentences, done.rest].filter(Boolean).join(" "), done.analysis.spoken);
  assert.equal(calls[0].body.contents[0].parts[0].inlineData.data, JPEG, "the frame of this question was analysed");
  assert.ok(calls[0].body.contents[0].parts.at(-1).text.includes("Now (Tunisia time):"), "the model knows the date and time of the question");
});

test("stream: every provider failing before the first sentence gives the usual JSON error", async () => {
  upstream = () => new Response("busy", { status: 429 });
  const res = await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "شنوة؟", stream: true });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "rate-limited" });
});

test("stream: a model failing part-way is reported as interrupted, and no second answer follows", async () => {
  const json = JSON.stringify({ spoken: "قدّامك باب. فوقه كتابة. وعلى يسارك كرسي." });
  upstream = (url) => (url.includes("model-a") ? geminiStream(cut(json, 8), { failAfter: 4 }) : geminiStream([JSON.stringify({ spoken: "جواب ثاني مختلف." })]));
  const events = await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي", stream: true }));
  assert.deepEqual(events.map((e) => e.type), ["sentence", "error"]);
  assert.equal(events[1].error, "interrupted");
  assert.ok(!calls.some((c) => c.url.includes("model-b")), "the next model doesn't add a different answer to a half-spoken one");
});

test("stream: a failure before anything was sent still falls back to the next model", async () => {
  upstream = (url) => (url.includes("model-a") ? new Response("busy", { status: 503 }) : geminiStream(cut(JSON.stringify({ spoken: "قدّامك باب." }), 5)));
  const events = await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي", stream: true }));
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).analysis.spoken, "قدّامك باب.");
});

test("the client going away aborts the model call", async () => {
  let upstreamSignal: AbortSignal | null = null;
  upstream = (_url, _body, signal) => {
    upstreamSignal = signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  };
  const ctrl = new AbortController();
  const pending = post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي", stream: true }, ctrl.signal);
  await new Promise((r) => setTimeout(r, 20));
  ctrl.abort();
  await pending;
  assert.equal(upstreamSignal!.aborted, true);
  assert.equal(calls.filter((c) => c.url.includes("generativelanguage")).length, 1, "no fallback for a cancelled question");
});

// --- camera off, and web search ------------------------------------------------------------------

test("chat: no image is accepted or sent; the model may use Google Search; the answer is plain text", async () => {
  upstream = (url, body) => (url.includes(":streamGenerateContent") && body.tools ? geminiStream(["الطقس في تونس اليوم مشمس. ", "الحرارة حوالي 22 درجة."], { grounded: true }) : new Response("no", { status: 500 }));
  const events = await readEvents(await post({ mode: "chat", cameraFacing: "outward", question: "كيفاش الطقس اليوم في تونس؟", stream: true, image: JPEG }));
  const done = events.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.analysis.usedWeb, true);
  assert.equal([...events.filter((e) => e.type === "sentence").map((e) => e.text), done.rest].filter(Boolean).join(" "), done.analysis.spoken);
  const sent = calls[0].body;
  assert.deepEqual(sent.tools, [{ google_search: {} }]);
  assert.ok(!JSON.stringify(sent.contents).includes(JPEG), "an image sent in chat mode is ignored");
  assert.equal(sent.generationConfig.responseMimeType, undefined);
});

test("chat: a key without search quota still gets an answer, which may not invent live facts; search then rests", async () => {
  upstream = (_url, body) => (body.tools ? new Response("quota", { status: 429 }) : gemini("ما نجمش نثبت في المعلومات الحية توّة."));
  const data = await (await post({ mode: "chat", cameraFacing: "outward", question: "شكون ربح الماتش البارح؟" })).json();
  assert.equal(data.analysis.spoken, "ما نجمش نثبت في المعلومات الحية توّة.");
  assert.equal(data.analysis.usedWeb, false);
  assert.deepEqual(calls.map((c) => !!c.body.tools), [true, false], "same model, retried without search");
  assert.ok(calls[1].body.systemInstruction.parts[0].text.includes("cannot look anything up"), "the model is told it has no search");
  assert.equal((await GET().json()).canSearch, false);
  calls.length = 0;
  await post({ mode: "chat", cameraFacing: "outward", question: "سؤال آخر" });
  assert.deepEqual(calls.map((c) => !!c.body.tools), [false], "search isn't retried on every question");
});

test("chat: a question about the surroundings comes back as 'needs the camera', with nothing made up", async () => {
  upstream = () => gemini("[CAMERA]");
  const data = await (await post({ mode: "chat", cameraFacing: "outward", question: "شنوة قدّامي؟" })).json();
  assert.equal(data.analysis.needsCamera, true);
  assert.equal(data.analysis.spoken, "");
});

test("camera on, live question: the picture's answer is replaced by a web search answer", async () => {
  upstream = (url, body) => {
    if (body.tools) return geminiStream(["الدينار اليوم يساوي 0.32 دولار حسب البحث."], { grounded: true });
    return geminiStream(cut(JSON.stringify({ needs_web: true, spoken: "ما نجمش نعرف السعر توّة.", detections: [{ label: "ورقة نقدية", confidence: "confirmed" }] }), 9));
  };
  const events = await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "قدّاش يسوى الدينار اليوم؟", stream: true }));
  const done = events.at(-1);
  assert.ok(!events.some((e) => e.type === "sentence" && e.text.includes("ما نجمش")), "the picture's 'can't know' answer isn't spoken first");
  assert.equal(done.analysis.usedWeb, true);
  assert.ok(done.analysis.spoken.includes("0.32"));
  assert.equal(done.analysis.detections[0].label, "ورقة نقدية", "what the camera saw is kept");
  assert.ok(calls[1].body.systemInstruction.parts[0].text.includes("camera is on"));
});

test("validation: chat needs a question; scans still need an image", async () => {
  assert.equal((await post({ mode: "chat", cameraFacing: "outward" })).status, 400);
  assert.equal((await post({ mode: "scan", cameraFacing: "outward" })).status, 400);
  assert.equal(calls.length, 0);
});

test("a separate billed key is used for web search only; camera frames keep the main key", async () => {
  process.env.GEMINI_SEARCH_API_KEY = "search-SECRET-3";
  try {
    upstream = (url, body) => (body.tools ? geminiStream(["حسب البحث في الإنترنت، الدينار يساوي 0.32 دولار."], { grounded: true }) : geminiStream([JSON.stringify({ needs_web: true, spoken: "ما نجمش نعرف السعر.", texts: [{ content: "1 DT", confidence: "confirmed" }] })]));
    const keys: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["x-goog-api-key"]);
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const events = await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "قدّاش يسوى هذا اليوم بالدولار؟", stream: true }));
      const done = events.at(-1);
      assert.equal(done.analysis.usedWeb, true);
      assert.deepEqual(keys, ["gem-SECRET-1", "search-SECRET-3"]);
      const searchText = calls[1].body.contents[0].parts.at(-1).text;
      assert.ok(searchText.includes("1 DT"), "the search model is told what the picture showed");
      assert.ok(!JSON.stringify(calls[1].body).includes(JPEG), "but never gets the image");
      assert.ok(typeof done.timing.totalMs === "number" && typeof done.timing.firstTokenMs === "number");
      assert.ok(done.timing.firstTokenMs <= done.timing.totalMs);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    delete process.env.GEMINI_SEARCH_API_KEY;
  }
});

test("prompts: the model is told to describe only the current image and to speak natural Derja", async () => {
  upstream = () => geminiStream([JSON.stringify({ spoken: "قدّامك باب." })]);
  await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي", stream: true, history: [{ q: "صفلي", a: "قدّامك كرسي." }] }));
  const system = calls[0].body.systemInstruction.parts[0].text;
  assert.ok(system.includes("Describe only the image you are given now"));
  assert.ok(system.includes("Do not use general knowledge to fill in what the picture does not show"));
  assert.ok(system.includes("«فمّا» not «يوجد/هناك»"));
  assert.ok(calls[0].body.contents[0].parts.at(-1).text.includes("Arabizi"));
});

test("an overloaded model (503) is skipped for a while, but never when it's the only one left", async () => {
  upstream = (url) => (url.includes("model-a") ? new Response("high demand", { status: 503 }) : geminiStream([JSON.stringify({ spoken: "قدّامك باب." })]));
  await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي", stream: true }));
  calls.length = 0;
  const events = await readEvents(await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي", stream: true }));
  assert.equal(events.at(-1).type, "done");
  assert.deepEqual(calls.map((c) => c.url.match(/model-[ab]/)?.[0]), ["model-b"], "model-a isn't waited for again");
  upstream = () => new Response("high demand", { status: 503 });
  calls.length = 0;
  resetVisionCooldowns();
  await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي" });
  calls.length = 0;
  upstream = (url) => (url.includes("model-a") ? gemini(JSON.stringify({ spoken: "قدّامك باب." })) : new Response("down", { status: 503 }));
  const last = await (await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي" })).json();
  assert.equal(last.analysis.spoken, "قدّامك باب.", "with every model recently overloaded, they are still tried");
});

test("a model that times out is skipped by the next questions too", async () => {
  process.env.VISION_TIMEOUT_MS = "1000";
  try {
    upstream = (url, _body, signal) => (url.includes("model-a")
      ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))
      : gemini(JSON.stringify({ spoken: "قدّامك باب." })));
    const first = await (await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي" })).json();
    assert.equal(first.analysis.spoken, "قدّامك باب.");
    calls.length = 0;
    await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "صفلي" });
    assert.deepEqual(calls.map((c) => c.url.match(/model-[ab]/)?.[0]), ["model-b"]);
  } finally {
    delete process.env.VISION_TIMEOUT_MS;
  }
});

// --- never claiming a search that didn't happen -------------------------------------------------

test("search claims: removed unless the answer really was grounded in a search", async () => {
  const { dropFalseSearchClaims, claimsWebSearch } = await import("../src/lib/assistant/schema.ts");
  for (const s of ["حسب البحث في الإنترنت، الدينار يساوي 0.32 دولار.", "لوجت في الإنترنت وما لقيت شي.", "Selon une recherche sur internet, il fera beau.", "According to a web search, it is sunny.", "I searched online and found nothing."]) {
    assert.ok(claimsWebSearch(s), s);
  }
  for (const s of ["لوجت على الباب في الصورة وما لقيتوش.", "قدّامك باب.", "Il y a une porte devant vous.", "There's a table on your left."]) {
    assert.ok(!claimsWebSearch(s), s);
  }
  assert.equal(dropFalseSearchClaims("حسب البحث، الطقس مشمس. قدّامك باب."), "قدّامك باب.");
  assert.equal(dropFalseSearchClaims("مكتوب: search results.", [{ content: "search results", confidence: "confirmed" }]), "مكتوب: search results.", "text read from the scene stays");
  const T = speech("tn");
  assert.equal(sanitizeChat("حسب البحث في الإنترنت، الطقس اليوم مشمس.", { lang: "tn", usedWeb: false }).spoken, T.noLiveInfo);
  assert.equal(sanitizeChat("حسب البحث في الإنترنت، الطقس اليوم مشمس.", { lang: "tn", usedWeb: true }).spoken, "حسب البحث في الإنترنت، الطقس اليوم مشمس.");
});

test("search claims: an ungrounded answer that claims a search is never spoken, streamed or not", async () => {
  upstream = (_url, body) => (body.tools ? new Response("quota", { status: 429 }) : geminiStream(["حسب البحث في الإنترنت، الترجي ربح 2-0. ", "الماتش كان البارح."]));
  const events = await readEvents(await post({ mode: "chat", cameraFacing: "outward", question: "شكون ربح الماتش البارح؟", stream: true }));
  const done = events.at(-1);
  assert.ok(!events.some((e) => e.type === "sentence" && e.text.includes("حسب البحث")), "not sent early");
  assert.ok(!done.analysis.spoken.includes("حسب البحث"));
  assert.equal(done.analysis.usedWeb, false);
  assert.equal([...events.filter((e) => e.type === "sentence").map((e) => e.text), done.rest].filter(Boolean).join(" "), done.analysis.spoken);
});

test("search claims: a vision answer can't claim a search either", async () => {
  upstream = () => gemini(JSON.stringify({ spoken: "هذي علبة دواء. حسب البحث في الإنترنت سعرها 3 دينار." }));
  const data = await (await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "شنوّة هذا؟" })).json();
  assert.equal(data.analysis.spoken, "هذي علبة دواء.");
});
