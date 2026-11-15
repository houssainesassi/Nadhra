// ONE live session of at most 5 minutes, in Chromium on the production build.
//   --mock   a fake Gemini (token route and WebSocket mocked in the browser): no quota, nothing sent
//            to Google. Use it to check the harness and the app's behaviour over the whole timeline.
//   (none)   REAL Gemini Live, free-tier quota: run only with the owner's approval. Stops at once on
//            any quota, rate-limit or billing error.
//
//   sh e2e/live/make_fixtures.sh            (questions + mech.jpg; stairs.jpg: see below)
//   GEMINI_LIVE_MODELS=gemini-3.1-flash-live-preview GEMINI_LIVE_PRICE_...=... npx next start -p 3100
//   node e2e/live/real5min.mjs http://localhost:3100 [--mock]
//
// Camera (fake, from photos): mechanic 0-70 s, stairs 70-150 s, mechanic 150-230 s, stairs 230-290 s,
// counted from the moment the camera opens. A .y4m file at 1 frame a second: Chromium plays .y4m at
// the rate in its header, but .mjpeg at its own capture rate (about 30 fps — the Nov 2026 run's
// 2-fps .mjpeg cycled through all four scenes every ~19 s). Each scene has a small coloured square in
// the top-left corner (red: mechanic, blue: stairs), so every frame sent to Gemini is labelled with
// the scene it really shows, read from the frame itself.
// Microphone (fake): five Derja questions in the first minute (incl. an interruption and a memory
// question), then silence, so "speaking first" can be seen on the scene changes.
// stairs.jpg: "Schody w Parku Środula", Krzysztof Popławski, CC BY-SA 4.0, Wikimedia Commons.
//
// Records: every message's timing and transcript, raw usageMetadata, frames and audio sent, the
// app's own measurements (Settings), the socket's close codes. Writes e2e/live/out/real5/.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const IN = new URL("./out/", import.meta.url).pathname;
const OUT = join(IN, "real5");
mkdirSync(OUT, { recursive: true });
const MOCK = process.argv.includes("--mock");
const HARD_LIMIT_MS = 300_000; // the session never lasts longer than 5 minutes
const END_AT_S = 290;

const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");

// --- camera: four segments from two photos ------------------------------------------------------
const SEGMENTS = [["mech.jpg", 70], ["stairs.jpg", 80], ["mech.jpg", 80], ["stairs.jpg", 70]];
const MARK = { "mech.jpg": "red", "stairs.jpg": "blue" };
const video = join(OUT, "camera.y4m");
if (!existsSync(video)) {
  const args = ["-loglevel", "error", "-y"];
  for (const [img, s] of SEGMENTS) args.push("-loop", "1", "-framerate", "1", "-t", String(s), "-i", join(IN, img));
  const scale = SEGMENTS.map(([img], i) => `[${i}]scale=480:640:force_original_aspect_ratio=increase,crop=480:640,setsar=1,drawbox=x=0:y=0:w=40:h=40:color=${MARK[img]}:t=fill,fps=1[v${i}]`).join(";");
  args.push("-filter_complex", `${scale};${SEGMENTS.map((_, i) => `[v${i}]`).join("")}concat=n=${SEGMENTS.length}:v=1,format=yuv420p[v]`, "-map", "[v]", "-r", "1", "-f", "yuv4mpegpipe", video);
  execFileSync("ffmpeg", args);
}
/** The scene the timeline says, `s` seconds after the camera opened. */
const sceneAt = (s) => { let t = 0; for (const [img, d] of SEGMENTS) { if (s < t + d) return img.replace(".jpg", ""); t += d; } return "end"; };
/** The scene a sent frame really shows, from the colour of its corner square. */
const { default: jpeg } = await import("jpeg-js");
function sceneOfFrame(b64) {
  try {
    const img = jpeg.decode(Buffer.from(b64, "base64"), { useTArray: true });
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = 6; y < 18; y++) for (let x = 6; x < 18; x++) { const i = (y * img.width + x) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++; }
    r /= n; g /= n; b /= n;
    if (r > 150 && g < 90 && b < 90) return "mech";
    if (b > 150 && r < 90 && g < 90) return "stairs";
    return "unknown";
  } catch { return "unreadable"; }
}

// --- microphone: questions, then silence ---------------------------------------------------------
const RATE = 16000;
const pcm = (n) => readFileSync(join(IN, `${n}.pcm`));
const silence = (s) => Buffer.alloc(Math.round(s * RATE) * 2);
/** Seconds of near-silence at the end of a recorded question (the speech really ends earlier). */
const trailing = (b) => {
  const x = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  let last = 0;
  for (let i = 0; i + 160 <= x.length; i += 160) { let e = 0; for (let j = i; j < i + 160; j++) e += x[j] * x[j]; if (Math.sqrt(e / 160) > 300) last = i + 160; }
  return (x.length - last) / RATE;
};
const TIMELINE = [
  [silence(4.0), ""],
  [pcm("q_mech"), "Q1 what is happening now"],
  [silence(10.0), ""],
  [pcm("q_right"), "Q2 what is on my right"],
  [silence(10.0), ""],
  [pcm("q_mech"), "Q3 asked again (to be interrupted)"],
  [silence(1.6), ""],
  [pcm("q_interrupt"), "Q4 interruption: what colour was the car"],
  [silence(10.0), ""],
  [pcm("q_before"), "Q5 memory: what did you tell me before"],
];
const marks = [];
let t = 0;
for (const [buf, label] of TIMELINE) {
  const dur = buf.length / 2 / RATE;
  if (label) marks.push({ label, start: t, speechEnd: t + dur - trailing(buf) });
  t += dur;
}
const mic = Buffer.concat([...TIMELINE.map(([b]) => b), silence(END_AT_S + 20 - t)]);
const wav = (() => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + mic.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(mic.length, 40);
  return Buffer.concat([h, mic]);
})();
writeFileSync(join(OUT, "mic.wav"), wav);

// --- run ---------------------------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${video}`, `--use-file-for-fake-audio-capture=${join(OUT, "mic.wav")}%noloop`],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ar-TN", permissions: ["camera", "microphone"] });
// Test-only instrumentation of the live socket (the app is unchanged). The token in the socket's URL
// is never recorded.
await ctx.addInitScript(() => {
  localStorage.setItem("assistant.consent.v3", "1");
  localStorage.setItem("assistant.liveConsent.v1", "1");
  const W = window.WebSocket;
  window.__live = { ev: [], usage: [], sentTexts: [], closes: [], sent: { audio: 0, audioBytes: 0, video: 0, videoBytes: 0, text: 0, setup: 0 }, micAt: 0, camAt: 0, tracks: [] };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    window.__live.tracks.push(...s.getTracks());
    if (c && c.audio) window.__live.micAt = performance.now();
    if (c && c.video) window.__live.camAt = performance.now();
    return s;
  };
  window.WebSocket = class extends W {
    constructor(url, p) {
      super(url, p);
      if (!String(url).includes("generativelanguage")) return;
      const L = window.__live;
      L.ev.push({ t: performance.now(), k: "open-socket" });
      const send = this.send.bind(this);
      this.send = (d) => {
        try {
          const m = JSON.parse(d);
          const ri = m.realtimeInput;
          if (m.setup) L.sent.setup++;
          else if (ri?.audio) { L.sent.audio++; L.sent.audioBytes += (ri.audio.data.length * 3) / 4; }
          else if (ri?.video) { L.sent.video++; L.sent.videoBytes += (ri.video.data.length * 3) / 4; L.ev.push({ t: performance.now(), k: "frame", d: ri.video.data }); }
          else if (typeof ri?.text === "string") { L.sent.text++; L.sentTexts.push({ t: performance.now(), text: ri.text }); L.ev.push({ t: performance.now(), k: ri.text.startsWith("[camera-update]") ? "cue" : "text" }); }
        } catch {}
        return send(d);
      };
      this.addEventListener("close", (e) => L.closes.push({ t: performance.now(), code: e.code, reason: String(e.reason || "").slice(0, 300) }));
      this.addEventListener("message", (e) => {
        const now = performance.now();
        const handle = (text) => {
          let m;
          try { m = JSON.parse(text); } catch { return; }
          if (m.setupComplete) L.ev.push({ t: now, k: "setup" });
          if (m.goAway) L.ev.push({ t: now, k: "goAway" });
          if (m.usageMetadata) L.usage.push({ t: now, u: m.usageMetadata });
          if (m.error) L.ev.push({ t: now, k: "error", d: JSON.stringify(m.error).slice(0, 300) });
          const sc = m.serverContent;
          if (!sc) return;
          for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) L.ev.push({ t: now, k: "audio", n: (p.inlineData.data.length * 3) / 4 });
          if (sc.inputTranscription?.text) L.ev.push({ t: now, k: "user", d: sc.inputTranscription.text });
          if (sc.outputTranscription?.text) L.ev.push({ t: now, k: "ai", d: sc.outputTranscription.text });
          if (sc.interrupted) L.ev.push({ t: now, k: "interrupted" });
          if (sc.turnComplete) L.ev.push({ t: now, k: "turn" });
        };
        if (typeof e.data === "string") handle(e.data);
        else if (e.data instanceof Blob) e.data.text().then(handle);
        else handle(new TextDecoder().decode(e.data));
      });
    }
  };
});
// --- mock mode: a fake Gemini in the browser's network layer (nothing leaves this machine) -----------
// It hears speech by level (like the server's voice detection), answers every user turn, and answers
// a cue like an obedient model: a sentence when the latest frame shows a scene it hasn't spoken about
// since it last looked, otherwise SILENT. Its usageMetadata follows the real Nov 2026 session: the
// prompt (the whole context, re-read every turn) grew by about 48 tokens a second from ~2,000.
// In mock mode Playwright's WebSocket routing replaces the page's WebSocket, so the in-page recorder
// sees nothing: frames and turns are recorded here, on the fake server's side (epoch ms).
const mock = { cues: 0, spokenCues: 0, userTurns: 0, frames: [], turns: [] };
if (MOCK) {
  await ctx.route("**/api/live/token", (route) => route.fulfill({ json: {
    token: "auth_tokens/fake", url: "wss://generativelanguage.googleapis.com/ws/fake", setup: { model: "models/fake-live" }, model: "fake-live", voice: "Sulafat", lastModel: true,
    pricing: { currency: "USD", input: { audio: 3, image: 1, text: 0.75 }, output: { audio: 12, text: 4.5 } },
  } }));
  await ctx.route("**/api/report", (route) => route.fulfill({ json: { accepted: 0 } }));
  // The app's own status voice too: nothing at all leaves this machine in mock mode.
  const silentMp3 = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-t", "0.3", "-i", "anullsrc=r=24000:cl=mono", "-f", "mp3", "-"]);
  await ctx.route("**/api/tts", (route) => route.request().method() !== "POST"
    ? route.fulfill({ json: { configured: true, voice: "mock", languageCode: "ar-TN" } })
    : route.fulfill({ body: silentMp3, contentType: "audio/mpeg" }));
  await ctx.route("**/api/vision**", (route) => route.fulfill({ json: { available: true, providers: [{ id: "mock", label: "Mock" }], canTranscribe: false } }));
  await ctx.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    const start = Date.now();
    const send = (m) => ws.send(JSON.stringify(m));
    const toneB64 = Buffer.alloc(24000 * 2 * 0.4).toString("base64"); // 0.4 s of answer audio
    let lastScene = null;
    let lastSpokenScene = null;
    let talking = false;
    let quietMs = 0;
    let busyUntil = 0;
    const usage = (out) => {
      const prompt = Math.round(2000 + 48 * ((Date.now() - start) / 1000));
      return { promptTokenCount: prompt, responseTokenCount: out, totalTokenCount: prompt + out,
        promptTokensDetails: [{ modality: "TEXT", tokenCount: Math.round(prompt * 0.3) }, { modality: "AUDIO", tokenCount: Math.round(prompt * 0.15) }, { modality: "IMAGE", tokenCount: Math.round(prompt * 0.45) }],
        responseTokensDetails: [{ modality: "AUDIO", tokenCount: out }] };
    };
    // Answers last as long as the real ones did (user turns 1.4-10.5 s, cues ~1-3 s): audio every
    // 400 ms, words early, then turnComplete. Talking over it cancels the rest (see below).
    let timers = [];
    const answer = (words, out, seconds) => {
      timers.forEach(clearTimeout);
      timers = [];
      busyUntil = Date.now() + 600 + seconds * 1000;
      for (let at = 600; at < 600 + seconds * 1000; at += 400) timers.push(setTimeout(() => send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: toneB64 } }] } } }), at));
      timers.push(setTimeout(() => send({ serverContent: { outputTranscription: { text: words } } }), 750));
      timers.push(setTimeout(() => send({ serverContent: { turnComplete: true }, usageMetadata: usage(out) }), 650 + seconds * 1000));
    };
    ws.onMessage((raw) => {
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.setup) return send({ setupComplete: {} });
      const ri = m.realtimeInput ?? {};
      if (ri.video) { lastScene = sceneOfFrame(ri.video.data); mock.frames.push({ at: Date.now(), scene: lastScene }); }
      if (ri.audio) {
        const b = Buffer.from(ri.audio.data, "base64");
        let e = 0;
        for (let i = 0; i + 1 < b.length; i += 2) { const v = b.readInt16LE(i); e += v * v; }
        const level = Math.sqrt(e / Math.max(1, b.length / 2));
        const ms = (b.length / 2 / 16000) * 1000;
        if (level > 500) {
          // Talking over an answer: the real service stops it and says so.
          if (!talking && Date.now() < busyUntil) { busyUntil = 0; timers.forEach(clearTimeout); timers = []; send({ serverContent: { interrupted: true } }); mock.interruptions = (mock.interruptions ?? 0) + 1; }
          talking = true; quietMs = 0;
        }
        else if (talking && (quietMs += ms) >= 500) {
          talking = false;
          mock.userTurns++;
          send({ serverContent: { inputTranscription: { text: "سؤال" } } });
          lastSpokenScene = lastScene;
          mock.turns.push({ at: Date.now(), kind: "user", scene: lastScene });
          answer(`جواب على ${lastScene}`, 120, 6);
        }
      }
      if (typeof ri.text === "string" && ri.text.startsWith("[camera-update]")) {
        mock.cues++;
        mock.turns.push({ at: Date.now(), kind: "cue", scene: lastScene, spoken: !!(lastScene && lastScene !== lastSpokenScene) });
        if (lastScene && lastScene !== lastSpokenScene) { mock.spokenCues++; lastSpokenScene = lastScene; answer(`فمّا حاجة جديدة: ${lastScene}`, 60, 2.5); }
        else answer("SILENT", 30, 1);
      }
    });
  });
}

const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
const tokenResponses = [];
page.on("response", async (r) => {
  if (!r.url().includes("/api/live/token") || r.request().method() !== "POST") return;
  let error = null;
  try { const j = await r.json(); error = j.error ?? null; } catch {}
  tokenResponses.push({ status: r.status(), error });
});

const QUOTA = /quota|exhaust|billing|rate.?limit|429|too many|limit exceeded|RESOURCE_EXHAUSTED|payment/i;
let abortReason = null;
async function guard() {
  const s = await page.evaluate(() => ({ closes: window.__live.closes, errors: window.__live.ev.filter((e) => e.k === "error") })).catch(() => ({ closes: [], errors: [] }));
  const bad = tokenResponses.find((r) => r.status !== 200);
  if (bad && (bad.status === 429 || QUOTA.test(String(bad.error)))) return `token route: HTTP ${bad.status} ${bad.error}`;
  if (bad) return `token route failed: HTTP ${bad.status} ${bad.error}`;
  const c = s.closes.find((x) => x.code !== 1000 && x.code !== 1005);
  if (c && (QUOTA.test(c.reason) || c.code === 1011 || c.code === 1008)) return `socket closed ${c.code}: ${c.reason}`;
  if (s.errors.length) return `server error message: ${s.errors[0].d}`;
  const st = await page.getByTestId("stage").getAttribute("data-live-status").catch(() => null);
  if (st === "failed") return "live status failed";
  return null;
}

const wallStart = Date.now();
const killer = setTimeout(async () => { abortReason ??= "hard 5-minute limit"; await page.getByTestId("stop-assistance").click().catch(() => {}); }, HARD_LIMIT_MS);
await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByTestId("live-toggle").click();
const t0 = Date.now();
let lastStatus = "";
while ((Date.now() - t0) / 1000 < END_AT_S) {
  abortReason ??= await guard();
  if (abortReason) break;
  const st = await page.getByTestId("stage").getAttribute("data-live-status").catch(() => null);
  if (st !== lastStatus) { console.log(`${((Date.now() - t0) / 1000).toFixed(1)} s  live: ${st}`); lastStatus = st; }
  await new Promise((r) => setTimeout(r, 500));
}
// End: the user's button. Then the measurements from Settings.
await page.getByTestId("stop-assistance").click().catch(() => {});
const endedAt = Date.now();
clearTimeout(killer);
await new Promise((r) => setTimeout(r, 1500));
const tracksAfter = await page.evaluate(() => window.__live.tracks.map((x) => ({ kind: x.kind, state: x.readyState }))).catch(() => []);
let statsText = "";
try {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("live-stats").locator("summary").click();
  statsText = (await page.getByTestId("live-stats").innerText()).replace(/\n/g, " | ");
  await page.screenshot({ path: join(OUT, MOCK ? "settings-stats-mock.png" : "settings-stats.png"), fullPage: true });
} catch (e) { statsText = `(not read: ${e.message.slice(0, 100)})`; }
const L = await page.evaluate(() => window.__live);
const origin = await page.evaluate(() => performance.timeOrigin).catch(() => 0);
const appState = await page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem("nadhra.liveTotals.v1") ?? "null"); } catch { return null; }
});
await browser.close();

// --- analysis --------------------------------------------------------------------------------------
const micAt = L.micAt;
const rel = (t) => (t - micAt) / 1000;
const ev = L.ev.map((e) => ({ ...e, s: rel(e.t) }));
const turns = [];
let cur = null;
for (const e of ev) {
  if (e.k === "cue" || e.k === "text") { cur = { kind: e.k, s: e.s, user: "", ai: "", firstAudio: null, audioBytes: 0, interrupted: false }; turns.push(cur); continue; }
  if (e.k === "user") {
    if (!cur || cur.kind !== "user" || cur.done) { cur = { kind: "user", s: e.s, user: "", ai: "", firstAudio: null, audioBytes: 0, interrupted: false }; turns.push(cur); }
    cur.user += e.d;
  }
  if (!cur) continue;
  if (e.k === "audio") { cur.firstAudio ??= e.s; cur.audioBytes += e.n; }
  if (e.k === "ai") cur.ai += e.d;
  if (e.k === "interrupted") cur.interrupted = true;
  if (e.k === "turn") cur.done = true;
}
// Every frame sent: when (camera clock), the scene the timeline expects, the scene it really shows.
const camAt = L.camAt;
const frames = MOCK
  ? mock.frames.map((f) => { const t = f.at - origin; return { s: rel(t), cam: (t - camAt) / 1000, expected: sceneAt((t - camAt) / 1000), actual: f.scene }; })
  : ev.filter((e) => e.k === "frame").map((e) => ({ s: e.s, cam: (e.t - camAt) / 1000, expected: sceneAt((e.t - camAt) / 1000), actual: sceneOfFrame(e.d) }));
const sceneSeenAt = (s) => [...frames].reverse().find((f) => f.s <= s)?.actual ?? "none";
// Away from a scene change (±2 s), a sent frame must show the scene the timeline says.
const bounds = []; { let b = 0; for (const [, d] of SEGMENTS) { b += d; bounds.push(b); } }
const nearBound = (c) => bounds.some((b) => Math.abs(c - b) < 2);
const frameMismatches = frames.filter((f) => !nearBound(f.cam) && f.expected !== f.actual);
const firstAudioAfter = (s) => ev.find((e) => e.k === "audio" && e.s > s)?.s ?? null;
const qLatency = marks.map((m) => { const a = firstAudioAfter(m.speechEnd); return { ...m, firstAudio: a, latencyS: a == null ? null : a - m.speechEnd, sceneSeen: sceneSeenAt(m.speechEnd), sceneExpected: sceneAt(m.speechEnd + (micAt - camAt) / 1000) }; });

const sum = { input: {}, output: {}, prompt: 0, response: 0, total: 0, messages: L.usage.length };
for (const { u } of L.usage) {
  sum.prompt += u.promptTokenCount ?? 0; sum.response += u.responseTokenCount ?? 0; sum.total += u.totalTokenCount ?? 0;
  for (const d of u.promptTokensDetails ?? []) sum.input[d.modality] = (sum.input[d.modality] ?? 0) + (d.tokenCount ?? 0);
  for (const d of u.responseTokensDetails ?? []) sum.output[d.modality] = (sum.output[d.modality] ?? 0) + (d.tokenCount ?? 0);
}
const durationS = (endedAt - t0) / 1000;
const result = {
  abortReason, durationS, wallS: (Date.now() - wallStart) / 1000, tokenResponses, closes: L.closes, consoleErrors,
  sent: { ...L.sent, audioSeconds: L.sent.audioBytes / (RATE * 2), videoFramesPerMin: (L.sent.video / durationS) * 60 },
  received: { audioSeconds: ev.filter((e) => e.k === "audio").reduce((a, e) => a + e.n, 0) / (24000 * 2) },
  mock: MOCK ? { cues: mock.cues, spokenCues: mock.spokenCues, userTurns: mock.userTurns, interruptions: mock.interruptions ?? 0,
    turns: mock.turns.map((x) => { const t = x.at - origin; return { cam: +((t - camAt) / 1000).toFixed(1), kind: x.kind, sceneSeen: x.scene, sceneExpected: sceneAt((t - camAt) / 1000), spoken: x.spoken }; }) } : undefined, micAfterCameraS: (micAt - camAt) / 1000,
  frameCheck: { sent: frames.length, mismatches: frameMismatches.length, examples: frameMismatches.slice(0, 5), byScene: frames.reduce((a, f) => ((a[f.actual] = (a[f.actual] ?? 0) + 1), a), {}),
    sceneChanges: frames.filter((f, i) => i && f.actual !== frames[i - 1].actual).map((f) => ({ cam: +f.cam.toFixed(1), to: f.actual })) },
  questions: qLatency, turns: turns.map((x) => ({ ...x, scene: sceneSeenAt(x.s) })),
  usageSum: sum, usageRaw: L.usage.map((x) => ({ s: rel(x.t), u: x.u })), appStats: statsText, deviceTotals: appState, tracksAfter,
};
writeFileSync(join(OUT, MOCK ? "result-mock.json" : "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, usageRaw: `${result.usageRaw.length} messages (see result.json)` }, null, 2));
process.exit(abortReason && abortReason !== "hard 5-minute limit" ? 2 : 0);
