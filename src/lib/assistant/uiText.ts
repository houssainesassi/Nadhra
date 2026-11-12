// The words on the main screen, in each language the assistant speaks, so the screen follows the
// language selector. The detailed panels (Settings, Privacy, Emergency, the consent notice) stay in
// English. Pure data.
import type { SpeechLang } from "./lang.ts";

export interface UiText {
  /** The language's own name, for the selector. */
  name: string;
  language: string;
  tagline: string;
  openCamera: string;
  stop: string;
  stopHint: string;
  privacySafety: string;
  settings: string;
  safetyNote: string;
  active: string;
  starting: string;
  speaking: string;
  looking: string;
  warning: string;
  paused: string;
  offline: string;
  detectorFailed: string;
  serviceDown: string;
  cameraOff: string;
  live: string;
  mic: { listening: string; on: string; off: string; processing: string; denied: string; unavailable: string };
  heard: string;
  /** Before anything was said. `example` is a question the user can ask. */
  prompt: (example: string) => string;
}

export const UI_TEXT: Record<SpeechLang, UiText> = {
  tn: {
    name: "تونسي",
    language: "اللغة",
    tagline: "نظرة توصفلك اللي حولك وتنبّهك للعوائق. احكي معاها وقت ما تحب.",
    openCamera: "حِلّ الكاميرا",
    stop: "وقّف المساعدة",
    stopHint: "يسكّر الكاميرا والميكرو.",
    privacySafety: "الخصوصية والسلامة",
    settings: "الإعدادات",
    safetyNote: "نظرة تعاونك برك، وما تعوّضش العصا ولا الكلب المرشد.",
    active: "المساعدة خدّامة",
    starting: "الكاميرا قاعدة تتحلّ…",
    speaking: "قاعدة تحكي",
    looking: "قاعدة تشوف…",
    warning: "تنبيه",
    paused: "الوصف واقف، التنبيهات خدّامة",
    offline: "ما فمّاش إنترنت: كان التنبيهات اللي في الجهاز",
    detectorFailed: "التنبيهات اللي في الجهاز ما خدمتش: التحليل عبر الإنترنت برك",
    serviceDown: "خدمة التحليل موش متوفّرة توّا",
    cameraOff: "الكاميرا مسكّرة.",
    live: "محادثة مباشرة",
    mic: { listening: "نسمع فيك", on: "الميكرو خدّام", off: "الميكرو مسكّر", processing: "قاعد نفهم…", denied: "الميكرو ممنوع", unavailable: "الصوت موش متوفّر" },
    heard: "سمعت",
    prompt: (e) => `اسأل وقت ما تحب، مثلاً: «${e}»`,
  },
  ar: {
    name: "العربية",
    language: "اللغة",
    tagline: "تصف لك نظرة ما حولك وتنبّهك إلى العوائق. تحدّث إليها في أي وقت.",
    openCamera: "افتح الكاميرا",
    stop: "أوقف المساعدة",
    stopHint: "يغلق الكاميرا والميكروفون.",
    privacySafety: "الخصوصية والسلامة",
    settings: "الإعدادات",
    safetyNote: "نظرة أداة مساعدة فقط، ولا تغني عن العصا أو الكلب المرشد.",
    active: "المساعدة مفعّلة",
    starting: "جارٍ تشغيل الكاميرا…",
    speaking: "تتحدّث",
    looking: "تنظر…",
    warning: "تنبيه",
    paused: "الوصف متوقّف، التنبيهات تعمل",
    offline: "لا يوجد إنترنت: تنبيهات الجهاز فقط",
    detectorFailed: "تنبيهات الجهاز لا تعمل: التحليل عبر الإنترنت فقط",
    serviceDown: "خدمة التحليل غير متاحة الآن",
    cameraOff: "الكاميرا مغلقة.",
    live: "محادثة مباشرة",
    mic: { listening: "أستمع إليك", on: "الميكروفون يعمل", off: "الميكروفون متوقّف", processing: "أفهم…", denied: "الميكروفون غير مسموح", unavailable: "الصوت غير متاح" },
    heard: "سمعت",
    prompt: (e) => `اسأل في أي وقت، مثلاً: «${e}»`,
  },
  fr: {
    name: "Français",
    language: "Langue",
    tagline: "Nadhra décrit ce qui vous entoure et vous avertit des obstacles. Parlez-lui à tout moment.",
    openCamera: "Ouvrir la caméra",
    stop: "Arrêter l'assistance",
    stopHint: "Éteint la caméra et le micro.",
    privacySafety: "Confidentialité et sécurité",
    settings: "Réglages",
    safetyNote: "Une aide, qui ne remplace ni la canne ni le chien guide.",
    active: "Assistance active",
    starting: "Démarrage de la caméra…",
    speaking: "Parle",
    looking: "Regarde…",
    warning: "Alerte",
    paused: "Description en pause, alertes actives",
    offline: "Hors ligne : alertes de l'appareil seulement",
    detectorFailed: "Alertes de l'appareil indisponibles : analyse en ligne seulement",
    serviceDown: "Le service d'analyse est indisponible",
    cameraOff: "La caméra est éteinte.",
    live: "Conversation en direct",
    mic: { listening: "J'écoute", on: "Micro actif", off: "Micro coupé", processing: "Je comprends…", denied: "Micro non autorisé", unavailable: "Voix indisponible" },
    heard: "Entendu",
    prompt: (e) => `Demandez à tout moment, par exemple : « ${e} »`,
  },
  en: {
    name: "English",
    language: "Language",
    tagline: "Nadhra describes what's around you and warns you about obstacles. Talk to it any time.",
    openCamera: "Open camera",
    stop: "Stop assistance",
    stopHint: "Turns off the camera and the microphone.",
    privacySafety: "Privacy & safety",
    settings: "Settings",
    safetyNote: "An aid only. It doesn't replace your cane or guide dog.",
    active: "Assistance active",
    starting: "Starting the camera…",
    speaking: "Speaking",
    looking: "Looking…",
    warning: "Warning",
    paused: "Descriptions paused, warnings on",
    offline: "Offline: on-device warnings only",
    detectorFailed: "On-device warnings failed: cloud analysis only",
    serviceDown: "The analysis service is unavailable",
    cameraOff: "The camera is off.",
    live: "Live conversation",
    mic: { listening: "Listening", on: "Mic on", off: "Mic off", processing: "Understanding…", denied: "Mic blocked", unavailable: "Voice unavailable" },
    heard: "Heard",
    prompt: (e) => `Ask any time, for example: “${e}”`,
  },
};
