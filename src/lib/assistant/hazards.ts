// Decides how serious a detection is and whether it should be spoken again. Pure logic.
import type { Hazard } from "./types.ts";

export type Urgency = "urgent" | "caution" | "info";

/**
 * Deliberately not taken from the model: a hazard is urgent only when there is enough evidence.
 * An uncertain detection can never be urgent, and something far away is not a warning.
 */
export function hazardUrgency(h: Hazard): Urgency {
  const near = h.proximity === "near";
  const coming = h.motion === "approaching";
  if (h.proximity === "far" && !coming) return "info";
  if (h.confidence === "uncertain") return near || h.proximity === "unknown" ? "caution" : "info";
  switch (h.kind) {
    case "stairs":
    case "drop":
      return near || h.side === "center" ? "urgent" : "caution";
    case "vehicle":
      return near || coming ? "urgent" : h.proximity === "mid" ? "caution" : "info";
    case "person":
      return near && (coming || h.side === "center") ? "caution" : coming ? "caution" : "info";
    case "obstacle":
      if (near && h.side === "center") return "urgent";
      return near ? "caution" : "info";
  }
}

const RANK: Record<Urgency, number> = { info: 0, caution: 1, urgent: 2 };

/** Stops the same warning from repeating, but lets it through at once when it becomes more serious. */
export class WarningGate {
  private seen = new Map<string, { at: number; rank: number }>();
  private cooldownMs: Record<Urgency, number>;
  constructor(cooldownMs: Partial<Record<Urgency, number>> = {}) {
    // An unchanged hazard is repeated rarely: constant warnings teach people to stop listening.
    this.cooldownMs = { urgent: 15_000, caution: 45_000, info: 60_000, ...cooldownMs };
  }

  admit(h: Hazard, urgency: Urgency, now: number): boolean {
    if (urgency === "info") return false;
    const key = hazardKey(h);
    const last = this.seen.get(key);
    // "Coming toward you" is new information even at the same severity, so it isn't held back.
    const rank = RANK[urgency] + (h.motion === "approaching" ? 0.5 : 0);
    if (last && rank <= last.rank && now - last.at < this.cooldownMs[urgency]) return false;
    this.seen.set(key, { at: now, rank });
    return true;
  }

  /** The warning was never heard (it went stale in the queue): the next detection may say it. */
  forget(key: string) {
    this.seen.delete(key);
  }

  clear() {
    this.seen.clear();
  }
}

/** Which warnings count as "the same one" for repeats. */
export const hazardKey = (h: Pick<Hazard, "kind" | "side">) => `${h.kind}:${h.side}`;
