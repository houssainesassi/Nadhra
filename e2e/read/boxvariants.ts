// Box accuracy experiment: for each model and prompt variant, the share of lines on clean documents
// whose box passes the pixel check (a misplaced box fails it). Real Gemini, ~30 calls.
//   node --experimental-strip-types --conditions=react-server e2e/read/boxvariants.ts e2e/read/out/plan P01,P03,P08,M01,M16
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import jpeg from "jpeg-js";
for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { getVisionProviders } = await import("../../src/lib/ai/vision.ts");
const { readSystemPrompt, buildReadText } = await import("../../src/lib/assistant/prompts.ts");
const { parseModelJson } = await import("../../src/lib/assistant/schema.ts");
const { inspectLine, toGray } = await import("../../src/lib/assistant/lineCheck.ts");

const base = readSystemPrompt("tn");
const VARIANTS: Record<string, (p: string) => string> = {
  current: (p) => p,
  box_2d: (p) => p.replaceAll('"box"', '"box_2d"').replace('"box": [ymin, xmin, ymax, xmax]', '"box_2d": [ymin, xmin, ymax, xmax]'),
  box_2d_first: (p) => p.replaceAll('"box"', '"box_2d"').replace('{"text": "exactly as printed", "confidence": "confirmed|likely|uncertain", "fully_visible": true, "box": [ymin, xmin, ymax, xmax]}', '{"box_2d": [ymin, xmin, ymax, xmax], "text": "exactly as printed", "confidence": "confirmed|likely|uncertain", "fully_visible": true}'),
};
const dir = process.argv[2];
const ids = process.argv[3].split(",");
const models = getVisionProviders().filter((p) => p.family === "gemini").slice(0, 2);
for (const [name, v] of Object.entries(VARIANTS)) {
  for (const p of models) {
    let pass = 0, total = 0, nested = 0;
    for (const id of ids) {
      const buf = readFileSync(join(dir, `${id}_a.jpg`));
      const d = jpeg.decode(buf, { useTArray: true });
      const g = toGray(d.data, d.width, d.height);
      let raw: Record<string, unknown> | null = null;
      for (let i = 0; i < 3 && !raw; i++) {
        try {
          const c = new AbortController(); setTimeout(() => c.abort(), 30_000);
          raw = parseModelJson(await p.analyze({ system: v(base), text: buildReadText({ hasImage: true, now: new Date() }), images: [buf.toString("base64")], maxTokens: 4000, signal: c.signal, temperature: 0 }));
        } catch { await new Promise((r) => setTimeout(r, 4000)); }
      }
      if (!raw) continue;
      for (const l of (raw.lines as Record<string, unknown>[]) ?? []) {
        const box = l.box_2d ?? l.box;
        if (Array.isArray(box) && Array.isArray(box[0])) nested++;
        total++;
        if (!inspectLine(g, box, String(l.text))) pass++;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(`${name.padEnd(13)} ${p.model.padEnd(22)} lines passing ${pass}/${total} (${Math.round((100 * pass) / Math.max(1, total))}%), nested boxes ${nested}`);
  }
}
