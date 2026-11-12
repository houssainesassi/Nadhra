// Speech to text for browsers without working speech recognition (Firefox, Brave, Chromium builds).
// The audio is forwarded to the provider and not stored or logged.
import { transcribeAudio, visionStatus } from "../../../../lib/ai/vision.ts";
import { isSpeechLang } from "../../../../lib/assistant/lang.ts";
import { readJsonBody } from "../../../../lib/server/http.ts";
import { charge, checkRequest } from "../../../../lib/server/guard.ts";
import { record } from "../../../../lib/server/monitor.ts";

export const runtime = "nodejs";
export const maxDuration = 20;

// About 15 s of 16 kHz mono PCM, in base64.
const MAX_AUDIO_BASE64 = 700 * 1024;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export async function POST(req: Request) {
  const ctx = checkRequest(req, "transcribe");
  if (ctx instanceof Response) return ctx;
  const body = await readJsonBody<{ audio?: unknown; lang?: unknown }>(req, MAX_AUDIO_BASE64 + 1024);
  if (!body.ok) return json({ error: body.error }, body.status);
  const audio = body.value?.audio;
  if (typeof audio !== "string" || audio.length < 64 || audio.length > MAX_AUDIO_BASE64) return json({ error: "audio required" }, 400);
  if (Buffer.from(audio.slice(0, 8), "base64").toString("latin1", 0, 4) !== "RIFF") return json({ error: "audio must be WAV" }, 400);
  if (!visionStatus().canTranscribe) return json({ error: "not-configured" }, 503);
  const limited = await charge(ctx, "transcribe");
  if (limited) return limited;
  const lang = body.value?.lang;
  const result = await transcribeAudio(audio, isSpeechLang(lang) ? lang : "tn");
  if (!result.ok) {
    for (const a of result.attempts) console.warn(`[vision/transcribe] ${a.provider} failed: ${(a.error?.match(/^HTTP \d+/)?.[0] ?? a.error?.split(":")[0] ?? "").slice(0, 80)}`);
    record("transcribe.failed", "ai-unavailable", "warn");
    return json({ error: "ai-unavailable" }, 503);
  }
  return json({ text: result.text });
}
