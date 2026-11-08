// SERVER-ONLY. Small helpers for calling AI providers.
import "server-only";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new HttpError(res.status, `HTTP ${res.status} ${text}`);
  }
  return res.json();
}

export function isFreeOpenRouterModel(model: string): boolean {
  return model === "openrouter/free" || model.endsWith(":free");
}
