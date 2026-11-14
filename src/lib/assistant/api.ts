// Browser side of the API session (src/lib/server/session.ts): every call to a quota-limited route
// goes through apiFetch, which opens the anonymous session cookie first if needed, and once more if
// the server says it expired. Also the page's own failure reports: fixed event names and short
// codes, never content (src/lib/server/monitor.ts).

let opening: Promise<boolean> | null = null;
let opened = false;

// --- Nadhra AI: nothing leaves the page ---------------------------------------------------------
// While Nadhra AI is selected, the controller refuses every feature that would send something, and
// this is the last line behind it: no request of the page's own goes out at all (questions, pictures,
// recordings, the cloud voice, live tokens, failure reports). Its local engines aren't connected yet
// (step N1), so there is nothing it may send.

let localOnly = false;

/** Thrown instead of sending while Nadhra AI is selected. */
export class LocalOnlyError extends Error {
  readonly code = "nadhra-unavailable";
  constructor() {
    super("nadhra-unavailable");
  }
}

export function setLocalOnly(on: boolean) {
  localOnly = on;
  if (on) {
    queue.length = 0; // reports queued before the switch aren't sent either
    if (timer) clearTimeout(timer);
    timer = null;
  }
}
export const isLocalOnly = () => localOnly;

/** Opens the session (sets the HttpOnly cookie). Shared by concurrent callers. */
export function openSession(force = false): Promise<boolean> {
  if (opened && !force) return Promise.resolve(true);
  opening ??= fetch("/api/session", { cache: "no-store", credentials: "same-origin" })
    .then((r) => (opened = r.ok))
    .catch(() => false)
    .finally(() => (opening = null));
  return opening;
}

const isSessionError = async (res: Response) => res.status === 401 && (await res.clone().json().then((d) => d?.error === "session", () => false));

/** fetch() for /api routes. A request refused for a missing or expired session is sent again once. */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  if (localOnly) throw new LocalOnlyError();
  if (!opened) await openSession();
  const send = () => fetch(url, { credentials: "same-origin", ...init });
  const res = await send();
  if (!(await isSessionError(res))) return res;
  opened = false;
  if (!(await openSession(true))) return res;
  return send();
}

// --- failure reports ----------------------------------------------------------------------------

export type ReportEvent =
  | "camera-error"
  | "detector-failed"
  | "voice-error"
  | "live-failed"
  | "live-reconnect"
  | "scan-failed"
  | "question-failed"
  | "tts-failed"
  | "warning-expired"
  | "live-safety-claim"
  | "live-medical"
  | "consent-withdrawn";

const queue: { e: ReportEvent; c: string }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/** Queued and sent in a batch a few seconds later. `code` must be a short machine code. */
export function report(event: ReportEvent, code = "ok") {
  if (typeof window === "undefined" || typeof fetch !== "function" || localOnly) return;
  queue.push({ e: event, c: /^[a-z0-9][a-z0-9._:-]{0,47}$/.test(code) ? code : "other" });
  if (queue.length > 50) queue.shift();
  timer ??= setTimeout(flushReports, 5_000);
}

export function flushReports() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (localOnly || !queue.length || (typeof navigator !== "undefined" && navigator.onLine === false)) return;
  const events = queue.splice(0, 20);
  void apiFetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events }), keepalive: true, cache: "no-store" }).catch(() => {});
}
