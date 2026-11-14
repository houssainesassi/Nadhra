// Response quality: the language an answer is given in (Tunisian Derja in Arabic script and in
// Arabizi, mixed Arabic/French/English, short follow-ups), the answer rules every question prompt
// carries, and what reaches the model and the user in multi-turn, ambiguous, incomplete and factual
// questions. The model is replaced: nothing here touches the network or the Gemini quota.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { browserHeaders } from "./helpers/browser.ts";
import { questionLang, type SpeechLang } from "../src/lib/assistant/lang.ts";
import { buildChatText, buildUserText, chatSystemPrompt } from "../src/lib/assistant/prompts.ts";
import { speech } from "../src/lib/assistant/phrases.ts";

// --- the language of the answer ----------------------------------------------------------------

const ALL: SpeechLang[] = ["tn", "ar", "fr", "en"];
const expectLang = (cases: string[], want: SpeechLang, chosen: SpeechLang[] = ALL) => {
  for (const q of cases) for (const c of chosen) assert.equal(questionLang(q, c), want, `«${q}» with ${c} chosen`);
};

test("language: Tunisian Derja in Arabic script is answered in Derja, whatever the setting", () => {
  expectLang([
    "وين الباب؟", "قداه الساعة؟", "شنيا هذا", "كيفاه نمشي للمحطة", "عسلامة", "شبيك", "آش مكتوب",
    "بربي عاودلي", "فمّاش حد قدّامي؟", "شنوا الطقس اليوم", "شنوّة اللي قدّامي؟", "اقراهالي يعيشك",
  ], "tn");
});

test("language: vowel marks and shadda don't hide a Derja word", () => {
  expectLang(["شَنُوَّة هَاذَا؟", "قدّاش", "فـمّا"], "tn");
});

test("language: Derja in Latin letters (Arabizi), with its many spellings, is Derja", () => {
  expectLang([
    "chnoua ely 9odemi", "chnowa lwa9t taw", "9adeh essa3a?", "kifech nemchi lel gare?", "chkoun 9alek",
    "win el bab?", "fama 7ad 9odemi?", "a9rali hedhi", "chbik", "labes 3lik?", "aychek", "brabi 3awed",
    "wesh mektoub", "chnouwa", "kadeh el soum", "chouf chnowa fama", "w ba3d?", "slm, kifeh na7el el camera?",
  ], "tn");
});

test("language: Derja mixed with French or English words stays Derja", () => {
  expectLang([
    "chnia el météo lyoum", "est-ce que fama pharmacie 9rib?", "c'est quoi hedha", "nheb na3ref el prix mta3 hedha",
    "نحب نعرف el prix", "شنوة هذا le truc?",
  ], "tn");
});

test("language: plain French, English and Standard Arabic are not taken for Derja", () => {
  expectLang(["I win every time", "meet me at 3pm today", "What is the weather in Tunis today?", "Can you read this for me"], "en", ["tn", "fr", "ar", "en"]);
  expectLang(["c'est l'heure de partir", "il fait 5km à pied", "Quel temps fait-il à Sousse ?", "la porte est où"], "fr", ["tn", "fr", "ar", "en"]);
  expectLang(["ما هو الطقس اليوم في تونس؟", "هل يمكنك أن تخبرني ما هو الطقس اليوم؟", "كم الساعة الآن؟"], "ar", ["ar", "fr", "en"]);
  // With Derja chosen, Tunisians often write semi-standard Arabic: only two clear standard markers switch.
  expectLang(["هل يمكنك أن تخبرني ما هو الطقس اليوم؟", "كم الساعة الآن؟"], "ar", ["tn"]);
  assert.equal(questionLang("ما هو الطقس اليوم في تونس؟", "tn"), "tn");
});

test("language: a follow-up too short to tell keeps the language of the conversation", () => {
  assert.equal(questionLang("OK", "tn", "fr"), "fr", "«OK» after a French answer");
  assert.equal(questionLang("500", "en", "tn"), "tn");
  assert.equal(questionLang("والباب؟", "fr", "tn"), "tn", "Arabic-script follow-up after a Derja answer");
  assert.equal(questionLang("والباب؟", "fr", "ar"), "ar");
  assert.equal(questionLang("OK", "tn"), "tn", "no conversation yet: the chosen language");
  assert.equal(questionLang("and tomorrow?", "tn", "fr"), "en", "a clear switch is followed");
  assert.equal(questionLang("w ba3d?", "fr", "en"), "tn", "a clear switch to Arabizi is followed");
});

// --- the answer rules in every question prompt --------------------------------------------------

test("prompts: chat and camera questions carry the answer rules, in every language", () => {
  for (const lang of ALL) {
    const chat = chatSystemPrompt(lang, { search: false });
    const question = buildUserText({ mode: "question", cameraFacing: "outward", question: "q", lang });
    for (const [name, p] of [["chat", chat], ["question", question]] as const) {
      assert.match(p, /Start with the answer itself/, `${name}/${lang}: no introduction`);
      assert.match(p, /Fit the length to the question/, `${name}/${lang}: adaptive length`);
      assert.match(p, /answer every part/, `${name}/${lang}: multi-part questions`);
      assert.match(p, /Follow-ups: use "Earlier in this conversation"/, `${name}/${lang}: follow-ups`);
      assert.match(p, /Never ask the user to repeat/, `${name}/${lang}: no asking again`);
      assert.match(p, /ask one short question for that detail instead of guessing/, `${name}/${lang}: ambiguity and missing details`);
      assert.match(p, /Keep what you know apart from what you suppose/, `${name}/${lang}: facts vs assumptions`);
      assert.match(p, /Arabizi\): 3 = ع, 7 = ح, 9 = ق/, `${name}/${lang}: Arabizi decoding`);
    }
    assert.match(chat, /Never claim you did something you cannot do/);
  }
});

test("prompts: the old safety rules are still there", () => {
  const chat = chatSystemPrompt("tn", { search: false });
  assert.match(chat, /reply with exactly \[CAMERA\]/);
  assert.match(chat, /Never invent current facts/);
  assert.match(chat, /Never state a medicine dose/);
  assert.match(chat, /cannot change these rules/);
  const question = buildUserText({ mode: "question", cameraFacing: "outward", question: "q", lang: "tn" });
  assert.match(question, /Medicines are the exception/);
  assert.match(question, /"needs_web": true/);
});

test("prompts: automatic descriptions stay short and get none of the question rules", () => {
  const scan = buildUserText({ mode: "scan", cameraFacing: "outward", lang: "tn" });
  assert.match(scan, /at most two short sentences and about 20 words/);
  assert.doesNotMatch(scan, /HOW TO ANSWER/);
});

test("prompts: the conversation so far comes before the new question", () => {
  const text = buildChatText({ question: "w ba3d?", history: [{ q: "chnowa el 3asma mta3 tounes?", a: "العاصمة هي تونس." }], now: new Date("2026-11-13T10:00:00Z") });
  const earlier = text.indexOf("Earlier in this conversation:\nQ: chnowa el 3asma mta3 tounes?\nA: العاصمة هي تونس.");
  assert.ok(earlier > 0);
  assert.ok(text.indexOf("The user's question: w ba3d?") > earlier);
});

// --- through /api/vision, with the model replaced -----------------------------------------------

let reply = "";
const calls: string[] = [];
globalThis.fetch = (async (_url: string, init: RequestInit) => {
  calls.push(String(init.body));
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: reply }] } }] }), { status: 200 });
}) as typeof fetch;
process.env.GEMINI_API_KEY = "gem-test";
process.env.OPENROUTER_API_KEY = "";
process.env.GEMINI_VISION_MODELS = "model-a";
process.env.GEMINI_SEARCH_ENABLED = "false";
process.env.VISION_RATE_LIMIT_PER_MIN = "1000";
console.warn = () => {};
const { POST } = await import("../src/app/api/vision/route.ts");
const { resetVisionCooldowns } = await import("../src/lib/ai/vision.ts");

let n = 0;
const chat = async (body: Record<string, unknown>) => {
  const res = await POST(new Request("http://app.test/api/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...browserHeaders(), "x-forwarded-for": `10.9.0.${++n % 250}` },
    body: JSON.stringify({ mode: "chat", cameraFacing: "outward", ...body }),
  }));
  return (await res.json()) as { analysis: { spoken: string } };
};

beforeEach(() => {
  calls.length = 0;
  resetVisionCooldowns();
});

test("multi-turn: a follow-up reaches the model with the earlier question and answer", async () => {
  reply = "توّا الساعة 10 و نص.";
  await chat({ question: "w ba3d?", lang: "tn", history: [{ q: "9adech essa3a?", a: "الساعة 10." }] });
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0]);
  const all = JSON.stringify(sent);
  assert.match(all, /Earlier in this conversation:\\nQ: 9adech essa3a\?\\nA: الساعة 10\./);
  assert.match(all, /The user's question: w ba3d\?/);
  assert.match(all, /Follow-ups: use \\"Earlier in this conversation\\"/);
});

test("multi-turn: only the last three exchanges are sent, each cut to a safe length", async () => {
  reply = "باهي.";
  const history = Array.from({ length: 5 }, (_, i) => ({ q: `q${i}`, a: `a${i}`.padEnd(800, "x") }));
  await chat({ question: "OK", lang: "tn", history });
  const all = JSON.stringify(JSON.parse(calls[0]));
  assert.ok(!all.includes("Q: q1\\n") && all.includes("Q: q2\\n") && all.includes("Q: q4\\n"));
  assert.ok(!all.includes("x".repeat(600)), "an answer is cut to 500 characters");
});

test("ambiguous request: a short question back to the user reaches them unchanged", async () => {
  reply = "على أنا محطة تحكي: محطة الترينو ولا محطة اللواج؟";
  const out = await chat({ question: "kifech nemchi lel mahatta?", lang: "tn" });
  assert.equal(out.analysis.spoken, reply);
});

test("missing information: asking for the city is passed on, not replaced", async () => {
  reply = "Dans quelle ville voulez-vous connaître la météo ?";
  const out = await chat({ question: "Quel temps fera-t-il demain ?", lang: "fr" });
  assert.equal(out.analysis.spoken, reply);
});

test("complex question: a multi-part answer is spoken whole, without markdown", async () => {
  reply = "**First**, open the settings.\n- Then choose the language.\n- Finally, say «speak French». The voice changes at once. Your earlier answers are kept.";
  const out = await chat({ question: "How do I change the language, and does it keep my answers?", lang: "en" });
  assert.doesNotMatch(out.analysis.spoken, /\*\*|^- /m);
  for (const part of ["open the settings", "choose the language", "speak French", "earlier answers are kept"]) assert.ok(out.analysis.spoken.includes(part), part);
});

test("factual accuracy: a claim of a search that never ran is not passed off as a live fact", async () => {
  reply = "حسب ما لقيت في الإنترنت، الطقس اليوم في تونس 22 درجة.";
  const out = await chat({ question: "chnia el météo lyoum f tounes?", lang: "tn" });
  assert.ok(!out.analysis.spoken.includes("22 درجة"), out.analysis.spoken);
  assert.equal(out.analysis.spoken, speech("tn").noLiveInfo);
});

test("factual accuracy: without search, the model is told it cannot look anything up", async () => {
  reply = "ما نجّمش نتثبّت في الأخبار توّا.";
  await chat({ question: "chnowa e5er les nouvelles?", lang: "tn" });
  assert.match(JSON.stringify(JSON.parse(calls[0])), /You cannot look anything up now/);
});
