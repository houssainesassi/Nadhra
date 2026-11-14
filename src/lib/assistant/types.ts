// Types shared by the browser and the /api/vision route. No runtime code.
import type { SpeechLang } from "./lang.ts";
import type { AiTask } from "../ai/router.ts";

/** Position from the USER's point of view (already corrected for a webcam that faces the user). */
export type Side = "left" | "center" | "right" | "unknown";
/** Relative, judged from the picture only. Never a measured distance. */
export type Proximity = "near" | "mid" | "far" | "unknown";
export type Confidence = "confirmed" | "likely" | "uncertain";
export type Motion = "approaching" | "moving_away" | "stationary" | "crossing" | "unknown";
export type Category = "object" | "person" | "vehicle";
export type HazardKind = "stairs" | "drop" | "vehicle" | "person" | "obstacle";
export type ImageQuality = "good" | "dark" | "blurry" | "obstructed";
/** "outward": the user stands behind the camera (phone, glasses). "user": the webcam looks at the user, like a mirror. */
export type CameraFacing = "outward" | "user";
/** "scan": automatic description. "question": a question about the current frame. "chat": a question
 * with the camera off, answered without any image (general knowledge, or the web when available).
 * "read": a document or package is read word for word (medicine, prescription, bill, letter), or a
 * question is asked about one read earlier. See document.ts. */
export type VisionMode = "scan" | "question" | "chat" | "read";

export interface Detection {
  label: string;
  category: Category;
  side: Side;
  proximity: Proximity;
  confidence: Confidence;
  motion: Motion;
  action?: string;
}

export interface Hazard {
  kind: HazardKind;
  label: string;
  side: Side;
  proximity: Proximity;
  confidence: Confidence;
  motion: Motion;
}

export interface SceneText {
  content: string;
  confidence: Confidence;
}

/** What a read document is. "medical": a medical paper that is not a prescription (results, a report, a leaflet). */
export type DocKind = "medicine" | "prescription" | "medical" | "invoice" | "letter" | "other" | "none";
export type Legibility = "clear" | "partial" | "unreadable";
export type ReadProblem = "blurry" | "glare" | "cut_off" | "too_far" | "dark" | "handwriting" | "angle";

/** One printed line, copied as it is written. */
export interface DocLine {
  text: string;
  confidence: Confidence;
  /** Where the model places the line: [ymin, xmin, ymax, xmax] in thousandths of the picture. */
  box?: [number, number, number, number];
  /** Where the locating model places it in the same frame; null: "not fully visible". Absent: not located. */
  located?: [number, number, number, number] | null;
}

/** Copied from the package. A field is only present when its text was found in a clearly read line. */
export interface MedicineFields {
  name?: string;
  ingredient?: string;
  strength?: string;
  form?: string;
  quantity?: string;
  expiry?: string;
}

/** One piece of the spoken reading. "document": copied text, in its own language's voice. "assistant": everything else. */
export interface SpeechSegment {
  text: string;
  source: "document" | "assistant";
  lang?: SpeechLang;
}

export interface DocumentReading {
  kind: DocKind;
  legibility: Legibility;
  problems: ReadProblem[];
  /** Every line the model reported, with its confidence. Only confirmed (and, outside medical papers, likely) ones are read out. */
  lines: DocLine[];
  medicine: MedicineFields;
  /** The model's explanation after the checks. Never text from the document. */
  explanation: string;
  /** The picture can't be read well enough: the user is asked to scan again. */
  rescan: boolean;
  /** A question was asked and it was not about the document: the client asks it as a normal question. */
  notAboutDocument?: boolean;
  /** Medical paper: some lines were not read the same way twice, so they were not said. */
  unconfirmed?: boolean;
  /** Medical paper: some lines were not whole in the picture (cut, covered, washed out), so they were not said. */
  obscured?: ("no-box" | "edge" | "covered" | "incomplete" | "faint" | "mismatch")[];
  /** Medical paper: why each line was or wasn't read ("ok", "disputed", "faint:first"…). For diagnosis only, never spoken. */
  checks?: { text: string; verdict: string }[];
  /** What is said, in order. `SceneAnalysis.spoken` is these joined. */
  segments: SpeechSegment[];
  /** The full text was not read out (a medicine box, or a long paper): "read all" reads `lines`. */
  more: boolean;
}

/** A document read earlier, sent back with a follow-up question about it. */
export interface DocumentContext {
  kind: DocKind;
  /** Only lines that were read clearly. */
  lines: string[];
}

export interface SceneAnalysis {
  /** Tunisian Arabic sentence(s) to speak. Empty = nothing new worth saying. */
  spoken: string;
  changed: boolean;
  imageQuality: ImageQuality;
  environment: { label: string; confidence: Confidence } | null;
  detections: Detection[];
  hazards: Hazard[];
  texts: SceneText[];
  uncertain: boolean;
  /** Chat mode: the question is about the surroundings, so it needs the camera. "spoken" is then "". */
  needsCamera?: boolean;
  /** The answer was grounded in a live web search. */
  usedWeb?: boolean;
  /** Read mode: the document as read and checked. */
  document?: DocumentReading;
  /** Scan mode: a paper, prescription or package is held up to the camera. Its text is not kept. */
  documentInView?: boolean;
}

export interface VisionRequestBody {
  mode: VisionMode;
  /** JPEG, base64 without the data: prefix. Absent only in chat mode. */
  image?: string;
  /** Older, smaller frame: the only evidence allowed for motion claims. */
  previousImage?: string;
  previousAgeMs?: number;
  cameraFacing: CameraFacing;
  question?: string;
  /** Recently spoken sentences, so the model doesn't repeat itself. */
  recent?: string[];
  /** Last question/answer pairs, for follow-ups such as «إيه، اقراها». */
  history?: { q: string; a: string }[];
  /** The language the user hears. Tunisian when missing. */
  lang?: SpeechLang;
  /** Answer as server-sent events, sentence by sentence (questions only). */
  stream?: boolean;
  /** Read mode: the document read earlier, for a follow-up question. The image is optional then. */
  document?: DocumentContext;
  /** Read mode: a second frame, taken a moment after `image`, for an independent second reading of doses and dates. */
  secondImage?: string;
}

export interface VisionResponseBody {
  analysis: SceneAnalysis;
  provider: string;
  latencyMs: number;
  /** Streamed answers: ms from the request reaching the server to the model's first text, and to the first sentence sent. */
  timing?: { firstTokenMs?: number; firstSentenceMs?: number; totalMs: number };
}

/**
 * Server-sent events of a streamed answer. "sentence" events are final and in order: the client can
 * speak them at once. "done" carries the whole checked analysis and the part not yet sent ("rest"),
 * which may be a safety caveat. "error" means the answer stopped; nothing more will come.
 */
export type VisionStreamEvent =
  | { type: "sentence"; text: string }
  | ({ type: "done"; rest: string } & VisionResponseBody)
  | { type: "error"; error: string };

export interface VisionStatus {
  /** AI_MODE on the server when it isn't cloud (the default, then absent): hybrid or offline (nothing leaves the device). */
  mode?: "cloud" | "hybrid" | "offline";
  available: boolean;
  /** Companies that receive the images, in fallback order: shown in the privacy notice. */
  providers: { id: string; label: string }[];
  canTranscribe: boolean;
  /** Questions that need current information can be looked up on the web. */
  canSearch?: boolean;
  /**
   * Present only when this server offers Nadhra AI (NADHRA_AI_ENABLED with AI_MODE hybrid or offline):
   * experimental, and the tasks it can do now (none until its local engines are connected).
   */
  nadhra?: { experimental: true; tasks: AiTask[] };
}
