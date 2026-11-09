// Turns untrusted model output into a SceneAnalysis, and enforces the safety rules in code rather
// than trusting the prompt: no safety promises, no invented distances, no motion claims without a
// second frame. Pure logic, used by the API route and covered by tests/visionSchema.test.ts.
import { speech } from "./phrases.ts";
import type { SpeechLang } from "./lang.ts";
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

/** For matching only: removes vowel marks and unifies letter forms. Latin accents are dropped too. */
export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    // Only Latin letters are decomposed: NFD would also split Arabic letters with a hamza.
    .replace(/[À-ɏ]/g, (c) => c.normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .replace(/[’ʼ]/g, "'")
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
    // Modern Standard Arabic
    "|(?:^|[\\s،,.])(?:ب)?امان(?:$|[\\s،,.؟?!])|لا\\s+(?:يوجد|توجد)\\s+(?:اي\\s+)?(?:خطر|خطوره|خطورة|عائق|عوائق)" +
    "|(?:بدون|دون)\\s+(?:اي\\s+)?(?:خطر|خطوره|خطورة|عائق|عوائق)|خال\\s+من\\s+(?:العوائق|الخطر)" +
    "|(?:الطريق|الممر|الشارع|الرصيف)\\s+(?:خال|خالي|خاليه|خالية)" +
    "|يمكنك\\s+(?:العبور|المرور|المشي|التقدم|الاستمرار|ان\\s+تعبر|ان\\s+تمشي|ان\\s+تتقدم)" +
    // French (accents already removed)
    "|sans\\s+(?:danger|risque|obstacle)|en\\s+(?:toute\\s+)?securite|\\bsecurise|aucun\\s+(?:danger|obstacle|risque)|pas\\s+d'obstacle" +
    "|(?:chemin|passage|route|voie|rue|trottoir)\\s+(?:est\\s+|semble\\s+)?(?:libre|degagee?|vide)" +
    "|(?:vous\\s+pouvez|tu\\s+peux)\\s+(?:traverser|avancer|passer|marcher|continuer|y\\s+aller)" +
    // English
    "|\\bsafe\\b|clear path|no obstacles?\\b|without\\s+(?:any\\s+)?(?:risk|danger)|no\\s+danger|nothing\\s+in\\s+(?:your|the)\\s+way" +
    "|\\b(?:path|road|way|street|sidewalk|pavement|crossing)\\s+(?:is|looks|seems)\\s+(?:clear|empty|free)" +
    "|\\byou\\s+can\\s+(?:cross|walk|go\\s+ahead|proceed|continue|move\\s+forward)",
  "i",
);
// «ما يعنيش … آمن» warns rather than promises, so it is allowed.
const NEGATED_SAFETY = new RegExp(
  "ما\\s*يعنيش|موش\\s*معناه|مش\\s*معناه|ما\\s*نجمش|ما\\s*نجمتش|ما\\s*نضمنش|موش\\s*متاكد|مش\\s*متاكد|ما\\s*نعرفش" +
    "|لا\\s*استطيع|لا\\s*يمكنني|لست\\s*متاكد|لا\\s*يعني|لا\\s*اضمن|لا\\s*اعرف|لا\\s*يمكن\\s*التاكد" +
    "|ne\\s+peux\\s+pas|pas\\s+sur|impossible\\s+de|ne\\s+(?:signifie|garantit|garantis)\\s+pas|ne\\s+veut\\s+pas\\s+dire|ne\\s+sais\\s+pas" +
    "|can'?t|cannot|can\\s+not|unable\\s+to|not\\s+sure|doesn'?t\\s+mean|does\\s+not\\s+mean|don'?t\\s+know|no\\s+guarantee",
);

const METRIC_DISTANCE = new RegExp(
  "[0-9٠-٩]+(?:[.,][0-9٠-٩]+)?\\s*(?:متر|مترو|امتار|سنتي|سم|كم|كيلو|خطوه|خطوة|خطوات|قدم|m\\b|cm\\b|km\\b|meters?\\b|metres?\\b|steps?\\b|feet\\b|ft\\b)" +
    // Spelled-out distances, also with an attached preposition («بمترين», «لخطوتين», «على خطوتين»).
    "|(?:^|[\\s،,.؟?!:;\"«(])(?:[وفبل]|على\\s+)?(?:مترين|خطوتين|نص متر|نصف متر|متر واحد|امتار|خطوات)(?:$|[\\s،,.؟?!])" +
    "|\\b(?:un|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|vingt|cent|quelques)\\s+(?:metres?|kilometres?|pas)\\b" +
    "|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred|a\\s+few|a\\s+couple\\s+of)\\s+(?:meters?|metres?|feet|foot|yards?|kilometers?|kilometres?|miles?)\\b" +
    // "two steps" can describe a staircase, so English steps count only as a distance.
    "|\\b(?:one|two|three|four|five|six|seven|eight|nine|ten|a\\s+few|a\\s+couple\\s+of)\\s+steps?\\s+(?:away|from\\s+you|ahead|in\\s+front|forward)",
  "i",
);

// "Nothing in front of you" is honest about the picture, but heard as "the way is safe". Such
// sentences stay (they are useful), and the reminder that this proves nothing always follows.
const ABSENCE = new RegExp(
  "ما\\s*(?:فماش|ثماش)|ما\\s*فما\\s*(?:شي|حتي|حد)|ما\\s*نشوف\\s*(?:شي|حتي)|ما\\s*نشوفش\\s*(?:شي|حتي|حد)" +
    "|لا\\s+(?:يوجد|توجد|ارى|شيء)|ليس\\s+هناك" +
    "|il\\s+n'y\\s+a\\s+(?:rien|aucun|aucune|personne|pas)|je\\s+ne\\s+vois\\s+(?:rien|aucun|aucune|personne|pas)|\\brien\\b" +
    "|\\bnothing\\b|\\bno\\s*one\\b|\\bnobody\\b|\\bi\\s+(?:don'?t|do\\s+not|can'?t|cannot)\\s+see\\b|\\bthere(?:\\s+is|\\s+are|'s)\\s+no\\b",
);
const AHEAD = new RegExp(
  "قدامك|طريقك|ثنيتك|الطريق|الثنيه|الثنية|امامك|الممر" +
    "|devant|chemin|route|passage|trottoir" +
    "|\\bahead\\b|in\\s+front|your\\s+way|\\bpath\\b|\\broad\\b|the\\s+way|sidewalk|pavement",
);
export const impliesClearWay = (spoken: string) =>
  splitSentences(spoken).some((s) => {
    const n = normalizeArabic(s);
    return ABSENCE.test(n) && AHEAD.test(n) && !NEGATED_SAFETY.test(n);
  });

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
// Only clear English uses of "right" and "left": "is this right?" must stay as it is.
const ENGLISH_SIDE = /\b((?:my|the|your)\s+)(left|right)\b|\b(left|right)(\s+(?:side|hand)\b)/gi;
const otherSide = (word: string) => (word.toLowerCase() === "left" ? "right" : "left");
// Only after a word that makes it a side: «tout droit» (straight on) must stay as it is.
const FRENCH_SIDE = /((?:^|[\s'(«"])(?:à|a|sur|vers|de|la|ma|ta|votre|sa|côté|cote|main)\s+)(gauche|droite|droit)(?![\p{L}])/giu;
const frenchOther = (before: string, side: string) => {
  const lower = side.toLowerCase();
  if (lower === "droit") return "gauche";
  if (lower === "droite") return "gauche";
  return /c[oô]t[ée]\s+$/i.test(before) ? "droit" : "droite";
};
/** Exchanges left and right, for a webcam that faces the user. */
export function swapSides(text: string): string {
  return text
    .replace(/يمين|يسار|شمال/g, (m) => SIDE_SWAP[m])
    .replace(ENGLISH_SIDE, (_, before, side, sideFirst, after) => (side ? `${before}${otherSide(side)}` : `${otherSide(sideFirst)}${after}`))
    .replace(FRENCH_SIDE, (_, before: string, side: string) => `${before}${frenchOther(before, side)}`);
}
/** Like swapSides, but leaves alone any sentence that quotes text read from the scene. */
function swapSidesOutsideQuotes(spoken: string, texts: SceneText[]): string {
  const quoted = texts.map((t) => normalizeArabic(t.content)).filter((t) => t.length >= 2);
  return splitSentences(spoken)
    .map((sentence) => (quoted.some((q) => normalizeArabic(sentence).includes(q)) ? sentence : swapSides(sentence)))
    .join(" ");
}

const PATH_QUESTION = new RegExp(
  "(طريق|ثنيه|ثنية|نعدي|نقطع|نتعدي|نمشي|نتقدم|عوائق|حواجز|حاجز|عائق|اعبر|امشي|اتقدم|الرصيف|خطر" +
    "|\\b(?:road|street|path|way|cross|crossing|walk|go|safe|clear|obstacles?)\\b" +
    "|\\b(?:chemin|route|rue|passage|traverser|avancer|marcher|obstacles?|danger|securite|trottoir)\\b)",
);
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
  /** The language the user hears. Tunisian by default. */
  lang?: SpeechLang;
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
  const say = speech(ctx.lang ?? "tn");
  const asksAboutPath = ctx.mode === "question" && isPathQuestion(question);
  // Path questions get their own caveat below; this one covers descriptions and other answers.
  if (spoken && !asksAboutPath && impliesClearWay(spoken)) spoken = `${spoken} ${say.notSafe}`;
  if (ctx.mode === "question") {
    // A removed safety promise leaves nothing to say: "move the camera" would be the wrong answer here.
    if (!spoken) spoken = asksAboutPath ? say.pathUnknown : say.unsure;
    else if (asksAboutPath) spoken = `${spoken} ${say.pathCaveat}`;
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
