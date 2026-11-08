// Turns untrusted model output into a SceneAnalysis, and enforces the safety rules in code rather
// than trusting the prompt: no safety promises, no invented distances, no motion claims without a
// second frame. Pure logic, used by the API route and covered by tests/visionSchema.test.ts.
import { SPEECH } from "./phrases.ts";
import type { CameraFacing, Category, Confidence, Detection, Hazard, HazardKind, ImageQuality, Motion, Proximity, SceneAnalysis, SceneText, Side, VisionMode } from "./types.ts";

const MAX_ITEMS = 12;
const MAX_LABEL = 60;
const MAX_TEXT = 1500;
const MAX_SPOKEN: Record<VisionMode, number> = { scan: 320, question: 1800 };

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? (v as T) : def);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Parses the model's JSON. Tolerates code fences and text around the object; throws when there is none. */
export function parseModelJson(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  const parsed: unknown = JSON.parse(raw.slice(start, end + 1));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model output is not an object");
  return parsed as Record<string, unknown>;
}

/** What was said, or "" when the model found no voice. Throws on unusable output, so nothing is guessed. */
export function parseTranscript(raw: string): string {
  const parsed = parseModelJson(raw);
  return parsed.speech === true ? str(parsed.text, 300) : "";
}

/** For matching only: removes vowel marks and unifies letter forms. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .toLowerCase();
}

/** \b does not work for Arabic: a term must start after a space or punctuation (optionally with و/ف). */
const wordStart = "(?:^|[\\s،,.؟?!:;\"«(])(?:و|ف)?";

const SAFETY_CLAIM = new RegExp(
  wordStart +
    "(?:ال)?(?:امن|امنه|امنة|مامون|مامونه|مامونة)(?:$|[\\s،,.؟?!])" +
    "|ما\\s?(?:فماش|فيهاش|فيهش|فيش|فمه|فما حتي)\\s*(?:اي\\s*)?(?:خطر|خطوره|خطورة)" +
    "|بلا\\s+(?:خطر|خطوره|خطورة)|ما\\s*فما\\s*حتي\\s*(?:عائق|حاجز)" +
    "|(?:الطريق|الطريقك|الثنيه|الثنية|الشارع|الممر)\\s+(?:فارغ|فارغه|فارغة|خالي|خاليه|خالية|محلول|محلوله|محلولة|مفتوح|مفتوحه|مفتوحة|نظيف|نظيفه|نظيفة)" +
    "|تنجم\\s+(?:تعدي|تقطع|تتعدي|تمشي|تكمل|تتقدم)" +
    "|\\bsafe\\b|clear path|no obstacles?\\b",
  "i",
);
// «ما يعنيش … آمن» warns rather than promises, so it is allowed.
const NEGATED_SAFETY = /(ما\s*يعنيش|موش\s*معناه|مش\s*معناه|ما\s*نجمش|ما\s*نجمتش|ما\s*نضمنش|موش\s*متاكد|مش\s*متاكد|ما\s*نعرفش)/;

const METRIC_DISTANCE = new RegExp(
  "[0-9٠-٩]+(?:[.,][0-9٠-٩]+)?\\s*(?:متر|مترو|امتار|سنتي|سم|كم|كيلو|خطوه|خطوة|خطوات|قدم|m\\b|cm\\b|km\\b|meters?\\b|metres?\\b|steps?\\b|feet\\b|ft\\b)" +
    // Spelled-out distances, also with an attached preposition («بمترين», «لخطوتين», «على خطوتين»).
    "|(?:^|[\\s،,.؟?!:;\"«(])(?:[وفبل]|على\\s+)?(?:مترين|خطوتين|نص متر|نصف متر|متر واحد|امتار|خطوات)(?:$|[\\s،,.؟?!])",
  "i",
);

export function splitSentences(text: string): string[] {
  return (text.match(/[^.!؟?\n]+[.!؟?]*/g) ?? []).map((s) => s.trim()).filter(Boolean);
}

/**
 * Removes sentences that promise safety or state a distance. A sentence that quotes text read from
 * the scene (a road sign saying "3 km") stays: reading is not measuring.
 */
export function guardSpoken(spoken: string, texts: SceneText[]): string {
  const quoted = texts.map((t) => normalizeArabic(t.content)).filter((t) => t.length >= 2);
  return splitSentences(spoken)
    .filter((sentence) => {
      const s = normalizeArabic(sentence);
      if (quoted.some((q) => s.includes(q) || q.includes(s))) return true;
      if (SAFETY_CLAIM.test(s) && !NEGATED_SAFETY.test(s)) return false;
      return !METRIC_DISTANCE.test(s);
    })
    .join(" ");
}

const SIDE_SWAP: Record<string, string> = { يمين: "يسار", يسار: "يمين", شمال: "يمين" };
/** Exchanges left and right, for a webcam that faces the user. */
export function swapSides(text: string): string {
  return text.replace(/يمين|يسار|شمال/g, (m) => SIDE_SWAP[m]);
}
/** Like swapSides, but leaves alone any sentence that quotes text read from the scene. */
function swapSidesOutsideQuotes(spoken: string, texts: SceneText[]): string {
  const quoted = texts.map((t) => normalizeArabic(t.content)).filter((t) => t.length >= 2);
  return splitSentences(spoken)
    .map((sentence) => (quoted.some((q) => normalizeArabic(sentence).includes(q)) ? sentence : swapSides(sentence)))
    .join(" ");
}

const PATH_QUESTION = /(طريق|ثنيه|ثنية|نعدي|نقطع|نتعدي|نمشي|نتقدم|عوائق|حواجز|حاجز|عائق)/;
export const isPathQuestion = (question: string) => PATH_QUESTION.test(normalizeArabic(question));

const SIDES = ["left", "center", "right", "unknown"] as const;
const PROXIMITIES = ["near", "mid", "far", "unknown"] as const;
const CONFIDENCES = ["confirmed", "likely", "uncertain"] as const;
const MOTIONS = ["approaching", "moving_away", "stationary", "crossing", "unknown"] as const;
const CATEGORIES = ["object", "person", "vehicle"] as const;
const KINDS = ["stairs", "drop", "vehicle", "person", "obstacle"] as const;
const QUALITIES = ["good", "dark", "blurry", "obstructed"] as const;

export interface SanitizeContext {
  mode: VisionMode;
  cameraFacing: CameraFacing;
  /** A second frame was sent. Without one, any motion claim is discarded. */
  hasMotionEvidence: boolean;
  question?: string;
}

export function sanitizeAnalysis(raw: Record<string, unknown>, ctx: SanitizeContext): SceneAnalysis {
  const mirrored = ctx.cameraFacing === "user";
  // The model reports image sides. Convert them once here, so everything downstream is user-relative.
  const toUserSide = (v: unknown): Side => {
    const side = oneOf<Side>(v, SIDES, "unknown");
    if (!mirrored) return side;
    return side === "left" ? "right" : side === "right" ? "left" : side;
  };
  const motion = (v: unknown): Motion => (ctx.hasMotionEvidence ? oneOf<Motion>(v, MOTIONS, "unknown") : "unknown");
  const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, MAX_ITEMS).filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);
  const confidence = (v: unknown): Confidence => oneOf<Confidence>(v, CONFIDENCES, "uncertain");

  const detections: Detection[] = list(raw.detections)
    .map((d) => ({
      label: str(d.label, MAX_LABEL),
      category: oneOf<Category>(d.category, CATEGORIES, "object"),
      side: toUserSide(d.side),
      proximity: oneOf<Proximity>(d.proximity, PROXIMITIES, "unknown"),
      confidence: confidence(d.confidence),
      motion: motion(d.motion),
      action: str(d.action, MAX_LABEL) || undefined,
    }))
    .filter((d) => d.label);

  const hazards: Hazard[] = list(raw.hazards)
    .filter((h) => KINDS.includes(h.kind as HazardKind))
    .map((h) => ({
      kind: h.kind as HazardKind,
      label: str(h.label, MAX_LABEL),
      side: toUserSide(h.side),
      proximity: oneOf<Proximity>(h.proximity, PROXIMITIES, "unknown"),
      confidence: confidence(h.confidence),
      motion: motion(h.motion),
    }))
    // A webcam facing the user sees the user up close: that is not someone in their way.
    .filter((h) => !(mirrored && h.kind === "person" && h.proximity === "near"));

  const texts: SceneText[] = list(raw.texts)
    .map((t) => ({ content: str(t.content, MAX_TEXT), confidence: confidence(t.confidence) }))
    .filter((t) => t.content);

  const env = raw.environment && typeof raw.environment === "object" ? (raw.environment as Record<string, unknown>) : null;
  const envLabel = env ? str(env.label, MAX_LABEL) : "";

  let spoken = guardSpoken(str(raw.spoken, MAX_SPOKEN[ctx.mode]), texts);
  if (mirrored) spoken = swapSidesOutsideQuotes(spoken, texts);

  const question = ctx.question ?? "";
  if (ctx.mode === "question") {
    const asksAboutPath = isPathQuestion(question);
    // A removed safety promise leaves nothing to say: "move the camera" would be the wrong answer here.
    if (!spoken) spoken = asksAboutPath ? SPEECH.pathUnknown : SPEECH.unsure;
    else if (asksAboutPath) spoken = `${spoken} ${SPEECH.pathCaveat}`;
  }

  return {
    spoken,
    changed: ctx.mode === "question" ? true : raw.changed !== false && !!spoken,
    imageQuality: oneOf<ImageQuality>(raw.image_quality, QUALITIES, "good"),
    environment: envLabel ? { label: envLabel, confidence: confidence(env?.confidence) } : null,
    detections,
    hazards,
    texts,
    uncertain: raw.uncertain === true,
  };
}
