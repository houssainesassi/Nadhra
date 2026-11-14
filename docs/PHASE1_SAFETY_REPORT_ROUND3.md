# Phase 1 reader: safety report, round 3

**Date:** 2026-11-13. **Scope:** your four decisions after the round-2 report (`PHASE1_SAFETY_FIXES_REPORT.md`), strictly within Phase 1. Not committed, pushed or deployed. No production settings changed. No Phase 2, registry, barcodes or Tesseract. No blind participants. Synthetic documents only.

**Priority applied throughout:** when Nadhra reads something, it must not confidently tell a blind person something that isn't printed. Reading fewer documents is the accepted cost.

## Verdict

In the final 31-case run with real Gemini (86 readings, each case 3 times), **no reading said anything wrong**:
- no wrong or invented name, dose, date or expiry status;
- no dose or AI explanation in the assistant's own words.

This includes the two cases that failed in round 2:
- **Arabic name misspelled (M12):** the name was never misspelled. When the two readings disagreed, it was withheld.
- **Dose completed under glare (M16b):** never completed.

The price:
- **Facts read fell from 95% to 63%.** Clear documents are now often partly withheld (§6).
- **Latency rose:** median 6.3 s, up from 2.8 s.

Rendered images are not real photographs, so zero errors here doesn't show the reader is safe on real boxes; see §7.

## 1. Medicine names read twice (decision 1)

- On a medical paper, **every line, names included, must appear in the second, independent reading as the whole line**, word for word and number for number. In round 2 only the numbers had to match, so «1) FEBRAUX 500 mg» would have confirmed «1) FEBRALIX 500 mg».
- **If the two readings disagree:** the name is not said. The user hears once that the text didn't match on both readings, and is asked for a clearer picture.
- **If they agree:** the name is still followed by «ثبّت فيه مع الصيدلي» ("check it with the pharmacist"), since both readings can make the same mistake. The same goes for the active substance.
- **Tests:**
  - "names: a name the second reading has differently is not said" (the real «فيبراليكس» / «فبراليكس» case)
  - "names: an agreed name is still followed by the pharmacist check"
  - "whole lines must agree, not just their numbers"
  - route test "names are read twice too"

## 2. Obscured, incomplete or uncertain lines: a check the model doesn't control (decision 2)

**New module `src/lib/assistant/lineCheck.ts`.** The model now gives each line a position in the picture. **Code, with no AI, then examines the actual pixels there in both frames**, using the open-source JPEG decoder jpeg-js 0.4.4 (BSD-3, no dependencies, server only). On a medical paper a line is read only if, in both frames, it:
- does not touch the edge of the picture → otherwise "edge" ("move back");
- has no solid mass on it or right after it, such as a finger, sticker or dark band → otherwise "covered" ("move it away");
- has no stretch of plain paper where the model claims characters, which is what glare leaves → otherwise "incomplete" ("tilt the paper or the phone");
- is not nearly empty, for example a misplaced box → otherwise "faint";
- has a usable position, in a picture that can be decoded → otherwise "no-box".

**Failing safely:**
- A line that fails, or can't be checked, is not read, in the reading, in «اقرا الكل» ("read all"), or in follow-up answers.
- The user is told once why, and how to take the next picture. A new photo is taken only when the user asks again.
- If uncertainty remains, the dose is never read.

**Calibration:**
- On real model boxes over the rendered documents: clean lines left at most 0.48 line-heights of empty stretch.
- Glare hiding «0 mg»: 0.97. A finger after «50»: a solid run of 0.71–0.73. The cut expiry line: a solid mass of 18.
- **Not calibrated on real phone photos.**

**Tests:**
- `tests/lineCheck.test.ts`: 6 tests covering clean, erased end, finger, solid inside, edge, faint, invalid boxes, and box formats.
- `tests/document.test.ts`: covered, edge and washed out in either frame; no check means nothing medical is read; bills are unaffected.
- `tests/visionRoute.test.ts`: real JPEGs through the full server, end to end: the washed-out end of a line, a line at the edge, an undecodable picture or missing positions.

Measured effect on the cases that failed before, final run:

| Case | Round 2 | Round 3 |
|---|---|---|
| M16b, glare hides «00 mg» | 1 of 3 runs completed "500 mg" | 0 of 3 |
| M19, finger over «0 mg» | 0 of 3 (after the round-2 fixes) | 0 of 3 |
| M20, frame cuts the expiry line | 0 of 3 | 0 of 3 |
| M12, Arabic name | 2 of 3 runs misspelled | 0 of 3 (name withheld when the readings differ) |

## 3. Automatic descriptions off by default (decision 3)

- A new setting, `autoDescribe`, **off by default**, replaces the old "narration" flag. Older saved settings don't carry it, so everyone starts with it off.
- **While off:**
  - no automatic picture is sent at all, neither descriptions nor cloud hazard scans;
  - pictures leave the phone only when the user asks: a question, a reading (after the document notice), or a live conversation they start;
  - the screen shows "describes when asked".
- **What the user hears at camera start, once per visit:** that no picture is sent unless they ask; that the phone's own warnings for people and vehicles still work; that **stairs and holes are not detected**; and how to turn descriptions on.
- **Turning it on:** «شعّل الوصف التلقائي» or "turn on automatic descriptions", or the Settings toggle. The user then hears that a picture goes to Google every few seconds, papers in view included. «سكّر الوصف التلقائي» turns it off.
- **Tests:**
  - controller: "by default no picture leaves the phone by itself", and "«شعّل الوصف التلقائي» turns scans on… and off"
  - settings: old saved settings stay off
  - Chromium: the "0." block in `e2e/redesign.mjs` checks, with a real camera and browser, that nothing is sent, the status, and the notice
- **Safety trade-off to know:** stairs and drops are detected only by the cloud scan. With the default, a user who walks with the camera on gets no stair warnings unless they turn descriptions on. You decided this; the user is told every visit.

## 4. Paid Gemini and legal review (decision 4)

Recorded as prerequisites in `PHASE1_LEGAL_REVIEW_CHECKLIST.md`: both must be completed before any real prescription is processed. No work was done on either, and no real prescription was used.

## 5. A real bug found and fixed in this round

**The check after every dose was not actually spoken after the second dose.**
- **Cause:** the speech queue silently drops a sentence identical to one already playing or waiting. That was meant for repeated status messages, but every «ثبّت فيها مع الصيدلي» ("check it with the pharmacist") is the same text, so on a prescription only the first dose got its check.
- **Why earlier rounds missed it:** the unit tests checked the planned speech, not what was played.
- **How it was found:** the browser test, which now checks the captions actually displayed.
- **Fix:** answer sentences are never dropped as duplicates.
- **Tests:** "speech: an answer sentence said twice is spoken twice" and "a prescription with several doses: the check is actually spoken after every one of them". Both fail on the old code and pass on the new.

## 6. Test results (final code)

| Test | Result |
|---|---|
| `npm test` | **288/288** (269 before this round), run twice |
| `npx tsc --noEmit` | no errors |
| `npm run build` | succeeds |
| Chromium, reading by voice, real Gemini (`e2e/read/browser.mjs`) | **18/18**. In one run a follow-up got "service unavailable" when all three models were busy; it's reported as SKIP, not hidden. |
| Chromium layout (`e2e/redesign.mjs`, mocked) | **49/49** (4 new default-off checks) |
| Chromium safety scenarios (`e2e/vision.mjs`, mocked) | **15/15** |
| 31 mock cases × 3 runs, real Gemini (`e2e/read/plan.ts`) | **86 readings, 0 critical.** 7 provider failures (free tier busy). Facts read 133/212. The run itself flagged 15 critical results; all 15 were the app's own fixed sentence, which mentions "twice" and "dose". The scorer was fixed to ignore fixed sentences, and the raw log was checked line by line. |

**Usefulness: what was withheld and why** (readings with at least one withheld line, of 86):
- "faint": 22. Mostly the model placing a line's box where there's no text.
- "incomplete": 17. Boxes wider than the text, or real washing-out.
- The two readings disagreed: 14.
- "covered": 7. Mostly blister foil.

| Fully or mostly read | Mostly withheld |
|---|---|
| decimals, 875/125 mg, 1 g vs 500 mg, 1500 mg, dot print, FAB/EXP, expiring this month, eye drops, finger and cut-off cases (the visible parts), typed handwriting, angled prescription | blister foil (0/9), dim room (0/9), embossed expiry (0/3), the readable-glare box M16 (3/9), several typed prescriptions (P01 1/6, P10 0/6, P08 2/6) |

**Latency:** median 6.3 s, 90% within 11.1 s, worst 15.9 s (round 2: median 2.8 s). Causes: decoding the photos (about 0.2–0.3 s each) and the longer answers with positions, on a busy free tier.

## 7. Remaining risks and unresolved issues

1. **Synthetic only.** The pixel check and the whole reader are calibrated on rendered images. Real phone photos have noise, curved boxes, real specular glare and compression. The check's thresholds and the model's box accuracy on them are unknown.
2. **Shared errors.** If both readings misread a whole line identically and its pixels look whole, it is spoken. The «قريت» wording and the check after every name, dose and date are the only remaining safeguard.
3. **Box quality limits usefulness.** Misplaced or loose boxes are the main reason clear lines are withheld. Possible improvement (needs approval): re-anchor a box onto the nearest printed line found in the pixels. That loosens the check, so it would need measuring first.
4. **Stairs and drops are not detected while automatic descriptions are off** (the default; see §3).
5. **Live conversation:** frames go to Gemini Live about once a second while the user's conversation is on, documents in view included, until a reading pauses them.
6. **Free-tier availability:** 7 of 93 requests failed (busy models). The user then hears that the service is unavailable, and nothing is guessed.
7. **Derja glossary:** still off, waiting for pharmacist review.
8. **Not done:** real Android devices, real photos, the legal and paid-tier reviews, blind participants.

## 8. Files changed in this round

- **New:**
  - `src/lib/assistant/lineCheck.ts`, `tests/lineCheck.test.ts`
  - `e2e/read/boxes.ts`, `e2e/read/linecheck.ts` (calibration helpers)
  - this report
- **Modified:**
  - `src/lib/assistant/document.ts` (whole-line agreement, pixel check, name check, messages)
  - `src/lib/ai/vision.ts` (decode both frames, pixel check)
  - `src/lib/assistant/prompts.ts` (line positions)
  - `src/lib/assistant/types.ts` (box, `unconfirmed`, `obscured`)
  - `src/lib/assistant/phrases.ts` (four languages: unconfirmed, obscured, name check, tips, automatic-description messages)
  - `src/lib/assistant/settings.ts` (`autoDescribe`, off)
  - `src/lib/assistant/controller.ts` (no automatic scans by default, notice, voice on/off, "manual" state)
  - `src/lib/assistant/commands.ts` (auto-on / auto-off)
  - `src/lib/assistant/speechQueue.ts` (duplicate answers kept)
  - `src/lib/assistant/uiText.ts`, `src/components/Assistant.tsx` (status and toggle text)
  - `package.json` and `package-lock.json` (jpeg-js 0.4.4)
  - tests: `controller`, `document`, `visionRoute`, `visionClient`
  - e2e: `redesign.mjs`, `vision.mjs`, `read/browser.mjs`, `read/plan.ts`
  - docs: `ARCHITECTURE.md`, `PHASE1_LEGAL_REVIEW_CHECKLIST.md`
