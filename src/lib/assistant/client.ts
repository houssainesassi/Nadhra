// Browser side of the API routes.
import type { VisionRequestBody, VisionResponseBody, VisionStatus } from "./types.ts";
import type { SpeechLang } from "./lang.ts";

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

async function postJson<T>(url: string, body: unknown, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (e) {
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

export const transcribeWav = (wavBase64: string, lang: SpeechLang = "tn") => postJson<{ text: string }>("/api/vision/transcribe", { audio: wavBase64, lang }, undefined, 19_000);

export async function fetchVisionStatus(): Promise<VisionStatus | null> {
  try {
    const res = await fetch("/api/vision", { cache: "no-store" });
    return res.ok ? ((await res.json()) as VisionStatus) : null;
  } catch {
    return null;
  }
}
