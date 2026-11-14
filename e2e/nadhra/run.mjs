// Nadhra in real Chromium against the production build (`next build` first): the provider switch on
// the home screen, persistence, privacy and consent rules, and the three safety fixes (repeated
// screen-reader announcements, no connectivity probe, cancelling what is in progress on the switch).
//
// Three `next start` servers, each under e2e/nadhra/netlog.mjs (every outgoing connection of the server
// is recorded and blocked: no Gemini quota, nothing reaches any cloud service):
//   hybrid  AI_MODE=hybrid NADHRA_AI_ENABLED=1   the Nadhra machine, DEFAULT settings otherwise
//   public  NADHRA_AI_ENABLED=1, AI_MODE unset   the flag alone must not expose Nadhra
//   plain   nothing set                          today's public configuration
// Fake camera (e2e/make_synthetic_camera.py), no microphone, no /api route mocked.
//
//   node --experimental-strip-types e2e/nadhra/run.mjs <fixtures-dir>
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { speech } from "../../src/lib/assistant/phrases.ts";
import { UI_TEXT } from "../../src/lib/assistant/uiText.ts";

const fixtures = process.argv[2];
if (!fixtures) throw new Error("usage: node --experimental-strip-types e2e/nadhra/run.mjs <fixtures-dir>");
const OUT = "e2e/nadhra/out";
mkdirSync(OUT, { recursive: true });
const T = speech("tn");
const UI = UI_TEXT.tn;
const REFUSAL = `${T.nadhra.unavailable} ${T.nadhra.needsGemini}`;
const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };

// --- servers -------------------------------------------------------------------------------------
const NETLOG = resolve("e2e/nadhra/netlog.mjs");
const DELAY = resolve(OUT, "netlog-delay-ms");
writeFileSync(DELAY, "0");
const setDelay = (ms) => writeFileSync(DELAY, String(ms));
const servers = {
  hybrid: { port: 3201, env: { AI_MODE: "hybrid", NADHRA_AI_ENABLED: "1" } },
  public: { port: 3202, env: { NADHRA_AI_ENABLED: "1" } },
  plain: { port: 3203, env: {} },
};
const children = [];
for (const [name, s] of Object.entries(servers)) {
  s.log = resolve(OUT, `netlog-${name}.jsonl`);
  rmSync(s.log, { force: true });
  const env = { ...process.env, ...s.env, NODE_OPTIONS: `--import ${NETLOG}`, NETLOG_FILE: s.log, NETLOG_DELAY_FILE: DELAY, NEXT_TELEMETRY_DISABLED: "1",
    // Fakes override .env.local: even an unblocked call could not use real quota.
    GEMINI_API_KEY: "e2e-fake-gemini-key", OPENROUTER_API_KEY: "e2e-fake-openrouter-key" };
  for (const k of ["AI_MODE", "NADHRA_AI_ENABLED", "INTERNET_PROBE_URL"]) if (!(k in s.env)) delete env[k];
  const child = spawn("node_modules/.bin/next", ["start", "-p", String(s.port)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stdout.on("data", (d) => (s.stdout = (s.stdout ?? "") + d));
  child.stderr.on("data", (d) => (s.stdout = (s.stdout ?? "") + d));
  children.push(child);
  s.base = `http://localhost:${s.port}`;
}
const stopServers = () => { for (const c of children) { try { process.kill(-c.pid, "SIGTERM"); } catch {} } };
process.on("exit", stopServers);
for (const s of Object.values(servers)) {
  const up = await until(() => fetch(`${s.base}/api/vision`).then((r) => r.ok, () => false), 30_000, 300);
  if (!up) { console.log(s.stdout); throw new Error(`server ${s.port} did not start`); }
}
const netlog = (name) => (existsSync(servers[name].log) ? readFileSync(servers[name].log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const since = (name, t) => netlog(name).filter((e) => e.t >= t);
const isGeminiModel = (e) => e.via === "fetch" && /generativelanguage\.googleapis\.com\/v1beta\/models\//.test(e.url);

// --- public configuration ----------------------------------------------------------------------------
const status = {};
for (const name of Object.keys(servers)) status[name] = await (await fetch(`${servers[name].base}/api/vision`)).json();
check("public (flag set, AI_MODE unset): status has no nadhra", !("nadhra" in status.public), JSON.stringify(status.public));
check("plain: status has no nadhra", !("nadhra" in status.plain));
check("public status identical with and without the flag", JSON.stringify(status.public) === JSON.stringify(status.plain));
check("hybrid status offers Nadhra, experimental, no task", JSON.stringify(status.hybrid.nadhra) === JSON.stringify({ experimental: true, tasks: [] }) && status.hybrid.mode === "hybrid", JSON.stringify(status.hybrid));

// --- browser -------------------------------------------------------------------------------------
const browser = await chromium.launch({
  executablePath,
  args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${join(fixtures, "synthetic.mjpeg")}`],
});

async function open(base, viewport = { width: 412, height: 915 }) {
  const ctx = await browser.newContext({ viewport, permissions: ["camera", "microphone"] });
  await ctx.addInitScript(() => {
    // What was said (caption and live regions), and every insertion into the screen-reader regions.
    window.__said = [];
    window.__announced = [];
    const last = new WeakMap();
    const seen = (t) => { t = (t || "").trim(); if (t && window.__said[window.__said.length - 1] !== t) window.__said.push(t); };
    new MutationObserver(() => {
      document.querySelectorAll('[data-testid=last-spoken],[aria-live],[role=alert]').forEach((e) => seen(e.textContent));
      document.querySelectorAll('[data-testid^="announce-"]').forEach((el) => {
        const t = el.textContent.trim();
        if (t !== (last.get(el) ?? "")) { last.set(el, t); if (t) window.__announced.push(t); }
      });
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const requests = [];
  const failed = [];
  const errors = [];
  const page = await ctx.newPage();
  page.on("request", (r) => requests.push({ t: Date.now(), method: r.method(), url: r.url(), body: r.postData() ?? "" }));
  page.on("requestfailed", (r) => failed.push({ t: Date.now(), url: r.url(), why: r.failure()?.errorText ?? "" }));
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base, { waitUntil: "networkidle" });
  return { ctx, page, requests, failed, errors };
}
const said = (page) => page.evaluate(() => window.__said.join(" \n "));
const heard = async (page, text, ms = 8_000) => !!(await until(async () => (await said(page)).includes(text.slice(0, 30)), ms));
const announcedCount = (page, text) => page.evaluate((t) => window.__announced.filter((a) => a === t).length, text);
const stage = (page, attr) => page.locator("[data-testid=stage]").getAttribute(`data-${attr}`);
const consentOpen = (page) => page.locator('dialog[aria-labelledby="consent-title"]').evaluate((d) => d.open);
async function settings(page, fn) {
  await page.click("[data-testid=open-settings]");
  await page.waitForSelector("dialog[open]");
  const r = await fn();
  await sleep(300);
  if (await page.locator("dialog[open] [data-testid=voice-commands]").count()) await page.keyboard.press("Escape");
  await until(async () => !(await page.locator("dialog[open] [data-testid=voice-commands]").count()), 3_000);
  return r;
}
const sw = (page) => page.locator("main [data-testid=ai-provider]");
const active = (page) => sw(page).getAttribute("data-active");
const notice = (page) => until(async () => (await page.locator("[data-testid=ai-provider-notice]").textContent())?.trim(), 3_000);
const choose = async (page, p) => { await page.click(`main [data-testid=ai-provider-${p}]`); await sleep(200); };

for (const name of ["public", "plain"]) {
  const { page, ctx } = await open(servers[name].base);
  check(`${name}: no AI switch on the home screen`, (await sw(page).count()) === 0);
  check(`${name}: none in Settings either`, (await settings(page, () => page.locator("dialog[open] [data-testid=ai-provider]").count())) === 0);
  await ctx.close();
}

// --- hybrid: the Nadhra machine ----------------------------------------------------------------------
const { page, ctx, requests, failed, errors } = await open(servers.hybrid.base);
const posts = (t = 0) => requests.filter((r) => r.t >= t && r.method !== "GET");
const aiPosts = (t = 0) => posts(t).filter((r) => /\/api\/(vision|live)/.test(r.url));
const offOrigin = () => requests.filter((r) => !r.url.startsWith(servers.hybrid.base) && !r.url.startsWith("data:") && !r.url.startsWith("blob:"));

check("home: the AI switch is on the home screen", (await sw(page).count()) === 1 && (await sw(page).isVisible()));
check("home: not in Settings any more", (await settings(page, () => page.locator("dialog[open] [data-testid=ai-provider]").count())) === 0);
check("Gemini is the default, selected", (await active(page)) === "gemini" && (await page.locator("[data-testid=ai-provider-gemini] input").isChecked()));
const names = await page.locator("main [data-testid=ai-provider] .ai-switch-name").allTextContents();
check("names exactly: Gemini / Nadhra (experimental)", JSON.stringify(names.map((n) => n.replace(/\s+/g, " ").trim())) === JSON.stringify(["Gemini", "Nadhra (experimental)"]), JSON.stringify(names));
check("radio names read correctly by screen readers", (await page.getByRole("radio", { name: "Nadhra (experimental)" }).count()) === 1 && (await page.getByRole("radio", { name: "Gemini" }).count()) === 1);
check("no 'Gemini AI' or 'Nadhra AI' anywhere", !/Gemini AI|Nadhra AI/.test(await page.evaluate(() => document.body.innerText)));
check("default: no provider stored", !(await page.evaluate(() => (localStorage.getItem("assistant.settings") ?? "").includes("provider"))));

// Existing consent behaviour (Gemini).
let t0 = Date.now();
await page.click("[data-testid=open-camera]");
check("Gemini: Open camera shows the consent notice first", await until(() => consentOpen(page), 5_000));
check("Gemini: the camera waits for consent", (await stage(page, "camera")) === "off");
await page.click("text=I don't agree");
check("Gemini: declining is said, camera stays off", (await heard(page, T.consentRefused)) && (await stage(page, "camera")) === "off");
check("Gemini: no AI request before or after declining", aiPosts(t0).length === 0, JSON.stringify(aiPosts(t0).map((r) => r.url)));

// Switch to Nadhra on the home screen.
await sleep(3_000);
const tSwitch = Date.now();
await choose(page, "nadhra");
check("switch to Nadhra: one tap, now active and selected", (await active(page)) === "nadhra" && (await page.locator("[data-testid=ai-provider-nadhra] input").isChecked()));
check("switch to Nadhra: short confirmation shown", (await notice(page)) === "✓ Nadhra (experimental)");
check("switch to Nadhra: confirmation spoken", await heard(page, T.nadhra.selected));
check("switch to Nadhra: saved", await page.evaluate(() => JSON.parse(localStorage.getItem("assistant.settings")).provider === "nadhra"));

await page.click("[data-testid=open-camera]");
await until(async () => (await stage(page, "camera")) === "on", 8_000);
check("Nadhra: camera starts without the Google consent notice", (await stage(page, "camera")) === "on" && !(await consentOpen(page)));
check("Nadhra: analysis state is local", (await stage(page, "analysis")) === "local", await stage(page, "analysis"));
check("Nadhra: the switch stays visible with the camera on", await sw(page).isVisible());
check("Nadhra: status line says on-device warnings only", await until(async () => (await page.locator("[data-testid=assistant-state]").textContent())?.includes(UI.nadhra), 4_000));
check("Nadhra: camera notice spoken", await heard(page, T.nadhra.cameraNotice));

// Fix 1: the same refusal twice in a row is announced twice (no other sentence in between).
await sleep(1_500);
const beforeRefusals = await announcedCount(page, REFUSAL);
await page.keyboard.press("d");
await until(async () => (await announcedCount(page, REFUSAL)) >= beforeRefusals + 1, 6_000);
await sleep(800);
await page.keyboard.press("d");
const twice = await until(async () => (await announcedCount(page, REFUSAL)) >= beforeRefusals + 2, 6_000);
check("screen reader: the same refusal twice in a row is announced twice", !!twice, `${await announcedCount(page, REFUSAL)} vs ${beforeRefusals}`);
for (const [key, what] of [["t", "read"], ["i", "identify"], ["l", "live conversation"]]) {
  const n = await announcedCount(page, REFUSAL);
  await page.keyboard.press(key);
  check(`Nadhra: ${what} refused out loud (announced again)`, await until(async () => (await announcedCount(page, REFUSAL)) > n, 6_000));
  await sleep(500);
}
await page.keyboard.press("v");
check("Nadhra: voice commands refused, with the reason", await heard(page, T.nadhra.noVoice));
check("Nadhra: live conversation never started", (await page.locator("[data-testid=live-toggle]").getAttribute("data-live-status")) === "off");

await sleep(4_000);
check("Nadhra: the page sent nothing (no POST of any kind)", posts(tSwitch).length === 0, JSON.stringify(posts(tSwitch).map((r) => r.url)));
check("Nadhra: the page contacted no other origin", offOrigin().length === 0, JSON.stringify(offOrigin().map((r) => r.url)));
check("Nadhra: the server made no outgoing attempt at all", since("hybrid", tSwitch).length === 0, JSON.stringify(since("hybrid", tSwitch)));

const tDirect = Date.now();
const direct = await page.evaluate(async () => {
  await fetch("/api/session", { credentials: "same-origin" });
  const r = await fetch("/api/vision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "nadhra", mode: "chat", question: "test" }) });
  return { status: r.status, body: await r.json() };
});
await sleep(500);
check("server: provider nadhra → 503 nadhra-unavailable", direct.status === 503 && direct.body.error === "nadhra-unavailable", JSON.stringify(direct));
check("server: that request made no outgoing call", since("hybrid", tDirect).length === 0);

// Persistence.
await page.reload({ waitUntil: "networkidle" });
check("Nadhra persists after reload", (await active(page)) === "nadhra");
await page.click("[data-testid=open-camera]");
await until(async () => (await stage(page, "camera")) === "on", 8_000);
check("after reload: still local (camera on, no Google notice)", (await stage(page, "analysis")) === "local" && !(await consentOpen(page)));

// Back to Gemini with the camera running and no consent: the camera stops and the notice comes first.
await page.evaluate(() => (window.__said = []));
const tBack = Date.now();
await choose(page, "gemini");
check("back to Gemini: active, confirmation spoken", (await active(page)) === "gemini" && (await heard(page, T.nadhra.geminiSelected)));
check("back to Gemini without consent: camera stopped", (await until(async () => (await stage(page, "camera")) === "off", 4_000)) !== null);
check("back to Gemini without consent: consent notice shown", await until(() => consentOpen(page), 4_000));
check("back to Gemini: no AI request before consent", aiPosts(tBack).length === 0);
await page.click("text=I agree");
await until(async () => (await stage(page, "camera")) === "on", 8_000);
check("Gemini after consent: camera on, existing 'manual' state", (await stage(page, "camera")) === "on" && (await stage(page, "analysis")) === "manual", await stage(page, "analysis"));

// Gemini's path: the question goes to today's chain (attempts recorded and blocked by the harness).
const tAsk = Date.now();
await page.keyboard.press("d");
const asked = await until(() => requests.find((r) => r.t >= tAsk && r.method === "POST" && r.url.endsWith("/api/vision")), 8_000);
check("Gemini: the question is posted to /api/vision", !!asked);
check("Gemini: the request carries no provider field (today's request)", asked && !("provider" in JSON.parse(asked.body)), asked?.body.slice(0, 120));
check("Gemini: the server routed it to Gemini", !!(await until(() => since("hybrid", tAsk).find(isGeminiModel), 15_000)));
check("Gemini: the failure is said honestly (no answer made up)", await heard(page, T.questionFailed, 30_000));

// Fix 3: switch to Nadhra while a Gemini question (and the cloud voice) is still in progress upstream.
await sleep(2_000);
setDelay(4_000);
await page.evaluate(() => (window.__said = []));
const failedBefore = await announcedCount(page, T.questionFailed);
const tQ = Date.now();
await page.keyboard.press("d");
const inProgress = await until(() => since("hybrid", tQ).find(isGeminiModel), 10_000);
check("in progress: the Gemini request is with the (delayed) upstream", !!inProgress);
const tSwitch2 = Date.now();
await choose(page, "nadhra");
check("in progress → Nadhra: the warning about stopped sending is spoken", await heard(page, T.nadhra.stoppedSending, 10_000));
await sleep(10_000); // longer than two delayed attempts: a next provider or a retry would show by now
setDelay(0);
const after = since("hybrid", tSwitch2 + 50);
check("in progress → Nadhra: the server made no further attempt (no next model, no OpenRouter, no voice retry)", after.length === 0, JSON.stringify(after));
check("in progress → Nadhra: the page's open request was aborted", failed.some((f) => f.t >= tSwitch2 - 50 && f.url.endsWith("/api/vision")), JSON.stringify(failed.slice(-4)));
check("in progress → Nadhra: the page sent nothing after the switch", posts(tSwitch2 + 50).length === 0, JSON.stringify(posts(tSwitch2 + 50).map((r) => r.url)));
check("in progress → Nadhra: no failure message for the abandoned question", (await announcedCount(page, T.questionFailed)) === failedBefore);

// Back to Gemini with consent: the camera keeps running, nothing asked again.
await page.evaluate(() => (window.__said = []));
await choose(page, "gemini");
check("with consent → Gemini: confirmation shown", (await notice(page)) === "✓ Gemini");
check("with consent → Gemini: no new consent notice, camera on, 'manual'", !(await consentOpen(page)) && (await stage(page, "camera")) === "on" && (await until(async () => (await stage(page, "analysis")) === "manual", 3_000)) !== null);
check("with consent → Gemini: confirmation spoken", await heard(page, T.nadhra.geminiSelected));
check("Gemini persists after reload", await (async () => { await page.reload({ waitUntil: "networkidle" }); return (await active(page)) === "gemini"; })());
check("no 'Gemini AI' or 'Nadhra AI' anywhere (end)", !/Gemini AI|Nadhra AI/.test(await page.evaluate(() => document.body.innerText)));

// Fix 2: in the whole run, no connectivity check went to Google (hybrid runs with its default settings).
const probes = Object.keys(servers).flatMap((n) => netlog(n)).filter((e) => e.via === "fetch" && /^https:\/\/[^/]*google[^/]*\/?$/.test(e.url));
check("no connectivity probe to Google, on any server, during the whole run", probes.length === 0, JSON.stringify(probes));

check("no page errors", errors.length === 0, errors.join(" | "));
await page.screenshot({ path: join(OUT, "home-412.png") });
await ctx.close();

// Layout: the home screen with the switch still fits, at phone widths, without cutting the names.
for (const width of [320, 390]) {
  const { page: p, ctx: c } = await open(servers.hybrid.base, { width, height: 700 });
  const m = await p.evaluate(() => ({
    hScroll: document.documentElement.scrollWidth > innerWidth,
    vScroll: document.querySelector(".app").scrollHeight > document.querySelector(".app").clientHeight + 1,
    cut: [...document.querySelectorAll(".ai-switch-name > span")].some((s) => s.scrollWidth > s.clientWidth + 1),
    openVisible: (() => { const r = document.querySelector("[data-testid=open-camera]").getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; })(),
  }));
  check(`${width}px: no sideways scroll, nothing cut, Open camera fully visible`, !m.hScroll && !m.cut && m.openVisible, JSON.stringify(m));
  check(`${width}px: the home screen still fits without scrolling`, !m.vScroll, JSON.stringify(m));
  await p.screenshot({ path: join(OUT, `home-${width}.png`) });
  await c.close();
}
await browser.close();

for (const name of Object.keys(servers)) {
  const entries = netlog(name);
  const kinds = [...new Set(entries.map((e) => (e.via === "fetch" ? `${e.method} ${e.url.replace(/key=[^&]+/, "key=…")}` : `socket ${e.host}:${e.port}`)))];
  console.log(`netlog ${name}: ${entries.length} blocked attempts${kinds.length ? "\n  " + kinds.join("\n  ") : ""}`);
}
stopServers();
const failedChecks = results.filter((r) => !r.ok);
console.log(`\n${results.length - failedChecks.length}/${results.length} passed`);
process.exit(failedChecks.length ? 1 : 0);
