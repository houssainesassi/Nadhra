// The assistant speaks Tunisian, Modern Standard Arabic, French and English. The safety rules must
// hold in every one of them, and voice commands must work whichever language the user speaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandExamples, parseCommand } from "../src/lib/assistant/commands.ts";
import { guardSpoken, isPathQuestion, sanitizeAnalysis, swapSides } from "../src/lib/assistant/schema.ts";
import { cameraErrorText, PHRASES, speech, SPEECH, warningPhrase } from "../src/lib/assistant/phrases.ts";
import { buildUserText, transcribePrompt, visionSystemPrompt, VISION_SYSTEM_PROMPT } from "../src/lib/assistant/prompts.ts";
import { cleanPhone, sanitizeVisionSettings } from "../src/lib/assistant/settings.ts";
import { HazardTracker, type RawDetection } from "../src/lib/assistant/hazardTracker.ts";
import { isSpeechLang, SPEECH_LANGS } from "../src/lib/assistant/lang.ts";
import type { Hazard } from "../src/lib/assistant/types.ts";

const q = { mode: "question", cameraFacing: "outward", hasMotionEvidence: false } as const;
const hazard = (p: Partial<Hazard>): Hazard => ({ kind: "obstacle", label: "", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown", ...p });

test("phrases: every language says every sentence", () => {
  // Every key at every depth, with its value. Document kinds without a spoken header are empty on purpose.
  const MAY_BE_EMPTY = new Set(["doc.kind.other", "doc.kind.none"]);
  const walk = (v: unknown, path: string, out: Map<string, string>) => {
    if (typeof v === "string") out.set(path, v);
    else for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, path ? `${path}.${k}` : k, out);
    return out;
  };
  const keys = [...walk(SPEECH, "", new Map()).keys()].sort();
  for (const lang of SPEECH_LANGS) {
    const all = walk(PHRASES[lang], "", new Map());
    assert.deepEqual([...all.keys()].sort(), keys, lang);
    for (const [k, text] of all) assert.ok(MAY_BE_EMPTY.has(k) ? text === "" : text.trim().length > 1, `${lang}.${k}`);
  }
  assert.equal(speech("tn"), SPEECH);
  assert.match(cameraErrorText("fr", "denied"), /autorisation/);
  assert.equal(cameraErrorText("en", "nonsense"), cameraErrorText("en", "unknown"));
});

test("phrases: the safety notice and the path caveat pass the safety filter in every language", () => {
  for (const lang of SPEECH_LANGS) {
    const p = PHRASES[lang];
    for (const text of [p.disclaimer, p.pathCaveat, p.pathUnknown, p.unsure, p.help, p.emergency]) {
      assert.equal(guardSpoken(text, []), text, `${lang}: ${text}`);
    }
  }
});

test("warnings: the wording states the confidence in every language", () => {
  assert.equal(warningPhrase(hazard({ kind: "stairs", label: "درج" })), "رد بالك، فمّا درج قدّامك.", "Tunisian unchanged");
  assert.equal(warningPhrase(hazard({ kind: "stairs" }), "en"), "Careful, there's a staircase ahead of you.");
  assert.equal(warningPhrase(hazard({ kind: "stairs", confidence: "likely", side: "left" }), "en"), "Careful, there seems to be a staircase on your left.");
  assert.equal(warningPhrase(hazard({ kind: "stairs", confidence: "uncertain" }), "en"), "There may be a staircase ahead of you, but I'm not sure.");
  assert.equal(warningPhrase(hazard({ kind: "vehicle", label: "a truck", side: "left", motion: "approaching" }), "en"), "Careful, a truck is coming toward you from the left.");
  assert.equal(warningPhrase(hazard({ kind: "vehicle", label: "une voiture", side: "right" }), "fr"), "Attention, une voiture est près de vous, à votre droite.");
  assert.equal(warningPhrase(hazard({ kind: "vehicle", label: "une voiture", side: "left", motion: "approaching", confidence: "likely" }), "fr"), "Attention, une voiture semble arriver vers vous par la gauche.");
  assert.equal(warningPhrase(hazard({ kind: "person", label: "une personne", motion: "approaching" }), "fr"), "Une personne arrive vers vous par devant.");
  assert.equal(warningPhrase(hazard({ kind: "obstacle", confidence: "uncertain" }), "fr"), "Il y a peut-être un obstacle devant vous, mais je n'en suis pas sûr.");
  assert.equal(warningPhrase(hazard({ kind: "vehicle", label: "سيارة", side: "left", motion: "approaching" }), "ar"), "انتبه، هناك سيارة تقترب نحوك من اليسار.");
  assert.equal(warningPhrase(hazard({ kind: "stairs", label: "درج", confidence: "likely" }), "ar"), "انتبه، يبدو أن هناك درج أمامك.");
  for (const lang of SPEECH_LANGS) {
    // Uncertain warnings always say so; none of them promises anything.
    const text = warningPhrase(hazard({ kind: "stairs", confidence: "uncertain" }), lang);
    assert.match(text, /موش متأكّد|لست متأكّدًا|pas sûr|not sure/, lang);
    assert.equal(guardSpoken(text, []), text, lang);
  }
});

test("guardSpoken: removes safety promises in French, English and Modern Standard Arabic", () => {
  const claims = [
    "Le chemin est libre.", "Vous pouvez traverser.", "Il n'y a aucun obstacle.", "La rue est dégagée.", "C'est sans danger.", "Vous êtes en sécurité.",
    "The path is clear.", "You can cross now.", "There's nothing in your way.", "The street looks empty.", "You can walk without any risk.",
    "الطريق خالٍ.", "يمكنك العبور.", "لا يوجد أي خطر.", "يمكنك المشي بأمان.", "الطريق آمن.",
  ];
  for (const claim of claims) assert.equal(guardSpoken(`Door. ${claim}`, []), "Door.", claim);
});

test("guardSpoken: honest doubt about safety stays, in every language", () => {
  const honest = [
    "Je ne peux pas confirmer que le chemin est libre.",
    "I can't confirm the path is clear.",
    "This doesn't mean the road is safe.",
    "لا أستطيع أن أؤكد أن الطريق آمن.",
  ];
  for (const ok of honest) assert.equal(guardSpoken(ok, []), ok);
  for (const ok of ["Il y a une porte devant vous, à droite.", "There are two steps down ahead of you.", "A person is walking on your left.", "Allez tout droit jusqu'à la porte."]) {
    assert.equal(guardSpoken(ok, []), ok, "innocent sentences stay");
  }
});

test("guardSpoken: no spelled-out distances in French or English, unless read from a sign", () => {
  for (const d of ["La porte est à deux mètres.", "The door is three meters away.", "It's about ten feet ahead.", "The car is a few steps away.", "Il reste quelques pas."]) {
    assert.equal(guardSpoken(`Ok. ${d}`, []), "Ok.", d);
  }
  assert.equal(guardSpoken("The sign says Exit 3 km.", [{ content: "Exit 3 km", confidence: "confirmed" }]), "The sign says Exit 3 km.");
});

test("swapSides: French sides, but never «tout droit»", () => {
  assert.equal(swapSides("Une porte à droite et une table sur votre gauche."), "Une porte à gauche et une table sur votre droite.");
  assert.equal(swapSides("Du côté droit."), "Du côté gauche.");
  assert.equal(swapSides("Du côté gauche."), "Du côté droit.");
  assert.equal(swapSides("Allez tout droit."), "Allez tout droit.");
  assert.equal(swapSides("Is this right? It's on the right."), "Is this right? It's on the left.");
});

test("path questions get the caveat in the user's language", () => {
  for (const question of ["Est-ce que je peux traverser ?", "Is the road clear?", "هل يمكنني أن أعبر الطريق؟"]) assert.ok(isPathQuestion(question), question);
  assert.ok(!isPathQuestion("Qu'est-ce que c'est ?"));
  const fr = sanitizeAnalysis({ spoken: "Il y a des voitures." }, { ...q, question: "Je peux traverser ?", lang: "fr" }).spoken;
  assert.ok(fr.endsWith(PHRASES.fr.pathCaveat), fr);
  const en = sanitizeAnalysis({ spoken: "The road is safe." }, { ...q, question: "Can I cross the road?", lang: "en" }).spoken;
  assert.equal(en, PHRASES.en.pathUnknown);
  assert.equal(sanitizeAnalysis({ spoken: "" }, { ...q, question: "What is this?", lang: "ar" }).spoken, PHRASES.ar.unsure);
  assert.equal(sanitizeAnalysis({ spoken: "" }, { ...q, question: "شنوة هاذي؟" }).spoken, SPEECH.unsure, "Tunisian by default");
});

test("commands: the brief's commands, in all four languages", () => {
  const cases: [string, string][] = [
    ["Open camera", "camera-on"], ["Ouvre la caméra", "camera-on"], ["افتح الكاميرا", "camera-on"], ["شعّل الكاميرا", "camera-on"],
    ["What is in front of me?", "front"], ["Qu'y a-t-il devant moi ?", "front"], ["ماذا أمامي؟", "front"], ["شنوة قدّامي؟", "front"],
    ["Read this text", "read"], ["Lis le texte", "read"], ["اقرأ النص", "read"], ["اقرالي الكتابة", "read"],
    ["Describe my surroundings", "describe"], ["Décris les alentours", "describe"], ["صف المكان", "describe"], ["وصفلي البلاصة", "describe"],
    ["What is this?", "identify"], ["C'est quoi ?", "identify"], ["ما هذا؟", "identify"], ["شنوة هاذي؟", "identify"],
    ["Repeat", "repeat"], ["Répète", "repeat"], ["أعد", "repeat"], ["عاود", "repeat"],
    ["Go back", "back"], ["Retour", "back"], ["رجوع", "back"], ["رجّع", "back"],
    ["Help", "help"], ["Aide", "help"], ["مساعدة", "help"],
    ["Emergency", "emergency"], ["Au secours !", "emergency"], ["طوارئ", "emergency"], ["نجدة", "emergency"], ["Help me!", "emergency"],
    ["Stop talking", "stop-speech"], ["Tais-toi", "stop-speech"], ["اسكت", "stop-speech"],
    ["Louder", "louder"], ["Plus lentement", "slower"],
    ["Speak French", "lang-fr"], ["احكي بالتونسي", "lang-tn"], ["Speak English", "lang-en"],
  ];
  for (const [said, cmd] of cases) assert.equal(parseCommand(said), cmd, said);
});

test("commands: polite words around a command are fine, real questions still reach the model", () => {
  assert.equal(parseCommand("Please read this text"), "read");
  assert.equal(parseCommand("Lis le texte s'il te plaît"), "read");
  assert.equal(parseCommand("اقرالي الكتابة يعيشك"), "read");
  assert.equal(parseCommand("Ok Nadhra, what is this?"), "identify");
  for (const question of ["Where is the door?", "Is the bus number 12?", "Lis-moi le prix sur l'étiquette", "وين الباب؟", "Please"]) {
    assert.equal(parseCommand(question), null, question);
  }
  const ex = commandExamples("fr");
  assert.equal(parseCommand(ex.read ?? ""), "read", "the examples shown on screen work");
  for (const lang of SPEECH_LANGS) for (const [cmd, text] of Object.entries(commandExamples(lang))) assert.equal(parseCommand(text), cmd, `${lang}: ${text}`);
});

test("prompts: one per language; Tunisian unchanged in substance", () => {
  assert.equal(visionSystemPrompt("tn"), VISION_SYSTEM_PROMPT);
  assert.match(VISION_SYSTEM_PROMPT, /Tunisian Arabic \(Derja\)/);
  for (const [lang, name] of [["ar", "Modern Standard Arabic"], ["fr", "French"], ["en", "English"]] as const) {
    const p = visionSystemPrompt(lang);
    assert.ok(p.includes(name), lang);
    assert.ok(!p.includes("Derja"), `${lang} prompt has no Derja instruction`);
    assert.match(p, /Never say a road, path or crossing is safe/, `${lang} keeps the safety rules`);
    assert.ok(!/\$\{/.test(p), `${lang}: no unfilled placeholders`);
    assert.match(buildUserText({ mode: "question", cameraFacing: "outward", question: "x", lang }), new RegExp(`always in ${name}`));
  }
  assert.match(buildUserText({ mode: "question", cameraFacing: "outward", question: "x" }), /always in Derja/);
  assert.match(transcribePrompt("fr"), /probably French/);
  assert.match(transcribePrompt("tn"), /Tunisian Arabic/);
});

test("settings: language, volume, text size and the emergency number are validated", () => {
  const s = sanitizeVisionSettings({ language: "de", volume: 7, textScale: 0.2, emergencyPhone: "+216 98 <script> 123 456", emergencyName: "  Maman\u0007 " });
  assert.equal(s.language, "tn");
  assert.equal(s.volume, 1);
  assert.equal(s.textScale, 1);
  assert.equal(s.emergencyPhone, "+216 98 123 456");
  assert.equal(s.emergencyName, "Maman");
  assert.equal(sanitizeVisionSettings({ language: "fr" }).language, "fr");
  assert.equal(cleanPhone("98+12;34"), "981234", "a + only at the start, nothing that changes a tel: link");
  assert.ok(isSpeechLang("en") && !isSpeechLang("EN"));
});

test("on-device warnings use the speech language", () => {
  const t = new HazardTracker();
  const car: RawDetection = { label: "car", score: 0.9, x: 0.4, y: 0.3, w: 0.2, h: 0.2 };
  let hazards: Hazard[] = [];
  for (let i = 0; i < 5; i++) hazards = t.update([car], i * 300, { cameraMoving: false, facing: "outward", lang: "fr" }).hazards;
  assert.equal(hazards[0]?.label, "une voiture");
  const u = new HazardTracker();
  for (let i = 0; i < 5; i++) hazards = u.update([car], i * 300, { cameraMoving: false, facing: "outward" }).hazards;
  assert.equal(hazards[0]?.label, "كرهبة", "Tunisian by default");
});

test("help: every command the spoken help tells the user to say actually works", () => {
  const spokenInHelp: Record<string, [string, string][]> = {
    tn: [["شنوة قدّامي", "front"], ["وصفلي البلاصة", "describe"], ["اقرالي الكتابة", "read"], ["شنوة هاذي الحاجة", "identify"], ["عاود", "repeat"], ["اسكت", "stop-speech"], ["وقّف التحليل", "pause"], ["كمّل", "resume"], ["رجّع", "back"], ["نجدة", "emergency"], ["عيّط", "call"]],
    ar: [["ماذا أمامي", "front"], ["صف المكان", "describe"], ["اقرأ النص", "read"], ["ما هذا الشيء", "identify"], ["أعد", "repeat"], ["اسكت", "stop-speech"], ["أوقف التحليل", "pause"], ["تابع", "resume"], ["رجوع", "back"], ["نجدة", "emergency"], ["اتصل", "call"]],
    fr: [["qu'y a-t-il devant moi", "front"], ["décris les alentours", "describe"], ["lis le texte", "read"], ["qu'est-ce que c'est", "identify"], ["répète", "repeat"], ["tais-toi", "stop-speech"], ["mets en pause", "pause"], ["continue", "resume"], ["retour", "back"], ["urgence", "emergency"], ["appelle", "call"]],
    en: [["what's in front of me", "front"], ["describe my surroundings", "describe"], ["read this text", "read"], ["what is this", "identify"], ["repeat", "repeat"], ["stop", "stop-speech"], ["pause analysis", "pause"], ["continue", "resume"], ["go back", "back"], ["emergency", "emergency"], ["call", "call"]],
  };
  for (const [lang, pairs] of Object.entries(spokenInHelp)) {
    const p = PHRASES[lang as keyof typeof PHRASES];
    for (const [phrase, cmd] of pairs) {
      assert.equal(parseCommand(phrase), cmd, `${lang}: «${phrase}»`);
      const said = `${p.help} ${p.emergency}`.toLowerCase();
      assert.ok(said.includes(phrase.toLowerCase()), `${lang}: the help or emergency text mentions «${phrase}»`);
    }
  }
});

test("commands: everyday words never pause warnings, switch language or start the camera", () => {
  const risky = new Set(["pause", "read", "describe", "identify", "front", "camera-on", "lang-tn", "lang-ar", "lang-fr", "lang-en"]);
  const everyday = [
    "wait", "attends", "استني", "انتظر", "توقف", "وقّف", "وقف شوية", "English", "français", "en français", "arabic", "بالتونسي",
    "read", "lis", "اقرا", "اقرأ", "describe", "décris", "وصفلي", "ok", "yes", "نعم", "d'accord", "go", "on y va",
  ];
  for (const w of everyday) {
    const cmd = parseCommand(w);
    assert.ok(!cmd || !risky.has(cmd), `«${w}» -> ${cmd}`);
  }
});

test("a sentence that says nothing is ahead always comes with: that doesn't mean it's safe", () => {
  const cases: [string, "tn" | "ar" | "fr" | "en"][] = [
    ["ما فمّا شي قدّامك.", "tn"],
    ["ما نشوف حتى حاجة في الطريق.", "tn"],
    ["لا يوجد شيء أمامك.", "ar"],
    ["Il n'y a rien devant vous.", "fr"],
    ["Je ne vois personne sur le chemin.", "fr"],
    ["There's nothing in front of you.", "en"],
    ["I don't see anyone ahead.", "en"],
  ];
  for (const [said, lang] of cases) {
    for (const mode of ["scan", "question"] as const) {
      const out = sanitizeAnalysis({ spoken: said }, { mode, cameraFacing: "outward", hasMotionEvidence: false, question: mode === "question" ? "x" : undefined, lang }).spoken;
      assert.equal(out, `${said} ${PHRASES[lang].notSafe}`, `${lang} ${mode}: ${out}`);
    }
  }
  for (const lang of SPEECH_LANGS) assert.equal(guardSpoken(PHRASES[lang].notSafe, []), PHRASES[lang].notSafe, `${lang}: the reminder itself survives the filter`);
  // Ordinary descriptions are left alone, and path questions keep their single caveat.
  assert.equal(sanitizeAnalysis({ spoken: "There's a door ahead of you." }, { mode: "scan", cameraFacing: "outward", hasMotionEvidence: false, lang: "en" }).spoken, "There's a door ahead of you.");
  assert.equal(sanitizeAnalysis({ spoken: "I can't see a door in the image." }, { mode: "question", cameraFacing: "outward", hasMotionEvidence: false, question: "Where is the door?", lang: "en" }).spoken, "I can't see a door in the image.");
  const path = sanitizeAnalysis({ spoken: "There's nothing in front of you." }, { mode: "question", cameraFacing: "outward", hasMotionEvidence: false, question: "Is the road clear?", lang: "en" }).spoken;
  assert.equal(path, `There's nothing in front of you. ${PHRASES.en.pathCaveat}`);
});
