// The one-screen layout in real Chromium: Open camera → consent → camera screen → warning → Stop,
// language switching, no scrolling at phone, tablet and desktop sizes, focus, reduced motion.
// Fully mocked (fake camera, /api/vision and /api/tts answered in the browser): no Gemini quota.
//
//   python3 e2e/make_synthetic_camera.py <fixtures>
//   node e2e/redesign.mjs <fixtures> [base=http://localhost:3100] [screenshots=e2e/live/out/redesign]
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fixtures = process.argv[2];
const BASE = process.argv[3] ?? "http://localhost:3100";
const OUT = process.argv[4] ?? "e2e/live/out/redesign";
if (!fixtures) throw new Error("usage: node e2e/redesign.mjs <fixtures> [base] [screenshots]");
mkdirSync(OUT, { recursive: true });
const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
const silence = readFileSync(join(fixtures, "silence.mp3"));

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const browser = await chromium.launch({
  executablePath,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${join(fixtures, "synthetic.mjpeg")}`],
});

async function context(viewport, extra = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"], ...extra });
  await ctx.addInitScript(() => {
    window.__tracks = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__tracks.push(...s.getTracks()); return s; };
  });
  const state = { posts: 0, tts: [], hazardAfter: null };
  await ctx.route("**/api/vision", (route) => {
    const r = route.request();
    if (r.method() !== "POST") return route.fulfill({ json: { available: true, providers: [{ id: "mock", label: "Mock" }], canTranscribe: false } });
    state.posts++;
    const stairs = state.hazardAfter != null && state.posts > state.hazardAfter;
    const analysis = { spoken: stairs ? "" : "A quiet room with a table ahead and a door on the right.", changed: true, imageQuality: "good", environment: null, detections: [], texts: [], uncertain: false,
      hazards: stairs ? [{ kind: "stairs", label: "stairs", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown" }] : [] };
    return route.fulfill({ json: { analysis, provider: "mock", latencyMs: 1 } });
  });
  await ctx.route("**/api/tts", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { configured: true, voice: "mock", languageCode: "en-US" } });
    try { state.tts.push(JSON.parse(route.request().postData())); } catch {}
    return route.fulfill({ body: silence, contentType: "audio/mpeg" });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, state, errors };
}

const layout = (page) => page.evaluate(() => {
  const app = document.querySelector(".app");
  const box = (sel) => { const el = document.querySelector(sel); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width ? { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) } : null; };
  const brand = document.querySelector(".brand");
  return {
    scrolls: document.documentElement.scrollHeight > innerHeight + 1 || app.scrollHeight > app.clientHeight + 1,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    nameClipped: brand.scrollWidth > brand.clientWidth + 1,
    vh: innerHeight, open: box(".open-camera"), live: box(".home-action-live"), liveActive: box(".live-button"), stop: box(".stop-button"), stage: box(".stage"),
    // The action buttons: each one's size and position, and whether all of them are on screen.
    // The group's content fits it (no button cut off at its top or bottom).
    actionsFit: (() => { const g = document.querySelector("[data-testid=actions]"); return !g || g.scrollHeight <= g.clientHeight + 1; })(),
    actions: [...document.querySelectorAll("[data-testid=actions] button")].map((b) => { const r = b.getBoundingClientRect(); return { id: b.dataset.testid, w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), right: Math.round(r.right) }; }),
  };
});
// Automatic descriptions are off by default; these layout flows turn them on, as a user would, to see
// descriptions and warnings on screen. The default itself is checked in "0." below.
const withLang = (ctx, language, extra = {}, settings = { autoDescribe: true }) => ctx.addInitScript(({ language, extra, settings }) => {
  if (!localStorage.getItem("assistant.settings")) localStorage.setItem("assistant.settings", JSON.stringify({ language, ...settings }));
  for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
}, { language, extra, settings });
const focused = (page) => page.evaluate(() => document.activeElement?.dataset.testid);
/** <html lang> and <html dir>, as screen readers and the browser see them. */
const htmlLang = (page) => page.evaluate(() => `${document.documentElement.lang} ${document.documentElement.dir}`);
/** Every action button is at least 48 px each way (Android's touch target) and fully on screen. */
const actionsOk = (l, vw) => l.actions.length >= 4 && l.actionsFit && l.actions.every((a) => a.w >= 48 && a.h >= 48 && a.top >= 0 && a.bottom <= l.vh && a.right <= vw);
// axe-core, when supplied (AXE=/path/to/axe.min.js), checks the camera screen for automated violations.
const AXE_SRC = process.env.AXE ? readFileSync(process.env.AXE, "utf8") : null;

// --- 0. By default, no picture leaves the phone by itself -------------------------------------------
{
  const { page, state, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await withLang(page.context(), "en", {}, {});
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("open-camera").click();
  await page.getByRole("button", { name: "I agree", exact: true }).click();
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(5000);
  check("default: no picture is sent automatically after Open camera", state.posts === 0, `${state.posts} sent`);
  check("default: the screen says it describes when asked", (await page.getByTestId("stage").getAttribute("data-analysis")) === "manual");
  check("default: the user hears that automatic descriptions are off, and what that means", state.tts.some((t) => /Automatic descriptions are off/.test(t.text ?? "")), state.tts.map((t) => t.text).join(" | "));
  check("default: no page errors", errors.length === 0, errors.join(" | "));
  await page.context().close();
}

// --- 0b. The live conversation asks first: nothing is requested before the second press ------------
{
  const { page, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await withLang(page.context(), "en", { "assistant.consent.v3": "1" });
  let tokens = 0;
  await page.context().route("**/api/live/token", (route) => (tokens++, route.fulfill({ status: 503, json: { error: "test" } })));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("open-camera").click();
  await until(() => page.locator('.stage[data-on="true"]').count());
  // Talk live sits with the actions while the camera is on (no trip to Settings).
  check("live: the Talk live button is beside Stop, outside Settings", (await page.locator(".active-bar [data-testid=live-toggle]").count()) === 1 && (await page.locator("dialog [data-testid=live-toggle]").count()) === 0);
  await page.getByTestId("live-toggle").click();
  await sleep(1500);
  check("live: the first press only asks (the button now says «I agree»)", (await page.getByTestId("live-toggle").innerText()).includes("I agree: start the live conversation"));
  check("live: nothing requested before the answer", tokens === 0, `${tokens} token requests`);
  await page.getByTestId("live-toggle").click();
  await until(() => tokens > 0, 5000);
  check("live: the second press starts it", tokens > 0);
  check("live: no page errors", errors.length === 0, errors.join(" | "));
  await page.context().close();
}

// --- 1. The whole flow on a phone ----------------------------------------------------------------
{
  const { ctx, page, state, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await withLang(ctx, "en");
  await page.goto(BASE, { waitUntil: "networkidle" });
  let l = await layout(page);
  check("phone home: no scrolling, the name isn't cut off", !l.scrolls && !l.overflowX && !l.nameClipped, JSON.stringify(l));
  check("phone home: Open camera is large and on screen", l.open && l.open.h >= 150 && l.open.bottom <= l.vh, JSON.stringify(l.open));
  check("phone home: Open camera has focus", (await focused(page)) === "open-camera");
  check("phone home: Talk live is right under Open camera, on screen, and the only one", l.live && l.live.top >= l.open.bottom && l.live.top - l.open.bottom <= 24 && l.live.bottom <= l.vh && l.live.h >= 48 && (await page.getByTestId("live-toggle").count()) === 1, JSON.stringify({ open: l.open, live: l.live }));
  await page.keyboard.press("Tab");
  check("phone home: Tab goes from Open camera to Talk live", (await focused(page)) === "live-toggle");
  check("phone home: Talk live is named by its words and described", await page.getByTestId("live-toggle").evaluate((b) => b.innerText.trim() === "Talk live" && document.getElementById(b.getAttribute("aria-describedby"))?.textContent.includes("Google Gemini")));
  await page.getByTestId("open-camera").focus();
  const text = await page.locator(".app").innerText();
  const removed = ["Ask by voice", "Stop talking", "Repeat last sentence", "Help", "Emergency assistance", "Type your question", "Send", "What's in front of me?", "Where is the door?", "What it sees now", "On-device detection", "Internet"];
  check("phone home: the removed controls and panels are gone", removed.every((w) => !text.split("\n").includes(w)));
  await page.screenshot({ path: join(OUT, "phone-home.png") });

  await page.getByTestId("open-camera").click();
  check("Open camera without consent shows the notice first", await page.getByRole("dialog", { name: "Before the camera starts" }).isVisible());
  check("no camera before consent", (await page.evaluate(() => window.__tracks.length)) === 0);
  await page.screenshot({ path: join(OUT, "phone-consent.png") });
  state.hazardAfter = 3;
  await page.getByRole("button", { name: "I agree", exact: true }).click();
  check("after consent the camera screen shows", !!(await until(() => page.locator('.stage[data-on="true"]').count())));
  check("focus moves to Stop assistance", !!(await until(async () => (await focused(page)) === "stop-assistance", 3000)));
  check("voice commands start with the camera", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-voice-commands")) === "true", 6000)));
  check("the on-device detector starts", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-detector")) !== "off", 6000)));
  check("the cloud analysis's description is shown", !!(await until(async () => (await page.getByTestId("last-spoken").innerText()).includes("quiet room"), 20_000)));
  l = await layout(page);
  // The action buttons take about a quarter of a phone screen: the preview keeps the rest.
  check("phone camera screen: no scrolling, Stop on screen, preview keeps most of it", !l.scrolls && l.stop?.bottom <= l.vh && l.stage?.h / l.vh > 0.45, JSON.stringify({ ...l, actions: undefined }));
  check("phone camera screen: the five actions are on screen and large enough to tap", l.actions.length === 5 && actionsOk(l, 390) && l.actions.every((a) => a.bottom <= l.stop.top), JSON.stringify(l.actions));
  const group = page.getByRole("group", { name: "Actions" });
  const names = ["Describe surroundings", "Read text", "Identify object", "Ask a question", "Pause descriptions"];
  const found = [];
  for (const n of names) found.push(await group.getByRole("button", { name: n, exact: true }).count());
  check("actions: a named group, each button named by its visible words", found.every((c) => c === 1), JSON.stringify(found));
  const order = await page.evaluate(() => [...document.querySelectorAll("[data-testid=stage], [data-testid=actions] button, [data-testid=stop-assistance], [data-testid=live-toggle]")].map((e) => e.dataset.testid));
  check("actions: read in order between the camera and Stop", order.join(",") === "stage,action-describe,action-read,action-identify,action-ask,action-pause,stop-assistance,live-toggle", order.join(","));
  check("actions: Pause is told that warnings keep running", (await page.getByTestId("action-pause").evaluate((b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent)) === "Warnings keep running.");
  if (AXE_SRC) {
    await page.addScriptTag({ content: AXE_SRC });
    const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
    check("camera screen: no automated accessibility violations (axe)", v.length === 0, v.join(" | "));
  } else console.log("SKIP  axe (set AXE=/path/to/axe.min.js)");
  await page.screenshot({ path: join(OUT, "phone-active.png") });

  // Each button is the same controller call as its voice command: a tap sends a picture and is answered.
  const before = state.posts;
  await page.getByTestId("action-describe").tap();
  check("Describe: a tap sends one picture", !!(await until(() => state.posts > before, 8000)), `${state.posts - before} sent`);
  await page.getByTestId("action-pause").tap();
  check("Pause: a tap pauses the descriptions", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-analysis")) === "paused", 3000)));
  check("Pause: the button now says Resume", !!(await until(async () => (await page.getByTestId("action-pause").innerText()).includes("Resume descriptions"), 3000)));
  check("Pause: the on-device warnings are still running", (await page.getByTestId("stage").getAttribute("data-detector")) !== "off");
  const paused = state.posts;
  await sleep(3000);
  check("Pause: no automatic picture is sent while paused", state.posts === paused, `${state.posts - paused} sent`);
  await page.getByTestId("action-identify").tap();
  check("Identify: works during the pause, and the pause stays", !!(await until(() => state.posts > paused, 8000)) && !!(await until(async () => (await page.getByTestId("action-pause").innerText()).includes("Resume"), 8000)));
  await page.getByTestId("action-pause").tap();
  check("Resume: a tap resumes the descriptions", !!(await until(async () => (await page.getByTestId("action-pause").innerText()).includes("Pause descriptions"), 3000)));
  await page.getByTestId("action-ask").tap();
  await sleep(500);
  check("Ask with voice commands on: the microphone stays on", (await page.getByTestId("stage").getAttribute("data-voice-commands")) === "true");
  const urgent = await until(async () => { const p = page.locator('[data-testid="last-spoken"][data-urgent="true"]'); return (await p.count()) ? p.first().innerText() : null; }, 25_000, 50);
  check("a stairs warning is shown as urgent", !!urgent);
  check("and spoken", state.tts.some((t) => /stair/i.test(t.text ?? "")));
  await page.screenshot({ path: join(OUT, "phone-warning.png") });

  await page.getByTestId("stop-assistance").click();
  check("Stop returns to the home screen", await page.getByTestId("open-camera").isVisible());
  check("Stop releases every camera track", await page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === "ended")));
  check("focus is back on Open camera", (await focused(page)) === "open-camera");

  check("language: <html> is English, left to right, while English is chosen", (await htmlLang(page)) === "en ltr", await htmlLang(page));
  await page.getByTestId("language").selectOption("tn");
  await sleep(300);
  check("language: <html> turns Tunisian and right to left at once, without a reload", (await htmlLang(page)) === "ar-TN rtl", await htmlLang(page));
  const ui = await page.evaluate(() => ({ dir: document.querySelector(".app").dir, lang: document.querySelector(".app").lang, label: document.querySelector(".open-camera").innerText, saved: JSON.parse(localStorage.getItem("assistant.settings")).language }));
  check("language: the screen turns Tunisian and right to left", ui.dir === "rtl" && ui.lang === "ar-TN" && /الكاميرا/.test(ui.label), JSON.stringify(ui));
  check("language: saved for speech and recognition", ui.saved === "tn");
  check("language: the assistant says it in the new language", !!(await until(() => state.tts.some((t) => /[؀-ۿ]/.test(t.text ?? "")), 5000)));
  l = await layout(page);
  check("Tunisian home: no scrolling", !l.scrolls && !l.overflowX && !l.nameClipped);
  await page.screenshot({ path: join(OUT, "phone-home-tn.png") });
  await page.getByTestId("open-camera").click();
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(2500);
  const tnLabels = await page.getByTestId("actions").innerText();
  check("Tunisian: the actions are in Derja", ["وصفلي البلاصة", "اقرالي الكتابة", "شنوة هاذي؟", "اسأل سؤال"].every((w) => tnLabels.includes(w)), tnLabels);
  l = await layout(page);
  check("Tunisian camera screen: no scrolling, actions on screen", !l.scrolls && !l.overflowX && actionsOk(l, 390), JSON.stringify(l.actions));
  if (AXE_SRC) {
    if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: AXE_SRC });
    const v = await page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
    check("Tunisian camera screen: no automated accessibility violations (axe, including html-has-lang and valid-lang)", v.length === 0, v.join(" | "));
  }
  await page.screenshot({ path: join(OUT, "phone-active-tn.png") });

  await page.getByTestId("open-settings").click();
  check("Settings holds voice commands and the emergency contact; Talk live stays on the main screen", (await page.getByRole("dialog", { name: "Settings" }).isVisible()) && (await page.getByTestId("voice-commands").count()) === 1 && (await page.locator("dialog [data-testid=live-toggle]").count()) === 0 && (await page.getByTestId("live-toggle").count()) === 1);
  await page.keyboard.press("Escape");
  await page.getByTestId("open-privacy").click();
  const privacy = page.getByRole("dialog", { name: "Privacy & safety" });
  check("Privacy & safety holds the experimental-version disclaimer", (await privacy.isVisible()) && /Silence doesn.t mean the way is safe/.test(await privacy.innerText()));
  await page.screenshot({ path: join(OUT, "phone-privacy.png") });
  await page.keyboard.press("Escape");
  await page.getByTestId("stop-assistance").click();
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2. Other sizes; keyboard on desktop -----------------------------------------------------------
for (const [name, viewport, mobile] of [
  ["desktop-1440x900", { width: 1440, height: 900 }],
  ["desktop-1280x720", { width: 1280, height: 720 }],
  ["tablet-768x1024", { width: 768, height: 1024 }, true],
  ["phone-375x667", { width: 375, height: 667 }, true],
  ["phone-360x640", { width: 360, height: 640 }, true],
  ["phone-landscape-844x390", { width: 844, height: 390 }, true],
]) {
  const { ctx, page, errors } = await context(viewport, mobile ? { isMobile: true, hasTouch: true } : {});
  await withLang(ctx, "fr", { "assistant.consent.v3": "1" });
  await page.goto(BASE, { waitUntil: "networkidle" });
  let l = await layout(page);
  check(`${name} home: no scrolling, button on screen`, !l.scrolls && !l.overflowX && !l.nameClipped && l.open?.bottom <= l.vh, JSON.stringify(l));
  // Next to each other: side by side from 640 px wide (same row), else Talk live right under it.
  const side = viewport.width >= 640;
  check(`${name} home: Talk live next to Open camera, on screen`, l.live && l.live.bottom <= l.vh && (side ? Math.abs(l.live.top - l.open.top) <= 2 && l.live.h === l.open.h : l.live.top >= l.open.bottom), JSON.stringify({ open: l.open, live: l.live }));
  await page.screenshot({ path: join(OUT, `${name}-home.png`) });
  if (mobile) await page.getByTestId("open-camera").tap();
  else await page.keyboard.press("Enter"); // focus starts on Open camera
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(2500);
  l = await layout(page);
  check(`${name} camera screen: no scrolling, Stop on screen`, !l.scrolls && !l.overflowX && l.stop?.bottom <= l.vh, JSON.stringify({ ...l, actions: undefined }));
  check(`${name} camera screen: Talk live beside Stop, on screen, at least 48 px`, l.liveActive && l.liveActive.bottom <= l.vh && l.liveActive.h >= 48, JSON.stringify({ stop: l.stop, live: l.liveActive }));
  check(`${name} camera screen: every action on screen, at least 48 px`, l.actions.length === 5 && actionsOk(l, viewport.width), JSON.stringify(l.actions));
  await page.screenshot({ path: join(OUT, `${name}-active.png`) });
  if (!mobile) {
    await page.keyboard.press("KeyC");
    check(`${name}: the C key stops assistance`, !!(await until(() => page.getByTestId("open-camera").isVisible(), 3000)));
  }
  check(`${name}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2b. Largest text size: the actions go to one column, each with its whole label ------------------
{
  const { ctx, page, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await withLang(ctx, "fr", { "assistant.consent.v3": "1" }, { autoDescribe: true, textScale: 2 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("open-camera").tap();
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(1500);
  const l = await layout(page);
  const lefts = await page.evaluate(() => [...document.querySelectorAll("[data-testid=actions] button")].map((b) => Math.round(b.getBoundingClientRect().left)));
  const cut = await page.evaluate(() => [...document.querySelectorAll("[data-testid=actions] button span")].filter((s) => s.scrollWidth > s.clientWidth + 1).length);
  check("text size 200%: one column of actions, no label cut off", new Set(lefts).size === 1 && cut === 0 && !l.overflowX, JSON.stringify({ lefts, cut }));
  await page.screenshot({ path: join(OUT, "phone-active-large-text.png"), fullPage: true });
  check("text size 200%: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2c. The page's language before React runs, and no hydration errors ------------------------------
{
  const html = await (await fetch(BASE)).text();
  check("server HTML: <html lang=\"ar-TN\" dir=\"rtl\"> (the default language)", /<html[^>]*\blang="ar-TN"[^>]*\bdir="rtl"/.test(html) || /<html[^>]*\bdir="rtl"[^>]*\blang="ar-TN"/.test(html), html.slice(0, 200));
  for (const [name, saved, want] of [["nothing saved", null, "ar-TN rtl"], ["saved English", { volume: 0.6, language: "en" }, "en ltr"], ["saved French", { language: "fr" }, "fr ltr"], ["saved Standard Arabic", { language: "ar" }, "ar rtl"], ["saved invalid", { language: "de" }, "ar-TN rtl"]]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript((saved) => {
      if (saved) localStorage.setItem("assistant.settings", JSON.stringify(saved));
      // What <html> says when the document is parsed, before the page's own scripts (React) run.
      document.addEventListener("DOMContentLoaded", () => (window.__langAtParse = `${document.documentElement.lang} ${document.documentElement.dir}`));
    }, saved);
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await page.goto(BASE, { waitUntil: "networkidle" });
    await sleep(500);
    const atParse = await page.evaluate(() => window.__langAtParse);
    const after = await htmlLang(page);
    const app = await page.evaluate(() => `${document.querySelector(".app").lang} ${document.querySelector(".app").dir}`);
    const stored = await page.evaluate(() => localStorage.getItem("assistant.settings"));
    check(`${name}: <html> is "${want}" before React runs and after, matching the screen, and nothing is written`, atParse === want && after === want && app === want && stored === (saved ? JSON.stringify(saved) : null), JSON.stringify({ atParse, after, app, stored }));
    check(`${name}: no console errors (no hydration mismatch)`, consoleErrors.length === 0, consoleErrors.join(" | "));
    await ctx.close();
  }
}

// --- 3. Reduced motion, light theme ----------------------------------------------------------------
{
  const { ctx, page } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: "reduce" });
  await withLang(ctx, "ar", { theme: "light" });
  await page.goto(BASE, { waitUntil: "networkidle" });
  const t = await page.evaluate(() => getComputedStyle(document.querySelector(".open-camera")).transitionDuration);
  check("reduced motion: no transitions", /^0s/.test(t), t);
  await page.screenshot({ path: join(OUT, "phone-home-light-ar.png") });
  await ctx.close();
}

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed; screenshots in ${OUT}`);
process.exit(passed === results.length ? 0 : 1);
