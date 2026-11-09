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
