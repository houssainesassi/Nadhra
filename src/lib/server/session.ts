// SERVER-ONLY. Anonymous browser sessions for the API routes.
//
// The page asks /api/session for a signed, HttpOnly cookie, and every paid or quota-limited route
// requires it. This is NOT authentication (there are no accounts, and a script can fetch a cookie
// too). What it gives: per-session limits and budgets, a cap on how many sessions one address can
// open, and no way to call the routes with a bare `curl` or from another site.
//
// The signing key is SESSION_SECRET, or else one derived from GEMINI_API_KEY, so every server
// instance agrees without extra configuration. Without either, a random per-process key is used
// (fine for local development; sessions then end when the server restarts).
import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "nadhra_session";
export const SESSION_TTL_SEC = 7 * 24 * 3600;

let processSecret: Buffer | null = null;

function secret(): Buffer {
  const explicit = process.env.SESSION_SECRET?.trim();
  if (explicit && explicit.length >= 16) return Buffer.from(explicit);
  const key = process.env.GEMINI_API_KEY?.trim();
  if (key) return createHmac("sha256", key).update("nadhra-session-v1").digest();
  processSecret ??= randomBytes(32);
  return processSecret;
}

const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

/** A new token: `v1.<id>.<expiry in seconds>.<signature>`. */
export function issueSessionToken(now = Date.now()): { token: string; id: string; expires: number } {
  const id = randomBytes(12).toString("base64url");
  const expires = Math.floor(now / 1000) + SESSION_TTL_SEC;
  const payload = `v1.${id}.${expires}`;
  return { token: `${payload}.${sign(payload)}`, id, expires };
}

/** The session id, or null when the token is missing, forged or expired. */
export function verifySessionToken(token: string | null | undefined, now = Date.now()): string | null {
  if (!token || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [v, id, exp, sig] = parts;
  if (!/^[\w-]{8,32}$/.test(id) || !/^\d{1,12}$/.test(exp)) return null;
  const expected = Buffer.from(sign(`${v}.${id}.${exp}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 <= now) return null;
  return id;
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const sessionIdFrom = (req: Request) => verifySessionToken(readCookie(req, SESSION_COOKIE));

/** Secure on https (and behind a TLS proxy); plain http only for local development. */
export function sessionCookieHeader(req: Request, token: string): string {
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const secure = proto === "https" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/api; Max-Age=${SESSION_TTL_SEC}; HttpOnly; SameSite=Strict${secure}`;
}
