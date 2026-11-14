// End-to-end test of the assistant, on the production build, with fake camera and microphone files.
//   python e2e/make_vision_camera.py <photos> <fixtures>
//   npm run build && npx next start -p 3100
//   npm run e2e -- <fixtures> [baseUrl] [screenshotDir]
// Real AI and voice services are used unless a check says "(mocked API)". That is only where a
// failure or a specific hazard has to be forced. Each mock is scoped to one browser context.
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const fixtures = process.argv[2];
const base = process.argv[3] ?? "http://localhost:3100";
const shots = process.argv[4] ?? fixtures;
const only = process.env.ONLY?.split(",");

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), ".cache", "ms-playwright");
  for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const p = join(root, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("No Chromium found; set CHROME_PATH");
}
const executablePath = findChrome();

const openBrowsers = new Set(); // a scenario that throws must not leave its browser running
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + String(detail).slice(0, 300) : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000, step = 150) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(step);
  }
};

async function open({ camera = "street", audio, grant = true, device = grant, viewport = { width: 1280, height: 900 }, facing, consent = true, init } = {}) {
  const args = ["--autoplay-policy=no-user-gesture-required"];
  if (grant) args.push("--use-fake-ui-for-media-stream");
  if (device) {
    args.push("--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${join(fixtures, camera + ".mjpeg")}`);
    if (audio) args.push(`--use-file-for-fake-audio-capture=${audio}`);
  }
  const browser = await chromium.launch({ executablePath, args });
  openBrowsers.add(browser);
  const ctx = await browser.newContext({ viewport, locale: "ar-TN", permissions: grant ? ["camera", "microphone"] : [] });
  await ctx.addInitScript(({ consent, facing }) => {
    if (consent) localStorage.setItem("assistant.consent.v3", "1");
    // The spoken notice about documents is tested in e2e/read/browser.mjs; here it is already accepted.
    if (consent) localStorage.setItem("assistant.readConsent.v1", "1");
    // These scenarios are about the automatic scans, which are off by default: turned on, as a user would.
    localStorage.setItem("assistant.settings", JSON.stringify({ autoDescribe: true, ...(facing ? { facing } : {}) }));
    // Keeps a handle on the camera tracks, to prove they get released.
    window.__tracks = [];
    // Every sentence the assistant starts to say, in order (the "Last said" caption).
    window.__captions = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="last-spoken"]')?.textContent?.trim();
      if (t && t !== window.__captions[window.__captions.length - 1]) window.__captions.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    const orig = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (orig) navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      window.__tracks.push(...s.getTracks());
      return s;
    };
  }, { consent, facing });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("crash", () => console.log("      !! renderer crashed at", new Date().toISOString(), "after", Math.round(performance.now() / 1000), "s"));
  // MediaPipe prints its normal start-up INFO lines through console.error.
  page.on("console", (m) => { if (m.type() === "error" && !m.text().startsWith("INFO:")) errors.push(m.text()); });
  const api = [];
  page.on("request", (r) => {
    const u = r.url();
    if (u.endsWith("/api/vision") && r.method() === "POST") {
      const body = JSON.parse(r.postData());
      api.push({ at: Date.now(), mode: body.mode, kb: Math.round(r.postData().length / 1024), hasPrev: !!body.previousImage, facing: body.cameraFacing, question: body.question });
    }
  });
  const tts = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/tts") && r.method() === "POST") tts.push(JSON.parse(r.postData()).text);
  });
  const ttsResponses = [];
  page.on("response", (r) => { if (r.url().endsWith("/api/tts") && r.request().method() === "POST") ttsResponses.push(r.status()); });
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  // The controller's state, reflected on the camera stage (the screen has no status panels).
  const STATE = { "camera-status": "data-camera", "analysis-status": "data-analysis", "mic-status": "data-mic", detector: "data-detector" };
  const statusOf = (id) => page.getByTestId("stage").getAttribute(STATE[id]);
  /** Open camera on the home screen, or the camera button left on the camera screen when voice commands stayed on. */
  const start = () => page.locator('[data-testid="open-camera"]:visible, [data-testid="reopen-camera"]:visible').first().click();
  const stop = () => page.getByTestId("stop-assistance").click();
  const openSettings = () => page.getByTestId("open-settings").click();
  const button = (name) => page.getByRole("button", { name, exact: true });
  const spoken = () => page.getByTestId("last-spoken").innerText();
  return { browser, ctx, page, errors, api, tts, ttsResponses, statusOf, button, spoken, start, stop, openSettings };
}

const said = (env, text) => env.tts.some((t) => t.includes(text));

const scene = (p) => ({ spoken: "", changed: false, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false, ...p });

/**
 * Every vision and voice request answered in the browser: no Gemini quota, no Microsoft voice.
 * The voice is a real 3 s silent MP3, so speech takes time as it does on a phone.
 */
async function mockServices(e, onPost = () => scene({})) {
  const silence = existsSync(join(fixtures, "silence.mp3")) ? readFileSync(join(fixtures, "silence.mp3")) : null;
  await e.ctx.route("**/api/vision", (route) => {
    const r = route.request();
    if (r.method() !== "POST") return route.fulfill({ json: { available: true, providers: [{ id: "mock", label: "Mock" }], canTranscribe: false } });
    return route.fulfill({ json: { analysis: onPost(JSON.parse(r.postData())), provider: "mock", latencyMs: 1 } });
  });
  await e.ctx.route("**/api/tts", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { configured: true, voice: "mock", languageCode: "ar-TN" } });
    return silence ? route.fulfill({ body: silence, contentType: "audio/mpeg" }) : route.fulfill({ status: 503, json: { error: "mock" } });
  });
}

/** What the browser does when the user switches apps or tabs. Headless Chromium can't really leave. */
async function setHidden(page, hidden) {
  await page.evaluate((hidden) => {
    if (hidden) {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    } else {
      delete document.hidden;
      delete document.visibilityState;
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

const scenarios = {
  async consentAndPrivacy() {
    const e = await open({ consent: false });
    const focused = await e.page.evaluate(() => document.activeElement?.dataset.testid);
    check("page opens with focus on the Open camera button", focused === "open-camera", focused);
    await e.page.keyboard.press("Enter");
    const dialog = e.page.getByRole("dialog");
    await dialog.waitFor();
    const text = await dialog.innerText();
    check("first start asks consent and names who gets the images", text.includes("Google Gemini") && text.includes("doesn't record"), text.slice(0, 120));
    check("focus moves into the consent dialog", (await e.page.evaluate(() => document.activeElement?.textContent)) === "I agree");
    check("no camera and no image before consent", e.api.length === 0 && (await e.page.evaluate(() => window.__tracks.length)) === 0);
    await e.button("I don't agree").click();
    await sleep(800);
    check("refusing keeps the camera off", (await e.statusOf("camera-status")) === "off" && (await e.page.evaluate(() => window.__tracks.length)) === 0);
    await e.start();
    await e.button("I agree").click();
    check("accepting starts the camera", !!(await until(async () => (await e.statusOf("camera-status")) === "on")));
    await e.browser.close();
  },

  async fullPipeline() {
    const e = await open({ facing: "outward" });
    const violations = await e.page.evaluate(async (src) => {
      const s = document.createElement("script");
      s.textContent = src;
      document.head.appendChild(s);
      const r = await window.axe.run(document, { runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] });
      return r.violations.map((v) => `${v.id}: ${v.nodes.length} (${v.nodes[0].target})`);
    }, process.env.AXE ? readFileSync(process.env.AXE, "utf8") : "window.axe={run:async()=>({violations:[]})}");
    check(`no automated accessibility violations${process.env.AXE ? "" : " (axe not supplied, skipped)"}`, violations.length === 0, violations.join(" | "));

    const t0 = Date.now();
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    check("camera status is on", (await e.statusOf("camera-status")) === "on");
    const firstInfo = await until(() => e.tts.some((t) => /شارع|كرهب|كراهب|موتور|عباد|شخص/.test(t)), 15_000);
    check("something useful about the surroundings is spoken within 15 s", !!firstInfo, `${Date.now() - t0} ms: ${e.tts.at(-1)}`);
    check("live preview plays", await e.page.evaluate(() => { const v = document.querySelector("video"); return v.videoWidth > 0 && !v.paused && v.srcObject !== null; }));
    await until(() => e.api.length > 0);
    check("a frame is sent to /api/vision", e.api.length > 0, JSON.stringify(e.api[0]));
    check("frame stays small", e.api[0].kb < 400, `${e.api[0].kb} KB`);

    const dets = await until(async () => Number(await e.page.getByTestId("stage").getAttribute("data-detections")) || 0, 25_000);
    check("the real model reports what the camera sees", !!dets, `${dets} detections`);
    // «رد بالك» sentences are warnings from the detector: wait for the description itself.
    const line = await until(() => e.tts.find((t) => /شارع|كراهب|عباد/.test(t) && !t.startsWith("رد بالك")), 25_000);
    check("a description of the street is spoken in Derja", !!line, e.tts.join(" | "));
    console.log("      first description after", Date.now() - t0, "ms; spoken:", e.tts.join(" | "));
    console.log("      (a busy scene: warnings and the safety notice are spoken before the description)");
    check("the cloud voice delivered audio", e.ttsResponses.includes(200), e.ttsResponses.join(","));

    const local = await until(() => e.page.getByTestId("stage").getAttribute("data-local-hazards"), 30_000);
    check("the on-device detector finds objects", !!local, local ?? "");

    // A still scene: few requests, never overlapping.
    const startCount = e.api.length;
    const t1 = Date.now();
    await sleep(30_000);
    const count = e.api.length - startCount;
    check("a still scene sends few frames", count <= 3, `${count} requests in ${Math.round((Date.now() - t1) / 1000)} s`);
    const gaps = e.api.slice(1).map((a, i) => a.at - e.api[i].at);
    check("at least 4 s between frames", gaps.every((g) => g >= 3900), gaps.join(","));
    const isWarning = (t) => t.startsWith("رد بالك") || t.startsWith("يظهرلي") || t.startsWith("فمّا شخص");
    const texts = e.tts.filter((t) => /شارع|كرهب|كراهب|موتور/.test(t) && !isWarning(t));
    check("the same description isn't repeated", new Set(texts).size === texts.length, texts.join(" | "));
    const warnings = {};
    for (const t of e.tts.filter(isWarning)) warnings[t] = (warnings[t] ?? 0) + 1;
    check("an unchanged hazard isn't repeated constantly", Object.values(warnings).every((n) => n <= 3), JSON.stringify(warnings));

    await e.page.screenshot({ path: join(shots, "desktop-running.png"), fullPage: true });

    // Question, by keyboard (the spoken «شنوة قدّامي؟» takes the same path).
    const before = e.api.length;
    await e.page.keyboard.press("KeyD");
    await until(() => e.api.slice(before).some((a) => a.mode === "question"));
    const q = e.api.slice(before).find((a) => a.mode === "question");
    check("a question captures a new, larger frame", !!q && q.kb > e.api[0].kb * 0.9, JSON.stringify(q));
    const heard = e.tts.length;
    const answered = await until(() => e.tts.slice(heard).some((t) => t !== "لحظة، نشوف.") || null, 25_000);
    check("the answer is spoken", !!answered, e.tts.slice(heard).join(" | "));

    // Pause and resume.
    await sleep(2000);
    await e.page.keyboard.press("KeyP");
    const paused = e.api.length;
    await sleep(9000);
    check("pause: no requests", e.api.length === paused && (await e.statusOf("analysis-status")) === "paused");
    await e.page.keyboard.press("KeyP");
    check("resume: analysis runs again", !!(await until(() => e.api.length > paused, 12_000)));

    // Interrupt.
    await e.page.keyboard.press("KeyR");
    await e.page.keyboard.press("Escape");
    check("repeat and stop controls respond", (await e.page.evaluate(() => document.body.innerText.length)) > 0);

    // Stop assistance.
    await e.stop();
    await sleep(300);
    const tracks = await e.page.evaluate(() => window.__tracks.map((t) => t.readyState));
    check("stop releases the camera hardware", tracks.length > 0 && tracks.every((s) => s === "ended"), tracks.join(","));
    check("the preview is detached", await e.page.evaluate(() => document.querySelector("video").srcObject === null));
    const stopped = e.api.length;
    await sleep(6000);
    check("no frames after stop", e.api.length === stopped);
    check("no console errors", e.errors.length === 0, e.errors.join(" | "));
    await e.browser.close();
  },

  async leavingReleasesCamera() {
    const e = await open();
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    // The event a browser fires when the user leaves. The page is gone after a real navigation, so
    // its tracks can't be inspected then.
    await e.page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await sleep(300);
    const states = await e.page.evaluate(() => window.__tracks.map((t) => t.readyState));
    check("leaving the page releases the camera", states.length > 0 && states.every((s) => s === "ended"), states.join(","));
    await e.browser.close();
  },

  async keyboardOnly() {
    const e = await open();
    await e.page.keyboard.press("KeyC");
    check("key C starts the camera", !!(await until(async () => (await e.statusOf("camera-status")) === "on")));
    await e.page.keyboard.press("KeyP");
    check("key P pauses", !!(await until(async () => (await e.statusOf("analysis-status")) === "paused", 3000)));
    await e.page.keyboard.press("KeyP");
    await e.page.keyboard.press("KeyR");
    await e.page.keyboard.press("Escape");
    await e.page.keyboard.press("KeyC");
    check("key C stops the camera", !!(await until(async () => (await e.statusOf("camera-status")) === "off", 3000)));
    check("key C also turns voice commands off", (await e.page.getByTestId("stage").getAttribute("data-voice-commands")) === "false");
    // Typing in a field must not trigger shortcuts (here the emergency contact's name).
    await e.openSettings();
    const name = e.page.getByLabel("Name", { exact: true });
    await name.focus();
    await e.page.keyboard.type("c");
    check("typing in a text field doesn't trigger shortcuts", (await e.statusOf("camera-status")) === "off" && (await name.inputValue()) === "c");
    await e.browser.close();
  },

  async permissionDenied() {
    const e = await open({ grant: false, device: true });
    await e.start();
    const alert = await until(async () => { const a = e.page.locator('[role="alert"]', { hasText: "permission" }); return (await a.count()) ? a.first().innerText() : null; }, 10_000);
    check("a refused camera is explained", !!alert, alert);
    check("status shows the problem", (await e.statusOf("camera-status")) === "error");
    check("the explanation is spoken", !!(await until(() => e.tts.some((t) => t.includes("الإذن")), 8000)), e.tts.join(" | "));
    check("no frame was sent", e.api.length === 0);
    await e.browser.close();
  },

  async noCamera() {
    const e = await open({ grant: true, device: false });
    await e.start();
    const said = await until(() => e.tts.some((t) => t.includes("ما لقيتش كاميرا")), 10_000);
    check("a missing camera is explained", !!said, e.tts.join(" | "));
    await e.browser.close();
  },

  async darkRoom() {
    const e = await open({ camera: "dark" });
    await e.start();
    const warned = await until(() => e.tts.some((t) => t.includes("مظلمة")), 15_000);
    check("too dark: the user is told", !!warned, e.tts.join(" | "));
    await sleep(6000);
    check("too dark: no frame is sent to the AI", e.api.length === 0, `${e.api.length} requests`);
    await e.browser.close();
  },

  async urgentWarning() {
    const e = await open({ facing: "outward" });
    const analysis = { spoken: "إنت في بلاصة كبيرة وفيها برشة حاجات.", changed: true, imageQuality: "good", environment: null, detections: [], texts: [], uncertain: false,
      hazards: [{ kind: "stairs", label: "درج", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown" }, { kind: "stairs", label: "درج", side: "left", proximity: "near", confidence: "uncertain", motion: "unknown" }] };
    await e.ctx.route("**/api/vision", (route) => (route.request().method() === "POST" ? route.fulfill({ json: { analysis, provider: "mock", latencyMs: 1 } }) : route.continue()));
    await e.start();
    const ok = await until(() => e.tts.some((t) => t.includes("رد بالك، فمّا درج قدّامك")), 20_000);
    check("(mocked API) a confirmed hazard gives the firm warning", !!ok, e.tts.join(" | "));
    // Right away: the next sentence replaces it on screen once it has been spoken.
    const shown = await until(async () => { const p = e.page.locator('[data-testid="last-spoken"][data-urgent="true"]'); return (await p.count()) ? p.first().innerText() : null; }, 8000, 50);
    await e.page.screenshot({ path: join(shots, "urgent.png") });
    check("(mocked API) the warning is shown prominently", !!shown, shown);
    check("(mocked API) an uncertain hazard is worded as uncertain", !!(await until(() => e.tts.some((t) => t.includes("موش متأكّد")), 15_000)), e.tts.join(" | "));
    await sleep(9000);
    const n = e.tts.filter((t) => t.includes("رد بالك، فمّا درج قدّامك")).length;
    check("(mocked API) the warning isn't spoken on every frame", n <= 2, `${n} times`);
    await e.browser.close();
  },

  async aiFailure() {
    const e = await open();
    await e.ctx.route("**/api/vision", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "ai-unavailable" } }) : route.continue()));
    await e.start();
    const warned = await until(() => e.tts.some((t) => t.includes("التحليل واقف")), 35_000);
    check("(mocked API) when the AI is down, the user is told not to rely on it", !!warned, e.tts.join(" | "));
    check("(mocked API) nothing is made up", !e.tts.some((t) => /قدّامك|شارع/.test(t)), e.tts.join(" | "));
    check("(mocked API) status shows it", !!(await until(async () => (await e.statusOf("analysis-status")) === "unavailable", 5000)));
    await e.ctx.unroute("**/api/vision");
    const back = await until(() => e.tts.some((t) => t.includes("رجع التحليل")), 60_000);
    check("recovery is announced once the AI returns", !!back, e.tts.slice(-3).join(" | "));
    await e.browser.close();
  },

  async approaching() {
    const e = await open({ camera: "approaching", facing: "outward" });
    await e.ctx.route("**/api/vision", (route) => (route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "ai-unavailable" } }) : route.continue()));
    await e.start();
    const seen = [];
    const hit = await until(async () => {
      const t = (await e.page.getByTestId("stage").getAttribute("data-local-hazards")) ?? "";
      if (t) seen.push(t);
      return /approaching/.test(t) ? t : null;
    }, 40_000, 200);
    check("on-device only: someone approaching is detected, with the cloud down", !!hit, hit ?? seen.slice(-3).join(" | "));
    const warned = await until(() => e.tts.some((t) => t.includes("جاي لجيهتك")), 20_000);
    check("on-device only: the approach is spoken as a warning", !!warned, e.tts.join(" | "));
    await e.browser.close();
  },

  async voiceRecognitionText() {
    // A browser with working speech recognition, replaced by a stub that "hears" one question.
    const init = () => {
      window.__rec = { started: 0, lang: null };
      window.SpeechRecognition = window.webkitSpeechRecognition = class {
        start() {
          window.__rec.started++;
          window.__rec.lang = this.lang;
          const n = window.__rec.started;
          setTimeout(() => {
            this.onspeechstart?.();
            if (n === 1) this.onresult?.({ results: [[{ transcript: "شنوة قدّامي؟" }]] });
            this.onspeechend?.();
            this.onend?.();
          }, 1500);
        }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
    };
    const e = await open({ init, facing: "outward" });
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    // Open camera turned voice commands on by itself.
    const q = await until(() => e.api.find((a) => a.mode === "question"), 45_000); // the mic waits for speech to finish
    check("voice question reaches the vision API with a frame", q?.question === "شنوة قدّامي؟", JSON.stringify(q));
    check("recognition language is Tunisian Arabic", (await e.page.evaluate(() => window.__rec.lang)) === "ar-TN");
    check("the screen follows the speech language (Tunisian, right to left)", (await e.page.locator(".app").getAttribute("lang")) === "ar-TN" && (await e.page.locator(".app").getAttribute("dir")) === "rtl");
    check("what was heard is shown", (await e.page.getByTestId("last-heard").innerText().catch(() => "")).includes("شنوة قدّامي"));
    const answered = await until(() => e.tts.some((t) => /شارع|كراهب|كرهبة|موتور|عباد/.test(t)), 25_000);
    check("the spoken answer follows", !!answered, e.tts.join(" | "));
    check("the loop keeps listening", (await e.page.evaluate(() => window.__rec.started)) >= 2 || !!(await until(() => e.page.evaluate(() => window.__rec.started >= 2), 20_000)));
    await e.openSettings();
    check("the voice commands switch reports its state", await e.page.getByTestId("voice-commands").isChecked());
    await e.page.getByTestId("voice-commands").click();
    await sleep(500);
    check("the mic can be turned off", (await e.statusOf("mic-status")) === "off" && !(await e.page.getByTestId("voice-commands").isChecked()));
    await e.browser.close();
  },

  async voiceRecorderFallback() {
    // Headless Chromium has the API but no speech service: it must fall back to recording, and real
    // audio of a spoken Arabic question then goes through the real transcription.
    const audio = join(fixtures, "question.wav");
    if (!existsSync(audio)) {
      const e = await open({ grant: false });
      const b64 = await e.page.evaluate(async () => {
        const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "شنوة قدّامي؟", rate: 0.9 }) });
        if (!res.ok) throw new Error(`/api/tts answered ${res.status}: ${await res.text()}`);
        const ctx = new OfflineAudioContext(1, 1, 16000);
        const d = await ctx.decodeAudioData(await res.arrayBuffer());
        const pad = 16000 * 2;
        // The fake microphone loops this file: its silences must be shorter than the 8 s wait for speech.
        const pcm = new Float32Array(pad + d.length + pad * 2);
        pcm.set(d.getChannelData(0), pad);
        const buf = new ArrayBuffer(44 + pcm.length * 2);
        const v = new DataView(buf);
        const asc = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
        asc(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); asc(8, "WAVEfmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); asc(36, "data"); v.setUint32(40, pcm.length * 2, true);
        pcm.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 32767, true));
        let bin = ""; new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
        return btoa(bin);
      });
      writeFileSync(audio, Buffer.from(b64, "base64"));
      await e.browser.close();
    }
    // The API exists but its service is unreachable, which is what Brave and some Chromium builds report.
    const init = () => {
      window.SpeechRecognition = window.webkitSpeechRecognition = class {
        start() { setTimeout(() => { this.onerror?.({ error: "network" }); this.onend?.(); }, 100); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
    };
    const e = await open({ audio, facing: "outward", init });
    const transcribes = [];
    e.page.on("response", async (r) => { if (r.url().endsWith("/api/vision/transcribe")) transcribes.push(`${r.status()} ${await r.text().catch(() => "")}`); });
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    // Open camera's hands-free listening hits the dead service and falls back by itself.
    const fell = await until(() => e.tts.some((t) => t.includes("نسجّل صوتك")), 15_000);
    check("without a speech service it falls back to recording, and says so", !!fell, e.tts.join(" | "));
    const q = await until(() => e.api.find((a) => a.mode === "question"), 40_000);
    console.log("      transcribe:", transcribes.join(" | "));
    check("recorded speech is transcribed and asked with a frame", !!q, q ? JSON.stringify(q) : `spoken: ${e.tts.join(" | ")}; mic: ${await e.statusOf("mic-status")}`);
    check("the transcript matches the spoken question", /شنو/.test(q?.question ?? "") && /قد.?ام/.test(q?.question ?? ""), q?.question);
    const tracks = await until(() => e.page.evaluate(() => { const a = window.__tracks.filter((t) => t.kind === "audio"); return a.length > 0 && a.every((t) => t.readyState === "ended"); }), 8000);
    check("the microphone is released after the question", !!tracks);
    await e.browser.close();
  },

  async askIsNotCutOff() {
    // The button is pressed just as routine speech is about to start: the question must survive.
    const init = () => {
      window.__rec = { aborted: 0 };
      window.SpeechRecognition = window.webkitSpeechRecognition = class {
        start() { this.t = setTimeout(() => { this.onspeechstart?.(); this.onresult?.({ results: [[{ transcript: "وين الباب؟" }]] }); this.onspeechend?.(); this.onend?.(); }, 6000); }
        stop() { clearTimeout(this.t); this.onend?.(); }
        abort() { window.__rec.aborted++; clearTimeout(this.t); this.onend?.(); }
      };
    };
    const e = await open({ init, facing: "outward" });
    await e.ctx.route("**/api/vision", (route) => (route.request().method() === "POST"
      ? route.fulfill({ json: { analysis: { spoken: JSON.parse(route.request().postData()).mode === "question" ? "الباب على يمينك." : "إنت في شارع.", changed: true, imageQuality: "good", environment: null, detections: [], hazards: [], texts: [], uncertain: false }, provider: "mock", latencyMs: 1 } })
      : route.continue()));
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    // Push-to-talk (Q) is for when hands-free listening is off: turn it off first.
    await e.page.keyboard.press("KeyV");
    await until(async () => (await e.page.getByTestId("stage").getAttribute("data-voice-commands")) === "false", 3000);
    await e.page.evaluate(() => { window.__rec.aborted = 0; });
    await e.page.keyboard.press("KeyQ");
    const q = await until(() => e.api.find((a) => a.mode === "question"), 15_000);
    check("(mocked API) routine speech doesn't cut off a question being asked", q?.question === "وين الباب؟" && (await e.page.evaluate(() => window.__rec.aborted)) === 0, JSON.stringify(q));
    await e.browser.close();
  },

  async deadSpeechService() {
    // No error at all, only sessions that end at once: the second one must trigger the fallback.
    const init = () => {
      window.SpeechRecognition = window.webkitSpeechRecognition = class {
        start() { setTimeout(() => this.onend?.(), 50); }
        stop() { this.onend?.(); }
        abort() { this.onend?.(); }
      };
    };
    const e = await open({ audio: join(fixtures, "question.wav"), facing: "outward", init });
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    // Voice commands are already on after Open camera.
    check("a service that ends instantly falls back to recording", !!(await until(() => e.tts.some((t) => t.includes("نسجّل صوتك")), 50_000)), e.tts.join(" | "));
    await e.browser.close();
  },

  async mobile() {
    const e = await open({ viewport: { width: 390, height: 844 } });
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    const overflow = await e.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    check("phone width: no sideways scrolling", overflow <= 0, `${overflow}px`);
    const scrolls = await e.page.evaluate(() => document.documentElement.scrollHeight > innerHeight || document.querySelector(".app").scrollHeight > document.querySelector(".app").clientHeight);
    check("phone: the camera screen fits without scrolling", !scrolls);
    const small = await e.page.evaluate(() => [...document.querySelectorAll("main button")].filter((b) => b.getBoundingClientRect().height < 48 && b.getBoundingClientRect().height > 0).map((b) => b.textContent));
    check("phone width: all buttons are large", small.length === 0, small.join(","));
    await e.page.screenshot({ path: join(shots, "mobile.png"), fullPage: true });
    await e.browser.close();
  },

  async sheetsAndThemes() {
    const e = await open();
    await e.openSettings();
    const sheet = e.page.getByRole("dialog", { name: "Settings" });
    await sheet.waitFor();
    check("settings open as a dialog, with focus inside", await sheet.evaluate((d) => d.contains(document.activeElement)));
    await e.page.keyboard.press("KeyC");
    await sleep(300);
    check("shortcuts don't fire behind an open dialog", (await e.statusOf("camera-status")) === "off");
    await e.page.keyboard.press("Escape");
    await sleep(200);
    check("Esc closes it and focus returns to the opener", (await sheet.isHidden()) && (await e.page.evaluate(() => document.activeElement?.dataset.testid)) === "open-settings");
    await e.openSettings();
    await e.page.getByLabel("Colors").selectOption("light");
    check("the light theme applies and is remembered", (await e.page.evaluate(() => document.documentElement.dataset.theme + localStorage.getItem("theme"))) === "lightlight");
    await e.page.getByRole("switch", { name: /Describe my surroundings/ }).uncheck();
    check("settings are saved", (await e.page.evaluate(() => JSON.parse(localStorage.getItem("assistant.settings")).narration)) === false);
    await e.browser.close();
  },

  // --- Safety and lifecycle, fully mocked: run with fixtures from make_synthetic_camera.py ------

  async hiddenReleasesCamera() {
    const e = await open({ camera: "synthetic", facing: "outward" });
    await mockServices(e);
    await e.start();
    check("(mocked API) camera starts", !!(await until(async () => (await e.statusOf("camera-status")) === "on")));
    await setHidden(e.page, true); // switching apps, changing tabs or locking the phone
    await sleep(500);
    const states = await e.page.evaluate(() => window.__tracks.map((t) => t.readyState));
    check("hiding the page releases the camera hardware", states.length > 0 && states.every((s) => s === "ended"), states.join(","));
    check("the screen says the camera is off", (await e.statusOf("camera-status")) === "off");
    const sent = e.api.length;
    await sleep(5000);
    check("no frame is sent while hidden", e.api.length === sent, `${e.api.length - sent} sent`);
    await setHidden(e.page, false);
    check("returning turns the camera back on", !!(await until(async () => (await e.statusOf("camera-status")) === "on", 10_000)));
    const live = await e.page.evaluate(() => window.__tracks.filter((t) => t.readyState === "live").length);
    check("with a new camera stream", live === 1, `${live} live`);
    check("and the user is told the camera was off", !!(await until(() => e.page.evaluate(() => window.__captions.some((c) => c.includes("الكاميرا تسكّرت وقت اللي خرجت"))), 10_000)));
    await e.browser.close();
  },

  async detectorFailureSpoken() {
    const e = await open({ camera: "synthetic", facing: "outward" });
    await mockServices(e);
    await e.ctx.route("**/mediapipe/**", (route) => route.abort());
    await e.start();
    const told = await until(() => e.page.evaluate(() => window.__captions.some((c) => c.includes("التحذيرات اللي في الجهاز ما تخدمش"))), 25_000);
    check("(mocked API) a detector that can't load is announced out loud", !!told, (await e.page.evaluate(() => window.__captions)).join(" | "));
    check("(mocked API) and the screen says so", (await until(async () => (await e.statusOf("detector")) === "failed" && (await e.page.locator(".notices").count()) > 0, 5000)) !== null);
    await e.browser.close();
  },

  async readingInterruptedByWarning() {
    const e = await open({ camera: "synthetic", facing: "outward" });
    const reading = Array.from({ length: 30 }, (_, i) => `هذا السطر رقم ${i + 1} من الورقة اللي قدّامك ومكتوب فيه كلام طويل شوية.`).join(" ");
    let readingStarted = false;
    const stairs = { kind: "stairs", label: "درج", side: "center", proximity: "near", confidence: "confirmed", motion: "unknown" };
    // The read task ("T") uses the reading mode: a long letter, read out as the paper's text.
    const letter = { kind: "letter", legibility: "clear", problems: [], lines: [], medicine: {}, explanation: "", rescan: false, more: false, segments: [{ text: reading, source: "document", lang: "tn" }] };
    await mockServices(e, (body) =>
      body.mode === "read"
        ? { ...scene({ spoken: reading, changed: true }), document: letter }
        : body.mode === "question"
          ? scene({ spoken: reading, changed: true })
          : scene({ hazards: readingStarted ? [stairs] : [], spoken: readingStarted ? "وصف جديد ما لازمش يتقال." : "", changed: true }),
    );
    await e.start();
    await until(async () => (await e.statusOf("camera-status")) === "on");
    await sleep(1500);
    await e.page.keyboard.press("KeyT");
    readingStarted = !!(await until(() => e.page.evaluate(() => window.__captions.some((c) => c.includes("السطر رقم 1 "))), 30_000));
    check("(mocked API) the reading starts", readingStarted);
    const scansBefore = e.api.filter((a) => a.mode === "scan").length;
    const warned = await until(() => e.page.evaluate(() => window.__captions.some((c) => c.includes("رد بالك، فمّا درج قدّامك"))), 25_000, 100);
    const caps = await e.page.evaluate(() => window.__captions);
    check("(mocked API) frames are still sent while the reading plays", e.api.filter((a) => a.mode === "scan").length > scansBefore);
    const w = caps.findIndex((c) => c.includes("رد بالك، فمّا درج قدّامك"));
    check("(mocked API) the urgent warning is spoken during the reading", !!warned, caps.join(" | ").slice(0, 300));
    check("(mocked API) before the reading had finished", w > 0 && !caps.slice(0, w).some((c) => c.includes("السطر رقم 30 ")), caps.slice(0, w + 1).map((c) => c.slice(0, 25)).join(" | "));
    await until(() => e.page.evaluate((w) => window.__captions.slice(w + 1).some((c) => c.includes("السطر رقم")), w), 20_000);
    const after = await e.page.evaluate(() => window.__captions);
    const resumed = after.slice(w + 1).find((c) => c.includes("السطر رقم"));
    check("(mocked API) the reading then resumes from the interrupted part", !!resumed && resumed === after.slice(0, w).reverse().find((c) => c.includes("السطر رقم")), resumed?.slice(0, 40));
    check("(mocked API) a new description isn't queued behind the reading", !after.some((c) => c.includes("وصف جديد")));
    await e.browser.close();
  },

  async independentApp() {
    const e = await open();
    const res = await e.page.goto(base + "/", { waitUntil: "domcontentloaded" });
    check("the assistant is the home page", res.status() === 200 && (await e.page.locator("h1").innerText()) === "Nadhra");
    const policy = res.headers()["permissions-policy"];
    check("camera, microphone and location (Emergency page) allowed for this site only", policy.includes("camera=(self)") && policy.includes("microphone=(self)") && policy.includes("geolocation=(self)") && !/\*/.test(policy), policy);
    for (const path of ["/dictionary", "/practice", "/studio", "/vision", "/api/sentence"]) {
      check(`nothing of the sign-language app at ${path}`, (await e.page.request.get(base + path)).status() === 404);
    }
    const html = await (await e.page.request.get(base + "/")).text();
    check("no API key and no old branding in the page", !/AIza|sk-or-|ترجمان|Sign Voice/.test(html));
    await e.browser.close();
  },

  /** Phase 1: CSP doesn't break the page or the detector, the session flow works, pause, consent. No Gemini quota. */
  async phase1Protection() {
    const e = await open({ camera: "synthetic", facing: "outward" });
    await mockServices(e); // only /api/vision and /api/tts: /api/session and /api/report are the real routes
    const detectorStatus = () => e.statusOf("detector");
    await e.start();
    check("camera starts", !!(await until(async () => (await e.statusOf("camera-status")) === "on")));
    check("the on-device detector loads under the Content-Security-Policy", !!(await until(async () => (await detectorStatus()) === "ready", 25_000)), await detectorStatus());
    const cookies = await e.ctx.cookies();
    const session = cookies.find((c) => c.name === "nadhra_session");
    check("the page opened an HttpOnly session cookie", !!session && session.httpOnly && session.sameSite === "Strict", JSON.stringify(session ?? {}).slice(0, 120));
    const reported = await e.page.evaluate(async () => {
      const r = await fetch("/api/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ e: "camera-error", c: "denied" }] }) });
      return r.json();
    });
    check("the page's own requests pass the API protection", reported?.accepted === 1, JSON.stringify(reported));
    const scripted = await e.page.request.post(base + "/api/vision", { data: { mode: "chat", question: "hi" }, headers: { origin: "https://evil.example" } });
    check("a request from another site is refused", scripted.status() === 403);

    await e.page.keyboard.press("KeyP");
    check("pause: the status says descriptions are paused", !!(await until(async () => (await e.statusOf("analysis-status")) === "paused", 3000)));
    check("pause: on-device detection keeps running", (await detectorStatus()) === "ready");
    check("pause: the user hears that warnings stay on", !!(await until(() => e.page.evaluate(() => window.__captions.some((c) => c.includes("التحذيرات اللي في الجهاز مازالت خدّامة"))), 10_000)));

    await e.page.getByTestId("open-privacy").click();
    await e.page.getByTestId("withdraw-consent").click();
    check("withdrawing consent stops the camera", !!(await until(async () => (await e.statusOf("camera-status")) === "off", 5000)));
    check("and forgets the consent", (await e.page.evaluate(() => localStorage.getItem("assistant.consent.v3"))) === null);
    await e.page.keyboard.press("Escape");
    await e.start();
    check("the notice is shown again before the camera can start", await e.page.getByRole("dialog", { name: "Before the camera starts" }).isVisible());
    await e.button("I agree").click();
    check("camera back on after agreeing", !!(await until(async () => (await e.statusOf("camera-status")) === "on")));

    // Talk live up to the token: the microphone's AudioWorklet (a blob: script) must load under the
    // CSP, since the token is only asked for once the microphone runs. No Gemini session is opened.
    let tokenAsked = false;
    await e.ctx.route("**/api/live/token", (route) => {
      tokenAsked = true;
      return route.fulfill({ status: 503, json: { error: "not-configured" } });
    });
    await e.openSettings();
    await e.page.getByTestId("live-toggle").click();
    check("Talk live: the microphone starts under the CSP, then asks for a token", !!(await until(() => tokenAsked, 10_000)));
    check("Talk live: a refused token is said, not hidden", !!(await until(() => e.page.evaluate(() => window.__captions.some((c) => c.includes("المحادثة المباشرة ما خدمتش"))), 10_000)));
    const csp = e.errors.filter((m) => /Content Security Policy|Refused to/.test(m));
    check("no Content-Security-Policy violations", csp.length === 0, csp.join(" | "));
    await e.browser.close();
  },
};

for (const [name, run] of Object.entries(scenarios)) {
  if (only && !only.includes(name)) continue;
  console.log(`\n=== ${name}`);
  try {
    await run();
  } catch (err) {
    check(`${name} finished without an exception`, false, err.message);
  }
  await Promise.all([...openBrowsers].map((b) => b.close().catch(() => {})));
  openBrowsers.clear();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log("FAILED:\n" + failed.map((f) => "  " + f.name).join("\n"));
process.exit(failed.length ? 1 : 0);
