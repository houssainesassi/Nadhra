// Reading documents and medicine boxes (document.ts, and the guards in schema.ts): the rules that
// keep a misread or invented medicine name, dose, date or amount from being said as fact. No network.
//
// Regression tests for the safety review (docs/PHASE1_SAFETY_PRIVACY_REVIEW.md) are marked F1–F6.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asksMedicalAdvice, DERJA_GLOSSARY_APPROVED, derjaInstruction, documentContext, expiryStatus, grounded, guardExplanation, isMedicalQuestion,
  isReadRequest, mentionsDose, normForMatch, numberSignature, numbersIn, readAllSegments, sanitizeDocument, scriptLang,
} from "../src/lib/assistant/document.ts";
import { dropDoses, sanitizeAnalysis, sanitizeChat, SentenceStreamer } from "../src/lib/assistant/schema.ts";
import { READ_BLUR_LIMIT, sharpestTile } from "../src/lib/assistant/frameAnalysis.ts";
import { parseCommand } from "../src/lib/assistant/commands.ts";
import { buildReadText, buildUserText, chatSystemPrompt, readSystemPrompt, visionSystemPrompt } from "../src/lib/assistant/prompts.ts";
import { liveSystemPrompt } from "../src/lib/live/config.ts";
import { PHRASES, speech } from "../src/lib/assistant/phrases.ts";
import { SPEECH_LANGS, type SpeechLang } from "../src/lib/assistant/lang.ts";
import type { DocumentContext } from "../src/lib/assistant/types.ts";

const NOW = new Date("2026-11-13T10:00:00+01:00");
const T = speech("tn").doc;
type Raw = Record<string, unknown>;
/**
 * Sanitizes a reading. By default the second, independent reading is the same as the first (they
 * agree); `confirm: null` is a second reading that failed, `confirm: {...}` a different one.
 */
type Inspect = NonNullable<Parameters<typeof sanitizeDocument>[1]["inspect"]>;
/** The pixel check, passing (a clear picture) unless a test gives its own. */
const WHOLE: Inspect = { first: () => null, second: () => null };
const read = (raw: Raw, ctx: { lang?: SpeechLang; question?: string; context?: DocumentContext; confirm?: Raw | null; derjaGlossary?: boolean; inspect?: Inspect | null } = {}) =>
  sanitizeDocument(raw, { lang: ctx.lang ?? "tn", question: ctx.question, context: ctx.context, now: NOW, confirm: "confirm" in ctx ? ctx.confirm : raw, derjaGlossary: ctx.derjaGlossary, inspect: ctx.inspect === null ? undefined : (ctx.inspect ?? WHOLE) });
const line = (text: string, confidence = "confirmed") => ({ text, confidence });

const BOX = {
  doc_type: "medicine",
  legibility: "clear",
  problems: [],
  lines: [line("FEBRALIX®"), line("500 mg"), line("Paracétamol"), line("16 comprimés pelliculés"), line("EXP : 03/2027")],
  medicine: { name: "FEBRALIX®", ingredient: "Paracétamol", strength: "500 mg", form: "comprimés pelliculés", quantity: "16 comprimés pelliculés", expiry: "EXP : 03/2027" },
  explanation: "هذي علبة فيها باراسيتامول، يستعمل عادة للوجيعة والسخانة.",
};
const texts = (a: { document?: { segments: { text: string }[] } }) => a.document!.segments.map((s) => s.text);
const after = (list: string[], item: string) => list[list.indexOf(item) + 1];

// --- matching -----------------------------------------------------------------------------------------

test("F1: a number only matches a whole number: 500 mg is not on a 1500 mg box", () => {
  const corpus = normForMatch("AMOXICILLINE 1500 mg | Prendre 12,5 mg | Total : 2,500 DT | الصلاحية ٠٣/٢٠٢٧ | FEBRALIX® 500mg");
  assert.ok(!grounded("500 mg", normForMatch("AMOXICILLINE 1500 mg")), "500 in 1500");
  assert.ok(!grounded("2,5 mg", corpus), "2,5 in 12,5");
  assert.ok(!grounded("5 mg", corpus), "5 in 12,5");
  assert.ok(!grounded("AMOX", corpus), "part of a word");
  assert.ok(!grounded("50 mg", corpus));
  assert.ok(grounded("1500 mg", corpus));
  assert.ok(grounded("12.5 mg", corpus), "decimal comma and point are the same");
  assert.ok(grounded("500 mg", corpus), "500mg and 500 mg are the same");
  assert.ok(grounded("febralix", corpus));
  assert.ok(grounded("03/2027", corpus), "Arabic-Indic digits");
  assert.ok(!grounded("", corpus));
});

test("F3: fractions are numbers", () => {
  assert.deepEqual(numbersIn("½ comprimé, ¼, 1/2"), ["1", "2", "0.5", "0.25"]);
  assert.deepEqual(numberSignature("½ comprimé le soir"), ["½ comprime"]);
  assert.deepEqual(numberSignature("1 comprimé 3 fois par jour pendant 5 jours"), ["1 comprime", "3 fois", "5 jours"]);
  assert.deepEqual(numberSignature("EXP : 03/2027 Lot 4K217"), ["03/2027", "4", "217"]);
});

test("scriptLang: French and English text in their own voices, Arabic in the user's", () => {
  assert.equal(scriptLang("16 comprimés pelliculés", "tn"), "fr");
  assert.equal(scriptLang("FEBRALIX", "tn"), "fr");
  assert.equal(scriptLang("Keep out of the reach of children", "tn"), "en");
  assert.equal(scriptLang("باراسيتامول", "tn"), "tn");
  assert.equal(scriptLang("باراسيتامول", "fr"), "ar");
  assert.equal(scriptLang("03/2027", "ar"), "ar");
});

test("expiryStatus: only from unambiguous numeric dates", () => {
  assert.equal(expiryStatus("EXP : 03/2027", NOW), "valid");
  assert.equal(expiryStatus("EXP 05/2025", NOW), "expired");
  assert.equal(expiryStatus("11/2026", NOW), "this-month");
  assert.equal(expiryStatus("PER 10-26", NOW), "expired");
  assert.equal(expiryStatus("25/11/2026", NOW), "valid");
  assert.equal(expiryStatus("2027-01", NOW), "valid");
  assert.equal(expiryStatus("صالح حتى ٠٤/٢٠٢٥", NOW), "expired");
  assert.equal(expiryStatus("10/11/2026", NOW), null, "10 November or 11 October: ambiguous, so nothing is said");
  assert.equal(expiryStatus("03/04/2027", NOW), null);
  assert.equal(expiryStatus("FAB 01/2024 EXP 12/2026", NOW), null, "two dates");
  assert.equal(expiryStatus("13/2027", NOW), null);
  assert.equal(expiryStatus("MARS 2027", NOW), null);
});

// --- the wording: never an unverified dose as fact ------------------------------------------------------

test("a clear box: «قريت…», a check right after the dose and after the date, and no AI explanation", () => {
  const a = read(BOX);
  const d = a.document!;
  const said = texts(a);
  assert.equal(said[0], T.kind.medicine);
  assert.match(T.strength, /^قريت الجرعة/);
  assert.equal(after(said, T.strength), "500 mg.");
  assert.equal(after(said, "500 mg."), T.checkDose, "the check comes immediately after the dose");
  const exp = said.indexOf("EXP : 03/2027.");
  assert.equal(said[exp + 1], T.checkDate, "the check immediately after the date");
  assert.equal(said[exp + 2], T.notExpired, "then the status");
  assert.match(T.notExpired, /^كان القراية صحيحة/, "the status is conditional on the reading");
  assert.ok(!a.spoken.includes("السخانة") && !said.includes(T.explanation), "medical papers get no AI explanation");
  assert.equal(d.explanation, "");
  assert.ok(said.includes(T.checkPharmacist));
  assert.equal(said.at(-1), T.readAll);
  const name = d.segments.find((s) => s.text === "FEBRALIX®.")!;
  assert.deepEqual([name.source, name.lang], ["document", "fr"]);
  // Nothing says "written" as if the reading were verified.
  for (const lang of SPEECH_LANGS) {
    const p = PHRASES[lang].doc;
    for (const k of ["name", "strength", "expiry", "textIntro", "quote"] as const) assert.doesNotMatch(p[k], /المكتوب|مكتوب:|écrit|as written/i, `${lang}.${k}`);
  }
});

test("F1: a strength field shorter than the printed one is not said", () => {
  const a = read({ ...BOX, lines: [line("FEBRALIX® 1500 mg"), line("EXP : 03/2027")], medicine: { name: "FEBRALIX®", strength: "500 mg", expiry: "EXP : 03/2027" } });
  assert.equal(a.document!.medicine.strength, undefined);
  assert.ok(!texts(a).includes("500 mg."));
  assert.ok(a.spoken.includes(T.strengthUnclear));
});

test("a medicine name the lines don't contain is never said", () => {
  const a = read({ ...BOX, medicine: { ...BOX.medicine, name: "DOLIPRANE" } });
  assert.equal(a.document!.medicine.name, undefined);
  assert.ok(!a.spoken.includes("DOLIPRANE"));
  assert.ok(a.spoken.includes(T.nameUnclear));
});

test("a strength from a line the model wasn't sure of is not said", () => {
  const a = read({ ...BOX, lines: BOX.lines.map((l) => (l.text === "500 mg" ? line("500 mg", "likely") : l)) });
  assert.equal(a.document!.medicine.strength, undefined);
  assert.ok(!a.spoken.includes("500 mg"));
});

test("F2: any unreadable mark makes a line uncertain: «5?0 mg», «GASTR?NIL», «[?]», «…»", () => {
  for (const bad of ["FEBRALIX 5?0 mg", "GASTR?NIL 20 mg", "5[?]0 mg", "50… mg", "?0 mg", "50? mg"]) {
    const a = read({ ...BOX, lines: [line("FEBRALIX®"), line(bad)], medicine: { name: "FEBRALIX®", strength: bad.replace("FEBRALIX ", "").replace("GASTR?NIL ", "") } });
    assert.equal(a.document!.lines.find((l) => l.text === bad)!.confidence, "uncertain", bad);
    assert.ok(!a.spoken.includes(bad) && !a.spoken.includes("?"), bad);
  }
  // A question mark ending a sentence in a letter is not a gap.
  const letter = read({ doc_type: "letter", legibility: "clear", lines: [line("Comment allez-vous ?")] });
  assert.ok(letter.spoken.includes("Comment allez-vous ?"));
});

test("F3: a fraction is held back like any number when the paper is hard to read", () => {
  const a = read({ doc_type: "prescription", legibility: "partial", problems: ["glare"], lines: [line("ORDONNANCE"), line("½ comprimé le soir")] });
  assert.ok(!a.spoken.includes("½"));
  assert.ok(a.spoken.includes(T.tip.glare));
  // In an explanation of a bill, a fraction that isn't printed is removed like any other number.
  assert.equal(guardExplanation("Il reste ½ à payer.", { corpus: normForMatch("Total 87,450 DT") }), "");
});

test("an expired box: the check right after the date, then the conditional status", () => {
  const a = read({ ...BOX, lines: [...BOX.lines.slice(0, 4), line("EXP 05/2025")], medicine: { ...BOX.medicine, expiry: "EXP 05/2025" } });
  const said = texts(a);
  const at = said.indexOf("EXP 05/2025.");
  assert.deepEqual(said.slice(at + 1, at + 3), [T.checkDate, T.expired]);
});

test("a box with nothing readable on it asks for another picture, with the reason", () => {
  const a = read({ doc_type: "medicine", legibility: "unreadable", problems: ["blurry"], lines: [line("FEBRALIX", "uncertain"), line("500 mg", "likely")], medicine: { name: "FEBRALIX", strength: "500 mg" } });
  assert.equal(a.document!.rescan, true);
  assert.ok(!a.spoken.includes("FEBRALIX") && !a.spoken.includes("500"));
  assert.ok(a.spoken.includes(T.tip.blurry));
});

test("a box reported as not fully legible: dose and date wait, in the fields, «read all» and follow-ups", () => {
  const a = read({ ...BOX, legibility: "partial", problems: ["glare"] });
  const d = a.document!;
  assert.equal(d.medicine.strength, undefined);
  assert.equal(d.medicine.expiry, undefined);
  assert.equal(d.medicine.name, "FEBRALIX®");
  const all = readAllSegments(d, "tn").map((x) => x.text).join(" ");
  assert.ok(!all.includes("500 mg") && !all.includes("03/2027"));
  assert.ok(!documentContext(d).lines.some((l) => /\d/.test(l)));
});

// --- double reading ----------------------------------------------------------------------------------------

test("double reading: a dose or date the second reading read differently is not said", () => {
  const second = { ...BOX, lines: [line("FEBRALIX®"), line("1000 mg"), line("Paracétamol"), line("16 comprimés pelliculés"), line("EXP : 08/2027")] };
  const a = read(BOX, { confirm: second });
  const d = a.document!;
  assert.equal(d.medicine.strength, undefined);
  assert.equal(d.medicine.expiry, undefined);
  assert.equal(d.medicine.name, "FEBRALIX®", "lines without numbers don't need the second reading");
  assert.ok(!a.spoken.includes("500") && !a.spoken.includes("1000") && !a.spoken.includes("2027"));
  assert.ok(a.spoken.includes(T.unconfirmed));
  assert.equal(d.unconfirmed, true);
  assert.equal(a.uncertain, true);
  assert.ok(!a.spoken.includes(T.strengthUnclear), "one message, not three");
  // Neither «read all» nor a follow-up brings them back.
  assert.ok(!readAllSegments(d, "tn").some((x) => /500|2027/.test(x.text)));
  assert.ok(!documentContext(d).lines.some((l) => /500|2027/.test(l)));
});

test("double reading: no second reading at all means no dose and no date", () => {
  const a = read(BOX, { confirm: null });
  assert.ok(!a.spoken.includes("500 mg") && !a.spoken.includes("03/2027"));
  assert.ok(a.spoken.includes(T.secondMissing));
});

test("double reading: agreement is character for character («03/2027» is not «3/2027»), and line breaks don't matter", () => {
  const a = read(BOX, { confirm: { ...BOX, lines: [line("FEBRALIX® 500 mg Paracétamol"), line("16 comprimés pelliculés EXP : 3/2027")] } });
  assert.equal(a.document!.medicine.strength, "500 mg", "same numbers, other line breaks");
  assert.equal(a.document!.medicine.expiry, undefined, "03 vs 3");
  // A second reading the model itself wasn't sure of doesn't confirm anything.
  const b = read(BOX, { confirm: { ...BOX, lines: BOX.lines.map((l) => ({ ...l, confidence: "likely" })) } });
  assert.equal(b.document!.medicine.strength, undefined);
});

test("double reading: the second reading calling it medical is enough to apply the medical rules", () => {
  const a = read({ doc_type: "other", legibility: "clear", lines: [line("1 comprimé 3 fois par jour")] }, { confirm: { doc_type: "prescription", legibility: "clear", lines: [line("1 comprimé 2 fois par jour")] } });
  assert.ok(!a.spoken.includes("3 fois"));
});

test("double reading is not needed for bills and letters", () => {
  const a = read({ doc_type: "invoice", legibility: "clear", lines: [line("Total : 87,450 DT")] }, { confirm: null });
  assert.ok(a.spoken.includes("87,450"));
});

// --- prescriptions -------------------------------------------------------------------------------------------

test("a prescription: confirmed lines are read, each dose followed at once by the check; unsure lines are left out", () => {
  const a = read({
    doc_type: "prescription", legibility: "partial", problems: ["cut_off"],
    lines: [line("ORDONNANCE"), line("1) FEBRALIX 500 mg"), line("1 comprimé 3 fois par jour"), line("2) GASTR0NIL 20 mg", "likely")],
    explanation: "الوصفة فيها زوز أدوية.",
  });
  const said = texts(a);
  assert.equal(after(said, "1 comprimé 3 fois par jour."), T.checkDose);
  assert.equal(after(said, "1) FEBRALIX 500 mg."), T.checkDose);
  assert.ok(!a.spoken.includes("GASTR"));
  assert.ok(a.spoken.includes(T.unclearParts) && a.spoken.includes(T.tip.cut_off));
  assert.ok(!a.spoken.includes("زوز أدوية"), "no AI explanation");
  const hw = read({ doc_type: "prescription", legibility: "partial", problems: ["handwriting"], lines: [line("ORDONNANCE"), line("1 comprimé 3 fois par jour")] });
  assert.ok(!hw.spoken.includes("3 fois") && hw.spoken.includes(T.tip.handwriting));
});

test("F4 and F5: nothing the model writes about a medical paper is said, however it is phrased", () => {
  const bad = [
    "Selon l'ordonnance, vous pouvez doubler la dose.",
    "الوصفة تقول تنجم تزيد حبة كان الوجيعة قوية.",
    "هذا الدوا يصلح للصغار والمرا الحامل.",
    "Ce médicament traite l'infection.",
  ];
  for (const explanation of bad) {
    const a = read({ ...BOX, explanation });
    assert.ok(!a.spoken.includes(explanation), explanation);
    const q = read({ lines: [], answer: { about_document: true, found: true, quote: "500 mg", explanation } }, { question: "شنوة الجرعة؟", context: { kind: "medicine", lines: ["FEBRALIX 500 mg"] } });
    assert.ok(!q.spoken.includes(explanation), `answer: ${explanation}`);
  }
});

// --- bills and letters ---------------------------------------------------------------------------------------

test("a bill: likely lines are read, the explanation stays labelled, and an amount the bill doesn't show is removed", () => {
  const a = read({
    doc_type: "invoice", legibility: "clear",
    lines: [line("المبلغ الجملي: 87,450 دينار"), line("آخر أجل للدفع: 25/11/2026", "likely")],
    explanation: "لازمك تخلص 87,450 دينار. يعني تقريبا 90 دينار. خوذ 2 حبات.",
  });
  assert.ok(a.spoken.includes("25/11/2026"));
  assert.ok(texts(a).includes(T.explanation));
  assert.ok(a.spoken.includes("لازمك تخلص 87,450 دينار."));
  assert.ok(!a.spoken.includes("90") && !a.spoken.includes("حبات"));
  assert.ok(!a.spoken.includes(T.checkDose), "no dose checks on a bill");
});

test("a long paper: the start is read and the rest is offered", () => {
  const a = read({ doc_type: "letter", legibility: "clear", lines: Array.from({ length: 60 }, (_, i) => line(`Ligne numéro ${i} du courrier, avec un peu de texte.`)) });
  assert.equal(a.document!.more, true);
  assert.ok(!a.spoken.includes("numéro 59"));
  assert.ok(readAllSegments(a.document!, "tn").map((s) => s.text).join(" ").includes("numéro 59"));
});

test("no text, and junk model output", () => {
  assert.ok(read({ doc_type: "none", legibility: "clear", lines: [] }).spoken.startsWith(T.noText));
  const a = read({ doc_type: "poison", legibility: 3, problems: ["blurry", "lol", "blurry"], lines: [{ text: 5 }, "x", line("Bonjour", "sure")], medicine: "x" });
  assert.equal(a.document!.kind, "other");
  assert.deepEqual(a.document!.problems, ["blurry"]);
  assert.equal(a.document!.rescan, true);
});

// --- questions about a document ------------------------------------------------------------------------------

const RX: DocumentContext = { kind: "prescription", lines: ["1) FEBRALIX 500 mg", "1 comprimé 3 fois par jour pendant 5 jours"] };

test("a question is answered with a checked quote, the dose check, and no AI words on a medical paper", () => {
  const a = read({ lines: [], answer: { about_document: true, found: true, quote: "1 comprimé 3 fois par jour pendant 5 jours", explanation: "الوصفة تقول حبة 3 مرات." } }, { question: "قدّاش من مرة ناخذو؟", context: RX });
  assert.deepEqual(texts(a), [T.quote, "1 comprimé 3 fois par jour pendant 5 jours.", T.checkDose]);
  assert.equal(a.document!.kind, "prescription");
});

test("F1 in quotes: «500 mg» is not found in «1500 mg»; an invented quote is never spoken", () => {
  const a = read({ lines: [], answer: { about_document: true, found: true, quote: "500 mg" } }, { question: "شنوة الجرعة؟", context: { kind: "medicine", lines: ["AMOXICILLINE 1500 mg"] } });
  assert.ok(a.spoken.startsWith(T.notFound));
  const b = read({ lines: [], answer: { about_document: true, found: true, quote: "2 comprimés 4 fois par jour" } }, { question: "قدّاش ناخذ؟", context: RX });
  assert.ok(!b.spoken.includes("4 fois"));
});

test("asking whether to take more is refused, and only what was read is quoted", () => {
  const a = read({ lines: [], answer: { about_document: true, found: true, quote: "1 comprimé 3 fois par jour pendant 5 jours", explanation: "إيه، تنجم تاخذ زوز." } }, { question: "نجم ناخذ زوز حبات مع بعضهم؟", context: RX });
  assert.ok(a.spoken.includes(T.noAdvice));
  assert.ok(!a.spoken.includes("تنجم تاخذ زوز"));
});

test("a question that isn't about the paper is flagged for an ordinary answer", () => {
  const a = read({ lines: [], answer: { about_document: false } }, { question: "شنوة الطقس اليوم؟", context: RX });
  assert.equal(a.document!.notAboutDocument, true);
  assert.equal(a.spoken, "");
});

test("every piece spoken as the document's text was really read (whole words and numbers)", () => {
  const raws: Raw[] = [
    BOX,
    { ...BOX, medicine: { name: "X", strength: "1 g", expiry: "01/2030" } },
    { doc_type: "prescription", legibility: "clear", lines: [line("A 10 mg"), line("B", "likely")], answer: { quote: "A 10 mg et B 20 mg" } },
    { doc_type: "medicine", legibility: "clear", lines: [line("Z 1500 mg")], medicine: { strength: "500 mg" }, answer: { quote: "500 mg" } },
  ];
  for (const raw of raws) {
    for (const question of [undefined, "شنوة مكتوب؟"]) {
      const a = read(raw, { question });
      const corpus = normForMatch(a.texts.map((t) => t.content).join(" \n "));
      for (const seg of a.document!.segments.filter((s) => s.source === "document")) assert.ok(grounded(seg.text.replace(/\.$/, ""), corpus), seg.text);
    }
  }
});

test("documentContext sends back only lines read clearly (and twice, for numbers)", () => {
  const a = read({ doc_type: "prescription", legibility: "clear", lines: [line("A 10 mg"), line("B ??", "confirmed"), line("C", "likely")] });
  assert.deepEqual(documentContext(a.document!).lines, ["A 10 mg"]);
});

// --- F6: medicine questions never get around the reading rules -------------------------------------------------

test("F6: medicine questions are recognised in Derja, Arabic, French, English and Arabizi", () => {
  for (const q of [
    "قداش من حبة ناخذ في النهار؟", "نجم ناخذ الدوا هذا مع الأكل؟", "قداش الجرعة؟", "شنوة هالدوا؟", "كم حبة آخذ؟",
    "combien de comprimés par jour ?", "Je peux prendre du paracétamol ?", "how many pills a day?", "Is this medicine safe for kids?", "chnowa hedha dwa", "9adech men 7abba",
  ]) assert.ok(isMedicalQuestion(q), q);
  for (const q of ["شنوة قدّامي؟", "وين الباب؟", "What colour is the wall?", "وين الصيدلية؟", "C'est quoi devant moi ?", "Read the bill"]) assert.ok(!isMedicalQuestion(q), q);
});

test("F6: doses are recognised in any sentence", () => {
  for (const s of ["خوذ 2 حبات.", "500 mg", "Prenez une gélule le soir.", "Take one tablet twice a day.", "½ cp le soir", "جرعة وحدة في النهار"]) assert.ok(mentionsDose(s), s);
  for (const s of ["فمّا علبة دوا قدّامك.", "Il y a 3 personnes devant vous.", "The total is 87 dinars.", "قدّامك باب."]) assert.ok(!mentionsDose(s), s);
});

test("F6: outside the reading mode, a dose is never said: scans, questions, chat, and streamed sentences", () => {
  const scan = sanitizeAnalysis({ spoken: "فمّا علبة دوا. مكتوب عليها 500 mg.", texts: [{ content: "500 mg", confidence: "confirmed" }] }, { mode: "scan", cameraFacing: "outward", hasMotionEvidence: false });
  assert.equal(scan.spoken, "فمّا علبة دوا.", "even quoted from the picture");
  const q = sanitizeAnalysis({ spoken: "هاذي علبة FEBRALIX 500 mg." }, { mode: "question", cameraFacing: "outward", hasMotionEvidence: false, question: "شنوة هاذي؟" });
  assert.equal(q.spoken, T.medicalDeclined);
  const chat = sanitizeChat("Le paracétamol se prend à 1 g toutes les 6 heures. Il soulage la douleur.", { question: "c'est quoi le paracétamol ?", lang: "fr" });
  assert.ok(!chat.spoken.includes("1 g") && chat.spoken.includes(speech("fr").doc.medicalDeclined));
  const streamer = new SentenceStreamer({ mode: "chat", cameraFacing: "outward", question: "?" });
  assert.deepEqual(streamer.push("Bonjour. Prenez 2 comprimés. Merci. "), ["Bonjour."], "the dose sentence stops early sending");
  assert.deepEqual(dropDoses("Hello. Take 2 tablets."), { text: "Hello.", dropped: true });
});

test("F6: the prompts of every mode, including the live conversation, forbid doses", () => {
  for (const lang of SPEECH_LANGS) {
    assert.match(readSystemPrompt(lang), /"explanation" is always ""/);
    assert.match(buildUserText({ mode: "question", cameraFacing: "outward", question: "?", lang }), /Medicines are the exception/);
    assert.match(chatSystemPrompt(lang, { search: false }), /Never state a medicine dose/);
    assert.match(liveSystemPrompt(lang), /MEDICINES/);
    assert.match(liveSystemPrompt(lang), /Never read out or state a medicine's dose/);
  }
  assert.match(buildUserText({ mode: "scan", cameraFacing: "outward", lang: "tn" }), /document_in_view/);
  assert.match(visionSystemPrompt("tn"), /"document_in_view": false/);
});

test("asksMedicalAdvice: permission and change questions", () => {
  for (const q of ["نجم ناخذ زوز حبات مع بعضهم؟", "هل يمكنني أن أتناول حبتين؟", "Est-ce que je peux prendre deux comprimés ?", "Can I take it with coffee?", "Should I stop taking it?"]) assert.ok(asksMedicalAdvice(q), q);
  for (const q of ["قدّاش من مرة في النهار ناخذ الفبراليكس؟", "What is the dose written on it?"]) assert.ok(!asksMedicalAdvice(q), q);
});

// --- automatic scans don't keep documents ------------------------------------------------------------------------

test("a scan that sees a document keeps none of its text and flags it", () => {
  const a = sanitizeAnalysis({ spoken: "فمّا ورقة فيها اسم ليلى الطرابلسي.", texts: [{ content: "Mme Leila Trabelsi", confidence: "confirmed" }], document_in_view: true }, { mode: "scan", cameraFacing: "outward", hasMotionEvidence: false });
  assert.equal(a.documentInView, true);
  assert.deepEqual(a.texts, []);
  assert.equal(a.spoken, "");
  const b = sanitizeAnalysis({ spoken: "قدّامك باب.", document_in_view: false }, { mode: "scan", cameraFacing: "outward", hasMotionEvidence: false });
  assert.equal(b.documentInView, undefined);
});

// --- the Derja glossary ---------------------------------------------------------------------------------------------

test("Derja instructions come only from the fixed glossary, word for word, or not at all", () => {
  assert.equal(derjaInstruction("1 comprimé 3 fois par jour pendant 5 jours"), "1 حبّة 3 مرات في النهار مدة 5 أيام");
  assert.equal(derjaInstruction("1/2 comprimé le soir"), "نص حبّة العشية");
  assert.equal(derjaInstruction("1 gélule le matin à jeun"), "1 كبسولة الصباح على الريق");
  assert.equal(derjaInstruction("1 comprimé 3 fois par jour si besoin"), null, "one unknown word: no rendering");
  assert.equal(derjaInstruction("1) FEBRALIX 500 mg"), null, "brand names are never 'translated'");
  assert.equal(derjaInstruction("3x/j"), null);
  assert.equal(derjaInstruction("12"), null, "nothing to translate");
});

test("the glossary is off until a pharmacist approves it; once on, it follows the original and comes before the check", () => {
  assert.equal(DERJA_GLOSSARY_APPROVED, false);
  const raw = { doc_type: "prescription", legibility: "clear", lines: [line("1 comprimé 3 fois par jour")] };
  assert.ok(!read(raw).spoken.includes(T.derjaMeans));
  const said = texts(read(raw, { derjaGlossary: true }));
  assert.deepEqual(said.slice(said.indexOf("1 comprimé 3 fois par jour.")), ["1 comprimé 3 fois par jour.", T.derjaMeans, "1 حبّة 3 مرات في النهار", T.checkDose, T.checkPharmacist]);
  assert.ok(!texts(read(raw, { derjaGlossary: true, lang: "fr" })).includes(speech("fr").doc.derjaMeans), "Derja only for the Derja user");
});

// --- notices ------------------------------------------------------------------------------------------------------

test("the notices name Google, say what the free service may do, and tell the user not to send real prescriptions", () => {
  for (const lang of SPEECH_LANGS) {
    const p = PHRASES[lang];
    assert.match(p.privacy, /Google Gemini/, `${lang} privacy`);
    assert.match(p.privacy, /OpenRouter/, `${lang} privacy`);
    assert.match(p.doc.notice, /Google Gemini/, `${lang} notice`);
  }
  assert.match(T.notice, /ما تصوّرش وصفة حقيقية/);
  assert.match(PHRASES.en.doc.notice, /don't photograph a real prescription/);
});

// --- asking for a reading ------------------------------------------------------------------------------------------

test("reading requests: commands and free questions", () => {
  for (const p of ["اقرالي الدوا", "اقرالي الوصفة", "اقرأ الدواء", "Lis l'ordonnance", "read the prescription", "what medicine is this", "اقرالي الكتابة"]) assert.equal(parseCommand(p), "read", p);
  for (const p of ["اقرا الكل", "اقرأ الكل", "lis tout", "read all", "اقرا الباقي"]) assert.equal(parseCommand(p), "read-all", p);
  for (const q of ["شنوة الجرعة المكتوبة على العلبة؟", "Quelle est la date de péremption ?", "What does the label say?", "اقراهالي يعيشك"]) assert.ok(isReadRequest(q), q);
});

test("the reading prompt asks for exact copies, [?] for gaps, and no explanation of medical papers", () => {
  for (const lang of SPEECH_LANGS) {
    const p = readSystemPrompt(lang);
    assert.match(p, /exactly as it is printed/);
    assert.match(p, /\[\?\]/);
    assert.doesNotMatch(p, /commonly used for/);
    for (const key of ["doc_type", "legibility", "lines", "medicine", "explanation", "about_document", "quote"]) assert.ok(p.includes(`"${key}"`), `${lang} ${key}`);
  }
  assert.match(buildReadText({ question: "?", document: RX, hasImage: false, now: NOW }), /no new image/);
});

// --- the on-device blur check --------------------------------------------------------------------------------------

test("on-device blur check: printed text is sharp, the same text blurred is not, noise doesn't fool it", () => {
  const W = 640, H = 480;
  const page = new Uint8Array(W * H).fill(235);
  for (let y = 60; y < 420; y += 24) for (let x = 40; x < 600; x++) if ((x * 7) % 11 < 3) for (let dy = 0; dy < 10; dy++) page[(y + dy) * W + x] = 30;
  const blur = (src: Uint8Array, r: number) => {
    let a = src;
    for (let pass = 0; pass < 3; pass++) {
      const b = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { s += a[y * W + Math.min(W - 1, Math.max(0, x + d))]; n++; } b[y * W + x] = s / n; }
      const c = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -r; d <= r; d++) { s += b[Math.min(H - 1, Math.max(0, y + d)) * W + x]; n++; } c[y * W + x] = s / n; }
      a = c;
    }
    return a;
  };
  const noisy = (src: Uint8Array) => src.map((v, i) => Math.min(255, v + ((i * 2654435761) >>> 29)));
  assert.ok(sharpestTile(noisy(page), W, H) > 10 * READ_BLUR_LIMIT);
  assert.ok(sharpestTile(noisy(blur(page, 4)), W, H) < READ_BLUR_LIMIT);
  assert.ok(sharpestTile(noisy(new Uint8Array(W * H).fill(200)), W, H) < READ_BLUR_LIMIT);
});

// --- found with the real model in the 30-case run (2026-11-13) ----------------------------------------------------

test("a line the model says isn't fully visible (cut by the edge, covered, under glare) is never read, whatever its confidence", () => {
  // The model reconstructed an expiry date cut in half by the frame edge, and called it confirmed.
  const a = read({ ...BOX, lines: [line("FEBRALIX®"), line("500 mg"), { text: "EXP : 03/2027", confidence: "confirmed", fully_visible: false }] });
  assert.equal(a.document!.medicine.expiry, undefined);
  assert.ok(!a.spoken.includes("03/2027"));
  assert.ok(!readAllSegments(a.document!, "tn").some((s) => s.text.includes("2027")));
});

test("a strength without a unit is never said, and a bare number on a medical paper is never read", () => {
  // A finger over «0 mg» of «500 mg»: the model read «50», confirmed, in both readings.
  const a = read({ ...BOX, lines: [line("FEBRALIX®"), line("50"), line("Paracétamol")], medicine: { name: "FEBRALIX®", strength: "50" } });
  assert.equal(a.document!.medicine.strength, undefined);
  assert.ok(!a.spoken.includes("50"));
  assert.ok(!readAllSegments(a.document!, "tn").some((s) => /\b50\b/.test(s.text)));
  for (const ok of ["500 mg", "2,5 mg", "0,5 %", "120 mg/5 ml", "1 g", "500 ملغ", "1000 UI"]) {
    const b = read({ ...BOX, lines: [line("X"), line(ok)], medicine: { name: "X", strength: ok } });
    assert.equal(b.document!.medicine.strength, ok, ok);
  }
  // On a bill, a bare number is fine.
  assert.ok(read({ doc_type: "invoice", legibility: "clear", lines: [line("87,450")] }).spoken.includes("87,450"));
});

test("the reading prompt asks, line by line, whether every character is fully visible", () => {
  for (const lang of SPEECH_LANGS) assert.match(readSystemPrompt(lang), /"fully_visible"/);
});

// --- 2026-11-13, second round: names read twice, pixels checked, no hidden line read ---------------------------

test("names: a name the second reading has differently is not said (seen: «فيبراليكس» for «فبراليكس»)", () => {
  const raw = { doc_type: "medicine", legibility: "clear", lines: [line("فيبراليكس"), line("500 ملغ")], medicine: { name: "فيبراليكس", strength: "500 ملغ" } };
  const a = read(raw, { lang: "tn", confirm: { ...raw, lines: [line("فبراليكس"), line("500 ملغ")] } });
  assert.equal(a.document!.medicine.name, undefined);
  assert.ok(!a.spoken.includes("فيبراليكس") && !a.spoken.includes("فبراليكس"));
  assert.ok(a.spoken.includes(T.unconfirmed));
  assert.ok(!a.spoken.includes(T.nameUnclear), "one message");
  assert.equal(a.document!.medicine.strength, "500 ملغ", "the strength, read the same twice, still is");
});

test("names: an agreed name is still followed by the pharmacist check", () => {
  const said = texts(read(BOX));
  assert.equal(after(said, "FEBRALIX®."), T.checkName);
  assert.equal(after(said, "Paracétamol."), T.checkName);
});

test("whole lines must agree, not just their numbers: «1) FEBRAUX 500 mg» doesn't confirm «1) FEBRALIX 500 mg»", () => {
  const raw = { doc_type: "prescription", legibility: "clear", lines: [line("1) FEBRALIX 500 mg"), line("1 comprimé 3 fois par jour")] };
  const a = read(raw, { confirm: { ...raw, lines: [line("1) FEBRAUX 500 mg"), line("1 comprimé 3 fois par jour")] } });
  assert.ok(!a.spoken.includes("FEBRALIX") && !a.spoken.includes("FEBRAUX"));
  assert.ok(a.spoken.includes("1 comprimé 3 fois par jour"));
});

test("pixel check: a line not whole in either frame is not said, with how to take the next picture", () => {
  const strengthCovered: Inspect = { first: (_b, text) => (text === "500 mg" ? "covered" : null), second: () => null };
  const a = read(BOX, { inspect: strengthCovered });
  assert.equal(a.document!.medicine.strength, undefined);
  assert.ok(!texts(a).includes("500 mg."));
  assert.deepEqual(a.document!.obscured, ["covered"]);
  assert.ok(a.spoken.includes(T.obscured) && a.spoken.includes(T.tip.covered));
  assert.ok(!a.spoken.includes(T.strengthUnclear), "one message");
  assert.equal(a.document!.medicine.expiry, "EXP : 03/2027");
  // In the second frame only: the same.
  const b = read(BOX, { inspect: { first: () => null, second: (_b, text) => (text === "EXP : 03/2027" ? "edge" : null) } });
  assert.equal(b.document!.medicine.expiry, undefined);
  assert.ok(b.spoken.includes(T.tip.cut_off));
  // Washed out: the glare tip.
  assert.ok(read(BOX, { inspect: { first: (_b, t) => (t === "500 mg" ? "incomplete" : null), second: () => null } }).spoken.includes(T.tip.incomplete));
  // «read all» and follow-ups don't bring hidden lines back.
  assert.ok(!readAllSegments(a.document!, "tn").some((s) => s.text.includes("500 mg")));
  assert.ok(!documentContext(a.document!).lines.includes("500 mg"));
});

test("pixel check: without it (no picture to check), nothing on a medical paper is read; bills don't need it", () => {
  const a = read(BOX, { inspect: null });
  assert.ok(!/FEBRALIX|500|2027|Paracétamol/.test(a.spoken));
  assert.equal(a.document!.rescan, true);
  const bill = read({ doc_type: "invoice", legibility: "clear", lines: [line("Total : 87,450 DT")] }, { inspect: null });
  assert.ok(bill.spoken.includes("87,450"));
});

test("line positions are read from Gemini's own «box_2d» key, and «box» still works", () => {
  const seen: unknown[] = [];
  const inspect: Inspect = { first: (box) => (seen.push(box), null), second: () => null };
  read({ ...BOX, lines: [{ text: "FEBRALIX®", confidence: "confirmed", box_2d: [100, 100, 150, 400] }, { text: "500 mg", confidence: "confirmed", box: [[200, 100, 250, 300]] }] }, { inspect });
  assert.deepEqual(seen, [[100, 100, 150, 400], [200, 100, 250, 300]]);
});

test("no second reading at all (the service was busy): nothing medical is read, and the user is told to ask again, not to retake the picture", () => {
  const a = read(BOX, { confirm: null });
  assert.ok(!/FEBRALIX|500|2027/.test(a.spoken));
  assert.ok(a.spoken.includes(T.secondMissing));
  assert.ok(!a.spoken.includes(T.unconfirmed));
  const b = read(BOX, { confirm: { ...BOX, lines: [line("FEBRALIX®"), line("1000 mg")] } });
  assert.ok(b.spoken.includes(T.unconfirmed) && !b.spoken.includes(T.secondMissing), "a real disagreement keeps the other message");
});

// --- located boxes (round 5): the locator can only help where the own box failed softly ----------------------

test("located boxes: used for faint/incomplete own boxes; never over «covered» or «edge»; null withholds", () => {
  const box = (n: number) => [n, 100, n + 50, 400];
  const verdicts: Record<string, "covered" | "edge" | "faint" | "incomplete" | null> = { "500": null };
  // own boxes start at 100, located ones at 600: the fake check passes located boxes and fails own ones as told.
  const inspectWith = (ownProblem: "covered" | "edge" | "faint" | "incomplete"): Inspect => ({ first: (b) => ((b as number[])[0] >= 600 ? verdicts["500"] : ownProblem), second: () => null });
  const raw = (located: unknown) => ({ ...BOX, lines: [{ text: "FEBRALIX®", confidence: "confirmed", box_2d: box(100), located_box: box(600) }, { text: "500 mg", confidence: "confirmed", box_2d: box(160), located_box: located }] });
  for (const soft of ["faint", "incomplete"] as const) assert.equal(read(raw(box(660)), { inspect: inspectWith(soft) }).document!.medicine.strength, "500 mg", soft);
  for (const hard of ["covered", "edge"] as const) assert.equal(read(raw(box(660)), { inspect: inspectWith(hard) }).document!.medicine.strength, undefined, hard);
  assert.equal(read(raw(null), { inspect: inspectWith("faint") }).document!.medicine.strength, undefined, "null: not fully visible");
  // Without any locating, the own box decides, as before.
  const plain = { ...BOX, lines: [{ text: "FEBRALIX®", confidence: "confirmed", box_2d: box(100) }, { text: "500 mg", confidence: "confirmed", box_2d: box(160) }] };
  assert.equal(read(plain, { inspect: inspectWith("faint") }).document!.medicine.strength, undefined);
});
