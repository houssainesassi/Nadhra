// Health check. Public: only "ok". With `Authorization: Bearer <HEALTH_TOKEN>`: event counters and
// today's usage against the daily budgets (aggregate numbers only, no content, no addresses), and the
// device: CPU, memory, temperature, AI mode, internet, and which engine would do each task. Hardware
// facts stay behind the token: a public deployment doesn't describe its machine to anyone who asks.
import { timingSafeEqual } from "node:crypto";
import { usageToday } from "../../../lib/server/guard.ts";
import { snapshot } from "../../../lib/server/monitor.ts";
import { deviceInfo } from "../../../lib/server/deviceCapabilities.ts";
import { capabilitySummary } from "../../../lib/ai/vision.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(req: Request): boolean {
  const token = process.env.HEALTH_TOKEN?.trim();
  if (!token || token.length < 16) return false;
  const given = Buffer.from(req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(req: Request) {
  const headers = { "Cache-Control": "no-store" };
  if (!authorized(req)) return Response.json({ ok: true }, { headers });
  return Response.json({ ok: true, ...(await usageToday()), ...snapshot(), device: deviceInfo(), ai: capabilitySummary() }, { headers });
}
