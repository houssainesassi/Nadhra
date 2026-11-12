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
    vh: innerHeight, open: box(".open-camera"), stop: box(".stop-button"), stage: box(".stage"),
  };
});
const withLang = (ctx, language, extra = {}) => ctx.addInitScript(({ language, extra }) => {
  if (!localStorage.getItem("assistant.settings")) localStorage.setItem("assistant.settings", JSON.stringify({ language }));
  for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
}, { language, extra });
const focused = (page) => page.evaluate(() => document.activeElement?.dataset.testid);

// --- 1. The whole flow on a phone ----------------------------------------------------------------
{
  const { ctx, page, state, errors } = await context({ width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await withLang(ctx, "en");
  await page.goto(BASE, { waitUntil: "networkidle" });
  let l = await layout(page);
  check("phone home: no scrolling, the name isn't cut off", !l.scrolls && !l.overflowX && !l.nameClipped, JSON.stringify(l));
  check("phone home: Open camera is large and on screen", l.open && l.open.h >= 150 && l.open.bottom <= l.vh, JSON.stringify(l.open));
  check("phone home: Open camera has focus", (await focused(page)) === "open-camera");
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
  check("phone camera screen: no scrolling, Stop on screen, preview fills most of it", !l.scrolls && l.stop?.bottom <= l.vh && l.stage?.h / l.vh > 0.6, JSON.stringify(l));
  await page.screenshot({ path: join(OUT, "phone-active.png") });
  const urgent = await until(async () => { const p = page.locator('[data-testid="last-spoken"][data-urgent="true"]'); return (await p.count()) ? p.first().innerText() : null; }, 25_000, 50);
  check("a stairs warning is shown as urgent", !!urgent);
  check("and spoken", state.tts.some((t) => /stair/i.test(t.text ?? "")));
  await page.screenshot({ path: join(OUT, "phone-warning.png") });

  await page.getByTestId("stop-assistance").click();
  check("Stop returns to the home screen", await page.getByTestId("open-camera").isVisible());
  check("Stop releases every camera track", await page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((t) => t.readyState === "ended")));
  check("focus is back on Open camera", (await focused(page)) === "open-camera");

  await page.getByTestId("language").selectOption("tn");
  await sleep(300);
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
  await page.screenshot({ path: join(OUT, "phone-active-tn.png") });

  await page.getByTestId("open-settings").click();
  check("Settings holds live conversation, voice commands, consent withdrawal and the emergency contact", (await page.getByRole("dialog", { name: "Settings" }).isVisible()) && (await page.getByTestId("live-toggle").count()) === 1 && (await page.getByTestId("voice-commands").count()) === 1 && (await page.getByTestId("withdraw-consent").count()) === 1);
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
  await withLang(ctx, "fr", { "assistant.consent.v2": "1" });
  await page.goto(BASE, { waitUntil: "networkidle" });
  let l = await layout(page);
  check(`${name} home: no scrolling, button on screen`, !l.scrolls && !l.overflowX && !l.nameClipped && l.open?.bottom <= l.vh, JSON.stringify(l));
  await page.screenshot({ path: join(OUT, `${name}-home.png`) });
  if (mobile) await page.getByTestId("open-camera").tap();
  else await page.keyboard.press("Enter"); // focus starts on Open camera
  await until(() => page.locator('.stage[data-on="true"]').count());
  await sleep(2500);
  l = await layout(page);
  check(`${name} camera screen: no scrolling, Stop on screen`, !l.scrolls && !l.overflowX && l.stop?.bottom <= l.vh, JSON.stringify(l));
  await page.screenshot({ path: join(OUT, `${name}-active.png`) });
  if (!mobile) {
    await page.keyboard.press("KeyC");
    check(`${name}: the C key stops assistance`, !!(await until(() => page.getByTestId("open-camera").isVisible(), 3000)));
  }
  check(`${name}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
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
