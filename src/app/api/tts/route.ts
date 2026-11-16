import { handleTtsPost, ttsStatus } from "@/lib/speech/geminiTts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Reports whether the assistant's voice (Gemini TTS, Sulafat) is enabled.
export function GET() {
  return Response.json(ttsStatus(), { headers: { "Cache-Control": "no-store" } });
}

// Synthesizes one sentence to WAV with Google Gemini TTS, voice Sulafat. Nothing is stored.
export function POST(req: Request) {
  return handleTtsPost(req);
}
