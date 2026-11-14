// Line-level measurements of a saved plan run, with no new requests:
//
//   node --experimental-strip-types --conditions=react-server e2e/read/lines.ts [results.json] [plan.json]
//
// For each reading, the reader's per-line verdicts (document.checks) are compared with the lines
// printed and visible on the paper (plan.json "visible"):
//   - correct:   a line the reader confirmed ("ok") that is word for word a visible line;
//   - incorrect: a line the reader confirmed that is not on the paper as written;
//   - withheld:  a visible line the reader did not confirm (held back by its checks, or never seen).
// Coverage = correct / visible lines.
//
// Provider failures are kept out of all three counts:
//   - "failed": no reading at all (every model call failed);
//   - "second missing": the first reading came back but the confirming reading failed at the
//     provider, so every line was held back ("no-second-reading"). Not a reading error.
// "fallback" marks a reading whose two readings came from the same model (the first model was
// busy): it is measured, but its two readings are less independent than designed.
// Also checked: every spoken document segment must be found on the paper.
import { readFileSync, writeFileSync } from "node:fs";
const { normForMatch, grounded } = await import("../../src/lib/assistant/document.ts");

type Check = { text: string; verdict: string };
type Seg = { text: string; source: string };
type Saved = { id: string; run: number; ms: number; critical: string[]; analysis?: { document?: { checks: Check[]; segments: Seg[] } }; attempts: { provider: string; ok: boolean; error?: string }[] };
type Case = { id: string; visible: string[] };

const results = JSON.parse(readFileSync(process.argv[2] ?? "e2e/read/out/plan-results.json", "utf8")) as Saved[];
const cases = new Map((JSON.parse(readFileSync(process.argv[3] ?? "e2e/read/out/plan/plan.json", "utf8")) as Case[]).map((c) => [c.id, c]));
const clean = (t: string) => normForMatch(t).trim();

const tot = { readings: 0, failed: 0, secondMissing: 0, measured: 0, fallback: 0, visible: 0, correct: 0, incorrect: 0, withheld: 0, spokenSegments: 0, spokenNotOnPaper: 0, critical: 0 };
const withheldWhy = new Map<string, number>();
const incorrect: string[] = [];
const spokenBad: string[] = [];
const perCase = new Map<string, { measured: number; visible: number; correct: number; incorrect: number; withheld: number; provider: number; critical: number }>();
const ms: number[] = [];

for (const r of results) {
  const c = cases.get(r.id);
  if (!c) continue;
  tot.readings++;
  const pc = perCase.get(r.id) ?? { measured: 0, visible: 0, correct: 0, incorrect: 0, withheld: 0, provider: 0, critical: 0 };
  perCase.set(r.id, pc);
  const doc = r.analysis?.document;
  if (!r.analysis) { tot.failed++; pc.provider++; continue; }
  tot.critical += r.critical.length; pc.critical += r.critical.length;
  if (doc?.checks.some((k) => k.verdict === "no-second-reading")) { tot.secondMissing++; pc.provider++; continue; }
  tot.measured++; pc.measured++; ms.push(r.ms);
  const okModels = r.attempts.filter((a) => a.ok).map((a) => a.provider);
  if (okModels.length >= 2 && okModels[0] === okModels[1]) tot.fallback++;
  const checks = doc?.checks ?? [];
  const visible = c.visible.map(clean);
  const confirmed = checks.filter((k) => k.verdict === "ok");
  for (const k of confirmed) if (!visible.includes(clean(k.text))) { tot.incorrect++; pc.incorrect++; incorrect.push(`${r.id} run ${r.run}: «${k.text}»`); }
  for (const v of c.visible) {
    tot.visible++; pc.visible++;
    if (confirmed.some((k) => clean(k.text) === clean(v))) { tot.correct++; pc.correct++; continue; }
    tot.withheld++; pc.withheld++;
    const seen = checks.find((k) => clean(k.text) === clean(v));
    const why = seen ? seen.verdict : checks.some((k) => grounded(k.text, clean(v)) || grounded(v, clean(k.text))) ? "read differently (partial or extra words)" : "not in the reading";
    withheldWhy.set(why, (withheldWhy.get(why) ?? 0) + 1);
  }
  const corpus = normForMatch(c.visible.join(" \n "));
  for (const s of doc?.segments ?? []) {
    if (s.source !== "document") continue;
    tot.spokenSegments++;
    if (!grounded(s.text.replace(/[.:]+$/, ""), corpus)) { tot.spokenNotOnPaper++; spokenBad.push(`${r.id} run ${r.run}: «${s.text}»`); }
  }
}

ms.sort((a, b) => a - b);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const complete = tot.failed === 0 && tot.secondMissing === 0;
const verdict = tot.critical ? "FAILED: critical reading errors" : complete ? "COMPLETE: no critical reading error" : `INCOMPLETE: ${tot.failed + tot.secondMissing} of ${tot.readings} readings hit a provider failure`;
const rows = [...perCase].map(([id, p]) => `| ${id} | ${p.measured} | ${p.correct}/${p.visible} | ${p.incorrect} | ${p.withheld} | ${p.provider} | ${p.critical} |`);
const out = [
  "| Case | Measured readings | Correct / visible lines | Incorrect | Withheld | Provider failures | Critical |",
  "|---|---|---|---|---|---|---|",
  ...rows,
  "",
  `Readings: ${tot.readings}. Provider failures: ${tot.failed} with no reading, ${tot.secondMissing} with the confirming reading missing (not counted as reading errors). Measured: ${tot.measured} (of which ${tot.fallback} with both readings from the same model).`,
  `Lines (measured readings): visible ${tot.visible}, correct ${tot.correct} (coverage ${pct(tot.correct, tot.visible)}), incorrect ${tot.incorrect}, withheld ${tot.withheld}.`,
  `Spoken document segments: ${tot.spokenSegments}, not found on the paper: ${tot.spokenNotOnPaper}.`,
  `Critical errors (plan.ts scorer): ${tot.critical}.`,
  `Latency of measured readings: median ${ms[Math.floor(ms.length / 2)] ?? "n/a"} ms, p90 ${ms[Math.floor(ms.length * 0.9)] ?? "n/a"} ms.`,
  "",
  "Withheld lines, by reason:",
  ...[...withheldWhy].sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v}`),
  "",
  "Confirmed lines not on the paper as written:",
  ...(incorrect.length ? incorrect.map((s) => `- ${s}`) : ["- none"]),
  "",
  "Spoken document segments not on the paper:",
  ...(spokenBad.length ? spokenBad.map((s) => `- ${s}`) : ["- none"]),
  "",
  `**${verdict}**`,
].join("\n");
writeFileSync("e2e/read/out/lines-summary.md", out + "\n");
console.log(out);
