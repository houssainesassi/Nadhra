import { handleTtsPost, ttsStatus } from "@/lib/speech/edgeTts";

export const runtime = "nodejs"; // needs Node's WebSocket client with custom headers (not available on Edge runtime)
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Reports whether the cloud voice is enabled and which voice it uses (no key exists).
export function GET() {
  return Response.json(ttsStatus(), { headers: { "Cache-Control": "no-store" } });
}

// Synthesizes one sentence to MP3 via Microsoft Edge's free online voice. Nothing is stored.
export function POST(req: Request) {
  return handleTtsPost(req);
}
