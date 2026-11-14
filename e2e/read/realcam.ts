// Scores a real-camera session with the printed synthetic kit (docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md),
// with the same rules as the 31-case plan (score.ts).
//
//   node --experimental-strip-types --conditions=react-server e2e/read/realcam.ts <session-dir> [e2e/read/out/kit/kit.json]
//
// <session-dir>/labels.csv, filled in by the operator, one row per reading:
//   id,case,device,condition,hidden
//   2026-11-20T10-31-02-123Z,M01,pixel6a,lamp-glare,strength
//   M01_pixel6a_dim,M01,pixel6a,dim,
// "id" is either a capture saved by the app (READ_CAPTURE_DIR: <id>.json, <id>_a.jpg, <id>_b.jpg; scored
// from what the app actually said, no new request), or a pair of photos from the phone's camera app
// (<id>_a.jpg and <id>_b.jpg, read now through the server's code, real Gemini quota).
// "hidden" lists what the operator physically hid or cut off in that picture (name, strength, expiry),
// separated by "|": anything of it said counts as CRITICAL.
// Writes <session-dir>/results.json and summary.md.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SceneAnalysis } from "../../src/lib/assistant/types.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { check } = await import("./score.ts");
import type { Case } from "./score.ts";

const dir = process.argv[2];
if (!dir) throw new Error("usage: realcam.ts <session-dir> [kit.json]");
const kit = JSON.parse(readFileSync(process.argv[3] ?? "e2e/read/out/kit/kit.json", "utf8")) as Case[];
const rows = readFileSync(join(dir, "labels.csv"), "utf8").split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
  const [id, cs, device, condition, hidden = ""] = l.split(",").map((x) => x.trim());
  return { id, case: cs, device, condition, hidden: hidden.split("|").filter(Boolean) as ("name" | "strength" | "expiry")[] };
});

type Analyze = (req: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{ ok: boolean; analysis?: SceneAnalysis }>;
let analyzeImage: Analyze | null = null;
const results: unknown[] = [];
const groups = new Map<string, { n: number; critical: number; read: number; expected: number; failed: number }>();
for (const r of rows) {
  const base = kit.find((c) => c.id === r.case);
  if (!base) {
    console.log(`SKIP ${r.id}: unknown case ${r.case}`);
    continue;
  }
  // What the operator hid can't be read in this picture: saying it is critical.
  const truth: Case = JSON.parse(JSON.stringify(base));
  for (const f of r.hidden) {
    const v = truth.fields[f];
    if (v) truth.must_not_say.push(v);
    truth.fields[f] = null;
    truth.visible = truth.visible.filter((l) => !v || !l.includes(v));
  }
  let analysis: SceneAnalysis | undefined;
  if (existsSync(join(dir, `${r.id}.json`))) {
    analysis = JSON.parse(readFileSync(join(dir, `${r.id}.json`), "utf8")).analysis;
  } else {
    analyzeImage ??= (await import("../../src/lib/ai/vision.ts")).analyzeImage as unknown as Analyze;
    const img = (v: string) => readFileSync(join(dir, `${r.id}_${v}.jpg`)).toString("base64");
    const res = await analyzeImage({ mode: "read", cameraFacing: "outward", lang: "tn", image: img("a"), secondImage: img("b") }, {});
    analysis = res.ok ? res.analysis : undefined;
    await new Promise((s) => setTimeout(s, 2500));
  }
  const key = `${r.device} / ${r.condition}`;
  const g = groups.get(key) ?? { n: 0, critical: 0, read: 0, expected: 0, failed: 0 };
  groups.set(key, g);
  if (!analysis?.document) {
    g.failed++;
    console.log(`ERR  ${r.id}: no reading`);
    continue;
  }
  const { critical, expected, read } = check(truth, analysis, "tn");
  g.n++;
  g.critical += critical.length ? 1 : 0;
  g.read += read;
  g.expected += expected;
  console.log(`${critical.length ? "CRIT" : "ok  "} ${r.id} ${r.case} ${key} read ${read}/${expected}${critical.length ? `: ${critical.join("; ")}` : ""}`);
  results.push({ ...r, critical, read, expected, spoken: analysis.spoken, checks: analysis.document.checks ?? [] });
}
const table = ["| Device and condition | Readings | With a critical error | Facts read / readable | No reading |", "|---|---|---|---|---|",
  ...[...groups].sort().map(([k, g]) => `| ${k} | ${g.n} | ${g.critical} | ${g.read}/${g.expected} | ${g.failed} |`)].join("\n");
writeFileSync(join(dir, "results.json"), JSON.stringify(results, null, 1));
writeFileSync(join(dir, "summary.md"), `${table}\n`);
console.log(`\n${table}`);
process.exitCode = [...groups.values()].some((g) => g.critical) ? 1 : 0;
