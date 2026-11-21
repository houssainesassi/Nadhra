// Subtitles, the removed language selector, the language following the user, and the AI Language
// Coach, in real Chromium on the production build. A fake Gemini Live WebSocket plays the model
// (transcripts, tool calls); token / TTS / vision routes are mocked: no Gemini quota, nothing sent.
// Phone portrait, desktop, and Derja (right to left).
//
//   npm run build && npx next start -p 3100
//   node e2e/coach.mjs [base=http://localhost:3100] [screenshots=e2e/live/out/coach]
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? "e2e/live/out/coach";
mkdirSync(OUT, { recursive: true });
const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
const mic = join(OUT, "silence.wav");
if (!existsSync(mic)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-t", "300", "-i", "anullsrc=r=16000:cl=mono", mic]);
const silenceMp3 = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-t", "0.2", "-i", "anullsrc=r=24000:cl=mono", "-f", "mp3", "-"]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const browser = await chromium.launch({
  executablePath,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${mic}`],
});

async function context(viewport, settings = null) {
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"] });
  await ctx.addInitScript((settings) => {
    localStorage.setItem("assistant.consent.v3", "1");
    localStorage.setItem("assistant.liveConsent.v1", "1");
    if (settings && !sessionStorage.getItem("seeded")) {
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("assistant.settings", JSON.stringify(settings));
    }
  }, settings);
  await ctx.route("**/api/tts", (route) => route.request().method() !== "POST"
    ? route.fulfill({ json: { configured: true, voice: "mock", languageCode: "en-US" } })
    : route.fulfill({ body: silenceMp3, contentType: "audio/mpeg" }));
  await ctx.route("**/api/vision", (route) => route.request().method() !== "POST"
    ? route.fulfill({ json: { available: true, providers: [{ id: "mock", label: "Mock" }], canTranscribe: false } })
    : route.fulfill({ json: { analysis: { spoken: "A table ahead.", changed: true, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false }, provider: "mock", latencyMs: 1 } }));
  await ctx.route("**/api/report", (route) => route.fulfill({ json: { accepted: 0 } }));
  const tokenBodies = [];
  await ctx.route("**/api/live/token", (route) => {
    tokenBodies.push(JSON.parse(route.request().postData() ?? "{}"));
    route.fulfill({ json: { token: "auth_tokens/fake", url: "wss://generativelanguage.googleapis.com/ws/fake", setup: { model: "models/fake-live" }, model: "fake-live", voice: "Sulafat", lastModel: true, pricing: null } });
  });
  const fake = { ws: null, toolResponses: [], texts: [] };
  await ctx.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    fake.ws = ws;
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.setup) return ws.send(JSON.stringify({ setupComplete: {} }));
      if (m.toolResponse) fake.toolResponses.push(...m.toolResponse.functionResponses);
      for (const t of m.clientContent?.turns ?? []) for (const p of t.parts ?? []) if (p.text) fake.texts.push(p.text);
      if (m.realtimeInput?.text) fake.texts.push(m.realtimeInput.text);
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.getByTestId("talk-nadhra").waitFor();
  await until(() => page.evaluate(() => document.activeElement?.dataset?.testid === "talk-nadhra"), 10_000);
  const send = (msg) => fake.ws?.send(JSON.stringify(msg));
  /** The model hears the user, answers in words, and ends its turn. */
  const turn = async (user, ai) => {
    send({ serverContent: { inputTranscription: { text: user } } });
    await sleep(80);
    send({ serverContent: { outputTranscription: { text: ai } } });
    await sleep(80);
    send({ serverContent: { turnComplete: true } });
    await sleep(200);
  };
  return { ctx, page, fake, errors, tokenBodies, send, turn };
}

const settingsOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("assistant.settings") ?? "{}"));
const stageAttr = (page, a) => page.getByTestId("stage").getAttribute(a);

async function openSettings(page) {
  await page.getByTestId("open-settings").click();
  return page.locator("dialog[open]");
}

// --- 1. Settings: no language selector; Subtitles off by default and remembered --------------------
for (const [label, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]]) {
  const { ctx, page, errors } = await context(viewport);
  const dlg = await openSettings(page);
  check(`${label}: Settings has no language selector`, (await dlg.getByTestId("language").count()) === 0 && !/\bLanguage\b(?! Coach)/.test(await dlg.innerText()));
  const sub = dlg.getByTestId("subtitles");
  check(`${label}: Subtitles toggle exists and is OFF by default`, (await sub.count()) === 1 && !(await sub.isChecked()));
  check(`${label}: AI Language Coach section with mode and feedback toggle`, (await dlg.getByTestId("coach-enabled").count()) === 1 && (await dlg.getByTestId("coach-mode").count()) === 1 && (await dlg.getByTestId("coach-feedback").count()) === 1);
  check(`${label}: coach off by default, four modes`, !(await dlg.getByTestId("coach-enabled").isChecked()) && (await dlg.getByTestId("coach-mode").locator("option").count()) === 4);
  await page.screenshot({ path: join(OUT, `${label}-settings.png`), fullPage: false });
  await sub.check();
  await page.reload();
  await page.getByTestId("talk-nadhra").waitFor();
  const dlg2 = await openSettings(page);
  check(`${label}: Subtitles ON is remembered after a reload`, await dlg2.getByTestId("subtitles").isChecked());
  check(`${label}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2. A conversation with subtitles OFF (default): nothing spoken is shown; the language follows ---
{
  const { ctx, page, fake, errors, tokenBodies, turn } = await context({ width: 390, height: 844 }, { language: "tn" });
  await page.getByTestId("talk-nadhra").click();
  await until(async () => (await stageAttr(page, "data-live-status")) === "open");
  check("live: opens", (await stageAttr(page, "data-live-status")) === "open");
  check("live: the token request carries no coach when it is off", tokenBodies.length === 1 && !("coach" in tokenBodies[0]));
  await turn("Bonjour, qu'est-ce qu'il y a devant moi ?", "Devant vous, une table.");
  check("subtitles off: no caption box, no heard text", (await page.getByTestId("caption-box").count()) === 0 && (await page.getByTestId("live-user").count()) === 0 && (await page.getByTestId("last-spoken").count()) === 0);
  check("subtitles off: the answer text is nowhere on the screen", !(await page.locator("main").innerText()).includes("une table"));
  check("subtitles off: data attribute", (await stageAttr(page, "data-subtitles")) === "false");
  check("language: the screen follows French (html lang, End button)", await until(async () => (await page.evaluate(() => document.documentElement.lang)) === "fr" && /Terminer la conversation/.test(await page.getByTestId("stop-assistance").innerText()), 3000));
  check("language: kept for the next visit", (await settingsOf(page)).language === "fr");
  check("language: the conversation was not restarted", tokenBodies.length === 1);
  await turn("OK", "D'accord.");
  check("language: «OK» doesn't switch", (await page.evaluate(() => document.documentElement.lang)) === "fr");
  await turn("What is in front of me right now?", "A table.");
  check("language: English next", await until(async () => (await page.evaluate(() => document.documentElement.lang)) === "en", 3000));
  await turn("شنوّة اللي قدّامي توّا؟", "فمّا طاولة قدّامك.");
  check("language: back to Derja, right to left", await until(async () => (await page.evaluate(() => document.documentElement.dir)) === "rtl" && (await settingsOf(page)).language === "tn", 3000));
  await page.screenshot({ path: join(OUT, "live-subtitles-off.png") });

  check("no page errors", errors.length === 0, errors.join(" | "));
  void fake;
  await ctx.close();
}

// --- 2b. Subtitles ON (chosen in Settings): the words are shown -----------------------------------
{
  const { ctx, page, errors, turn } = await context({ width: 390, height: 844 }, { language: "tn", subtitles: true });
  await page.getByTestId("talk-nadhra").click();
  await until(async () => (await stageAttr(page, "data-live-status")) === "open");
  await turn("وين الباب؟", "الباب على يمينك.");
  check("subtitles on: the user's words and the answer are shown", await until(async () => (await page.getByTestId("live-user").count()) === 1 && /الباب على يمينك/.test(await page.getByTestId("last-spoken").innerText()), 3000));
  check("subtitles on: data attribute", (await stageAttr(page, "data-subtitles")) === "true");
  await page.screenshot({ path: join(OUT, "live-subtitles-on.png") });
  check("subtitles on: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 3. AI Language Coach: English practice, corrections in their own panel -------------------------
for (const [label, viewport] of [["phone", { width: 390, height: 844 }], ["desktop", { width: 1280, height: 800 }]]) {
  const { ctx, page, fake, errors, tokenBodies, send, turn } = await context(viewport, { language: "tn", coachEnabled: true, coachMode: "corrections" });
  check(`${label} coach: the home button says the coach is on`, (await page.getByTestId("coach-home").count()) === 1);
  await page.getByTestId("talk-nadhra").click();
  await until(async () => (await stageAttr(page, "data-live-status")) === "open");
  const body = tokenBodies[0] ?? {};
  check(`${label} coach: the token request carries the mode and the user's own language`, body.coach?.mode === "corrections" && body.coach?.userLanguage === "Tunisian Arabic (Derja)", JSON.stringify(body));
  check(`${label} coach: pill and empty panel while the language isn't chosen`, (await page.getByTestId("coach-status").count()) === 1 && (await page.getByTestId("coach-panel").count()) === 1 && /practise|تتمرّن/.test(await page.getByTestId("coach-panel").innerText()));
  await turn("Let's practice English. I want to improve my speaking.", "Of course! Let's have a natural conversation. How was your day?");
  send({ toolCall: { functionCalls: [{ id: "c1", name: "set_practice_language", args: { language: "English" } }] } });
  await until(() => fake.toolResponses.some((r) => r.id === "c1"), 3000);
  check(`${label} coach: set_practice_language answered at once`, fake.toolResponses.find((r) => r.id === "c1")?.response?.ok === true);
  check(`${label} coach: the pill shows English`, await until(async () => /English/.test(await page.getByTestId("coach-status").innerText()), 3000));
  check(`${label} coach: the phone's own language stays Derja while practising English`, (await page.evaluate(() => document.documentElement.lang)) === "ar-TN");
  send({ serverContent: { inputTranscription: { text: "Today I go to work and I am very tired." } } });
  send({ toolCall: { functionCalls: [{ id: "c2", name: "show_learning_feedback", args: { kind: "correction", your_sentence: "Today I go to work", correct_sentence: "Today I went to work", explanation: "You're talking about the past.", new_expression: "I had a long day at work." } }] } });
  await until(() => fake.toolResponses.some((r) => r.id === "c2"), 3000);
  send({ serverContent: { outputTranscription: { text: "That sounds like a long day! A small correction…" } } });
  send({ serverContent: { turnComplete: true } });
  const item = page.getByTestId("coach-item").first();
  check(`${label} coach: the correction is in its own panel`, await until(async () => (await item.count()) === 1 && /Today I went to work/.test(await item.innerText()), 3000));
  const text = await item.innerText();
  check(`${label} coach: your sentence, correct sentence, why and a better expression`, /Today I go to work/.test(text) && /past/.test(text) && /long day at work/.test(text));
  check(`${label} coach: subtitles stay off (only the feedback panel shows)`, (await page.getByTestId("last-spoken").count()) === 0 && (await page.getByTestId("live-user").count()) === 0);
  const box = await page.getByTestId("caption-box").boundingBox();
  const vw = viewport.width;
  check(`${label} coach: the panel fits the screen`, !!box && box.x >= 0 && box.x + box.width <= vw + 1, JSON.stringify(box));
  check(`${label} coach: no horizontal scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  send({ toolCall: { functionCalls: [{ id: "c3", name: "show_learning_feedback", args: { kind: "vocabulary", word: "exhausted", meaning: "very tired", example: "I was exhausted after work." } }] } });
  check(`${label} coach: a new word goes on top`, await until(async () => /exhausted/.test(await page.getByTestId("coach-item").first().innerText()), 3000));
  send({ toolCall: { functionCalls: [{ id: "c4", name: "set_practice_mode", args: { mode: "vocabulary" } }] } });
  check(`${label} coach: mode change shown and saved`, await until(async () => (await settingsOf(page)).coachMode === "vocabulary", 3000));
  check(`${label} coach: practice language remembered`, (await settingsOf(page)).coachLanguage === "English");
  await page.screenshot({ path: join(OUT, `${label}-coach.png`) });
  check(`${label} coach: the conversation was never restarted`, (await stageAttr(page, "data-live-status")) === "open" && tokenBodies.length === 1);
  await turn("I am agree with you.", "Great! Just say 'I agree with you'.");
  check(`${label} no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 4. Coach with the feedback panel turned off: practice by voice only, nothing drawn -------------
{
  const { ctx, page, fake, errors, send } = await context({ width: 390, height: 844 }, { language: "en", coachEnabled: true, coachFeedback: false });
  await page.getByTestId("talk-nadhra").click();
  await until(async () => (await stageAttr(page, "data-live-status")) === "open");
  send({ toolCall: { functionCalls: [{ id: "f1", name: "show_learning_feedback", args: { kind: "correction", your_sentence: "I am agree", correct_sentence: "I agree" } }] } });
  await until(() => fake.toolResponses.some((r) => r.id === "f1"), 3000);
  await sleep(200);
  check("feedback off: the tool is still answered (the model isn't held up)", fake.toolResponses.find((r) => r.id === "f1")?.response?.ok === true);
  check("feedback off: no panel, no caption box", (await page.getByTestId("coach-panel").count()) === 0 && (await page.getByTestId("caption-box").count()) === 0);
  check("feedback off: the coach pill still says practice is on", (await page.getByTestId("coach-status").count()) === 1);
  check("feedback off: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
