// The live conversation in real Chromium, on the production build, against a FAKE Gemini Live
// WebSocket (Playwright routeWebSocket) and a mocked token route. Uses no Gemini quota and sends
// nothing to Google.
//
//   npm run build && npx next start -p 3100
//   node e2e/live/mocked.mjs http://localhost:3100
//
// Checks: speaking first (a cue goes out while the user is silent; the fake model answers "SILENT"
// once, which must never be shown, then a real sentence, which must be); measurements and cost
// from configured prices in Settings; the setting that turns speaking first off; ending live closes
// the camera AND microphone tracks when live opened the camera, and only the microphone when the
// camera was already on. The camera alternates between two very different views every 5 s; the
// microphone is silent (Chromium's default fake microphone beeps, which would count as speech).
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = new URL("./out/mocked/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
const video = join(OUT, "two-views.mjpeg");
const mic = join(OUT, "silence.wav");
if (!existsSync(video)) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-t", "5", "-i", "testsrc2=s=640x480:r=10", "-f", "lavfi", "-t", "5", "-i", "cellauto=s=640x480:r=10",
    "-filter_complex", "[0][1]concat=n=2:v=1[v]", "-map", "[v]", "-q:v", "4", video]);
}
if (!existsSync(mic)) execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "lavfi", "-t", "300", "-i", "anullsrc=r=16000:cl=mono", mic]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

const browser = await chromium.launch({
  executablePath,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${video}`, `--use-file-for-fake-audio-capture=${mic}`],
});

/** 0.3 s of a 440 Hz tone at 24 kHz, base64 16-bit PCM: what the fake model "says". */
const tone = (() => {
  const n = 7200;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 24000) * 8000), i * 2);
  return b.toString("base64");
})();

async function session() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"] });
  await ctx.addInitScript(() => {
    localStorage.setItem("assistant.consent.v3", "1");
    localStorage.setItem("assistant.liveConsent.v1", "1");
    window.__tracks = [];
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); window.__tracks.push(...s.getTracks()); return s; };
  });
  const silenceMp3 = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-t", "0.2", "-i", "anullsrc=r=24000:cl=mono", "-f", "mp3", "-"]);
  await ctx.route("**/api/tts", (route) => route.request().method() !== "POST"
    ? route.fulfill({ json: { configured: true, voice: "mock", languageCode: "ar-TN" } })
    : route.fulfill({ body: silenceMp3, contentType: "audio/mpeg" }));
  await ctx.route("**/api/vision", (route) => route.fulfill({ json: { available: true, providers: [{ id: "mock", label: "Mock" }], canTranscribe: false } }));
  await ctx.route("**/api/report", (route) => route.fulfill({ json: { accepted: 0 } }));
  await ctx.route("**/api/live/token", (route) => route.fulfill({ json: {
    token: "auth_tokens/fake", url: "wss://generativelanguage.googleapis.com/ws/fake", setup: { model: "models/fake-live" }, model: "fake-live", voice: "Sulafat", lastModel: true,
    // Like the real configuration: no price for tokens Gemini doesn't break down by type.
    pricing: { currency: "USD", input: { audio: 3, image: 3, text: 0.5 }, output: { audio: 12, text: 2 } },
  } }));
  const fake = { connections: 0, frames: 0, cues: [], texts: [], audioChunks: 0 };
  await ctx.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    fake.connections++;
    const send = (m) => ws.send(JSON.stringify(m));
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.setup) {
        send({ setupComplete: {} });
        // Usage that doesn't add up (the real service did this: ~10% of prompt tokens not broken down by type).
        if (fake.incompleteUsage) setTimeout(() => send({ usageMetadata: { promptTokenCount: 3000, responseTokenCount: 40, totalTokenCount: 3040, promptTokensDetails: [{ modality: "TEXT", tokenCount: 1500 }, { modality: "IMAGE", tokenCount: 1200 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 40 }] } }), 500);
        return;
      }
      const ri = m.realtimeInput;
      if (ri?.video) fake.frames++;
      if (ri?.audio) fake.audioChunks++;
      if (typeof ri?.text !== "string") return;
      fake.texts.push(ri.text);
      if (!ri.text.startsWith("[camera-update]")) return;
      fake.cues.push(ri.text);
      const silent = fake.cues.length === 1;
      const words = silent ? "SILENT." : "ردّ بالك، فمّا دروج قدّامك.";
      // Audio first, words a little later: the app must hold the sound until the words are known.
      setTimeout(() => send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tone } }] } } }), 50);
      setTimeout(() => send({ serverContent: { outputTranscription: { text: words } } }), 250);
      setTimeout(() => send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: tone } }] } } }), 300);
      setTimeout(() => send({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 5200, responseTokenCount: 60, totalTokenCount: 5260,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: 1400 }, { modality: "IMAGE", tokenCount: 3800 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 60 }] } }), 700);
    });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { ctx, page, fake, errors };
}

const tracks = (page) => page.evaluate(() => window.__tracks.map((t) => ({ kind: t.kind, state: t.readyState })));
// On the stage (always in the page): the Microphone button is only on the home screen.
const status = (page) => page.getByTestId("stage").getAttribute("data-live-status");
const camera = (page) => page.getByTestId("stage").getAttribute("data-camera").catch(() => null);

// --- 1. live from the home screen: speaking first, measurements, then End closes everything ---------
{
  const { ctx, page, fake, errors } = await session();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("live-toggle").click();
  check("home: live opens", await until(async () => (await status(page)) === "open", 15_000));
  check("home: the camera opened for it", (await camera(page)) === "on");
  // Collect every caption while waiting for the two cues.
  const seen = new Set();
  const watch = setInterval(async () => {
    const t = await page.evaluate(() => document.body.innerText).catch(() => "");
    if (/SILENT/i.test(t)) seen.add("SILENT");
    if (t.includes("دروج")) seen.add("answer");
  }, 100);
  const t0 = Date.now();
  await until(() => fake.cues.length >= 1, 30_000);
  const firstCueS = (Date.now() - t0) / 1000;
  check("speaking first: a cue goes out while the user is silent", fake.cues.length >= 1, `after ${firstCueS.toFixed(1)} s`);
  const firstCueAt = Date.now();
  await until(() => fake.cues.length >= 2, 40_000);
  check("speaking first: backoff — the second cue waited at least 20 s after the SILENT one", Date.now() - firstCueAt >= 20_000, `${((Date.now() - firstCueAt) / 1000).toFixed(1)} s`);
  check("speaking first: a second cue after the SILENT backoff (24 s)", fake.cues.length >= 2, `${fake.cues.length} cues`);
  await until(() => seen.has("answer"), 5_000);
  await sleep(1_500); // its turnComplete and usageMetadata come 0.7 s after its words
  clearInterval(watch);
  check("speaking first: «SILENT» is never shown", !seen.has("SILENT"));
  check("speaking first: the real sentence is shown", seen.has("answer"));
  check("frames reach the model", fake.frames >= 3, `${fake.frames} frames`);
  check("silent microphone: no user turn was detected", !fake.texts.some((t) => !t.startsWith("[camera-update]")), JSON.stringify(fake.texts.filter((t) => !t.startsWith("[camera-update]"))));

  const before = await tracks(page);
  check("before End: camera and microphone tracks are live", before.some((t) => t.kind === "video" && t.state === "live") && before.some((t) => t.kind === "audio" && t.state === "live"), JSON.stringify(before));
  const liveButtons = await page.locator(".app button:visible").evaluateAll((bs) => bs.map((b) => b.dataset.testid ?? b.textContent));
  check("during live: only the End button is on screen", liveButtons.join(",") === "stop-assistance" && /End live conversation|وقّف المحادثة المباشرة/.test(await page.getByTestId("stop-assistance").innerText()), liveButtons.join(","));
  await page.getByTestId("stop-assistance").click();
  await until(async () => (await tracks(page)).every((t) => t.state === "ended"), 3_000);
  const after = await tracks(page);
  check("End: every camera and microphone track stopped at once", after.length > 0 && after.every((t) => t.state === "ended"), JSON.stringify(after));
  check("End: back to the home screen (camera off)", (await camera(page)) !== "on" && (await page.getByTestId("open-camera").isVisible()));
  const framesAtEnd = fake.frames;
  await sleep(2_500);
  check("End: nothing more is sent", fake.frames === framesAtEnd);

  // Settings is on the home screen only: the measurements of the conversation that just ended.
  await page.getByTestId("open-settings").click();
  const stats = page.getByTestId("live-stats");
  await stats.locator("summary").click();
  const text = await stats.innerText();
  check("Settings: measurements shown", /Connected in\s+\d/.test(text) && /Pictures\s+\d+ sent/.test(text), text.replace(/\s+/g, " ").slice(0, 400));
  check("Settings: speaking first counted", /Spoke first\s+1 of 2/.test(text));
  check("Settings: tokens from usageMetadata", /Tokens\s+10,520/.test(text));
  const cost = await page.getByTestId("live-cost").innerText();
  // 2 turns × (1400×0.5 + 3800×3 input, 60×12 output) per million.
  const expected = (2 * (1400 * 0.5 + 3800 * 3 + 60 * 12)) / 1e6;
  check("Settings: cost from the configured prices, labelled as an estimate", cost.startsWith(`${expected.toFixed(4)} USD`) && /estimate/.test(cost), `${cost} vs ${expected.toFixed(4)}`);
  check("Settings: measured usage and estimated cost are separate sections", /Measured[\s\S]*Tokens[\s\S]*Estimated cost/.test(text));
  await page.screenshot({ path: join(OUT, "settings-stats.png"), fullPage: true });
  await page.keyboard.press("Escape");
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

// --- 2. camera already on: L starts live, L again ends it and keeps the camera; speaking first off ---
// (During a camera session only Stop is on screen; the L key and «احكي مباشرة» still start live.)
{
  const { ctx, page, fake, errors } = await session();
  fake.incompleteUsage = true;
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByTestId("open-settings").click();
  await page.getByTestId("live-proactive").uncheck();
  await page.keyboard.press("Escape");
  await page.getByTestId("open-camera").click();
  await until(async () => (await camera(page)) === "on", 10_000);
  await page.keyboard.press("KeyL");
  check("camera on: live opens", await until(async () => (await status(page)) === "open", 15_000));
  await sleep(18_000);
  check("speaking first off: no cue in 18 s of changing views", fake.cues.length === 0, `${fake.cues.length} cues`);
  await page.keyboard.press("KeyL");
  await until(async () => (await tracks(page)).filter((t) => t.kind === "audio").every((t) => t.state === "ended"), 3_000);
  const after = await tracks(page);
  check("End: microphone stopped", after.filter((t) => t.kind === "audio").every((t) => t.state === "ended"), JSON.stringify(after));
  check("End: the camera that was already on keeps running", (await camera(page)) === "on" && after.some((t) => t.kind === "video" && t.state === "live"), JSON.stringify(after));
  await page.getByTestId("stop-assistance").click();
  await until(async () => (await tracks(page)).every((t) => t.state === "ended"), 3_000);
  check("Stop assistance: everything stopped", (await tracks(page)).every((t) => t.state === "ended"));
  await page.getByTestId("open-settings").click();
  await page.getByTestId("live-stats").locator("summary").click();
  const cost2 = await page.getByTestId("live-cost").innerText();
  check("incomplete usage: «Cost unavailable – incomplete usage data», and no number given as the cost", cost2.startsWith("Cost unavailable – incomplete usage data") && !/USD/.test(cost2), cost2);
  check("incomplete usage: the tokens are still shown as measured", /300 not broken down by type/.test(await page.getByTestId("live-tokens").innerText()));
  await page.keyboard.press("Escape");
  check("no page errors", errors.length === 0, errors.join(" | "));
  await ctx.close();
}

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
