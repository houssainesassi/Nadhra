// The languages the assistant can speak and hear. The interface stays in English; this only decides
// what the voice says, what the microphone expects, and the language of the model's replies.
// Pure data, shared by the browser and the server.

export type SpeechLang = "tn" | "ar" | "fr" | "en";

export const SPEECH_LANGS: readonly SpeechLang[] = ["tn", "ar", "fr", "en"];

export const isSpeechLang = (v: unknown): v is SpeechLang => typeof v === "string" && (SPEECH_LANGS as readonly string[]).includes(v);

export interface LangInfo {
  /** For the settings menu (the interface is in English). */
  label: string;
  /** For lang="" attributes, so screen readers switch voice. */
  bcp47: string;
  dir: "rtl" | "ltr";
  /** SpeechRecognition.lang */
  recognition: string;
  /** Installed voices to look for, best first. Matched on the language tag. */
  voices: string[];
  /** Words spoken in place of "/". */
  or: string;
}

export const LANGS: Record<SpeechLang, LangInfo> = {
  tn: { label: "Tunisian Arabic (Derja)", bcp47: "ar-TN", dir: "rtl", recognition: "ar-TN", voices: ["ar-TN", "ar-DZ", "ar-MA", "ar-LY", "ar-SA", "ar-EG", "ar"], or: "أو" },
  ar: { label: "Modern Standard Arabic", bcp47: "ar", dir: "rtl", recognition: "ar-SA", voices: ["ar-SA", "ar-AE", "ar-EG", "ar-JO", "ar-TN", "ar"], or: "أو" },
  fr: { label: "French", bcp47: "fr", dir: "ltr", recognition: "fr-FR", voices: ["fr-FR", "fr-BE", "fr-CH", "fr-CA", "fr"], or: "ou" },
  en: { label: "English", bcp47: "en", dir: "ltr", recognition: "en-US", voices: ["en-US", "en-GB", "en-AU", "en-CA", "en-IN", "en"], or: "or" },
};

/** Cloud voices for languages other than Tunisian (whose voice the server reads from EDGE_TTS_VOICE). All female. */
export const CLOUD_VOICES: Record<Exclude<SpeechLang, "tn">, string> = {
  ar: "ar-SA-ZariyahNeural",
  fr: "fr-FR-DeniseNeural",
  en: "en-US-JennyNeural",
};

// --- the language of a question -----------------------------------------------------------------
// The answer comes in the language the question was asked in, among those the assistant speaks.
// Only clear signs count; anything unclear keeps the language of the conversation so far (a short
// follow-up like «w ba3d?» or «OK» doesn't switch), then the chosen one. Derja written in Latin
// letters (Arabizi) is Derja. Matching ignores Arabic vowel marks, shadda and hamza forms.

/** Vowel marks, shadda and tatweel removed, hamza forms of alef and final ى folded: «شنوّة» = «شنوة». */
const foldArabic = (text: string) => text.replace(/[\u064B-\u0652\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي");

// Words a Tunisian writes and a speaker of Modern Standard Arabic doesn't, in folded spelling. Verbs
// may carry an object suffix («عاودلي», «اقراهالي»).
const DERJA_WORDS = [
  "شنو", "شنوة", "شنوا", "شنية", "شنيا", "شكون", "اش", "واش", "فما", "فماش", "مافماش", "توة", "توا", "برشة", "برشا", "باش",
  "علاش", "علاه", "كيفاش", "كيفاه", "وقتاش", "وقتاه", "قداش", "قداه", "وين", "منين", "نحب", "يعيشك", "عيشك", "هاذا",
  "هاذي", "هاذيكا", "قدامي", "قدامك", "متاع", "متاعي", "موش", "مش", "ياسر", "زادا", "نجم", "تنجم", "كيما", "هوني", "غادي",
  "بربي", "عسلامة", "شبيك", "شبيكم", "لاباس", "باهي", "ياخي", "هكا", "هكاكة", "مازال", "مزال", "يزي", "برا", "ايه", "بالحق",
  "اقرالي", "وصفلي", "صفلي", "عاود", "عاودلي", "قلي", "شوفلي", "عيطلي", "بالله",
];
const DERJA = new RegExp(`(?:^|[\\s،,.؟?!«(])(?:و|ف)?(?:${DERJA_WORDS.join("|")})(?:لي|لك|ها|هالي|هم)?(?=$|[\\s،,.؟?!»)])`);
const MSA = /(?:^|[\s،,.؟?!«(])(?:ماذا|هل|اين|لماذا|متي|امامي|يوجد|توجد|هذه|الذي|التي|اريد|استطيع|يمكنك|يمكن|من فضلك|لو سمحت|ما هو|ما هي|ما هذا|ما الذي|الان|كم|ليس|سوف|لكن)(?=$|[\s،,.؟?!»)])/g;
// Arabizi: the digits that stand for Arabic letters (3 ع, 7 ح, 9 ق, 5 خ, 2 ء) inside a word, or a
// word only Derja has. Words that are also English or French («win», «ach», «fama») count only
// next to an Arabizi article or word, so «I win» stays English.
const ARABIZI = /\b(?:chn[aeiou]+w?[aeiou]*|chnia|chniya|chnya|chkoun|chkon|famma|mafamech|famech|barcha|barsha|kifech|kifach|kifeh|kifah|3lech|3lach|3leh|9odemi|9odamek|9edemi|9adem|hedha|hedhi|hadha|ya3tik|ya3tek|ya3tikessa7a|n7eb|nheb|t7eb|theb|ta9ra|t9ra|a9rali|tawa|mta3|mte3|mouch|mech|bech|wa9tech|9adech|9adeh|qadech|kadeh|kadech|brabi|bribi|chbik|chbikom|labes|aychek|3aychek|3aslema|aslema|mektoub|mektouba|3awed|3awedli|chouf|choufli|9oli|9olli|ena|enti|enty|nesta7a9|ne5dem|lyoum|elyoum|ghodwa|barra|yezzi|yezi|zeda|zada|yesser|mezel|mazel|ma3neha)\b|[a-z][23579][a-z]|\b[3579][a-z]{3,}/i;
const ARABIZI_WEAK = /\b(?:win|wen|wesh|ach|fama|el|l|w|ya|lel|fi|3la|ala|mta|kif|kima|chay|wela|bel|lil)\b/gi;
const FRENCH = /\b(?:le|la|les|est|c'est|qu'est|quoi|je|vous|tu|une|des|pour|comment|devant|moi|ce|cette|où|ou|quel|quelle|lire|lis|qui|dans|avec|sur|combien|aujourd'hui|merci|il|elle|pas|mon|ma|mes|du|au|heure|temps|bonjour|salut)\b/gi;
const ENGLISH = /\b(?:the|is|what|how|are|you|this|my|front|read|where|which|of|who|in|with|much|today|please|can|there|it|do|does|time|i|me|and|to)\b/gi;

const count = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/**
 * The language to answer a question in: the question's own, when it is clearly one we speak.
 * `previous` is the language of the last answer in this conversation: an unclear question keeps it.
 */
export function questionLang(question: string, chosen: SpeechLang, previous?: SpeechLang): SpeechLang {
  const q = question.trim();
  const fallback = previous ?? chosen;
  if (!q) return fallback;
  const arabicLetters = count(/[\u0600-\u06FF]/g, q);
  const latinLetters = count(/[A-Za-zÀ-ÿ]/g, q);
  if (arabicLetters > latinLetters) {
    const folded = foldArabic(q);
    if (DERJA.test(folded)) return "tn";
    const msa = count(MSA, folded);
    if (chosen === "tn") return msa >= 2 ? "ar" : "tn"; // Derja speakers often write semi-standard Arabic
    if (msa === 0 && (previous === "tn" || previous === "ar")) return previous; // «والباب؟» after a Derja answer
    return "ar";
  }
  if (latinLetters === 0) return fallback;
  if (ARABIZI.test(q)) return "tn";
  const fr = count(FRENCH, q) + (/[àâçéèêëîïôûùœ]/i.test(q) ? 1 : 0);
  const en = count(ENGLISH, q);
  const weak = count(ARABIZI_WEAK, q);
  if (weak >= 2 && weak > fr && weak > en) return "tn"; // «win el bab?»
  if (fr > en) return "fr";
  if (en > fr) return "en";
  return fallback;
}
