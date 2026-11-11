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

/** Cloud voices for languages other than Tunisian (whose voice the server reads from EDGE_TTS_VOICE). */
export const CLOUD_VOICES: Record<Exclude<SpeechLang, "tn">, string> = {
  ar: "ar-SA-HamedNeural",
  fr: "fr-FR-DeniseNeural",
  en: "en-US-JennyNeural",
};

// --- the language of a question -----------------------------------------------------------------
// The answer comes in the language the question was asked in, among those the assistant speaks.
// Only clear signs count; anything unclear keeps the chosen language. Derja written in Latin
// letters (Arabizi) is Derja.

const DERJA = /(?:^|[\s،,.؟?!«(])(?:و|ف)?(?:شنو|شنوة|شنوّة|شنيّة|شنية|شكون|فمّا|فما|مافماش|ما فماش|توّة|توة|برشة|برشا|باش|علاش|كيفاش|وقتاش|قدّاش|قداش|نحب|يعيشك|هاذا|هاذي|قدّامي|قدامي|متاع|موش|ياسر|زادا|نجم|تنجم|كيما|هوني|غادي|اقرالي|وصفلي|صفلي|عاود|بالله)(?=$|[\s،,.؟?!»)])/;
const MSA = /(?:^|[\s،,.؟?!«(])(?:ماذا|هل|أين|اين|لماذا|متى|أمامي|امامي|يوجد|توجد|هذه|الذي|التي|أريد|اريد|أستطيع|يمكنك|يمكن|من فضلك|لو سمحت|ما هو|ما هي|ما هذا|ما الذي)(?=$|[\s،,.؟?!»)])/g;
const ARABIZI = /\b(?:chnowa|chnoua|chnou|chnia|chniya|chkoun|famma|fama|barcha|kifech|kifach|3lech|3lach|9odemi|9edemi|9adem|hedha|hedhi|ya3tik|ya3tek|n7eb|nheb|ta9ra|t9ra|tawa|taw|mta3|mouch|bech|wa9tech|9adech)\b|[a-z][2379][a-z]/i;
const FRENCH = /\b(?:le|la|les|est|c'est|qu'est|quoi|je|vous|tu|une|des|pour|comment|devant|moi|ce|cette|où|ou|quel|quelle|lire|lis|qui|dans|avec|sur|combien|aujourd'hui|merci)\b/gi;
const ENGLISH = /\b(?:the|is|what|how|are|you|this|my|front|read|where|which|of|who|in|with|much|today|please|can|there)\b/gi;

const count = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/** The language to answer a question in: the question's own, when it is clearly one we speak. */
export function questionLang(question: string, chosen: SpeechLang): SpeechLang {
  const q = question.trim();
  if (!q) return chosen;
  const arabicLetters = count(/[؀-ۿ]/g, q);
  const latinLetters = count(/[A-Za-zÀ-ÿ]/g, q);
  if (arabicLetters > latinLetters) {
    const derja = DERJA.test(q);
    const msa = count(MSA, q);
    if (chosen === "tn") return !derja && msa >= 2 ? "ar" : "tn"; // Derja speakers often write semi-standard Arabic
    if (chosen === "ar") return derja ? "tn" : "ar";
    return derja ? "tn" : "ar";
  }
  if (latinLetters === 0) return chosen;
  if (ARABIZI.test(q)) return "tn";
  const fr = count(FRENCH, q) + (/[àâçéèêëîïôûùœ]/i.test(q) ? 1 : 0);
  const en = count(ENGLISH, q);
  if (fr > en) return "fr";
  if (en > fr) return "en";
  return chosen;
}
