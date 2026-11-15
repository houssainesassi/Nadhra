// Android Phase 1: ONE real Gemini Live session on a phone, at most 6 minutes, recorded. Free-tier
// quota: run only with the owner's approval, a sighted supervisor present, away from traffic.
//
// Checks that Gemini accepts the setup with context compression (triggerTokens 25,600 → targetTokens
// 12,800), that the connection stays up beyond 5 minutes, and records tokens per turn, any context
// trimming (the prompt count dropping), latency, reconnects and errors.
//
// STOPS AT ONCE, with no retry reaching Google, if the setup or the token is refused, or on any
// quota/billing error: a kill switch in the page blocks every further token request and socket, and
// the session is ended with the app's own End button.
//
//   Phone: USB debugging on, connected, "Allow" the computer.  adb: ~/Android/Sdk/platform-tools/adb
//   Server (one model only, so no fallback can retry with another model):
//     GEMINI_LIVE_MODELS=gemini-3.1-flash-live-preview npx next start -p 3100
//   node e2e/live/android-phase1.mjs                         real session on the phone
//   node e2e/live/android-phase1.mjs --desktop --mock accept|reject-token|reject-socket
//                                                            checks this script itself: desktop
//                                                            Chromium, fake Gemini, no quota
import { _android, chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] ?? true; };
const DESKTOP = process.argv.includes("--desktop");
const MOCK = arg("--mock"); // accept | reject-token | reject-socket
const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const LIMIT_S = Number(arg("--seconds") ?? 360); // 6 minutes
const OUT = new URL(`./out/android-phase1${MOCK ? `-mock-${MOCK}` : ""}/`, import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const ADB = join(homedir(), "Android/Sdk/platform-tools/adb");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!DESKTOP && MOCK) throw new Error("--mock is for --desktop only: the phone run is the real one");

// --- device ------------------------------------------------------------------------------------------
let context, device = null, battery = { start: null, end: null };
const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8" });
function readBattery() {
  try {
    const d = adb("shell", "dumpsys", "battery");
    const level = Number(/level: (\d+)/.exec(d)?.[1]);
    const temp = Number(/temperature: (\d+)/.exec(d)?.[1]) / 10;
    return { level, temperatureC: temp, at: new Date().toISOString() };
  } catch { return null; }
}
if (DESKTOP) {
  const root = join(homedir(), ".cache", "ms-playwright");
  const executablePath = join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
  const browser = await chromium.launch({ executablePath, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera", "microphone"] });
} else {
  const devices = await _android.devices();
  if (devices.length !== 1) throw new Error(`expected exactly one phone, found ${devices.length}`);
  device = devices[0];
  log(`phone: ${device.model()} (${device.serial()})`);
  adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`); // the phone's localhost:3100 is this computer's: a secure context, nothing deployed
  battery.start = readBattery();
  await device.shell("am force-stop com.android.chrome");
  context = await device.launchBrowser();
  await context.grantPermissions(["camera", "microphone"], { origin: BASE }).catch(() => log("could not pre-grant permissions: allow them on the phone"));
}

// --- fake Gemini (desktop checks of this script only) -------------------------------------------------
const fake = { tokenRequests: 0, sockets: 0, setups: [] };
if (MOCK) {
  await context.route("**/api/live/token", (route) => {
    fake.tokenRequests++;
    if (MOCK === "reject-token") return route.fulfill({ status: 502, json: { error: "upstream-unavailable" } });
    return route.fulfill({ json: { token: "auth_tokens/fake", url: "wss://generativelanguage.googleapis.com/ws/fake",
      setup: { model: "models/fake", contextWindowCompression: { triggerTokens: 25600, slidingWindow: { targetTokens: 12800 } } }, model: "fake", voice: "Sulafat", lastModel: true, pricing: null } });
  });
  await context.route("**/api/report", (route) => route.fulfill({ json: { accepted: 0 } }));
  await context.routeWebSocket(/generativelanguage\.googleapis\.com/, (ws) => {
    fake.sockets++;
    ws.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (!m.setup) return;
      fake.setups.push(m.setup);
      if (MOCK === "reject-socket") return ws.close({ code: 1007, reason: "Invalid JSON payload received. Unknown name \"triggerTokens\"" });
      ws.send(JSON.stringify({ setupComplete: {} }));
      let n = 0;
      const iv = setInterval(() => { // a turn every 5 s, with a prompt that grows and is trimmed once
        n++;
        const prompt = n === 4 ? 13_000 : 2000 + n * 6000;
        ws.send(JSON.stringify({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: prompt, responseTokenCount: 40, totalTokenCount: prompt + 40 } }));
      }, 5000);
      ws.onClose(() => clearInterval(iv));
    });
  });
}

// --- instrumentation and kill switch, in the page -----------------------------------------------------
await context.addInitScript(() => {
  if (location.port !== "3100") return;
  localStorage.setItem("assistant.consent.v3", "1"); // this test origin only
  localStorage.setItem("assistant.liveConsent.v1", "1");
  const L = (window.__p1 = { halt: null, ev: [], usage: [], closes: [], setupSent: null, setupDone: 0, tokens: [], tracks: [], blocked: 0 });
  const stop = (why) => { if (!L.halt) L.halt = { why, at: Date.now() }; };
  const f = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.includes("/api/live/token")) {
      if (L.halt) { L.blocked++; throw new TypeError("halted: no retry"); }
      const res = await f(input, init);
      let body = null;
      try { body = await res.clone().json(); } catch {}
      L.tokens.push({ at: Date.now(), status: res.status, error: body?.error ?? null });
      if (!res.ok) stop(`token refused: HTTP ${res.status} ${body?.error ?? ""}`);
      return res;
    }
    return f(input, init);
  };
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => { const s = await gum(c); L.tracks.push(...s.getTracks()); return s; };
  const W = window.WebSocket;
  window.WebSocket = class extends W {
    constructor(url, p) {
      if (String(url).includes("generativelanguage") && L.halt) { L.blocked++; throw new Error("halted: no retry"); }
      super(url, p);
      if (!String(url).includes("generativelanguage")) return;
      let setupDone = false;
      const send = this.send.bind(this);
      this.send = (d) => {
        try {
          const m = JSON.parse(d);
          if (m.setup) L.setupSent = { at: Date.now(), model: m.setup.model, contextWindowCompression: m.setup.contextWindowCompression ?? null };
          else if (m.realtimeInput?.video) L.ev.push({ t: Date.now(), k: "frame" });
          else if (typeof m.realtimeInput?.text === "string") L.ev.push({ t: Date.now(), k: m.realtimeInput.text.startsWith("[camera-update]") ? "cue" : "text" });
        } catch {}
        return send(d);
      };
      this.addEventListener("close", (e) => {
        L.closes.push({ at: Date.now(), code: e.code, reason: String(e.reason || "").slice(0, 300), afterSetup: setupDone });
        if (!setupDone) stop(`setup refused: socket closed ${e.code} ${String(e.reason || "").slice(0, 200)}`);
        else if (/quota|exhaust|billing|RESOURCE_EXHAUSTED|429|payment/i.test(e.reason || "")) stop(`quota/billing: ${e.code} ${e.reason}`);
      });
      this.addEventListener("message", (e) => {
        const handle = (text) => {
          let m;
          try { m = JSON.parse(text); } catch { return; }
          const now = Date.now();
          if (m.setupComplete) { setupDone = true; L.setupDone++; L.ev.push({ t: now, k: "setup" }); }
          if (m.error) stop(`server error: ${JSON.stringify(m.error).slice(0, 200)}`);
          if (m.goAway) L.ev.push({ t: now, k: "goAway", d: m.goAway.timeLeft });
          if (m.usageMetadata) L.usage.push({ t: now, u: m.usageMetadata });
          const sc = m.serverContent;
          if (!sc) return;
          if (sc.modelTurn?.parts?.some((p) => p.inlineData?.data)) L.ev.push({ t: now, k: "audio" });
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

// --- the session ----------------------------------------------------------------------------------------
const page = context.pages()[0] ?? (await context.newPage());
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
await page.goto(BASE, { waitUntil: "networkidle" });
const status = () => page.getByTestId("stage").getAttribute("data-live-status").catch(() => null);
const p1 = () => page.evaluate(() => { const L = window.__p1; return { ...L, tracks: L.tracks.map((t) => ({ kind: t.kind, state: t.readyState })) }; });

log(DESKTOP ? `desktop check, mock: ${MOCK}` : "REAL session: Talk live starts now. Supervisor: keep the phone pointed at the room; ask a question about once a minute.");
await page.getByTestId("live-toggle").click();
const t0 = Date.now();
let halt = null, lastStatus = "", ever = { open: false, reconnecting: 0 }, statusLog = [];
while ((Date.now() - t0) / 1000 < LIMIT_S) {
  const st = await status();
  if (st !== lastStatus) {
    statusLog.push({ s: +((Date.now() - t0) / 1000).toFixed(1), status: st });
    log(`${((Date.now() - t0) / 1000).toFixed(0)} s  live: ${st}`);
    if (st === "open") ever.open = true;
    if (st === "reconnecting") ever.reconnecting++;
    lastStatus = st;
  }
  // Refused before ever opening (the app is about to retry): stop it from the page at once.
  if (st === "reconnecting" && !ever.open) await page.evaluate(() => { window.__p1.halt ??= { why: "reconnecting before the first setup completed", at: Date.now() }; });
  if (st === "failed") await page.evaluate(() => { window.__p1.halt ??= { why: "live status failed", at: Date.now() }; });
  halt = (await p1()).halt;
  if (halt) { log(`STOP: ${halt.why}`); break; }
  await new Promise((r) => setTimeout(r, 100));
}
await page.getByTestId("stop-assistance").click().catch(() => {}); // End (or nothing if already off)
const endedAt = Date.now();
await new Promise((r) => setTimeout(r, 2000));
const L = await p1();
battery.end = device ? readBattery() : null;
let stats = "";
try {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("live-stats").locator("summary").click();
  stats = (await page.getByTestId("live-stats").innerText()).replace(/\n/g, " | ");
  await page.screenshot({ path: join(OUT, "settings-stats.png"), fullPage: true });
} catch (e) { stats = `(not read: ${String(e.message).slice(0, 80)})`; }
await context.close();
if (device) device.close();

// --- report ------------------------------------------------------------------------------------------------
const rel = (t) => +((t - t0) / 1000).toFixed(1);
const usage = L.usage.map((x) => ({ s: rel(x.t), prompt: x.u.promptTokenCount ?? 0, response: x.u.responseTokenCount ?? 0, total: x.u.totalTokenCount ?? 0 }));
const trims = usage.filter((u, i) => i && u.prompt < usage[i - 1].prompt * 0.8).map((u) => ({ s: u.s, from: usage[usage.indexOf(u) - 1].prompt, to: u.prompt }));
const result = {
  mode: DESKTOP ? `desktop mock ${MOCK}` : "real phone", limitS: LIMIT_S, durationS: rel(endedAt), halt,
  setup: { sent: L.setupSent, accepted: L.setupDone > 0, setupCompletes: L.setupDone },
  stableBeyond5min: !halt && ever.open && rel(endedAt) >= 300 && !L.closes.some((c) => c.code !== 1000 && c.code !== 1005),
  tokenRequests: L.tokens, retriesBlocked: L.blocked, closes: L.closes.map((c) => ({ ...c, s: rel(c.at) })), statusLog,
  reconnects: ever.reconnecting, usage, usageSum: usage.reduce((a, u) => ({ prompt: a.prompt + u.prompt, response: a.response + u.response, total: a.total + u.total }), { prompt: 0, response: 0, total: 0 }),
  maxPrompt: Math.max(0, ...usage.map((u) => u.prompt)), trims,
  frames: L.ev.filter((e) => e.k === "frame").length, cues: L.ev.filter((e) => e.k === "cue").length, turns: L.ev.filter((e) => e.k === "turn").length,
  interrupted: L.ev.filter((e) => e.k === "interrupted").length, transcript: L.ev.filter((e) => e.k === "user" || e.k === "ai").map((e) => ({ s: rel(e.t), k: e.k, d: e.d })),
  appStats: stats, tracksAfterEnd: L.tracks, battery, consoleErrors, fake: MOCK ? fake : undefined,
};
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, transcript: `${result.transcript.length} pieces (result.json)`, usage: `${usage.length} turns (result.json)` }, null, 2));
process.exit(halt ? 2 : 0);
