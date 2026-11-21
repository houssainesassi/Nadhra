// Camera and microphone controls in real Chromium, on the production build: the full-screen camera
// (on by itself, exit and back), front/back camera switching (Chromium's two fake cameras), and the
// microphone button in a live conversation (tracks really stop and start again, nothing is sent
// while muted, the conversation and camera go on) and with voice commands. Phone portrait and
// landscape, a small phone with large text, desktop, Derja (right to left), and a one-camera device.
// Fake Gemini Live WebSocket and mocked token / TTS / vision routes: no Gemini quota, nothing sent.
//
//   npm run build && npx next start -p 3100
//   node e2e/controls.mjs [base=http://localhost:3100] [screenshots=e2e/live/out/controls]
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = process.argv[3] ?? "e2e/live/out/controls";
mkdirSync(OUT, { recursive: true });
const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
// A silent microphone: Chromium's default fake microphone beeps, which would count as speech.
const mic = join(OUT, "silence.wav");
if (!existsSync(mic)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-t", "300", "-i", "anullsrc=r=16000:cl=mono", mic]);
const silenceMp3 = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-t", "0.2", "-i", "anullsrc=r=24000:cl=mono", "-f", "mp3", "-"]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const launch = (cameras) => chromium.launch({
  executablePath,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", `--use-fake-device-for-media-stream=device-count=${cameras}`, `--use-file-for-fake-audio-capture=${mic}`],
});

async function context(browser, viewport, { language = "en", settings = {}, ...extra } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"], ...extra });
  await ctx.addInitScript(({ language, settings }) => {
    localStorage.setItem("assistant.consent.v3", "1");
    localStorage.setItem("assistant.liveConsent.v1", "1");
    if (!localStorage.getItem("assistant.settings")) localStorage.setItem("assistant.settings", JSON.stringify({ language, ...settings }));
    window.__tracks = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__tracks.push(...s.getTracks()); return s; };
  }, { language, settings });
  await ctx.route("**/api/tts", (route) => route.request().method() !== "POST"
    ? route.fulfill({ json: { configured: true, voice: "mock", languageCode: "en-US" } })
    : route.fulfill({ body: silenceMp3, contentType: "audio/mpeg" }));
  await ctx.route("**/api/vision", (route) => route.request().method() !== "POST"
    ? route.fulfill({ json: { available: true, providers: [{ id: "mock", label: "Mock" }], canTranscribe: false } })
    : route.fulfill({ json: { analysis: { spoken: "A table ahead.", changed: true, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false }, provider: "mock", latencyMs: 1 } }));
  await ctx.route("**/api/report", (route) => route.fulfill({ json: { accepted: 0 } }));
  await ctx.route("**/api/live/token", (route) => route.fulfill({ json: {
    token: "auth_tokens/fake", url: "wss://generativelanguage.googleapis.com/ws/fake", setup: { model: "models/fake-live" }, model: "fake-live", voice: "Sulafat", lastModel: true, pricing: null,
  } }));
  const fake = { connections: 0, frames: 0, audio: 0, streamEnds: 0 };
  await ctx.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    fake.connections++;
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.setup) return ws.send(JSON.stringify({ setupComplete: {} }));
      const ri = m.realtimeInput;
      if (ri?.video) fake.frames++;
      if (ri?.audio) fake.audio++;
      if (ri?.audioStreamEnd) fake.streamEnds++;
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.getByTestId("talk-nadhra").waitFor();
  // Hydrated: the page focuses its main button once it is running (a key pressed earlier is lost).
  await until(() => page.evaluate(() => document.activeElement?.dataset?.testid === "talk-nadhra"), 10_000);
  return { ctx, page, fake, errors };
}

const stage = (page, attr) => page.getByTestId("stage").getAttribute(attr);
const tracks = (page) => page.evaluate(() => window.__tracks.map((t) => ({ kind: t.kind, state: t.readyState, id: t.getSettings().deviceId })));
const liveTracks = async (page, kind) => (await tracks(page)).filter((t) => t.kind === kind && t.state === "live");

/** Where everything is, and whether it fits: no scrolling, nothing off screen, controls don't overlap. */
const geometry = (page) => page.evaluate(() => {
  const r = (el) => { if (!el || !el.checkVisibility()) return null; const b = el.getBoundingClientRect(); return b.width > 1 ? { top: b.top, bottom: b.bottom, left: b.left, right: b.right, w: b.width, h: b.height } : null; };
  const q = (sel) => r(document.querySelector(sel));
  const ids = ["fullscreen-toggle", "mic-toggle", "stop-assistance", "switch-camera"];
  const buttons = Object.fromEntries(ids.map((id) => [id, q(`[data-testid=${id}]`)]).filter(([, b]) => b));
  const overlap = (a, b) => a && b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const list = Object.entries(buttons);
  const clashes = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) if (overlap(list[i][1], list[j][1])) clashes.push(`${list[i][0]}×${list[j][0]}`);
  const caption = q(".caption-box");
  const pills = q(".stage-pills");
  for (const [id, b] of list) {
    if (overlap(caption, b)) clashes.push(`caption×${id}`);
    if (id !== "fullscreen-toggle" && overlap(pills, b)) clashes.push(`pills×${id}`);
  }
  // Each pill against the exit-full-screen button (they share the top row).
  for (const p of document.querySelectorAll(".stage-pills .pill")) {
    if (overlap(r(p), buttons["fullscreen-toggle"])) clashes.push("pill×fullscreen-toggle");
    if (p.scrollWidth > p.clientWidth + 1) clashes.push("pill text overflows");
  }
  const off = list.filter(([, b]) => b.left < -0.5 || b.top < -0.5 || b.right > innerWidth + 0.5 || b.bottom > innerHeight + 0.5).map(([id]) => id);
  const small = list.filter(([, b]) => b.w < 44 || b.h < 44).map(([id]) => id);
  const app = document.querySelector(".app");
  return {
    vw: innerWidth, vh: innerHeight, stage: q(".stage"), video: q(".stage video"), endBar: q(".end-bar"), caption, buttons: Object.keys(buttons), clashes, off, small,
    scrolls: document.documentElement.scrollHeight > innerHeight + 1 || document.documentElement.scrollWidth > innerWidth + 1 || app.scrollWidth > app.clientWidth + 1,
    labelCut: [...document.querySelectorAll(".end-button span")].some((e) => e.scrollWidth > e.clientWidth + 1),
    // A word of End's label broken in the middle ("conversatio-n"): more lines than words would need.
    wordBroken: (() => { const sp = document.querySelector(".end-button span"); if (!sp) return false; const range = document.createRange(); range.selectNodeContents(sp);
      const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size; return lines > sp.textContent.trim().split(/\s+/).length; })(),
    browserFullscreen: !!document.fullscreenElement,
    videoTransform: getComputedStyle(document.querySelector(".stage video")).transform,
  };
});
const fills = (g) => !!g.stage && Math.abs(g.stage.left) < 1 && Math.abs(g.stage.top) < 1 && Math.abs(g.stage.w - g.vw) < 1 && Math.abs(g.stage.h - g.vh) < 1;
const fits = (name, g, extra = "") => check(`${name}: controls on screen, ≥ 44 px, no overlap, no scrolling, End's label not cut${extra}`, !g.off.length && !g.small.length && !g.clashes.length && !g.scrolls && !g.labelCut && !g.wordBroken, JSON.stringify({ off: g.off, small: g.small, clashes: g.clashes, scrolls: g.scrolls, labelCut: g.labelCut, wordBroken: g.wordBroken }));

// --- 1. phone, live conversation ------------------------------------------------------------------
let browser = await launch(2);
{
  // Subtitles on (off by default since 2026-11-21): these checks measure where the captions sit.
  const { page, fake, errors, ctx } = await context(browser, { width: 390, height: 844 }, { isMobile: true, hasTouch: true, deviceScaleFactor: 2, settings: { subtitles: true } });
  await page.getByTestId("talk-nadhra").tap();
  check("phone live: the conversation opens", !!(await until(async () => (await stage(page, "data-live-status")) === "open")));
  await until(async () => (await stage(page, "data-camera")) === "on");
  await until(() => page.getByTestId("switch-camera").isVisible(), 3000);
  let g = await geometry(page);
  check("phone live: full screen by itself — the camera fills the whole screen", (await page.getByTestId("app").getAttribute("data-full")) === "true" && fills(g) && g.video && Math.abs(g.video.h - g.vh) < 1, JSON.stringify({ stage: g.stage, video: g.video }));
  check("phone live: microphone, End, switch camera and exit full screen are on screen", ["fullscreen-toggle", "mic-toggle", "stop-assistance", "switch-camera"].every((b) => g.buttons.includes(b)), g.buttons.join(","));
  fits("phone live", g);
  check("phone live: captions sit above the buttons", g.caption && g.endBar && g.caption.bottom <= g.endBar.top + 0.5, JSON.stringify({ caption: g.caption, endBar: g.endBar }));
  check("phone live: focus on End", (await page.evaluate(() => document.activeElement?.dataset?.testid)) === "stop-assistance");
  await page.screenshot({ path: join(OUT, "phone-live-full.png") });

  // Microphone off: its track stops, nothing more is sent, the conversation and camera go on.
  const micBtn = page.getByTestId("mic-toggle");
  check("phone live: mic button starts on, named for what it does", (await micBtn.getAttribute("data-muted")) === "false" && (await micBtn.getAttribute("aria-label")) === "Mute microphone");
  check("phone live: one microphone track live", (await liveTracks(page, "audio")).length === 1);
  await until(() => fake.audio > 5, 5000);
  await micBtn.tap();
  check("phone live: muted — the button and the pill say so", !!(await until(async () => (await micBtn.getAttribute("data-muted")) === "true" && (await micBtn.getAttribute("aria-label")) === "Unmute microphone" && (await page.getByTestId("mic-status").innerText()).includes("Mic off"), 3000)));
  check("phone live: muted — the microphone track is stopped (the browser's indicator goes off)", !!(await until(async () => (await liveTracks(page, "audio")).length === 0, 3000)));
  check("phone live: muted — Gemini is told the audio stream paused", !!(await until(() => fake.streamEnds === 1, 3000)), `streamEnds=${fake.streamEnds}`);
  await sleep(300);
  const sentAtMute = fake.audio;
  const framesAtMute = fake.frames;
  await sleep(2500);
  check("phone live: muted — no audio is sent", fake.audio === sentAtMute, `${sentAtMute} → ${fake.audio}`);
  check("phone live: muted — the conversation, the camera and its pictures go on", (await stage(page, "data-live-status")) === "open" && (await liveTracks(page, "video")).length === 1 && fake.frames > framesAtMute && fake.connections === 1, `frames ${framesAtMute} → ${fake.frames}, connections ${fake.connections}`);
  await page.screenshot({ path: join(OUT, "phone-live-muted.png") });
  await micBtn.tap();
  check("phone live: unmuted — a new microphone track is live", !!(await until(async () => (await liveTracks(page, "audio")).length === 1, 3000)));
  check("phone live: unmuted — audio flows again, same connection", !!(await until(() => fake.audio > sentAtMute + 5, 4000)) && fake.connections === 1, `audio ${sentAtMute} → ${fake.audio}`);
  check("phone live: unmuted — button back on", (await micBtn.getAttribute("data-muted")) === "false");
  await page.keyboard.press("KeyM");
  check("phone live: the M key mutes too", !!(await until(async () => (await micBtn.getAttribute("data-muted")) === "true", 2000)));
  await page.keyboard.press("KeyM");
  await until(async () => (await micBtn.getAttribute("data-muted")) === "false", 2000);

  // Front/back camera: the other fake camera, one camera open at a time, the conversation goes on.
  const before = (await liveTracks(page, "video"))[0]?.id;
  await page.getByTestId("switch-camera").tap();
  const switched = await until(async () => { const v = await liveTracks(page, "video"); return v.length === 1 && v[0].id !== before && (await stage(page, "data-switching")) === "false" ? v[0].id : null; }, 6000);
  check("phone live: switch camera opens the other camera, the first is released", !!switched, JSON.stringify(await tracks(page)));
  const framesAtSwitch = fake.frames;
  check("phone live: after the switch the pictures keep going to the same conversation", !!(await until(() => fake.frames > framesAtSwitch, 12_000)) && fake.connections === 1 && (await stage(page, "data-live-status")) === "open");
  check("phone live: microphone still on after the switch", (await liveTracks(page, "audio")).length === 1);
  await page.getByTestId("switch-camera").tap();
  check("phone live: switch again → back to the first camera", !!(await until(async () => { const v = await liveTracks(page, "video"); return v.length === 1 && v[0].id === before; }, 6000)));

  // Out of full screen and back: the session goes on.
  await page.getByTestId("fullscreen-toggle").tap();
  await until(async () => (await page.getByTestId("app").getAttribute("data-full")) === "false", 2000);
  g = await geometry(page);
  check("phone live: exit full screen → the framed view, End below the camera, session still on", !fills(g) && g.stage && g.endBar && g.endBar.top >= g.stage.bottom - 0.5 && (await stage(page, "data-live-status")) === "open" && (await page.getByTestId("fullscreen-toggle").getAttribute("aria-label")) === "Full-screen camera", JSON.stringify({ stage: g.stage, endBar: g.endBar }));
  fits("phone framed", g);
  await page.screenshot({ path: join(OUT, "phone-live-framed.png") });
  await page.getByTestId("fullscreen-toggle").tap();
  check("phone live: full screen again", !!(await until(async () => fills(await geometry(page)), 2000)));

  // Landscape.
  await page.setViewportSize({ width: 844, height: 390 });
  await sleep(400);
  g = await geometry(page);
  check("phone landscape: still the whole screen", fills(g), JSON.stringify(g.stage));
  check("phone landscape: the buttons beside the captions, not over them", g.endBar && g.caption && (g.caption.right <= g.endBar.left + 0.5 || g.caption.left >= g.endBar.right - 0.5), JSON.stringify({ caption: g.caption, endBar: g.endBar }));
  fits("phone landscape", g);
  await page.screenshot({ path: join(OUT, "phone-landscape-full.png") });
  await page.getByTestId("fullscreen-toggle").tap();
  await sleep(400);
  g = await geometry(page);
  fits("phone landscape framed", g);
  await page.screenshot({ path: join(OUT, "phone-landscape-framed.png") });
  await page.setViewportSize({ width: 390, height: 844 });

  // End: everything is released.
  await page.getByTestId("stop-assistance").tap();
  check("phone live: End → home, every camera and microphone track stopped", !!(await until(async () => (await page.getByTestId("talk-nadhra").isVisible()) && (await tracks(page)).every((t) => t.state === "ended"), 4000)), JSON.stringify(await tracks(page)));
  check("phone live: End → not full screen any more", (await page.getByTestId("app").getAttribute("data-full")) === "false" && !(await page.evaluate(() => !!document.fullscreenElement)));
  // The next session opens full screen again, with the camera that was in use.
  await page.getByTestId("talk-nadhra").tap();
  check("phone live: the next session opens full screen again", !!(await until(async () => (await stage(page, "data-live-status")) === "open" && fills(await geometry(page)), 6000)));
  await page.getByTestId("stop-assistance").tap();
  await until(() => page.getByTestId("talk-nadhra").isVisible(), 4000);
  check("phone live: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2. desktop, camera with voice commands (no live conversation) ---------------------------------
{
  const { page, errors, ctx } = await context(browser, { width: 1280, height: 800 });
  await page.keyboard.press("KeyC"); // camera + voice commands
  await until(async () => (await stage(page, "data-camera")) === "on", 6000);
  await until(() => page.getByTestId("switch-camera").isVisible(), 3000);
  let g = await geometry(page);
  check("desktop camera: full screen, camera fills the window", fills(g), JSON.stringify(g.stage));
  console.log(`      (browser full screen: ${g.browserFullscreen ? "entered" : "not granted — the page still fills the window"})`);
  check("desktop camera: a webcam facing the user is shown as a mirror", (await stage(page, "data-mirror")) === "true" && g.videoTransform.startsWith("matrix(-1"), g.videoTransform);
  fits("desktop camera", g);
  await page.screenshot({ path: join(OUT, "desktop-full.png") });
  const micBtn = page.getByTestId("mic-toggle");
  const vc0 = await stage(page, "data-voice-commands");
  await micBtn.click();
  const vc1 = await until(async () => { const v = await stage(page, "data-voice-commands"); return v !== vc0 ? v : null; }, 2000);
  check("desktop camera: mic button turns the voice commands off/on; the camera stays on", !!vc1 && (await stage(page, "data-camera")) === "on", `${vc0} → ${vc1}`);
  check("desktop camera: button state follows", (await micBtn.getAttribute("data-muted")) === String(vc1 !== "true"));
  if (vc1 === "false") check("desktop camera: muted → no microphone track live", !!(await until(async () => (await liveTracks(page, "audio")).length === 0, 3000)), JSON.stringify(await tracks(page)));
  await micBtn.click();
  check("desktop camera: mic button again restores", !!(await until(async () => (await stage(page, "data-voice-commands")) === vc0, 2000)));
  await page.getByTestId("switch-camera").click();
  check("desktop camera: switch to the second webcam", !!(await until(async () => { const v = await liveTracks(page, "video"); return v.length === 1 && (await stage(page, "data-switching")) === "false" && (await tracks(page)).filter((t) => t.kind === "video").length === 2; }, 6000)));
  await page.getByTestId("fullscreen-toggle").click();
  await until(async () => (await page.getByTestId("app").getAttribute("data-full")) === "false", 2000);
  g = await geometry(page);
  check("desktop: exit full screen → framed view, browser full screen left", !fills(g) && !g.browserFullscreen);
  fits("desktop framed", g);
  await page.screenshot({ path: join(OUT, "desktop-framed.png") });
  await page.getByTestId("stop-assistance").click();
  check("desktop: Stop → every track stopped", !!(await until(async () => (await tracks(page)).every((t) => t.state === "ended"), 4000)));
  check("desktop: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 3. Derja (right to left), small phone with large text ------------------------------------------
for (const [name, viewport, opts] of [
  ["Derja phone", { width: 390, height: 844 }, { language: "tn" }],
  ["small phone, text 150%", { width: 320, height: 568 }, { settings: { textScale: 1.5 } }],
  ["small phone landscape, text 150%", { width: 568, height: 320 }, { settings: { textScale: 1.5 } }],
]) {
  const { page, errors, ctx } = await context(browser, viewport, { isMobile: true, hasTouch: true, ...opts });
  await page.getByTestId("talk-nadhra").tap();
  await until(async () => (await stage(page, "data-live-status")) === "open", 6000);
  await until(() => page.getByTestId("switch-camera").isVisible(), 3000);
  await sleep(300);
  const g = await geometry(page);
  check(`${name}: full screen`, fills(g), JSON.stringify(g.stage));
  fits(name, g);
  if (opts.language === "tn") check("Derja: the buttons are named in Derja", (await page.getByTestId("mic-toggle").getAttribute("aria-label")) === "سكّر الميكرو" && (await page.getByTestId("switch-camera").getAttribute("aria-label")).startsWith("بدّل"));
  await page.screenshot({ path: join(OUT, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`) });
  await page.getByTestId("stop-assistance").tap();
  check(`${name}: no page errors`, errors.length === 0, errors.join(" | "));
  await ctx.close();
}
await browser.close();

// --- 4. one camera only ---------------------------------------------------------------------------
browser = await launch(1);
{
  const { page, errors, ctx } = await context(browser, { width: 390, height: 844 }, { isMobile: true, hasTouch: true });
  await page.getByTestId("talk-nadhra").tap();
  await until(async () => (await stage(page, "data-live-status")) === "open", 6000);
  await sleep(800);
  const g = await geometry(page);
  check("one camera: no switch button; microphone, End and exit full screen remain", !g.buttons.includes("switch-camera") && ["mic-toggle", "stop-assistance", "fullscreen-toggle"].every((b) => g.buttons.includes(b)), g.buttons.join(","));
  fits("one camera", g);
  await page.getByTestId("stop-assistance").tap();
  check("one camera: no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}
await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
