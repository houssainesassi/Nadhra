// SERVER-ONLY. What every quota-limited API route checks, in this order:
//   1. the request comes from this site's own page (Origin header, required on POST);
//   2. it carries a valid session cookie (see session.ts);
//   3. per-minute limits, per session and per address;
//   4. daily budgets, per session and for the whole service.
// The daily budgets are the cost control: whatever a script does, the service as a whole never
// makes more upstream calls per day than configured. Counters are shared between server instances
// only when the Upstash store is configured (usageStore.ts).
import "server-only";
import { clientKey, isSameOrigin } from "./http.ts";
import { sessionIdFrom } from "./session.ts";
import { usageStore } from "./usageStore.ts";
import { record } from "./monitor.ts";

/** Everything that costs an upstream call. */
export type UsageKind = "vision" | "transcribe" | "tts" | "live" | "search" | "report";

interface Limits {
  perMinuteSession: number;
  perMinuteAddress: number;
  perDaySession: number;
  perDayGlobal: number;
}

const int = (v: string | undefined, def: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};

/**
 * Defaults sized for the free tiers and for a few dozen testers. A walk with the camera on sends
 * at most one frame every 4 s (900 an hour). Web search is the only billed call (with a billed
 * GEMINI_SEARCH_API_KEY): 150 a day stays inside its 5,000 included searches a month.
 */
export function limitsFor(kind: UsageKind): Limits {
  const e = process.env;
  switch (kind) {
    case "vision":
      return { perMinuteSession: int(e.VISION_RATE_LIMIT_PER_MIN, 40), perMinuteAddress: int(e.VISION_RATE_LIMIT_PER_MIN, 40) * 3, perDaySession: int(e.DAILY_VISION_PER_SESSION, 2_000), perDayGlobal: int(e.DAILY_VISION_GLOBAL, 10_000) };
    case "transcribe":
      return { perMinuteSession: int(e.VISION_TRANSCRIBE_RATE_LIMIT_PER_MIN, 20), perMinuteAddress: int(e.VISION_TRANSCRIBE_RATE_LIMIT_PER_MIN, 20) * 3, perDaySession: int(e.DAILY_TRANSCRIBE_PER_SESSION, 400), perDayGlobal: int(e.DAILY_TRANSCRIBE_GLOBAL, 2_000) };
    case "tts":
      return { perMinuteSession: int(e.TTS_RATE_LIMIT_PER_MIN, 30), perMinuteAddress: int(e.TTS_RATE_LIMIT_PER_MIN, 30) * 3, perDaySession: int(e.DAILY_TTS_PER_SESSION, 4_000), perDayGlobal: int(e.DAILY_TTS_GLOBAL, 30_000) };
    case "live":
      return { perMinuteSession: int(e.LIVE_TOKEN_RATE_LIMIT_PER_MIN, 12), perMinuteAddress: int(e.LIVE_TOKEN_RATE_LIMIT_PER_MIN, 12) * 3, perDaySession: int(e.DAILY_LIVE_PER_SESSION, 150), perDayGlobal: int(e.DAILY_LIVE_GLOBAL, 1_000) };
    case "search":
      return { perMinuteSession: 6, perMinuteAddress: 18, perDaySession: int(e.DAILY_SEARCH_PER_SESSION, 30), perDayGlobal: int(e.DAILY_SEARCH_GLOBAL, 150) };
    case "report":
      return { perMinuteSession: 10, perMinuteAddress: 30, perDaySession: 500, perDayGlobal: 50_000 };
  }
}

const SESSIONS_PER_ADDRESS_PER_HOUR = () => int(process.env.SESSIONS_PER_ADDRESS_PER_HOUR, 30);

export interface RequestContext {
  sessionId: string;
  address: string;
}

const NO_STORE = { "Cache-Control": "no-store" };
const deny = (status: number, error: string, retryAfterSec?: number) =>
  Response.json({ error }, { status, headers: { ...NO_STORE, ...(retryAfterSec ? { "Retry-After": String(retryAfterSec) } : {}) } });

/** The UTC day, for daily budgets. */
const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const minute = (now = Date.now()) => Math.floor(now / 60_000);

/** Steps 1 and 2. Returns the caller, or the response to send instead. */
export function checkRequest(req: Request, route: string): RequestContext | Response {
  // A POST from a browser always has an Origin; one without it is a script.
  if (!req.headers.get("origin") || !isSameOrigin(req)) {
    record(`${route}.denied`, "origin", "warn");
    return deny(403, "forbidden");
  }
  const sessionId = sessionIdFrom(req);
  if (!sessionId) {
    record(`${route}.denied`, "session");
    return deny(401, "session");
  }
  return { sessionId, address: clientKey(req) };
}

/**
 * Steps 3 and 4, for one upstream call of `kind`. Null when allowed (and counted), or the response
 * to send: 429 for a per-minute limit, 503 "quota-exhausted" for a daily budget.
 */
export async function charge(ctx: RequestContext, kind: UsageKind, now = Date.now()): Promise<Response | null> {
  const l = limitsFor(kind);
  const m = minute(now);
  const d = today(now);
  const [perMinSession, perMinAddress, perDaySession] = await usageStore().incr([
    { key: `m:${m}:${kind}:s:${ctx.sessionId}`, ttlSec: 120 },
    { key: `m:${m}:${kind}:a:${ctx.address}`, ttlSec: 120 },
    { key: `d:${d}:${kind}:s:${ctx.sessionId}`, ttlSec: 26 * 3600 },
  ]);
  if (perMinSession > l.perMinuteSession || perMinAddress > l.perMinuteAddress) {
    record(`${kind}.limited`, "minute");
    return deny(429, "too many requests", 20);
  }
  if (perDaySession > l.perDaySession) {
    record(`${kind}.limited`, "day-session", "warn");
    return deny(503, "quota-exhausted", 3600);
  }
  // Counted only once the session's own limits passed: one session hammering the route after its
  // budget is spent mustn't use up everyone else's.
  const [perDayGlobal] = await usageStore().incr([{ key: `d:${d}:${kind}:g`, ttlSec: 26 * 3600 }]);
  if (perDayGlobal > l.perDayGlobal) {
    record(`${kind}.limited`, "day-global", "warn");
    return deny(503, "quota-exhausted", 3600);
  }
  return null;
}

/** For the optional web search inside a question: true when it may run (and is then counted). */
export async function allowSearch(ctx: RequestContext): Promise<boolean> {
  return (await charge(ctx, "search")) === null;
}

/** Opening a session. Limited per address per hour, so a script can't mint endless fresh budgets. */
export async function allowNewSession(req: Request, now = Date.now()): Promise<boolean> {
  const hour = Math.floor(now / 3_600_000);
  const [n] = await usageStore().incr([{ key: `h:${hour}:session:a:${clientKey(req)}`, ttlSec: 3_700 }]);
  return n <= SESSIONS_PER_ADDRESS_PER_HOUR();
}

/** Today's totals for the whole service, for the health route. */
export async function usageToday(now = Date.now()) {
  const kinds: UsageKind[] = ["vision", "transcribe", "tts", "live", "search"];
  const d = today(now);
  const used = await usageStore().peek(kinds.map((k) => `d:${d}:${k}:g`));
  return {
    day: d,
    store: usageStore().kind,
    usage: Object.fromEntries(kinds.map((k, i) => [k, { used: used[i], budget: limitsFor(k).perDayGlobal }])),
  };
}
