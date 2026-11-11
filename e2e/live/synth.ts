// Synthesizes one sentence with a Microsoft Edge voice (through the app's own server module).
// node --experimental-strip-types --conditions=react-server e2e/live/synth.ts <voice> <text> <out.mp3>
import { synthesize, ttsConfig } from "../../src/lib/speech/edgeTts.ts";
import { writeFileSync } from "node:fs";
const [voice, text, out] = process.argv.slice(2);
const c = { ...ttsConfig(), voice, languageCode: voice.split("-").slice(0, 2).join("-") };
const t = Date.now();
const mp3 = await synthesize(text, 1, c, AbortSignal.timeout(15000));
writeFileSync(out, mp3);
console.log(voice, mp3.length, "bytes", Date.now() - t, "ms");
