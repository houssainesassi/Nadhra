// The words on the main screen, in each language the assistant speaks, so the screen follows the
// language selector. The detailed panels (Settings, Privacy, Emergency, the consent notice) stay in
// English. Pure data.
import type { SpeechLang } from "./lang.ts";

export interface UiText {
  /** The language's own name, for the selector. */
  name: string;
  language: string;
  /** Said and shown when the app opens. */
  greeting: string;
  openCamera: string;
  /** The one home button: camera and microphone together (the live conversation, or with Nadhra AI
      the camera and voice commands). Settings is separate. */
  talkNadhra: string;
  stop: string;
  stopHint: string;
  privacySafety: string;
  settings: string;
  active: string;
  starting: string;
  speaking: string;
  looking: string;
  /** Camera on, automatic descriptions off. */
  manual: string;
  /** Camera on with Nadhra selected: only the on-device warnings run. */
  nadhra: string;
  warning: string;
  paused: string;
  offline: string;
  detectorFailed: string;
  serviceDown: string;
  /** The assistant's voice (Sulafat) failed; there is no other voice, so the screen reader reads. */
  voiceFailed: string;
  cameraOff: string;
  live: string;
  mic: { listening: string; on: string; off: string; processing: string; denied: string; unavailable: string };
  heard: string;
  /** The session's actions, as screen-reader-only buttons (TalkBack reaches them by swiping; they
      take no space on screen), and the name of their group. */
  actions: {
    group: string;
    describe: string;
    read: string;
    identify: string;
    ask: string;
    /** Ask while the question is being recorded: pressing again sends it. */
    askDone: string;
    pause: string;
    resume: string;
    /** Read with Pause: what keeps running. */
    pauseHint: string;
  };
  /** The live conversation: the Microphone button's states. `hint` is its screen-reader description. */
  talkLive: { start: string; agree: string; end: string; hint: string };
  /** The buttons over the camera: what each does when pressed (their accessible names). */
  controls: { micMute: string; micUnmute: string; switchCamera: string; switching: string; fullscreen: string; exitFullscreen: string };
  /** Before anything was said. `example` is a question the user can ask. */
  prompt: (example: string) => string;
  /** Location and walking guidance on the main screen: the strip shown while it runs. */
  nav: {
    /** Opens the Location & directions panel. */
    open: string;
    /** Big button: ends the guidance (the same as «وقّف التوجيه»). */
    stop: string;
    to: (destination: string) => string;
    left: (distance: string) => string;
    gpsWeak: string;
    gpsLost: string;
    rerouting: string;
    /** The location notice, shown while it is said. */
    allow: string;
    notNow: string;
  };
}

export const UI_TEXT: Record<SpeechLang, UiText> = {
  tn: {
    name: "تونسي",
    language: "اللغة",
    greeting: "عسلامة",
    openCamera: "حِلّ الكاميرا",
    talkNadhra: "احكي مع نظرة",
    stop: "وقّف المساعدة",
    stopHint: "يسكّر الكاميرا والميكرو.",
    privacySafety: "الخصوصية والسلامة",
    settings: "الإعدادات",
    active: "المساعدة خدّامة",
    starting: "الكاميرا قاعدة تتحلّ…",
    speaking: "قاعدة تحكي",
    looking: "قاعدة تشوف…",
    manual: "يوصف كي تسألو، التنبيهات خدّامة",
    nadhra: "ذكاء نظرة (تجريبي): تحذيرات الجهاز فقط",
    warning: "تنبيه",
    paused: "الوصف واقف، التنبيهات خدّامة",
    offline: "ما فمّاش إنترنت: كان التنبيهات اللي في الجهاز",
    detectorFailed: "التنبيهات اللي في الجهاز ما خدمتش: التحليل عبر الإنترنت برك",
    serviceDown: "خدمة التحليل موش متوفّرة توّا",
    voiceFailed: "صوت Sulafat ما خدمش: قارئ الشاشة يقرا الكلام",
    cameraOff: "الكاميرا مسكّرة.",
    live: "محادثة مباشرة",
    mic: { listening: "نسمع فيك", on: "الميكرو خدّام", off: "الميكرو مسكّر", processing: "قاعد نفهم…", denied: "الميكرو ممنوع", unavailable: "الصوت موش متوفّر" },
    heard: "سمعت",
    actions: { group: "الأوامر", describe: "وصفلي البلاصة", read: "اقرالي الكتابة", identify: "شنوة هاذي؟", ask: "اسأل سؤال", askDone: "وفيت، ابعث السؤال", pause: "وقّف الوصف", resume: "كمّل الوصف", pauseHint: "التنبيهات تبقى خدّامة." },
    talkLive: { start: "احكي مباشرة", agree: "موافق: ابدا المحادثة المباشرة", end: "وقّف المحادثة المباشرة", hint: "محادثة بالصوت كيف التليفون. طول ما هي خدّامة، صوتك وصورة من الكاميرا كل ثانية تقريبا يتبعثو لـ Google Gemini." },
    controls: { micMute: "سكّر الميكرو", micUnmute: "حِلّ الميكرو", switchCamera: "بدّل الكاميرا (قدّام / تالي)", switching: "قاعدة نبدّل الكاميرا…", fullscreen: "الكاميرا في الشاشة الكل", exitFullscreen: "اخرج من الشاشة الكاملة" },
    prompt: (e) => `اسأل وقت ما تحب، مثلاً: «${e}»`,
    nav: { open: "البلايص والطريق", stop: "وقّف التوجيه", to: (d) => `ماشي لـ${d}`, left: (d) => `باقي ${d}`, gpsWeak: "الـGPS موش دقيق", gpsLost: "ضاع الـGPS", rerouting: "نحسب طريق جديد…", allow: "موافق، استعمل بلاصتي", notNow: "لا، موش توّا" },
  },
  ar: {
    name: "العربية",
    language: "اللغة",
    greeting: "عسلامة",
    openCamera: "افتح الكاميرا",
    talkNadhra: "تحدّث مع نظرة",
    stop: "أوقف المساعدة",
    stopHint: "يغلق الكاميرا والميكروفون.",
    privacySafety: "الخصوصية والسلامة",
    settings: "الإعدادات",
    active: "المساعدة مفعّلة",
    starting: "جارٍ تشغيل الكاميرا…",
    speaking: "تتحدّث",
    looking: "تنظر…",
    manual: "يصف عند الطلب، التنبيهات تعمل",
    nadhra: "ذكاء نظرة (تجريبي): تنبيهات الجهاز فقط",
    warning: "تنبيه",
    paused: "الوصف متوقّف، التنبيهات تعمل",
    offline: "لا يوجد إنترنت: تنبيهات الجهاز فقط",
    detectorFailed: "تنبيهات الجهاز لا تعمل: التحليل عبر الإنترنت فقط",
    serviceDown: "خدمة التحليل غير متاحة الآن",
    voiceFailed: "تعذّر تشغيل صوت Sulafat: قارئ الشاشة يقرأ الكلام",
    cameraOff: "الكاميرا مغلقة.",
    live: "محادثة مباشرة",
    mic: { listening: "أستمع إليك", on: "الميكروفون يعمل", off: "الميكروفون متوقّف", processing: "أفهم…", denied: "الميكروفون غير مسموح", unavailable: "الصوت غير متاح" },
    heard: "سمعت",
    actions: { group: "الإجراءات", describe: "صف المكان", read: "اقرأ النص", identify: "ما هذا؟", ask: "اطرح سؤالاً", askDone: "انتهيت، أرسل السؤال", pause: "أوقف الوصف", resume: "تابع الوصف", pauseHint: "تبقى التنبيهات تعمل." },
    talkLive: { start: "تحدّث مباشرة", agree: "أوافق: ابدأ المحادثة المباشرة", end: "أنهِ المحادثة المباشرة", hint: "محادثة صوتية مثل مكالمة هاتفية. طوال المحادثة يُرسل صوتك وصورة من الكاميرا كل ثانية تقريبًا إلى Google Gemini." },
    controls: { micMute: "أطفئ الميكروفون", micUnmute: "شغّل الميكروفون", switchCamera: "بدّل الكاميرا (أمامية / خلفية)", switching: "جارٍ تبديل الكاميرا…", fullscreen: "الكاميرا بملء الشاشة", exitFullscreen: "اخرج من ملء الشاشة" },
    prompt: (e) => `اسأل في أي وقت، مثلاً: «${e}»`,
    nav: { open: "الأماكن والطريق", stop: "أوقف الإرشاد", to: (d) => `في الطريق إلى ${d}`, left: (d) => `بقي ${d}`, gpsWeak: "تحديد الموقع غير دقيق", gpsLost: "فُقدت إشارة الموقع", rerouting: "جارٍ حساب طريق جديد…", allow: "موافق، استعمل موقعي", notNow: "لا، ليس الآن" },
  },
  fr: {
    name: "Français",
    language: "Langue",
    greeting: "Asslema",
    openCamera: "Ouvrir la caméra",
    talkNadhra: "Parler avec Nadhra",
    stop: "Arrêter l'assistance",
    stopHint: "Éteint la caméra et le micro.",
    privacySafety: "Confidentialité et sécurité",
    settings: "Réglages",
    active: "Assistance active",
    starting: "Démarrage de la caméra…",
    speaking: "Parle",
    looking: "Regarde…",
    manual: "Décrit à la demande, alertes actives",
    nadhra: "Nadhra (experimental) : alertes de l'appareil seulement",
    warning: "Alerte",
    paused: "Description en pause, alertes actives",
    offline: "Hors ligne : alertes de l'appareil seulement",
    detectorFailed: "Alertes de l'appareil indisponibles : analyse en ligne seulement",
    serviceDown: "Le service d'analyse est indisponible",
    voiceFailed: "La voix Sulafat ne fonctionne pas : le lecteur d'écran lit à sa place",
    cameraOff: "La caméra est éteinte.",
    live: "Conversation en direct",
    mic: { listening: "J'écoute", on: "Micro actif", off: "Micro coupé", processing: "Je comprends…", denied: "Micro non autorisé", unavailable: "Voix indisponible" },
    heard: "Entendu",
    actions: { group: "Actions", describe: "Décrire les alentours", read: "Lire le texte", identify: "Identifier un objet", ask: "Poser une question", askDone: "Terminé, envoyer la question", pause: "Mettre la description en pause", resume: "Reprendre la description", pauseHint: "Les alertes restent actives." },
    talkLive: { start: "Parler en direct", agree: "J'accepte : démarrer la conversation en direct", end: "Terminer la conversation en direct", hint: "Une conversation à voix haute, comme un appel. Tant qu'elle dure, votre voix et environ une image par seconde sont envoyées à Google Gemini." },
    controls: { micMute: "Couper le micro", micUnmute: "Activer le micro", switchCamera: "Changer de caméra (avant / arrière)", switching: "Changement de caméra…", fullscreen: "Caméra en plein écran", exitFullscreen: "Quitter le plein écran" },
    prompt: (e) => `Demandez à tout moment, par exemple : « ${e} »`,
    nav: { open: "Lieux et itinéraire", stop: "Arrêter le guidage", to: (d) => `Vers ${d}`, left: (d) => `Reste ${d}`, gpsWeak: "GPS imprécis", gpsLost: "Signal GPS perdu", rerouting: "Nouvel itinéraire…", allow: "J'accepte, utiliser ma position", notNow: "Pas maintenant" },
  },
  en: {
    name: "English",
    language: "Language",
    greeting: "Asslema",
    openCamera: "Open camera",
    talkNadhra: "Talk with Nadhra",
    stop: "Stop assistance",
    stopHint: "Turns off the camera and the microphone.",
    privacySafety: "Privacy & safety",
    settings: "Settings",
    active: "Assistance active",
    starting: "Starting the camera…",
    speaking: "Speaking",
    looking: "Looking…",
    manual: "Describes when asked, warnings on",
    nadhra: "Nadhra (experimental): on-device warnings only",
    warning: "Warning",
    paused: "Descriptions paused, warnings on",
    offline: "Offline: on-device warnings only",
    detectorFailed: "On-device warnings failed: cloud analysis only",
    serviceDown: "The analysis service is unavailable",
    voiceFailed: "The Sulafat voice isn't working: the screen reader reads instead",
    cameraOff: "The camera is off.",
    live: "Live conversation",
    mic: { listening: "Listening", on: "Mic on", off: "Mic off", processing: "Understanding…", denied: "Mic blocked", unavailable: "Voice unavailable" },
    heard: "Heard",
    actions: { group: "Actions", describe: "Describe surroundings", read: "Read text", identify: "Identify object", ask: "Ask a question", askDone: "Done, send question", pause: "Pause descriptions", resume: "Resume descriptions", pauseHint: "Warnings keep running." },
    talkLive: { start: "Talk live", agree: "I agree: start the live conversation", end: "End live conversation", hint: "A spoken conversation, like a phone call. While it is on, your voice and about one picture a second go to Google Gemini." },
    controls: { micMute: "Mute microphone", micUnmute: "Unmute microphone", switchCamera: "Switch camera (front / back)", switching: "Switching camera…", fullscreen: "Full-screen camera", exitFullscreen: "Exit full screen" },
    prompt: (e) => `Ask any time, for example: “${e}”`,
    nav: { open: "Places & directions", stop: "Stop navigation", to: (d) => `To ${d}`, left: (d) => `${d} left`, gpsWeak: "GPS not precise", gpsLost: "GPS signal lost", rerouting: "Finding a new route…", allow: "I agree, use my location", notNow: "Not now" },
  },
};
