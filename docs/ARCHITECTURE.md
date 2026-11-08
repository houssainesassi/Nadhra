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
| `src/lib/assistant/hazards.ts`, `phrases.ts` | How serious a hazard is, and the wording of warnings |
| `src/lib/assistant/hazardTracker.ts`, `localDetector.ts` | On-device detection across frames |
| `src/lib/assistant/speechQueue.ts` | One voice at a time, by priority |
| `src/lib/assistant/voiceInput.ts`, `commands.ts`, `wav.ts` | Hearing the user |
| `src/lib/assistant/prompts.ts` | Model instructions |
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

When you change these, add a test: they are the part of this app that can hurt someone if wrong.

## Left and right

The model always reports image sides, and is told the user stands behind the camera. If the webcam faces the user, the server swaps sides in the data deterministically, swaps the words in the question going in and in the answer coming out, and leaves quoted text alone.

## Adding another camera

Implement `CameraSource` and register it in `createCameraSource`. Glasses that stream into a video element can reuse most of `WebcamSource`. A source without a video element returns `null` from `videoElement()`, which turns off the on-device detector, so warnings then depend only on the cloud model.

## Adding an AI provider

Add an entry to `getVisionProviders()` in `src/lib/ai/vision.ts`. It must return the model's text, and may implement `transcribe`. Everything else, including fallback, cooldowns and validation, is shared. `label` is shown to users as a recipient of their images, so it must be accurate.

## Frame selection

Frames go out at most every 4 s, when more than 8 % of pixels changed, when the detector finds something new, or on a heartbeat that slows from 20 s to 80 s while nothing changes. Dark, overexposed or featureless frames aren't sent. Blurred frames wait up to 6 s for a sharper one. Limits are in `scheduler.ts`.

## Speech priority

`urgent` interrupts everything, and what it cuts off resumes afterwards (except narration). `answer` interrupts narration only. `status` waits and isn't lost. `narration` is replaced by newer narration and dropped when stale. While the user is talking, or has pressed Ask, only urgent warnings play.

## Browser tests

`e2e/vision.mjs` runs the production build in Chromium with fake camera and microphone files, using the real AI and voice services except for checks marked "(mocked API)". It needs a Chromium binary (Playwright's, or set `CHROME_PATH`) and working keys, and it uses free-tier quota.

```bash
# photos/ needs street.jpg (a busy street) and person.jpg (a person, at the position in PERSON_BOX)
python e2e/make_vision_camera.py photos fixtures
npm run build && npx next start -p 3100
npm run e2e -- fixtures http://localhost:3100 screenshots
```

Set `AXE=/path/to/axe.min.js` to include automated accessibility checks, and `ONLY=scenarioA,scenarioB` to run some scenarios.

Fake devices prove the software path, not real-world quality. Test with a real webcam, real speech, real rooms and blind users as well.
