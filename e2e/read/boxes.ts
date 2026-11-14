// Calibration helper for the pixel check of printed lines (src/lib/assistant/lineCheck.ts): asks the
// real model to read some plan cases and saves its raw output, with the line boxes, for inspection.
//   node --experimental-strip-types --conditions=react-server e2e/read/boxes.ts e2e/read/out/plan M01,M16b,M19
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { getVisionProviders } = await import("../../src/lib/ai/vision.ts");
const { readSystemPrompt, buildReadText } = await import("../../src/lib/assistant/prompts.ts");
const { parseModelJson } = await import("../../src/lib/assistant/schema.ts");
const dir = process.argv[2];
const ids = process.argv[3].split(",");
const models = getVisionProviders().filter((p) => p.family === "gemini").slice(0, 2);
mkdirSync("e2e/read/out/boxes", { recursive: true });
for (const id of ids) {
  for (const [i, v] of (["a", "b"] as const).entries()) {
    const p = models[i];
    const img = readFileSync(join(dir, `${id}_${v}.jpg`)).toString("base64");
    const c = new AbortController();
    setTimeout(() => c.abort(), 30_000);
    try {
      const raw = parseModelJson(await p.analyze({ system: readSystemPrompt("tn"), text: buildReadText({ hasImage: true, now: new Date() }), images: [img], maxTokens: 4000, signal: c.signal, temperature: 0 }));
      writeFileSync(`e2e/read/out/boxes/${id}_${v}.json`, JSON.stringify(raw, null, 1));
      console.log(id, v, p.model, JSON.stringify((raw.lines as { text: string; box: unknown; fully_visible: unknown }[]).map((l) => [l.text, l.box, l.fully_visible])).slice(0, 400));
    } catch (e) { console.log(id, v, "ERR", (e as Error).message.slice(0, 80)); }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
