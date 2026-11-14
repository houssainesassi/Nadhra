// A/B evaluation of spoken answers to questions asked with the camera off ("chat" mode): the
// prompts and language detection before the response-quality changes (baseline-*.ts) against the
// current ones, on the same real model, scored automatically. Uses the free Gemini quota (2 calls
// per case; no web search, which is the only billed call). Outputs in e2e/chat/out (gitignored).
//
//   node --experimental-strip-types --conditions=react-server e2e/chat/eval.ts
//   EVAL_MODEL=gemini-3.1-flash-lite ONLY=followup-tn,ambiguous ...   (optional)
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";

for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
process.env.GEMINI_SEARCH_ENABLED = "false";

const { getVisionProviders } = await import("../../src/lib/ai/vision.ts");
const { sanitizeChat } = await import("../../src/lib/assistant/schema.ts");
const cur = { ...(await import("../../src/lib/assistant/prompts.ts")), ...(await import("../../src/lib/assistant/lang.ts")) };
const old = { ...(await import("./baseline-prompts.ts")), ...(await import("./baseline-lang.ts")) };
type Lang = "tn" | "ar" | "fr" | "en";

interface Case {
  id: string;
  kind: string;
  q: string;
  /** The app's language setting. */
  chosen: Lang;
  history?: { q: string; a: string }[];
  /** Language the answer must be in. */
  want: Lang;
  maxSentences: number;
  must?: RegExp[];
  mustNot?: RegExp[];
  /** The answer must ask the user something back. */
  clarify?: boolean;
}

const UNSURE_EN = /can't|cannot|can not|don't (?:know|have)|not sure|no (?:reliable )?information|unable|not able|hasn't|has not|yet to/i;
const UNSURE_TN = /نجّ?مش|ما ن(?:جّ?مش|عرفش|جمتش)|ما عنديش|موش متأكّ?د|ما نجّ?مش|ما نقدرش|ما نجم|ما فمّ?اش|ماعنديش|نجّ?مش نتثبّ?ت|ما نعرفش/;
const CASES: Case[] = [
  { id: "arabizi-fact", kind: "Arabizi, short", q: "chnowa el 3asma mta3 el jazayer?", chosen: "fr", want: "tn", maxSentences: 2, must: [/الجزائر/] },
  { id: "arabizi-greeting", kind: "Arabizi, short", q: "3aslema, labes?", chosen: "en", want: "tn", maxSentences: 2 },
  { id: "arabizi-where", kind: "Arabizi, short", q: "win tji tozeur?", chosen: "fr", want: "tn", maxSentences: 3, must: [/(?:جنوب|غرب)/] },
  { id: "derja-howto", kind: "Derja, complex", q: "شنوّة نعمل كان ضيّعت الكارطة متاع البنك؟", chosen: "tn", want: "tn", maxSentences: 6, must: [/بنك|البنك|الكارطة|الكارت/] },
  { id: "derja-where", kind: "Derja, short", q: "وين جات القيروان؟", chosen: "fr", want: "tn", maxSentences: 3, must: [/القيروان|وسط/] },
  { id: "mixed-fr-derja", kind: "mixed AR/FR", q: "c'est quoi la différence bin pharmacie de garde w pharmacie normale?", chosen: "fr", want: "tn", maxSentences: 4, must: [/(?:ليل|الليل|عطلة|ديما|وقت|سكّ?ر)/] },
  { id: "mixed-en-derja", kind: "mixed AR/EN", q: "نحب نعرف chnowa el weekend f English", chosen: "tn", want: "tn", maxSentences: 3, must: [/(?:سبت|الأحد|الاحد|آخر الجمعة|اخر الجمعة|عطلة)/] },
  { id: "short-math", kind: "short", q: "What's 15 times 4?", chosen: "tn", want: "en", maxSentences: 1, must: [/60|sixty/i] },
  { id: "multipart-en", kind: "complex, multi-part", q: "What's the capital of Japan, and what language do people speak there?", chosen: "en", want: "en", maxSentences: 3, must: [/Tokyo/i, /Japanese/i] },
  { id: "multipart-fr", kind: "complex, multi-part", q: "Quelle est la capitale du Maroc et quelle monnaie on y utilise ?", chosen: "fr", want: "fr", maxSentences: 3, must: [/Rabat/i, /dirham/i] },
  { id: "ambiguous", kind: "ambiguous", q: "kifech nemchi lel mahatta?", chosen: "tn", want: "tn", maxSentences: 3, clarify: true },
  { id: "missing-city", kind: "missing info", q: "Il va faire quel temps demain ?", chosen: "fr", want: "fr", maxSentences: 3, mustNot: [/\d+\s*°|\d+\s*degr/i] },
  { id: "factual-match", kind: "factual accuracy", q: "chkoun rbe7 el match mta3 el Espérance el bera7?", chosen: "tn", want: "tn", maxSentences: 3, must: [UNSURE_TN], mustNot: [/\d\s*[-–]\s*\d/] },
  { id: "factual-phone", kind: "factual accuracy", q: "What's the phone number of Doctor Karim Ben Salah in Sfax?", chosen: "en", want: "en", maxSentences: 3, must: [UNSURE_EN], mustNot: [/\d{2}\s?\d{3}\s?\d{3}/] },
  { id: "factual-future", kind: "factual accuracy", q: "Who won the 2034 World Cup?", chosen: "en", want: "en", maxSentences: 2, must: [UNSURE_EN] },
  { id: "followup-tn", kind: "follow-up", q: "w el jazayer?", chosen: "tn", history: [{ q: "chnowa el 3asma mta3 el maghreb?", a: "العاصمة متاع المغرب هي الرباط." }], want: "tn", maxSentences: 2, must: [/الجزائر/], clarify: false },
  { id: "followup-en", kind: "follow-up", q: "And how many people live there?", chosen: "tn", history: [{ q: "What's the capital of Italy?", a: "The capital of Italy is Rome." }], want: "en", maxSentences: 3, must: [/million/i], clarify: false },
  { id: "followup-short", kind: "follow-up", q: "OK, w ba3d?", chosen: "tn", history: [{ q: "How do I turn on automatic descriptions?", a: "Say “turn on automatic descriptions”." }], want: "tn", maxSentences: 4 },
  { id: "capability", kind: "capability", q: "3ayetli l khouya Sami", chosen: "tn", want: "tn", maxSentences: 2, mustNot: [/(?:عيّ?طتلو|كلّ?متو|تو نعيطلو|نعيّ?طلو توّ?ا|I called|j'ai appelé)/] },
];

const ARABIC = /[؀-ۿ]/g;
const LATIN = /[A-Za-zÀ-ÿ]/g;
const MSA_HEAVY = /(?:^|\s)(?:يوجد|هناك|الآن|لماذا|ماذا|سوف|لكن|هل)(?=\s|$|[،.؟?!])/g;
const INTRO = /^(?:sure|of course|great question|certainly|bien sûr|bonne question|absolument|بالطبع|طبعا|طبعًا|بكل سرور|سؤال (?:باهي|جيد|ممتاز))/i;
const OUTRO = /(?:anything else|autre chose|حاجة أخرى|حاجة اخرى|نعاونك في حاجة|تحب حاجة)[^.!?؟]*[?؟]?\s*$/i;

function langOf(text: string): Lang | "?" {
  const ar = text.match(ARABIC)?.length ?? 0;
  const la = text.match(LATIN)?.length ?? 0;
  if (ar > la) return (text.match(MSA_HEAVY)?.length ?? 0) >= 2 ? "ar" : "tn";
  if (!la) return "?";
  const fr = text.match(/\b(?:le|la|les|est|vous|une|des|pour|et|en|du|au|il|elle|qui|que|dans)\b/gi)?.length ?? 0;
  const en = text.match(/\b(?:the|is|are|you|and|of|in|to|it|that|there|a)\b/gi)?.length ?? 0;
  return fr > en ? "fr" : "en";
}
const sentences = (t: string) => t.split(/(?<=[.!?؟])\s+/).filter((s) => s.trim().length > 1).length;

function score(c: Case, spoken: string) {
  const fails: string[] = [];
  const l = langOf(spoken);
  if (l !== c.want) fails.push(`language ${l}≠${c.want}`);
  const n = sentences(spoken);
  if (n > c.maxSentences) fails.push(`${n} sentences > ${c.maxSentences}`);
  for (const re of c.must ?? []) if (!re.test(spoken)) fails.push(`missing ${re.source.slice(0, 30)}`);
  for (const re of c.mustNot ?? []) if (re.test(spoken)) fails.push(`has ${re.source.slice(0, 30)}`);
  const asks = /[?؟]/.test(spoken);
  if (c.clarify === true && !asks) fails.push("no clarifying question");
  if (c.clarify === false && asks && sentences(spoken) === 1) fails.push("asked back instead of answering");
  if (INTRO.test(spoken.trim())) fails.push("introduction");
  if (OUTRO.test(spoken.trim())) fails.push("closing offer");
  return { ok: fails.length === 0, fails, lang: l, sentences: n, chars: spoken.length };
}

const providers = getVisionProviders().filter((p) => p.configured && !p.disabledReason && p.family === "gemini");
const provider = providers.find((p) => p.model === process.env.EVAL_MODEL) ?? providers[0];
if (!provider) throw new Error("no Gemini provider configured");
const only = process.env.ONLY?.split(",");
const cases = CASES.filter((c) => !only || only.includes(c.id));
const now = new Date();
const out: Record<string, unknown>[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
console.log(`model ${provider.model}, ${cases.length} cases × 2`);

async function run(v: typeof cur | typeof old, c: Case) {
  const lang = v.questionLang(c.q, c.chosen, c.history?.length ? cur.questionLang(c.history.at(-1)!.q, c.chosen) : undefined) as Lang;
  const system = v.chatSystemPrompt(lang, { search: false });
  const text = v.buildChatText({ question: c.q, history: c.history, now });
  for (let attempt = 0; ; attempt++) {
    try {
      const t0 = Date.now();
      const raw = await provider.analyze({ system, text, images: [], maxTokens: 1500, json: false, signal: AbortSignal.timeout(20_000) });
      const spoken = sanitizeChat(raw, { question: c.q, lang }).spoken;
      return { lang, spoken, ms: Date.now() - t0 };
    } catch (e) {
      const msg = String((e as Error).message);
      if (/quota|exceeded/i.test(msg)) throw new Error(`QUOTA: ${(msg.match(/"quotaId": "[^"]+"/g) ?? []).join(", ") || msg.slice(0, 200)}`);
      if (attempt >= 2) return { lang, spoken: "", ms: 0, error: msg.slice(0, 120) };
      await sleep(15_000);
    }
  }
}

mkdirSync(new URL("./out/", import.meta.url), { recursive: true });
for (const c of cases) {
  const row: Record<string, unknown> = { id: c.id, kind: c.kind, q: c.q };
  for (const [name, v] of [["before", old], ["after", cur]] as const) {
    const r = await run(v, c);
    row[name] = { ...r, score: r.spoken ? score(c, r.spoken) : { ok: false, fails: [r.error ?? "empty"] } };
    await sleep(Number(process.env.EVAL_GAP_MS ?? 4500)); // free tier: about 15 requests a minute
  }
  out.push(row);
  const b = row.before as { score: { ok: boolean; fails: string[] }; spoken: string };
  const a = row.after as { score: { ok: boolean; fails: string[] }; spoken: string };
  console.log(`\n[${c.id}] ${c.q}\n  before ${b.score.ok ? "PASS" : "FAIL " + b.score.fails.join("; ")}: ${b.spoken}\n  after  ${a.score.ok ? "PASS" : "FAIL " + a.score.fails.join("; ")}: ${a.spoken}`);
}
const pass = (k: string) => out.filter((r) => (r[k] as { score: { ok: boolean } }).score.ok).length;
const avg = (k: string, f: string) => (out.reduce((s, r) => s + (((r[k] as { score: Record<string, number> }).score[f]) ?? 0), 0) / out.length).toFixed(1);
const summary = `model ${provider.model}, ${out.length} cases: before ${pass("before")}/${out.length} pass (avg ${avg("before", "sentences")} sentences, ${avg("before", "chars")} chars), after ${pass("after")}/${out.length} pass (avg ${avg("after", "sentences")} sentences, ${avg("after", "chars")} chars)`;
console.log(`\n${summary}`);
const file = new URL(`./out/eval-${now.toISOString().replace(/[:.]/g, "-")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ summary, model: provider.model, at: now.toISOString(), results: out }, null, 2));
console.log(`saved ${file.pathname}`);
