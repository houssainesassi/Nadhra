// Types shared by the browser and the /api/vision route. No runtime code.
import type { SpeechLang } from "./lang.ts";

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
export type VisionMode = "scan" | "question";

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
}

export interface VisionRequestBody {
  mode: VisionMode;
  /** JPEG, base64 without the data: prefix. */
  image: string;
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
}

export interface VisionResponseBody {
  analysis: SceneAnalysis;
  provider: string;
  latencyMs: number;
}

export interface VisionStatus {
  available: boolean;
  /** Companies that receive the images, in fallback order: shown in the privacy notice. */
  providers: { id: string; label: string }[];
  canTranscribe: boolean;
}
