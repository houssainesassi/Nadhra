// Spoken commands that control the assistant, handled on the device instead of going to the model.
// Only short phrases match, so a real question that happens to contain one of these words still
// reaches the model. Every command is understood in every speech language, whatever the setting:
// people mix languages, and the recognizer sometimes writes French or English in its own way.
// Pure logic.
import { normalizeArabic } from "./schema.ts";
import type { SpeechLang } from "./lang.ts";

export type VoiceCommand =
  | "stop-speech"
  | "repeat"
  | "pause"
  | "resume"
  | "camera-off"
  | "camera-on"
  | "assistant-off"
  | "yes"
  | "help"
  | "back"
  | "front"
  | "describe"
  | "read"
  | "identify"
  | "emergency"
  | "call"
  | "louder"
  | "quieter"
  | "faster"
  | "slower"
  | `lang-${SpeechLang}`;

const clean = (text: string) => normalizeArabic(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

// Tunisian, then Modern Standard Arabic, then French, then English. Accents and Arabic vowel marks
// are ignored when matching.
const COMMANDS: [VoiceCommand, string[]][] = [
  ["stop-speech", [
    "اسكت", "اسكت توة", "سكت", "بركة", "بركه", "يزي", "ايزي", "يزي برك", "وقف الكلام",
    "توقف عن الكلام", "كفى", "صمت",
    "tais toi", "taisez vous", "silence", "chut", "arrête de parler", "stop",
    "stop talking", "be quiet", "quiet", "shut up", "enough",
  ]],
  ["repeat", [
    "عاود", "عاودلي", "عاود قول", "عاود قولي", "شنوة قلت", "شنوه قلت",
    "أعد", "كرر", "ماذا قلت", "أعد من فضلك",
    "répète", "répétez", "tu as dit quoi", "qu est ce que tu as dit", "pardon",
    "repeat", "repeat that", "say again", "say that again", "what did you say",
  ]],
  // Pausing also stops hazard warnings, so no everyday word ("wait", «استني») can do it.
  ["pause", [
    "وقف التحليل", "وقف الوصف",
    "أوقف التحليل", "أوقف الوصف",
    "pause", "mets en pause", "pause l analyse",
    "pause analysis",
  ]],
  ["resume", [
    "كمل", "كمل التحليل", "رجع التحليل", "كمل الوصف", "ابدا",
    "تابع", "استمر", "واصل",
    "continue", "reprends", "reprendre",
    "resume", "go on", "carry on",
  ]],
  ["camera-off", [
    "سكر الكاميرا", "طفي الكاميرا", "اطفي الكاميرا", "وقف الكاميرا",
    "أطفئ الكاميرا", "أغلق الكاميرا", "أوقف الكاميرا",
    "éteins la caméra", "ferme la caméra", "arrête la caméra", "coupe la caméra",
    "close camera", "close the camera", "turn off the camera", "turn off camera", "stop camera", "stop the camera", "camera off",
  ]],
  ["camera-on", [
    "شعل الكاميرا", "حل الكاميرا", "ولع الكاميرا",
    "شغل الكاميرا", "افتح الكاميرا",
    "allume la caméra", "ouvre la caméra", "active la caméra", "démarre la caméra", "lance la caméra",
    "open camera", "open the camera", "turn on the camera", "turn on camera", "start camera", "start the camera", "camera on", "start assistance",
  ]],
  ["assistant-off", [
    "سكر الميكرو", "طفي الميكرو", "سكر المساعد", "طفي المساعد", "وقف المساعد",
    "أطفئ الميكروفون", "أغلق الميكروفون", "أوقف المساعد",
    "coupe le micro", "éteins le micro", "ferme le micro", "arrête d écouter",
    "turn off the microphone", "microphone off", "mic off", "stop listening",
  ]],
  ["yes", [
    "موافق", "نعم موافق", "ايه موافق",
    "أوافق", "نعم أوافق",
    "j accepte", "oui j accepte", "je suis d accord",
    "i agree", "yes i agree",
  ]],
  ["help", [
    "شنوة نجم نقول", "شنوة نجم نعمل", "الأوامر", "كيفاش نستعمل", "مساعدة", "معاونة",
    "ماذا يمكنني أن أقول", "ماذا أقول", "الأوامر", "كيف أستعمل",
    "aide", "que puis je dire", "qu est ce que je peux dire", "commandes",
    "help", "what can i say", "commands", "how does this work",
  ]],
  ["back", [
    "رجع", "رجّع", "ارجع", "بطل", "بطّل",
    "رجوع", "إلغاء", "عودة", "ألغ",
    "retour", "reviens", "annule", "annuler", "précédent",
    "go back", "back", "cancel", "never mind",
  ]],
  ["front", [
    "شنوة قدامي", "شنية قدامي", "اش قدامي", "شنوة قدّامي",
    "ماذا أمامي", "ما الذي أمامي", "ماذا يوجد أمامي",
    "qu y a t il devant moi", "qu est ce qu il y a devant moi", "il y a quoi devant moi",
    "what is in front of me", "what s in front of me", "what is ahead", "what s ahead", "what s in front",
  ]],
  ["describe", [
    "وصفلي البلاصة", "وصفلي اللي حذايا", "وين أنا",
    "صف المكان", "صف لي المكان", "صف ما حولي", "أين أنا",
    "décris les alentours", "décris l endroit", "décris ce qui m entoure", "où suis je",
    "describe my surroundings", "describe surroundings", "describe the room", "describe the place", "where am i",
  ]],
  ["read", [
    // No single word: these can start the camera and send an image.
    "اقرالي الكتابة", "اقرا الكتابة", "شنوة مكتوب",
    "اقرأ النص", "اقرأ لي", "ماذا كتب", "ماذا مكتوب",
    "lis le texte", "lis moi ça", "lis ce texte", "qu est ce qui est écrit",
    "read this text", "read the text", "read this", "what does it say", "what does this say",
  ]],
  ["identify", [
    "شنوة هاذي", "شنوة هاذا", "شنية هاذي", "شنوة هاذي الحاجة", "شنوة الحاجة هاذي",
    "ما هذا", "ما هذا الشيء", "ماذا أحمل",
    "qu est ce que c est", "c est quoi", "c est quoi ça", "identifie l objet",
    "what is this", "what s this", "identify object", "identify this", "what am i holding",
  ]],
  ["emergency", [
    "نجدة", "النجدة", "عاونوني", "طوارئ", "حالة طوارئ",
    "ساعدوني", "الطوارئ",
    "urgence", "au secours", "à l aide", "appel d urgence",
    "emergency", "help me", "i need help", "call for help",
  ]],
  ["call", [
    "عيط", "عيطلو", "عيطلها", "اطلب",
    "اتصل", "اتصل به", "اتصل بها",
    "appelle", "appeler", "appelle le", "appelle la",
    "call", "call them", "call my contact",
  ]],
  ["louder", ["علي الصوت", "على صوتك", "ارفع الصوت", "plus fort", "parle plus fort", "louder", "speak louder", "volume up"]],
  ["quieter", ["هبط الصوت", "وطي صوتك", "اخفض الصوت", "moins fort", "parle moins fort", "quieter", "softer", "volume down"]],
  ["faster", ["احكي بالزربة", "اسرع", "أسرع", "تحدث بسرعة", "plus vite", "parle plus vite", "faster", "speak faster"]],
  ["slower", ["احكي بالشوية", "بالشوية", "أبطأ", "تحدث ببطء", "plus lentement", "parle plus lentement", "moins vite", "slower", "speak slower", "slow down"]],
  // Always "speak X": a lone language name is too common in conversation.
  ["lang-tn", ["احكي بالتونسي", "تحدث بالتونسية", "parle tunisien", "speak tunisian"]],
  ["lang-ar", ["احكي بالفصحى", "تحدث بالفصحى", "تحدث بالعربية", "parle arabe", "speak arabic"]],
  ["lang-fr", ["احكي بالفرنساوي", "تحدث بالفرنسية", "parle français", "speak french"]],
  ["lang-en", ["احكي بالانقليزي", "تحدث بالإنجليزية", "parle anglais", "speak english"]],
];

const LOOKUP = new Map(COMMANDS.flatMap(([cmd, phrases]) => phrases.map((p) => [clean(p), cmd] as const)));

/** Polite words around a command («please read», «اقرالي يعيشك»): dropped before a second try. */
const FILLER = ["please", "now", "ok", "okay", "hey", "nadhra", "s il te plait", "s il vous plait", "svp", "maintenant", "عافاك", "يعيشك", "من فضلك", "توة", "نظرة"].map(clean);

function stripFiller(text: string): string {
  let words = text.split(" ");
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    for (const f of FILLER) {
      const fw = f.split(" ");
      if (words.slice(0, fw.length).join(" ") === f) (words = words.slice(fw.length)), (changed = true);
      else if (words.slice(-fw.length).join(" ") === f) (words = words.slice(0, -fw.length)), (changed = true);
    }
  }
  return words.join(" ");
}

export function parseCommand(text: string): VoiceCommand | null {
  const c = clean(text);
  return LOOKUP.get(c) ?? LOOKUP.get(stripFiller(c)) ?? null;
}

/** For the help list on screen: one example per command, in the given language. */
export function commandExamples(lang: SpeechLang): Partial<Record<VoiceCommand, string>> {
  const index = { tn: 0, ar: 1, fr: 2, en: 3 }[lang];
  const out: Partial<Record<VoiceCommand, string>> = {};
  for (const [cmd, phrase] of EXAMPLES) out[cmd] = phrase[index];
  return out;
}

const EXAMPLES: [VoiceCommand, [string, string, string, string]][] = [
  ["front", ["شنوة قدّامي؟", "ماذا أمامي؟", "Qu'y a-t-il devant moi ?", "What's in front of me?"]],
  ["describe", ["وصفلي البلاصة", "صف المكان", "Décris les alentours", "Describe my surroundings"]],
  ["read", ["اقرالي الكتابة", "اقرأ النص", "Lis le texte", "Read this text"]],
  ["identify", ["شنوة هاذي؟", "ما هذا؟", "Qu'est-ce que c'est ?", "What is this?"]],
  ["repeat", ["عاود", "أعد", "Répète", "Repeat"]],
  ["stop-speech", ["اسكت", "اسكت", "Tais-toi", "Stop talking"]],
  ["back", ["رجّع", "رجوع", "Retour", "Go back"]],
  ["help", ["شنوة نجم نقول؟", "مساعدة", "Aide", "Help"]],
  ["pause", ["وقّف التحليل", "أوقف التحليل", "Mets en pause", "Pause analysis"]],
  ["resume", ["كمّل", "تابع", "Continue", "Continue"]],
  ["camera-on", ["شعّل الكاميرا", "افتح الكاميرا", "Allume la caméra", "Open camera"]],
  ["camera-off", ["سكّر الكاميرا", "أغلق الكاميرا", "Éteins la caméra", "Close camera"]],
  ["louder", ["علّي الصوت", "ارفع الصوت", "Plus fort", "Louder"]],
  ["slower", ["احكي بالشوية", "أبطأ", "Plus lentement", "Slower"]],
  ["emergency", ["نجدة", "طوارئ", "Urgence", "Emergency"]],
  ["assistant-off", ["سكّر الميكرو", "أطفئ الميكروفون", "Coupe le micro", "Stop listening"]],
];
