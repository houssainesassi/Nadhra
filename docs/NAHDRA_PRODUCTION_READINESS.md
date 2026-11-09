# Nadhra (نظرة): production readiness

- **Started:** 2026-11-10. This builds on `docs/NAHDRA_COMPLETE_FEATURE_AUDIT.md` (2026-11-09).
- **Goal:** make Nadhra reliable, accessible, privacy-conscious and safe enough for **controlled, supervised testing** with blind and visually impaired users.
- **Current verdict:** **not ready for unsupervised use.** Phase 1 (critical safety) is done in code and passes automated tests. It has **not** run on a real Android phone or with a blind tester. Phases 2–5 haven't started.
- **Rule for this document:** "verified" names the exact test that ran. Nothing here claims a real-device or user result that didn't happen.

---

## 1. Phase 1: critical safety fixes (done in code, 2026-11-10)

### 1.1 What changed

| Area | Problem (audit ref) | Fix | Files |
|---|---|---|---|
| Frames during speech | Cloud scans paused while any speech played, so a long reading also paused stairs and drop warnings (F18, F25, §9.1) | The scheduler no longer looks at speech. During a reading, scans continue at the normal change-driven rate (at most one every 4 s, same quota as silence). Their hazards are spoken. Their description is dropped instead of waiting behind the reading. | `scheduler.ts`, `controller.ts` (`applyAnalysis`) |
| Warning priority | Caution warnings used the `answer` priority, so they waited behind every remaining part of a reading (up to 2 min) | New `warning` priority. It interrupts answers, status and narration, never an urgent warning, and goes stale after 8 s. The interrupted reading resumes afterwards. | `speechQueue.ts`, `controller.ts` (`speakHazards`) |
| Urgent interruption | Urgent warnings already interrupted at once (unchanged). **New bug found:** the interrupted part of a multi-part reading was re-queued *after* the rest, so the reading resumed out of order. | Re-queued before the rest of its own reading. | `speechQueue.ts` |
| Detector failure | Load failure only logged and shown as text; a crash while running was silent (F23, §7.4) | Spoken at `warning` priority with the error tone and vibration: load failure, a load that doesn't finish within **20 s**, and a crash while running. When offline at the same time, the user hears "analysis is down, don't rely on me", never the offline notice that promises on-device warnings. The broken instance is closed, so "turn the camera off and on" (which the message tells the user) really retries. The status list keeps showing "Failed, cloud analysis only". | `controller.ts` (`detectorFailed`, `startDetector`), `phrases.ts` (`detectorFailed`, 4 languages) |
| "Stop listening" | Said through Ask with voice commands off, it turned them **on** (F36) | New `stopAssistant()`. `assistant-off` only ever turns the mode off and confirms. | `controller.ts` |
| Camera lifecycle | The camera was released only on `pagehide`, not when switching apps or tabs (F62) | Page hidden: the camera is released, an open microphone is aborted, speech stops. Page visible again: "the camera was off while you were away", then the camera restarts. A camera the user stopped stays off. Closing the page (`pagehide`) still shuts everything down, with no restart. | `controller.ts` (`leaveWhileHidden`, `returnFromHidden`), privacy text in `Assistant.tsx` |
| Background speech | (found while testing) An aborted Ask said "I didn't hear a question" after the user had left | Not said while hidden. | `controller.ts` (`listenOnce`) |
| Testability | `controller.ts` imported React through `store.ts`, so it couldn't run in unit tests | `useStore` moved to `src/lib/useStore.ts`. The controller takes an optional TTS engine in `attach()` and has a replaceable camera factory and detector timeout. Production behaviour is unchanged. | `store.ts`, `useStore.ts`, `controller.ts` |

New phrases `detectorFailed` and `wasAway` exist in Derja, MSA, French and English. **No native speaker has reviewed them** (same as every other phrase).

### 1.2 What was tested and how

| Test | Result | Notes |
|---|---|---|
| `npm test`: 122 unit tests (was 106) | **122/122 pass** | 13 new in `tests/controller.test.ts`, 3 new in `tests/visionClient.test.ts`. No network, no camera, no quota. |
| `npm run typecheck` | clean | |
| `npm run build` | succeeds | |
| Regression check: the fixes were reverted one by one and the tests run again | The tests for scans during speech, caution and urgent interruption, detector load, timeout and crash, "Stop listening", hidden-page release and resume order **fail on the old code** | Proves the tests detect the bugs. |
| Chromium e2e, 3 new scenarios, production build, every vision and voice request mocked in the browser | **15/15 checks pass** (run twice) | `hiddenReleasesCamera`, `detectorFailureSpoken`, `readingInterruptedByWarning`. Synthetic camera from `e2e/make_synthetic_camera.py`. **Zero Gemini requests, zero Microsoft voice requests.** |
| Existing 17 e2e scenarios | **not run** | They need `photos/street.jpg` and `photos/person.jpg` plus OpenCV, none of which are on this machine, and they use real Gemini quota. |

**Limits of these tests:**
- The hidden page is **simulated** by overriding `document.hidden`. Headless Chromium can't switch apps.
- The detector failure is forced by blocking `/mediapipe/**`. A real GPU or WASM crash on a phone wasn't reproduced.
- The voice is a silent MP3 through the cloud path, not a real Android voice.

### 1.3 Phase 1 items that still need a real phone

These go in `docs/ANDROID_TESTING.md` §9 (updated):
1. The green camera indicator turns off within about a second when switching apps, locking the phone, or switching Chrome tabs. It comes back on return, with the spoken notice.
2. The microphone indicator does the same with hands-free mode on.
3. Whether Android permission prompts, the notification shade or a phone call hide the page. If they do, the camera briefly restarts, which must be recorded.
4. A long reading (a real document) with a person or stairs entering view. Measure the time from the hazard appearing to the warning starting, and confirm the reading resumes from the right place.
5. Detector failure on a low-end phone (for example, with data saver blocking the 7 MB model). Is the spoken message understandable to a blind tester?
6. "Stop listening" through Ask in all four languages with real speech recognition.

### 1.4 Known remaining Phase 1 gaps (not fixed, by decision)

- **No scans while a question waits for its answer** (up to 27 s). The question frame itself returns urgent hazards, and on-device warnings keep running. Sending a parallel scan would double the quota. Revisit after measuring real answer latency.
- **Pause («وقّف التحليل») also stops on-device warnings.** It is the user's explicit choice and is spoken. Mobility trainers should review it.
- **A caution warning that waits more than 8 s is dropped silently**, for example while the user is talking. This is deliberate: an old warning describes the past. An optional earcon for "warning dropped" is in the roadmap.
- **The camera restarts automatically on return.** This assumes the browser keeps the camera permission. If it asks again, the user hears the camera error message.

---

## 2. Prioritized roadmap

Each phase is implemented and tested on its own, in this order. Items marked **[decision]** need the owner's choice before work starts. Items marked **[authorization]** touch production settings or paid services and won't be done without explicit approval.

### Phase 1b: supervised device check (before Phase 2 ships to testers)
1. Run `docs/ANDROID_TESTING.md` on at least one mid-range Android phone with TalkBack, with a sighted supervisor. Record results in the file.
2. Fix what it finds before anyone uses the app unsupervised.

### Phase 2: accessibility
1. **Arabic RTL interface.** Move every visible string into a dictionary per language (`tn`, `ar`, `fr`, `en`). Set `<html lang dir>` from the speech language. Use logical CSS (`ms-`/`me-`, already partly used). Mirror icons only where direction matters. Make Arabic the default UI for `tn`/`ar`. Derja on screen is a **[decision]**: written Derja vs MSA labels, with native-speaker review.
2. **Tunisian voice interaction.** The recognizer is `ar-TN` already. Add Derja command variants from real recordings with testers. Document that Chrome's `ar-TN` quality is unknown.
3. **TalkBack.**
   - Announce status changes (detector, connectivity, analysis down, camera lost) through a polite live region as well as the voice, so screen-reader-only users hear them.
   - Decide how the page voice and TalkBack coexist: **[decision]** default echo on with TalkBack detected (not reliably detectable), or a first-run question "do you use a screen reader?".
4. **Emergency.** Wire up the unused spoken location phrases (F70), add a strong haptic on open, and add a shortcut key.
5. **First-run audio tour.**
6. **Default theme from `prefers-color-scheme`**, and a high-contrast theme.

### Phase 3: offline
1. **Web app manifest and service worker** (no new dependency; a hand-written worker). Precache the app shell, fonts, `/mediapipe/wasm/*` and `efficientdet_lite0.tflite`. Use network-only for every `/api/*` route.
2. **Launch offline.** The app opens, and says that only on-device warnings work and that reading, describing and questions need the internet.
3. **Feature map on screen and by voice:** on-device (detector, tracker, earcons, haptics, Emergency `tel:`/`sms:` links) vs cloud (descriptions, reading, identify, questions, stairs and drops, recording transcription, cloud voice). Speech recognition in Chrome is cloud as well.
4. **Dead connection detection** beyond `navigator.onLine`: two consecutive network failures count as offline for announcements.
5. **Tests:** e2e with `context.setOffline(true)` before load and mid-session. Check that no text claims cloud features work offline (a source test on phrases).

### Phase 4: security and privacy
1. **API protection.**
   - Require a same-origin `Origin` or `Sec-Fetch-Site` on POST, and reject requests with no `Origin` (today they're allowed).
   - Add a short-lived signed session token issued by the page (HMAC with a server secret, no dependency).
   - **[decision][authorization]** A shared rate-limit store (Vercel KV or Upstash) replaces the per-instance memory limits. It needs an account and production configuration.
2. **Gemini quota.** A per-day budget counter per instance and globally (with the shared store). A "quota exhausted" spoken state distinct from "analysis down". **[decision]** A paid "no training" Gemini key before real users. Free tiers may keep images.
3. **Withdraw consent.** A Settings button that clears the flag, stops the camera and says so. Version consent by provider list, so a change of provider asks again.
4. **Image and data flow review.** Document exactly what leaves the device per request (image, last 4 sentences, last 3 Q&A, language, direction). Add a setting to not send conversation history.
5. **Disclose the Edge voice.** The consent and privacy text say spoken sentences may go to Microsoft through an unofficial endpoint. Add an option to turn the cloud voice off. **[decision]** Keep `EDGE_TTS_DISABLED` as the default for testers?
6. **Headers.** Content-Security-Policy and HSTS.
7. **Secrets.** Add a source test that no `GEMINI_`/`OPENROUTER_` value or key-shaped string is in client bundles (scan `.next/static` after build).

### Phase 5: testing (plan in §3)

---

## 3. Testing plan

| Layer | Tooling | What it must cover | Status |
|---|---|---|---|
| Unit | `node --test` (`npm test`) | Safety filters, urgency, gate, scheduler, queue priorities and interruption, tracker, commands (4 languages), phrases, TTS client and server, API validation, settings. **Controller:** speech vs scans, detector states, voice-command state machine, lifecycle. | 122 tests. Controller harness exists (`tests/controller.test.ts`). Extend it for consent withdrawal, offline and the Emergency page. |
| Integration | Route handlers with mocked `fetch` (`tests/visionRoute.test.ts`) | Provider chain, cooldowns, free-only guard, rate limit, Origin checks, error bodies never leaked | Exists. Extend for Origin-required and token checks (Phase 4). |
| Browser (mocked) | `e2e/vision.mjs` with `mockServices`, synthetic camera | Lifecycle, detector failure, reading interruption, offline launch, consent withdrawal, Emergency flow, language switch, RTL layout, axe | 3 scenarios added. Add offline, Emergency and RTL. **No quota.** |
| Browser (real AI) | `e2e/vision.mjs` with photo fixtures | Real Gemini descriptions, warnings and transcription | 17 scenarios exist. Run sparingly: each run uses free-tier quota. |
| Android real device | `docs/ANDROID_TESTING.md`, Chrome over HTTPS or `adb reverse` | Camera and microphone indicators, lifecycle, vibration, wake lock, earcons after the first tap, voices, battery and heat over 30 min | **Never run.** |
| Offline | Device in airplane mode; e2e `setOffline` | Launch offline, detector from cache, honest spoken limits | Not possible until Phase 3. |
| Camera lifecycle | Unit + e2e (simulated) + device | Hide, show, lock, call, permission prompts, tab switch, close | Unit and e2e pass. Device not done. |
| TalkBack | Device, blind tester and sighted observer | Reading order, labels in Arabic, focus after Emergency "call", page voice vs TalkBack overlap, live regions | **Never run.** |
| Speech interruption and emergency alerts | Unit + e2e + device | Urgent and caution cut readings, resume order, no two voices, alert tone and vibration, emergency page spoken | Unit and e2e pass. Device latency not measured. |
| AI and network failure | Unit + e2e (mocked 503, timeout, offline) | "Analysis down" spoken within 2 failures, recovery spoken, nothing invented | `aiFailure` e2e exists (uses real API for recovery). Add a fully mocked variant and a timeout variant. |
| Accuracy | Labelled local photo and video set (stairs, kerbs, doors, crossings, labels, medicine) | Recall, false alarms and latency per model or prompt change | **Doesn't exist.** Needs collection with consent. |
| Language | Native speakers of Derja, MSA and French | Phrases, safety regex lists, command phrases | **Never done.** |

**Quota rule:** default test runs (`npm test`, mocked e2e) make **zero** Gemini requests. Real-AI e2e is run on purpose, rarely, and its request count is reported.

---

## 4. Needs a real phone or a blind tester

**Real phone:**
- the camera and microphone indicators on hide, lock and close
- vibration without a recent tap
- earcons after a voice-only start
- the wake lock
- speech recognition in Derja
- installed Arabic voices
- battery and heat
- detector speed on a mid-range phone
- `sms:` body handling in the default SMS app
- `tel:` from TalkBack focus

**Blind tester (supervised):**
- whether the warnings are understandable and timely
- whether caution warnings cutting into readings are acceptable or annoying
- the detector-failure message
- the "camera was off while you were away" flow
- TalkBack coexistence
- Emergency page usability
- first-run experience
- trust: does the user over-rely on silence?

**Orientation and mobility trainer:**
- the person-urgency rule (never urgent)
- whether Pause should stop on-device warnings
- the warning repeat intervals

---

## 5. Change log

| Date | Phase | Summary |
|---|---|---|
| 2026-11-10 | 1 | Scans during speech, `warning` priority, resume order, detector failure spoken, "Stop listening" fix, camera released when hidden, no background "didn't hear". 122 unit tests, 3 mocked e2e scenarios (15 checks). Not device-tested. |
