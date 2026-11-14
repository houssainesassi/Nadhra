// Reading documents and packages: medicine boxes, prescriptions, medical papers, bills, letters.
// The model transcribes; this file decides what is said, and enforces the rules in code.
//
// The rule above all others: a medicine dose or date is never presented as fact. What the model
// read is said as «قريت…» ("I read…"), and every dose and date is followed at once by "check it with
// the pharmacist". A transcription is not proof, and neither is the model's own "confirmed".
//
// - A medicine name, substance, strength or expiry is only said when its exact text, as whole words
//   and whole numbers, is in a line that was read clearly. Medical papers: confirmed lines only.
// - A line with any unreadable mark (`[?]`, `5?0`, `…`) is uncertain.
// - Medical papers: a line (a name, a dose, a date) is said only when a second, independent reading
//   of another frame (another model when possible) has the same line, and when the pixels where both
//   readings place it show it whole: not cut by the edge, covered or washed out (lineCheck.ts).
//   Agreement is not proof either: it only removes readings the model isn't even consistent about.
// - Medical papers reported as hard to read (glare, blur…): lines with numbers wait for a better picture.
// - No AI explanation at all on medical papers: no uses, no warnings, no paraphrased instructions.
//   A Derja rendering of an instruction can only come from a fixed glossary, word for word, and only
//   once a pharmacist has approved it (DERJA_GLOSSARY_APPROVED).
// - Bills and letters: the explanation may not bring a number that isn't printed.
// - A picture that can't be read gives "scan again", with a reason, never a guess.
// Pure logic, shared by the server (sanitizeDocument) and the browser (readAllSegments).
import { normalizeArabic, splitSentences } from "./schema.ts";
import { speech } from "./phrases.ts";
import type { SpeechLang } from "./lang.ts";
import { parseBox, type LineProblem } from "./lineCheck.ts";
import type { Confidence, DocKind, DocLine, DocumentContext, DocumentReading, Legibility, MedicineFields, ReadProblem, SceneAnalysis, SpeechSegment } from "./types.ts";

export const DOC_KINDS = ["medicine", "prescription", "medical", "invoice", "letter", "other", "none"] as const;
const LEGIBILITY = ["clear", "partial", "unreadable"] as const;
const PROBLEMS = ["blurry", "glare", "cut_off", "too_far", "dark", "handwriting", "angle"] as const;
const CONFIDENCES = ["confirmed", "likely", "uncertain"] as const;
const MEDICAL = new Set<DocKind>(["medicine", "prescription", "medical"]);
const MEDICINE_FIELDS = ["name", "ingredient", "strength", "form", "quantity", "expiry"] as const;

const MAX_LINES = 120;
const MAX_LINE = 300;
const MAX_FIELD = 80;
const MAX_EXPLANATION = 600;
/** Read out at once; the rest waits for "read all" or a question. About a minute of speech. */
const MAX_READ_CHARS = 1200;
/** Lines sent back with a follow-up question. */
export const MAX_CONTEXT_LINES = 80;

/**
 * The Derja glossary for instructions (DERJA_INSTRUCTIONS below) is a draft. It is used only once a
 * Tunisian pharmacist has reviewed every entry; until then, only the original text is read.
 */
export const DERJA_GLOSSARY_APPROVED = false;

export const isMedical = (kind: DocKind) => MEDICAL.has(kind);

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

// --- numbers -------------------------------------------------------------------------------------------

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;
const asciiDigits = (s: string) => s.replace(ARABIC_DIGITS, (d) => String((d.charCodeAt(0) - (d >= "۰" ? 0x6f0 : 0x660)) % 10));
/** Vulgar fractions are numbers too: «½ comprimé» is a dose. */
const FRACTIONS: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅕": 0.2, "⅖": 0.4, "⅗": 0.6, "⅘": 0.8, "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 0.125, "⅜": 0.375, "⅝": 0.625, "⅞": 0.875 };
const FRACTION_CHARS = Object.keys(FRACTIONS).join("");
const NUMBER_CHAR = new RegExp(`[0-9٠-٩۰-۹${FRACTION_CHARS}]`);
/** Any digit, Arabic-Indic digit or fraction sign. */
export const hasNumber = (text: string) => NUMBER_CHAR.test(text);

/** For comparing a value with the document: letter forms, digits, case, spacing and punctuation unified. */
export function normForMatch(text: string): string {
  return normalizeArabic(asciiDigits(text))
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/[^\p{L}\p{N}.%/]+/gu, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    // "500mg" and "500 mg" are the same; "4K217" becomes "4 k 217" on both sides alike.
    .replace(/(\p{N})(?=\p{L})/gu, "$1 ")
    .replace(/(\p{L})(?=\p{N})/gu, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The value appears in the document as whole words and whole numbers (after normForMatch). "500 mg"
 * is not in "1500 mg", "2.5 mg" is not in "12.5 mg", "AMOX" is not in "AMOXICILLINE".
 */
export function grounded(value: string, corpus: string): boolean {
  const v = normForMatch(value);
  return !!v && ` ${corpus} `.includes(` ${v} `);
}

/** The numbers in a text, as numbers: "03" and "3" match, "2,500" and "2.500" match, "½" is 0.5. */
export function numbersIn(text: string): string[] {
  const t = asciiDigits(text);
  const digits = (t.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => String(Number(n.replace(",", "."))));
  const fractions = [...t].filter((c) => c in FRACTIONS).map((c) => String(FRACTIONS[c]));
  return [...digits, ...fractions];
}

// Words that belong to a number on a medical paper: "500 mg" and "500 ml" are different readings.
const UNITS = new Set([
  "mg", "g", "µg", "mcg", "ml", "l", "cl", "dl", "ui", "iu", "%", "kg", "cp", "cps", "cpr", "comprime", "comprimes", "gelule", "gelules",
  "capsule", "capsules", "tablet", "tablets", "fois", "x", "jour", "jours", "j", "h", "heures", "semaine", "semaines", "mois", "sachet", "sachets",
  "goutte", "gouttes", "gtt", "cuillere", "cuilleres", "ampoule", "ampoules", "dose", "doses", "times", "days", "day", "weeks", "drops",
  "مغ", "ملغ", "ملغم", "غ", "مل", "حبه", "حبة", "حبات", "حبوب", "مره", "مرة", "مرات", "يوم", "ايام", "اسبوع", "اسابيع", "شهر", "قطره", "قطرة", "قطرات", "كيس", "اكياس", "ملعقه", "ملعقة",
]);

/**
 * The numbers of a line, in order, each with its unit when one follows: «1 comprimé 3 fois par jour»
 * gives ["1 comprime", "3 fois"]. Two readings agree on a line when these are identical, character for
 * character ("03" is not "3", "2.5" is not "25").
 */
export function numberSignature(text: string): string[] {
  const words = normForMatch(text).split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (!hasNumber(words[i])) continue;
    const next = words[i + 1];
    out.push(next && UNITS.has(next) ? `${words[i]} ${next}` : words[i]);
  }
  return out;
}


// --- which voice reads a line ----------------------------------------------------------------------

const EN_WORDS = /\b(?:the|and|of|tablets?|capsules?|for|with|use|before|after|store|keep|children|each|contains?|dear|total|amount|due|date|invoice|bill)\b/gi;
const FR_WORDS = /\b(?:le|la|les|des|du|de|et|comprimés?|gélules?|pour|avec|boîte|flacon|conserver|enfants|voie|orale|par|jour|fois|facture|montant|total|monsieur|madame|date)\b/gi;
const count = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/**
 * The voice for a piece of document text. Arabic script in the user's Arabic voice; Latin script in
 * French (most Tunisian packages and prescriptions), or English when it is clearly English.
 */
export function scriptLang(text: string, userLang: SpeechLang): SpeechLang {
  const arabic = count(/[؀-ۿ]/g, text);
  const latin = count(/[A-Za-zÀ-ÿ]/g, text);
  if (!arabic && !latin) return userLang;
  if (arabic >= latin) return userLang === "tn" || userLang === "ar" ? userLang : "ar";
  const en = count(EN_WORDS, text);
  const fr = count(FR_WORDS, text) + (/[àâçéèêëîïôûùœ]/i.test(text) ? 1 : 0);
  if (userLang === "fr" || userLang === "en") return en > fr ? "en" : fr > en ? "fr" : userLang;
  return en > fr ? "en" : "fr";
}

const endSentence = (line: string) => (/[.!?؟:;،,]$/.test(line) ? line : `${line}.`);
const say = (text: string): SpeechSegment => ({ text, source: "assistant" });

/** Lines as spoken parts: neighbours in the same language share one part. */
function lineSegments(lines: string[], userLang: SpeechLang): SpeechSegment[] {
  const out: SpeechSegment[] = [];
  for (const line of lines) {
    const lang = scriptLang(line, userLang);
    const last = out[out.length - 1];
    if (last && last.lang === lang) last.text = `${last.text} ${endSentence(line)}`;
    else out.push({ text: endSentence(line), source: "document", lang });
  }
  return out;
}

// --- dates --------------------------------------------------------------------------------------------

const DATE_LIKE = /(?<!\d)\d{1,4}[/.-]\d{1,2}(?:[/.-]\d{2,4})?(?!\d)|\b(?:exp|per|peremption|expiry|expiration|use by|fab|mfg)\b|صلاحي|انتهاء/i;
export const isDateLike = (text: string) => DATE_LIKE.test(asciiDigits(normalizeArabic(text)));

/**
 * Whether a printed expiry date has passed, computed here rather than by the model, and only for
 * unambiguous numeric dates. Null (nothing is said about it) for two dates («FAB … EXP …»), month
 * names, impossible values, and day/month dates that read differently either way round (03/04/2027).
 */
export function expiryStatus(text: string, now: Date): "expired" | "this-month" | "valid" | null {
  const t = asciiDigits(text);
  if ((t.match(/\d{1,4}[/.-]\d{1,4}/g) ?? []).length > 1) return null;
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  let y = 0, m = 0, d = 0;
  let r: RegExpExecArray | null;
  if ((r = /(?<!\d)(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?!\d)/.exec(t))) [d, m, y] = [Number(r[1]), Number(r[2]), year(r[3])];
  else if ((r = /(?<!\d)(\d{4})[/.-](\d{1,2})(?!\d)/.exec(t))) [y, m] = [Number(r[1]), Number(r[2])];
  else if ((r = /(?<!\d)(\d{1,2})[/.\s-]+(\d{4}|\d{2})(?!\d)/.exec(t))) [m, y] = [Number(r[1]), year(r[2])];
  else return null;
  if (m < 1 || m > 12 || y < 2000 || y > 2100 || d > 31) return null;
  if (d && d <= 12 && d !== m) return null; // 03/04/2027: 3 April or 4 March
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Tunis", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(now).map((p) => [p.type, Number(p.value)]));
  const ny = parts.year, nm = parts.month, nd = parts.day;
  if (y !== ny || m !== nm) return y < ny || (y === ny && m < nm) ? "expired" : "valid";
  if (d) return d < nd ? "expired" : "valid";
  return "this-month"; // a month-only date: it ends some time this month
}

// --- doses and medical questions -------------------------------------------------------------------------

const SPELLED_NUMBER = new RegExp(
  "(?:^|\\s)(?:واحد|واحدة|وحدة|زوز|ثلاثة|تلاثة|ثلاث|اربعة|اربع|خمسة|نص|نصف|اثنين|اثنان|اثنتين|حبتين|مرتين)(?:\\s|$)" +
    "|\\b(?:un|une|deux|trois|quatre|cinq|six|demi|moitie|one|two|three|four|five|six|half|twice|thrice|once|double)\\b",
  "i",
);
const DOSE_UNIT = new RegExp(
  "(?:^|\\s)(?:ملغ|مغ|ملغم|غرام|غ|ميليغرام|مل|حبه|حبة|حبات|حبتين|حبوب|حباية|كعبه|كعبة|كعبات|كبسوله|كبسولة|قطره|قطرة|قطرات|ملعقه|ملعقة|معلقة|جرعه|جرعة|كيس)(?:\\s|$)" +
    "|\\b(?:mg|mcg|µg|g|gr|grammes?|milligrammes?|grams?|milligrams?|ml|ui|cp|cps|comprimes?|gelules?|capsules?|tablets?|pills?|drops?|gouttes?|sachets?|cuilleres?|teaspoons?|spoons?|doses?|units?)\\b",
  "i",
);

/** A sentence that states an amount of a medicine («2 حبات», «500 mg», «one tablet», «½ cp»). */
export function mentionsDose(text: string): boolean {
  const n = normForMatch(text).replace(/'/g, " ");
  return DOSE_UNIT.test(n) && (hasNumber(n) || SPELLED_NUMBER.test(n));
}

// A question about medicines or doses. It never gets an ordinary answer: it goes through the
// reading rules (a reading of the box or paper), or is declined. Matched on normForMatch() text.
const MEDICAL_QUESTION = new RegExp(
  "(?:^|\\s)(?:و|ف)?(?:بال|لل|هال|ال|ه|ب|ل|ك)?(?:دواء|دوا|ادوية|ادويه|دوايات|حبة|حبه|حبات|حبوب|حباية|حبايات|حبتين|كعبة|كعبه|كعبات|كبسولة|كبسوله|كبسولات|جرعة|جرعه|جرعات|سيرو|مرهم|قطرات|انسولين|وصفة|وصفه|اوردونونس|مضاد حيوي)(?:\\s|$)" +
    "|\\b(?:medicaments?|medicines?|medications?|drugs?|comprimes?|cachets?|gelules?|pilules?|pills?|tablets?|capsules?|doses?|dosage|posologie|sirop|syrup|ordonnance|prescriptions?|antibiotiques?|antibiotics?|paracetamol|acetaminophen|ibuprofene?|aspirine?|insuline?|mg)\\b",
  "i",
);
const ARABIZI_MEDICAL = /\b(?:e?dwa|dwe|dwayet|7abb?a|7abet|7boub|jor3a)\b/i;
export const isMedicalQuestion = (question: string) => MEDICAL_QUESTION.test(normForMatch(question).replace(/'/g, " ")) || ARABIZI_MEDICAL.test(question);

// Asking whether to take, change or stop a medicine: never answered, whatever the paper says.
const ADVICE_QUESTION = new RegExp(
  "(?:^|\\s)(?:نجم ناخذ|ننجم ناخذ|نجم نشرب|نزيد|ننقص|نوقف|نبدل|نبطل|يصلحلي|ينفعني|يضرني|هل يمكنني|هل يمكن ان|هل اتناول|هل اخذ|هل يجب|هل استطيع)(?:\\s|$)" +
    "|\\b(?:je peux prendre|puis je prendre|est ce que je (?:peux|dois)|dois je|je peux arreter|je peux doubler|c est dangereux)\\b" +
    "|\\b(?:can i take|should i take|may i take|is it ok to take|is it safe to take|can i stop|should i stop|can i give|can i double|is it safe for me)\\b",
  "i",
);
export const asksMedicalAdvice = (question: string) => ADVICE_QUESTION.test(normForMatch(question).replace(/'/g, " "));

// --- explanations (bills, letters and other non-medical papers only) --------------------------------

/**
 * The model's explanation of a non-medical paper, without any sentence that brings a number the
 * paper doesn't contain (an amount, a date) or states a medicine dose. Medical papers get no AI
 * explanation at all (see sanitizeDocument).
 */
export function guardExplanation(text: string, opts: { corpus: string }): string {
  const known = new Set(numbersIn(opts.corpus));
  return splitSentences(text)
    .filter((sentence) => !numbersIn(sentence).some((n) => !known.has(n)) && !mentionsDose(sentence))
    .join(" ");
}

// --- a Derja rendering of an instruction, from a fixed glossary ------------------------------------------

// DRAFT, pending review by a Tunisian pharmacist. Phrases first (longest match wins), on
// normForMatch() words. A line is rendered only if every word is in here or is a plain number.
const DERJA_INSTRUCTIONS: [string, string][] = [
  ["cuillere a cafe", "مغرفة صغيرة"], ["cuilleres a cafe", "مغارف صغار"], ["cuillere a soupe", "مغرفة كبيرة"], ["cuilleres a soupe", "مغارف كبار"],
  ["fois par jour", "مرات في النهار"], ["par jour", "في النهار"], ["le matin", "الصباح"], ["le midi", "نص النهار"], ["le soir", "العشية"],
  ["au coucher", "قبل ما ترقد"], ["a jeun", "على الريق"], ["avant les repas", "قبل الماكلة"], ["apres les repas", "بعد الماكلة"],
  ["avant le repas", "قبل الماكلة"], ["apres le repas", "بعد الماكلة"], ["si douleur", "كان فمّا وجيعة"], ["si fievre", "كان فمّا سخانة"], ["si toux", "كان فمّا كحّة"],
  ["comprime", "حبّة"], ["comprimes", "حبّات"], ["cp", "حبّة"], ["gelule", "كبسولة"], ["gelules", "كبسولات"], ["sachet", "كيس"], ["sachets", "أكياس"],
  ["goutte", "قطرة"], ["gouttes", "قطرات"], ["fois", "مرات"], ["matin", "الصباح"], ["midi", "نص النهار"], ["soir", "العشية"],
  ["pendant", "مدة"], ["jour", "يوم"], ["jours", "أيام"], ["semaine", "جمعة"], ["semaines", "جمعات"], ["mois", "شهر"], ["et", "و"],
  ["mg", "ميليغرام"], ["ml", "ميليلتر"], ["1/2", "نص"], ["½", "نص"],
];

/** «1 comprimé 3 fois par jour pendant 5 jours» → «1 حبّة 3 مرات في النهار مدة 5 أيام», or null. */
export function derjaInstruction(line: string): string | null {
  const words = normForMatch(line).split(" ").filter(Boolean);
  if (!words.length) return null;
  const out: string[] = [];
  let mapped = 0;
  for (let i = 0; i < words.length;) {
    const hit = DERJA_INSTRUCTIONS
      .map(([fr, tn]) => ({ n: fr.split(" ").length, fr, tn }))
      .filter((e) => words.slice(i, i + e.n).join(" ") === e.fr)
      .sort((a, b) => b.n - a.n)[0];
    if (hit) {
      out.push(hit.tn);
      mapped++;
      i += hit.n;
    } else if (/^\d+(?:\.\d+)?$/.test(words[i])) {
      out.push(words[i]);
      i++;
    } else return null; // one unknown word: no rendering, the original is enough
  }
  return mapped ? out.join(" ") : null;
}

// --- from model output to what is said --------------------------------------------------------------------

export interface DocumentSanitizeContext {
  lang: SpeechLang;
  question?: string;
  /** The document read earlier, for a follow-up question. Its lines were already checked. */
  context?: DocumentContext;
  now: Date;
  /**
   * The second, independent reading (another frame, another model when possible), or null when it
   * was not available. Undefined: no second reading was asked for (no new picture).
   */
  confirm?: Record<string, unknown> | null;
  /** For tests; otherwise DERJA_GLOSSARY_APPROVED decides. */
  derjaGlossary?: boolean;
  /**
   * The pixel check of a line in the first and the second frame (lineCheck.ts). Missing (no picture,
   * or a picture that couldn't be decoded): no line of a medical paper can be checked, so none is read.
   */
  inspect?: { first?: (box: unknown, text: string) => LineProblem | null; second?: (box: unknown, text: string) => LineProblem | null };
}

// Problems that make the visible text itself hard to read. "cut_off" only hides what is outside the frame.
const BLURS_TEXT = new Set<ReadProblem>(["blurry", "glare", "dark", "angle", "too_far", "handwriting"]);
// An unreadable mark anywhere in a line: «[?]», «??», «…», a «?» inside a word or number («5?0», «GASTR?NIL»).
const GAP = /\[\?\]|\?\?|…|\.\.\.|[\p{L}\p{N}]\?[\p{L}\p{N}]|\?\p{N}|\p{N}\?|_{2,}/u;

interface ParsedReading {
  kind: DocKind;
  legibility: Legibility;
  problems: ReadProblem[];
  lines: DocLine[];
}

function parseReading(raw: Record<string, unknown>): ParsedReading {
  const lines: DocLine[] = (Array.isArray(raw.lines) ? raw.lines : [])
    .slice(0, MAX_LINES)
    .map((l) => obj(l))
    .map((l) => {
      const text = str(l.text, MAX_LINE);
      // A gap the model marked as unreadable, or a line it says isn't fully visible (cut by the edge,
      // covered, under glare), is unsure, whatever confidence it gave: it may have been completed.
      const hidden = GAP.test(text) || l.fully_visible === false;
      const confidence: Confidence = hidden ? "uncertain" : oneOf<Confidence>(l.confidence, CONFIDENCES, "uncertain");
      // "box_2d" is Gemini's own name for it, and gave better boxes (e2e/read/boxvariants.ts); "box" still accepted.
      const box = parseBox(l.box_2d ?? l.box);
      // Where the locating model places this line (vision.ts): a box, null ("not fully visible"), or
      // absent (no locating was done).
      const located = "located_box" in l ? (parseBox(l.located_box) ?? null) : undefined;
      return { text, confidence, ...(box ? { box } : {}), ...(located !== undefined ? { located } : {}) };
    })
    .filter((l) => l.text);
  let kind = oneOf<DocKind>(raw.doc_type, DOC_KINDS, lines.length ? "other" : "none");
  if (kind === "none" && lines.length) kind = "other";
  const legibility = oneOf<Legibility>(raw.legibility, LEGIBILITY, "partial");
  const problems = [...new Set((Array.isArray(raw.problems) ? raw.problems : []).filter((p): p is ReadProblem => PROBLEMS.includes(p as ReadProblem)))];
  return { kind, legibility, problems, lines };
}

/**
 * The lines that may be read out. On medical papers, only confirmed ones; and when the model reports
 * the paper as not fully legible because of glare, blur and the like, not the lines with numbers in
 * them either. The real model was seen to fill in a dose half hidden by glare («500 m…» → «500 mg»)
 * and still call that line confirmed, while reporting the glare.
 */
export function readableLines(doc: { lines: DocLine[]; kind: DocKind; legibility: Legibility; problems: ReadProblem[] }): DocLine[] {
  const medical = isMedical(doc.kind);
  const shaky = medical && doc.legibility !== "clear" && (!doc.problems.length || doc.problems.some((p) => BLURS_TEXT.has(p)));
  return doc.lines.filter((l) => (l.confidence === "confirmed" || (!medical && l.confidence === "likely")) && !(shaky && hasNumber(l.text)) && !(medical && BARE_NUMBER.test(l.text)));
}

// A medical line that is only a number, with no word or unit: «50» could be what is left of
// «500 mg» under a finger (seen with the real model). It is never read out.
const BARE_NUMBER = /^[\s\d٠-٩۰-۹.,/:½¼¾⅓⅔-]*$/; // "%" is a unit: «0,5 %» is a strength
// A strength is a number with its unit («500 mg», «2,5 mg», «0,5 %», «120 mg/5 ml»). Without one, it is not said.
const HAS_UNIT = /\d\s*(?:(?:mg|g|µg|mcg|ml|l|ui|iu|mmol|meq|u)\b|%)|\d\s*(?:ملغ|مغ|غ|مل|ملغم)|[½¼¾]\s*(?:mg|g|ml)/i;

export function sanitizeDocument(raw: Record<string, unknown>, ctx: DocumentSanitizeContext): SceneAnalysis {
  const t = speech(ctx.lang).doc;
  const first = parseReading(raw);
  const { legibility, problems, lines } = first;
  let kind = first.kind;
  // A follow-up without new text is about the document read before: its kind (and its medical rules) hold.
  if (ctx.context && (!lines.length || kind === "none")) kind = ctx.context.kind;
  const second = ctx.confirm ? parseReading(ctx.confirm) : null;
  // Medical if either reading or the earlier document says so: the stricter rules win.
  const medical = isMedical(kind) || (!!second && isMedical(second.kind)) || (!!ctx.context && isMedical(ctx.context.kind));
  const asKind: DocKind = medical && !isMedical(kind) ? "medical" : kind;

  let readable = readableLines({ lines, kind: asKind, legibility, problems });
  /**
   * The pixel check in the first frame. The first reading's own box is used, unless the locating
   * model placed the line: then its box decides, except when the own box already shows a solid mass
   * or the picture's edge there (evidence the locator can't overrule). A line the locator says is
   * not fully visible (null) is not read.
   */
  const checkFirst = (l: DocLine): LineProblem | null => {
    if (!ctx.inspect?.first) return "no-box";
    const own = ctx.inspect.first(l.box, l.text);
    if (l.located === undefined || own === "covered" || own === "edge") return own;
    return l.located === null ? "no-box" : ctx.inspect.first(l.located, l.text);
  };
  // Why each line was or wasn't read: for diagnosis and the test reports only, never spoken.
  const checks: { text: string; verdict: string }[] = lines.map((l) => ({ text: l.text, verdict: readable.includes(l) ? "ok" : `unsure:${l.confidence}` }));
  const verdict = (l: DocLine, v: string) => {
    const c = checks[lines.indexOf(l)];
    if (c) c.verdict = v;
  };
  // A medical paper: each line must be in the second reading too, word for word and number for
  // number, and whole in the pixels of both frames where the readings place it.
  let disputed = 0;
  const obscured: LineProblem[] = [];
  if (medical && lines.length) {
    const confirming = second ? readableLines({ lines: second.lines, kind: asKind, legibility: second.legibility, problems: second.problems }) : null;
    const confirmingCorpus = confirming ? normForMatch(confirming.map((l) => l.text).join(" \n ")) : "";
    readable = readable.filter((l) => {
      if (!confirming || !grounded(l.text, confirmingCorpus)) {
        disputed++;
        verdict(l, confirming ? "disputed" : "no-second-reading");
        return false;
      }
      const own = normForMatch(l.text);
      const same = confirming.filter((m) => grounded(m.text, own) || grounded(l.text, normForMatch(m.text)));
      const inFirst = checkFirst(l);
      const inSecond = !ctx.inspect?.second || !same.length ? "no-box" : same.map((m) => ctx.inspect!.second!(m.box, m.text)).find((p) => p) ?? null;
      const problem = inFirst ?? inSecond;
      if (problem) obscured.push(problem);
      verdict(l, problem ? `${problem}:${inFirst ? "first" : "second"}` : "ok");
      return !problem;
    });
  }
  const unconfirmed = disputed > 0;
  // No second reading at all (the service was busy): a clearer picture wouldn't help, asking again might.
  const secondMissing = medical && lines.length > 0 && !second && ctx.confirm === null;
  const hidden = obscured.length > 0;
  // The most telling problem decides how to take the next picture.
  const obscuredTip = obscured.includes("edge") ? t.tip.cut_off : obscured.includes("covered") ? t.tip.covered : obscured.includes("incomplete") ? t.tip.incomplete : t.tip.generic;
  const unclear = readable.length < lines.length;
  const withheld = disputed + obscured.length;
  const contextLines = ctx.context?.lines ?? [];
  const corpus = normForMatch([...readable.map((l) => l.text), ...contextLines].join(" \n "));
  const tip = t.tip[problems[0] ?? "generic"] ?? t.tip.generic;
  const glossary = (ctx.derjaGlossary ?? DERJA_GLOSSARY_APPROVED) && ctx.lang === "tn";

  /** A line of a medical paper, then at once what to do about it if it has a dose or a date. */
  const medicalLine = (text: string): SpeechSegment[] => {
    const out = lineSegments([text], ctx.lang);
    if (!hasNumber(text)) return out;
    const derja = glossary ? derjaInstruction(text) : null;
    if (derja) out.push(say(t.derjaMeans), say(derja));
    out.push(say(isDateLike(text) && !mentionsDose(text) ? t.checkDate : t.checkDose));
    return out;
  };
  const speakLines = (texts: string[]) => (medical ? texts.flatMap(medicalLine) : lineSegments(texts, ctx.lang));

  // Medicine fields: only what is written, in a clearly read (and, for numbers, twice read) line.
  const rawMed = obj(raw.medicine);
  const medicine: MedicineFields = {};
  let strengthDropped = false;
  let expiryDropped = false;
  if (kind === "medicine") {
    for (const f of MEDICINE_FIELDS) {
      const v = str(rawMed[f], MAX_FIELD);
      if (v && grounded(v, corpus) && !GAP.test(v) && (f !== "strength" || HAS_UNIT.test(asciiDigits(v)))) medicine[f] = v;
      else if (v && f === "strength") strengthDropped = true;
      else if (v && f === "expiry") expiryDropped = true;
    }
  }

  const answer = obj(raw.answer);
  const question = ctx.question?.trim() ?? "";
  const notAboutDocument = !!question && !!ctx.context && answer.about_document === false;
  // No AI explanation of a medical paper, ever: no uses, no warnings, no instructions in other words.
  const explanation = medical ? "" : guardExplanation(str(question ? answer.explanation : raw.explanation, MAX_EXPLANATION), { corpus });

  const segments: SpeechSegment[] = [];
  let rescan = false;
  let more = false;
  const header = t.kind[asKind];
  /** Why some of it wasn't read, and how to get a better picture. */
  const doubtNotes = () => [
    ...(unconfirmed ? [say(secondMissing ? t.secondMissing : t.unconfirmed)] : []),
    ...(hidden ? [say(t.obscured), say(obscuredTip)] : []),
    ...(lines.length - readable.length - withheld > 0 ? [say(t.unclearParts)] : []),
    ...(unclear && !hidden ? [say(tip)] : []),
  ];

  if (notAboutDocument) {
    // The client asks it again as an ordinary question (or declines it, if it is about medicines).
  } else if (!readable.length && !contextLines.length) {
    rescan = true;
    if (!lines.length && legibility !== "unreadable") segments.push(say(t.noText), say(t.tip.generic));
    else if (withheld) segments.push(...(header ? [say(header)] : []), ...doubtNotes());
    else segments.push(...(header ? [say(header)] : []), say(t.unreadable), say(tip));
  } else if (question) {
    // A question about the document: what was read answers it, then (non-medical only) the assistant's words.
    const quote = str(answer.quote, MAX_LINE * 2);
    const quoteOk = !!quote && !GAP.test(quote) && grounded(quote, corpus);
    if (!ctx.context && header) segments.push(say(header));
    if (quoteOk) segments.push(say(t.quote), ...(medical ? medicalLine(quote) : lineSegments([quote], ctx.lang)));
    else segments.push(say(t.notFound));
    if (explanation) segments.push(say(quoteOk ? t.explanation : t.general), say(explanation));
    if (medical && asksMedicalAdvice(question)) segments.push(say(t.noAdvice));
    if (!quoteOk && unclear) segments.push(...doubtNotes());
  } else {
    if (header) segments.push(say(header));
    if (kind === "medicine") {
      const labels: Record<(typeof MEDICINE_FIELDS)[number], string> = { name: t.name, ingredient: t.ingredient, strength: t.strength, form: t.form, quantity: t.quantity, expiry: t.expiry };
      for (const f of MEDICINE_FIELDS) {
        const v = medicine[f];
        if (!v) continue;
        segments.push(say(labels[f]), ...lineSegments([v], ctx.lang));
        // Identical misreadings in both readings are possible: the name is checked by a person too.
        if (f === "name" || f === "ingredient") segments.push(say(t.checkName));
        if (f === "strength") segments.push(say(t.checkDose));
        if (f === "expiry") {
          // The check comes immediately after the date; the (conditional) status after it.
          segments.push(say(t.checkDate));
          const status = expiryStatus(v, ctx.now);
          if (status) segments.push(say(status === "expired" ? t.expired : status === "this-month" ? t.expiresThisMonth : t.notExpired));
        }
      }
      // Withheld for disagreement or hiding: the summary below says why, once.
      if (!medicine.name && !withheld) segments.push(say(t.nameUnclear));
      if (strengthDropped && !withheld) segments.push(say(t.strengthUnclear));
      if (expiryDropped && !withheld) segments.push(say(t.expiryUnclear));
      // Nothing to say about the medicine at all: the picture must be taken again.
      if (!Object.keys(medicine).length) rescan = true;
      more = readable.length > 0;
    } else {
      const { spoken, cut } = firstPart(readable.map((l) => l.text));
      segments.push(say(t.textIntro), ...speakLines(spoken));
      more = cut;
    }
    segments.push(...doubtNotes());
    if (rescan && !unclear) segments.push(say(tip));
    if (explanation) segments.push(say(t.explanation), say(explanation));
    if (medical) segments.push(say(t.checkPharmacist));
    if (more) segments.push(say(kind === "medicine" ? t.readAll : t.long));
  }

  const reading: DocumentReading = {
    kind: asKind,
    legibility,
    problems,
    // Lines not confirmed by the second reading, or not whole in the pixels, are kept as uncertain,
    // so "read all" and follow-ups skip them too.
    lines: lines.map((l) => (readable.includes(l) || !medical ? l : { ...l, confidence: "uncertain" as const })),
    medicine,
    explanation,
    rescan,
    ...(notAboutDocument ? { notAboutDocument: true } : {}),
    ...(unconfirmed ? { unconfirmed: true } : {}),
    ...(medical ? { checks } : {}),
    ...(hidden ? { obscured: [...new Set(obscured)] } : {}),
    segments,
    more,
  };
  return {
    spoken: segments.map((s) => s.text).join(" "),
    changed: true,
    imageQuality: problems.includes("dark") ? "dark" : problems.includes("blurry") ? "blurry" : "good",
    environment: null,
    detections: [],
    hazards: [],
    texts: readable.map((l) => ({ content: l.text, confidence: l.confidence })),
    uncertain: rescan || withheld > 0,
    document: reading,
  };
}

/** The lines that fit in one reading. */
function firstPart(lines: string[]): { spoken: string[]; cut: boolean } {
  const spoken: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (spoken.length && chars + line.length > MAX_READ_CHARS) return { spoken, cut: true };
    spoken.push(line);
    chars += line.length;
  }
  return { spoken, cut: false };
}

/** "Read all": every readable line of the last document, without another picture, with the same checks after doses and dates. */
export function readAllSegments(doc: DocumentReading, lang: SpeechLang, opts: { derjaGlossary?: boolean } = {}): SpeechSegment[] {
  const t = speech(lang).doc;
  const lines = readableLines(doc).map((l) => l.text);
  if (!lines.length) return [say(t.unreadable), say(t.tip.generic)];
  const medical = isMedical(doc.kind);
  const glossary = (opts.derjaGlossary ?? DERJA_GLOSSARY_APPROVED) && lang === "tn";
  const out: SpeechSegment[] = [say(t.textIntro)];
  if (!medical) out.push(...lineSegments(lines, lang));
  else {
    for (const line of lines) {
      out.push(...lineSegments([line], lang));
      if (!hasNumber(line)) continue;
      const derja = glossary ? derjaInstruction(line) : null;
      if (derja) out.push(say(t.derjaMeans), say(derja));
      out.push(say(isDateLike(line) && !mentionsDose(line) ? t.checkDate : t.checkDose));
    }
  }
  if (lines.length < doc.lines.length) out.push(say(doc.unconfirmed ? t.unconfirmed : doc.obscured?.length ? t.obscured : t.unclearParts));
  return out;
}

/** What goes back to the server with a follow-up question: the clearly read (and confirmed) lines only. */
export function documentContext(doc: DocumentReading): DocumentContext {
  return { kind: doc.kind, lines: readableLines(doc).map((l) => l.text).slice(0, MAX_CONTEXT_LINES) };
}

// --- recognising a request to read -------------------------------------------------------------------------

// A question that asks for reading (rather than a description): it goes to the reading mode, with
// the question. Matched on normForMatch() text.
const READ_REQUEST = new RegExp(
  "(?:^|\\s)(?:اقرا|اقرالي|اقراها|اقراهالي|اقرأ|مكتوب|الدوا|دوا|الدواء|دواء|الوصفة|وصفة|الفاتورة|فاتورة|الجواب|الرسالة|رسالة|الورقة|الصلاحية|الجرعة)(?:\\s|$)" +
    "|\\b(?:lis|lire|lisez|ecrit|medicament|ordonnance|facture|lettre|notice|posologie|peremption|dosage)\\b" +
    "|\\b(?:read|written|medicine|medication|prescription|invoice|bill|letter|label|leaflet|expiry|expiration|dosage|dose)\\b",
  "i",
);
export const isReadRequest = (question: string) => READ_REQUEST.test(normForMatch(question).replace(/'/g, " "));
