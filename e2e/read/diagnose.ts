// Why are clear lines withheld? Runs the same two readings as the server (the reading prompt, the
// first model on frame a, the second on frame b), the same checks (document.ts, lineCheck.ts), and
// saves both raw readings with every line's verdict, for e2e/read/draw_boxes.py.
//   node --experimental-strip-types --conditions=react-server e2e/read/diagnose.ts e2e/read/out/plan P01,M18 [box-key]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { getVisionProviders } = await import("../../src/lib/ai/vision.ts");
const { readSystemPrompt, buildReadText } = await import("../../src/lib/assistant/prompts.ts");
const { parseModelJson } = await import("../../src/lib/assistant/schema.ts");
const { sanitizeDocument } = await import("../../src/lib/assistant/document.ts");
const { inspectLine, toGray } = await import("../../src/lib/assistant/lineCheck.ts");

const dir = process.argv[2];
const ids = process.argv[3].split(",");
const gemini = getVisionProviders().filter((p) => p.family === "gemini");
const order = [gemini[0], gemini[1]];
mkdirSync("e2e/read/out/diag", { recursive: true });
const tally: Record<string, number> = {};
for (const id of ids) {
  const imgs = (["a", "b"] as const).map((v) => readFileSync(join(dir, `${id}_${v}.jpg`)));
  const raws = await Promise.all(imgs.map(async (buf, i) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const c = new AbortController();
        setTimeout(() => c.abort(), 30_000);
        return parseModelJson(await order[i].analyze({ system: readSystemPrompt("tn"), text: buildReadText({ hasImage: true, now: new Date() }), images: [buf.toString("base64")], maxTokens: 4000, signal: c.signal, temperature: 0 }));
      } catch { await new Promise((r) => setTimeout(r, 3000)); }
    }
    return null;
  }));
  if (!raws[0] || !raws[1]) { console.log(id, "provider failure"); continue; }
  const grays = imgs.map((b) => { const d = jpeg.decode(b, { useTArray: true }); return toGray(d.data, d.width, d.height); });
  const a = sanitizeDocument(raws[0], { lang: "tn", now: new Date(), confirm: raws[1], inspect: { first: (box, t) => inspectLine(grays[0], box, t), second: (box, t) => inspectLine(grays[1], box, t) } });
  const checks = a.document?.checks ?? [];
  for (const c of checks) tally[c.verdict.split(":")[0]] = (tally[c.verdict.split(":")[0]] ?? 0) + 1;
  writeFileSync(`e2e/read/out/diag/${id}.json`, JSON.stringify({ id, first: raws[0], second: raws[1], checks }, null, 1));
  console.log(id.padEnd(5), checks.map((c) => `${c.text.slice(0, 22)}=${c.verdict}`).join(" | ").slice(0, 600));
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("verdicts:", JSON.stringify(tally));
