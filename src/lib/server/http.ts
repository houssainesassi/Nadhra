// SERVER-ONLY. Small request helpers shared by the API routes: bounded JSON body reading,
// same-origin check, client key and an in-memory sliding-window rate limiter.
// State is per server instance (serverless instances don't share memory); that is acceptable for
// protecting free upstream services, whose own 429s are handled by the callers.
import "server-only";

export type BodyResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 413; error: string };

/**
 * Parse a JSON body of at most maxBytes. Checks Content-Length first (cheap rejection), then
 * counts the streamed bytes, so a chunked upload without a length header can't exceed the limit.
 */
export async function readJsonBody<T = unknown>(req: Request, maxBytes: number): Promise<BodyResult<T>> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, status: 413, error: "payload too large" };
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, error: "payload too large" };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON" };
  }
}

/** Browser requests from another site are refused. A missing Origin (same-origin GET-like fetches, curl) is allowed; rate limits still apply. */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Client identifier for rate limiting (first X-Forwarded-For hop, as set by Vercel / the proxy). */
export function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "local";
}

/** Sliding-window limiter: at most `max` hits per `windowMs` per key; memory bounded to `maxKeys` (least recently active dropped). */
export class RateLimiter {
  private hits = new Map<string, number[]>();
  private max: number;
  private windowMs: number;
  private maxKeys: number;
  constructor(max: number, windowMs = 60_000, maxKeys = 5000) {
    this.max = max;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }

  /** Records a hit and returns true, or returns false (and records nothing) when the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.delete(key); // re-insert: Map order = least recently active first
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value!);
    return true;
  }

  get size() {
    return this.hits.size;
  }

  clear() {
    this.hits.clear();
  }
}
