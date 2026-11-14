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
  // The limit allows the two frames of a reading (up to about 4 MB of base64), and no more.
  assert.equal((await post({ ...scan, pad: "x".repeat(4.3 * 1024 * 1024) })).status, 413);
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

// --- reading documents ---------------------------------------------------------------------------------

// Where the fake model places the lines, and where photo() draws them.
const LINE1 = [200, 100, 300, 700];
const LINE2 = [500, 100, 600, 600];
const BOX_OUTPUT = {
  doc_type: "medicine", legibility: "clear", problems: [],
  lines: [{ text: "FEBRALIX 500 mg", confidence: "confirmed", box: LINE1 }, { text: "EXP 03/2027", confidence: "confirmed", box: LINE2 }],
  // The model "recognised" a well-known brand that isn't printed: it must not be said.
  medicine: { name: "DOLIPRANE", strength: "500 mg", expiry: "EXP 03/2027" },
  explanation: "خوذ 2 حبات كل 4 سوايع.",
};

const JPEG2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 9)]).toString("base64");

const jpeg = (await import("jpeg-js")).default;
/**
 * A real JPEG of a page: text-like strokes inside each box (thousandths, [ymin, xmin, ymax, xmax]).
 * `erase` blanks the right part of a box from that fraction of its width on, as glare does.
 */
function photo(boxes: number[][], opts: { erase?: { box: number; from: number }; shift?: number } = {}): string {
  const W = 600, H = 400;
  const data = Buffer.alloc(W * H * 4, 230);
  for (const [i, [y0, x0, y1, x1]] of boxes.entries()) {
    const ya = Math.round((y0 / 1000) * H), yb = Math.round((y1 / 1000) * H);
    const xa = Math.round((x0 / 1000) * W), xb = Math.round((x1 / 1000) * W);
    const stop = opts.erase?.box === i ? xa + (xb - xa) * opts.erase.from : xb;
    for (let y = ya + Math.round((yb - ya) * 0.2); y < yb - Math.round((yb - ya) * 0.2); y++) {
      for (let x = xa; x < stop; x++) if ((x + (opts.shift ?? 0)) % 6 < 2) data.fill(30, (y * W + x) * 4, (y * W + x) * 4 + 3);
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return Buffer.from(jpeg.encode({ data, width: W, height: H }, 90).data).toString("base64");
}
const PAGE = photo([LINE1, LINE2]);
const PAGE2 = photo([LINE1, LINE2], { shift: 1 });

test("read mode: the reading prompt, temperature 0, not streamed, two readings, and the checks applied", async () => {
  upstream = () => gemini(BOX_OUTPUT);
  const res = await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward", stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /json/, "readings are never streamed");
  const data = await res.json();
  const doc = data.analysis.document;
  assert.equal(doc.kind, "medicine");
  assert.equal(doc.medicine.name, undefined, "a name that isn't printed is dropped");
  assert.equal(doc.medicine.strength, "500 mg");
  assert.ok(!data.analysis.spoken.includes("DOLIPRANE"));
  assert.ok(!data.analysis.spoken.includes("سوايع"), "advice with an invented number is dropped");
  assert.equal(calls[0].body.generationConfig.temperature, 0);
  assert.match(calls[0].body.systemInstruction.parts[0].text, /exactly as it is printed/);
});

test("read mode: a follow-up may come without an image when it brings the document read before", async () => {
  upstream = () => gemini({ lines: [], answer: { about_document: true, found: true, quote: "EXP 03/2027", explanation: "" } });
  const document = { kind: "medicine", lines: ["FEBRALIX 500 mg", "EXP 03/2027", 42] };
  const res = await post({ mode: "read", cameraFacing: "outward", question: "وقتاش يوفى؟", document });
  assert.equal(res.status, 200);
  const sent = calls[0].body.contents[0].parts;
  assert.equal(sent.length, 1, "no image part");
  assert.match(sent[0].text, /\| EXP 03\/2027/);
  assert.ok(!sent[0].text.includes("42"), "non-string lines are dropped");
  assert.match((await res.json()).analysis.spoken, /EXP 03\/2027/);
});

test("read mode: no image is refused without a document and a question, and a bad document doesn't open that door", async () => {
  assert.equal((await post({ mode: "read", cameraFacing: "outward" })).status, 400);
  assert.equal((await post({ mode: "read", cameraFacing: "outward", question: "?" })).status, 400);
  assert.equal((await post({ mode: "read", cameraFacing: "outward", question: "?", document: { kind: "virus", lines: ["x"] } })).status, 400);
  assert.equal((await post({ mode: "read", cameraFacing: "outward", question: "?", document: { kind: "letter", lines: [] } })).status, 400);
  assert.equal((await post({ mode: "read", image: PNG, cameraFacing: "outward" })).status, 400);
  assert.equal(calls.length, 0);
});

test("read mode: unusable output from every provider gives an error, never a made-up reading", async () => {
  upstream = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "FEBRALIX 500 mg" }] } }] }), { status: 200 });
  const res = await post({ mode: "read", image: JPEG, cameraFacing: "outward" });
  assert.equal(res.status, 503);
});

test("double reading: two frames go to two different models at once, and disagreeing numbers are not said", async () => {
  upstream = (url) => gemini({ ...BOX_OUTPUT, lines: [{ text: url.includes("model-a") ? "FEBRALIX 500 mg" : "FEBRALIX 1000 mg", confidence: "confirmed" }], medicine: { name: "FEBRALIX", strength: url.includes("model-a") ? "500 mg" : "1000 mg" } });
  const data = await (await post({ mode: "read", image: JPEG, secondImage: JPEG2, cameraFacing: "outward" })).json();
  const readings = calls.filter((c) => /exactly as it is printed/.test(c.body.systemInstruction?.parts[0].text ?? ""));
  const models = readings.map((c) => c.url.match(/model-[ab]/)?.[0]).sort();
  assert.deepEqual(models, ["model-a", "model-b"], "independent: another model");
  const images = readings.map((c) => c.body.contents[0].parts[0].inlineData.data).sort();
  assert.deepEqual(images, [JPEG, JPEG2].sort(), "independent: another frame");
  assert.equal(data.analysis.document.medicine.strength, undefined);
  assert.equal(data.analysis.document.unconfirmed, true);
  assert.ok(!/500|1000/.test(data.analysis.spoken));
});

test("double reading: one frame only (or a failed second reading) means no dose or date is said", async () => {
  upstream = () => gemini(BOX_OUTPUT);
  const data = await (await post({ mode: "read", image: JPEG, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.strength, undefined);
  assert.equal(data.analysis.document.unconfirmed, true);
});

test("documents never go to OpenRouter, even when Gemini is down", async () => {
  upstream = (url) => (url.includes("generativelanguage") ? new Response("down", { status: 500 }) : openrouter(BOX_OUTPUT));
  const res = await post({ mode: "read", image: JPEG, secondImage: JPEG2, cameraFacing: "outward" });
  assert.equal(res.status, 503);
  assert.ok(calls.length > 0 && calls.every((c) => c.url.includes("generativelanguage")), "no request to OpenRouter");
});

test("F6: a medicine question in question mode is read under the reading rules; in chat mode it is declined without any request", async () => {
  upstream = () => gemini(BOX_OUTPUT);
  const res = await post({ mode: "question", image: JPEG, cameraFacing: "outward", question: "how many pills a day?" });
  const data = await res.json();
  assert.match(calls[0].body.systemInstruction.parts[0].text, /exactly as it is printed/, "the reading prompt, not the scene one");
  assert.ok(data.analysis.document, "a document reading");
  assert.ok(!data.analysis.spoken.includes("500 mg"), "a single frame: no dose");
  calls.length = 0;
  const chat = await (await post({ mode: "chat", cameraFacing: "outward", question: "قداش من حبة ناخذ في النهار؟" })).json();
  assert.equal(calls.length, 0);
  assert.match(chat.analysis.spoken, /ما نجاوبش على الأدوية/);
});

test("pixel check: a dose line whose end is washed out in the picture is not said, though both readings agree", async () => {
  upstream = () => gemini(BOX_OUTPUT);
  // The model claims «FEBRALIX 500 mg» over the whole box; the photo has ink only in its first half.
  const glare = photo([LINE1, LINE2], { erase: { box: 0, from: 0.5 } });
  const data = await (await post({ mode: "read", image: glare, secondImage: PAGE2, cameraFacing: "outward" })).json();
  const doc = data.analysis.document;
  assert.equal(doc.medicine.strength, undefined);
  assert.ok(!data.analysis.spoken.includes("500"));
  assert.deepEqual(doc.obscured, ["incomplete"]);
  assert.ok(data.analysis.spoken.includes(doc.segments.find((s: { text: string }) => s.text.includes("ميّل"))?.text ?? "∅"), "the user is told how to take another picture");
  assert.equal(doc.medicine.expiry, "EXP 03/2027", "the other, whole line is still read");
});

test("pixel check: a line at the edge of the picture is not said", async () => {
  const atEdge = [500, 100, 600, 1000];
  upstream = () => gemini({ ...BOX_OUTPUT, lines: [BOX_OUTPUT.lines[0], { text: "EXP 03/2027", confidence: "confirmed", box: atEdge }] });
  const img = photo([LINE1, atEdge]);
  const data = await (await post({ mode: "read", image: img, secondImage: img, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.expiry, undefined);
  assert.deepEqual(data.analysis.document.obscured, ["edge"]);
});

test("pixel check: a picture that can't be decoded, or lines without a position, means nothing on a medical paper is read", async () => {
  upstream = () => gemini(BOX_OUTPUT);
  const bad = await (await post({ mode: "read", image: JPEG, secondImage: JPEG2, cameraFacing: "outward" })).json();
  assert.ok(!/FEBRALIX|500|2027/.test(bad.analysis.spoken));
  upstream = () => gemini({ ...BOX_OUTPUT, lines: BOX_OUTPUT.lines.map(({ box: _box, ...l }) => l) });
  const nobox = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.ok(!/FEBRALIX|500|2027/.test(nobox.analysis.spoken));
  assert.deepEqual(nobox.analysis.document.obscured, ["no-box"]);
});

test("names are read twice too: a name the second reading has differently is not said", async () => {
  upstream = (url) => gemini({ ...BOX_OUTPUT, lines: [{ text: url.includes("model-a") ? "FEBRALIX 500 mg" : "FEBRAUX 500 mg", confidence: "confirmed", box: LINE1 }, BOX_OUTPUT.lines[1]], medicine: { name: "FEBRALIX", strength: "500 mg", expiry: "EXP 03/2027" } });
  const data = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.name, undefined);
  assert.ok(!/FEBRA/.test(data.analysis.spoken));
  assert.equal(data.analysis.document.unconfirmed, true);
  assert.equal(data.analysis.document.medicine.expiry, "EXP 03/2027");
});

test("test capture: off unless READ_CAPTURE_DIR is set, refused on Vercel, and saves frames, readings and result when on", async () => {
  const { mkdtempSync, readdirSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "nadhra-capture-"));
  const wait = () => new Promise((r) => setTimeout(r, 200));
  upstream = () => gemini(BOX_OUTPUT);
  try {
    await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" });
    await wait();
    assert.equal(readdirSync(dir).length, 0, "off by default");
    process.env.READ_CAPTURE_DIR = dir;
    process.env.VERCEL = "1";
    await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" });
    await wait();
    assert.equal(readdirSync(dir).length, 0, "never on Vercel");
    delete process.env.VERCEL;
    await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" });
    await wait();
    const files = readdirSync(dir).sort();
    assert.equal(files.length, 3, files.join(","));
    const saved = JSON.parse(readFileSync(join(dir, files.find((f) => f.endsWith(".json"))!), "utf8"));
    assert.ok(saved.first && saved.second && saved.analysis.document);
  } finally {
    delete process.env.READ_CAPTURE_DIR;
    delete process.env.VERCEL;
    rmSync(dir, { recursive: true, force: true });
  }
});


// --- locating the first reading's lines with the accurate model (round 5) ---------------------------------

const isLocate = (body: any) => /You locate printed lines/.test(body.systemInstruction?.parts[0].text ?? "");
/** The first reading's boxes drifted (on blank paper); the locating model gives `locate` for its lines. */
function drifted(locate: unknown) {
  const DRIFT = [700, 100, 800, 700]; // blank paper in photo()
  upstream = (url, body) => {
    if (isLocate(body)) return gemini(locate);
    const own = url.includes("model-a") ? DRIFT : LINE1;
    return gemini({ ...BOX_OUTPUT, lines: [{ text: "FEBRALIX 500 mg", confidence: "confirmed", box_2d: own }, { text: "EXP 03/2027", confidence: "confirmed", box_2d: url.includes("model-a") ? DRIFT : LINE2 }] });
  };
}

test("locating: the accurate model is asked where the first reading's lines are, in the first frame, with the exact text", async () => {
  drifted({ boxes: [{ i: 0, box_2d: LINE1 }, { i: 1, box_2d: LINE2 }] });
  await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" });
  const loc = calls.filter((c) => isLocate(c.body));
  assert.equal(loc.length, 1);
  assert.match(loc[0].url, /model-b/, "the second model in the list (the accurate one)");
  assert.equal(loc[0].body.contents[0].parts[0].inlineData.data, PAGE, "frame A");
  assert.match(loc[0].body.contents[0].parts[1].text, /0: FEBRALIX 500 mg\n1: EXP 03\/2027/);
  const readings = calls.filter((c) => !isLocate(c.body)).map((c) => c.url.match(/model-[ab]/)?.[0]).sort();
  assert.deepEqual(readings, ["model-a", "model-b"], "the two readings stay with two different models");
});

test("locating: a drifted box no longer withholds a whole line (coverage)", async () => {
  drifted({ boxes: [{ i: 0, box_2d: LINE1 }, { i: 1, box_2d: LINE2 }] });
  const data = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.strength, "500 mg");
  assert.equal(data.analysis.document.medicine.expiry, "EXP 03/2027");
});

test("locating doesn't weaken the check: a located line that is washed out, missing or said to be not fully visible is still not read", async () => {
  // Washed out where the locator places it.
  drifted({ boxes: [{ i: 0, box_2d: LINE1 }, { i: 1, box_2d: LINE2 }] });
  const glare = photo([LINE1, LINE2], { erase: { box: 0, from: 0.5 } });
  let data = await (await post({ mode: "read", image: glare, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.strength, undefined, "washed out");
  // The locator says it isn't fully visible, or gives nothing for it.
  for (const answer of [{ boxes: [{ i: 0, box_2d: null }, { i: 1, box_2d: LINE2 }] }, { boxes: [{ i: 1, box_2d: LINE2 }] }]) {
    drifted(answer);
    data = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
    assert.equal(data.analysis.document.medicine.strength, undefined, JSON.stringify(answer));
    assert.equal(data.analysis.document.medicine.expiry, "EXP 03/2027");
  }
  // The locator places two different lines in the same spot (the dose on the date's line): neither counts.
  drifted({ boxes: [{ i: 0, box_2d: LINE2 }, { i: 1, box_2d: LINE2 }] });
  data = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.ok(!/500|2027/.test(data.analysis.spoken));
  // The locator places a line on blank paper: faint, not read.
  drifted({ boxes: [{ i: 0, box_2d: [850, 100, 950, 700] }, { i: 1, box_2d: LINE2 }] });
  data = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.strength, undefined);
});

test("locating doesn't overrule evidence: the first reading's own box at the picture edge stays withheld", async () => {
  const atEdge = [200, 100, 300, 1000];
  upstream = (url, body) => (isLocate(body) ? gemini({ boxes: [{ i: 0, box_2d: LINE1 }, { i: 1, box_2d: LINE2 }] }) :
    gemini({ ...BOX_OUTPUT, lines: [{ text: "FEBRALIX 500 mg", confidence: "confirmed", box_2d: url.includes("model-a") ? atEdge : LINE1 }, { text: "EXP 03/2027", confidence: "confirmed", box_2d: LINE2 }] }));
  const data = await (await post({ mode: "read", image: photo([atEdge, LINE2]), secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.strength, undefined);
});

test("locating fails: exactly the behaviour before (the first reading's own boxes)", async () => {
  upstream = (url, body) => (isLocate(body) ? new Response("busy", { status: 503 }) : gemini(BOX_OUTPUT));
  const data = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(data.analysis.document.medicine.strength, "500 mg");
  upstream = (url, body) => (isLocate(body) ? new Response("busy", { status: 503 }) : gemini({ ...BOX_OUTPUT, lines: [{ ...BOX_OUTPUT.lines[0], box_2d: [700, 100, 800, 700] }, BOX_OUTPUT.lines[1]] }));
  const drift = await (await post({ mode: "read", image: PAGE, secondImage: PAGE2, cameraFacing: "outward" })).json();
  assert.equal(drift.analysis.document.medicine.strength, undefined, "a drifted own box is still refused when nobody located it");
});

test("withLocatedBoxes: index matching, missing → null, overlapping placements → null, malformed answers ignored", async () => {
  const { withLocatedBoxes } = await import("../src/lib/ai/vision.ts");
  const reading = { lines: [{ text: "A" }, { text: "B" }, { text: "C" }] };
  const out = withLocatedBoxes(reading, { boxes: [{ i: 0, box_2d: [100, 100, 150, 500] }, { i: 2, box_2d: [300, 100, 350, 500] }] }).lines as Record<string, unknown>[];
  assert.deepEqual(out.map((l) => l.located_box), [[100, 100, 150, 500], null, [300, 100, 350, 500]]);
  const clash = withLocatedBoxes(reading, { boxes: [{ i: 0, box_2d: [100, 100, 150, 500] }, { i: 1, box_2d: [105, 120, 150, 480] }, { i: 2, box_2d: [300, 100, 350, 500] }] }).lines as Record<string, unknown>[];
  assert.deepEqual(clash.map((l) => l.located_box), [null, null, [300, 100, 350, 500]]);
  assert.equal(withLocatedBoxes(reading, { nope: 1 }), reading, "no usable answer: the reading is unchanged");
});
