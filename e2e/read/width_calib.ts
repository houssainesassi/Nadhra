// Calibrates the "ink width per character" check (lineCheck.ts) on lines that pass the pixel check
// in e2e/read/out/diag/*.json: how wide is printed text per claimed character, in line heights?
import { readFileSync, readdirSync } from "node:fs";
import jpeg from "jpeg-js";
import { inkWidthPerChar, inspectLine, toGray } from "../../src/lib/assistant/lineCheck.ts";
const vals: number[] = [];
const rows: string[] = [];
for (const f of readdirSync("e2e/read/out/diag").filter((x) => x.endsWith(".json"))) {
  const d = JSON.parse(readFileSync(`e2e/read/out/diag/${f}`, "utf8"));
  for (const [key, frame] of [["first", "a"], ["second", "b"]] as const) {
    const buf = readFileSync(`e2e/read/out/plan/${d.id}_${frame}.jpg`);
    const dec = jpeg.decode(buf, { useTArray: true });
    const g = toGray(dec.data, dec.width, dec.height);
    for (const l of d[key].lines ?? []) {
      if (inspectLine(g, l.box, l.text)) continue;
      const w = inkWidthPerChar(g, l.box, l.text);
      if (w == null) continue;
      vals.push(w);
      rows.push(`${w.toFixed(2)} ${d.id} ${key} ${l.text}`);
    }
  }
}
vals.sort((a, b) => a - b);
const q = (p: number) => vals[Math.floor(p * (vals.length - 1))].toFixed(2);
console.log(`n=${vals.length} min=${q(0)} p1=${q(0.01)} p5=${q(0.05)} median=${q(0.5)} p95=${q(0.95)} p99=${q(0.99)} max=${q(1)}`);
console.log(rows.sort().slice(0, 6).join("\n"));
console.log("...");
console.log(rows.sort().slice(-6).join("\n"));
