// TEST TOOLING ONLY, never the app's voice: synthesizes the simulated *user's* spoken question with
// Gemini TTS (through the app's own server module), in a voice other than the assistant's so the
// checks can't confuse the two. Needs GEMINI_API_KEY.
// node --experimental-strip-types --conditions=react-server e2e/live/synth.ts <gemini-voice> <text> <out.wav>
import { synthesize, ttsConfig } from "../../src/lib/speech/geminiTts.ts";
import { writeFileSync } from "node:fs";
const [voice, text, out] = process.argv.slice(2);
const t = Date.now();
const wav = await synthesize(text, ttsConfig(), AbortSignal.timeout(30000), voice);
writeFileSync(out, wav);
console.log(voice, wav.length, "bytes", Date.now() - t, "ms");
