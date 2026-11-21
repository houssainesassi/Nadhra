// Location & directions in real Chromium, on the production build, with the REAL map services
// (Nominatim, Overpass/Nominatim fallback, OSRM) through the app's own routes. Only the GPS is
// emulated (Chromium's geolocation override, moved along the real route) and the voice is
// intercepted: /api/tts answers silence and records each sentence Sulafat was asked to say.
// Checks: consent first, permission refused, where am I, pharmacies and hospitals, directions,
// start, turn instructions while walking, leaving the route, stop; screen-reader names (axe); the
// optional map loads OSM tiles under the CSP; phone and desktop sizes; the camera session still works.
//
//   npm run build && npx next start -p 3100
//   node e2e/geo/browser.mjs [base=http://localhost:3100]
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = process.argv[2] ?? "http://localhost:3100";
const OUT = "e2e/live/out/geo";
mkdirSync(OUT, { recursive: true });
const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
const AXE = process.env.AXE ?? join(homedir(), ".cache/porto-e2e/app/node_modules/axe-core/axe.min.js");
const silenceMp3 = execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-t", "0.2", "-i", "anullsrc=r=24000:cl=mono", "-f", "mp3", "-"]);

const results = [];
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20_000, step = 150) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

// Rue de Grèce, Tunis (Bab Bhar).
const HERE = { latitude: 36.7993, longitude: 10.1802, accuracy: 8 };

const browser = await chromium.launch({ executablePath, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });

async function open(viewport, { geo = true, language = "tn" } = {}) {
  const ctx = await browser.newContext({ viewport, permissions: geo ? ["geolocation", "camera", "microphone"] : ["camera", "microphone"], geolocation: HERE, locale: "ar-TN" });
  await ctx.addInitScript((language) => {
    localStorage.setItem("assistant.consent.v3", "1");
    localStorage.setItem("assistant.settings", JSON.stringify({ language }));
  }, language);
  const said = [];
  await ctx.route("**/api/tts", async (route) => {
    if (route.request().method() === "POST") said.push(JSON.parse(route.request().postData() ?? "{}").text ?? "");
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silenceMp3 });
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused/.test(m.text())) problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(String(e)));
  await page.goto(BASE);
  await page.click("body", { position: { x: 5, y: 5 } }); // the first gesture unlocks audio
  return { ctx, page, said, problems };
}
const openPanel = async (page) => {
  await page.click("[data-testid=open-settings]");
  await page.click("[data-testid=open-places]");
  await page.waitForSelector("[data-testid=nav-panel]", { state: "visible" });
};
const saidMatching = (said, re) => said.some((t) => re.test(t));

// --- 1. permission refused by the browser -----------------------------------------------------------------
{
  const { ctx, page, said } = await open({ width: 390, height: 844 }, { geo: false });
  await openPanel(page);
  check("consent notice shown before anything", await page.isVisible("[data-testid=nav-consent]"));
  await page.click("[data-testid=nav-allow]");
  const err = await until(async () => (await page.textContent("[data-testid=nav-location]"))?.includes("blocked"));
  check("browser refusal: shown in words", !!err, await page.textContent("[data-testid=nav-location]"));
  check("browser refusal: said (how to allow it)", !!(await until(() => saidMatching(said, /ما عنديش الإذن/))), said.join(" | "));
  await ctx.close();
}

// --- 2. phone, Derja: the whole flow on the real map services ----------------------------------------------
const { ctx, page, said, problems } = await open({ width: 390, height: 844 });
await openPanel(page);
check("the camera consent doesn't cover location: its own notice", await page.isVisible("[data-testid=nav-consent]"));
await page.click("[data-testid=nav-where]");
check("«where am I» without consent: the notice is said", !!(await until(() => saidMatching(said, /باش نعرف وين إنت/))));
await page.click("[data-testid=nav-allow]");
check("consent kept on the device", (await page.evaluate(() => localStorage.getItem("assistant.locationConsent.v1"))) === "1");
const found = await until(async () => /accurate to about 8 m/.test((await page.textContent("[data-testid=nav-location]")) ?? ""));
check("position: accuracy and time shown", !!found, await page.textContent("[data-testid=nav-location]"));

const t0 = Date.now();
await page.click("[data-testid=nav-where]");
const where = await until(() => said.find((t) => t.startsWith("إنت في ")));
check("where am I: a real address from the map, said aloud", !!where && /نهج|شارع/.test(where), String(where));
console.log(`      said: ${where} (${Date.now() - t0} ms)`);

for (const [cat, re] of [["pharmacy", /^لقيت \d+ بلايص\. الأقرب: /], ["hospital", /^(لقيت \d+ بلايص|لقيت بلاصة وحدة|ما لقيت حتى بلاصة)/]]) {
  const before = said.length;
  const t = Date.now();
  await page.selectOption("[data-testid=nav-category]", cat);
  const s = await until(() => said.slice(before).find((x) => re.test(x)), 30_000);
  check(`nearby ${cat}: real results, nearest said`, !!s, said.slice(before).join(" | "));
  console.log(`      said: ${s} (${Date.now() - t} ms)`);
}
await page.selectOption("[data-testid=nav-category]", "pharmacy");
await until(async () => /Pharmacy/.test((await page.textContent("[data-testid=nav-places] li").catch(() => "")) ?? ""), 30_000);
const firstPlace = (await page.textContent("[data-testid=nav-places] li"))?.trim();
check("places listed in text with distance (no map needed)", /metres/.test(firstPlace ?? ""), firstPlace);
await page.click("[data-testid=nav-places] li button");
const routeSaid = await until(() => said.find((t) => /على ساقيك، حوالي \d+ دقاي?ق\. اضغط «?ابدا التوجيه»?/.test(t)), 20_000);
check("directions: a real walking route, distance and time said", !!routeSaid, said.slice(-3).join(" | "));
console.log(`      said: ${routeSaid}`);

await page.click("[data-testid=nav-start]");
check("start: summary + first direction + no-guarantee said", !!(await until(() => said.find((t) => t.startsWith("نبداو.") && /ما نجّمش نضمن/.test(t)))));
await page.keyboard.press("Escape");
check("main screen: navigation strip with a big Stop", !!(await until(() => page.isVisible("[data-testid=nav-strip-stop]"))));
const stopBox = await page.locator("[data-testid=nav-strip-stop]").boundingBox();
check("Stop navigation is large (≥ 48 px tall)", !!stopBox && stopBox.height >= 48, JSON.stringify(stopBox));
console.log(`      strip: ${await page.textContent("[data-testid=nav-strip]")}`);

// The same route the page is following, through the app's own endpoints (same session and cache).
const pts = await page.evaluate(async ({ lat, lon }) => {
  const post = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
  const near = await post("/api/geo/nearby", { lat, lon, category: "pharmacy", lang: "tn" });
  const to = near.places[0];
  const r = await post("/api/geo/route", { from: { lat, lon }, to: { lat: to.lat, lon: to.lon } });
  return r.route.geometry;
}, { lat: HERE.latitude, lon: HERE.longitude });
// Walk it at about 5 m a step (one position a second), densifying long segments.
const walkPts = [];
for (let i = 0; i < pts.length - 1; i++) {
  const a = pts[i], b = pts[i + 1];
  const d = Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180));
  const n = Math.max(1, Math.ceil(d / 5));
  for (let k = 0; k < n; k++) walkPts.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
}
for (const p of walkPts) {
  await ctx.setGeolocation({ latitude: p.lat, longitude: p.lon, accuracy: 6 });
  await sleep(1100);
  if (saidMatching(said, /^توّا، /)) break;
}
check("walking: «now, turn…» said at the first turn", saidMatching(said, /^توّا، دور على/), said.slice(-4).join(" | "));
// Leave the route: 80 m east of it, for a while.
for (let i = 0; i < 6; i++) {
  await ctx.setGeolocation({ latitude: HERE.latitude + 0.0001 * i, longitude: HERE.longitude + 0.0012, accuracy: 6 });
  await sleep(2200);
}
check("off the route: said, and a new route is worked out", !!(await until(() => saidMatching(said, /^لقيت طريق جديد\./) || saidMatching(said, /^ما نجّمتش نحسب طريق جديد/), 20_000)), said.slice(-4).join(" | "));
await page.click("[data-testid=nav-strip-stop]");
check("stop: said, strip gone", !!(await until(() => said.includes("وقّفت التوجيه."))) && !(await page.isVisible("[data-testid=nav-strip]")));

// The optional map: OpenStreetMap tiles load, nothing refused by the CSP.
await openPanel(page);
let tiles = 0;
page.on("response", (r) => { if (r.url().startsWith("https://tile.openstreetmap.org/") && r.status() === 200) tiles++; });
await page.click("[data-testid=nav-map-toggle]");
await until(() => page.isVisible("[data-testid=nav-map] .leaflet-tile-loaded"), 20_000);
check("map: tiles load", tiles > 0 || (await page.isVisible("[data-testid=nav-map] .leaflet-tile-loaded")), `tiles=${tiles}`);
check("map: has a text alternative", /Map showing/.test((await page.getAttribute("[data-testid=nav-map]", "aria-label")) ?? ""));
await page.screenshot({ path: join(OUT, "panel-phone.png"), fullPage: false });

// Accessibility of the panel.
if (existsSync(AXE)) {
  await page.addScriptTag({ path: AXE });
  const v = await page.evaluate(async () => (await window.axe.run("[data-testid=nav-panel]", { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((x) => `${x.id}(${x.nodes.length})`));
  check("axe (WCAG 2 A/AA) on the panel: no violations", v.length === 0, v.join(", "));
}
check("no CSP refusals or page errors", problems.length === 0, problems.join(" | ").slice(0, 400));
await page.click("[data-testid=nav-withdraw]");
check("forget permission: consent removed", (await page.evaluate(() => localStorage.getItem("assistant.locationConsent.v1"))) === null);
await ctx.close();

// --- 3. desktop, English: the panel and the camera session side by side -------------------------------------
{
  const { ctx, page, said, problems } = await open({ width: 1280, height: 800 }, { language: "en" });
  await page.evaluate(() => localStorage.setItem("assistant.locationConsent.v1", "1"));
  await page.reload();
  await page.click("body", { position: { x: 5, y: 5 } });
  await openPanel(page);
  await page.click("[data-testid=nav-where]");
  const w = await until(() => said.find((t) => t.startsWith("You are at ")));
  check("desktop English: where am I said in English", !!w, said.join(" | "));
  console.log(`      said: ${w}`);
  await page.keyboard.press("Escape");
  // The camera session (Nadhra's existing feature) still starts and ends.
  await page.keyboard.press("KeyC");
  check("camera session still starts", !!(await until(() => page.evaluate(() => document.querySelector("[data-testid=stage]")?.getAttribute("data-camera") === "on"))));
  check("the screen-reader actions include Places & directions", await page.locator("[data-testid=action-places]").count() === 1);
  await page.click("[data-testid=stop-assistance]");
  check("camera session still ends", !!(await until(() => page.evaluate(() => document.querySelector("[data-testid=stage]")?.getAttribute("data-camera") === "off"))));
  await page.screenshot({ path: join(OUT, "home-desktop.png") });
  check("desktop: no CSP refusals or page errors", problems.length === 0, problems.join(" | ").slice(0, 400));
  await ctx.close();
}

// --- 4. accessibility of guidance outside the session: End, the screen locked, the N key, privacy ---------------
{
  const { ctx, page, said, problems } = await open({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("assistant.locationConsent.v1", "1"));
  await page.reload();
  await page.click("body", { position: { x: 5, y: 5 } });
  await page.keyboard.press("KeyC");
  await until(() => page.evaluate(() => document.querySelector("[data-testid=stage]")?.getAttribute("data-camera") === "on"));
  // The screen-reader action opens the panel during a session.
  await page.evaluate(() => document.querySelector("[data-testid=action-places]").click());
  await page.waitForSelector("[data-testid=nav-panel]", { state: "visible" });
  await page.selectOption("[data-testid=nav-category]", "pharmacy");
  await until(() => page.isVisible("[data-testid=nav-places] li"), 30_000);
  await page.click("[data-testid=nav-places] li button");
  await until(() => page.isVisible("[data-testid=nav-start]"), 20_000);
  await page.click("[data-testid=nav-start]");
  check("start also says, once, to keep the screen on", !!(await until(() => saidMatching(said, /^خلّي الشاشة شاعلة/))));
  await page.keyboard.press("Escape");
  check("during the session: the strip with Stop is on the camera screen", !!(await until(() => page.isVisible("[data-testid=stage] [data-testid=nav-strip-stop]"))));
  if (existsSync(AXE)) {
    await page.addScriptTag({ path: AXE });
    const v = await page.evaluate(async () => (await window.axe.run("[data-testid=nav-strip]", { runOnly: ["wcag2a", "wcag2aa"] })).violations.map((x) => `${x.id}(${x.nodes.length})`));
    check("axe on the navigation strip: no violations", v.length === 0, v.join(", "));
  }
  await page.click("[data-testid=stop-assistance]");
  check("End: guidance goes on, its Stop is on the home screen", !!(await until(() => page.isVisible(".home [data-testid=nav-strip-stop]"))));
  check("End: focus lands on Stop navigation (one double-tap away)", !!(await until(() => page.evaluate(() => document.activeElement?.getAttribute("data-testid") === "nav-strip-stop"))));
  check("End: said how to stop without a microphone", !!(await until(() => saidMatching(said, /^التوجيه مازال شاعل\. باش توقّفو، اضغط على .?وقّف التوجيه.? في الشاشة/))), said.slice(-3).join(" | "));
  const stopName = await page.evaluate(() => { const b = document.querySelector("[data-testid=nav-strip-stop]"); return `${b.textContent} | ${document.getElementById(b.getAttribute("aria-describedby"))?.textContent}`; });
  check("Stop has a name and describes the guidance", /وقّف التوجيه \| ماشي لـ.+ · باقي حوالي/.test(stopName), stopName);
  // The screen is locked (the page is hidden), then unlocked.
  const setHidden = (hidden) => page.evaluate((hidden) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await setHidden(true);
  check("screen locked: the strip says guidance is paused", !!(await until(() => page.evaluate(() => /الشاشة كانت مسكّرة/.test(document.querySelector("[data-testid=nav-strip]")?.textContent ?? "")))));
  const n = said.length;
  await setHidden(false);
  check("screen back: said that guidance was paused and continues", !!(await until(() => said.slice(n).some((t) => t.startsWith("التوجيه كان واقف")))), said.slice(n).join(" | "));
  check("screen back: the strip shows it running again", !!(await until(() => page.evaluate(() => !/الشاشة كانت مسكّرة/.test(document.querySelector("[data-testid=nav-strip]")?.textContent ?? "")))));
  await page.keyboard.press("KeyN");
  check("N key: stops guidance, said", !!(await until(() => said.includes("وقّفت التوجيه."))) && !(await page.isVisible("[data-testid=nav-strip]")));
  // The privacy text, as shown in the app.
  await page.click("[data-testid=open-settings]");
  await page.click("[data-testid=open-privacy]");
  const privacy = await page.textContent("dialog[open]");
  check("privacy: says GPS coordinates go to Nadhra's server", /your GPS coordinates are sent to Nadhra's server/.test(privacy ?? ""));
  check("privacy: says place information is shared with Gemini", /shared with Google Gemini/.test(privacy ?? ""));
  check("privacy: no claim that location stays on the device", !/location stay on this device/.test(privacy ?? ""));
  await page.screenshot({ path: join(OUT, "privacy-phone.png") });
  check("no CSP refusals or page errors", problems.length === 0, problems.join(" | ").slice(0, 400));
  await ctx.close();
}

await browser.close();
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
