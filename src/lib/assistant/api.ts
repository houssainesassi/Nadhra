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

// Every request of the page carries the signal of the current "epoch". Switching to Nadhra aborts it
// first of all, so whatever was still being sent or awaited (a question, a recording, a sentence for
// the cloud voice, a live token) stops at once, and nothing is retried after it.
let epoch = new AbortController();
let inFlight = 0;

/** Returns how many of the page's requests were still open and have just been aborted. */
export function setLocalOnly(on: boolean): number {
  localOnly = on;
  if (!on) return 0;
  const cancelled = inFlight;
  epoch.abort(new LocalOnlyError());
  epoch = new AbortController();
  queue.length = 0; // reports queued before the switch aren't sent either
  if (timer) clearTimeout(timer);
  timer = null;
  return cancelled;
}
export const isLocalOnly = () => localOnly;

/** The request's own signal (if any) and the epoch's, as one. */
function withEpoch(own: AbortSignal | null | undefined): AbortSignal {
  const e = epoch.signal;
  if (!own) return e;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([own, e]);
  const ctrl = new AbortController();
  for (const s of [own, e]) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

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
  const signal = withEpoch(init.signal);
  inFlight++;
  try {
    if (!opened) await openSession();
    const send = () => {
      if (localOnly) throw new LocalOnlyError(); // switched while waiting: not sent at all
      return fetch(url, { credentials: "same-origin", ...init, signal });
    };
    const res = await send();
    if (!(await isSessionError(res))) return res;
    opened = false;
    if (!(await openSession(true))) return res;
    return send();
  } finally {
    inFlight--;
  }
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
