// Turns untrusted model output into a SceneAnalysis, and enforces the safety rules in code rather
// than trusting the prompt: no safety promises, no invented distances, no motion claims without a
// second frame. Pure logic, used by the API route and covered by tests/visionSchema.test.ts.
import { speech } from "./phrases.ts";
import type { SpeechLang } from "./lang.ts";
import type { CameraFacing, Category, Confidence, Detection, Hazard, HazardKind, ImageQuality, Motion, Proximity, SceneAnalysis, SceneText, Side, VisionMode } from "./types.ts";

const MAX_ITEMS = 12;
const MAX_LABEL = 60;
const MAX_TEXT = 1500;
const MAX_SPOKEN: Record<VisionMode, number> = { scan: 320, question: 1800, chat: 1800 };

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

// "According to a web search…": only true when the answer was grounded in one (usedWeb). Matched
// on normalizeArabic() text, so alef forms and Latin accents are already unified.
const SEARCH_CLAIM = new RegExp(
  "(?:حسب|على حساب|بحسب|وفق)\\s*(?:ال)?(?:بحث|انترنت|الانترنت|نتائج البحث)|(?:بحثت?|لوجت|قلبت|لقيت|شفت)\\s+(?:في|على|فى)\\s+(?:ال)?(?:انترنت|ويب|جوجل|غوغل|قوقل)|في (?:ال)?انترنت لقيت|نتائج البحث|البحث في (?:ال)?انترنت" +
    "|selon (?:une |ma |la |les |mes )?recherches?|d'apres (?:internet|le web|une recherche|mes recherches)|j'ai (?:cherche|recherche|verifie|trouve) (?:sur|en ligne|dans)|resultats? de (?:la |ma )?recherche|recherche (?:sur|en) (?:internet|ligne|google)" +
    "|according to (?:a |my |the |an )?(?:web |online |internet |google )?search|\\bi (?:searched|looked (?:it |this )?up|checked online|googled)|search results|according to (?:the )?(?:web|internet)|i found online|a (?:web|online|quick) search",
  "i",
);
export const claimsWebSearch = (sentence: string) => SEARCH_CLAIM.test(normalizeArabic(sentence));

/** Removes sentences that say the answer comes from a web search, when it doesn't (usedWeb false). */
export function dropFalseSearchClaims(spoken: string, texts: SceneText[] = []): string {
  const quoted = texts.map((t) => normalizeArabic(t.content)).filter((t) => t.length >= 2);
  return splitSentences(spoken)
    .filter((sentence) => quoted.some((q) => normalizeArabic(sentence).includes(q)) || !claimsWebSearch(sentence))
    .join(" ");
}

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

  // The vision model has no web search: any "according to the internet" in its answer is false.
  let spoken = dropFalseSearchClaims(guardSpoken(str(raw.spoken, MAX_SPOKEN[ctx.mode]), texts), texts);
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

// --- streamed answers -------------------------------------------------------------------------
// A streamed answer is spoken sentence by sentence while the model is still writing. Each sentence
// sent early must be one the final check (sanitizeAnalysis / sanitizeChat) keeps exactly as it is,
// so the early sentences are always the start of the final answer. Anything the checks might change,
// drop or follow with a caveat stops the early sentences; the rest then comes with the final check.

/** Only the "needs camera" marker, never spoken. */
const CAMERA_MARKER = /\[\s*camera\s*\]/i;
/** Markdown and links don't belong in speech. Character-level, so it gives the same result on a prefix. */
const cleanChatText = (text: string) => text.replace(/[*#`_~>|]/g, " ").replace(/^\s*[-•]\s+/gm, " ");

/**
 * The value of a JSON string field in possibly unfinished JSON, decoded so far. `complete` once its
 * closing quote has arrived. An escape cut in half is left out until the rest of it arrives.
 */
export function partialJsonString(raw: string, field: string): { text: string; complete: boolean } | null {
  const m = new RegExp(`"${field}"\\s*:\\s*"`).exec(raw);
  if (!m) return null;
  let text = "";
  for (let i = m.index + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') return { text, complete: true };
    if (c !== "\\") {
      text += c;
      continue;
    }
    const e = raw[i + 1];
    if (e === undefined) break;
    if (e === "u") {
      const hex = raw.slice(i + 2, i + 6);
      if (hex.length < 4) break;
      text += String.fromCharCode(parseInt(hex, 16) || 32);
      i += 5;
      continue;
    }
    text += ({ n: "\n", t: "\t", r: "\r", b: "", f: "" } as Record<string, string>)[e] ?? e;
    i++;
  }
  return { text, complete: false };
}

export interface StreamContext {
  mode: VisionMode;
  cameraFacing: CameraFacing;
  question?: string;
  /** Hold everything for the final answer, given the raw output so far (e.g. it will be replaced by a web search). */
  holdAll?: (raw: string) => boolean;
}

/** Feeds on the model's raw output as it arrives, and gives back sentences that are safe to speak now. */
export class SentenceStreamer {
  private raw = "";
  private stopped = false;
  readonly sent: string[] = [];
  private ctx: StreamContext;

  constructor(ctx: StreamContext) {
    this.ctx = ctx;
    // A path question always gets its caveat with the answer: a broken stream mustn't leave it out.
    if (ctx.mode !== "scan" && isPathQuestion(ctx.question ?? "")) this.stopped = true;
  }

  /** Adds raw model text. Returns the sentences that became final with it. */
  push(delta: string): string[] {
    this.raw += delta;
    if (this.stopped) return [];
    if (this.ctx.holdAll?.(this.raw)) {
      this.stopped = true;
      return [];
    }
    const part = this.ctx.mode === "chat" ? { text: cleanChatText(this.raw), complete: false } : partialJsonString(this.raw, "spoken");
    if (!part) return [];
    // The same steps as str(): spaces collapsed, length capped.
    const text = part.text.replace(/\s+/g, " ").trimStart().slice(0, MAX_SPOKEN[this.ctx.mode]);
    const sentences = splitSentences(text);
    // The last sentence may still grow, unless the field is closed and nothing was cut.
    const ready = part.complete && text.length < MAX_SPOKEN[this.ctx.mode] ? sentences : sentences.slice(0, -1);
    const out: string[] = [];
    for (const sentence of ready.slice(this.sent.length)) {
      if (!this.safeEarly(sentence)) {
        this.stopped = true;
        break;
      }
      this.sent.push(sentence);
      out.push(sentence);
    }
    return out;
  }

  private safeEarly(sentence: string): boolean {
    // Whether a search really happened is only known at the end (grounding metadata): held until then.
    if (claimsWebSearch(sentence)) return false;
    // Chat answers have no picture, so the scene rules (distances, "the way is clear") don't apply,
    // except to path questions, which the constructor already holds back.
    if (this.ctx.mode === "chat") return !CAMERA_MARKER.test(sentence) && !/\[|https?:|www\./i.test(sentence);
    if (guardSpoken(sentence, []) !== sentence) return false; // a quote from the scene may still keep it; the final check decides
    if (impliesClearWay(sentence)) return false; // needs the "this doesn't mean it's safe" reminder right after it
    if (this.ctx.cameraFacing === "user" && swapSides(sentence) !== sentence) return false;
    return true;
  }
}

/** What is left to say once the final answer is known, given the sentences already sent. */
export function remainingSpeech(finalSpoken: string, sent: string[]): string {
  const sentences = splitSentences(finalSpoken);
  let i = 0;
  while (i < sent.length && i < sentences.length && sentences[i] === sent[i]) i++;
  return sentences.slice(i).join(" ");
}

/**
 * A chat answer (no image): no links or markdown. Distances and facts are fine here ("Sousse is
 * 140 km away"), but a question about the user's way gets the walking-safety rules: without a camera
 * nothing can be said about it.
 */
export function sanitizeChat(raw: string, ctx: { question?: string; lang?: SpeechLang; usedWeb?: boolean }): SceneAnalysis {
  const say = speech(ctx.lang ?? "tn");
  const base: SceneAnalysis = { spoken: "", changed: true, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false, usedWeb: !!ctx.usedWeb };
  if (CAMERA_MARKER.test(raw)) return { ...base, needsCamera: true };
  const text = str(cleanChatText(raw).replace(/https?:\/\/\S+|www\.\S+/gi, " "), MAX_SPOKEN.chat);
  let spoken = ctx.usedWeb ? text : dropFalseSearchClaims(text);
  // Everything it said rested on a search that never happened: say so instead of a made-up answer.
  if (!spoken && text) spoken = say.noLiveInfo;
  if (isPathQuestion(ctx.question ?? "")) {
    spoken = guardSpoken(text, []);
    spoken = spoken ? `${spoken} ${say.pathCaveat}` : say.pathUnknown;
  }
  if (!spoken) throw new Error("empty chat answer"); // counts as a provider failure: nothing is made up
  return { ...base, spoken };
}
