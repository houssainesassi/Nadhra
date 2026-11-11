// Latency benchmark of the live conversation against the real service, through the app's own
// token route and LiveSession. Measured from the END OF SPEECH (the questions' trailing silence is
// detected and subtracted), to the first audio of the answer.
//   GEMINI_LIVE_MODELS=... GEMINI_LIVE_SILENCE_MS=... node --experimental-strip-types --conditions=react-server e2e/live/latency.ts [rounds]
import { readFileSync } from "node:fs";
import { LiveSession } from "../../src/lib/live/session.ts";
import { POST } from "../../src/app/api/live/token/route.ts";

const OUT = new URL("./out/", import.meta.url).pathname;
const rounds = Number(process.argv[2] ?? 3);
const questions = ["q_mech", "q_right", "q_before"].map((n) => {
  const b = readFileSync(`${OUT}${n}.pcm`);
  const x = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  let last = 0;
  for (let i = 0; i + 160 <= x.length; i += 160) {
    let e = 0;
    for (let j = i; j < i + 160; j++) e += x[j] * x[j];
    if (Math.sqrt(e / 160) > 300) last = i + 160;
  }
  return { n, b, trailingMs: ((x.length - last) / 16000) * 1000 };
});
let firstAudioAt = 0;
let turnDone: (() => void) | null = null;
const s = new LiveSession({ lang: "tn", facing: "outward", fetchImpl: async (_u, init) => POST(new Request("http://localhost/api/live/token", init as RequestInit)) }, {
  audio: () => { if (!firstAudioAt) firstAudioAt = Date.now(); },
  turnComplete: () => turnDone?.(),
});
await s.start();
s.sendFrame(readFileSync(`${OUT}mech.jpg`).toString("base64"));
let speech: Buffer | null = null, pos = 0, ended = 0;
const silence = Buffer.alloc(3200);
const iv = setInterval(() => {
  if (speech && pos < speech.length) {
    s.sendAudio(speech.subarray(pos, pos + 3200));
    pos += 3200;
    if (pos >= speech.length) { ended = Date.now(); speech = null; }
  } else s.sendAudio(silence);
}, 100);
const results: number[] = [];
for (let r = 0; r < rounds; r++) for (const q of questions) {
  firstAudioAt = 0;
  const done = new Promise<void>((res) => (turnDone = res));
  speech = q.b; pos = 0;
  await Promise.race([done, new Promise((res) => setTimeout(res, 20000))]);
  if (firstAudioAt) results.push(firstAudioAt - (ended - q.trailingMs));
  await new Promise((res) => setTimeout(res, 800));
}
clearInterval(iv);
s.stop();
results.sort((a, b) => a - b);
const med = results[Math.floor(results.length / 2)];
console.log(`${s.model} silence=${process.env.GEMINI_LIVE_SILENCE_MS ?? 500} end=${process.env.GEMINI_LIVE_END_SENSITIVITY ?? "default"}: end of speech -> first audio, n=${results.length}: median ${Math.round(med)} ms, min ${Math.round(results[0])}, max ${Math.round(results.at(-1)!)}`);
process.exit(0);
