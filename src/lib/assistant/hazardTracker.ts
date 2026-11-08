// Follows objects from the on-device detector across frames. A single detection is never reported:
// an object must persist, and "approaching" comes from its apparent size growing over at least a
// second while the camera is still. Pure logic (tests/hazardTracker.test.ts).
import type { CameraFacing, Confidence, Hazard, HazardKind, Motion, Proximity, Side } from "./types.ts";

export interface RawDetection {
  /** COCO class name from the detector. */
  label: string;
  score: number;
  /** All normalized to 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ClassInfo {
  ar: string;
  kind: HazardKind;
  minScore: number;
}

const CLASSES: Record<string, ClassInfo> = {
  person: { ar: "شخص", kind: "person", minScore: 0.5 },
  car: { ar: "كرهبة", kind: "vehicle", minScore: 0.5 },
  motorcycle: { ar: "موتور", kind: "vehicle", minScore: 0.5 },
  bicycle: { ar: "بسكلات", kind: "vehicle", minScore: 0.5 },
  bus: { ar: "كار", kind: "vehicle", minScore: 0.5 },
  truck: { ar: "كميون", kind: "vehicle", minScore: 0.5 },
  train: { ar: "تران", kind: "vehicle", minScore: 0.5 },
  chair: { ar: "كرسي", kind: "obstacle", minScore: 0.6 },
  bench: { ar: "بنك", kind: "obstacle", minScore: 0.6 },
  couch: { ar: "فوتاي", kind: "obstacle", minScore: 0.6 },
  "dining table": { ar: "طاولة", kind: "obstacle", minScore: 0.6 },
  "potted plant": { ar: "نبتة", kind: "obstacle", minScore: 0.6 },
  suitcase: { ar: "فاليجة", kind: "obstacle", minScore: 0.6 },
  "fire hydrant": { ar: "حنفية حريق", kind: "obstacle", minScore: 0.6 },
};

const TRACK_TIMEOUT_MS = 1_500;
const MIN_HITS = 3;
const CONFIRMED_HITS = 5;
const CONFIRMED_SCORE = 0.7;
const MOTION_MIN_MS = 1_000;
const MOTION_MIN_SAMPLES = 4;
const GROWTH = 1.15; // linear size change, about 15 % over the observed window
const HISTORY_MS = 3_000;

interface Sample {
  t: number;
  size: number;
}

interface Track {
  id: number;
  label: string;
  box: RawDetection;
  hits: number;
  scoreSum: number;
  lastSeen: number;
  history: Sample[];
  reported: boolean;
}

function iou(a: RawDetection, b: RawDetection): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function sideOf(box: RawDetection, facing: CameraFacing): Side {
  const cx = box.x + box.w / 2;
  const side: Side = cx < 0.36 ? "left" : cx > 0.64 ? "right" : "center";
  if (facing === "outward") return side;
  return side === "left" ? "right" : side === "right" ? "left" : side;
}

function proximityOf(box: RawDetection, kind: HazardKind): Proximity {
  const area = box.w * box.h;
  switch (kind) {
    case "person":
      return box.h > 0.6 ? "near" : box.h > 0.3 ? "mid" : "far";
    case "vehicle":
      return area > 0.2 || box.w > 0.5 ? "near" : area > 0.05 ? "mid" : "far";
    default:
      // Obstacles matter when they reach the bottom of the picture, where the user's feet would be.
      return box.y + box.h > 0.85 && area > 0.12 ? "near" : area > 0.04 ? "mid" : "far";
  }
}

function motionOf(history: Sample[], cameraMoving: boolean): Motion {
  if (cameraMoving || history.length < MOTION_MIN_SAMPLES) return "unknown";
  const span = history[history.length - 1].t - history[0].t;
  if (span < MOTION_MIN_MS) return "unknown";
  const third = Math.max(1, Math.floor(history.length / 3));
  const mean = (s: Sample[]) => s.reduce((sum, x) => sum + x.size, 0) / s.length;
  const ratio = mean(history.slice(-third)) / mean(history.slice(0, third));
  if (ratio >= GROWTH) return "approaching";
  if (ratio <= 1 / GROWTH) return "moving_away";
  return "stationary";
}

export interface TrackerUpdate {
  /** Objects that have persisted long enough to be believed. */
  hazards: Hazard[];
  /** At least one object was just confirmed for the first time: worth asking the vision model. */
  newObject: boolean;
}

export class HazardTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  update(detections: RawDetection[], t: number, opts: { cameraMoving: boolean; facing: CameraFacing }): TrackerUpdate {
    const known = detections
      .filter((d) => CLASSES[d.label] && d.score >= CLASSES[d.label].minScore)
      .sort((a, b) => b.score - a.score);
    const free = new Set(this.tracks);
    for (const d of known) {
      let best: Track | null = null;
      let bestIou = 0.2;
      for (const track of free) {
        if (track.label !== d.label) continue;
        const overlap = iou(track.box, d);
        if (overlap > bestIou) {
          best = track;
          bestIou = overlap;
        }
      }
      if (best) free.delete(best);
      const track: Track = best ?? { id: this.nextId++, label: d.label, box: d, hits: 0, scoreSum: 0, lastSeen: t, history: [], reported: false };
      if (!best) this.tracks.push(track);
      track.box = d;
      track.hits++;
      track.scoreSum += d.score;
      track.lastSeen = t;
      track.history.push({ t, size: Math.sqrt(d.w * d.h) });
      while (track.history.length && t - track.history[0].t > HISTORY_MS) track.history.shift();
    }
    this.tracks = this.tracks.filter((track) => t - track.lastSeen <= TRACK_TIMEOUT_MS);

    let newObject = false;
    const hazards: Hazard[] = [];
    for (const track of this.tracks) {
      if (track.hits < MIN_HITS || track.lastSeen !== t) continue;
      const info = CLASSES[track.label];
      if (opts.facing === "user" && info.kind !== "vehicle") {
        // A desk webcam sees the user and their room up close: that is not an obstacle in their way.
        if (info.kind === "obstacle" || proximityOf(track.box, info.kind) === "near") continue;
      }
      if (!track.reported) {
        track.reported = true;
        newObject = true;
      }
      const confidence: Confidence = track.hits >= CONFIRMED_HITS && track.scoreSum / track.hits >= CONFIRMED_SCORE ? "confirmed" : "likely";
      hazards.push({
        kind: info.kind,
        label: info.ar,
        side: sideOf(track.box, opts.facing),
        proximity: proximityOf(track.box, info.kind),
        confidence,
        motion: motionOf(track.history, opts.cameraMoving),
      });
    }
    return { hazards, newObject };
  }

  clear() {
    this.tracks = [];
  }
}
