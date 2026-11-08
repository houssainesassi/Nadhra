// The safety rules live in code, so they hold whatever the model writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { guardSpoken, isPathQuestion, parseModelJson, sanitizeAnalysis, swapSides } from "../src/lib/assistant/schema.ts";
import { SPEECH, warningPhrase } from "../src/lib/assistant/phrases.ts";
import { hazardUrgency, WarningGate } from "../src/lib/assistant/hazards.ts";
import type { Hazard } from "../src/lib/assistant/types.ts";

const scan = { mode: "scan", cameraFacing: "outward", hasMotionEvidence: true } as const;
const hazard = (p: Partial<Hazard>): Hazard => ({ kind: "obstacle", label: "", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown", ...p });

test("parseModelJson: accepts fences and surrounding text, throws without an object", () => {
  assert.deepEqual(parseModelJson('```json\n{"spoken":"x"}\n```'), { spoken: "x" });
  assert.deepEqual(parseModelJson('Here it is: {"a":1} done'), { a: 1 });
  assert.throws(() => parseModelJson("sorry, I can't"));
  assert.throws(() => parseModelJson("{broken"));
  assert.throws(() => parseModelJson("[1,2]"));
});

test("guardSpoken: removes safety promises in any wording", () => {
  for (const claim of ["الطريق آمن.", "الطريق فارغة.", "ما فمّاش خطر.", "تنجم تعدّي.", "الثنية محلولة.", "تنجم تقطع الشارع.", "The road is safe."]) {
    assert.equal(guardSpoken(`قدّامك باب. ${claim}`, []), "قدّامك باب.", claim);
  }
});

test("guardSpoken: does not catch innocent sentences", () => {
  for (const ok of ["قدّامك كرسي، تنجم تقعد عليه.", "الباب مفتوح.", "فمّا عباد قدّامنا.", "قدّامك باب على اليمين.", "ما شفتش حاجة، أما هذا ما يعنيش الطريق آمن."]) {
    assert.equal(guardSpoken(ok, []), ok);
  }
});

test("guardSpoken: removes measured distances, keeps text read from a sign", () => {
  assert.equal(guardSpoken("قدّامك باب. الكرهبة على بعد 3 متر.", []), "قدّامك باب.");
  assert.equal(guardSpoken("الحيط قدّامك بمترين.", []), "");
  assert.equal(guardSpoken("فمّا 5 خطوات وتوصل.", []), "");
  assert.equal(guardSpoken("الباب على خطوتين.", []), "");
  assert.equal(guardSpoken("بعيد ثلاثة أمتار.", []), "");
  assert.equal(guardSpoken("فمّا ٣ متر.", []), "");
  assert.equal(guardSpoken("فمّا مترو في الشارع.", []), "فمّا مترو في الشارع.", "the word for the metro isn't a distance");
  assert.equal(guardSpoken("مكتوب: تونس 3 km.", [{ content: "تونس 3 km", confidence: "confirmed" }]), "مكتوب: تونس 3 km.");
});

test("no second frame: motion claims are discarded", () => {
  const raw = { detections: [{ label: "شخص", category: "person", motion: "approaching", confidence: "likely" }], hazards: [{ kind: "person", label: "شخص", motion: "approaching", confidence: "likely" }] };
  const without = sanitizeAnalysis(raw, { ...scan, hasMotionEvidence: false });
  assert.equal(without.detections[0].motion, "unknown");
  assert.equal(without.hazards[0].motion, "unknown");
  assert.equal(sanitizeAnalysis(raw, scan).hazards[0].motion, "approaching");
});

test("garbage from the model becomes low confidence, never a confident claim", () => {
  const a = sanitizeAnalysis({ detections: [{ label: "x", side: "above", proximity: 3, confidence: "100%", motion: {} }, "nope", null], hazards: [{ kind: "lava", label: "x" }, { kind: "stairs" }], texts: "no" }, scan);
  assert.deepEqual(a.detections, [{ label: "x", category: "object", side: "unknown", proximity: "unknown", confidence: "uncertain", motion: "unknown", action: undefined }]);
  assert.equal(a.hazards.length, 1);
  assert.equal(a.hazards[0].confidence, "uncertain");
  assert.deepEqual(a.texts, []);
});

test("webcam facing the user: sides swap in the data and the sentence, but not in quoted text", () => {
  const raw = {
    spoken: "على يسارك طاولة. مكتوب: يمين.",
    hazards: [{ kind: "stairs", label: "درج", side: "left", proximity: "near", confidence: "confirmed" }],
    detections: [{ label: "طاولة", side: "right", confidence: "confirmed" }],
    texts: [{ content: "يمين", confidence: "confirmed" }],
  };
  const a = sanitizeAnalysis(raw, { ...scan, cameraFacing: "user" });
  assert.equal(a.hazards[0].side, "right");
  assert.equal(a.detections[0].side, "left");
  assert.equal(a.spoken, "على يمينك طاولة. مكتوب: يمين.");
  const outward = sanitizeAnalysis(raw, scan);
  assert.equal(outward.hazards[0].side, "left");
  assert.equal(outward.spoken, "على يسارك طاولة. مكتوب: يمين.");
  assert.equal(swapSides("شنوة موجود على يميني؟"), "شنوة موجود على يساري؟");
});

test("questions typed in English get the same safety caveat and side correction", () => {
  const q = { mode: "question", cameraFacing: "outward", hasMotionEvidence: false } as const;
  for (const question of ["Can I cross the street?", "Is the road safe?", "Is anything in my way?"]) {
    assert.ok(sanitizeAnalysis({ spoken: "فمّا عباد." }, { ...q, question }).spoken.endsWith(SPEECH.pathCaveat), question);
  }
  assert.ok(!isPathQuestion("What color is this?"));
  assert.equal(swapSides("What is on my right?"), "What is on my left?");
  assert.equal(swapSides("the left side of the room"), "the right side of the room");
  assert.equal(swapSides("Is this right?"), "Is this right?", "'right' meaning 'correct' stays");
});

test("webcam facing the user: the user is not an obstacle to themself", () => {
  const raw = { hazards: [{ kind: "person", label: "شخص", side: "center", proximity: "near", confidence: "confirmed" }, { kind: "person", label: "شخص", side: "left", proximity: "mid", confidence: "confirmed" }] };
  assert.equal(sanitizeAnalysis(raw, { ...scan, cameraFacing: "user" }).hazards.length, 1);
  assert.equal(sanitizeAnalysis(raw, scan).hazards.length, 2);
});

test("question mode: always answers, and never leaves a path answer sounding like a promise", () => {
  const q = { mode: "question", cameraFacing: "outward", hasMotionEvidence: false } as const;
  assert.equal(sanitizeAnalysis({ spoken: "" }, { ...q, question: "شنوة قدّامي؟" }).spoken, SPEECH.unsure);
  const path = sanitizeAnalysis({ spoken: "الطريق فارغة وآمنة. ما شفتش حاجات." }, { ...q, question: "فمّا حاجات في طريقي؟" }).spoken;
  assert.ok(!path.includes("فارغة"), path);
  assert.ok(path.includes("ما شفتش حاجات"), path);
  assert.ok(path.endsWith(SPEECH.pathCaveat), path);
  assert.equal(sanitizeAnalysis({ spoken: "الطريق آمن." }, { ...q, question: "نجم نقطع الشارع؟" }).spoken, SPEECH.pathUnknown, "no 'move the camera' for a crossing question");
  // A real model answer that warns rather than promises: it must survive.
  const honest = sanitizeAnalysis({ spoken: "فمّا عباد تقطع في الشارع قدّامك، وما نجمش نتأكّد إذا الشارع آمن باش تقطع." }, { ...q, question: "نجم نقطع الشارع؟" }).spoken;
  assert.ok(honest.startsWith("فمّا عباد تقطع"), honest);
  assert.ok(isPathQuestion("نجم نقطع الشارع؟"));
  assert.ok(!isPathQuestion("شنوة لون الحكاية هاذي؟"));
});

test("scan mode: nothing to say means not changed", () => {
  assert.equal(sanitizeAnalysis({ spoken: "الطريق آمن." }, scan).changed, false);
  assert.equal(sanitizeAnalysis({ spoken: "قدّامك باب.", changed: false }, scan).changed, false);
  assert.equal(sanitizeAnalysis({ spoken: "قدّامك باب." }, scan).changed, true);
});

test("urgency needs evidence: uncertain is never urgent, far away is not a warning", () => {
  assert.equal(hazardUrgency(hazard({ kind: "stairs" })), "urgent");
  assert.equal(hazardUrgency(hazard({ kind: "stairs", confidence: "uncertain" })), "caution");
  assert.equal(hazardUrgency(hazard({ kind: "vehicle", proximity: "far" })), "info");
  assert.equal(hazardUrgency(hazard({ kind: "vehicle", proximity: "far", motion: "approaching" })), "urgent");
  assert.equal(hazardUrgency(hazard({ kind: "vehicle", proximity: "far", confidence: "uncertain" })), "info");
  assert.equal(hazardUrgency(hazard({ kind: "person", side: "left", proximity: "mid" })), "info");
  assert.equal(hazardUrgency(hazard({ kind: "obstacle", side: "left" })), "caution");
});

test("the wording states the confidence", () => {
  assert.equal(warningPhrase(hazard({ kind: "stairs", label: "درج" })), "رد بالك، فمّا درج قدّامك.");
  assert.equal(warningPhrase(hazard({ kind: "stairs", label: "درج", confidence: "likely", side: "left" })), "رد بالك، يظهرلي فمّا درج على يسارك.");
  assert.equal(warningPhrase(hazard({ kind: "stairs", label: "درج", confidence: "uncertain" })), "يظهرلي فمّا درج قدّامك، أما موش متأكّد.");
  assert.equal(warningPhrase(hazard({ kind: "vehicle", label: "كرهبة", side: "right" })), "رد بالك، كرهبة قريبة منك من اليمين.");
  assert.equal(warningPhrase(hazard({ kind: "vehicle", label: "كميون", side: "left", motion: "approaching" })), "رد بالك، فمّا كميون جاي لجيهتك من اليسار.");
  assert.equal(warningPhrase(hazard({ kind: "obstacle" })), "رد بالك، فمّا حاجة قدّامك.");
});

test("WarningGate: someone starting to approach is announced at once, but only once", () => {
  const gate = new WarningGate({ caution: 5000 });
  const standing = hazard({ kind: "person" });
  const coming = hazard({ kind: "person", motion: "approaching" });
  assert.equal(gate.admit(standing, "caution", 0), true);
  assert.equal(gate.admit(standing, "caution", 100), false);
  assert.equal(gate.admit(coming, "caution", 200), true, "new information");
  assert.equal(gate.admit(coming, "caution", 300), false);
  assert.equal(gate.admit(standing, "caution", 400), false);
});

test("WarningGate: no repeats within the cooldown, but escalation passes at once", () => {
  const gate = new WarningGate({ urgent: 1000, caution: 5000 });
  const h = hazard({ kind: "vehicle" });
  assert.equal(gate.admit(h, "caution", 0), true);
  assert.equal(gate.admit(h, "caution", 100), false);
  assert.equal(gate.admit(h, "urgent", 200), true, "escalation");
  assert.equal(gate.admit(h, "urgent", 300), false);
  assert.equal(gate.admit(h, "urgent", 1300), true, "after the cooldown");
  assert.equal(gate.admit(hazard({ kind: "vehicle", side: "left" }), "urgent", 1300), true, "another side is another warning");
  assert.equal(gate.admit(hazard({ kind: "stairs" }), "info", 0), false);
});
