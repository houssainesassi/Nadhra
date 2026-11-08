// Everything the assistant says on its own, in Tunisian Arabic. Warnings are built from validated
// fields by these templates, not by the model, so the wording always matches the confidence level.
import type { Hazard, Side } from "./types.ts";

export const SPEECH = {
  disclaimer: "هذا المساعد يعاونك برك، وما يعوّضش العصا ولا الكلب المرشد.",
  privacy: "باش نوصفلك اللي قدّامك، الصور تتبعث لخدمة ذكاء اصطناعي خارجية. ما نسجّلوش فيديو وما نخزّنوش الصور. إذا موافق، اضغط موافق.",
  consentRefused: "باهي، ما شعّلتش الكاميرا وما تبعثت حتى صورة.",
  cameraOn: "الكاميرا خدّامة.",
  cameraOff: "الكاميرا تسكّرت.",
  cameraNeeded: "الكاميرا مطفية. شعّلها الأول باش نجم نجاوبك.",
  cameraLost: "الكاميرا وقفت. ثبّت فيها وشعّلها مرة أخرى.",
  paused: "وقّفت التحليل.",
  resumed: "رجعت نحلّل.",
  assistantOn: "المساعد الصوتي خدّام. اسألني وقت اللي تحب.",
  assistantOff: "سكّرت الميكرو.",
  listening: "نسمع فيك.",
  noQuestionHeard: "ما سمعتش سؤال. عاود قولو.",
  micDenied: "ما عنديش الإذن باش نستعمل الميكرو. اسمح بيه من إعدادات المتصفح، ولا اكتب سؤالك.",
  micMissing: "ما لقيتش ميكرو يخدم. تنجم تكتب سؤالك.",
  voiceFallback: "التعرّف على الكلام في المتصفح هذا ما يخدمش، باش نسجّل صوتك ونبعثو للخدمة.",
  voiceUnavailable: "الأسئلة بالصوت ما تخدمش هنا. استعمل الأزرار ولا اكتب سؤالك.",
  analysisDown: "التحليل واقف توّة وما نجمش نوصفلك. رد بالك وما تعتمدش عليّ.",
  analysisBack: "رجع التحليل يخدم.",
  aiNotConfigured: "خدمة التحليل موش مفعّلة على الخادم.",
  rateLimited: "طلبات برشة في وقت قصير. نستنّى شوية ونرجع.",
  questionFailed: "ما نجمتش نجاوبك توّة، صار مشكل في الخدمة. عاود بعد شوية.",
  thinking: "لحظة، نشوف.",
  tooDark: "الصورة مظلمة برشة وما نشوفش مليح. ما نجمش نقلّك شنوة قدّامك.",
  obstructed: "ما نشوف شي واضح. يمكن الكاميرا مغطّية ولا موجّهة لحيط.",
  imageBack: "الصورة رجعت واضحة.",
  nothingToRepeat: "مازلت ما قلت شي.",
  unsure: "ما نجمتش نتأكّد من اللي في الصورة. حرّك الكاميرا شوية وعاود اسألني.",
  pathCaveat: "أما ما نجمش نأكّدلك إلي الطريق آمن، كمّل ثبّت بالعصا.",
  pathUnknown: "ما نجمش نأكّدلك إلي الطريق آمن. ثبّت بالعصا واسأل شكون حذاك إذا تنجم.",
} as const;

export const CAMERA_ERRORS: Record<string, string> = {
  denied: "ما عنديش الإذن باش نستعمل الكاميرا. اسمح بيها من إعدادات المتصفح وعاود.",
  "not-found": "ما لقيتش كاميرا في الجهاز هذا.",
  busy: "الكاميرا مستعملة في برنامج آخر. سكّرو وعاود.",
  insecure: "الكاميرا تحتاج رابط آمن https.",
  unsupported: "المتصفح هذا ما يدعمش الكاميرا.",
  unknown: "ما نجمتش نشعّل الكاميرا. عاود جرّب.",
};

const FEMININE = new Set(["كرهبة", "بسكلات", "دراجة", "موتو", "شاحنة", "حافلة", "سيارة", "حاجة", "طاولة"]);
const isFeminine = (label: string) => FEMININE.has(label) || label.endsWith("ة");

const DEFAULT_LABEL: Record<Hazard["kind"], string> = {
  stairs: "درج",
  drop: "تبديل في مستوى القاعة",
  vehicle: "كرهبة",
  person: "شخص",
  obstacle: "حاجة",
};

const where = (side: Side) => ({ left: "على يسارك", right: "على يمينك", center: "قدّامك", unknown: "قريب منك" })[side];
const fromSide = (side: Side) => ({ left: "من اليسار", right: "من اليمين", center: "قدّامك", unknown: "" })[side];

/** The sentence for one hazard. Its wording states how sure we are. */
export function warningPhrase(h: Hazard): string {
  const name = h.label || DEFAULT_LABEL[h.kind];
  if (h.confidence === "uncertain") return `يظهرلي فمّا ${name} ${where(h.side)}، أما موش متأكّد.`;
  const hedge = h.confidence === "likely" ? "يظهرلي " : "";
  if (h.motion === "approaching" && (h.kind === "vehicle" || h.kind === "person")) {
    const coming = isFeminine(name) ? "جاية" : "جاي";
    const opener = h.kind === "vehicle" ? "رد بالك، " : "";
    return `${opener}${hedge}فمّا ${name} ${coming} لجيهتك ${fromSide(h.side)}`.trim() + ".";
  }
  if (h.kind === "vehicle" && h.proximity === "near") {
    const close = isFeminine(name) ? "قريبة" : "قريب";
    return `رد بالك، ${hedge}${name} ${close} منك ${fromSide(h.side)}`.trim() + ".";
  }
  if (h.kind === "person") return `${hedge}فمّا ${name} ${where(h.side)}.`;
  return `رد بالك، ${hedge}فمّا ${name} ${where(h.side)}.`;
}
