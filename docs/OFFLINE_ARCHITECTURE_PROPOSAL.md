# Offline-first Nadhra: audit and architecture proposal

Status: **proposal, Phase 1 (audit) of the offline track. Nothing is implemented.** Written 2026-11-13.
This track is separate from the 8-phase feature roadmap. It does not touch the Phase 1 reading
pipeline's safety rules, and it uses no Gemini quota.

---

## 1. What exists today (audit)

### 1.1 Shape of the application

A Next.js 16 web app (one screen, voice-first). Two halves:

| Half | Runs in | Main files |
|---|---|---|
| Browser | phone browser (Chrome on Android) | `controller.ts` (2,086 lines, no React), `cameraSource.ts`, `voiceInput.ts`, `speech/tts.ts`, `live/*`, `localDetector.ts`, `frameAnalysis.ts`, `scheduler.ts`, `speechQueue.ts` |
| Server | Vercel today; any Node ≥ 22 | `api/vision`, `api/vision/transcribe`, `api/tts`, `api/live/token`; `ai/vision.ts` (providers + fallback), `schema.ts` / `document.ts` / `lineCheck.ts` (safety rules in code), `server/guard.ts` (quotas) |

Baseline checked today: `npm test` 328/328 pass, `tsc --noEmit` clean.

### 1.2 What already works without internet

These are real and already offline:

- **Camera, frame quality and change detection** (`frameAnalysis.ts`, `scheduler.ts`): plain JS on pixels.
- **Hazard warnings** for people, vehicles and common objects: MediaPipe EfficientDet-Lite0 (WASM, model in
  `public/mediapipe/`), `hazardTracker.ts` (3 sightings needed), `WarningGate`, templated wording.
- **Voice commands parsing** (`commands.ts`): regex, no model.
- **Speech priority queue**, earcons, settings, consent.
- **Safety rules** (`schema.ts`, `document.ts`, `lineCheck.ts`): pure TypeScript. `lineCheck.ts` is a
  no-AI pixel check that runs on the server.
- **Browser TTS** (`BrowserTts`), only if the OS has an Arabic voice installed.
- **Honest offline message** already exists: «ما فمّاش إنترنت… كان التنبيهات اللي في الجهاز».

### 1.3 What needs the internet today

| Feature | Engine today | Offline today? |
|---|---|---|
| Scene description (scan), camera questions, chat | Gemini (3 models in a chain), OpenRouter free last | No |
| Document / medicine reading | Gemini only, two models, + pixel check | No |
| Speech recognition | Chrome `SpeechRecognition` (sends audio to Google), or `RecorderInput` → `/api/vision/transcribe` → Gemini | No |
| Voice output (preferred female Derja voice) | Microsoft Edge neural voice via `/api/tts` (unofficial endpoint) | No (browser voice fallback only) |
| Live conversation | Gemini Live WebSocket | No, and has no local equivalent |
| Web search | Gemini grounding (billed) | No |

### 1.4 Abstractions that already exist (and map onto the 8 requested interfaces)

The project already has most of the seams this work needs. They should be **extended, not
replaced**:

| Requested | Existing equivalent | Gap |
|---|---|---|
| VisionEngine | `VisionProvider` in `ai/vision.ts` (server) + `LocalDetector` (browser) | Providers don't declare *what* they can do, or whether they're local |
| OCREngine | none; reading uses a vision model | New interface (server side) |
| SpeechRecognitionEngine | `VoiceInput` (browser) + `VisionProvider.transcribe` (server) | Transcription is tied to vision providers |
| LanguageEngine | `VisionProvider.analyze` with no image (chat mode) | Same interface as vision; only needs a capability flag |
| TextToSpeechEngine | `TtsEngine` (browser) + `edgeTts.ts` (server) | Server side has a single hard-wired engine |
| AIProviderRouter | `withFallback()` in `ai/vision.ts`: ordered chain, cooldowns, time budget | Ordered by config only, not by task or locality |
| DeviceCapabilities | scattered (`recognitionSupported()`, `navigator.onLine`, `visionStatus()`) | No single place; "online" means two different things once the server runs on the device |
| ConversationController | `SmartVisionController` | Keep it. It should not learn about providers |

`CameraSource` is already the hardware adapter for cameras (its header names smart glasses).

### 1.5 Development machine (measured)

Intel i5-5300U (2 cores / 4 threads, AVX2 + FMA, 2015), 7.6 GB RAM with **about 2.4 GB free** while
the desktop runs, Intel HD 5500 (no usable GPU compute), 90 GB disk free. Installed: gcc, cmake,
ffmpeg, Python with numpy and Pillow. Not installed: Tesseract, OpenCV, ONNX Runtime, llama.cpp,
whisper.cpp, Piper, espeak-ng.

This CPU is in the same broad class as current ARM single-board computers, so timings here are a
useful but **not exact** proxy. ARM numbers must be measured on ARM; until there is hardware, an
aarch64 build under QEMU can check that things *build and run*, not how fast.

### 1.6 Risks found during the audit

1. **The working tree has a large amount of uncommitted work** (30 modified files, 17 new ones from Phase 1).
   Architectural changes on top of it will be hard to review. I recommend you commit Phase 1 first.
2. **`navigator.onLine` is the only offline signal.** Once the Next server runs on the device itself,
   "server reachable" and "internet reachable" are different things. The router must check the
   second one on the server.
3. **The browser runtime is heavy for glasses.** Chromium plus Next is roughly 0.5–1 GB of RAM. That's
   fine on the PC and on a 4 GB ARM board, but tight below that. This is a later concern (Phase 5), not a reason
   to rewrite now.
4. **Safety rules assume a vision-language model** (`box_2d`, `confirmed`, two independent readings).
   A local OCR engine must feed the *same* `document.ts` checks, never bypass them.

---

## 2. Target architecture

### 2.1 Principle: local engines are separate processes (sidecars) behind the existing server routes

```
Browser (unchanged UI and controller)
   │  same /api/vision, /api/vision/transcribe, /api/tts calls as today
   ▼
Next server (on the PC now, on the ARM device later — localhost)
   │
   AIProviderRouter  ── picks an engine per TASK, by capability, locality, mode, health
   │
   ├─ Cloud adapters:  Gemini (as today), OpenRouter free (as today), Edge TTS (as today)
   └─ Local adapters:  HTTP to sidecars on 127.0.0.1
        llama.cpp  `llama-server`   (OpenAI-compatible chat API; optional small vision model)
        whisper.cpp `whisper-server` or sherpa-onnx (speech → text)
        OCR service (Tesseract or PaddleOCR-on-ONNX, chosen by benchmark)
        offline TTS (chosen by benchmark; see 3.5)
```

Why sidecars, not Node native add-ons:

- Every candidate (llama.cpp, whisper.cpp, sherpa-onnx, Tesseract, ONNX Runtime) is C/C++ and builds for
  x86_64 and aarch64. Running each as its own process keeps the Node app pure TypeScript and the same
  on both architectures.
- A crashed or out-of-memory model doesn't take the app down. The router just marks it unhealthy.
- Models can be swapped by changing a URL or a model file, never application logic.
- Hardware-specific flags (threads, NEON, Vulkan, NPU delegate) live in each sidecar's launch config,
  isolated from the app (Phase 5).

`llama-server` already speaks the OpenAI chat-completions format. The existing OpenRouter adapter sends
that same format, so a local LLM provider is mostly the OpenRouter adapter with a localhost URL.

### 2.2 The router

Each provider declares, in code:

```ts
locality: "local" | "cloud";
tasks: { scan?, question?, chat?, read?, ocr?, transcribe?, tts? }  // each: "full" | "limited"
languages: SpeechLang[];  // what it handles acceptably, from benchmarks, not assumptions
```

Mode is set by `AI_MODE`:

| AI_MODE | Behaviour |
|---|---|
| `cloud` (default, = today) | Exactly the current chain. No behaviour change. |
| `hybrid` | Local first for the tasks it does `full`; cloud for the rest; local fallback when cloud fails |
| `offline` | Local only. A task with no local provider gets an **explicit spoken refusal** ("this needs the internet") |

Routing rules (matching your Phase 4):

| Task | Route |
|---|---|
| Frame quality, change, hazards from common objects | Local, as today (already offline) |
| Voice commands | Local regex, as today |
| Speech → text | Local STT if its benchmarked language quality passes; else cloud |
| Text extraction (non-medical) | Local OCR |
| Medicine and prescription reading | Needs **two independent readings + pixel check** (unchanged rule). Local OCR can be one of the two readings. With only one local engine, numbers are withheld and the user is told why |
| Chat (no image) | Local LLM when present; cloud for things the local model fails in benchmarks (for example Derja) |
| Scene description / visual questions | Cloud. Local VLM only if benchmarks show it is usable, and then labelled as limited |
| Cloud fails | Local fallback **for tasks local can actually do**; otherwise the existing "analysis is down" message, made more precise |

**Honesty rule, enforced in code:** a provider can only be selected for a task it declares. Every
answer carries which engine made it (`provider` already exists in responses), and a test asserts that
`offline` mode never returns a cloud provider and never returns a scene description from an engine
not declared for it.

### 2.3 DeviceCapabilities

One small server module answering, at startup and periodically: is the internet reachable (a cheap
probe, not `navigator.onLine`)? Which sidecars are healthy? Architecture, cores, total and free RAM,
thermal state where `/sys/class/thermal` exists. `GET /api/vision` already returns status to the
browser; it gets these fields added. The browser keeps its own checks (microphone, SpeechRecognition).

---

## 3. Offline technologies: candidates and what must be measured (Phase 3 preview)

Nothing below is to be installed until you approve Phase 3. Figures marked *(to verify)* are from my
knowledge, not measured on this machine.

### 3.1 OCR

| Candidate | Size | Notes |
|---|---|---|
| Tesseract 5 + `ara`, `fra`, `eng` | ~ tens of MB *(to verify)* | Simple, packaged for Arch and aarch64. Known to be weak on photographed, curved or glossy text. |
| PaddleOCR (detector + Arabic/Latin recogniser) exported to ONNX, run with ONNX Runtime | ~10–20 MB *(to verify)* | Usually better on photos. Needs ONNX Runtime (which also serves sherpa-onnx). |

**Same inputs:** the existing 31-case synthetic set (`e2e/read/make_plan_set.py`) and the print kit, scored
by the existing line-level scorer (`e2e/read/lines.ts`). Note: earlier you said "no Tesseract or other OCR at
this stage" for the reading feature. Evaluation here is benchmark-only unless you say otherwise.

### 3.2 Speech recognition

| Candidate | Notes |
|---|---|
| whisper.cpp (tiny / base / small, quantized) | Multilingual. Arabic is MSA-leaning, and Tunisian Derja quality is the big unknown. Small is likely several seconds per utterance on this CPU *(to verify)*. |
| sherpa-onnx | Streaming, lighter. Must check which Arabic and French models exist and their Derja quality. |

**Test audio problem:** the existing `e2e/live` fixtures are Edge-TTS-synthesized questions. Synthetic
speech overstates accuracy. A real Derja word error rate needs **real recordings** (for example 30–50 short
questions you record), scored as WER per language.

### 3.3 Local language model (llama.cpp, GGUF Q4)

Candidates in the 0.5–1.5 B range (for example Qwen2.5 0.5B/1.5B Instruct, Gemma 3 1B), about 0.4–1 GB
each *(to verify)*. With ~2.4 GB free RAM on this PC, larger models are unrealistic. Expect useful
command-like and short factual answers in MSA, French and English, and **probably poor Derja**. That is exactly what the
benchmark (`e2e/chat/eval.ts` cases, run against the local model, no Gemini quota) must show before
any routing decision.

### 3.4 Local vision-language model

Small VLMs (for example SmolVLM 256M/500M, Moondream) can run through llama.cpp. On this CPU, I expect an
image to take many seconds *(to verify)*. Most likely outcome: **not usable for continuous scans**,
possibly acceptable for an on-demand offline "describe", clearly labelled as limited. Hazards
stay with the MediaPipe detector either way.

### 3.5 Offline Arabic TTS: the hardest gap

Your requirement is a female voice only. Known options and their problems:

| Candidate | Problem |
|---|---|
| Piper | Its only Arabic voice that I know of (`ar_JO-kareem`) is **male** → excluded by your rule *(to verify for newer voices)* |
| Meta MMS-TTS (`ara`), VITS, runs in sherpa-onnx | License is **CC-BY-NC** (non-commercial). Voice is not selectable. |
| espeak-ng (female variants) | Tiny, fully free, ARM-ready, but robotic and hard to follow in Arabic |
| OS voice through browser `SpeechSynthesis` | On Linux this is speech-dispatcher, usually espeak underneath, so the same quality |

There is probably **no good, free, female, Tunisian offline voice today**. Options to discuss:
accept espeak-ng as the offline-only fallback (honest but rough), use MMS for non-commercial
testing only, or later train or fine-tune a voice (real work, and needs recordings with consent).
This needs your decision before Phase 3 picks anything.

### 3.6 OpenCV

Not needed now. Blur, brightness, change detection and the line pixel check are already plain
TypeScript and tested. Adding OpenCV would be an unnecessary dependency. I'd revisit only if a
feature needs it (for example perspective correction of a tilted page before OCR).

### 3.7 ONNX Runtime

Worth adding **only if** the benchmarks pick PaddleOCR and/or sherpa-onnx, since it then serves both.

---

## 4. Benchmark harness (Phase 6 preview)

One command per engine type, same inputs for every implementation, results as JSON + a Markdown summary
in a gitignored `bench/out/`:

- latency (median, p90), peak RSS of the sidecar (`/proc/<pid>/status`), CPU time, model file size;
- OCR: per-line correct / incorrect / withheld on the 31-case set (existing scorer);
- STT: WER/CER per language on recorded audio;
- LLM: the `e2e/chat` cases, scored the same way for old and new;
- offline availability: a run with the network namespace cut (`unshare -n`) proves it works offline, rather than just claiming it;
- cloud usage: call counts × published price per model (free tier = 0, with the quota used shown).

---

## 5. Smallest safe first implementation (proposed Phase 2, for your approval)

Default behaviour stays **identical** (`AI_MODE=cloud`). No new runtime dependency, no UI change.

1. **Capabilities on providers.** Add `locality` and `tasks` to `VisionProvider`. Gemini and OpenRouter declare
   what they do today. `withFallback` filters by task. Tests: existing 328 still pass; new tests prove the
   filtering and the `offline` mode refusal.
2. **`AI_MODE` switch** (`cloud | hybrid | offline`) in `ai/vision.ts`, plus precise spoken refusals in
   `phrases.ts` (four languages) for "this needs the internet".
3. **`deviceCapabilities.ts`** (server): internet probe, sidecar health, CPU, RAM, thermal. Exposed in `GET /api/vision`.
4. **Local OpenAI-compatible LLM provider**, off unless `LOCAL_LLM_URL` is set, declared for `chat` only
   (`limited`). It reuses the OpenRouter request code. Tested with a mock HTTP server, so no model download is needed for
   the tests.
5. **Separate interfaces for OCR, STT and TTS on the server** (`OcrEngine`, `SttEngine`, `ServerTtsEngine`) with the
   current Gemini transcription and Edge TTS as their first implementations. This is a refactor without behaviour change.

Steps 1–3 are small and mechanical. Steps 4–5 are the "major architectural changes" part, so each will
be shown to you before I make it. No model or tool is installed in Phase 2.

## 6. Decisions I need from you

1. Approve Phase 2 as described in §5 (or a subset, for example steps 1–3 only)?
2. Should Phase 1's uncommitted work be committed by you first (recommended)?
3. Offline TTS (§3.5): which direction to evaluate — espeak-ng, MMS (non-commercial), or research only?
4. OCR: may Phase 3 *benchmark* Tesseract/PaddleOCR, given your earlier "no OCR at this stage"?
5. Can you record ~30–50 real Derja questions later for honest speech-recognition scoring?
