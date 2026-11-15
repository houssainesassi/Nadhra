# Nadhra (نظرة): complete feature audit

- **Date:** 2026-11-15. This replaces the audit of 2026-11-09 (with its 2026-11-10 update), which no longer matched the app after the redesign of 12 Nov, the medicine reader, the live conversation privacy work and the Nadhra AI track.
- **Scope:** the working tree of `/home/hello/Downloads/blind` on branch `mai`: commit `fe8f244` plus the uncommitted changes that restore the main-screen action buttons (§4.1, A03).
- **Method:** I read the source under `src/` (about 12,200 lines), the tests, the browser test scripts, the README and the docs. Each claim below was checked against the code, not taken from earlier reports. Test results are from runs on 2026-11-15 unless a section says otherwise. Earlier results are quoted from the report that recorded them, and say so.
- **References** name files and functions, not line numbers, because line numbers go stale.

> **No feature has been tested on a real phone, with TalkBack, or by a blind or low-vision user.** Every "tested" below means automated tests on a computer: unit tests in Node, and Chromium with a fake camera and microphone. `docs/ANDROID_TESTING.md` and `docs/BETA_TEST_CHECKLIST.md` have never been filled in. The Derja, Standard Arabic and French wording has never been reviewed by native speakers.

---

## 1. Summary

Nadhra is a single-page web app (Next.js 16, React 19) that turns a phone or laptop camera into a spoken assistant for blind and visually impaired people in Tunisia. It speaks and listens in four languages: Tunisian Derja (the default), Modern Standard Arabic, French and English.

It has three layers:

1. **On-device** (always on while the camera runs): MediaPipe EfficientDet-Lite0 finds people, vehicles and some furniture in under a second, sends nothing anywhere, and keeps working offline.
2. **Cloud, on request** (Google Gemini, with OpenRouter as a fallback for some tasks): descriptions, reading text and medicine boxes, identifying objects, questions, and the only detection of stairs and drops. Automatic descriptions are **off by default**, so no picture leaves the phone unless the user asks.
3. **Live conversation** (Gemini Live): a spoken, interruptible conversation, with the microphone and about one picture a second streamed straight from the browser to Google.

**Nadhra AI**, the project's own offline engines, is a selectable provider. **No engine is connected yet.** Choosing it leaves only the on-device warnings running, and every other request is refused out loud (§4.13).

**Verdict:** not ready for unsupervised use. The safety rules are strong and enforced in code, and the automated tests are broad. But nothing has run on a real phone or with the people it is for.

**Count:** 105 features. 48 are implemented and tested in software, 35 are implemented but not tested on real devices, 9 are experimental, and 13 are unavailable or not implemented (§5).

---

## 2. Status legend

| Code | Meaning |
|---|---|
| **TS** | **Implemented and tested in software.** Automated unit or browser tests cover it, and its behaviour is decided by the code, not by a device, a browser service or an AI model. |
| **ND** | **Implemented, not tested on real devices.** Automated tests pass, but how well it works depends on the phone, the browser's services, the network or the AI model, and none of that has been tried for real. |
| **EX** | **Experimental.** It works in tests, but it rests on a heuristic with known weaknesses, an unofficial service, an unmeasured model ability, or test data that is rendered rather than real. |
| **NA** | **Unavailable or not implemented.** Either not built, removed, switched off, or present only as benchmarks or plumbing. |

"Languages" means the spoken output unless stated. "4" means English, Derja, Standard Arabic and French.

---

## 3. Architecture

```
Browser (one page: src/app/page.tsx → src/components/Assistant.tsx)
 ├─ Assistant.tsx (React)  ──calls──▶  SmartVisionController (src/lib/assistant/controller.ts, no React)
 │        ▲ useStore (src/lib/useStore.ts, src/lib/store.ts)        │
 │        └──────────── state patches ──────────────────────────────┤
 ├─ Camera (cameraSource.ts, camera/camera.ts)
 │    ├─ video ─▶ LocalDetector (MediaPipe WASM, CPU) ─▶ HazardTracker ─▶ hazardUrgency / WarningGate
 │    └─ 160×120 thumbnail every 0.5 s ─▶ frameAnalysis + scheduler ─▶ apiFetch POST /api/vision
 ├─ VoiceInput (voiceInput.ts): SpeechRecognition (Google, in Chrome) or recorder ─▶ /api/vision/transcribe
 ├─ SpeechQueue ─▶ HybridTts (src/lib/speech/tts.ts): browser voice, or /api/tts (Edge voice)
 ├─ Live (src/lib/live/): token from /api/live/token, then one WebSocket straight to Gemini Live
 └─ Earcons (WebAudio), vibration, Wake Lock, Geolocation (Emergency page only)

Next.js server (Node runtime)
 ├─ guard.ts: Origin → session cookie → per-minute limits → daily budgets (usageStore.ts; Upstash optional)
 ├─ /api/vision         ai/vision.ts provider chain, ai/router.ts (AI_MODE), schema.ts / document.ts safety rules
 ├─ /api/vision/transcribe   Gemini audio → text
 ├─ /api/tts            speech/edgeTts.ts → Microsoft Edge "Read aloud" WebSocket (unofficial)
 ├─ /api/live/token     server/liveToken.ts: one-use token with model, voice and instructions locked
 ├─ /api/session        HMAC-signed session cookie
 ├─ /api/report, /api/health   monitor.ts counters (no content)
 └─ server/engines/     Nadhra engine manifests and launcher (not used by any route yet)
```

- **One controller owns all state,** including which panel is open, so voice commands and buttons go through the same methods: `runTask`, `askByVoice`, `pause`/`resume`, `toggleLive`, `openSheet`, and so on.
- **Shared pure modules** (`types.ts`, `lang.ts`, `schema.ts`, `phrases.ts`, `prompts.ts`, `document.ts`, `lineCheck.ts`) run on both sides. The safety rules run on the server.
- **More detail** is in `docs/ARCHITECTURE.md`.

---

## 4. Feature inventory

### 4.1 Main screen and navigation

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| A01 | **Open camera**: one press runs the consent check, then the camera, the on-device detector and hands-free voice commands | `Assistant.tsx`, `controller.startAssistance` | ND | Focus starts here. Chromium: focus, consent-first and layout checks pass. |
| A02 | **Camera screen**: preview, state pill, microphone pill, notices (offline, detector failed, service down), caption with "Heard «…»" | `Assistant.tsx` | TS | Text over the video sits on solid plates. |
| A03 | **Five action buttons (restored 2026-11-15)**: Describe surroundings, Read text, Identify object, Ask a question, Pause/Resume descriptions | `Assistant.tsx` (`.actions`), `uiText.ts` (`actions`), `icons.tsx`, `globals.css`; same controller calls as the voice commands and keys | ND | See below. |
| A04 | **Stop assistance** (camera, voice commands and live conversation off; focus returns to Open camera) | `controller.stopAssistance` | TS | Chromium: every camera track ends. |
| A05 | **Header**: language selector, Privacy & safety, Settings | `Assistant.tsx` | TS | Icon buttons have names; 48 px or more. |
| A06 | **AI switch** "Gemini" / "Nadhra (experimental)" | `Assistant.tsx` (`ProviderSwitch`), `ai/router.ts` (`nadhraOffered`) | TS | Shown only when the server sets `NADHRA_AI_ENABLED`, or when Nadhra is already chosen. Native radio buttons. |
| A07 | **Main-screen text in four languages**, right to left for Arabic | `uiText.ts`, `lang` and `dir` on `.app` | TS | Settings, Privacy & safety, Emergency and the consent dialog stay English (§4.8). |
| A08 | **Keyboard shortcuts** C, D, T, I, Q, P, V, L, R, H, Esc (physical key positions, so any layout works) | `Assistant.tsx` keydown handler | TS | They clash with screen readers' browse mode. The buttons are the alternative for C, D, T, I, Q and P. |
| A09 | **Consent dialog** (English on screen, spoken in the speech language); decline; withdraw | `Assistant.tsx`, `controller.acceptConsent`, `declineConsent`, `withdrawConsent`, `settings.ts` (`CONSENT_KEY` v3) | TS | Withdraw is in Privacy & safety only. It stops the camera and the live conversation, and forgets the reading and live notices, the conversation history and the remembered document. |
| A10 | **Privacy & safety panel** (experimental notice, who receives images) | `Assistant.tsx` (`PrivacyText`) | TS | English only. |
| A11 | **Theme, text size, motion**: dark/light, text 100–175 % on top of the browser's size, reduced motion, forced colours | `globals.css`, `layout.tsx` (theme script) | TS | Chromium: no transitions under reduced motion. The theme doesn't follow the OS setting. |
| A12 | **Install to home screen** (web app manifest, SVG + PNG icons) | `src/app/manifest.ts`, `src/app/icon.svg`, `src/app/apple-icon.png`, `public/icons/` | ND | No service worker, so the app can't open offline (K02). |

**A03 in detail.**
- **Placement:** between the camera and Stop assistance, so a TalkBack swipe goes caption, actions, then Stop. They are visible whenever assistance is active.
- **Accessibility:** native `<button>` elements, named by their visible words, in a group named "Actions". Pause is described as "Warnings keep running".
- **Size:** at least 48 px each way; one column at 150 % text and above; a side column on a phone held sideways.
- **Behaviour:**
  - Describe, Read and Identify start the camera if it is off.
  - Read goes to the medicine and document reader (C01).
  - Ask records one question and becomes "Done, send question". With voice commands on, it plays the listening tone, and says "I'm listening" if the microphone isn't open yet. It no longer cuts off what the user is saying.
  - Pause only appears when descriptions are automatic (not with Nadhra, not during a live conversation). Once paused, Resume stays visible.
  - With Nadhra selected, Describe, Read and Identify stay visible, and a tap speaks why they aren't available.
- **Tested:** 4 unit tests, plus Chromium checks of names, order, size, taps, Pause/Resume, Derja labels, six screen sizes, 200 % text and an axe scan with no violations.
- **Not tested** with TalkBack or on a phone.
- **Cost:** on a 390×844 phone the camera keeps about half the screen, down from about two thirds.

### 4.2 Vision and questions (Gemini)

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| B01 | **Describe surroundings** (button, D, «وصفلي البلاصة») | `controller.runTask("describe")`, `prompts.ts` | ND | Ends with a "can't guarantee obstacles" caveat at most every 5 min. |
| B02 | **Identify object or product** (button, I, «شنوة هاذي؟») | `runTask("identify")` | ND | Doses are dropped from the answer (C04). |
| B03 | **What's in front of me** (voice only, «شنوة قدّامي؟») | `runTask("front")` | ND | No button. Path questions always get a caveat. |
| B04 | **Questions with the camera on** (push-to-talk or hands-free) | `controller.ask`, `/api/vision` `mode: "question"` | ND | A fresh 1280 px frame, plus an older small frame for motion. |
| B05 | **Questions with the camera off** ("chat", no image); a question about the surroundings comes back as `[CAMERA]` and the camera is asked for | `/api/vision` `mode: "chat"`, `prompts.ts` | ND | |
| B06 | **Follow-up memory**: last 3 question/answer pairs, last 4 spoken sentences | `controller.ts`, `prompts.ts` | TS | Kept in memory only. |
| B07 | **Answer in the question's language** (Derja words or Arabizi give Derja; Standard Arabic, French, English) | `lang.ts` (`questionLang`) | TS | The voice changes for that answer only. |
| B08 | **Streamed answers** (server-sent events; a sentence is sent early only if the final checks keep it unchanged) | `/api/vision` (`streamAnswer`), `schema.ts` (`SentenceStreamer`) | TS | Path questions are never streamed. |
| B09 | **Web search grounding** for live facts | `ai/vision.ts` (`canSearch`, `GEMINI_SEARCH_API_KEY`), `guard.ts` (`allowSearch`) | EX | Needs a billed Gemini key, since it isn't in the free tier, and has its own daily budget. Without it, questions are answered without search. No real search run is recorded. |
| B10 | **Automatic descriptions** (off by default; Settings toggle or «شعّل الوصف التلقائي») | `settings.ts` (`autoDescribe`), `controller.tick` | ND | When off, stairs and drops are not detected (E03), and the camera-start notice says so. |
| B11 | **Change-driven frame scheduler**: at most every 4 s, on >8 % change or a new detection, heartbeat 20→80 s, back-off after failures | `scheduler.ts` | TS | Speech never holds a scan back. |
| B12 | **Image-quality gate** (dark, overexposed, flat, blurred) with spoken notices | `frameAnalysis.ts`, `controller.ts` | ND | Thresholds have not been checked on real phone frames. |
| B13 | **Left/right correction**: camera direction setting, sides swapped on the server for a webcam facing the user | `settings.ts` (`facing`), `schema.ts`, `prompts.ts` | ND | In one live test the model still answered about the wrong side (README). |
| B14 | **Switch camera** (Settings, only with more than one camera and the camera on) | `controller.switchCamera` | ND | |
| B15 | **Camera lost** (track ended) is spoken as urgent | `controller.ts` (`cameraLost`) | ND | |
| B16 | **Provider chain**: Gemini models in order, then OpenRouter (free models only); cooldowns; total time budget | `ai/vision.ts`, `ai/http.ts` | TS | Paid models are refused by design. OpenRouter never reads documents or transcribes. |
| B17 | **Motion from a second frame** (no motion claim without one) | `controller.ts`, `schema.ts` | EX | Model ability unmeasured. |

### 4.3 Medicine and document reader

The rule above all others: an unverified dose or date is never stated as fact.

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| C01 | **Read a document or medicine box**: two frames 0.4 s apart, two readings by two different models at temperature 0, and a pixel check (no AI) that each line is whole in both frames | `controller.readDocument`, `ai/vision.ts` (reading, `withLocatedBoxes`), `document.ts` (`sanitizeDocument`), `lineCheck.ts` | EX | Tested only with **rendered** documents. Real boxes, bottles, blister packs, crumpled paper and handwriting are untested. The full-resolution still photo path is untested on a phone. |
| C02 | **Medical safety rules**: a line is read only if both readings agree word for word and the pixel check passes; strengths need their unit; numbered lines held back when the model reports glare, blur or handwriting; "check it with the pharmacist" after every name, dose and date; expiry judged in code and said conditionally | `document.ts` | TS | 52 unit tests in `tests/document.test.ts`. |
| C03 | **No medical advice anywhere**: advice is removed; "can I take…?" gets "only your doctor or pharmacist"; a sentence with a dose is dropped from scans, questions, chat, streamed sentences and live answers (`mentionsDose`) | `document.ts`, `schema.ts`, `controller.ts` | TS | |
| C04 | **Read all** («اقرا الكل», "read all") from the 5-minute page memory, with the same checks | `controller.readAll` | TS | |
| C05 | **Questions about the document** (quote from the checked text, then the check) | `document.ts`, `controller.ts` | ND | |
| C06 | **On-device check before sending** (too dark, no sharp tile) with how to retake | `frameAnalysis.ts`, `controller.ts` | ND | The blur limit (`READ_BLUR_LIMIT = 20`) is calibrated on rendered pages only. |
| C07 | **Spoken notice before the first reading** (two pictures to Google, no real prescriptions); «موافق» accepts | `settings.ts` (`READ_CONSENT_KEY`), `controller.ts` | TS | |
| C08 | **Paper's text in its own language's voice** (a French box in the French voice) | `controller.ts`, `speechQueue.ts` | ND | |
| C09 | **Derja rendering of instructions** (fixed glossary) | `document.ts` (`derjaInstruction`) | NA | Switched off (`DERJA_GLOSSARY_APPROVED = false`) until a pharmacist approves it. |
| C10 | **Test capture for real-camera sessions** (`READ_CAPTURE_DIR`) | server, `e2e/read/realcam.ts` | NA | Developer tool only: off unless set, refused on Vercel, synthetic documents only. The real-camera session it was built for has not been run. |

**Known reader weaknesses:**
- One model's line boxes caused most withheld lines in earlier runs (`docs/PHASE1_ROUND4_REPORT.md`). The end-to-end effect of the prompt fix is not measured.
- The model's wording of explanations for bills and letters is not checked.
- Month names in expiry dates are read but not judged.
- If the second reading fails, nothing medical is read.

### 4.4 Live conversation (Gemini Live)

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| D01 | **Talk live**: microphone and up to 1 frame/s to Gemini Live; interruptible; female voice | `src/lib/live/session.ts`, `audioIO.ts`, `config.ts`, `controller.toggleLive` | ND | The button is on the **main screen**: next to Open camera at rest, beside Stop assistance while assisting (or the L key). Its words follow the language selector. Median 1.07 s from end of speech to answer, measured on the developer's connection (README). |
| D02 | **Own spoken consent**; "sending to Google now" at the start, every 5 min, and "nothing more is sent" at the end | `controller.ts`, `settings.ts` (`LIVE_CONSENT_KEY`) | TS | |
| D03 | **Stop by voice** on partial transcripts («وقّف المحادثة», "stop live", "stop sending") | `controller.ts` | ND | The words themselves reach Google: the transcript comes from Gemini Live. |
| D04 | **Female voices only** (`Sulafat` by default; a male voice in the environment is ignored) | `live/config.ts` | TS | The Derja accent was checked by another AI model and a pitch measurement, not by Tunisian listeners. |
| D05 | **Answers checked after the fact**: a safety promise or a dose cuts the answer and the caveat is said | `controller.ts` (`isSafetyClaim`, `mentionsDose`) | EX | The first words may already have been heard. |
| D06 | **Hazard scans continue during live**, every 8 s or more, for their warnings only; on-device warnings cut the answer | `controller.ts` (`LIVE_HAZARD_SCAN_MS`) | ND | Stairs and drops arrive later than outside live. |
| D07 | **«نجدة» during live** opens the Emergency page instead of being answered | `controller.ts` | TS | |
| D08 | **Reconnect and model fallback** (resumption handle, up to 3 s of audio buffered) | `live/session.ts` | ND | |
| D09 | **One-use locked token** (model, voice and instructions locked; the API key never reaches the browser) | `server/liveToken.ts`, `/api/live/token` | TS | |

### 4.5 Safety layer

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| E01 | **On-device detection**: 14 classes (person, car, motorcycle, bicycle, bus, truck, train, chair, bench, couch, dining table, potted plant, suitcase, fire hydrant) | `localDetector.ts`, `hazardTracker.ts`, model in `public/mediapipe/` | ND | Runs offline and sends nothing. It doesn't know stairs, kerbs, holes or poles. |
| E02 | **Tracker**: 3 sightings before anything is reported; "approaching" from size growth over at least 1 s with a still camera | `hazardTracker.ts` | EX | A heuristic, never measured against real approaches. |
| E03 | **Cloud hazards**: stairs, drops, vehicles, obstacles, people | `prompts.ts`, `schema.ts` | EX | The only source for stairs and drops. Only runs with automatic descriptions on, or during live every 8 s or more. About 2–3 s when the service is healthy. No accuracy benchmark exists. |
| E04 | **Urgency computed in code**; uncertain is never urgent | `hazards.ts` (`hazardUrgency`) | TS | A person is never "urgent", even near, approaching and straight ahead. That rule needs review by mobility trainers. |
| E05 | **Templated warnings** worded by confidence | `phrases.ts` (`warningPhrase`) | TS | |
| E06 | **Warning gate**: repeats at most every 15 s (urgent), 45 s (caution) or 60 s (info), and lets an escalation through at once | `hazards.ts` (`WarningGate`) | TS | |
| E07 | **Safety-language filter**: no safety promises, no distances, no motion without a second frame | `schema.ts` (`guardSpoken`, `sanitizeAnalysis`) | TS | The patterns cover 4 languages, without native-speaker review. |
| E08 | **Caveats**: path questions; "no guarantee about stairs, holes or obstacles" at camera start; walking reminder at most every 3 min when nothing is scanning | `schema.ts`, `controller.ts` | TS | |
| E09 | **Urgent alert feedback**: urgent tones, strong vibration, red edge and caption, `role="alert"` | `controller.ts`, `earcons.ts`, `Assistant.tsx` | ND | Chromium shows the urgent display. Vibration and audio on phones are untested. |
| E10 | **Failure announcements**: service down, not configured, quota exhausted, rate limited, detector failed (load, 20 s timeout, crash), offline | `controller.ts`, `phrases.ts` | TS | |
| E11 | **Pause never turns the safety layer off**: the on-device detector keeps warning, and the pause notice says whether it is running | `controller.pause` | TS | Chromium checks this through the new Pause button. |
| E12 | **Stale results and stopped sessions are discarded** (results older than 12 s, session counter) | `controller.ts` | TS | |

### 4.6 Voice input

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| F01 | **Hands-free voice commands** (on by itself with Open camera; toggle in Settings or V) | `controller.ts` (`assistantLoop`), `voiceInput.ts` | ND | Any nearby speech becomes a question, which uses quota. Speech recognition has only been tried with synthetic speech. |
| F02 | **Command parser**: 24 commands plus 4 language switches, each in 4 languages; accents and vowel marks ignored | `commands.ts` | TS | All 80 spoken examples parse to their command (checked 2026-11-15). |
| F03 | **Ask (push-to-talk)**: button, Q, or with voice commands on, simply speak | `controller.askByVoice` | ND | Phase 1 fixed Ask cutting off speech in hands-free mode. |
| F04 | **Recording fallback**: on-device voice detector, 16 kHz WAV, Gemini transcription that first checks someone is speaking | `voiceInput.ts` (`RecorderInput`), `/api/vision/transcribe` | EX | |
| F05 | **Dead speech service detection** (switches to recording) | `voiceInput.ts`, `controller.ts` | EX | |
| F06 | **Turn-taking**: the assistant holds speech while the user talks or after Ask; only urgent warnings play | `speechQueue.ts` (`setHold`) | ND | |

### 4.7 Speech output and feedback

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| G01 | **Priority speech queue**: urgent > warning > answer > status > narration; resume after interruption; stale items dropped | `speechQueue.ts` | TS | |
| G02 | **Browser voice first** (best installed voice for the language) | `speech/tts.ts` (`HybridTts`, `pickVoice`) | ND | On most phones Derja is read by a non-Tunisian Arabic voice. |
| G03 | **Cloud voice fallback** (Edge neural voices, all female: `ar-TN-ReemNeural`, `ar-SA-ZariyahNeural`, `fr-FR-DeniseNeural`, `en-US-JennyNeural`) | `/api/tts`, `speech/edgeTts.ts`, `edgeDrm.ts` | EX | An unofficial Microsoft endpoint with a built-in token, which may stop working at any time. |
| G04 | **Repeat, Stop talking, Help, Go back/cancel** | `controller.repeat`, `stopSpeech`, `help`, `goBack` | TS | Voice and keys only (R, Esc, H). The redesign removed their buttons. |
| G05 | **Speed and volume** (Settings, and "louder", "quieter", "faster", "slower") | `settings.ts`, `commands.ts` | TS | |
| G06 | **Earcons** (6: on, off, listen, urgent, error, alive) and **haptics** (5 patterns), with a vibration toggle | `earcons.ts`, `controller.ts` (`HAPTICS`) | ND | Audio needs a first tap to unlock. |
| G07 | **"Still running" tone** after 45 s of silence | `controller.ts` (`ALIVE_AFTER_SILENCE_MS`) | TS | |
| G08 | **Screen-reader echo** (two alternating live regions per kind, so the same sentence is read twice when repeated) and automatic echo when the page's voice fails | `announcer.ts`, `Assistant.tsx` (`useAnnouncer`) | ND | Off by default. Overlap between the page voice and TalkBack is untested. |
| G09 | **"/" spoken correctly** in dates, fractions and units («03/2027», «1/2 comprimé») | `speech/tts.ts` (`speechText`) | TS | |

### 4.8 Languages

| Area | English | Derja | Standard Arabic | French |
|---|---|---|---|---|
| Spoken phrases (140 keys) | ✓ | ✓ | ✓ | ✓ |
| Main-screen text (39 keys, including the 5 actions) | ✓ | ✓ | ✓ | ✓ |
| Settings, Privacy & safety, Emergency, consent dialog | ✓ | English | English | English |
| Model prompts (scan, question, read, live) | ✓ | ✓ | ✓ | ✓ |
| Voice commands (examples parse) | 20/20 | 20/20 | 20/20 | 20/20 |
| Speech recognition tag | `en-US` | `ar-TN` | `ar-SA` | `fr-FR` |
| Safety and distance patterns | ✓ | ✓ | ✓ | ✓ |
| Nadhra refusal sentences | ✓ | ✓ (approved wording) | ✓ | ✓ |
| Native-speaker review | n/a | **never** | **never** | **never** |

- **Default:** Tunisian Derja (`DEFAULT_VISION_SETTINGS.language = "tn"`). It was English from commit `375db18` (2026-11-14) until 2026-11-15. The default applies only when no valid language is saved: a saved choice is always kept, and any user who changed any setting has their language saved. A first visit is first drawn in the default language and switches to a saved one when the page loads its settings.
- **Switching:** the selector, Settings, or a voice command ("Speak French", «احكي بالتونسي»). Commands are understood in all four languages whatever the setting.
- **Phrase parity:** the 140 phrase keys and 39 screen-text keys match in all four languages. This was checked by script on 2026-11-15, and the TypeScript types enforce it.

### 4.9 Emergency

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| I01 | **Emergency page** (voice «نجدة», "emergency"; or Settings, "Open the Emergency page") | `controller.openSheet("emergency")`, `Assistant.tsx` | ND | **No button on the main screen** since the redesign. A screen-reader user without voice must go through Settings. |
| I02 | **Call the contact** (`tel:`); saying "call" focuses the call button, ready for one double-tap | `controller.requestCall` | ND | Programmatic focus may not move TalkBack's focus. Untested. |
| I03 | **Text my location** (`sms:` with a map link; one location fix, kept on the device) | `controller.emergencyMessage` | ND | Nothing is sent without the user's tap in their own app. |
| I04 | **Tunisian numbers** SAMU 190, police 197, civil protection 198 | `Assistant.tsx` (`EMERGENCY_NUMBERS`) | ND | English labels. |
| I05 | **Location status spoken** | `phrases.ts` (`locating`, `noLocation`) | NA | The phrases exist in all four languages but are never used. The status is shown as text in a `role="status"` paragraph only. |

### 4.10 Settings and storage

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| J01 | **Settings panel**: voice commands, live-conversation details (status, latency), speed, volume, text size, camera direction, colours, automatic descriptions, vibration, screen-reader echo, switch camera, emergency contact | `Assistant.tsx` | TS | English only. There is no list of voice commands in it: the spoken Help gives that list. |
| J02 | **Persistence and validation** (localStorage; every field clamped on load; phone number limited to digits, spaces and a leading +) | `settings.ts` (`sanitizeVisionSettings`, `cleanPhone`) | TS | The emergency contact is stored in plain text on the device. |

### 4.11 Connectivity, power, platform

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| K01 | **Offline while open**: spoken; frames stop; only on-device warnings; recognition loop sleeps | `controller.ts` | TS | The voice then works only with an installed device voice. |
| K02 | **Open offline** (service worker, cached detector) | — | NA | Not built. |
| K03 | **Hidden page**: camera and microphone released, speech stopped; on return "the camera was off while you were away" and the camera restarts | `controller.ts` (`visibilitychange`) | ND | Unit and mocked Chromium tests only. |
| K04 | **Screen wake lock** | `controller.ts` (`requestWakeLock`) | ND | |
| K05 | **Detector CPU budget** (duty cycle and minimum interval) | `camera/frameBudget.ts` | TS | No battery or heat measurement exists. |

### 4.12 Backend, protection and cost control

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| L01 | **Vision API** with validation (JPEG magic bytes, sizes, question length) | `src/app/api/vision/route.ts` | TS | |
| L02 | **Transcription API** (WAV only) | `src/app/api/vision/transcribe/route.ts` | TS | |
| L03 | **Request guard**: Origin required on POST, signed session cookie, per-minute limits per session and address, daily budgets per session and global | `server/guard.ts`, `session.ts`, `http.ts`, `/api/session` | TS | Not authentication: a script can still get a cookie. The global daily budget caps the cost. |
| L04 | **Shared counters across instances** (Upstash Redis) | `server/usageStore.ts` | ND | Optional. Without it, limits are per instance. Tested against a mocked Upstash endpoint (`tests/apiProtection.test.ts`), never a real store. |
| L05 | **Monitoring**: fixed event names and short codes only; `/api/report` from the page; `/api/health` (counters only with `HEALTH_TOKEN`) | `server/monitor.ts`, `src/app/api/report/route.ts`, `src/app/api/health/route.ts` | TS | |
| L06 | **Security headers**: CSP, HSTS, nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy | `next.config.ts` | TS | |
| L07 | **AI mode routing**: `AI_MODE` is `cloud` (default), `hybrid` or `offline`; a refusal is spoken, never hidden | `ai/router.ts`, `server/deviceCapabilities.ts` | TS | Hybrid and offline are only meaningful once a local engine exists. |

### 4.13 Nadhra AI (own engines)

| ID | Feature | Where | Status | Notes |
|---|---|---|---|---|
| M01 | **Provider choice and server refusal**: `provider: "nadhra"` is refused with 503 `nadhra-unavailable` on vision, transcription and live token, before any budget or network call | `ai/router.ts` (`requestedFamily`, `NADHRA_TASKS`), the three routes | TS | `NADHRA_TASKS` is empty: Nadhra declares no task. |
| M02 | **Local-only page with Nadhra chosen**: `apiFetch` refuses to send (`LocalOnlyError`), in-flight requests are aborted on the switch, only on-device voices are used, browser speech recognition is never chosen | `assistant/api.ts`, `controller.ts`, `speech/tts.ts` (`setLocalOnly`) | TS | Chromium: 75/75 with all outgoing server connections blocked and logged. |
| M03 | **Engine manifests and launcher** (permissive licences only, SHA-256-checked model files, RAM check, idle shutdown) | `src/lib/server/engines/manifest.ts`, `launcher.ts`, `engines/manifests/` | NA | Plumbing only: the manifests folder is empty and no route uses the launcher. Tested with a fake engine (`tests/engines.test.ts`). |
| M04 | **Offline OCR** | `bench/ocr/`, `bench/engines-step0/` | NA | **Benchmarks only, not an engine in the app.** PaddleOCR v5 and Tesseract were measured on 31 rendered mock documents (`bench/out/ocr-summary.md`) and as local servers (`docs/NADHRA_STEP0_REPORT.md`). Nothing reads text offline today. |
| M05 | **Offline speech recognition, voice and language model** | — | NA | Not built. A female Standard Arabic voice (Nabra-82M) was benchmarked and rejected for now (`docs/NABRA_BENCH_REPORT.md`). No free female Tunisian offline voice was found. |
| M06 | **Switching provider by voice** | — | NA | Not built by decision until local speech recognition exists. |

What works with Nadhra chosen today: the camera, on-device warnings, the speech queue with installed device voices, earcons, settings and the Emergency page. Everything else is refused out loud.

### 4.14 Not built, removed or planned

| ID | Feature | Status | Notes |
|---|---|---|---|
| N01 | Typed questions | NA | Removed in the redesign (`92d5e16`, 2026-11-12). |
| N02 | Quick-question buttons | NA | Removed in the redesign. |
| N03 | "What it sees now" findings panel and status list | NA | Removed in the redesign. The state is still exposed as `data-*` attributes for tests. |
| N04 | Smart-glasses camera source | NA | §7.5 |
| N05 | Currency, barcode and colour recognition, find-object mode | NA | Ideas only. |

---

## 5. Classification

Each feature row above is counted once, by its status column.

| Class | Count | Features |
|---|---|---|
| **TS** Implemented and tested in software | **48** | A02, A04–A11, B06–B08, B11, B16, C02–C04, C07, D02, D04, D07, D09, E04–E08, E10–E12, F02, G01, G04, G05, G07, G09, J01, J02, K01, K05, L01–L03, L05–L07, M01, M02 |
| **ND** Implemented, not tested on real devices | **35** | A01, A03, A12, B01–B05, B10, B12–B15, C05, C06, C08, D01, D03, D06, D08, E01, E09, F01, F03, F06, G02, G06, G08, I01–I04, K03, K04, L04 |
| **EX** Experimental | **9** | B09 (web search), B17 (two-frame motion), C01 (document reading), D05 (live answers filtered after the fact), E02 (tracker), E03 (cloud hazards), F04 (recording fallback), F05 (dead-service detection), G03 (unofficial Edge voice) |
| **NA** Unavailable or not implemented | **13** | C09, C10, I05, K02, M03–M06, N01–N05 |
| **Total** | **105** | |

"TS" never means tested on a device or with users (§6.4). Some TS features also have language-quality caveats that tests can't settle: the safety patterns (E07) and the live voice's accent (D04) are unreviewed by native speakers.

---|---|---|
| **TS** Implemented and tested in software | **33** | A02, A04–A11, B06–B08, B11, B16, C02–C04, C07, D02, D04, D07, D09, E04–E08, E10–E12, F02, G01, G04, G05, G07, G09, J01, J02, K01, K05, L01–L03, L05–L07, M01, M02 |
| **ND** Implemented, not tested on real devices | **33** | A01, A03, A12, B01–B05, B10, B12–B15, C05, C06, C08, D01, D03, D06, D08, E01, E09, F01, F03, F06, G02, G06, G08, I01–I04, K03, K04, L04 |
| **EX** Experimental | **13** | B09, B17, C01, D05, E02, E03, F04, F05, G03, and the cloud-hazard dependence of D06 is counted under E03. Also: A06's Nadhra side (counted in M01), web search (B09) |
| **NA** Unavailable or not implemented | **13** | C09, C10, I05, K02, M03, M04, M05, M06, N01–N05 |
| **Total** | **92** | |

(EX lists 9 IDs: B09, B17, C01, D05, E02, E03, F04, F05, G03. The remaining 4 experimental features are the language-quality items that cut across rows: Derja voice on non-Tunisian voices (G02), the live Derja accent (D04), the unreviewed safety patterns (E07) and the unmeasured image-quality thresholds (B12). They are also counted in their rows, so the row total is 79 plus these 13 cross-cutting entries.)

---

## 6. Test results

### 6.1 Run on 2026-11-15 (this audit)

| Suite | What it is | Result |
|---|---|---|
| `npm test` (26 files in `tests/`) | Node unit and integration tests: no network, no keys | **423/423** after the default-language change (422/422 before it). One launcher test (`tests/engines.test.ts`, "crash: an engine that exits by itself…") failed once under full-suite load, then passed 3/3 alone and in the full rerun. It is timing-sensitive. |
| `npx tsc --noEmit` | TypeScript | **No errors** |
| `npm run build` | Production build | **Succeeds** |
| `e2e/redesign.mjs` (with `AXE`) | Chromium, fake camera, `/api/vision` and `/api/tts` mocked in the browser | **76/76, twice** (and again twice after the default-language change), including the new action-button checks and axe (WCAG 2 A/AA + best practice, camera screen) with no violations |
| `e2e/nadhra/run.mjs` | Chromium against three `next start` servers, every outgoing server connection blocked and logged | **75/75** (and again after the default-language change) |
| Default-language check (one-off script, not in the repo) | Chromium, production build: a first visit with nothing saved opens in Derja (right to left); a saved English or French choice is kept; loading writes nothing to storage | **3/3** |

### 6.2 Recorded earlier (not re-run here)

| Suite | Result as recorded | Source |
|---|---|---|
| `e2e/read/run.ts` | Real Gemini, 16 rendered document cases: all pass (2026-11-13) | `docs/PHASE1_DOCUMENT_READER.md` |
| `e2e/read/browser.mjs` | Real Gemini, production build, Chromium: 13/13 (2026-11-13) | `docs/PHASE1_DOCUMENT_READER.md` |
| Round-4 real-Gemini runs | **Not completed:** free-tier quota ran out | `docs/PHASE1_ROUND4_REPORT.md` |
| Live latency (`e2e/live/latency.ts`) | Median 1.07 s on the developer's connection, occasionally 3 s | README "Known limits" |
| OCR benchmark | Paddle v5 86.6 % exact lines; Tesseract 77.7 %; 31 rendered mock cases | `bench/out/ocr-summary.md` |

### 6.3 Not run

- `e2e/vision.mjs`, the real-model camera suite: needs `photos/street.jpg` and `photos/person.jpg` (not in the repo) and Gemini quota.
- `e2e/live/browser.mjs` and the chat evaluations (`e2e/chat/`): real services and quota.

### 6.4 Real devices and people: none

| Test | Status |
|---|---|
| Android checklist (`docs/ANDROID_TESTING.md`) | **Never run** |
| Beta checklist (`docs/BETA_TEST_CHECKLIST.md`) | **Never run** |
| TalkBack / VoiceOver | **Never run** |
| Blind or low-vision testers | **Never** |
| Real-camera reading protocol (`docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md`) | Prepared, **never run** |
| Native-speaker review (Derja, Standard Arabic, French) | **Never** |
| Battery, heat, latency on a mobile network | **Never measured** |
| Hazard accuracy (stairs, kerbs, crossings) | **No labelled set exists** |

**Browser tests prove the software path, not real-world quality.** Fake cameras show synthetic noise, and fake microphones play files. Real light, motion, accents, noise, phone voices and TalkBack can all behave differently.

---

## 7. Limitations

### 7.1 Safety

- **Warnings are not instant.** On-device warnings need 3 sightings, about 1 s. Stairs and drops come only from the cloud, at least 4 s apart plus about 2–3 s of model time, and **not at all with automatic descriptions off** (the default) unless live is on. A fast car can arrive before any warning.
- **The on-device detector knows 14 common classes only.** No stairs, kerbs, holes, poles, wet floors or glass doors.
- **"Near" and "far" are judged from the picture.** No distances are ever given.
- **A person is never urgent** (E04). Untested with mobility trainers.
- **Live answers are filtered after they start playing** (D05).
- **Silence never means safe.** This is said in the notice, but the user still has to remember it.

### 7.2 Medicine reader

- Tested only on rendered mock documents, never on real boxes, bottles, blister packs or prescriptions, and never on a phone.
- Two models must agree and the pixel check must pass. Many readable lines are withheld (round 4: 37 of 116 lines in the worst cases, from one model's boxes).
- Handwritten doses are always withheld, by design.
- Images go to Google's free tier. Real prescriptions must not be used in testing (the notice says so).
- The Derja instruction glossary is off until a pharmacist approves it.

### 7.3 Privacy

- **Camera images go to Google Gemini** (or OpenRouter). On free tiers they may be kept, used to improve products, and seen by human reviewers. Bystanders appear in them. This is disclosed in the consent notice and the README.
- **Live conversation** streams the microphone and about one picture a second to Google, including the spoken stop words.
- **Speech recognition** in Chrome goes to Google. The recording fallback goes to Gemini.
- **The cloud voice** sends each sentence's text, never images, to an unofficial Microsoft endpoint.
- **Local storage** holds settings, including the emergency contact's name and number in plain text, plus the consent flags.
- **Logs** hold event names and short codes only. No images, audio, questions, answers or locations.
- **Location** is requested only when the Emergency page opens, and only goes into a text message the user sends.

### 7.4 Offline

- Already open: on-device warnings, earcons, settings and the Emergency page work. The voice needs an installed device voice. Questions, reading, descriptions, live and voice commands don't work, because recognition is an online service.
- Not open yet: the app can't be opened offline, since there is no service worker.
- Nadhra AI provides no offline ability yet beyond the on-device warnings (§4.13).

### 7.5 Smart-glasses roadmap

- **Today:** not supported and untested. The camera input is an interface (`CameraSource` in `cameraSource.ts`, registered in `createCameraSource`), so glasses that stream into a video element can reuse most of `WebcamSource`. A source without a video element turns the on-device detector off.
- **Offline track** (`docs/OFFLINE_ARCHITECTURE_PROPOSAL.md`, `docs/OFFLINE_PHASE2_REPORT.md`, `docs/NADHRA_AI_PROPOSAL.md`): six phases toward standalone ARM Linux glasses (audit → AI core interfaces → offline engines → routing → portability → benchmarks).
- **Done:** the audit; provider `locality`/`tasks` and `AI_MODE`; the Nadhra switch and refusals (N1); the engine manifest and launcher (N2); and Step 0, the OCR pair measured as local servers.
- **Not started:** connecting any real engine (N3, the OCR pair), local speech recognition, a local voice, a local language model, ARM testing, glasses hardware, spatial audio, and a wake word.

---

## 8. Contradictions found (README, manifest, defaults, code, docs)

| # | Where | What it says | What is true | Fixed here? |
|---|---|---|---|---|
| 1 | README "Using it" vs `settings.ts` | Derja is the default | The default was **English** (`375db18`) | **Resolved 2026-11-15:** the default is Derja again (`settings.ts`), matching the README and the manifest. Saved choices are kept (`tests/languages.test.ts`). |
| 2 | `src/app/manifest.ts` | `lang: "ar-TN"`; "answers spoken questions in Tunisian Arabic" | Consistent with the Derja default | Resolved by row 1 (manifest unchanged) |
| 3 | `layout.tsx` | `<html lang="en" dir="ltr">`, fixed | The `.app` element carries the chosen language's `lang` and `dir`, so the content is read in the right language. The document-level language (page title, anything outside `.app`) stays English whatever is chosen | **Open decision** (needs a small runtime change) |
| 4 | Comments in `settings.ts` (`language`) and `lang.ts` | "The interface stays in English" | The main screen follows the chosen language; the panels stay English | Corrected (comments only) |
| 5 | README action table | Buttons for Repeat, Stop talking, Help, Emergency assistance, "Ask by voice", "Start assistance / Stop camera", typed questions and quick-question buttons | Those buttons were removed (§4.14); the main screen has Open camera / Stop assistance and the five actions; Emergency is in Settings | README corrected |
| 6 | README | "The full list of voice commands is in Settings" | Settings has no list; Help (H, «شنوة نجم نقول؟») speaks it | README corrected |
| 7 | README Privacy | Consent can be withdrawn "in Settings or Privacy" | Only in Privacy & safety | README corrected |
| 8 | README Configuration | Missing `GEMINI_SEARCH_API_KEY`, `AI_MODE`, `NADHRA_AI_ENABLED`, `INTERNET_PROBE_URL` | They exist (`.env.example`) | README corrected |
| 9 | `docs/ARCHITECTURE.md` | Code map lists `src/components/Iris.tsx`; reading is "voice only, no button"; API list has three routes | `Iris.tsx` no longer exists; Read text is a button; there are seven routes | Corrected |
| 10 | `docs/ANDROID_TESTING.md`, `docs/BETA_TEST_CHECKLIST.md` | "Start assistance", "Stop camera", a header saying "Experimental test version", "Answer so far" and "from a web search" on screen, the voice name in Settings | The buttons are "Open camera" and "Stop assistance"; the other texts are no longer on screen | Corrected 2026-11-15, including checks for the five action buttons |
| 11 | `hazardTracker.ts` header comment | Tests in a separate tracker test file | That file doesn't exist; tracker tests are in `tests/visionClient.test.ts` | Corrected (comment only) |
| 12 | Settings vs storage | Text size menu goes to 175 % | Stored values up to 200 % are accepted (`sanitizeVisionSettings`) | No (harmless) |

---

## 9. Accessibility status

**In place:**
- **Native elements:** `dialog` (focus trap, Esc, focus return), `select`, `role="switch"` checkboxes, buttons named by their visible words, radio buttons for the AI switch.
- **Focus management:** Open camera has focus on load; Stop assistance gets it when the camera starts; consent focuses "I agree"; the Emergency page focuses its main action.
- **Essential actions as buttons again** (A03), so Describe, Read, Identify, Ask and Pause no longer depend on voice or keys.
- **Every state change** is spoken, with a tone and, where possible, a vibration.
- **Visual accessibility:** text scale up to 175 %, reduced motion, forced colours, 48 px or larger targets. The automated axe scan of the camera screen is clean.

**Gaps:**
1. **Not tested with TalkBack** or any real screen reader.
2. **Panels are English only** (Settings, Privacy & safety, Emergency, consent).
3. **No main-screen buttons** for Emergency, Repeat, Stop talking, Help or voice commands on/off. These are voice, keys, or Settings only.
4. **The page voice and TalkBack may overlap.** With echo on, sentences are heard twice.
5. **Audio and vibration need a first tap.**
6. **The "call" focus move** may not move TalkBack's focus.
7. **No audio onboarding.**
8. **The theme doesn't follow the OS,** and there is no high-contrast theme.

---

## 10. Remaining gaps, by priority

1. **Run the Android and TalkBack checklists with blind testers,** after updating them to the current screen (§8 row 10).
2. **Native-speaker review** of all phrases, commands and safety patterns in Derja, Standard Arabic and French.
3. **Real-camera reading session** with the printed synthetic kit, before any real medicine box.
4. **Hazard accuracy and latency** on real streets and mobile networks.
5. **Document language:** decide whether `<html lang>` should follow the chosen language (§8 row 3).
6. **Emergency reachable from the main screen** without voice, and spoken location status (I05).
7. **Localise the panels.**
8. **Privacy:** a paid tier that doesn't keep images before real users; a replacement for the unofficial Edge voice.
9. **Offline:** a service worker; then the first real Nadhra engine (N3, OCR pair), only with approval.
10. **Battery and heat** measured over 30 minutes on a mid-range Android phone.
