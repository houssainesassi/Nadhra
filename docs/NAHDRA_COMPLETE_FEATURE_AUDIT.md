# Nadhra (نظرة): complete feature audit

- **Scope:** the working tree of `/home/hello/Downloads/blind` on branch `mai`, on 2026-11-09. This includes 29 modified and 4 untracked files that are not committed yet (most of the multi-language work is in them).
- **Method:** I read every source file under `src/` (about 6,500 lines), the tests, the e2e script, the README, `docs/ARCHITECTURE.md` and `docs/ANDROID_TESTING.md`. I ran `npm test` once: **106 of 106 unit tests pass** (8 files, about 2 s, no network). I did not run the e2e suite. It needs photos that aren't in the repo and it uses real Gemini quota.
- **Read-only:** no code was changed. This file is the only addition.
- **References:** `path:line` refers to the current working tree.

> **Update, 2026-11-10 (Phase 1 safety fixes).** Seven defects in this audit are now fixed in code and covered by tests. See §0 below and `docs/NAHDRA_PRODUCTION_READINESS.md`. The rest of the audit still describes the code as it was on 2026-11-09. `controller.ts` line numbers have since moved by up to about 60 lines.

> **How to read the status labels.** "Fully implemented" means the code is complete and its behaviour doesn't depend on a device, a browser service or an AI model. It does **not** mean it was validated with blind users. Nothing in the repo records a session on a real Android phone or with a blind tester. `docs/ANDROID_TESTING.md` is a checklist with no results filled in.

---

## 0. Changes since the audit (2026-11-10)

| # | Audit finding | What changed | Verified by |
|---|---|---|---|
| 1 | Scans held back while any speech plays (F18, F25, §9.1) | `decideScan` no longer has a `speaking` input. During a reading, scans continue at the normal change-driven rate. Their warnings are spoken, and their description is dropped instead of being queued behind the reading. | unit (`controller.test.ts`, `visionClient.test.ts`) + Chromium e2e `readingInterruptedByWarning` (mocked API) |
| 2 | Caution warnings waited behind a whole reading (new finding) | New `warning` priority between `answer` and `urgent`. It cuts into a reading, never into an urgent warning, and expires after 8 s. | unit |
| 3 | An interrupted multi-part reading resumed out of order (new finding) | The interrupted part is re-queued before the rest of its reading, not after it. This affected urgent warnings too. | unit + e2e |
| 4 | Detector failure not spoken (F23, §7.4) | Load failure, a load that takes more than 20 s, and a crash while running are all spoken, with an error tone. Offline, the user hears "analysis down" instead of the offline notice that promises on-device warnings. The broken instance is dropped, so restarting the camera retries. | unit + e2e `detectorFailureSpoken` |
| 5 | "Stop listening" through Ask turned hands-free mode **on** (F36) | New `stopAssistant()`: `assistant-off` only ever turns the mode off. | unit (fails on the old code) |
| 6 | Camera not released when the page is only hidden (F62) | On `visibilitychange` → hidden: camera released, microphone aborted, speech stopped. On return: the user hears "the camera was off while you were away" and the camera restarts. A camera the user stopped stays off. | unit + e2e `hiddenReleasesCamera` (hidden state simulated) |
| 7 | (found while testing) "I didn't hear a question" spoken in the background after leaving the app | Not said while the page is hidden. | unit |

Supporting change: the React hook `useStore` moved to `src/lib/useStore.ts`, so `controller.ts` loads without React and can be unit-tested.

**Status changes:** F62 moves from PI to RD. Real Android behaviour is still unverified. The F36 defect is fixed.

**Still not verified:** none of this has run on a real Android phone or with a blind tester.

---

## 1. Executive summary

Nadhra is a **single-page web app** (Next.js 16, React 19). It turns a phone or laptop camera into a spoken assistant for blind and visually impaired people in Tunisia. It has two layers:

1. **A cloud layer (Google Gemini, with OpenRouter as a fallback).** It describes scenes, reads text, identifies products, answers free questions, and reports hazards a small model can't see, such as stairs and drops.
2. **An on-device layer (MediaPipe EfficientDet-Lite0).** It finds people, vehicles and a few furniture-type obstacles in under a second, sends nothing off the device, and keeps working offline.

Everything the app says goes through a priority speech queue. The voice is the browser's own, with Microsoft Edge's online neural voice as a fallback. The app speaks and listens in **Tunisian Arabic (Derja, the default), Modern Standard Arabic, French or English**. The **visible interface is English only.**

The safety design is the strongest part of the codebase:
- Code, not the prompt, enforces "no safety promises", "no distances", "no motion claims without a second frame" and "uncertain is never urgent".
- Warnings come from fixed templates whose wording states the confidence level.
- The user is told out loud when analysis is down.
- The Emergency page never dials or sends anything by itself.

**The main weaknesses:**
- **Latency.** Cloud hazards such as stairs arrive several seconds late. *(Fixed 2026-11-10: cloud scans used to be held back while the assistant was speaking.)*
- **No offline shell.** There is no service worker or manifest.
- **The UI is English only**, for an Arabic-speaking audience that uses screen readers.
- **Nothing has been tested on real devices or with real users.** That covers TalkBack, real speech, battery, real hazards and real Derja.
- **Unofficial services.** The Edge voice uses an unofficial endpoint, and the vision provider runs on a free tier that may keep images.

**Count:** 70 features found. Fully implemented 34, needs real-device testing 25, partially implemented 3, experimental 6, planned 1, broken or deprecated 1 (see §6).

---

## 2. Technical architecture

### 2.1 Components and how they talk

```
                   ┌──────────────────────── Browser (one page: src/app/page.tsx) ────────────────────────┐
 User ─ tap/keys ─▶│ Assistant.tsx (React UI) ──calls──▶ SmartVisionController (controller.ts, no React)     │
 User ─ voice ────▶│        ▲ useStore(store)                    │                                          │
                   │        └────────── state patches ───────────┤                                          │
                   │  CameraSource (cameraSource.ts) ─ video ─▶ LocalDetector (MediaPipe WASM, CPU)          │
                   │        │ thumbnail 160×120 every 0.5 s       └▶ HazardTracker ─▶ hazardUrgency/WarningGate │
                   │        │ frameAnalysis + scheduler ── decide ─▶ client.ts POST /api/vision ────────┐       │
                   │  VoiceInput: SpeechRecognition (Google, in Chrome) │ or RecorderInput ─▶ /api/vision/transcribe
                   │  SpeechQueue ─▶ HybridTts: speechSynthesis │ or CloudTts ─▶ POST /api/tts ──────────┐ │       │
                   │  Earcons (WebAudio) · navigator.vibrate · Wake Lock · Geolocation (Emergency only)  │ │       │
                   └────────────────────────────────────────────────────────────────────────────────────┼─┼───────┘
                   ┌──────────────────────── Next.js server (Node runtime, Vercel-ready) ───────────────┼─┼───────┐
                   │ /api/vision  → validate → ai/vision.ts provider chain → schema.ts sanitize ◀───────┘ │       │
                   │ /api/vision/transcribe → Gemini audio → parseTranscript                               │       │
                   │ /api/tts → edgeTts.ts WebSocket → speech.platform.bing.com (unofficial) ◀─────────────┘       │
                   └───────────────────────────────────────────────────────────────────────────────────────────────┘
                     Gemini (generativelanguage.googleapis.com), OpenRouter (free models only), Microsoft Edge TTS
```

- **UI ↔ controller.** `Assistant.tsx` creates one `SmartVisionController` (`src/components/Assistant.tsx:162`) and re-renders from its store (`src/lib/store.ts:29`). The controller owns every piece of state, including which panel is open (`controller.ts:42-43`), so voice commands can open and close panels.
- **Controller ↔ server.** JSON over `fetch`, in `src/lib/assistant/client.ts`. Client timeouts are 27 s for vision and 19 s for transcription (`client.ts:39-41`).
- **Server ↔ providers.** `src/lib/ai/vision.ts:48-110` (Gemini REST with `x-goog-api-key`, OpenRouter chat completions) and `src/lib/speech/edgeTts.ts:130` (WebSocket).
- **Shared code.** `types.ts`, `lang.ts`, `schema.ts`, `phrases.ts` and `prompts.ts` are pure modules used on both sides. The safety rules run on the server, inside `sanitizeAnalysis`.

### 2.2 Frontend

- One route only: `src/app/page.tsx` renders `<Assistant/>`. `layout.tsx` loads the Inter and IBM Plex Sans Arabic fonts. It also runs an inline script that applies the saved theme and text size before first paint (`src/app/layout.tsx:22`).
- Styling is Tailwind 4 plus `src/app/globals.css`, which holds design tokens, a reduced-motion rule (`globals.css:589`) and a forced-colors rule (`globals.css:598`).
- State is a minimal external store with `useSyncExternalStore`. The whole `Assistant` subscribes to the whole state, so **every patch re-renders the full page** (see §8).

### 2.3 Camera pipeline (`controller.ts`, `cameraSource.ts`, `camera.ts`)

1. `getUserMedia` asks for the back camera, 1280×720 at 15 fps, video only (`cameraSource.ts:44,61`, `camera.ts:25-28`). Errors map to `denied`, `not-found`, `busy`, `insecure`, `unsupported` or `unknown` (`camera.ts:17-37`).
2. **Every 500 ms** (`controller.ts:23,359`) it draws a 160×120 thumbnail and converts it to grey. It computes brightness, contrast and Laplacian sharpness (`frameAnalysis.ts:24-58`), and measures motion as the fraction of changed pixels.
3. **Every 1 s while online**, it encodes a 384 px JPEG "motion frame" and keeps the last 3 (`controller.ts:510-515`). One of them, 0.7–4 s old, is sent with a request as the only allowed evidence for motion (`controller.ts:560-563`).
4. `decideScan` decides whether to send a 768 px JPEG (`scheduler.ts:45-61`):
   - never more often than every 4 s
   - send when more than 8 % of pixels changed, when the detector found a new object, or on a heartbeat of 20 s that doubles up to 80 s while nothing changes
   - never send dark, overexposed or flat frames
   - wait up to 6 s for a sharp frame
   - ~~hold back while speech is playing~~ (removed 2026-11-10: speech never holds a scan back)
   - back off exponentially after failures, up to 60 s
5. Questions, Read, Identify and Describe capture a 1280 px JPEG at quality 0.82 (`controller.ts:26,706`).
6. A result whose frame is older than 12 s is dropped (`controller.ts:30,591`). Results from a stopped camera session are ignored through a `session` counter (`controller.ts:144,392`).

### 2.4 AI and Gemini integration (`src/lib/ai/vision.ts`, `prompts.ts`, `schema.ts`)

- **Provider chain.** It tries each model in `GEMINI_VISION_MODELS` (default `gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.5-flash`), then OpenRouter (`vision.ts:52,83-109`).
  - Each attempt has a 9 s timeout, with a 22 s total budget (`vision.ts:192-193`).
  - A 429 or 402 response puts that model on a 60 s cooldown (`vision.ts:160`).
  - Unusable JSON counts as a failure, so the next provider gets a chance (`vision.ts:196-197`).
- **Free tiers only, by design.** Gemini models matching `/pro/i` are refused (`vision.ts:64`). OpenRouter must be `openrouter/free` or end in `:free` (`ai/http.ts:21-23`, `vision.ts:91`).
- **Request settings.** Temperature 0.2. JSON response MIME type. 1,200 output tokens for scans and 2,500 for questions (`vision.ts:69,195`).
- **Prompts.** There is one system prompt per language (`prompts.ts:16-135`), covering truthfulness, position, people (no identification), confidence, motion and hazards, plus a strict JSON schema. There are separate rules for scan mode and question mode (`prompts.ts:140-153`). A user-text builder adds the camera direction, the age of the second frame, the last 4 spoken sentences and the last 3 Q&A pairs (`prompts.ts:154-175`).
- **Sanitizing** (`schema.ts:179-247`):
  - It clamps enums, lengths and list sizes.
  - It drops motion when there was no second frame.
  - It swaps sides for a webcam that faces the user.
  - It drops a "person, near" hazard when mirrored.
  - It removes sentences that promise safety or give distances.
  - It adds caveats.
  - For questions, it never returns an empty answer.
- I could not confirm that the configured model names exist. That depends on Google's catalogue, and I made no network calls.

### 2.5 Speech recognition (`voiceInput.ts`)

- **`RecognitionInput`** uses the browser's `SpeechRecognition` with the chosen language's tag: `ar-TN`, `ar-SA`, `fr-FR` or `en-US` (`lang.ts:25-30`). It runs one utterance per session, with no interim results (`voiceInput.ts:84-88`). In Chrome this audio goes to Google's online service.
- **`RecorderInput`** records with `MediaRecorder` and a simple voice-activity detector that follows the noise floor (`voiceInput.ts:188-221`):
  - gives up after 8 s with no speech
  - ends after 1.2 s of silence
  - stops at 12 s at most
  - ignores speech shorter than 350 ms
  - converts to a 16 kHz mono WAV and posts it to `/api/vision/transcribe`
  - Gemini first decides whether anyone is speaking, so silence doesn't become an invented "question" (`prompts.ts:177-197`, `schema.ts:27-30`).
- **Automatic fallback.** If recognition reports a service error, or ends instantly twice in a row, the app switches to recording for the rest of the session (`voiceInput.ts:64-65,107-109`, `controller.ts:1003-1020`).

### 2.6 Text-to-speech (`src/lib/speech/tts.ts`, `edgeTts.ts`, `speechQueue.ts`)

- **`HybridTts`** (`tts.ts:427-499`) uses the best installed browser voice for the language (`pickVoice`, `tts.ts:147-158`). When there is none, or it fails, it uses `CloudTts`, which posts each sentence to `/api/tts` and plays the MP3 through WebAudio.
- **The server** (`edgeTts.ts:236`) speaks Microsoft Edge's "Read aloud" WebSocket protocol, with a built-in client token and a computed `Sec-MS-GEC` token (`edgeDrm.ts:8,176`). Voices are fixed per language: `ar-TN-ReemNeural` (or `EDGE_TTS_VOICE`, female voices only), `ar-SA-ZariyahNeural`, `fr-FR-DeniseNeural` and `en-US-JennyNeural` (`lang.ts:33-37`). The client picks a language, never a voice name.
- **`SpeechQueue`** (`speechQueue.ts`) has four priorities: urgent, answer, status and narration. It handles pre-emption, resuming, a time-to-live per priority, de-duplication, a "hold" while the user talks, and a watchdog for engines that never report the end of a sentence (`speechQueue.ts:167`). Long text is split into chunks of 400 characters or less (`speechQueue.ts:34-50`).

### 2.7 Local processing

These run entirely on the device:
- MediaPipe detection on the main thread with the CPU delegate (`localDetector.ts:13-19`), throttled to at most 20 % duty cycle and one run per 250 ms (`controller.ts:138,689`)
- the hazard tracker
- urgency and the warning gate
- frame quality and change detection
- command parsing
- earcons and vibration
- settings storage

The WASM runtime and the `.tflite` model are copied into `public/mediapipe` on `npm install` (`scripts/copy-mediapipe.mjs`) and served by the app with a 7-day cache (`next.config.ts:18`).

### 2.8 Backend and API routes

| Route | Method | Purpose | Guards |
|---|---|---|---|
| `/api/vision` | GET | Status: available, provider labels, `canTranscribe` (`route.ts:34-36`) | none |
| `/api/vision` | POST | One frame (+ optional older frame) → sanitized `SceneAnalysis` | same-origin, 3 MB body, base64 JPEG magic bytes, 300-char question, 40 req/min/IP, 503 `not-configured` (`src/app/api/vision/route.ts:13-83`) |
| `/api/vision/transcribe` | POST | WAV → text | same-origin, 700 KB, `RIFF` header, 20 req/min/IP (`transcribe/route.ts:11-30`) |
| `/api/tts` | GET/POST | Voice status / one sentence → MP3 | same-origin, 4 KB body, 500 chars, 30 req/min/IP, upstream cooldown after 3 failures, one retry on refused handshake (`edgeTts.ts:236-293`) |

The logs hold provider ids and HTTP status only, never content (`route.ts:86-90`, `edgeTts.ts` "never logs the sentence").

### 2.9 Permissions and security

- **Headers** (`next.config.ts:3-11`): `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, and `Permissions-Policy: camera=(self), microphone=(self), geolocation=(self)`.
- **Keys** are only read on the server (`vision.ts:49,53`). The `server-only` import guards keep server modules out of the browser bundle.
- **The same-origin check allows requests with no `Origin` header** (`server/http.ts:41-50`), so scripts such as curl can use the API, limited only by an in-memory, per-instance rate limit. There is no authentication.

### 2.10 Performance and battery

- Measures in place: the frame budget, change-driven sending, a heartbeat that slows to 80 s, no sending offline, while paused or while hidden, and a recognition loop that sleeps when offline (`controller.ts:922-925`).
- Running costs that remain: a thumbnail `getImageData` every 500 ms, a 384 px JPEG encode every 1 s even when nothing is sent (`controller.ts:511-515`), MediaPipe up to 4 times a second, the screen wake lock, and a recognition session restarting every few seconds in hands-free mode.
- No battery measurement exists in the repo. Only a checklist line asks for one (`ANDROID_TESTING.md` §9).

### 2.11 Android compatibility

- It targets Chrome on Android over HTTPS, or `localhost` through `adb reverse` (README "Supervised Android test build").
- Covered for Android: `playsInline`, the back camera through `facingMode: environment`, `navigator.vibrate`, the Wake Lock API, `tel:` and `sms:` links, and voices that load asynchronously (`tts.ts:76-80`).
- iOS-specific handling also exists: the WebAudio unlock with a silent buffer (`tts.ts:289-300`).
- It is not a PWA and not a native app: there is no manifest, no service worker and no install prompt.

### 2.12 Deployment

- It is designed for Vercel, either through `npx vercel deploy` previews behind Vercel Authentication or a normal project. It needs the Node runtime, because the Edge TTS route uses Node ≥ 22's global WebSocket with custom headers (`edgeTts.ts:106-112`).
- `maxDuration` is 30 s for vision and TTS, and 20 s for transcription.
- Rate limits and cooldowns are in memory, so each serverless instance has its own.

---

## 3. Complete feature inventory

Status legend: **FI** fully implemented · **RD** implemented, needs real-device testing · **PI** partially implemented · **EX** experimental · **PL** planned, not implemented · **BR** broken or deprecated.
The languages column refers to the spoken output. "4" means Derja, MSA, French and English. Every visible label is English.

| ID | Feature | Runs | Internet | Lang | Status |
|---|---|---|---|---|---|
| **Main screen** |||||
| F01 | Start / stop assistance (camera) | Local | No (yes for descriptions) | 4 | RD |
| F02 | Consent gate (dialog + spoken + "I agree" by voice) | Local | No | 4 | FI |
| F03 | Privacy panel | Local | Status fetch | EN | FI |
| F04 | "Last said" caption and "I heard" transcript | Local | No | 4 | FI |
| F05 | State emblem (Iris) and status list | Local | No | EN | FI |
| F06 | Experimental-version disclaimer (screen + spoken once) | Local | No | 4 | FI |
| F07 | "What it sees now" findings panel | Local | No | 4 + EN | FI |
| **Vision and AI** |||||
| F08 | Automatic surroundings narration | Cloud AI | Yes | 4 | RD |
| F09 | Describe surroundings | Cloud AI | Yes | 4 | RD |
| F10 | Read text (OCR) | Cloud AI | Yes | 4 + any script read | RD |
| F11 | Identify object / product | Cloud AI | Yes | 4 | RD |
| F12 | "What's in front of me" | Cloud AI | Yes | 4 | RD |
| F13 | Typed questions | Cloud AI | Yes | Any in, 4 out | FI |
| F14 | Quick-question buttons (6) | Cloud AI | Yes | 4 | FI |
| F15 | Follow-up memory (last 3 Q&A) | Cloud AI | Yes | 4 | FI |
| F16 | Actions start the camera first | Local | No | 4 | FI |
| F17 | Image-quality gate and spoken notices | Local | No | 4 | RD |
| F18 | Change-driven frame scheduler | Local | n/a | n/a | FI |
| F19 | Motion evidence from a second frame (cloud) | Cloud AI | Yes | n/a | EX |
| F20 | Left/right correction and camera-direction setting | Local + server | No | 4 | RD |
| F21 | Switch camera | Local | No | n/a | RD |
| F22 | Camera-lost detection | Local | No | 4 | RD |
| **Safety** |||||
| F23 | On-device detection (14 object classes) | Local AI | No | 4 | RD |
| F24 | On-device tracker: persistence and "approaching" | Local | No | 4 | EX |
| F25 | Cloud hazards: stairs, drops, vehicles, obstacles, people | Cloud AI | Yes | 4 | EX |
| F26 | Urgency computed in code | Local | No | n/a | FI |
| F27 | Templated warnings worded by confidence | Local | No | 4 | FI |
| F28 | Warning de-duplication and escalation gate | Local | No | n/a | FI |
| F29 | Safety-language filter (no promises, no distances) | Server | n/a | 4 | FI |
| F30 | "Doesn't mean it's safe" and path-question caveats | Server | n/a | 4 | FI |
| F31 | Urgent alert feedback (tone, vibration, red display, `role=alert`) | Local | No | 4 | RD |
| F32 | Service-down / not-configured / rate-limit announcements | Local | n/a | 4 | FI |
| F33 | Stale-result discard and session guard | Local | n/a | n/a | FI |
| **Voice input** |||||
| F34 | Hands-free voice commands mode | Browser service | Yes | 4 | RD |
| F35 | Ask by voice (push-to-talk) | Browser service | Yes | 4 | RD |
| F36 | Voice-command parser (21 commands × 4 languages) | Local | No | 4 | FI |
| F37 | Recording fallback + Gemini transcription | Cloud AI | Yes | 4 | EX |
| F38 | Dead-speech-service detection and auto-switch | Local | n/a | n/a | EX |
| F39 | Turn-taking (hold speech while the user talks) | Local | n/a | n/a | RD |
| **Speech output and feedback** |||||
| F40 | Priority speech queue | Local | No | 4 | FI |
| F41 | Hybrid TTS (browser voice → cloud voice) | Local / cloud | Partly | 4 | RD |
| F42 | Edge neural voice proxy (`/api/tts`) | Cloud (unofficial) | Yes | 4 | EX |
| F43 | Repeat, Stop talking, Help, Go back / cancel | Local | No | 4 | FI |
| F44 | Earcons (6 tones) | Local | No | n/a | RD |
| F45 | Haptics (5 vibration patterns) | Local | No | n/a | RD |
| F46 | "Still running" tone after 45 s of silence | Local | No | n/a | FI |
| F47 | Screen-reader echo and automatic fallback when the voice fails | Local | No | 4 | RD |
| **Languages** |||||
| F48 | Four speech languages | Mixed | n/a | 4 | RD |
| F49 | Switch language by voice or in Settings | Local | No | 4 | FI |
| **Emergency** |||||
| F50 | Emergency page (button or voice, spoken summary, focus on the action) | Local | No | 4 | RD |
| F51 | Call the emergency contact (`tel:`; voice selects the button) | Phone app | Phone network | 4 | RD |
| F52 | Text my location (`sms:` + Google Maps link, one GPS fix) | Local + GPS | No (SMS) | 4 | RD |
| F53 | Tunisian emergency numbers 190 / 197 / 198 | Phone app | Phone network | EN labels | RD |
| **Settings** |||||
| F54 | Speech speed and volume (menus + "louder/faster" by voice) | Local | No | 4 | FI |
| F55 | Text size and light/dark theme | Local | No | EN | FI |
| F56 | Narration and vibration toggles | Local | No | EN | FI |
| F57 | Emergency contact storage | Local | No | EN | FI |
| F58 | Settings persistence and validation | Local | No | n/a | FI |
| F59 | Keyboard shortcuts (physical keys) | Local | No | n/a | FI |
| **Connectivity, power, platform** |||||
| F60 | Offline detection and degraded mode | Local | n/a | 4 | PI |
| F61 | Screen wake lock | Local | No | n/a | RD |
| F62 | Hidden-page handling and resource release | Local | No | n/a | PI |
| F63 | Detector CPU duty-cycle budget | Local | No | n/a | FI |
| **Backend** |||||
| F64 | Vision API with input validation | Server | Yes | 4 | FI |
| F65 | Provider fallback chain, cooldowns, free-only guard | Server | Yes | n/a | FI |
| F66 | Rate limiting and same-origin check | Server | n/a | n/a | PI |
| F67 | Security headers and Permissions-Policy | Server | n/a | n/a | FI |
| F68 | Status endpoint and disclosure of who receives images | Server | Yes | EN | FI |
| **Not yet built / leftovers** |||||
| F69 | Smart-glasses camera source | — | — | — | PL |
| F70 | Spoken location status on the Emergency page (phrases exist, never wired) | — | — | — | BR |

**Features that don't appear on the main screen:** the consent dialog (F02), the voice-command parser (F36) and every voice-only command (louder, quieter, faster, slower, speak X, call, back, yes), the recording fallback (F37/F38), the on-device tracker (F24), the code safety filter (F29/F30), the "still running" tone (F46), the wake lock (F61), hidden-page pausing (F62), the frame scheduler (F18), the provider chain (F65), and the switch-camera button. That last one only appears in Settings while the camera is on and the device has more than one camera (`Assistant.tsx:508-510`).

---

## 4. Feature-by-feature details

Each entry gives: what it does · how it's activated · how it works · AI or local / internet · languages · status · known limits. "4 langs" = Derja, MSA, French, English.

### Main screen

#### F01 · Start / stop assistance
- **What:** turns the camera on and starts watching. Turning it off releases the camera.
- **Activate:** the "Start assistance" / "Stop camera" button, which has focus when the page opens (`Assistant.tsx:178,314-324`), the `C` key, or voice («شعّل الكاميرا», "Open camera", «سكّر الكاميرا»).
- **How:** `startCamera` checks consent, opens the camera, then starts the 500 ms tick, the detector and the wake lock, and speaks "camera on" with a tone and a vibration (`controller.ts:317-365`). `releaseCamera` stops the tracks, timers and requests (`controller.ts:391-409`).
- **AI/Internet:** local. Descriptions need the internet.
- **Langs:** 4 spoken; on-screen error text in English (`Assistant.tsx:69-77`).
- **Status:** RD. Android camera release and the system's green indicator are untested.
- **Limits:** the camera isn't released when the page is only hidden (see F62). Starting by voice relies on hands-free mode already running, which works without the camera.

#### F02 · Consent gate
- **What:** before the first camera start, a modal says images go to an external AI service and names it. The same notice is spoken.
- **Activate:** automatic on the first start. Answer with "I agree" / "I don't agree", Esc (= decline, `Assistant.tsx:592`), or by saying «موافق», "I agree" (`commands.ts:80-85`, `controller.ts:1071-1075`).
- **How:** a flag in `localStorage` (`assistant.consent.v1`, `settings.ts:66,82-95`). The provider names come from `GET /api/vision`.
- **AI/Internet:** local.
- **Langs:** dialog in English, spoken in 4 langs.
- **Status:** FI (covered by the `consentAndPrivacy` e2e scenario).
- **Limits:** **consent can't be withdrawn in the UI.** `setConsent(false)` is never called (`grep` finds only `setConsent(true)` at `controller.ts:369`). Consent is stored for good. It is also not tied to a provider: if the provider list changes, nobody is asked again.

#### F03 · Privacy panel
- **What:** the same seven privacy statements, available at any time (`Assistant.tsx:549-551,689-705`).
- **Activate:** the "Privacy" button in the header.
- **Status:** FI.
- **Limits:** English only. On mobile the button's visible label is hidden; it is still in the accessible name through `sr-only` (`Assistant.tsx:274`).

#### F04 · "Last said" caption and "I heard"
- **What:** shows the last spoken sentence in large type, with the right `lang` and `dir`. An urgent warning stays on screen for 5 s (`Assistant.tsx:119,143-156,298-307`). "I heard «…»" shows what recognition produced.
- **Status:** FI.
- **Limits:** none significant. Testers rely on it for the reports the checklist asks for.

#### F05 · State emblem and status list
- **What:** an animated iris (idle, watching, thinking, listening, speaking, urgent), hidden from screen readers. A status list shows camera, microphone, analysis, on-device detection, language, internet, voice, and "Service" when the key is missing (`Assistant.tsx:121-128,416-425`).
- **Status:** FI.
- **Limits:** status changes aren't announced through a live region. That's acceptable, because the controller speaks state changes.

#### F06 · Experimental disclaimer
- **What:** an on-screen paragraph (`Assistant.tsx:382-384`). The same notice is spoken once per page load, right after the first description or 20 s after the camera starts (`controller.ts:36,227-230,354,448-452,493`).
- **Status:** FI.
- **Limits:** `spokeDisclaimer` is never reset, so it isn't repeated after restarting the camera. That is probably intended.

#### F07 · "What it sees now"
- **What:** lists the place (with confidence), the on-device detections, the cloud detections and readable text (`Assistant.tsx:455-478`).
- **Status:** FI.
- **Limits:** a mix of languages, with labels in the speech language and side and confidence words in English. Not announced; the user has to navigate to it.

### Vision and AI

#### F08 · Automatic surroundings narration
- **What:** speaks a short description (2 sentences or fewer, about 20 words) when the scene changes.
- **Activate:** automatic while the camera is on. It can be turned off in Settings ("Describe my surroundings automatically", `Assistant.tsx:505`).
- **How:**
  - The scheduler sends a scan, and the model returns `spoken` and `changed` (`prompts.ts:140-144`).
  - The text is spoken at `narration` priority only if `changed` is true, narration is on, and it's less than 60 % similar to the last 4 sentences (`controller.ts:637-639`, `speechQueue.ts:188-198`).
  - Turning narration off still sends scans, so cloud hazards keep working.
- **AI/Internet:** Gemini, internet required.
- **Langs:** 4.
- **Status:** RD.
- **Limits:**
  - Roughly 2–3 s of latency, plus a minimum interval of 4 s.
  - Narration is dropped after 15 s in the queue (`speechQueue.ts:68`).
  - No scan is sent while any speech plays (`scheduler.ts:57`).
  - The descriptions' quality in real places is unmeasured.

#### F09 / F10 / F11 / F12 · Describe, Read text, Identify, What's in front of me
- **What:** each sends a fixed question with a 1280 px frame (`phrases.ts` `ask.*`, e.g. `phrases.ts:56-61`).
  - **Read** asks for the text word for word, in its original language, and to say when part is unreadable (`prompts.ts:148`).
  - **Identify** asks for the product, the brand, and label text such as expiry date, dosage and warnings, and to suggest turning the object if the label can't be read (`prompts.ts:150`).
- **Activate:**
  - buttons (Describe / Read / Identify), keys `D` / `T` / `I`
  - voice: «وصفلي البلاصة», «اقرالي الكتابة», «شنوة هاذي؟», «شنوة قدّامي؟» and the equivalents in the other languages (`commands.ts:98-122`)
  - "What's in front of me?" is a quick-question button and a voice command. It has no key.
- **How:** `runTask` → `ask` (`controller.ts:764-776,696-748`). Speaks "One moment" first, cancels any running scan, and speaks the answer at `answer` priority. Only urgent hazards are spoken during a question (`controller.ts:632,646`).
- **AI/Internet:** Gemini, internet required. **There is no on-device OCR**, so reading doesn't work offline.
- **Langs:** the answer is in the speech language. Text read from the scene stays in its original language and script.
- **Status:** RD.
- **Limits:**
  - Long readings are capped at 1,800 characters (`schema.ts:11`) and split into chunks of 400 or fewer.
  - Large documents get truncated.
  - There is no guidance to help frame the page (no "move left" or "too close").
  - Medicine and expiry details come straight from a free-tier model with no independent check, which is a real risk for dosages.

#### F13 · Typed questions
- **What:** a text field (300 characters) with Send (`Assistant.tsx:430-444`).
- **Status:** FI. The logic is a thin layer over `ask`.
- **Limits:** needs the camera on, otherwise it says "camera needed" (`controller.ts:701-705`). Unlike the main actions, it doesn't start the camera itself.

#### F14 · Quick-question buttons
- **What:** six preset questions (`Assistant.tsx:42-49`). In Derja or MSA mode they send the Derja text; in French or English mode, the English label (`Assistant.tsx:447`).
- **Status:** FI.
- **Limits:** the labels are English only.

#### F15 · Follow-up memory
- **What:** the last 3 question-and-answer pairs go with each question (`controller.ts:733,738`, `route.ts:64-69`), so «إيه، اقراها» ("yes, read it") works.
- **Status:** FI.
- **Limits:** cleared on language change. Sent to the provider on every question.

#### F16 · Actions start the camera first
- **What:** Describe, Read, Identify and "front", used while the camera is off, start it (with consent if needed), wait up to 4 s for a frame, then ask (`controller.ts:764-776,362-364`).
- **Status:** FI (exercised in the e2e `fullPipeline` scenario).
- **Limits:** if consent is declined, the pending task is dropped (`controller.ts:376`). That's correct.

#### F17 · Image-quality gate
- **What:** no frame is sent while the image is dark (mean < 30), overexposed (> 245) or flat (contrast < 7). Blurred frames wait up to 6 s (`frameAnalysis.ts:51-59`, `scheduler.ts:50-54`). After 2 s of a poor image it says "too dark" or "camera may be covered". It says "image clear again" when that recovers (`controller.ts:542-558`).
- **Status:** RD. The thresholds were tuned on synthetic frames.
- **Limits:** the "bright" state is spoken with the "obstructed" sentence (`controller.ts:556`), which may confuse someone facing a window.

#### F18 · Change-driven frame scheduler
- **What:** see §2.3. It balances latency, the free-tier quota (about 15 requests a minute) and battery.
- **Status:** FI (`tests/visionClient.test.ts`, scheduler tests).
- **Limits:** ~~scans are skipped while speech plays~~ Fixed 2026-11-10. Scans still don't run while a question is waiting for its answer (up to 27 s). The question's own frame does return urgent hazards.

#### F19 · Motion evidence from a second frame
- **What:** a smaller frame from 0.7–4 s earlier is sent. The model may only report "approaching" or "moving away" when that frame was present; otherwise the server forces "unknown" (`schema.ts:187`, `vision.ts:175`).
- **Status:** EX. It depends on the model comparing two images reliably, which isn't measured.
- **Limits:** costs one extra JPEG encode a second, plus upload bandwidth.

#### F20 · Left/right correction
- **What:** the setting "Where does the camera point?" offers Automatic, Ahead of me or At me (`Assistant.tsx:496-500`).
  - Automatic treats a camera that reports `environment` as outward, and anything else as a mirror (`controller.ts:424-429`).
  - In mirror mode, the server swaps sides in the data, in the question going in and in the answer coming out, and leaves quoted scene text alone (`vision.ts:178`, `schema.ts:127-152,181-186`).
  - The on-device tracker mirrors too (`hazardTracker.ts:75-80`).
- **Status:** RD. Android phones may not report `facingMode`, and "unknown" falls back to mirror mode, which is **wrong for a phone's back camera**.
- **Limits:** swapping side words in Arabic uses plain substring replacement of يمين/يسار/شمال (`schema.ts:142`), which could hit compound words. In mirror mode, all on-device obstacles and near people are dropped (`hazardTracker.ts:151-154`).

#### F21 · Switch camera
- **What:** switches between the front and back camera (`cameraSource.ts:121-128`, `controller.ts:411-422`).
- **Activate:** a Settings button, shown only with more than one camera while the camera is on.
- **Status:** RD.
- **Limits:** no voice command. It doesn't say which camera is now active.

#### F22 · Camera-lost detection
- **What:** if the track ends on its own (unplugged, permission revoked), the app says so at urgent priority with an error tone (`controller.ts:340-345`).
- **Status:** RD.

### Safety

#### F23 · On-device detection
- **What:** MediaPipe EfficientDet-Lite0 (COCO). Of its classes, 14 are used: person, car, motorcycle, bicycle, bus, truck, train, chair, bench, couch, dining table, potted plant, suitcase and fire hydrant (`hazardTracker.ts:25-40`).
- **Activate:** loads automatically with the camera (`controller.ts:659-692`).
- **How:**
  - Runs on the CPU in VIDEO mode, with a score threshold of 0.4 and at most 12 results (`localDetector.ts:13-19`).
  - Results go into the tracker, then into urgency and the gate, and are spoken.
  - New objects also trigger a cloud scan (`controller.ts:680`, `scheduler.ts:56`).
- **AI/Internet:** local ML, **no internet** once the files are loaded.
- **Langs:** 4 (`phrases.ts:389-404`).
- **Status:** RD.
- **Limits:**
  - **It doesn't detect stairs, kerbs, holes, poles, walls, doors or glass.**
  - ~~The page doesn't speak a load failure.~~ Fixed 2026-11-10: load failure, a 20 s load timeout and a crash while running are spoken.
  - Runs on the main thread.

#### F24 · Tracker: persistence and "approaching"
- **What:**
  - An object must be seen 3 times before it is reported, and counts as "confirmed" after 5 sightings with a mean score of 0.7 or more.
  - A track expires after 1.5 s without a sighting.
  - It is "approaching" when its size grows 15 % or more over at least 1 s and 4 samples, while the camera is steady (less than 35 % of pixels changed) (`hazardTracker.ts:42-49,95-105`, `controller.ts:31,679`).
  - Proximity is guessed from the box size; obstacles count as "near" only when they reach the bottom 15 % of the frame (`hazardTracker.ts:82-93`).
- **Status:** EX. The heuristics haven't been calibrated in real streets.
- **Limits:**
  - Someone walking with the phone moves the camera all the time, so "approaching" will mostly be "unknown".
  - Box-size proximity varies with each object's real size.

#### F25 · Cloud hazards
- **What:** the model lists stairs, drops (a change of floor level), vehicles, obstacles and approaching people (`prompts.ts:121`). These are the only source of **stairs and drop** warnings.
- **Status:** EX. Recall, false-alarm rate and latency on real stairs are unknown.
- **Limits:**
  - Latency is the 4 s minimum interval plus about 2–3 s for the model.
  - ~~Paused while speech plays~~ (fixed 2026-11-10).
  - No warnings at all offline or while the service is down. The user is told in that case (F32).

#### F26 · Urgency computed in code
- **What:** `hazardUrgency` (`hazards.ts:10-27`):
  - Uncertain is never urgent.
  - Far and not approaching is only "info", and "info" is never spoken.
  - Stairs or a drop is urgent when near or straight ahead.
  - A vehicle is urgent when near or approaching.
  - An obstacle is urgent only when near and straight ahead.
  - **A person is at most "caution"**.
- **Status:** FI (`tests/visionSchema.test.ts` "urgency needs evidence").
- **Limits:** a person rushing straight at the user is never urgent, by design. Worth reviewing with mobility trainers.

#### F27 · Templated warnings worded by confidence
- **What:** `warningPhrase` writes every warning from validated fields: "There may be … but I'm not sure" for uncertain, "there seems to be" for likely, and firm wording for confirmed. It has Derja gender agreement for "coming" (`phrases.ts:327-387`).
- **Status:** FI (`tests/languages.test.ts`).
- **Limits:** the model's `label` is put into the template as is, so a long or odd label reads badly. The wording hasn't been reviewed by native speakers (README "Known limits").

#### F28 · Warning gate
- **What:** the same `kind:side` isn't repeated within 15 s (urgent) or 45 s (caution). It passes at once when urgency rises, or when "approaching" is added (`hazards.ts:32-53`).
- **Status:** FI.
- **Limits:** two different obstacles on the same side share a key (`hazards.ts:42`), so a second one can be held back for up to 45 s.

#### F29 · Safety-language filter
- **What:** `guardSpoken` removes any sentence that promises safety ("safe", "clear path", «آمن», «sans danger»…) or gives a distance ("3 m", «مترين», "two meters"…) in all 4 languages. It keeps honest doubt and sentences that quote text read from the scene (`schema.ts:47-125`).
- **Status:** FI (about 30 assertions across `visionSchema` and `languages` tests).
- **Limits:**
  - It is a regex blocklist, so new wordings get through. Examples: "go ahead", "the coast is clear", «الطريق ما فيهاش حتى حاجة».
  - A safe-sounding sentence that happens to contain a quoted sign is kept.

#### F30 · Safety caveats
- **What:** a sentence that says nothing is ahead always gets "that doesn't mean it's safe" (`schema.ts:90-105,230`). Questions about a path or crossing always end with "I can't confirm the way is safe, keep checking with your cane" (`schema.ts:154-159,232-235`).
- **Status:** FI.
- **Limits:** depends on regex detection of path questions. Wording outside the list gets no caveat.

#### F31 · Urgent alert feedback
- **What:**
  - three high tones, played at 80 % volume or more (`earcons.ts:8,33`)
  - a 200-100-200-100-200 ms vibration (`controller.ts:53`)
  - interrupts all other speech
  - red caption and stage for 5 s
  - `role="alert"` when screen-reader echo is on (`Assistant.tsx:286`)
- **Status:** RD.
- **Limits:**
  - Android Chrome may block `navigator.vibrate` without a recent user gesture.
  - The tone needs the AudioContext unlocked by a tap first (`earcons.ts:17-25`).
  - If the only voice is the cloud voice, an urgent warning needs a server round trip before it plays.

#### F32 · Failure announcements
- **What:**
  - After 2 failed scans in a row: "Analysis is stopped, don't rely on me", with an error tone (`controller.ts:621-627`). "Analysis is back" when it recovers.
  - A missing key: "service not enabled", and a 5-minute backoff.
  - Rate limits: "too many requests" for questions.
- **Status:** FI (e2e `aiFailure`, mocked).
- **Limits:** during the first failure (up to about 27 s with the client timeout), the user hears nothing.

#### F33 · Stale-result discard and session guard
- **What:** results older than 12 s, or from an earlier camera session, are dropped (`controller.ts:586,591`).
- **Status:** FI.

### Voice input

#### F34 · Hands-free voice commands
- **What:** an endless listen → command or question → listen loop.
- **Activate:** the "Voice commands" toggle (`aria-pressed`), the `V` key, or «سكّر الميكرو» / "Stop listening" to turn it off.
- **How:**
  - `assistantLoop` waits while speech plays, while a question is running, while hidden or while offline, then listens once (`controller.ts:915-929`).
  - When the assistant starts speaking, the microphone is aborted, so it doesn't hear itself (`controller.ts:222`).
  - Anything that isn't a command goes to the model as a question (`controller.ts:1039-1046`).
- **AI/Internet:** the browser's speech service (Google in Chrome). Internet required. **Doesn't work offline.**
- **Langs:** recognition in the chosen language; commands in all 4.
- **Status:** RD. Real voices, accents, noise, TalkBack interplay and battery are all untested.
- **Limits:**
  - Every phrase overheard nearby becomes a question, with an image and quota (README).
  - On Android, every recognition restart can beep.
  - Single-word commands such as "stop", "back", "call", "cancel", "pardon", «يزي» or «اطلب» can fire from overheard speech. "call" or «اطلب» alone opens the Emergency page and asks for location (`commands.ts:129-134`, `controller.ts:826`).

#### F35 · Ask by voice (push-to-talk)
- **What:** listens for one question. Routine speech is held until it's done (`controller.ts:932-993`). Pressing again sends it ("Done, send question", `Assistant.tsx:354`).
- **Activate:** the "Ask by voice" button, or the `Q` key.
- **Status:** RD.
- **Limits:** with hands-free mode on, it only stops speech and makes room (`controller.ts:938-939`).

#### F36 · Voice-command parser
- **What:** 21 commands, each with Derja, MSA, French and English phrases (`commands.ts:36-144`):
  - stop-speech, repeat, pause, resume
  - camera-on, camera-off, assistant-off
  - yes, help, back
  - front, describe, read, identify
  - emergency, call
  - louder, quieter, faster, slower
  - lang-tn / ar / fr / en
- **How:**
  - The whole utterance must match exactly, after Arabic and Latin normalisation.
  - Courtesy words around it are dropped first ("please", «يعيشك», "nadhra"…) (`commands.ts:149-168`).
  - "Pause" requires two words, so the everyday word "wait" can't turn off warnings (`commands.ts:49-55`).
  - Language switches require "speak X" (`commands.ts:139`).
- **Status:** FI (tests check that every command in the spoken help works, and that everyday words don't trigger anything harmful).
- **Limits / bug:** ~~"Stop listening" said through push-to-talk while hands-free mode is off turns hands-free mode ON.~~ Fixed 2026-11-10 (`stopAssistant()`, regression tests in `tests/controller.test.ts`).

#### F37 · Recording fallback + Gemini transcription
- **What:** for browsers without a working recognition service (Firefox, Brave, some Chromium builds), the audio is recorded and transcribed by Gemini (`voiceInput.ts:135-221`, `transcribe/route.ts`, `vision.ts:205-209`).
- **Status:** EX. Transcription quality for Derja is unknown.
- **Limits:** adds 1–3 s or more. Uses quota. The audio leaves the device for Google.

#### F38 · Dead-speech-service detection
- **What:** two recognition sessions in a row that end in under 1 s with no result mean the service is missing. The app announces it and switches to recording (`voiceInput.ts:64-65,107-109`, `controller.ts:1003-1020`).
- **Status:** EX (a heuristic, tested in e2e `deadSpeechService` on desktop Chromium only).

#### F39 · Turn-taking
- **What:** while the user is talking, or after Ask, only urgent warnings play (`speechQueue.ts:109-112,148`, `controller.ts:958-966`).
- **Status:** RD.
- **Limits:** relies on `onspeechstart`/`onspeechend`, which Android may not fire reliably.

### Speech output and feedback

#### F40 · Priority speech queue
- **What:** four priorities with pre-emption, resuming, a time-to-live, de-duplication, a watchdog and chunking (`speechQueue.ts`). Since 2026-11-10 there are five: `warning` (caution hazards) sits between answer and urgent.
- **Status:** FI (10 tests).
- **Limits:** a stale urgent warning (over 6 s in the queue) is dropped silently. That is correct for safety, but no tone marks it.

#### F41 · Hybrid TTS
- **What:** browser voice first. Prefers an exact `ar-TN` voice for Derja, then other Arabic voices (`lang.ts:26`), and prefers installed voices when offline (`tts.ts:147-158`). Falls back to the cloud voice.
- **Status:** RD.
- **Limits:**
  - On most Android phones Derja will be read by an MSA or Gulf voice. The UI says "(Arabic, not Tunisian)" (`Assistant.tsx:251-255`).
  - The cloud error messages are in Arabic only and never shown (`tts.ts:167-175`).

#### F42 · Edge neural voice proxy
- **What:** server-side WebSocket to Microsoft's Edge "Read aloud" endpoint, giving an MP3 (`edgeTts.ts`).
- **Status:** EX. It is an **unofficial, undocumented endpoint** with a hard-coded client token (`edgeDrm.ts:8`). Microsoft may block it, and its terms are unclear.
- **Limits:** 500 characters per sentence. Per-instance rate limit. Can be turned off with `EDGE_TTS_DISABLED`.

#### F43 · Repeat, Stop talking, Help, Go back / cancel
- **What:**
  - **Repeat** says the last sentence again (`controller.ts:755-759`).
  - **Stop talking** clears the queue.
  - **Help** speaks the list of commands (`phrases.ts:38`).
  - **Go back** closes the open panel, or cancels the running question and the listening, or stops speech (`controller.ts:785-798`).
- **Activate:** buttons, `R` / `Esc` / `H`, and voice.
- **Status:** FI.

#### F44 · Earcons
- **What:** on, off, listen, urgent, error and "still running" tones (`earcons.ts:4-11`).
- **Status:** RD. They need the AudioContext unlocked by a tap, so the first events after a voice-only start may be silent.

#### F45 · Haptics
- **What:** on [40], off [40,80,40], listen [25], urgent [200,100,200,100,200] and error [120,80,120] (`controller.ts:49-55`). Can be turned off.
- **Status:** RD.

#### F46 · "Still running" tone
- **What:** a soft tone after 45 s of silence, so the user knows the app hasn't died (`controller.ts:34,536-539`).
- **Status:** FI.

#### F47 · Screen-reader echo and fallback
- **What:** an optional live region that also sends every sentence to the screen reader (`Assistant.tsx:285-286,507`). It turns on automatically for the rest of the session if the voice fails (`controller.ts:233-237`).
- **Status:** RD. With TalkBack, the page voice and TalkBack can talk over each other. Untested.
- **Limits:** once on, the fallback stays on until the language is changed (`controller.ts:1098`).

### Languages

#### F48 · Four speech languages
- **What:** for each of the 4 languages, the app has (`lang.ts`, `phrases.ts`, `prompts.ts`, `schema.ts`, `commands.ts`):
  - a recognition locale
  - a voice preference list
  - a cloud voice
  - a system prompt
  - every app phrase
  - warning templates
  - safety, distance and negation patterns
  - command phrases
- **Status:** RD. The README says that the **French, English and MSA wording, and the Derja, were written without native-speaker review**.
- **Limits:**
  - **The UI is English only**, including the Settings labels and the emergency labels.
  - The `<html lang="en">` attribute stays fixed (`layout.tsx:26`). Sentences the assistant speaks carry their own `lang` and `dir`.

#### F49 · Switch language
- **What:** a Settings menu, or voice: "Speak French", «احكي بالتونسي»… (`commands.ts:140-143`). The switch clears the recent sentences, the history and the warning gate, switches the voice, and confirms in the new language (`controller.ts:1091-1100`).
- **Status:** FI.
- **Limits:** a command in another language has to get through a recognizer set to the current language. That's why the command list includes Arabic-script versions.

### Emergency

#### F50 · Emergency page
- **What:** a modal with "Call [name]", "Text my location to [name]", and the SAMU 190, Police 197 and Civil protection 198 buttons (`Assistant.tsx:553-590`). On opening, it speaks a summary and asks for location once (`controller.ts:800-809`). Focus goes to "Call" or to "Add an emergency contact" (`Assistant.tsx:200-201,557,574`).
- **Activate:** the "Emergency assistance" button, or voice: «نجدة», "Emergency", « Au secours », "help me", "call".
- **Status:** RD (no e2e scenario covers it; only a source-code test does, `tests/safetyInvariants.test.ts`).
- **Limits:**
  - No shortcut key.
  - Shortcut keys are turned off while any dialog is open (`Assistant.tsx:217`).
  - Spoken in the speech language, labels in English.
  - The emergency numbers are hard-coded for Tunisia.

#### F51 · Call the emergency contact
- **What:** a `tel:` link (`Assistant.tsx:158,557`). The voice command "call" / «عيّط» only **moves focus** to the button and says "double-tap to call" (`controller.ts:825-831`). Browsers only open the dialer from a real tap, and a source test checks that code never starts a call (`tests/safetyInvariants.test.ts:17-28`).
- **Status:** RD.
- **Limits:** TalkBack's accessibility focus doesn't always follow a programmatic `.focus()`. This must be checked on a device (`ANDROID_TESTING.md` §7).

#### F52 · Text my location
- **What:** an `sms:` link with the body "I need help. This is my location: https://maps.google.com/?q=lat,lng", or "please call me" without a location (`controller.ts:857-860`, `Assistant.tsx:159,561-569`). The position is one `getCurrentPosition` with high accuracy, a 15 s timeout and up to 60 s old (`controller.ts:834-849`). It's never sent to the server.
- **Status:** RD.
- **Limits:**
  - The location is never spoken (see F70); it only appears in the on-screen status text.
  - The `?body=` syntax for `sms:` varies between Android SMS apps.

#### F53 · Tunisian emergency numbers
- **What:** `tel:190`, `tel:197` and `tel:198` (`Assistant.tsx:112-116`).
- **Status:** RD.

### Settings

#### F54 · Speech speed and volume
- **What:** speed choices 0.7–1.3 (default 0.9) and volume 40–100 % (`settings.ts:38-39`). By voice, "louder", "quieter", "faster" and "slower" step through them and say when a limit is reached (`controller.ts:863-873`).
- **Status:** FI.
- **Limits:** volume is relative to the device's media volume, which the app can't change.

#### F55 · Text size and theme
- **What:** text size 100/125/150/175 %, applied on top of the browser's font size. At 150 % or more the layout drops to one column (`Assistant.tsx:329,351`, `globals.css:68`). Dark or light theme.
- **Status:** FI.
- **Limits:** the theme defaults to dark and **ignores `prefers-color-scheme`** (`layout.tsx:22`). There is no high-contrast theme beyond `forced-colors`.

#### F56 · Narration and vibration toggles
- **What:** native `input role="switch"` controls (`Assistant.tsx:618-625`).
- **Status:** FI.

#### F57 · Emergency contact
- **What:** a name (40 characters) and a phone number (digits, `+` and spaces), kept only in `localStorage` (`Assistant.tsx:512-523`, `settings.ts:43,60-61`).
- **Status:** FI.
- **Limits:**
  - Only one contact.
  - No validation that the number is dialable.
  - Several `+` signs are kept until the next load, because the UI handler doesn't use `cleanPhone` (`Assistant.tsx:521`).

#### F58 · Settings persistence and validation
- **What:** `sanitizeVisionSettings` clamps every field (`settings.ts:46-63`).
- **Status:** FI.

#### F59 · Keyboard shortcuts
- **What:** C, D, T, I, V, Q, P, R, H and Esc, matched by physical key position, so they work with Arabic or French layouts. Turned off in text fields and dialogs (`Assistant.tsx:214-240`). Listed in Settings.
- **Status:** FI (e2e `keyboardOnly`).
- **Limits:** screen readers capture letter keys in browse mode. That's documented, and the user has to switch to pass-through mode.

### Connectivity, power, platform

#### F60 · Offline detection and degraded mode
- **What:** on `offline`, it aborts the scan, says "No internet; only on-device warnings work" (or "analysis down" when the detector isn't ready), shows a banner, stops encoding motion frames, and pauses the voice loop. On `online`, it resets the backoff and says the connection is back (`controller.ts:245-271`, `Assistant.tsx:311`).
- **Status:** **PI.**
  - There is no service worker or manifest, so **the app can't be opened offline at all**.
  - The detector only works offline if its files were already loaded or are in the HTTP cache.
  - Voice commands don't work offline.
  - The voice only works if a local voice for the language is installed.
  - `navigator.onLine` doesn't catch a captive portal or a dead connection.

#### F61 · Screen wake lock
- **What:** keeps the screen on while the camera runs, and asks again when the page becomes visible (`controller.ts:274-276,454-459`).
- **Status:** RD.

#### F62 · Hidden-page handling and release
- **What:** when the page is hidden, analysis, detection and the voice loop stop (`controller.ts:495-498,675,917`). On `pagehide` or unmount, everything is shut down (`controller.ts:273,286-303`).
- **Status:** ~~PI~~ **RD** (2026-11-10). The camera and microphone are now released on `visibilitychange` → hidden, and the camera restarts with a spoken notice on return. Still to check on a real phone: the green camera indicator, the lock screen, the app switcher, and whether a permission prompt hides the page.

#### F63 · Detector CPU budget
- **What:** at most 20 % of main-thread time, at least 250 ms between runs, and at least one run every 3 s (`frameBudget.ts`, `controller.ts:138,689`).
- **Status:** FI (3 tests).

### Backend

#### F64 · Vision API validation
- **Status:** FI (`tests/visionRoute.test.ts` "input validation"). See §2.8.

#### F65 · Provider chain and free-only guard
- **Status:** FI (5 route tests). See §2.4.
- **Limits:** cooldowns are kept per server instance.

#### F66 · Rate limiting and same-origin check
- **Status:** **PI.** The limits live in memory per instance and are keyed by `X-Forwarded-For` (`server/http.ts:53-55`). Requests with no `Origin` are allowed (`server/http.ts:43`). There is no authentication, so anyone who finds the URL can spend the Gemini quota.

#### F67 · Security headers
- **Status:** FI (e2e `independentApp` checks the policy).
- **Limits:** no Content-Security-Policy and no HSTS header. Vercel adds HSTS on its domains.

#### F68 · Status endpoint and disclosure
- **What:** the provider labels shown in the consent notice come from the real configuration (`vision.ts:114-121`).
- **Status:** FI.

### Not yet built / leftovers

#### F69 · Smart-glasses camera source
- **What:** only an interface (`CameraSource`) and a one-case factory (`cameraSource.ts:18-35,132-137`). The README says glasses are not supported.
- **Status:** PL.

#### F70 · Spoken location status in the Emergency page
- **What:** the phrases `locating`, `noLocation`, `smsReady` and `listening` exist in all 4 languages (e.g. `phrases.ts:19,52-54`), but no code uses them (`grep` finds 0 uses). The location result is only on screen, in a `role="status"` paragraph (`Assistant.tsx:565`).
- **Status:** BR (dead code).

### Other defects and leftovers found

- `hazardTracker.ts:3` refers to `tests/hazardTracker.test.ts`, which doesn't exist. The tracker tests are in `tests/visionClient.test.ts`.
- `store.ts:1-3` has a comment about "live prediction ~10/s, fps", copied from the sign-language app.
- Legacy aliases are kept only for tests: `SPEECH`, `CAMERA_ERRORS`, `VISION_SYSTEM_PROMPT`, `TRANSCRIBE_PROMPT` and `pickArabicVoice`.
- `SpeechQueue.hasAtLeast` and `CameraSource.isLive` are never called.

---

## 5. User journey

1. **First time opening the app.**
   - Focus is on "Start assistance" (`Assistant.tsx:178`). TalkBack reads it first, with the hint "Turns on the camera…".
   - The caption says "Press Start assistance to begin, or press H for help".
   - The header says "Experimental test version".
   - Nothing is spoken before the first tap, because browsers block audio until then.
2. **Permissions and consent.**
   - The first Start opens the consent dialog and speaks the privacy notice in the speech language (Derja by default). Focus goes to "I agree".
   - Declining speaks "camera not turned on, no image sent".
   - Agreeing stores consent for good, and Android then asks for the camera.
   - The microphone is asked for later, by the browser, on the first voice use. Location is asked for only when the Emergency page opens.
3. **Starting assistance.**
   - "Camera on", a rising tone and a short vibration.
   - The detector loads, the first scan goes out, the first description is spoken, then the experimental notice.
4. **Voice commands.**
   - The user turns on "Voice commands", says a command, and the assistant acts and speaks.
   - Anything else is a question.
   - "Help" lists what can be said.
   - Each attempt shows "I heard «…»".
5. **Reading text.** "Read text", `T`, or «اقرالي الكتابة». The camera starts if needed, then "One moment, let me look", then the text word for word, or a note that part is unreadable.
6. **Identifying objects.** "Identify object", `I`, or «شنوة هاذي؟». The product and brand are named, the label is read, or the user is told to turn the object.
7. **Describing surroundings.** On demand (`D`), or automatic narration when the scene changes. It can be turned off.
8. **Safety warnings.**
   - On-device: people, vehicles and furniture after 3 sightings, at "caution" or "urgent" level.
   - Cloud: stairs and drops a few seconds later.
   - Urgent warnings interrupt everything, with 3 tones, a strong vibration and red on screen.
   - Warnings repeat at most every 15 or 45 s.
   - Silence is never presented as "safe".
9. **Switching languages.** Settings, or "Speak French" / «احكي بالتونسي». The app confirms in the new language. The UI stays English.
10. **Emergency.**
    - Button, or «نجدة» / "Emergency". The page opens and is read out, and location is requested.
    - Saying "call" selects the call button, and one double-tap opens the dialer.
    - "Text my location" opens the SMS app with a maps link, unsent.
    - The 190, 197 and 198 buttons are there.
    - Without a contact, the user hears that none is set, and focus goes to "Add an emergency contact".
11. **Working offline.**
    - Already open: the app says only on-device warnings work, and the banner shows it. Questions, reading and voice commands are unavailable. The voice works only with a local voice. It announces when the connection comes back.
    - Not open yet: the app can't be opened at all.
12. **Stopping and restarting.**
    - "Stop camera" (`C`, «سكّر الكاميرا»): falling tone, "camera off", and everything is released.
    - Pause («وقّف التحليل», `P`) stops analysis **and on-device warnings** (`controller.ts:675`) while keeping the camera on.
    - Restarting asks no new questions, because consent is stored.

---

## 6. Feature classification

| Class | Count | Features |
|---|---|---|
| Fully implemented | **34** | F02–F07, F13–F16, F18, F26–F30, F32, F33, F36, F40, F43, F46, F49, F54–F59, F63, F64, F65, F67, F68 |
| Implemented, needs real-device testing | **25** | F01, F08–F12, F17, F20–F23, F31, F34, F35, F39, F41, F44, F45, F47, F48, F50–F53, F61 |
| Partially implemented | **3** | F60 (offline), F62 (background release, now RD), F66 (API protection) |
| Experimental | **6** | F19 (two-frame motion), F24 (on-device approach heuristic), F25 (cloud stairs/drops), F37 (recorded speech via Gemini), F38 (dead-service heuristic), F42 (unofficial Edge voice) |
| Planned, not implemented | **1** | F69 (smart glasses) |
| Broken or deprecated | **1** | F70 (spoken location status, dead phrases) |
| **Total** | **70** | |

The voice-command bug in F36 ("Stop listening" turns hands-free mode on when said through push-to-talk) is a defect in a feature that otherwise works, so I didn't count it as a separate feature.

---

## 7. Accessibility audit (blind and low-vision users)

**Strengths (with evidence):**
- **Native semantics.** `dialog` with `showModal` (focus trap, Esc, focus returns), `select`, `input role="switch"`, `aria-pressed` on the voice toggle (`Assistant.tsx:345`), `aria-keyshortcuts` on every action, and headings for each section (some `sr-only`).
- **Reading order.** The comment in `Assistant.tsx:2-4` describes the order: what was last said, the actions, the camera, questions, then details. The video has `aria-label="Live camera preview"`, and the iris is `aria-hidden`.
- **Spoken text** carries `lang` and `dir`, so screen readers switch voice (`Assistant.tsx:285,299`).
- **Focus management.** The Start button has focus on load. Focus moves into consent ("I agree"). The Emergency page focuses the main action (`data-autofocus`). The voice "call" command focuses the call link.
- **Voice-only operation.** Every main action and setting has a voice command, apart from text size, theme, camera direction and the emergency contact. Each state change is spoken and has a tone, and vibrates where possible.
- **Large text.** The app follows the browser's font size and adds its own scale up to 175 %. The layout drops to one column at 150 %. There are no fixed bars.
- **Touch targets.** Main controls are 5.25 rem and tiles 6 rem tall; ghost buttons are 3 rem (`globals.css:103,176,218`). The emergency buttons use `min-h-16`.
- **Motion.** All animation stops under `prefers-reduced-motion` (`globals.css:589-596`), and there are `forced-colors` fallbacks.
- **Automated checks.** An axe-core run in e2e (WCAG 2.0 A/AA and 2.1 AA) when `AXE` is set (`e2e/vision.mjs:124-127`). The results of the last run aren't in the repo.

**Problems and risks:**
1. **The interface is English only** for a Tunisian, mostly Arabic-speaking audience. TalkBack reads every label in English. This is the biggest accessibility gap.
2. **The page voice and TalkBack.** With echo off (the default), the page talks through `speechSynthesis` while TalkBack reads focus changes, so the two can overlap. With echo on, everything is said twice. Untested on a device.
3. **The first tap.** Audio, tones and vibration need a user gesture. Hands-free mode can only be turned on by a tap or key press, and the earcons stay silent until the AudioContext is unlocked.
4. ~~**Detector failure isn't spoken**~~ (F23). Fixed 2026-11-10.
5. **Single-letter shortcuts** clash with screen-reader browse mode. This is documented, and the buttons are the workaround.
6. **The "What it sees now" panel and status list** change silently (no live region). That's fine for the voice path, but screen-reader-only users won't hear updates there.
7. **Programmatic focus** for "call" may not move TalkBack's accessibility focus.
8. **The Emergency page has no shortcut key** and no confirmation tone or vibration when the dialer opens. That is outside the browser's control.
9. **The `ghost` header buttons** (Privacy, Settings) are icon-only on small screens. They are 48 px and have `sr-only` names, which is acceptable.
10. **No onboarding or tutorial** beyond Help. A first-time blind user gets no audio tour of the screen layout.

---

## 8. Security and privacy analysis

| Topic | Finding | Evidence |
|---|---|---|
| Images | Sent to Google Gemini (or OpenRouter) only while the camera is on, not paused, not hidden and online. Never stored or logged by the app. **Free tiers may keep them and use them for training, and human reviewers may see them.** This is disclosed in the consent notice and the README. | `route.ts`, `vision.ts:3-4`, `Assistant.tsx:694-696` |
| Context sent with each image | The last 4 spoken sentences, the last 3 Q&A pairs, the camera direction and the language. No identity, location or contact. | `controller.ts:578-585,726-734`, `route.ts:54-70` |
| Voice | Goes to Google through Chrome's recognition, or to Gemini as a WAV in the fallback. | `voiceInput.ts`, `transcribe/route.ts` |
| Spoken text | Sent to Microsoft's Edge endpoint when the cloud voice is used. The camera image is never sent there. | `tts.ts:318`, `edgeTts.ts` |
| Location | Asked for only on opening the Emergency page, as one fix, kept in memory, and only put into an `sms:` body. Enforced by a source test. | `controller.ts:834-849`, `tests/safetyInvariants.test.ts:30-41` |
| Local storage | Settings, including the **emergency contact name and number in plain text**, the consent flag and the theme. No encryption, which is normal for a web app. | `settings.ts:65-80` |
| Keys | Server-only. Error bodies from providers never reach the client (tested). | `vision.ts:49`, `tests/visionRoute.test.ts` |
| API abuse | No authentication. Requests with no `Origin` are allowed. Rate limits are per IP and per instance. | `server/http.ts:41-55` |
| Billing safety | Pro models and non-free OpenRouter models are refused. | `vision.ts:64,91` |
| Prompt injection | The prompt says scene text is content, never an instruction (`prompts.ts:105`). The code safety filter still applies, whatever the model writes. | `schema.ts` |
| Third parties | The Edge endpoint is unofficial, with a hard-coded token, so its terms and availability are a risk. | `edgeDrm.ts:8`, `edgeTts.ts:6-7` |
| Bystanders | People in view are sent to the provider. The prompt forbids identifying them or guessing sensitive traits. | `prompts.ts:111-112` |
| Consent | Stored for good, can't be withdrawn in the UI, and isn't asked again when the provider changes. | `settings.ts:90-95` |

---

## 9. Limitations (cross-cutting)

1. **Warning latency.** On-device warnings take about 1 s after 3 sightings. Cloud warnings, the only source for stairs and drops, take at least 4 s plus about 2–3 s. *(The pause during speech was removed on 2026-11-10.)*
2. **Distances are never given**, by design. "Near" and "far" are judged from the picture.
3. **Linguistic quality is unreviewed** in all 4 languages. On most phones, Derja is read by a non-Tunisian voice.
4. **Nothing has been tested on a real device or with real users.** Speech recognition has only been tested with synthetic speech (README).
5. **Free-tier dependence.** Quotas are about 15 requests a minute per model, and model names may change.
6. **Not a PWA.** It doesn't open offline and can't be installed.
7. **One user per device.** There are no accounts and no sync, which is good for privacy.
8. **Performance.** `useStore` re-renders the whole `Assistant` tree on every state patch. Patches are frequent (speaking toggles, analysis state, hazard updates), which could cost frame time on low-end Android phones next to MediaPipe on the main thread.

---

## 10. Testing gaps

**What exists:**
- 106 unit tests, all passing on 2026-11-09. They cover the safety filters, urgency, the gate, the scheduler, the queue, the tracker, commands, prompts, languages, TTS client and server, the vision route and HTTP helpers.
- A Playwright e2e script with 17 scenarios: consent, full pipeline, release on leave, keyboard only, permission denied, no camera, dark room, urgent warning (mocked), AI failure (mocked), approaching, recognition, recorder fallback, ask not cut off, dead speech service, mobile, panels and themes, independence from the other app.

**What's missing:**
- **The real-device checklist** (`docs/ANDROID_TESTING.md`) has never been filled in: TalkBack, the Android camera and microphone indicators, vibration, wake lock, battery and heat.
- **No accuracy benchmark:** no labelled set of stairs, kerbs, doors, crossings, labels or medicine boxes, so recall and false-alarm rates are unknown.
- **No latency measurement** on mobile networks for warnings.
- **No e2e scenario** for the Emergency flow, offline mode, language switching, text size or vibration.
- **No component tests** of `controller.ts`. It is the largest file (1,107 lines) and is only exercised through e2e: voice-loop races, the "Stop listening" toggle bug, pending tasks.
- **No native-speaker review** of the phrases or the regex safety lists.
- **No load test** of the rate limits across serverless instances.
- **The e2e suite can't run from a fresh clone.** It needs `photos/street.jpg` and `photos/person.jpg`, which aren't committed.

---

## 11. Recommendations

### Essential (safety, accessibility, trust)
1. **Run the supervised Android checklist** with blind testers and fill in the results before any wider use. Record the warning latency each time.
2. **Don't hold back cloud scans during long speech.** Let hazard scans run while answers or readings play (`scheduler.ts:57`), and speak only hazards from them.
3. **Speak the detector's state.** Say "on-device warnings are off" when MediaPipe fails to load, and "on-device warnings running" on start (`controller.ts:663-670`).
4. **Release the camera when the page is hidden** (or after a short grace period), not only on `pagehide` (`controller.ts:273-282`).
5. **Fix the "Stop listening" toggle**, so `assistant-off` only ever turns the mode off (`controller.ts:1057`).
6. **Localise the interface** into Arabic (Derja/MSA) and French, with `lang` and `dir` on `<html>`.
7. **Let users withdraw consent** in Settings, and ask again when the provider list changes.
8. **Protect the API.** Require `Origin` (or a signed session token) on POST routes, and use a shared rate-limit store (for example Vercel KV or Upstash) to protect the Gemini quota.
9. **Move off free tiers that may train on images** before real users, or at least add a way to use a paid "no training" key.
10. **Add a service worker and manifest**, so the app opens offline with the detector cached and can be installed to the home screen.
11. **Wire up the spoken location status** on the Emergency page (F70), and add an emergency shortcut key and a strong haptic when the page opens.
12. **Review the person-urgency rule** with orientation-and-mobility trainers. Someone near, approaching and straight ahead is never urgent at present (`hazards.ts:21-22`).

### Improving independence (optional)
- **Guided framing for reading:** "move the page left", "closer", "all four corners visible".
- **Document mode:** multi-page reading with "next page" and "read again from …".
- **Currency recognition for Tunisian dinar notes and coins.** This is a very common need.
- **Colour and light detection** on the device, with no cloud.
- **Barcode and QR scanning** on the device (BarcodeDetector or ZXing), with a product lookup.
- **Find-object mode** ("Where is my phone or the door?") with repeated tones that change as the object is centred.
- **Saved places and personal object labels** (stored locally).
- **Trusted-contact video call** handoff for difficult situations.
- **Spoken battery and connection status** on request.

### Smart-glasses readiness
- **Add a `CameraSource`** for streams from glasses (WebRTC, or a Bluetooth/Wi-Fi bridge). Keep `videoElement()` so the on-device detector stays on (`cameraSource.ts:18-35`).
- **Fix the facing to "outward"** for glasses, and skip the auto-detection.
- **Spatial audio** through the glasses' speakers: pan warnings left or right according to `side`.
- **Head-relative cues:** "turn your head right".
- **Lower-latency, always-on detection.** Move MediaPipe to a Web Worker or OffscreenCanvas, and consider the GPU delegate.
- **Hands-free wake word** instead of the open-microphone loop, to reduce false triggers.

### Performance and battery
- **Subscribe components to slices of state**, or memoise the sub-trees, instead of re-rendering the whole page on each patch.
- **Encode the motion frame only when a scan is about to be sent**, using a ring of thumbnails, instead of every second (`controller.ts:511-515`).
- **Move detection off the main thread**, and try the GPU delegate (`localDetector.ts:15`).
- **Measure battery and heat** over 15–30 minutes on a mid-range Android phone.

### Safety (more)
- **Grow the safety regex lists** with native speakers, and consider a second classifier pass that rejects sentences implying "safe".
- **Add an earcon** when an urgent warning expires unspoken, or log it for testers.
- **Keep a separate gate key per object**, using the tracker id for on-device hazards, so two obstacles on the same side are both announced.
- **Build an accuracy test set** of local streets, stairs and crossings, and re-run it whenever the model or prompt changes.

### Accessibility (more)
- **An audio onboarding tour** on first use.
- **A live region (polite) for the findings** when echo is on, and a "what changed" summary command.
- **Default the theme to the OS setting** (`prefers-color-scheme`), and add a high-contrast or yellow-on-black theme.
- **Test with TalkBack, Voice Access and Switch Access**, and on Samsung's own Chrome builds.

---

## 12. Final numbers

| Measure | Count |
|---|---|
| Total features discovered | **70** |
| Fully implemented | **34** |
| Partially implemented | **3** |
| Experimental | **6** |
| Implemented, needs real-device testing | **25** |
| Planned, not implemented | 1 |
| Broken or deprecated | 1 |

### The 10 most important features
1. **On-device obstacle, person and vehicle warnings** (F23/F24). They work offline, react in about a second, and send nothing anywhere.
2. **Cloud hazard detection for stairs and floor-level changes** (F25). This is the only source for the most dangerous hazards.
3. **The safety-language filter and the "not safe" caveats** (F29/F30). Code-level guarantees against false reassurance and invented distances.
4. **Urgent alert path** (F26, F31, F40): computed urgency, interrupting speech, tones, vibration and the red display.
5. **Read text** (F10).
6. **Identify object or product, including labels, expiry dates and dosage** (F11).
7. **Describe surroundings and automatic narration** (F08/F09).
8. **Hands-free voice commands in four languages** (F34/F36).
9. **Emergency page:** call the contact, text the location, Tunisian numbers, with nothing sent without a tap (F50–F53).
10. **Honest failure reporting** (F32, F60): the user is always told when analysis is down or offline, so they never believe they're being watched over when they aren't.
