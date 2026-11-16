// The one-screen layout in real Chromium. Home: «Asslema» and exactly three buttons (Camera,
// Microphone, Settings). Camera → consent → camera session (one button only) → warning → Stop;
// Microphone → live notice → live session (one button only); language in Settings; no scrolling at
// phone, tablet and desktop sizes; focus; reduced motion.
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
  const box = (sel) => { const el = document.querySelector(sel); if (!el || el.hidden) return null; const r = el.getBoundingClientRect(); return r.width ? { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), h: Math.round(r.height), w: Math.round(r.width) } : null; };
  const brand = document.querySelector(".home-brand");
  return {
    scrolls: document.documentElement.scrollHeight > innerHeight + 1 || app.scrollHeight > app.clientHeight + 1,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    nameClipped: !!brand && brand.scrollWidth > brand.clientWidth + 1,
    vh: innerHeight, open: box(".tile-camera"), live: box(".tile-mic"), settings: box(".settings-button"), stop: box(".end-button"), stage: box(".stage"),
    // Every control drawn on the main screen (panels excluded; screen-reader-only ones are 1 px).
    buttons: [...document.querySelectorAll(".app button, .app a, .app select, .app input")].filter((b) => b.checkVisibility() && b.getBoundingClientRect().width > 1 && b.getBoundingClientRect().height > 1).map((b) => b.dataset.testid ?? b.textContent.trim()),
    labelsCut: [...document.querySelectorAll(".tile-label, .end-button span")].filter((e) => e.scrollWidth > e.clientWidth + 1).length,
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
const HOME = "open-camera,live-toggle,open-settings";
const tapOk = (b) => b && b.h >= 48 && b.w >= 48;
// axe-core, when supplied (AXE=/path/to/axe.min.js), checks the camera screen for automated violations.
const AXE_SRC = process.env.AXE ? readFileSync(process.env.AXE, "utf8") : null;
const axe = async (page) => {
  if (!(await page.evaluate(() => !!window.axe))) await page.addScriptTag({ content: AXE_SRC });
  return page.evaluate(async () => (await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "best-practice"] })).violations.map((x) => `${x.id}: ${x.nodes.length}`));
};

// --- 0. By default, no picture leaves the phone by itself -------------------------------------------
{
  const { page, state, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await withLang(page.context(), "en", {}, {});
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("open-camera").click();
  await page.getByRole("button", { name: "I agree", exact: true }).click();
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(5000);
  check("default: no picture is sent automatically after Camera", state.posts === 0, `${state.posts} sent`);
  check("default: the screen says it describes when asked", (await page.getByTestId("stage").getAttribute("data-analysis")) === "manual");
  check("default: the user hears that automatic descriptions are off, and what that means", state.tts.some((t) => /Automatic descriptions are off/.test(t.text ?? "")), state.tts.map((t) => t.text).join(" | "));
  check("default: no page errors", errors.length === 0, errors.join(" | "));
  await page.context().close();
}

// --- 0b. Microphone: the live conversation asks first, then only the assistant is on screen ---------
{
  const { page, errors, state } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await withLang(page.context(), "en", { "assistant.consent.v3": "1" });
  let tokens = 0;
  // Answered late (then refused), so the "connecting" session can be looked at meanwhile.
  await page.context().route("**/api/live/token", async (route) => { tokens++; await sleep(4000); await route.fulfill({ status: 503, json: { error: "test" } }).catch(() => {}); });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("live-toggle").tap();
  await sleep(1500);
  check("live: the first press only asks (the button now says «I agree»)", (await page.getByTestId("live-toggle").innerText()).includes("I agree: start the live conversation"));
  check("live: nothing requested before the answer", tokens === 0, `${tokens} token requests`);
  check("live: still home while it asks (no popup)", (await page.locator("dialog[open]").count()) === 0 && (await layout(page)).buttons.join(",") === HOME);
  await page.getByTestId("live-toggle").tap();
  check("live: the second press starts it", !!(await until(() => tokens > 0, 5000)));
  check("live: the session screen shows at once, with the voice orb", !!(await until(() => page.locator("[data-testid=voice-orb]").isVisible(), 3000)) && (await page.getByTestId("stage").isVisible()));
  const l = await layout(page);
  check("live: only one button on screen, End live conversation", l.buttons.join(",") === "stop-assistance" && (await page.getByTestId("stop-assistance").innerText()).includes("End live conversation"), l.buttons.join(","));
  check("live: Camera, Microphone and Settings are gone", (await page.getByTestId("open-camera").count()) + (await page.getByTestId("live-toggle").count()) + (await page.getByTestId("open-settings").count()) === 0);
  check("live: focus on End", (await focused(page)) === "stop-assistance");
  await page.screenshot({ path: join(OUT, "phone-live.png") });
  await page.getByTestId("stop-assistance").tap();
  check("live: End goes back home, three buttons", !!(await until(async () => (await layout(page)).buttons.join(",") === HOME, 3000)));
  check("live: End releases every camera track", await page.evaluate(() => window.__tracks.every((t) => t.readyState === "ended")));
  check("live: Microphone pressed first: the phone doesn't say «Asslema» (the call's greeting is the one)", !state.tts.some((t) => /Asslema/.test(t.text ?? "")), state.tts.map((t) => t.text).join(" | "));
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
  check("phone home: exactly three buttons, Camera, Microphone, Settings, in that order", l.buttons.join(",") === HOME, l.buttons.join(","));
  check("phone home: the greeting is the page's heading", (await page.getByRole("heading", { level: 1 }).innerText()) === "Asslema");
  check("phone home: Camera is large and on screen", l.open && l.open.h >= 110 && l.open.bottom <= l.vh, JSON.stringify(l.open));
  check("phone home: Microphone right under Camera, as large", l.live && l.live.top >= l.open.bottom && l.live.top - l.open.bottom <= 24 && l.live.h === l.open.h, JSON.stringify({ open: l.open, live: l.live }));
  check("phone home: Settings on screen, at least 48 px", tapOk(l.settings) && l.settings.bottom <= l.vh, JSON.stringify(l.settings));
  check("phone home: Camera has focus", (await focused(page)) === "open-camera");
  check("phone home: nothing spoken before the first gesture (audio is locked then)", state.tts.length === 0, state.tts.map((t) => t.text).join(" | "));
  await page.keyboard.press("Tab");
  // A key press is a gesture: the welcome may be said now.
  const t1 = await focused(page);
  await page.keyboard.press("Tab");
  check("phone home: Tab goes Camera → Microphone → Settings", t1 === "live-toggle" && (await focused(page)) === "open-settings");
  check("phone home: Camera named by its word, described", await page.getByTestId("open-camera").evaluate((b) => b.innerText.split("\n")[0].trim() === "Camera" && document.getElementById(b.getAttribute("aria-describedby"))?.textContent === "Describes what’s around you"));
  check("phone home: Microphone named by its word, described with what goes to Gemini", (await page.getByRole("button", { name: "Microphone", exact: true }).count()) === 1 && await page.getByTestId("live-toggle").evaluate((b) => b.getAttribute("aria-describedby").split(" ").map((id) => document.getElementById(id)?.textContent).join(" ").includes("Google Gemini")));
  if (AXE_SRC) { const v = await axe(page); check("home: no automated accessibility violations (axe)", v.length === 0, v.join(" | ")); }
  await page.screenshot({ path: join(OUT, "phone-home.png") });

  await page.getByTestId("open-camera").tap();
  check("«Asslema» is said after the first gesture", !!(await until(() => state.tts.some((t) => /Asslema/.test(t.text ?? "")), 5000)), state.tts.map((t) => t.text).join(" | "));
  check("Camera without consent shows the notice first", await page.getByRole("dialog", { name: "Before the camera starts" }).isVisible());
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
  check("phone camera screen: only one button, Stop assistance", l.buttons.join(",") === "stop-assistance", l.buttons.join(","));
  check("phone camera screen: no scrolling, Stop on screen, the preview takes most of it", !l.scrolls && l.stop?.bottom <= l.vh && tapOk(l.stop) && l.stage?.h / l.vh > 0.7, JSON.stringify(l));
  check("phone camera screen: no voice orb (that's the live conversation)", (await page.getByTestId("voice-orb").count()) === 0);
  if (AXE_SRC) { const v = await axe(page); check("camera screen: no automated accessibility violations (axe)", v.length === 0, v.join(" | ")); }
  else console.log("SKIP  axe (set AXE=/path/to/axe.min.js)");
  await page.screenshot({ path: join(OUT, "phone-active.png") });

  // TalkBack: the actions are screen-reader-only buttons, swiped to between the camera and End.
  const group = page.getByRole("group", { name: "Actions" });
  const names = ["Describe surroundings", "Read text", "Identify object", "Ask a question", "Pause descriptions"];
  const found = [];
  for (const n of names) found.push(await group.getByRole("button", { name: n, exact: true }).count());
  check("TalkBack: a named Actions group with the five actions, each named by its words", found.every((c) => c === 1), JSON.stringify(found));
  const order = await page.evaluate(() => [...document.querySelectorAll("[data-testid=stage], [data-testid=actions] button, [data-testid=stop-assistance]")].map((e) => e.dataset.testid));
  check("TalkBack: read in order camera → actions → End", order.join(",") === "stage,action-describe,action-read,action-identify,action-ask,action-pause,stop-assistance", order.join(","));
  check("TalkBack: Pause is told that warnings keep running", (await page.getByTestId("action-pause").evaluate((b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent)) === "Warnings keep running.");
  check("TalkBack: the actions draw nothing on screen", await page.locator("[data-testid=actions] button").evaluateAll((bs) => bs.every((b) => { const r = b.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; })));
  // A TalkBack double-tap is an accessibility click on the element itself (element.click()).
  let sent = state.posts;
  await page.getByTestId("action-describe").evaluate((b) => b.click());
  check("TalkBack: Describe sends one picture", !!(await until(() => state.posts > sent, 8000)), `${state.posts - sent} sent`);
  await page.getByTestId("action-pause").evaluate((b) => b.click());
  check("TalkBack: Pause pauses, and now says Resume", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-analysis")) === "paused" && (await page.getByTestId("action-pause").innerText()).includes("Resume descriptions"), 3000)));
  sent = state.posts;
  await page.getByTestId("action-identify").evaluate((b) => b.click());
  check("TalkBack: Identify sends a picture during the pause", !!(await until(() => state.posts > sent, 8000)));
  // The first Read gives the one-time document notice (spoken; «موافق» to go on) and sends nothing.
  await sleep(1500);
  sent = state.posts;
  const said = state.tts.length;
  await page.getByTestId("action-read").evaluate((b) => b.click());
  check("TalkBack: Read reaches the controller: the document notice first, nothing sent", !!(await until(() => state.tts.length > said, 5000)) && state.posts === sent, state.tts.slice(said).map((t) => t.text).join(" | "));
  await page.keyboard.press("Escape"); // stops the notice
  await page.getByTestId("action-pause").evaluate((b) => b.click());
  check("TalkBack: Resume resumes", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-analysis")) !== "paused", 3000)));
  await page.getByTestId("action-ask").evaluate((b) => b.click());
  await sleep(500);
  check("TalkBack: Ask keeps the hands-free microphone on", (await page.getByTestId("stage").getAttribute("data-voice-commands")) === "true");
  await page.getByTestId("stop-assistance").focus();
  await page.keyboard.press("Shift+Tab");
  const shown = await page.evaluate(() => { const b = document.activeElement; const r = b.getBoundingClientRect(); return { id: b.dataset.testid, w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; });
  check("keyboard: tabbing onto an action shows it, large and on screen", /^action-/.test(shown.id ?? "") && shown.h >= 48 && shown.w >= 200 && shown.bottom <= 844, JSON.stringify(shown));
  await page.getByTestId("stop-assistance").focus();

  // And by key (and by voice): the same controller calls.
  const before = state.posts;
  await page.keyboard.press("KeyD");
  check("D (Describe): sends one picture", !!(await until(() => state.posts > before, 8000)), `${state.posts - before} sent`);
  await page.keyboard.press("KeyP");
  check("P (Pause): pauses the descriptions, warnings keep running", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-analysis")) === "paused", 3000)) && (await page.getByTestId("stage").getAttribute("data-detector")) !== "off");
  const paused = state.posts;
  await sleep(3000);
  check("Pause: no automatic picture is sent while paused", state.posts === paused, `${state.posts - paused} sent`);
  await page.keyboard.press("KeyI");
  check("I (Identify): works during the pause", !!(await until(() => state.posts > paused, 8000)));
  await page.keyboard.press("KeyP");
  check("P again: resumes", !!(await until(async () => (await page.getByTestId("stage").getAttribute("data-analysis")) !== "paused", 3000)));
  const urgent = await until(async () => { const p = page.locator('[data-testid="last-spoken"][data-urgent="true"]'); return (await p.count()) ? p.first().innerText() : null; }, 25_000, 50);
  check("a stairs warning is shown as urgent", !!urgent);
  check("and spoken", state.tts.some((t) => /stair/i.test(t.text ?? "")));
  check("still only one button during the warning", (await layout(page)).buttons.join(",") === "stop-assistance");
  await page.screenshot({ path: join(OUT, "phone-warning.png") });

  await page.getByTestId("stop-assistance").click();
  check("Stop returns to the home screen, three buttons", !!(await until(async () => (await layout(page)).buttons.join(",") === HOME, 3000)));
  check("Stop releases every camera track", await page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === "ended")));
  check("focus is back on Camera", (await focused(page)) === "open-camera");
  check("«Asslema» was said once only", state.tts.filter((t) => /Asslema/.test(t.text ?? "")).length === 1);

  await page.getByTestId("open-settings").tap();
  const settings = page.getByRole("dialog", { name: "Settings" });
  check("Settings holds the language, Privacy & safety, voice commands and the emergency contact", (await settings.isVisible()) && (await settings.getByTestId("language").count()) === 1 && (await settings.getByTestId("open-privacy").count()) === 1 && (await settings.getByTestId("voice-commands").count()) === 1 && /Emergency contact/.test(await settings.innerText()));
  check("language: <html> is English, left to right, while English is chosen", (await htmlLang(page)) === "en ltr", await htmlLang(page));
  await settings.getByTestId("language").selectOption("tn");
  await sleep(300);
  check("language: <html> turns Tunisian and right to left at once, without a reload", (await htmlLang(page)) === "ar-TN rtl", await htmlLang(page));
  await page.keyboard.press("Escape");
  await sleep(300);
  const ui = await page.evaluate(() => ({ dir: document.querySelector(".app").dir, lang: document.querySelector(".app").lang, label: document.querySelector(".tile-camera").innerText, hello: document.querySelector("h1").innerText, saved: JSON.parse(localStorage.getItem("assistant.settings")).language }));
  check("language: the screen turns Tunisian and right to left", ui.dir === "rtl" && ui.lang === "ar-TN" && /الكاميرا/.test(ui.label) && ui.hello === "عسلامة", JSON.stringify(ui));
  check("language: saved for speech and recognition", ui.saved === "tn");
  check("language: the assistant says it in the new language", !!(await until(() => state.tts.some((t) => /[؀-ۿ]/.test(t.text ?? "")), 5000)));
  l = await layout(page);
  check("Tunisian home: no scrolling, three buttons", !l.scrolls && !l.overflowX && !l.nameClipped && l.buttons.join(",") === HOME && l.labelsCut === 0, JSON.stringify(l));
  await page.screenshot({ path: join(OUT, "phone-home-tn.png") });
  await page.getByTestId("open-camera").tap();
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(2500);
  l = await layout(page);
  check("Tunisian camera screen: no scrolling, one button in Derja", !l.scrolls && !l.overflowX && l.buttons.join(",") === "stop-assistance" && (await page.getByTestId("stop-assistance").innerText()).includes("وقّف"), JSON.stringify(l));
  if (AXE_SRC) { const v = await axe(page); check("Tunisian camera screen: no automated accessibility violations (axe, including html-has-lang and valid-lang)", v.length === 0, v.join(" | ")); }
  await page.screenshot({ path: join(OUT, "phone-active-tn.png") });
  await page.getByTestId("stop-assistance").tap();
  await until(() => page.getByTestId("open-settings").isVisible(), 3000);

  await page.getByTestId("open-settings").tap();
  await page.getByTestId("open-privacy").click();
  const privacy = page.getByRole("dialog", { name: "Privacy & safety" });
  check("Privacy & safety (from Settings) holds the experimental-version disclaimer", (await privacy.isVisible()) && /Silence doesn.t mean the way is safe/.test(await privacy.innerText()));
  await page.screenshot({ path: join(OUT, "phone-privacy.png") });
  await page.keyboard.press("Escape");
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
  check(`${name} home: no scrolling, all three buttons on screen, at least 48 px`, !l.scrolls && !l.overflowX && !l.nameClipped && l.buttons.join(",") === HOME && [l.open, l.live, l.settings].every((b) => tapOk(b) && b.bottom <= l.vh) && l.labelsCut === 0, JSON.stringify(l));
  // Side by side from 640 px wide (same row, same size), else Microphone right under Camera.
  const side = viewport.width >= 640;
  check(`${name} home: Microphone next to Camera, as large`, side ? Math.abs(l.live.top - l.open.top) <= 2 && l.live.h === l.open.h : l.live.top >= l.open.bottom, JSON.stringify({ open: l.open, live: l.live }));
  await page.screenshot({ path: join(OUT, `${name}-home.png`) });
  if (mobile) await page.getByTestId("open-camera").tap();
  else await page.keyboard.press("Enter"); // focus starts on Camera
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(2500);
  l = await layout(page);
  check(`${name} camera screen: no scrolling, only Stop, on screen, at least 48 px`, !l.scrolls && !l.overflowX && l.buttons.join(",") === "stop-assistance" && tapOk(l.stop) && l.stop.bottom <= l.vh && l.labelsCut === 0, JSON.stringify(l));
  await page.screenshot({ path: join(OUT, `${name}-active.png`) });
  if (!mobile) {
    await page.keyboard.press("KeyC");
    check(`${name}: the C key stops assistance`, !!(await until(() => page.getByTestId("open-camera").isVisible(), 3000)));
  }
  check(`${name}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2b. Largest text size: the tiles go to rows, every label whole ---------------------------------
{
  const { ctx, page, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await withLang(ctx, "fr", { "assistant.consent.v3": "1" }, { autoDescribe: true, textScale: 2 });
  await page.goto(BASE, { waitUntil: "networkidle" });
  let l = await layout(page);
  check("text size 200% home: one column, no label cut off, no sideways scroll", l.open.left === l.live.left && l.live.top >= l.open.bottom && l.labelsCut === 0 && !l.overflowX, JSON.stringify(l));
  await page.screenshot({ path: join(OUT, "phone-home-large-text.png"), fullPage: true });
  await page.getByTestId("open-camera").tap();
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(1500);
  l = await layout(page);
  check("text size 200% session: Stop whole and on screen", l.labelsCut === 0 && !l.overflowX && l.stop.bottom <= l.vh, JSON.stringify(l));
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
  const t = await page.evaluate(() => getComputedStyle(document.querySelector(".tile-camera")).transitionDuration);
  check("reduced motion: no transitions", /^0s/.test(t), t);
  await page.screenshot({ path: join(OUT, "phone-home-light-ar.png") });
  await ctx.close();
}

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed; screenshots in ${OUT}`);
process.exit(passed === results.length ? 0 : 1);
