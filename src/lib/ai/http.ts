// SERVER-ONLY. Small helpers for calling AI providers.
import "server-only";
import { noteCloudReachable } from "../server/deviceCapabilities.ts";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * fetch() to a cloud provider. Its outcome also tells the server whether the internet is reachable
 * (hybrid mode), so no separate request is ever needed for that (deviceCapabilities.ts).
 */
async function cloudFetch(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
  try {
    const res = await fetch(url, init);
    noteCloudReachable(true);
    return res;
  } catch (e) {
    if (!init.signal.aborted) noteCloudReachable(false);
    throw e;
  }
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const res = await cloudFetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new HttpError(res.status, `HTTP ${res.status} ${text}`);
  }
  return res.json();
}

export function isFreeOpenRouterModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}

/**
 * POSTs and reads a server-sent-events response, calling `onEvent` with each JSON `data:` payload
 * as it arrives. Errors before the stream starts throw HttpError, like postJson.
 */
export async function postSse(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, onEvent: (data: unknown) => void) {
  const res = await cloudFetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new HttpError(res.status, `HTTP ${res.status} ${text}`);
  }
  if (!res.body) throw new Error("empty stream");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (final: boolean) => {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      onEvent(JSON.parse(payload));
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    flush(false);
  }
  buffer += decoder.decode();
  flush(true);
}
