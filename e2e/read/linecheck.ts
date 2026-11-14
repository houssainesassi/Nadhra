// Calibration helper: runs the pixel check of printed lines (src/lib/assistant/lineCheck.ts) on the
// boxes saved by e2e/read/boxes.ts. node --experimental-strip-types e2e/read/linecheck.ts
import { readFileSync, readdirSync } from "node:fs";
import jpeg from "jpeg-js";
import { inspectLine, toGray } from "../../src/lib/assistant/lineCheck.ts";
const dir = "e2e/read/out";
for (const f of readdirSync(`${dir}/boxes`).sort()) {
  const id = f.replace(".json", "");
  const t0 = Date.now();
  const d = jpeg.decode(readFileSync(`${dir}/plan/${id}.jpg`), { useTArray: true });
  const img = toGray(d.data, d.width, d.height);
  const ms = Date.now() - t0;
  const raw = JSON.parse(readFileSync(`${dir}/boxes/${f}`, "utf8"));
  const out = (raw.lines as { text: string; box: unknown }[]).map((l) => `${l.text.slice(0, 18)}=${inspectLine(img, l.box, l.text) ?? "ok"}`);
  console.log(id.padEnd(7), `${ms}ms`, out.join(" | "));
}
