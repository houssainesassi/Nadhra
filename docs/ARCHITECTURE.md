# Architecture

For developers working on the assistant. See the [README](../README.md) for setup and limits.

## Overview

```
Camera (CameraSource)
 ├─ small copy, every 0.5 s ── quality + change check ── scheduler decides: send a frame?
 │                                                             │
 │                                                     POST /api/vision ── server: validate,
 │                                                             │           provider chain,
 │                                                             │           safety rules in code
 │                                                             ▼
 └─ video, about 2-4 per s ── on-device detector ── tracker ── WarningGate ── SpeechQueue ── voice
                                                                                  ▲
 Microphone (VoiceInput) ── question or command ── POST /api/vision ── answer ────┘
```

Two layers on purpose. The **cloud model** understands the scene: rooms, stairs, text, questions. The **on-device detector** (MediaPipe EfficientDet-Lite0) is fast, private and keeps working when the cloud is slow or down, but only knows common objects.

## Live conversation

```
Microphone ─ AudioWorklet ─ 16 kHz PCM ─┐
Camera ─ ≤1 frame/s (on change, every 3 s, and when the user starts talking) ─┤ one WebSocket ─ Gemini Live
Speaker ◄─ 24 kHz PCM, played as it arrives, flushed on `interrupted` ◄───────┘    (token from /api/live/token)
```

- `src/lib/live/session.ts`: the WebSocket client. Gets a token, sends the setup locked into it, falls back to the next model if one can't be reached, keeps the resumption handle, reconnects into the same conversation after a drop or a `goAway` (buffering up to 3 s of microphone audio meanwhile), and reports latency from the end of the user's speech.
- `src/lib/live/audioIO.ts`: microphone capture with echo cancellation, gapless playback, ducking while the user talks over an answer, and a level-based voice detector.
- `src/lib/live/config.ts`: female voices, models, frame limits and the system prompt (Derja by default, the same safety rules as the rest of the app).
- `src/lib/server/liveToken.ts`: mints a one-use token whose whole setup (model, voice, instructions) is locked, so a page script can't use it for anything else.
- The controller pauses cloud scans while live, keeps the on-device detector running, and lets a warning cut the live answer off. The live microphone is never muted: the user's words stop status sentences instead.
- Tests: `tests/live.test.ts` (no network); `e2e/live/latency.ts` and `e2e/live/browser.mjs` use the real service (see their headers).

## Reading documents and medicine boxes

The rule above all others: **Nadhra never states an unverified dose or date as fact.** A transcription is not proof, a model's "confirmed" is not proof, and two readings that agree are not proof either.

Voice only, no button: «اقرالي الدوا», «اقرالي الورقة», «lis l'ordonnance», "read the prescription", and «اقرا الكل» / "read all".

```
voice ── first time only: spoken notice (Google, free tier, no real prescriptions) ── «موافق»
      ── on-device: too dark? no sharp tile (640 px)? ── refuse, say why (nothing sent)
      ── automatic frames stop (scans, live) ── frame A (still photo if possible) + frame B 0.4 s later
      ── POST /api/vision {mode:"read", image, secondImage} ── Gemini only, never OpenRouter
            reading A: first model, frame A ─┐ in parallel, temperature 0, readSystemPrompt
            reading B: other model, frame B ─┘
      ── document.ts sanitizeDocument(A, confirm: B) ── checked, labelled speech
voice ◄── «قريت…» + the paper's text in its own language's voice + "check it with the pharmacist" after each dose and date
```

What `document.ts` enforces (tests: `tests/document.test.ts`, F1–F6 marked):

- **Medical papers** (medicine, prescription, other medical): a line, whether a name, a dose or a date, is said only when all of these hold:
  - the model calls it confirmed and fully visible, with no unreadable mark (`[?]`, `5?0`, `…`);
  - reading B has the **same whole line**, word for word and number for number;
  - **the pixel check passes in both frames** (`lineCheck.ts`). It uses no AI: at the position each reading gives for the line (`box_2d`), the line must not touch the picture edge, must not be covered by a solid mass in it or right after it, must not claim characters over unprinted paper (glare), and must not be nearly empty. Its printed ink must also be about as wide as the characters claimed (0.22–1.3 line heights per character): this catches a box drawn around only the visible part («50» for «500 mg») and a box on a much longer line.

  **Line positions in frame A** come from the accurate model (gemini-3.1-flash-lite) when the first reading came from another model. As soon as that reading is in, the accurate model is asked to *locate* its lines in frame A, text unchanged (`LOCATE_SYSTEM_PROMPT`, `withLocatedBoxes`).
  - The located box replaces the first reading's own box only when the own box failed softly (faint, incomplete, mismatch, none).
  - An own box showing a solid mass or the picture edge still withholds the line.
  - A line the locator answers null for (not fully visible), or leaves out, is withheld.
  - Two lines located in the same spot are both withheld.
  - If locating fails, the own boxes are used as before.

  The two readings stay with two different models; frame B is checked with the second reading's own boxes. A line without a usable position, or a picture that can't be decoded, can't be checked, so it isn't read. If the second reading fails altogether (a busy service), nothing medical is read, and the user is told to ask again rather than to retake the picture. A strength must carry its unit, and a bare number is never read. When the model reports glare, blur, darkness, angle, distance or handwriting, numbered lines are held back too. Anything withheld is said once, with how to take the next picture (move back, move the finger, tilt against glare).
- **Fields** (name, substance, strength, form, quantity, expiry) must appear as whole words and whole numbers in those lines: "500 mg" is not on a 1500 mg box.
- **Wording:** «قريت الجرعة: … ثبّت فيها مع الصيدلي» ("I read the dose as …, check it with the pharmacist"), the check right after every dose, date and medicine name. The speech queue doesn't drop repeated answer sentences: it used to drop the repeated check, so later doses went unchecked (fixed and tested). Expiry status is computed in code, said conditionally («كان القراية صحيحة…», "if the reading is right…"), and not at all for ambiguous dates (03/04/2027).
- **No AI explanation of medical papers.** The model's explanation is dropped. A Derja rendering of an instruction can only come from a fixed word-for-word glossary (`derjaInstruction`), switched off (`DERJA_GLOSSARY_APPROVED = false`) until a pharmacist approves it.
- **Questions** about a document: a quote that must be in the checked text, then the check. "Can I take…?" always gets "only your doctor or pharmacist". Bills and letters keep a labelled explanation, without numbers that aren't printed or any dose.
- **Medicine questions never bypass this.**
  - Client: `isMedicalQuestion` sends them to reading mode, or declines them with the camera off.
  - Server: a medicine question in question or chat mode is read under these rules (one frame, so no numbers) or declined.
  - Scans, questions, chat and streamed sentences: any sentence with a dose is dropped (`mentionsDose`).
  - Live conversation: its prompt forbids doses; a medicine question takes the turn from the live model to reading mode; a dose in a live answer is cut and the refusal said.
- **Automatic descriptions are off by default** (`settings.autoDescribe`). No picture leaves the phone unless the user asks: a question, a reading, a live conversation. The camera-start notice says that stairs and drops are then not detected, since only the cloud scan finds them; on-device warnings for people and vehicles run either way. «شعّل الوصف التلقائي» ("turn on automatic descriptions") or the Settings toggle turns them on, with a spoken note that a picture goes to Google every few seconds, papers included.
- **No guarantee about obstacles:**
  - The safety notice at the first camera start of a visit says Nadhra can't guarantee seeing stairs, holes or obstacles; later starts repeat it briefly.
  - With automatic descriptions off or paused and no live conversation, a camera that keeps moving (probably walking) brings a reminder at most every 3 minutes that stairs and holes aren't seen.
  - "What's in front of me?" and "describe" answers end with the no-guarantee sentence at most every 5 minutes.
- **When automatic descriptions are on:** a scan that sees a document (`document_in_view`) keeps none of its text and says nothing about it, and scans and live frames pause until the view clearly changes. A reading starts the same pause.
- **Memory:** the last document stays in the page's memory for 5 minutes, outside the general conversation history. It's forgotten when consent is withdrawn or the language changes. «اقرا الكل» reads from memory with the same checks.
- `speechText` keeps "/" between digits and units: «03/2027» and «1/2 comprimé» are not read as «03 أو 2027», «1 ou 2».
- **Real-model tests:** `e2e/read/make_plan_set.py` and `e2e/read/plan.ts` (30 mock cases, scored for critical errors), `e2e/read/run.ts` and `e2e/read/browser.mjs`. All documents are rendered mocks with invented names.

## Live conversation privacy

- **Its own spoken consent**, after the camera's: voice and about one picture a second go to Google Gemini for as long as it runs; what the free service may do; no personal papers; how to stop. Nothing is sent until «موافق» ("I agree") or a second press of the button, which then reads "I agree: start the live conversation". «رجّع» ("go back") cancels. Withdrawing consent forgets it.
- **While it runs:** "voice and pictures are going to Google now" at the start, a reminder every 5 minutes, and "nothing more is being sent" at the end.
- **Stopping:**
  - **On the phone, sending nothing:** the "Stop assistance" button on the main screen, or "End live conversation" in Settings.
  - **By voice:** «وقّف المحادثة», «وقّف الإرسال», "stop live", "stop sending" (and "stop listening", "close the camera") are matched on every partial transcript of the user's words, so sending stops as soon as the phrase is recognised. That transcript comes from Gemini Live, so the stop words reach Google; the notice and the Settings hint say so.
  - An on-device stop word is a separate future task.

## Test capture (real-camera sessions only)

`READ_CAPTURE_DIR` on a local server saves each reading: both frames, both raw readings, what was said and each line's verdict. It is for scoring sessions with the printed synthetic kit (`docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md`, `e2e/read/realcam.ts`). It is off unless set, refused on Vercel, and never to be used with real documents.

## Code map

| Path | Responsibility |
|---|---|
| `src/components/Assistant.tsx` | The only screen |
| `src/components/Iris.tsx`, `icons.tsx` | The state emblem and line icons |
| `src/app/globals.css` | Design tokens, controls and all motion |
| `src/lib/assistant/controller.ts` | Runs everything: camera, frame selection, analysis, speech, voice. No React in it |
| `src/lib/assistant/cameraSource.ts` | Camera interface and webcam implementation |
| `src/lib/assistant/frameAnalysis.ts`, `scheduler.ts` | Is this frame usable, and is it worth sending? |
| `src/lib/assistant/schema.ts` | Cleans model output, and enforces the safety rules |
| `src/lib/assistant/hazards.ts`, `phrases.ts` | How serious a hazard is, and everything the assistant says, in each language |
| `src/lib/assistant/hazardTracker.ts`, `localDetector.ts` | On-device detection across frames |
| `src/lib/assistant/speechQueue.ts` | One voice at a time, by priority |
| `src/lib/assistant/voiceInput.ts`, `commands.ts`, `wav.ts` | Hearing the user |
| `src/lib/assistant/prompts.ts` | Model instructions, per speech language |
| `src/lib/assistant/document.ts` | Reading documents: checks the transcription and builds what is said |
| `src/lib/assistant/lineCheck.ts` | Pixel check (no AI) that a printed line is whole in the picture |
| `src/lib/assistant/lang.ts` | The four speech languages: recognition, voices, lang attributes |
| `src/lib/ai/vision.ts` | Server only: providers and fallback |
| `src/lib/speech/` | Voice output: browser voice first, Edge voice as fallback |
| `src/lib/server/http.ts` | Body limits, same-origin check, rate limiter |
| `src/app/api/` | `vision`, `vision/transcribe`, `tts` |

## Design rules

- **One meaning per colour.** Warm light is the assistant, blue is listening, and a large red area is only ever a warning. Don't use them decoratively.
- **Nothing depends on sight or motion.** Each state is also spoken and given as text. Motion is CSS only and stops under `prefers-reduced-motion`.
- **Native elements first:** `dialog`, `select`, and `input role="switch"` keep focus handling and screen-reader behaviour correct.
- **Keep text 7:1 or better, control edges 3:1 or better,** and controls at least 48 px, in both themes. Text over the video sits on solid chips.
- **No fixed bars.** They cover content when low-vision users zoom in.

## Safety rules live in code

The prompt asks the model to behave, but these hold whatever it writes:

- **No safety promises and no measured distances.** `guardSpoken` removes such sentences, unless they quote text read from the scene.
- **Path questions always get a caveat** that safety can't be confirmed.
- **No motion claims without a second frame.** Discarded on the server.
- **Urgency is computed, not taken from the model.** An uncertain hazard is never urgent (`hazardUrgency`).
- **Warnings come from templates** (`warningPhrase`), so the wording always matches the confidence level.
- **The on-device detector needs persistence.** At least 3 sightings before anything is reported; "approaching" needs growth over at least a second with a still camera.
- **Unusable or failed results are never filled in.** The user is told the analysis is down.
- **Pause never turns the safety layer off.** It stops descriptions and cloud scans; the on-device detector keeps warning, and the spoken notice says whether it is running.
- **A live conversation keeps the hazard scans.** Cloud scans continue every 8 s or more, for their warnings only (stairs and drops come only from them).
- **Live answers are checked after the fact.** Gemini Live speaks before its words can be filtered, so `isSafetyClaim` checks each finished sentence of its transcript; a promise of safety cuts the rest of that answer and the caveat is said instead.
- **A warning dropped unheard can be said again.** When the speech queue drops a keyed warning (stale, or the queue was stopped), `WarningGate.forget` lets the next detection announce it.
- **«نجدة» in a live conversation opens the Emergency page** instead of being answered by the model.

The rules in `schema.ts` cover all four speech languages. Adding a language means adding its safety, distance and negation patterns there, and tests in `tests/languages.test.ts`.

When you change these, add a test: they are the part of this app that can hurt someone if wrong.

## API protection and cost control

Every quota-limited route (`/api/vision`, `/api/vision/transcribe`, `/api/tts`, `/api/live/token`, `/api/report`) goes through `src/lib/server/guard.ts`:

1. **Origin required** on POST and equal to the host: a bare script or another site gets 403.
2. **Session cookie**: `/api/session` sets an HMAC-signed HttpOnly `SameSite=Strict` cookie (7 days); without it the route answers 401 `session` and the page's `apiFetch` opens one and retries. It is not authentication: it enables per-session limits, and one address may open at most `SESSIONS_PER_ADDRESS_PER_HOUR` sessions.
3. **Per-minute limits** per session and per address.
4. **Daily budgets** per session and for the whole service (`DAILY_*` variables). The service total is the cost ceiling; it is only counted after a session's own limits pass. Web search, the only billed call, has its own budget and is counted only when a search is offered; past it, questions are answered without search. A spent budget answers 503 `quota-exhausted`, which the page says out loud.

Counters live in memory per instance unless `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` are set (`usageStore.ts`); if that store fails, memory is used and a warning logged.

**Monitoring** (`monitor.ts`): counters and one JSON log line per notable event, with fixed names and short codes only. The page reports its own failures to `/api/report` (allow-listed event names). `/api/health` returns `{ok:true}`, or with `Authorization: Bearer $HEALTH_TOKEN` the counters and today's usage against the budgets.

**Headers**: Content-Security-Policy (only this site, plus the Gemini Live WebSocket; `wasm-unsafe-eval` for MediaPipe, `blob:` scripts for the microphone worklet) and HSTS, in `next.config.ts`.

## Left and right

The model always reports image sides, and is told the user stands behind the camera. If the webcam faces the user, the server swaps sides in the data deterministically, swaps the words in the question going in and in the answer coming out, and leaves quoted text alone.

## Adding another camera

Implement `CameraSource` and register it in `createCameraSource`. Glasses that stream into a video element can reuse most of `WebcamSource`. A source without a video element returns `null` from `videoElement()`, which turns off the on-device detector, so warnings then depend only on the cloud model.

## AI mode and routing (offline track)

`AI_MODE` (server): `cloud` (default, today's behaviour), `hybrid` or `offline`. Proposal and plan: `docs/OFFLINE_ARCHITECTURE_PROPOSAL.md`.

- **Providers declare what they do.** Each `VisionProvider` has `locality` (`local` or `cloud`) and `tasks` (`scan`, `question`, `chat`, `read`, `transcribe`, each `full` or `limited`). `src/lib/ai/router.ts` only ever gives a provider a task it declares. Gemini declares all five; OpenRouter never `read` (documents) or `transcribe`.
- **Order:** cloud mode uses cloud providers in their configured order. Offline mode uses local providers only, full before limited. Hybrid mode uses local full, then cloud, then local limited, and skips cloud when the internet is known to be down.
- **Refusals are said, not hidden.** When the mode or the connection leaves a task without a provider, the route answers 503 `offline-mode` or `no-internet` before any budget is counted. The page says «المساعد مضبوط باش يخدم بلاش إنترنت، وهاذا يستحقّ الإنترنت» or the existing offline sentence, which claims that on-device warnings work only when the detector runs.
- **Offline mode sends nothing:**
  - `/api/vision`, `/api/vision/transcribe` and `/api/live/token` refuse.
  - The Edge voice is off, so the device's own voice speaks.
  - The browser's speech recognition, a cloud service, is never chosen. Voice input then needs an on-device transcription engine, and none exists yet.
  - The internet probe doesn't run.
- **DeviceCapabilities** (`src/lib/server/deviceCapabilities.ts`):
  - Architecture, CPU, load, `MemAvailable`, hottest thermal zone, AI mode.
  - The internet probe, hybrid mode only.
  - With the per-task routing (`capabilitySummary`), shown by `/api/health` with the health token only. A public deployment doesn't describe its machine.
- **Not yet:** no on-device language model, OCR, speech recognition or voice engine is wired in. Adding one means a provider with `locality: "local"` and honest `tasks`, from benchmarks.
- **Reading rules don't change with the mode.** Medicine papers still need two independent readings and the pixel check (`document.ts`).

## Adding an AI provider

Add an entry to `getVisionProviders()` in `src/lib/ai/vision.ts`. It must return the model's text, and may implement `transcribe`. Everything else, including fallback, cooldowns and validation, is shared. `label` is shown to users as a recipient of their images, so it must be accurate.

## Questions: streamed, at request time

Every answer is made by the model when the question is asked. Nothing is cached or prepared in advance.

- **Camera on** (`mode: "question"`): the frame captured for this question (1280 px), plus an older small frame for motion, goes to the vision model with the last three question/answer pairs and the current Tunisian date and time.
- **Camera off** (`mode: "chat"`): no image. The model answers general questions. A question about the surroundings comes back as `[CAMERA]`, and the assistant asks for the camera instead of guessing.
- **Live information**: chat questions may use Google Search grounding. With the camera on, the model sets `needs_web` when the answer depends on current facts, and a search answer replaces its "I can't know" when search is available. A key without search quota (HTTP 429) answers without search, and search rests for `SEARCH_COOLDOWN_MS`.
- **Streaming**: with `stream: true` the route answers with server-sent events (`sentence`, then `done` with `rest`, or `error`). `SentenceStreamer` (schema.ts) sends a sentence early only if the final checks would keep it exactly as it is. A sentence those checks might drop, change or follow with a caveat stops early sending, and the rest comes in `done`. Path questions are never streamed. Early sentences plus `rest` are always the checked answer (tests/streaming.test.ts).
- **Cancelling**: a new question aborts the previous request. The route passes the abort on to the provider call. A provider that fails after a sentence was sent ends the answer as `interrupted` ("the answer was cut off"), and no other model's answer follows half of one. The browser retries once on a network failure if nothing has arrived yet.

- **Language**: the answer comes in the question's language when it is clearly one of the four (`questionLang` in lang.ts: Derja words or Arabizi give Derja, two standard-Arabic signs give MSA, French or English words give those). The voice switches for that answer only (`SpeechQueue` items carry a language). Warnings and status stay in the chosen language.
- **Web search** needs a billed Gemini project. It is not in the free tier. `GEMINI_SEARCH_API_KEY` can be a billed key used only for search calls. The search model gets the question and the text of the picture analysis, never the image, and it is told not to add visual details. `usedWeb` is set only when Gemini returns grounding metadata.
- **Timing**: the `done` event carries `timing` (first token, first sentence, total, all from the request reaching the server).

## Frame selection

Frames go out at most every 4 s, when more than 8 % of pixels changed, when the detector finds something new, or on a heartbeat that slows from 20 s to 80 s while nothing changes. Dark, overexposed or featureless frames aren't sent. Blurred frames wait up to 6 s for a sharper one. Limits are in `scheduler.ts`. Speech playing never holds a frame back: during a long reading, scans keep running for their warnings, and their description is dropped.

## Speech priority

`urgent` interrupts everything, and what it cuts off resumes afterwards (except narration). `warning` (caution-level hazards) interrupts answers and below, never an urgent warning, and goes stale after 8 s. An interrupted reading resumes from the part that was cut, before the rest. `answer` interrupts narration only. `status` waits and isn't lost. `narration` is replaced by newer narration and dropped when stale. While the user is talking, or has pressed Ask, only urgent warnings play.

## Browser tests

`e2e/vision.mjs` runs the production build in Chromium with fake camera and microphone files, using the real AI and voice services except for checks marked "(mocked API)". It needs a Chromium binary (Playwright's, or set `CHROME_PATH`) and working keys, and it uses free-tier quota.

```bash
# photos/ needs street.jpg (a busy street) and person.jpg (a person, at the position in PERSON_BOX)
python e2e/make_vision_camera.py photos fixtures
npm run build && npx next start -p 3100
npm run e2e -- fixtures http://localhost:3100 screenshots
```

Three scenarios mock every vision and voice request and need no photos and no quota: `hiddenReleasesCamera`, `detectorFailureSpoken` and `readingInterruptedByWarning`.

```bash
python3 e2e/make_synthetic_camera.py fixtures   # Pillow; ffmpeg for silence.mp3
ONLY=hiddenReleasesCamera,detectorFailureSpoken,readingInterruptedByWarning npm run e2e -- fixtures http://localhost:3100
```

Set `AXE=/path/to/axe.min.js` to include automated accessibility checks, and `ONLY=scenarioA,scenarioB` to run some scenarios.

Fake devices prove the software path, not real-world quality. Test with a real webcam, real speech, real rooms and blind users as well.
