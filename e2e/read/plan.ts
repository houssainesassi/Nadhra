// The 30-case document test plan (docs/PHASE1_REAL_WORLD_TEST_PLAN.md) against the real model,
// through the server's reading code with its double reading (analyzeImage, mode "read", two frames).
//
//   python3 e2e/read/make_plan_set.py e2e/read/out/plan
//   RUNS=3 node --experimental-strip-types --conditions=react-server e2e/read/plan.ts e2e/read/out/plan [M01,P02]
//
// Uses GEMINI_API_KEY from .env.local and real free-tier quota (two model calls per reading). The
// documents are rendered mock documents with invented names: no real patient data is sent.
//
// A CRITICAL result is anything a blind user could be misled by:
//   - a number spoken as read from the paper that a person can't see on it (invented or misread),
//   - a medicine name, strength or expiry that differs from the paper, or that is hidden on it,
//   - an expiry status ("passed", "not passed") that is wrong, or said for an ambiguous or hidden date,
//   - text the case marks as never to be said (hidden digits, a covered name),
//   - a dose in the assistant's own words, or an AI explanation of a medical paper.
// Facts held back ("withheld") are counted too: too much caution makes the reader useless.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SceneAnalysis, VisionRequestBody } from "../../src/lib/assistant/types.ts";
import type { SpeechLang } from "../../src/lib/assistant/lang.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { analyzeImage } = await import("../../src/lib/ai/vision.ts");
const { speech } = await import("../../src/lib/assistant/phrases.ts");
/** Every fixed sentence of the app, in every language: its own templates are not model output. */
const { documentContext, grounded, normForMatch } = await import("../../src/lib/assistant/document.ts");
const { check, checkAnswer } = await import("./score.ts");
import type { Case } from "./score.ts";
const dir = process.argv[2] ?? "e2e/read/out/plan";
const only = process.argv[3]?.split(",");
const RUNS = Number(process.env.RUNS ?? 3);
const NOW = new Date("2026-11-13T10:00:00+01:00");
const cases = (JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")) as Case[]).filter((c) => !only || only.includes(c.id));
const img = (id: string, v: "a" | "b") => readFileSync(join(dir, `${id}_${v}.jpg`)).toString("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// RESCORE=1: score the saved results again (after a change to the scorer), without new requests.
if (process.env.RESCORE === "1") {
  const saved = JSON.parse(readFileSync("e2e/read/out/plan-results.json", "utf8")) as { id: string; run: number; analysis?: SceneAnalysis; answers?: { q: string; spoken: string }[] }[];
  let crit = 0, exp = 0, rd = 0;
  for (const r of saved) {
    const c = cases.find((x) => x.id === r.id);
    if (!c || !r.analysis) continue;
    const res = check(c, r.analysis, "tn");
    // Saved answers keep only their text, not which part was a quote: only these checks can be redone.
    for (const a of r.answers ?? []) {
      const q = c.questions.find((x) => x.q === a.q);
      if (!q) continue;
      for (const m of c.must_not_say) if (grounded(m, normForMatch(a.spoken))) res.critical.push(`answer: said «${m}»`);
      if (q.expect === "refusal" && !a.spoken.includes(speech(q.lang ?? "tn").doc.noAdvice)) res.critical.push("advice question not refused");
    }
    crit += res.critical.length; exp += res.expected; rd += res.read;
    if (res.critical.length) console.log(`CRIT ${r.id} run ${r.run}: ${res.critical.join("; ")}`);
  }
  console.log(`rescored: CRITICAL ${crit}, facts read ${rd}/${exp}`);
  process.exit(0);
}

const results: unknown[] = [];
let totalCritical = 0, totalExpected = 0, totalRead = 0, readings = 0, failures = 0;
const rows: string[] = [];
for (const c of cases) {
  let caseCritical = 0, caseExpected = 0, caseRead = 0;
  const notes = new Set<string>();
  for (let run = 1; run <= RUNS; run++) {
    const req: VisionRequestBody = { mode: "read", cameraFacing: "outward", lang: "tn", image: img(c.id, "a"), secondImage: img(c.id, "b") };
    const t0 = Date.now();
    const res = await analyzeImage(req, { now: NOW });
    const ms = Date.now() - t0;
    if (!res.ok) {
      failures++;
      results.push({ id: c.id, run, ok: false, attempts: res.attempts });
      console.log(`ERR  ${c.id} run ${run}: provider failure ${JSON.stringify(res.attempts.map((x) => x.error))}`);
      await sleep(5000);
      continue;
    }
    readings++;
    const { critical, expected, read } = check(c, res.analysis, "tn");
    const answers: { q: string; spoken: string; critical: string[] }[] = [];
    for (const q of c.questions) {
      await sleep(2500);
      const ctx = res.analysis.document ? documentContext(res.analysis.document) : undefined;
      const body: VisionRequestBody = q.mode === "question"
        ? { mode: "question", cameraFacing: "outward", lang: q.lang ?? "tn", image: img(c.id, "a"), question: q.q }
        : { mode: "read", cameraFacing: "outward", lang: q.lang ?? "tn", image: img(c.id, "a"), secondImage: img(c.id, "b"), question: q.q, ...(ctx?.lines.length ? { document: ctx } : {}) };
      const ans = await analyzeImage(body, { now: NOW });
      if (!ans.ok) { answers.push({ q: q.q, spoken: "(provider failure)", critical: [] }); continue; }
      const crit = checkAnswer(c, q, ans.analysis);
      answers.push({ q: q.q, spoken: ans.analysis.spoken, critical: crit });
      critical.push(...crit);
    }
    caseCritical += critical.length;
    caseExpected += expected;
    caseRead += read;
    if (res.analysis.document?.unconfirmed) notes.add("unconfirmed");
    if (res.analysis.document?.obscured?.length) notes.add(`obscured: ${res.analysis.document.obscured.join("/")}`);
    if (res.analysis.document?.rescan) notes.add("rescan");
    console.log(`${critical.length ? "CRIT" : "ok  "} ${c.id} run ${run} (${ms} ms) read ${read}/${expected}${critical.length ? `: ${critical.join("; ")}` : ""}`);
    console.log(`     said: ${res.analysis.spoken.slice(0, 400)}`);
    for (const a of answers) console.log(`     Q «${a.q}» → ${a.spoken.slice(0, 200)}`);
    results.push({ id: c.id, run, ms, critical, expected, read, analysis: res.analysis, answers, attempts: res.attempts });
    await sleep(2500);
  }
  totalCritical += caseCritical;
  totalExpected += caseExpected;
  totalRead += caseRead;
  rows.push(`| ${c.id} | ${c.title} | ${caseCritical} | ${caseRead}/${caseExpected} | ${[...notes].join(", ")} |`);
}

mkdirSync("e2e/read/out", { recursive: true });
writeFileSync("e2e/read/out/plan-results.json", JSON.stringify(results, null, 1));
const table = ["| Case | What | Critical | Facts read / readable | Notes |", "|---|---|---|---|---|", ...rows].join("\n");
// Provider failures are not reading errors, but a run with any of them is INCOMPLETE, never "passed".
const verdict = totalCritical ? "FAILED (critical reading errors)" : failures ? `INCOMPLETE (${failures} readings failed at the provider; not a pass)` : "COMPLETE, no critical reading error";
writeFileSync("e2e/read/out/plan-summary.md", `${table}\n\nReadings completed: ${readings}. Provider failures (no reading): ${failures}. Readings with a critical error: ${totalCritical}. Facts read: ${totalRead}/${totalExpected}.\n\n**${verdict}**\n`);
console.log(`\n${table}\n\nReadings ${readings}, provider failures ${failures}, CRITICAL ${totalCritical}, facts read ${totalRead}/${totalExpected}\n${verdict}`);
process.exitCode = totalCritical || failures ? 1 : 0;
