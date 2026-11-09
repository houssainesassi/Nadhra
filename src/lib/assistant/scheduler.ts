// When to send a frame to the vision model. A request is the expensive part (battery, latency, free
// quota), so the frame is sent only when the scene changed, with a slow heartbeat otherwise. Pure logic.
// Speech playing never holds a frame back: during a long reading the scans are what still warn about
// stairs and drops (the controller then speaks only their warnings, not a new description).
import type { LocalQuality } from "./frameAnalysis.ts";

export const SCHEDULE = {
  /** Never more often than this: free tiers allow about 15 requests a minute. */
  minIntervalMs: 4_000,
  /** The scene counts as changed above this fraction of pixels. */
  changeThreshold: 0.08,
  /** Heartbeat for a still scene; doubles with each unchanged result, up to the maximum. */
  heartbeatMs: 20_000,
  maxHeartbeatMs: 80_000,
  /** How long to wait for a sharp frame before sending a blurred one anyway. */
  blurWaitMs: 6_000,
  maxBackoffMs: 60_000,
};

export interface ScanInput {
  now: number;
  /** Time of the last request, or -Infinity. */
  lastScanAt: number;
  /** Change since the last sent frame. */
  changed: number;
  quality: LocalQuality;
  inFlight: boolean;
  paused: boolean;
  hidden: boolean;
  backoffUntil: number;
  /** Results in a row where the model reported nothing new. */
  unchangedStreak: number;
  /** The on-device detector just found something new. */
  newObject: boolean;
  /** When the current run of blurred frames began, or null. */
  blurSince: number | null;
}

export type ScanDecision = { send: true; reason: "first" | "change" | "new-object" | "heartbeat" } | { send: false; reason: string };

export function heartbeatFor(unchangedStreak: number): number {
  return Math.min(SCHEDULE.maxHeartbeatMs, SCHEDULE.heartbeatMs * 2 ** Math.max(0, unchangedStreak));
}

export function decideScan(s: ScanInput): ScanDecision {
  if (s.paused) return { send: false, reason: "paused" };
  if (s.hidden) return { send: false, reason: "hidden" };
  if (s.inFlight) return { send: false, reason: "in-flight" };
  if (s.now < s.backoffUntil) return { send: false, reason: "backoff" };
  if (s.quality === "dark" || s.quality === "bright" || s.quality === "flat") return { send: false, reason: `quality-${s.quality}` };
  const elapsed = s.now - s.lastScanAt;
  if (elapsed < SCHEDULE.minIntervalMs) return { send: false, reason: "too-soon" };
  // Usually the camera is swinging: a sharp frame is worth a short wait, but not forever.
  if (s.quality === "blurry" && s.blurSince !== null && s.now - s.blurSince < SCHEDULE.blurWaitMs) return { send: false, reason: "waiting-for-sharp" };
  if (s.lastScanAt === -Infinity) return { send: true, reason: "first" };
  if (s.newObject) return { send: true, reason: "new-object" };
  if (s.changed >= SCHEDULE.changeThreshold) return { send: true, reason: "change" };
  if (elapsed >= heartbeatFor(s.unchangedStreak)) return { send: true, reason: "heartbeat" };
  return { send: false, reason: "no-change" };
}

/** Delay after `failures` failed requests in a row (or the server's Retry-After, if longer). */
export function backoffMs(failures: number, retryAfterMs = 0): number {
  return Math.max(retryAfterMs, Math.min(SCHEDULE.maxBackoffMs, SCHEDULE.minIntervalMs * 2 ** Math.max(0, failures)));
}
