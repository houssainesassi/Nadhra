# Phase 1 reader: safety fixes report

**Date:** 2026-11-13. **Scope:** the work you approved after the safety review, strictly within Phase 1. Not committed, pushed or deployed. No production settings changed. No Phase 2, no registry, no barcode, no Tesseract.

## Verdict

**The pass criterion for blind participants is not met yet.** In the final 30-case run (89 readings), **3 readings still said something wrong**:
- A misspelled Arabic medicine name, in 2 of 3 runs.
- A dose completed under heavy glare, in 1 of 3 runs.

Every other failure type found along the way is fixed and covered by tests. Real-world testing and blind participants should wait for your decision on the two proposals in §7.

## 1. The six approved fixes (F1–F6)

| # | Problem | Fix | Regression tests (`tests/document.test.ts` unless noted) |
|---|---|---|---|
| F1 | "500 mg" matched a 1500 mg box | Values, quotes and expected text now match only as whole words and whole numbers (`grounded`, `normForMatch` splits "500mg" into "500 mg") | "F1: a number only matches a whole number"; "F1: a strength field shorter than the printed one is not said"; "F1 in quotes" |
| F2 | «5?0 mg» marked confirmed was spoken | Any `?` touching a letter or digit, `[?]`, `??`, `…`, `___` makes the line uncertain | "F2: any unreadable mark makes a line uncertain" (6 variants; a letter ending in "?" is unaffected) |
| F3 | `½ ¼ ¾` weren't numbers | Fractions count as numbers in every rule (hold-back, double reading, explanation check) | "F3: fractions are numbers"; "F3: a fraction is held back" |
| F4 | «Selon l'ordonnance, vous pouvez doubler la dose» passed | **No AI explanation of medical papers at all**: the model's text is dropped, in readings and in answers | "F4 and F5: nothing the model writes about a medical paper is said" |
| F5 | Invented uses and contraindications passed | Same as F4. The prompt no longer allows "what it is commonly used for". | same test; prompt test |
| F6 | Medicine questions bypassed the reading rules | See below | "F6: …" tests in `document.test.ts`, `controller.test.ts`, `visionRoute.test.ts` |

**F6 in detail.** Medicine questions are recognised in Derja, Arabic, French, English and Arabizi (`isMedicalQuestion`).
- **On the phone:** they go to reading mode when the camera is on or a document was just read. Otherwise they are declined: «ما نجاوبش على الأدوية ولا على الجرعات من عندي…» ("I don't answer about medicines or doses myself…").
- **On the server:** a medicine question in question mode is read under the reading rules. It has one frame, so no number can be confirmed. In chat mode it is declined without any request to Gemini.
- **Everywhere else** (scans, questions, chat, and streamed sentences before they are spoken), any sentence stating a dose is removed (`mentionsDose`).
- **Live conversation:** the live prompt forbids doses. A medicine question takes the turn from the live model and goes to the reading rules. A dose in a live answer cuts that answer, and the refusal is said instead.

## 2. Wording: never an unverified dose as fact

«قريت الجرعة: 500 mg. ثبّت فيها مع الصيدلي.» ("I read the dose as: 500 mg. Check it with the pharmacist.")
- The check is said **immediately after every dose and every date**: in the fields, in each prescription line with a number, in quotes, and in «اقرا الكل» ("read all").
- Labels say «قريت…» ("I read…"), never «المكتوب» ("written").
- Expiry status is conditional («كان القراية صحيحة، …», "if the reading is right…"), is said after the check, and is not said at all for ambiguous dates such as 03/04/2027.
- Medical readings end with «قبل ما تاخذ أي دوا، ثبّت مع الصيدلي ولا الطبيب» ("before taking any medicine, check with the pharmacist or the doctor").
- All of this in the four languages.

## 3. Double reading

- **How it works:**
  - The phone takes two frames, 0.4 s apart.
  - The server reads them in parallel, as two separate requests. The first goes to gemini-3.5-flash-lite; the second starts on gemini-3.1-flash-lite, then falls back to the first model, with the slow 3.5-flash last.
- **The rule:** on a medical paper, a line with a number is said only if the second reading has the same numbers, character for character ("03" is not "3", line breaks don't matter). If the readings disagree, or the second one fails, the user hears that the numbers couldn't be confirmed and is asked for a clearer picture.
- **Measured, final run (89 readings):**
  - median 2.8 s, 90th percentile 8.2 s, worst 21.9 s
  - 4 requests failed at the provider (Gemini "high demand" or timeouts, free tier)
  - 3 readings had their numbers withheld because the two readings disagreed
- **What it does not do:** catch errors both readings share. The remaining glare failure (§6) had both readings agree on the same wrong completion.

## 4. Privacy decisions (as approved)

- Documents go **to Gemini only, never OpenRouter** (tested: with Gemini down, nothing goes to OpenRouter, and the user hears that the service is unavailable).
- **No document leaves the phone without an explicit command.**
  - Before the first reading, a spoken notice names Google Gemini and says the free service may keep the pictures, use them, and let staff see them. It says Google's terms ask that no personal or sensitive data be sent, and so: "don't photograph a real prescription or a paper with your name or ID". Only a spoken «موافق» continues; «رجّع» cancels.
  - The notice is forgotten when consent is withdrawn.
- **Automatic frames stop for documents.**
  - When an automatic scan sees a paper or box, it keeps none of its text and the user is told descriptions are paused.
  - Scans and live frames stay paused until the view changes clearly.
  - A reading starts the same pause.
  - **Limit:** the first automatic frame showing a document is sent before it is recognised. Stopping that would need an on-device document detector (not available without an OCR or new model) or automatic descriptions off by default. That's your decision.
- The camera notice now names Google Gemini and OpenRouter and says the free service may keep images. Consent was reset (key v3), so everyone hears it again.
- Readings stay out of the general conversation history.
- **Not changed (needs your decision):** the paid tier. A **legal review checklist** for Law 2004-63 and the INPDP is in `docs/PHASE1_LEGAL_REVIEW_CHECKLIST.md`. It includes what to check in a paid tier's actual terms; none of it is assumed.
- **No real prescription or identifiable medical document was sent.** All tests used rendered mock documents with invented names.

## 5. Derja explanations

- No AI medical explanation at all.
- A word-for-word glossary turns an instruction into Derja (`1 comprimé 3 fois par jour pendant 5 jours` → «1 حبّة 3 مرات في النهار مدة 5 أيام»). If one word is unknown, there's no rendering; brand names are never rendered.
- **Off** (`DERJA_GLOSSARY_APPROVED = false`) until a pharmacist reviews every entry. Until then only the original text is read.

## 6. Found by testing with the real model, and fixed

| Found | Fix | Result |
|---|---|---|
| Finger over «0 mg»: «50» said as the strength (M19) | A strength needs a unit. A medical line that is only a number is never read. | 0/6 critical after (was 1/3) |
| Frame edge cutting the expiry line: date reconstructed, all lines "confirmed" (M20) | Each line now has a `fully_visible` answer (cut, covered, glare). Not fully visible counts as uncertain, whatever the confidence. | 0/9 critical after (was 3/3) |
| Expiry status said before the check | Check first, then status | browser test |
| «0,5 %» rejected by the new unit rule | Fixed (`%` is a unit) | M15 9/9 |
| «1 g» not recognised as a dose | Grams added | unit test |
| Second model slow (14 s, then timeouts) | Faster fallback order, 10 s per attempt | median 2.8 s |

**Still failing:**
- **M12, Arabic box, 2 of 3 runs:** the name was read «فيبراليكس», with one letter added, instead of «فبراليكس». Names are not double-read; the approval covered doses and dates.
- **M16b, glare really hiding «00 mg», 1 of 3 runs:** "500 mg" was completed. Both readings agreed and both said the line was fully visible.

My first glare case (M16) had wrong ground truth: "mg" was only faded and still readable. I corrected it, and added M16b, which really hides the digits.

## 7. Proposals awaiting your approval

1. **Names double-read too** (small change): a medicine name is said only if the second reading has it. Measure on M12 first: if both readings misspell it the same way, it won't help.
2. **Glare.** A simple on-device "washed-out pixels" signal **does not work**: white prescriptions score higher (6–9%) than the glare case. Options:
   - (a) a second, targeted question to the model about each number's visibility;
   - (b) ask the model for each number's position, and check that region on the phone for washed-out pixels;
   - (c) accept the residual risk, covered by the wording and the pharmacist check.

   Each needs approval and measurement.
3. The first-automatic-frame limit (§4).
4. Paid tier and legal review (§4).

## 8. Tests executed and results (final code)

| Test | Result |
|---|---|
| `npm test` (all unit and integration tests, no network) | **269/269** (243 before this work), run twice. One earlier full run had a one-time timing failure in an unrelated health-route test while the plan run was using the CPU; it did not repeat. |
| `npx tsc --noEmit` | no errors |
| `npm run build` | succeeds |
| 30-case mock plan, real Gemini, 3 runs per case (`e2e/read/plan.ts`) | first run: 7 readings with real critical errors (plus 9 scorer false positives, fixed). **Final run: 31 cases, 89 readings, 3 with a critical error (M12 ×2, M16b ×1), facts read 208/220 (M15 re-run after the % fix: 9/9).** |
| Chromium, production build, real Gemini, fake camera and speech (`e2e/read/browser.mjs`) | **18/18**: notice before any picture; «موافق»; two frames; «قريت…»; a check after every dose and date; no AI explanation; follow-up; read all from memory; medicine question routed; blur refused on the phone |
| Chromium layout (`e2e/redesign.mjs`, mocked) | **45/45** |
| Chromium safety scenarios (`e2e/vision.mjs`, mocked) | **15/15** (a stairs warning still interrupts a reading) |

**Not tested:** real phones, real photos, real voices on Android, blind users.

## 9. Files changed

- **New:**
  - `src/lib/assistant/document.ts` (rewritten)
  - `tests/document.test.ts` (rewritten)
  - `e2e/read/make_plan_set.py`, `e2e/read/plan.ts`
  - `docs/PHASE1_LEGAL_REVIEW_CHECKLIST.md`, this report
- **Modified:**
  - `src/lib/ai/vision.ts` (double reading, Gemini only, medical rerouting)
  - `src/app/api/vision/route.ts` (second frame, 4.2 MB limit)
  - `src/lib/assistant/schema.ts` (dose removal everywhere, document in view)
  - `src/lib/assistant/prompts.ts`, `src/lib/live/config.ts` (prompts)
  - `src/lib/assistant/phrases.ts` (wording, notices, four languages)
  - `src/lib/assistant/controller.ts` (notice, two frames, holds, medical routing, live)
  - `src/lib/assistant/settings.ts` (consent v3, document notice)
  - `src/lib/assistant/types.ts`, `api.ts`, `src/lib/server/monitor.ts` (new event)
  - tests: `controller`, `visionRoute`, `languages`, `tts`
  - e2e: `redesign.mjs`, `vision.mjs`, `read/browser.mjs`, `read/run.ts`
  - `docs/ARCHITECTURE.md`
