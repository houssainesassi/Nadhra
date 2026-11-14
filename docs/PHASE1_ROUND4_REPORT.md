# Phase 1 reader: round 4 report (validation stage preparation)

**Date:** 2026-11-13. **Scope:** your five tasks after round 3. Not committed, pushed or deployed. No Phase 2, registry, barcodes or Tesseract. Synthetic documents only. No blind participants, no real prescriptions.

## Summary

| Task | Status |
|---|---|
| 1. Real-camera testing | **Prepared, not run.** It needs phones and an operator: printable synthetic kit, protocol for Android and iPhone, test-only capture switch, scorer. |
| 2. Reading accuracy | **Cause found and partly fixed.** 88% of withheld lines in the worst cases came from one model's misplaced line boxes. A prompt change raises that model's box accuracy from 76% to 84% of lines; the end-to-end gain is **not yet measured** (§2). |
| 2b. Safety (found while investigating) | Two holes in the pixel check closed: a box around only the visible part, and a box on another, longer line. |
| 3. Live conversation privacy | Done: its own spoken consent, spoken "sending to Google" at start and every 5 minutes, a stop command that acts on the partial transcript. |
| 4. Obstacles with automatic descriptions off | Done: "can't guarantee stairs, holes or obstacles" in the safety notice and at every camera start, a reminder while walking, and a caveat after "what's in front of me?". |
| 5. Tests | 301/301 unit and integration (288 before), typecheck clean, build succeeds; mocked browser suites 53/53 and 15/15. **The real-Gemini runs could not be completed: the daily free-tier quota ran out** (§6). |

## 1. Real-camera testing (prepared)

**`docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md`:**
- the equipment;
- how to run the app on Android (`adb reverse`) and iPhone (`next dev --experimental-https` on the local network) without deploying;
- a conditions matrix: light, glare and reflections, distance, angle, deliberately hidden parts, round bottles, blister, languages, hand-held;
- about 150–250 readings in two half-day sessions;
- pass criteria: **zero critical readings**, refusals in the dim condition, and the check heard after every name, dose and date.

**Tools:**

| Tool | What it does |
|---|---|
| `e2e/read/make_print_kit.py` | `kit.pdf` with 25 synthetic documents at real sizes (9 cm box faces, A5 papers), each marked "FICTIONAL SPECIMEN" outside the cut line, with notes (wrap round a bottle, glossy paper for the blister…); `kit.json` with the ground truth, same as the plan; page previews |
| `READ_CAPTURE_DIR` (test-only, server) | Saves each in-app reading (both frames, both raw readings, what was said, each line's verdict), so a session is scored with no new requests. Off unless set; **refused on Vercel**; documented as synthetic-only. Tested (off by default, refused on Vercel, saves when on). |
| `e2e/read/realcam.ts` | Scores a session from the operator's `labels.csv` (document, device, condition, what was physically hidden). Works on saved in-app captures or on camera-app photo pairs, with the same rules as the plan (now in `e2e/read/score.ts`). Reports per device and condition. Dry-run on synthetic photos: worked; a hidden strength would count as critical. |

## 2. Why readable facts are withheld, and what changed

**Diagnosis** (`e2e/read/diagnose.ts`, `e2e/read/draw_boxes.py`, the 13 lowest-coverage cases, real Gemini):

| Verdict | Lines (of 116) |
|---|---|
| read | 74 |
| first model's box failed (faint or incomplete) | **37** |
| second model's box failed | 3 |
| the two readings disagreed | 1 |
| no position / bare number («1-0-1») | 2 |

Drawn on the pictures: gemini-3.5-flash-lite (first reading) places boxes well at the top of a page and **drifts down by half a line to a line** further down, onto blank paper or between lines. gemini-3.1-flash-lite (second reading) is accurate.

**Box accuracy by prompt** (`e2e/read/boxvariants.ts`, 5 clean documents, 51 lines, real Gemini). This measures the share of lines whose box passes the pixel check:

| Prompt | 3.5-flash-lite | 3.1-flash-lite |
|---|---|---|
| "box" (round 3) | 76% | 96% |
| "box_2d" | 71% | 96% |
| **"box_2d" given first in each line (now used)** | **84%** | **98%** |

Both readings' boxes must pass, so the expected line pass rate goes from about 73% to about 82%. **This is an estimate, not an end-to-end measurement.** The full 31-case run hit the daily quota (§6).

**What was not done, and why:** moving a misplaced box onto the nearest printed line. A hidden dose's box could then land on a neighbouring intact line and pass, which would weaken the check, so I didn't. Using the accurate model for both readings would also raise coverage, but would make the two readings less independent, which you asked to keep. Both are options for you to decide on (§8).

**Other coverage changes:**
- **A busy second reading:** when it fails altogether, the user now hears "I couldn't read it a second time to check, the service is busy, ask again in a moment", instead of "take a clearer picture", which was misleading. Nothing medical is read either way.
- **Not changed:** «1-0-1»-style posology lines are still held back by the bare-number rule. That's safe, but it costs coverage on such prescriptions.

## 2b. The pixel check, made stricter

The box-drift investigation showed two ways the check could pass a line it shouldn't:
1. **A box drawn around only the visible part** of a line («50» while claiming «500 mg»): nothing blank inside the box.
2. **A box on another, intact line.**

**New rule:** the printed ink in the box must be about as wide as the characters claimed, 0.22 to 1.3 line heights per character.
- **Calibration:** on 182 lines that pass, from both models, the range is 0.26–0.97. «50» for «500 mg» gives about 0.20.
- **What it doesn't catch:** a box on a *neighbouring line of similar length*, or one hidden character at the very end (only the "g" of "mg").
- **Tests:** `tests/lineCheck.test.ts` (tight box on the visible part, box on a longer line, the calibrated range); the saved failure boxes are still caught (M16b, M19, M20).

## 3. Live conversation privacy

- **Its own spoken consent**, before anything is sent:
  - The notice says: voice and about one picture a second go to Google Gemini for as long as it runs; Google's free service may keep and use them, and staff may see them; don't show papers with personal details; and how to stop.
  - It starts only after «موافق» or a second press of the button, which now reads "I agree: start the live conversation". «رجّع» cancels.
  - Withdrawing consent forgets it.
- **Spoken indication:**
  - at the start: "the live conversation is on: your voice and the picture are going to Google Gemini now. To stop sending, say: stop live";
  - every 5 minutes, a reminder;
  - at the end: "no voice or picture is being sent".
  - The Settings hint says the same.
- **Immediate stop:**
  - Phrases: «وقّف المحادثة», «وقّف الإرسال», "stop live", "stop sending", "arrête la conversation"…, plus "stop listening" and "close the camera".
  - They are matched on **every partial transcript** of the user's words, so sending stops as soon as the phrase is recognised, instead of when the model starts answering.
  - **Limit:** the transcript comes from Gemini Live itself, so the stop words have reached Google by then. The button on screen stops it locally.
- **Tests:**
  - controller: notice first and nothing started; «رجّع»; «موافق»; stop on a partial transcript; 5-minute reminder; consent withdrawal;
  - browser: the first press only asks, with no token request, and the second press starts.

## 4. Obstacles with automatic descriptions off

- **Safety notice** (first camera start of a visit), in the four languages: "…it can't guarantee it will see stairs, holes or obstacles".
- **Every later camera start:** «تنبيه: نظرة ما تنجمش تضمن إنها تشوف الدروج ولا الحفر ولا العوائق. كمّل بالعصا.» ("Note: Nadhra can't guarantee it will see stairs, holes or obstacles. Keep using your cane.")
- **Walking reminder:**
  - When the camera keeps moving for 4 s (on-device motion measure) with automatic descriptions off or paused, and no live conversation, the user hears that stairs and holes aren't seen, plus how to turn descriptions on.
  - At most every 3 minutes.
  - Not said when automatic descriptions are on.
- **"What's in front of me?" and "describe"** end with the no-guarantee sentence, at most every 5 minutes.
- **Unchanged:** the camera-start notice saying automatic descriptions are off and stairs and holes aren't detected, and the Settings toggle text.
- **Tests:** notice wording in four languages; reminder on a later camera start; walking reminder (and not with descriptions on, nor repeated at once); caveat after "what's in front of me?" (not repeated within 5 minutes).

## 5. Tests executed

| Test | Result |
|---|---|
| `npm test` | **301/301** |
| `npx tsc --noEmit` | no errors |
| `npm run build` | succeeds |
| Chromium layout (`e2e/redesign.mjs`, mocked) | **53/53**: 4 default-off checks and 4 new live-consent checks |
| Chromium safety scenarios (`e2e/vision.mjs`, mocked) | **15/15** |
| Chromium reading with real Gemini (`e2e/read/browser.mjs`) | **Not run this round: quota exhausted.** Last run 18/18 (round 3, before this round's changes) |
| 31 cases × 3 runs, real Gemini | **Incomplete:** 44 readings succeeded, **0 critical**; 49 failed at the provider (HTTP 429 "exceeded your current quota" on all three models). The coverage figure from it (77/115) is not meaningful, because the rate-limited second readings correctly withheld everything. |
| Box accuracy experiment, diagnosis (real Gemini, earlier the same day) | §2 |

## 6. Remaining risks and unresolved issues

1. **Not measured end to end:** this round's coverage gain, and whether it holds on real cameras. Next step, after the quota resets: the 31-case run, then the real-camera sessions.
2. **The free tier is not enough for validation.** One full 31-case run (two readings each) plus diagnostics used up the daily quota. The real-camera sessions (150–250 readings) need either several days or a paid project. The paid-terms review you required before real prescriptions applies here too, though these sessions use only synthetic documents.
3. **Shared misreadings:** both readings identical and the pixels looking whole remain possible (round-3 risk 2).
4. **The pixel check's remaining blind spots:** a box on a neighbouring line of similar length; one hidden character at the end of a line. Neither calibrated on real photos.
5. **Live stop:** the stop words are recognised by Gemini Live, so they're transmitted. Stopping without any transmission needs the screen button. A local stop-word detector would need its own work.
6. **Stairs and holes:** still not detected with automatic descriptions off. The user is now told at every camera start and while walking.
7. Blister foil, dim pictures and «1-0-1»-style posology remain mostly withheld.

## 7. Recommendations, for your decision

1. When the quota resets: run the 31-case plan again to measure this round's coverage gain end to end, and the Chromium reading test.
2. Decide how the real-camera sessions get enough quota: spread over days, or a paid project after the terms review.
3. Run the real-camera protocol with sighted operators: two Android phones and an iPhone, the printed kit.
4. Coverage options that need your decision, because each trades something:
   - (a) use the accurate model for both readings, with less independence;
   - (b) ask the accurate model to locate the first reading's lines (one more request per reading, about +3 s);
   - (c) accept the current coverage.
5. A local "stop" for live conversations without sending the stop words: a small on-device keyword detector. Separate work.

## 8. Files changed in this round

- **New:**
  - `src/lib/assistant/lineCheck.ts` (width check: `inkWidthPerChar`)
  - `e2e/read/diagnose.ts`, `e2e/read/draw_boxes.py`, `e2e/read/boxvariants.ts`, `e2e/read/width_calib.ts`
  - `e2e/read/make_print_kit.py`, `e2e/read/realcam.ts`, `e2e/read/score.ts`
  - `docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md`, this report
- **Modified:**
  - `src/lib/assistant/document.ts` (per-line verdicts, `box_2d`, busy-service message)
  - `src/lib/assistant/prompts.ts` (`box_2d` first)
  - `src/lib/ai/vision.ts` (test-only capture)
  - `src/lib/assistant/controller.ts` (live consent, stop on partial transcript, reminders, obstacle notices)
  - `src/lib/assistant/commands.ts` (live-off)
  - `src/lib/assistant/phrases.ts` (four languages)
  - `src/lib/assistant/settings.ts` (live consent)
  - `src/lib/assistant/types.ts`
  - `src/components/Assistant.tsx` (live button and hint)
  - tests: `lineCheck`, `document`, `controller`, `visionRoute`
  - e2e: `redesign.mjs`, `read/plan.ts`, `read/make_plan_set.py`
  - docs: `ARCHITECTURE.md`
