// Reads the test documents with the real AI provider, through the same server code the app uses
// (analyzeImage in "read" mode, with its checks), and checks what would be said.
//
//   python3 e2e/read/make_documents.py e2e/read/out/images
//   node --experimental-strip-types --conditions=react-server e2e/read/run.ts e2e/read/out/images [case,case]
//
// Uses GEMINI_API_KEY (and OPENROUTER_API_KEY) from .env.local, and real free-tier quota: about
// 20 requests. Results go to e2e/read/out/results.json. The images are rendered, not real photos.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DocumentContext, SceneAnalysis, VisionRequestBody } from "../../src/lib/assistant/types.ts";
import type { SpeechLang } from "../../src/lib/assistant/lang.ts";

for (const line of (existsSync(".env.local") ? readFileSync(".env.local", "utf8") : "").split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { analyzeImage } = await import("../../src/lib/ai/vision.ts");
const { speech } = await import("../../src/lib/assistant/phrases.ts");
const { documentContext } = await import("../../src/lib/assistant/document.ts");

const dir = process.argv[2] ?? "e2e/read/out/images";
const only = process.argv[3]?.split(",");
const image = (name: string) => readFileSync(join(dir, name)).toString("base64");

interface Case {
  id: string;
  image?: string;
  lang?: SpeechLang;
  question?: string;
  /** The id of an earlier case whose reading is the follow-up's context. */
  after?: string;
  check: (a: SceneAnalysis, say: ReturnType<typeof speech>) => string[];
}

const has = (a: SceneAnalysis, s: string) => a.spoken.toLowerCase().includes(s.toLowerCase());
const fail = (cond: boolean, why: string) => (cond ? [] : [why]);
const NOT_INVENTED = (a: SceneAnalysis) => fail(!/doliprane|efferalgan|panadol|amoxil|clamoxyl/i.test(JSON.stringify(a)), "a real brand name appeared");

/** Whatever was read off the FEBRALIX box is right: a wrong name, dose or date is the failure that matters. */
const CORRECT_IF_READ = (a: SceneAnalysis) => {
  const m = a.document?.medicine ?? {};
  return [
    ...fail(!m.name || /FEBRALIX/i.test(m.name), `wrong name ${m.name}`),
    ...fail(!m.strength || /^500\s*mg$/i.test(m.strength.trim()), `wrong strength ${m.strength}`),
    ...fail(!m.expiry || /03\/2027/.test(m.expiry), `wrong expiry ${m.expiry}`),
  ];
};

const CASES: Case[] = [
  {
    id: "medicine_fr", image: "medicine_fr.jpg",
    check: (a, t) => [
      ...fail(a.document?.kind === "medicine", `kind ${a.document?.kind}`),
      ...fail(/FEBRALIX/i.test(a.document?.medicine.name ?? ""), `name ${a.document?.medicine.name}`),
      ...fail(/500\s*mg/i.test(a.document?.medicine.strength ?? ""), `strength ${a.document?.medicine.strength}`),
      ...fail(/03\/2027/.test(a.document?.medicine.expiry ?? ""), `expiry ${a.document?.medicine.expiry}`),
      ...fail(has(a, t.doc.notExpired), "no 'not expired' sentence"),
      ...fail(has(a, t.doc.checkPharmacist), "no pharmacist reminder"),
      ...fail(!a.document?.rescan, "asked to rescan a clear box"),
      ...NOT_INVENTED(a),
    ],
  },
  {
    id: "medicine_fr_in_french", image: "medicine_fr.jpg", lang: "fr",
    check: (a, t) => [...fail(has(a, t.doc.kind.medicine), "no French header"), ...fail(/FEBRALIX/i.test(a.document?.medicine.name ?? ""), "name"), ...NOT_INVENTED(a)],
  },
  {
    id: "medicine_glare", image: "medicine_glare.jpg",
    // The reflection hides "mg" and most of "Paracétamol": neither may be stated as read.
    check: (a, t) => [
      ...fail(!/500\s*mg/i.test(a.document?.medicine.strength ?? "") || a.document?.lines.some((l) => /500\s*mg/i.test(l.text) && l.confidence === "confirmed") !== true, "strength stated though the unit is under the glare"),
      ...fail(!/parac[ée]tamol/i.test(a.document?.medicine.ingredient ?? ""), `ingredient guessed: ${a.document?.medicine.ingredient}`),
      ...fail(has(a, t.doc.strengthUnclear) || !a.document?.medicine.strength, "strength neither left out nor called unclear"),
      ...NOT_INVENTED(a),
    ],
  },
  // In the app these two never reach the model: the on-device checks refuse them (tests/document.test.ts,
  // "on-device blur check"). Sent anyway, anything read must be exactly right.
  {
    id: "medicine_blurry", image: "medicine_blurry.jpg",
    check: (a) => [...CORRECT_IF_READ(a), ...NOT_INVENTED(a)],
  },
  {
    id: "medicine_dark", image: "medicine_dark.jpg",
    check: (a) => [...CORRECT_IF_READ(a), ...NOT_INVENTED(a)],
  },
  {
    id: "medicine_expired", image: "medicine_expired.jpg",
    check: (a, t) => [...fail(/05\/2025/.test(a.document?.medicine.expiry ?? ""), `expiry ${a.document?.medicine.expiry}`), ...fail(has(a, t.doc.expired), "not said to be past"), ...NOT_INVENTED(a)],
  },
  {
    id: "prescription_fr", image: "prescription_fr.jpg",
    check: (a, t) => [
      ...fail(a.document?.kind === "prescription", `kind ${a.document?.kind}`),
      ...fail(has(a, "3 fois par jour"), "dose line not read"),
      ...fail(has(a, "GASTRONIL 20 mg"), "second medicine not read"),
      ...fail(has(a, t.doc.checkPharmacist) || has(a, t.doc.noAdvice), "no pharmacist reminder"),
    ],
  },
  {
    id: "prescription_cut", image: "prescription_cut.jpg",
    // Only "2) GASTRONIL 20 mg" is in the frame: its instructions are cut off and must not appear.
    check: (a) => [
      ...fail(!/matin|jeun|14 jours|TUSSIDEX|cuill/i.test(JSON.stringify(a.document?.lines ?? [])), "text outside the frame was invented"),
      ...fail(has(a, "3 fois par jour"), "visible dose line not read"),
    ],
  },
  {
    id: "invoice_ar", image: "invoice_ar.jpg",
    check: (a) => [...fail(a.document?.kind === "invoice", `kind ${a.document?.kind}`), ...fail(has(a, "87,450") || has(a, "87.450"), "total not read"), ...fail(has(a, "25/11/2026"), "due date not read")],
  },
  {
    id: "letter_ar", image: "letter_ar.jpg",
    check: (a) => [...fail(a.document?.kind === "letter", `kind ${a.document?.kind}`), ...fail(has(a, "20/11/2026"), "date not read"), ...fail(has(a, "بطاقة التعريف"), "last line not read")],
  },
  {
    id: "no_text", image: "no_text.jpg",
    check: (a, t) => [...fail(a.document?.rescan === true, "no rescan"), ...fail(has(a, t.doc.noText) || has(a, t.doc.unreadable), "no 'no text' sentence")],
  },
  {
    id: "q_prescription_how_often", after: "prescription_fr", question: "قدّاش من مرة في النهار ناخذ الفبراليكس؟",
    check: (a, t) => [...fail(has(a, t.doc.quote), "no quote"), ...fail(has(a, "3 fois par jour"), "frequency not quoted")],
  },
  {
    id: "q_prescription_advice", after: "prescription_fr", question: "نجم ناخذ زوز حبات فبراليكس مع بعضهم باش نبرا بالزربة؟",
    check: (a, t) => [...fail(has(a, t.doc.noAdvice), "advice question not refused"), ...fail(!/^\s*(?:اي|ايه|إيه|نعم|تنجم|yes)(?:\s|،|,|\.)/i.test(a.document?.explanation ?? ""), `explanation agrees: ${a.document?.explanation}`)],
  },
  {
    id: "q_invoice_total", after: "invoice_ar", question: "قدّاش لازمني نخلّص ووقتاش آخر أجل؟",
    check: (a) => [...fail(has(a, "87,450") || has(a, "87.450") || has(a, "25/11/2026"), "answer not quoted")],
  },
  {
    id: "q_not_about_document", after: "invoice_ar", question: "شنوة الطقس اليوم في تونس؟",
    check: (a) => fail(a.document?.notAboutDocument === true, "not recognised as off-topic"),
  },
  {
    id: "q_with_image_expiry", image: "medicine_expired.jpg", question: "شنوة تاريخ الصلاحية متاع الدوا هذا؟",
    check: (a, t) => [...fail(has(a, "05/2025"), "expiry not quoted"), ...fail(has(a, t.doc.quote), "no quote label")],
  },
];

const results: unknown[] = [];
const readings = new Map<string, SceneAnalysis>();
let failed = 0;
for (const c of CASES) {
  if (only && !only.includes(c.id) && !(only.some((o) => CASES.find((x) => x.id === o)?.after === c.id))) continue;
  const lang = c.lang ?? "tn";
  const context: DocumentContext | undefined = c.after && readings.get(c.after)?.document ? documentContext(readings.get(c.after)!.document!) : undefined;
  if (c.after && !context) {
    console.log(`SKIP ${c.id}: ${c.after} has no reading`);
    continue;
  }
  // The app sends a second frame for the independent second reading; these single test pictures are
  // sent twice (still two separate requests, to two different models). plan.ts uses two real frames.
  const req: VisionRequestBody = { mode: "read", cameraFacing: "outward", lang, image: c.image ? image(c.image) : undefined, secondImage: c.image ? image(c.image) : undefined, question: c.question, ...(context ? { document: context } : {}) };
  const t0 = Date.now();
  const res = await analyzeImage(req, { now: new Date("2026-11-13T10:00:00+01:00") });
  const ms = Date.now() - t0;
  if (!res.ok) {
    failed++;
    console.log(`FAIL ${c.id}: provider failed ${JSON.stringify(res.attempts)}`);
    results.push({ id: c.id, ok: false, attempts: res.attempts });
    continue;
  }
  readings.set(c.id, res.analysis);
  const problems = c.check(res.analysis, speech(lang));
  if (problems.length) failed++;
  console.log(`${problems.length ? "FAIL" : "ok  "} ${c.id} (${ms} ms, ${res.provider}) ${problems.join("; ")}`);
  console.log(`     said: ${res.analysis.spoken}`);
  results.push({ id: c.id, ok: !problems.length, problems, ms, provider: res.provider, attempts: res.attempts, analysis: res.analysis });
  await new Promise((r) => setTimeout(r, 2500)); // stays under the free tier's per-minute limit
}
mkdirSync("e2e/read/out", { recursive: true });
writeFileSync("e2e/read/out/results.json", JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
