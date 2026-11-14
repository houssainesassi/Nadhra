// Reading by voice in real Chromium, against the production build and the real vision API
// (Gemini quota: about 3 requests). The camera shows a rendered medicine box; speech recognition is
// a stub that "hears" the commands. The voice (/api/tts) is answered in the browser and recorded,
// so what would be said, and in which voice, can be checked.
//
//   python3 e2e/read/make_documents.py e2e/read/out/images
//   F=e2e/read/out/fixtures; mkdir -p $F
//   for n in medicine_fr medicine_blurry; do ffmpeg -y -loop 1 -i e2e/read/out/images/$n.jpg -t 3 -r 10 -vf scale=1280:960 -q:v 3 -f mjpeg $F/$n.mjpeg; done
//   ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t 0.3 -q:a 9 $F/silence.mp3
//   npm run build && npx next start -p 3100
//   node e2e/read/browser.mjs e2e/read/out/fixtures http://localhost:3100
import { chromium } from "playwright-core";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const fixtures = process.argv[2] ?? "e2e/read/out/fixtures";
const BASE = process.argv[3] ?? "http://localhost:3100";
const root = join(homedir(), ".cache", "ms-playwright");
const executablePath = process.env.CHROME_PATH ?? join(root, readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()[0], "chrome-linux64", "chrome");
const silence = readFileSync(join(fixtures, "silence.mp3"));

const results = [];
let skipped = 0;
const check = (name, ok, detail = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000, step = 100) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }

/** Opens the app with the camera showing `camera`, and speech recognition hearing `utterances` in turn. */
async function open(camera, utterances) {
  const browser = await chromium.launch({
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-video-capture=${join(fixtures, `${camera}.mjpeg`)}`],
  });
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, permissions: ["camera", "microphone"] });
  await ctx.addInitScript((said) => {
    // Each start hears the next utterance, after the previous answer had time to arrive.
    window.__heard = 0;
    window.__hold = true;
    // What is actually said, in order, from the caption: the voice caches audio, so a sentence said
    // twice makes only one /api/tts request.
    window.__captions = [];
    new MutationObserver(() => {
      const t = document.querySelector('[data-testid="last-spoken"]')?.textContent?.trim();
      if (t && t !== window.__captions[window.__captions.length - 1]) window.__captions.push(t);
    }).observe(document, { subtree: true, childList: true, characterData: true });
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() {
        const wait = async () => {
          while (window.__hold) {
            if (this.dead) return; // aborted: a later recognizer gets the utterance
            await new Promise((r) => setTimeout(r, 200));
          }
          if (this.dead) return;
          window.__hold = true;
          const text = said[window.__heard++];
          this.onspeechstart?.();
          if (text) this.onresult?.({ results: [[{ transcript: text }]] });
          this.onspeechend?.();
          this.onend?.();
        };
        setTimeout(wait, 300);
      }
      stop() { this.dead = true; this.onend?.(); }
      abort() { this.dead = true; this.onend?.(); }
    };
  }, utterances);
  const api = [];
  const tts = [];
  await ctx.route("**/api/vision", async (route) => {
    const r = route.request();
    if (r.method() === "POST") {
      try { const b = JSON.parse(r.postData()); api.push({ mode: b.mode, question: b.question, imageChars: b.image?.length ?? 0, secondChars: b.secondImage?.length ?? 0, document: b.document }); } catch {}
    }
    return route.continue(); // the real route and the real model
  });
  await ctx.route("**/api/tts", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { configured: true, voice: "mock", languageCode: "ar-TN" } });
    try { tts.push(JSON.parse(route.request().postData())); } catch {}
    return route.fulfill({ body: silence, contentType: "audio/mpeg" });
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE);
  await page.getByTestId("open-camera").click();
  await page.getByRole("button", { name: "I agree", exact: true }).click().catch(() => {});
  const say = () => page.evaluate(() => (window.__hold = false));
  return { browser, page, api, tts, errors, say };
}

const spoken = (e) => e.tts.map((t) => t.text).join(" | ");

/** Waits for the start-up sentences (camera on, safety notice) to be said: hands-free listening ignores what it hears over them. */
const settled = async (e) => {
  await until(() => e.tts.some((t) => /تجريبي/.test(t.text)), 30_000);
  await sleep(2500);
};

const D = { notice: "قبل ما نقرا", checkDose: "ثبّت فيها مع الصيدلي.", checkDate: "ثبّت فيه مع الصيدلي.", unconfirmed: "قريت الكتابة مرتين", declined: "ما نجاوبش على الأدوية" };
/** Every spoken dose or date is followed at once by the check, and no number is said as "written". */
/** Doses and dates as captioned, each with what came right after it when that isn't the check. */
const missingCheck = async (e) => {
  const caps = await e.page.evaluate(() => window.__captions);
  return caps.filter((c, i) => /\d/.test(c) && /mg|EXP|comprim/.test(c) && !/قريت|comprimés pelliculés|16 comprimés/.test(c) && ![D.checkDose, D.checkDate].includes(caps[i + 1])).map((c) => `${c} → ${caps[caps.indexOf(c) + 1]}`);
};

{
  const e = await open("medicine_fr", ["اقرالي الدوا", "موافق", "وقتاش يوفى الدوا هذا؟", "اقرا الكل", "قداش من حبة ناخذ في النهار؟"]);
  await settled(e);
  await e.say();
  const notice = await until(() => e.tts.some((t) => t.text.startsWith(D.notice)), 15_000);
  check("the first reading starts with the spoken notice naming Google", !!notice && /Google Gemini/.test(spoken(e)), spoken(e));
  await sleep(1500);
  check("… and no picture is sent before the answer", !e.api.some((a) => a.mode === "read"), JSON.stringify(e.api));
  await until(() => e.tts.at(-1)?.text.startsWith(D.notice) || /رجّع/.test(e.tts.at(-1)?.text ?? ""), 10_000);
  await sleep(2000);
  await e.say(); // «موافق»
  const read = await until(() => e.api.find((a) => a.mode === "read"), 20_000);
  check("«موافق» sends the reading, with two frames for the double reading", read && read.imageChars > 50_000 && read.secondChars > 20_000 && !read.question, JSON.stringify(read && { ...read, document: undefined }));
  const name = await until(() => e.tts.find((t) => /FEBRALIX/.test(t.text)), 30_000);
  const shown = await until(async () => /FEBRALIX|Paracétamol|500 mg|قريت/.test(await e.page.locator("body").innerText()), 15_000, 50);
  await until(() => /اقرا الكل|قريت الأرقام مرتين/.test(spoken(e).split(D.notice).slice(-1)[0]), 60_000);
  check("the printed name is spoken, in the French voice", name?.lang === "fr", spoken(e));
  check("«قريت…» labels: the reading is never presented as verified", /قريت الاسم/.test(spoken(e)) && !/المكتوب:/.test(spoken(e)), spoken(e));
  const doseSaid = /500 mg/.test(spoken(e));
  check("the dose is said with the check right after it, or withheld as unconfirmed", doseSaid ? e.tts[e.tts.findIndex((t) => t.text === "500 mg.") + 1]?.text === D.checkDose : spoken(e).includes(D.unconfirmed), spoken(e));
  const missing1 = await missingCheck(e);
  check("every spoken dose or date is followed at once by the check (from the captions)", missing1.length === 0, missing1.join(" || "));
  check("the date keeps its slash", !/03 (?:ou|أو|or) 2027/.test(spoken(e)));
  check("no AI explanation of a medical paper", !/توضيح من عندي/.test(spoken(e)), spoken(e));
  check("the reading is captioned on screen as it is said", !!shown);

  await sleep(3000);
  const askedAt = e.tts.length;
  await e.say();
  const follow = await until(() => e.api.find((a) => a.mode === "read" && a.question), 20_000);
  check("a follow-up question goes to the reading mode, with two frames and the text read before", follow?.secondChars > 0 && Array.isArray(follow?.document?.lines), JSON.stringify(follow && { ...follow, document: follow.document?.lines?.length }));
  const answer = () => e.tts.slice(askedAt).map((t) => t.text).join(" | ");
  const answered = await until(() => /قريت فيها|ما لقيتش|قريت الكتابة مرتين|ما نجمتش نجاوبك/.test(answer()), 30_000);
  await sleep(2000);
  if (/ما نجمتش نجاوبك/.test(answer())) { skipped++; console.log("SKIP  the follow-up: the AI service was unavailable (free tier), and the user was told so"); }
  else check("the follow-up is answered from what was read (quote followed by the check, or not confirmed)", !!answered && (!/2027/.test(answer()) || answer().includes(D.checkDate) || answer().includes(D.checkDose)), answer());

  await sleep(4000);
  const posts = e.api.length;
  const before = e.tts.length;
  await e.say();
  await until(() => e.tts.length > before + 1, 15_000);
  await sleep(1500);
  check("«اقرا الكل» reads from memory, without sending another picture", e.api.length === posts && e.tts.slice(before).some((t) => /قريت/.test(t.text)), e.tts.slice(before).map((t) => t.text).join(" | "));
  const missing2 = await missingCheck(e);
  check("… with the check after each line with numbers", missing2.length === 0, missing2.join(" || "));

  await sleep(4000);
  const n = e.api.length;
  await e.say(); // a medicine question
  const med = await until(() => e.api.slice(n).find((a) => a.question === "قداش من حبة ناخذ في النهار؟"), 20_000);
  check("F6: a medicine question goes through the reading rules, not an ordinary answer", med?.mode === "read", JSON.stringify(e.api.slice(n).map((a) => ({ mode: a.mode, q: a.question }))));
  check("no page errors", e.errors.length === 0, e.errors.join(" | "));
  await e.browser.close();
}

{
  const e = await open("medicine_blurry", ["اقرالي الدوا", "موافق"]);
  await settled(e);
  await e.say();
  await until(() => e.tts.some((t) => t.text.startsWith(D.notice)), 15_000);
  await sleep(2000);
  await e.say(); // «موافق»: then the on-device check runs
  const refused = await until(() => e.tts.some((t) => /مهزوزة/.test(t.text)), 15_000);
  check("a blurred box is refused on the phone, with how to fix it", !!refused, spoken(e));
  check("… and no picture is sent for reading", !e.api.some((a) => a.mode === "read"), JSON.stringify(e.api));
  await e.browser.close();
}

const failed = results.filter((r) => !r).length;
// A check skipped because the service was unavailable makes the run INCOMPLETE, never "passed".
console.log(`\n${results.length - failed}/${results.length} passed${skipped ? `, ${skipped} skipped: INCOMPLETE` : ""}`);
process.exitCode = failed || skipped ? 1 : 0;
