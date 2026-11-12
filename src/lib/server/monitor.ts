// SERVER-ONLY. Operational monitoring without user content: counts of events and failure codes,
// and one structured log line per notable event. Never images, audio, questions, answers,
// transcripts, locations, phone numbers or addresses: only fixed names and short codes.
import "server-only";

const CODE = /^[a-z0-9][a-z0-9._:-]{0,47}$/;
const counters = new Map<string, number>();
const startedAt = Date.now();

/** Keeps only a short machine code: anything else becomes "other", so content can't slip in. */
export const safeCode = (v: unknown): string => (typeof v === "string" && CODE.test(v) ? v : "other");

/** Counts an event and logs it as one JSON line. */
export function record(event: string, code = "ok", level: "info" | "warn" = "info") {
  const e = safeCode(event);
  const c = safeCode(code);
  const key = `${e}:${c}`;
  counters.set(key, (counters.get(key) ?? 0) + 1);
  if (counters.size > 2_000) counters.delete(counters.keys().next().value!);
  if (level === "warn" || process.env.MONITOR_LOG_ALL === "1") console[level](JSON.stringify({ at: new Date().toISOString(), event: e, code: c }));
}

export function snapshot() {
  return { since: new Date(startedAt).toISOString(), counters: Object.fromEntries([...counters].sort(([a], [b]) => a.localeCompare(b))) };
}

/** Events the page may report about itself (POST /api/report). Anything else is refused. */
export const CLIENT_EVENTS = new Set([
  "camera-error",
  "detector-failed",
  "voice-error",
  "live-failed",
  "live-reconnect",
  "scan-failed",
  "question-failed",
  "tts-failed",
  "warning-expired",
  "live-safety-claim",
  "consent-withdrawn",
]);

/** For tests. */
export function resetMonitor() {
  counters.clear();
}
