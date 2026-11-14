// Scores bench/ocr/run_ocr.py results against the ground truth of the 31-case reading set, or of a
// real-photo session with the printed kit (LABELS=..., see below).
//
//   node --experimental-strip-types --conditions=react-server bench/ocr/score.ts PLAN.json OUT_DIR engine1 engine2 ...
//   LABELS=<session>/labels.csv node ... bench/ocr/score.ts e2e/read/out/kit/kit.json OUT_DIR engine1 ...
//
// Text is compared after the app's own normForMatch (document.ts): the same letter, digit and spacing
// rules the reading checks use. Per visible line (plan.json "visible"):
//   exact        an OCR line equal to it;
//   contained    it appears, as whole words, inside an OCR line (two printed lines merged into one);
//   CER          character error rate against the closest OCR line (edit distance / length);
//   number error the closest OCR line (CER <= 0.5) has different numbers: the dangerous case
//                («50 mg» for «500 mg», a wrong lot or date). Missing numbers count as errors too.
// Also: text that must never be read (hidden by a finger, glare or the frame edge) found in the OCR
// output, both frames read the same (what the two-readings rule would need), and speed and memory.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normForMatch } from "../../src/lib/assistant/document.ts";

type Case = { id: string; title: string; kind: string; visible: string[]; must_not_say?: string[] };
type Run = { engine: string; load_ms: number; peak_rss_mb: number; cpu_s: number; model_mb: number; results: { image: string; lines: string[]; ms: number; warmup: boolean }[] };

const [planPath, outDir, ...engines] = process.argv.slice(2);
type KitCase = Case & { fields?: Record<string, string> };
const cases: KitCase[] = JSON.parse(readFileSync(planPath, "utf8"));
// Real photographs (docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md): LABELS=<session>/labels.csv maps each
// photo pair <id>_a.jpg / <id>_b.jpg to a kit case (PLAN.json is then the kit's kit.json). What the
// operator hid ("hidden": name|strength|expiry) is no longer a visible line, and reading it counts as
// hidden text read.
const plan: Case[] = process.env.LABELS
  ? readFileSync(process.env.LABELS, "utf8").split("\n").slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [id, caseId, device = "", condition = "", hidden = ""] = l.split(",");
      const c = cases.find((k) => k.id === caseId);
      if (!c) throw new Error(`labels: unknown case ${caseId}`);
      const gone = hidden.split("|").map((h) => c.fields?.[h.trim()]).filter((v): v is string => !!v);
      const covered = (v: string) => gone.some((g) => normForMatch(v).includes(normForMatch(g)));
      return { ...c, id, title: `${c.id} ${device} ${condition}`.trim(), visible: c.visible.filter((v) => !covered(v)), must_not_say: [...(c.must_not_say ?? []), ...gone] };
    })
  : cases;
const norm = (s: string) => normForMatch(s).trim();
const isArabic = (s: string) => /[؀-ۿ]/.test(s);
const numbers = (s: string) => norm(s).match(/\d+(?:[.\/]\d+)*/g) ?? [];

function editDistance(a: string, b: string): number {
  const x = [...a], y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[y.length];
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)} %` : "–");
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const p90 = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] : 0; };

const summary: Record<string, unknown>[] = [];
const md: string[] = ["# Offline OCR benchmark", "", `Inputs: ${plan.length} cases × 2 frames from \`${planPath}\` (rendered mock documents, invented names). Same images for every engine.`, ""];
const details: string[] = [];

for (const engine of engines) {
  const run: Run = JSON.parse(readFileSync(join(outDir, `${engine}.json`), "utf8"));
  const byImage = new Map(run.results.map((r) => [r.image, r.lines.map(norm).filter(Boolean)]));
  const t = { visible: 0, exact: 0, contained: 0, cerSum: 0, numLines: 0, numOk: 0, numWrong: 0, numMissing: 0, leaks: 0, ar: { visible: 0, exact: 0, cer: 0 }, la: { visible: 0, exact: 0, cer: 0 }, bothFrames: 0, bothFramesOf: 0 };
  const wrong: string[] = [];
  const perCase: string[] = [];
  for (const c of plan) {
    let caseExact = 0, caseVisible = 0, caseWrong = 0;
    const exactIn: Record<string, Set<string>> = { a: new Set(), b: new Set() };
    for (const frame of ["a", "b"] as const) {
      const lines = byImage.get(`${c.id}_${frame}.jpg`);
      if (!lines) continue;
      const all = ` ${lines.join(" \n ")} `;
      for (const v of c.visible) {
        const nv = norm(v);
        if (!nv) continue;
        const script = isArabic(v) ? t.ar : t.la;
        t.visible++; script.visible++; caseVisible++;
        const exact = lines.includes(nv);
        if (exact) { t.exact++; script.exact++; caseExact++; exactIn[frame].add(nv); }
        if (exact || lines.some((l) => ` ${l} `.includes(` ${nv} `))) t.contained++;
        let best = Infinity, bestLine = "";
        for (const l of lines) { const d = editDistance(nv, l) / nv.length; if (d < best) { best = d; bestLine = l; } }
        const cer = Math.min(1, best);
        t.cerSum += cer; script.cer += cer;
        const want = numbers(v);
        if (want.length) {
          t.numLines++;
          // The closest OCR line is another line printed on this paper: this one wasn't read at all.
          const another = c.visible.some((o) => o !== v && norm(o) === bestLine);
          if (best > 0.5 || another) t.numMissing++;
          else if (JSON.stringify(numbers(bestLine)) === JSON.stringify(want)) t.numOk++;
          else { t.numWrong++; caseWrong++; wrong.push(`${c.id}_${frame}: «${v}» read as «${bestLine}»`); }
        }
      }
      for (const m of c.must_not_say ?? []) {
        const nm = norm(m);
        if (nm && all.includes(` ${nm} `)) { t.leaks++; wrong.push(`${c.id}_${frame}: hidden text «${m}» read`); }
      }
    }
    for (const v of exactIn.a) if (exactIn.b.has(v)) t.bothFrames++;
    t.bothFramesOf += c.visible.filter((v) => norm(v)).length;
    perCase.push(`| ${c.id} | ${c.title} | ${caseExact}/${caseVisible} | ${caseWrong} |`);
  }
  const times = run.results.filter((r) => !r.warmup).map((r) => r.ms);
  const row = {
    engine,
    visible: t.visible,
    exact: pct(t.exact, t.visible),
    contained: pct(t.contained, t.visible),
    meanCer: (t.cerSum / t.visible).toFixed(3),
    arabicExact: pct(t.ar.exact, t.ar.visible),
    arabicCer: (t.ar.cer / (t.ar.visible || 1)).toFixed(3),
    latinExact: pct(t.la.exact, t.la.visible),
    latinCer: (t.la.cer / (t.la.visible || 1)).toFixed(3),
    numberLines: t.numLines,
    numbersRight: pct(t.numOk, t.numLines),
    numbersWrong: t.numWrong,
    numbersMissing: t.numMissing,
    hiddenTextRead: t.leaks,
    sameInBothFrames: pct(t.bothFrames, t.bothFramesOf),
    medianMs: Math.round(median(times)),
    p90Ms: Math.round(p90(times)),
    loadMs: run.load_ms,
    peakRssMb: run.peak_rss_mb,
    cpuS: run.cpu_s,
    modelMb: run.model_mb,
  };
  summary.push(row);
  details.push(`## ${engine}`, "", "| Case | Title | Exact lines (both frames) | Number errors |", "|---|---|---|---|", ...perCase, "", "Number errors and hidden text read:", "", ...(wrong.length ? wrong.map((w) => `- ${w}`) : ["- none"]), "");
}

const cols: [string, string][] = [
  ["engine", "Engine"], ["exact", "Lines exact"], ["contained", "Lines found (incl. merged)"], ["meanCer", "Mean CER"],
  ["arabicExact", "Arabic exact"], ["arabicCer", "Arabic CER"], ["latinExact", "Latin exact"], ["latinCer", "Latin CER"],
  ["numbersRight", "Numbered lines right"], ["numbersWrong", "Number errors"], ["numbersMissing", "Numbered lines not found"], ["hiddenTextRead", "Hidden text read"],
  ["sameInBothFrames", "Same in both frames"], ["medianMs", "Median ms/image"], ["p90Ms", "p90 ms"], ["loadMs", "Load ms"], ["peakRssMb", "Peak RSS MB"], ["cpuS", "CPU s (62 images)"], ["modelMb", "Model MB"],
];
md.push(`| ${cols.map((c) => c[1]).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
for (const r of summary) md.push(`| ${cols.map(([k]) => String(r[k])).join(" | ")} |`);
// The two-readings rule with OCR engines as the readers: engine A reads frame A, engine B frame B (as the
// app does with two models), and only lines both give word for word would pass to the next checks.
// "Wrong" = agreed lines that are not a printed visible line. Not a substitute for the pixel check.
if (process.env.PAIRS) {
  md.push("## Agreement of two readers (engine A on frame A, engine B on frame B)", "", "| Readers | Agreed lines | Correct | Wrong | Wrong with a number | Coverage of visible lines |", "|---|---|---|---|---|---|");
  const load = (e: string) => new Map((JSON.parse(readFileSync(join(outDir, `${e}.json`), "utf8")) as Run).results.map((r) => [r.image, r.lines.map(norm).filter(Boolean)]));
  for (const pair of process.env.PAIRS.split(";")) {
    const [ea, eb] = pair.split(",");
    const A = load(ea), B = load(eb);
    let agreed = 0, correct = 0, wrongN = 0, wrongNum = 0, visible = 0;
    const wrongList: string[] = [];
    for (const c of plan) {
      const vis = new Set(c.visible.map(norm).filter(Boolean));
      visible += vis.size;
      const la = new Set(A.get(`${c.id}_a.jpg`) ?? []), lb = new Set(B.get(`${c.id}_b.jpg`) ?? []);
      for (const l of la) {
        if (!lb.has(l)) continue;
        agreed++;
        if (vis.has(l)) correct++;
        else { wrongN++; if (/\d/.test(l)) wrongNum++; wrongList.push(`${c.id}: «${l}»`); }
      }
    }
    md.push(`| ${ea} + ${eb} | ${agreed} | ${correct} | ${wrongN} | ${wrongNum} | ${pct(correct, visible)} |`);
    if (wrongList.length) details.push(`Agreed but not a printed line (${ea} + ${eb}): ${wrongList.join(", ")}`, "");
  }
  md.push("");
}
md.push("", ...details);
writeFileSync(join(outDir, "ocr-summary.md"), md.join("\n"));
writeFileSync(join(outDir, "ocr-summary.json"), JSON.stringify(summary, null, 1));
console.log(md.slice(0, 6 + summary.length).join("\n"));
