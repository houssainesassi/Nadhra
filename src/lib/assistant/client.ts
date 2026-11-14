// Browser side of the API routes.
import type { VisionRequestBody, VisionResponseBody, VisionStatus, VisionStreamEvent } from "./types.ts";
import type { SpeechLang } from "./lang.ts";
import { apiFetch, LocalOnlyError } from "./api.ts";

export class VisionApiError extends Error {
  status: number;
  code: string;
  retryAfterMs: number;
  constructor(status: number, code: string, retryAfterMs = 0) {
    super(code);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * AbortSignal.any and AbortSignal.timeout, with a fallback: AbortSignal.any only exists since iOS
 * Safari 17.4, and without it every question on an older iPhone would fail before being sent.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), ms);
  return ctrl.signal;
}
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

async function postJson<T>(url: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const timeout = timeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: signal ? anySignal([signal, timeout]) : timeout,
    });
  } catch (e) {
    if (e instanceof LocalOnlyError) throw new VisionApiError(0, e.code); // Nadhra AI: never sent
    if (signal?.aborted) throw e; // cancelled by us, not a failure
    throw new VisionApiError(0, timeout.aborted ? "timeout" : "network");
  }
  if (!res.ok) {
    const code = await res.json().then((d) => String(d?.error ?? ""), () => "");
    throw new VisionApiError(res.status, code || `http-${res.status}`, Number(res.headers.get("retry-after") ?? 0) * 1000);
  }
  return (await res.json()) as T;
}

export const analyzeFrame = (body: VisionRequestBody, signal?: AbortSignal) => postJson<VisionResponseBody>("/api/vision", body, signal, 27_000);

export interface StreamedAnswer extends VisionResponseBody {
  /** What is left to say after the sentences already passed to onSentence. */
  rest: string;
}

/**
 * Asks a question and receives the answer sentence by sentence (server-sent events). A plain JSON
 * reply is accepted too. Throws VisionApiError: "interrupted" once some sentences have arrived.
 * A connection that fails before anything arrived is tried once more: the question is still current.
 */
export async function askStreaming(body: VisionRequestBody, onSentence: (text: string) => void, signal?: AbortSignal, timeoutMs = 27_000): Promise<StreamedAnswer> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    let received = 0;
    try {
      return await streamOnce(body, (text) => (received++, onSentence(text)), signal, Math.max(3_000, timeoutMs - (Date.now() - started)));
    } catch (e) {
      const retry = attempt === 0 && received === 0 && e instanceof VisionApiError && e.code === "network" && !signal?.aborted && navigator.onLine !== false && Date.now() - started < 10_000;
      if (!retry) throw e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

async function streamOnce(body: VisionRequestBody, onSentence: (text: string) => void, signal: AbortSignal | undefined, timeoutMs: number): Promise<StreamedAnswer> {
  const timeout = timeoutSignal(timeoutMs);
  const combined = signal ? anySignal([signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await apiFetch("/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), cache: "no-store", signal: combined });
  } catch (e) {
    if (e instanceof LocalOnlyError) throw new VisionApiError(0, e.code); // Nadhra AI: never sent
    if (signal?.aborted) throw e;
    throw new VisionApiError(0, timeout.aborted ? "timeout" : "network");
  }
  if (!res.ok) {
    const code = await res.json().then((d) => String(d?.error ?? ""), () => "");
    throw new VisionApiError(res.status, code || `http-${res.status}`, Number(res.headers.get("retry-after") ?? 0) * 1000);
  }
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream") || !res.body) {
    const data = (await res.json()) as VisionResponseBody;
    return { ...data, rest: data.analysis.spoken };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sentences = 0;
  const fail = (code: string) => new VisionApiError(0, sentences ? "interrupted" : code);
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (signal?.aborted) throw e;
      throw fail(timeout.aborted ? "timeout" : "network");
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data) continue;
      const event = JSON.parse(data) as VisionStreamEvent;
      if (event.type === "sentence") {
        sentences++;
        onSentence(event.text);
      } else if (event.type === "done") {
        void reader.cancel().catch(() => {});
        return event;
      } else {
        throw fail(event.error || "ai-unavailable");
      }
    }
  }
  throw fail("network"); // the stream ended without its final event
}

export const transcribeWav = (wavBase64: string, lang: SpeechLang = "tn") => postJson<{ text: string }>("/api/vision/transcribe", { audio: wavBase64, lang }, undefined, 19_000);

export async function fetchVisionStatus(): Promise<VisionStatus | null> {
  try {
    const res = await fetch("/api/vision", { cache: "no-store" });
    return res.ok ? ((await res.json()) as VisionStatus) : null;
  } catch {
    return null;
  }
}
