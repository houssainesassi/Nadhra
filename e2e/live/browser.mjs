// End-to-end test of the live conversation in Chromium, on the production build, against the REAL
// Gemini Live service, with a fake camera (a photo of a mechanic at work) and a fake microphone
// (spoken Derja questions on a timeline). Uses free-tier Live quota.
//
//   sh e2e/live/make_fixtures.sh
//   npm run build && npx next start -p 3100
//   node e2e/live/browser.mjs http://localhost:3100
//
// Checks: camera frames reach the model, microphone speech is recognised, answers are spoken in
// Derja, latency (measured by the app and from the known timeline), interruption while the model
// speaks, several turns in one session, memory after a turn, and the page at phone size.
// Writes each answer's audio to e2e/live/out/browser_turn<N>.wav for listening and pitch checks.
import { chromium } from "playwright-core";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = new URL("./out/", import.meta.url).pathname;

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), ".cache/ms-playwright");
  for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
    const p = join(root, d, "chrome-linux64/chrome");
    if (existsSync(p)) return p;
  }
  throw new Error("No Chromium found; set CHROME_PATH");
}

// --- fixtures: camera video and the microphone timeline ------------------------------------------
const RATE = 16000;
const pcm = (n) => readFileSync(join(OUT, `${n}.pcm`));
const silence = (s) => Buffer.alloc(Math.round(s * RATE) * 2);
// [what, seconds of silence after it]. Times are from the moment the microphone opens.
const TIMELINE = [
  [silence(3.0), "connect"],
  [pcm("q_mech"), "Q1: شنوة قاعد يصير توّا؟"],
  [silence(9.0), ""],
  [pcm("q_right"), "Q2: وشنوّة فمّا على يميني؟"],
  [silence(9.0), ""],
  [pcm("q_mech"), "Q3: (asked again, to be interrupted)"],
  [silence(1.6), ""],
  [pcm("q_interrupt"), "Q4: talks over the answer — استنّى استنّى، قلّي كان شنوّة لون الكرهبة؟"],
  [silence(9.0), ""],
  [pcm("q_before"), "Q5: شنوّة قلتلي قبل شويّة؟"],
  [silence(10.0), ""],
];
const marks = [];
let t = 0;
for (const [buf, label] of TIMELINE) {
  const dur = buf.length / 2 / RATE;
  if (label && label !== "connect") marks.push({ label, start: t, end: t + dur });
  t += dur;
}
const TOTAL_S = t;
const all = Buffer.concat(TIMELINE.map(([b]) => b));
const wavHeader = (len, rate) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + len, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(len, 40);
  return h;
};
writeFileSync(join(OUT, "mic_timeline.wav"), Buffer.concat([wavHeader(all.length, RATE), all]));
if (!existsSync(join(OUT, "mech.mjpeg"))) {
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-loop", "1", "-i", join(OUT, "mech.jpg"), "-t", "4", "-r", "10", "-vf", "scale=720:960", "-q:v", "4", join(OUT, "mech.mjpeg")]);
}

// --- run -------------------------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath: chromePath(),
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${join(OUT, "mech.mjpeg")}`,
    `--use-file-for-fake-audio-capture=${join(OUT, "mic_timeline.wav")}%noloop`,
  ],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "ar-TN", permissions: ["camera", "microphone"] });
// Test-only instrumentation: watch the live WebSocket from inside the page (the app is unchanged).
await ctx.addInitScript(() => {
  localStorage.setItem("assistant.consent.v2", "1");
  const W = window.WebSocket;
  window.__live = { ev: [], sent: { audio: 0, video: 0, text: 0, setup: 0 }, micOpenAt: 0 };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    const s = await gum(c);
    if (c && c.audio) window.__live.micOpenAt = performance.now();
    return s;
  };
  window.WebSocket = class extends W {
    constructor(url, p) {
      super(url, p);
      if (!String(url).includes("generativelanguage")) return;
      window.__live.ev.push({ t: performance.now(), k: "open-socket" });
      const send = this.send.bind(this);
      this.send = (d) => {
        try {
          const m = JSON.parse(d);
          if (m.setup) window.__live.sent.setup++;
          else if (m.realtimeInput?.audio) window.__live.sent.audio++;
          else if (m.realtimeInput?.video) { window.__live.sent.video++; window.__live.ev.push({ t: performance.now(), k: "frame" }); }
          else if (m.realtimeInput?.text) window.__live.sent.text++;
        } catch {}
        return send(d);
      };
      this.addEventListener("message", (e) => {
        const now = performance.now();
        const text = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
        let m;
        try { m = JSON.parse(text); } catch { return; }
        const sc = m.serverContent;
        if (m.setupComplete) window.__live.ev.push({ t: now, k: "setup" });
        if (m.voiceActivity) window.__live.ev.push({ t: now, k: m.voiceActivity.type });
        if (!sc) return;
        for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) window.__live.ev.push({ t: now, k: "audio", d: p.inlineData.data });
        if (sc.inputTranscription?.text) window.__live.ev.push({ t: now, k: "user", d: sc.inputTranscription.text });
        if (sc.outputTranscription?.text) window.__live.ev.push({ t: now, k: "ai", d: sc.outputTranscription.text });
        if (sc.interrupted) window.__live.ev.push({ t: now, k: "interrupted" });
        if (sc.turnComplete) window.__live.ev.push({ t: now, k: "turn" });
      });
    }
  };
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.goto(BASE, { waitUntil: "networkidle" });

const latencies = [];
// Talk live is in Settings; the panel stays open over the camera.
await page.getByTestId("open-settings").click();
await page.getByTestId("live-toggle").click();
const started = Date.now();
let lastLatency = null;
while (Date.now() - started < (TOTAL_S + 4) * 1000) {
  await page.waitForTimeout(250);
  const meta = (await page.getByTestId("live-meta").textContent().catch(() => "")) ?? "";
  const m = meta.match(/answered in ([\d.]+) s/);
  if (m && m[1] !== lastLatency) {
    lastLatency = m[1];
    latencies.push(Number(m[1]) * 1000);
  }
}
const ui = {
  status: await page.getByTestId("live-toggle").getAttribute("data-live-status"),
  state: await page.getByTestId("assistant-state").textContent(),
  mic: await page.getByTestId("mic-status").textContent(),
  user: await page.getByTestId("live-user").textContent().catch(() => ""),
  ai: await page.getByTestId("live-ai").textContent().catch(() => ""),
  videoPlaying: await page.evaluate(() => { const v = document.querySelector("video"); return !!v && v.videoWidth > 0 && !v.paused; }),
};
const live = await page.evaluate(() => window.__live);
await page.screenshot({ path: join(OUT, "desktop.png") });

// End the conversation from the UI: the microphone must be released.
await page.getByTestId("live-toggle").click();
await page.waitForTimeout(500);
const afterStop = await page.getByTestId("live-toggle").getAttribute("data-live-status");

// --- analysis ----------------------------------------------------------------------------------
const t0 = live.micOpenAt;
const rel = (x) => (x - t0) / 1000;
const turns = [];
let cur = null;
for (const e of live.ev) {
  if (e.k === "user") {
    if (!cur || cur.ai) { cur = { user: "", ai: "", audio: [], firstAudio: null, interrupted: false, done: false }; turns.push(cur); }
    cur.user += e.d;
  } else if (e.k === "audio" && cur) {
    if (cur.firstAudio == null) cur.firstAudio = rel(e.t);
    cur.audio.push(e.d);
  } else if (e.k === "ai" && cur) cur.ai += e.d;
  else if (e.k === "interrupted" && cur) cur.interrupted = true;
  else if (e.k === "turn" && cur) cur.done = true;
}
console.log(`\nmicrophone timeline (${TOTAL_S.toFixed(1)} s):`);
for (const m of marks) console.log(`  ${m.start.toFixed(1)}-${m.end.toFixed(1)} s  ${m.label}`);
console.log(`\nsetup complete at ${rel(live.ev.find((e) => e.k === "setup")?.t ?? NaN).toFixed(2)} s after the mic opened`);
console.log(`sent: ${live.sent.audio} audio chunks, ${live.sent.video} camera frames, ${live.sent.setup} setup(s)`);
console.log(`frame times (s): ${live.ev.filter((e) => e.k === "frame").map((e) => rel(e.t).toFixed(1)).join(" ")}`);
turns.forEach((tr, i) => {
  const b = Buffer.concat(tr.audio.map((d) => Buffer.from(d, "base64")));
  const file = join(OUT, `browser_turn${i + 1}.wav`);
  writeFileSync(file, Buffer.concat([wavHeader(b.length, 24000), b]));
  // The question this answer follows: the last one that ended before its first audio.
  const q = [...marks].reverse().find((m) => tr.firstAudio != null && m.end <= tr.firstAudio + 0.05);
  const fromTimeline = q && tr.firstAudio != null ? Math.round((tr.firstAudio - q.end) * 1000) : null;
  console.log(`\nturn ${i + 1}${tr.interrupted ? " (INTERRUPTED by the user)" : ""}`);
  console.log(`  user heard : ${tr.user.trim()}`);
  console.log(`  assistant  : ${tr.ai.trim()}`);
  console.log(`  first audio: ${tr.firstAudio?.toFixed(2)} s; ${fromTimeline} ms after "${q?.label.slice(0, 3)}" ended; ${(b.length / 48000).toFixed(1)} s of speech -> ${file.split("/").pop()}`);
});
console.log(`\napp-measured latencies (end of speech -> first sound): ${latencies.map((x) => Math.round(x) + " ms").join(", ")}`);
console.log(`interruptions: ${live.ev.filter((e) => e.k === "interrupted").length}`);
console.log(`UI at the end: ${JSON.stringify(ui)}`);
console.log(`after End: status=${afterStop}`);
console.log(`console errors: ${consoleErrors.length ? consoleErrors.join(" | ") : "none"}`);

// --- phone size --------------------------------------------------------------------------------
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: "ar-TN", permissions: ["camera", "microphone"] });
const p2 = await phone.newPage();
await p2.goto(BASE, { waitUntil: "networkidle" });
const mobile = await p2.evaluate(() => {
  const b = document.querySelector('[data-testid="open-camera"]').getBoundingClientRect();
  return { overflowX: document.documentElement.scrollWidth > innerWidth, overflowY: document.documentElement.scrollHeight > innerHeight, button: { top: Math.round(b.top), height: Math.round(b.height), width: Math.round(b.width) }, viewport: innerWidth };
});
await p2.screenshot({ path: join(OUT, "phone.png"), fullPage: false });
console.log(`phone 390x844: ${JSON.stringify(mobile)}`);
await browser.close();
