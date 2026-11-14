# Nadhra AI: a second, independent AI provider next to Gemini

Status: **proposal for review. Nothing here is implemented.** Written 2026-11-14.
Builds on `OFFLINE_ARCHITECTURE_PROPOSAL.md` and Phase 2 (`OFFLINE_PHASE2_REPORT.md`).

## 1. What we are building

Two AI options. The user picks one in Settings, or by voice:

| | **Gemini AI** | **Nadhra AI** |
|---|---|---|
| What | The existing implementation, unchanged | Our own system: open-source models running on the device |
| Where data goes | Google (cloud), as today, with today's consent notices | Nowhere: everything runs on the machine running Nadhra |
| Needs | Internet, Gemini key, free-tier quota | A Nadhra machine (this PC now, an ARM64 device later) |
| Cost | Free tier (paid tier only with your approval) | Zero per use; electricity and disk only |

**Today's offline mode is not Nadhra AI.** It only stops cloud requests. Nadhra AI is the set of local engines
that will actually do the work. Phase 2's routing (`locality`, `tasks`, `router.ts`) is the base it plugs into.

Rules that don't change, whichever provider is chosen:
- the medicine and document reading rules (`document.ts`, `lineCheck.ts`): two independent readings, the
  pixel check, «قريت…» + "check with the pharmacist", no dose ever spoken from one reading or from a
  model's explanation;
- the on-device hazard layer (MediaPipe) and every safety rule in `schema.ts`;
- no paid API without your approval.

## 2. How the two coexist without breaking anything

### 2.1 One new field, absent by default

The browser adds `provider: "nadhra"` to its API requests only when Nadhra AI is selected. **A request
without the field is a Gemini request and is handled exactly as today** (same code path, same
providers, same order, same responses). The existing 352 tests, including the exact-match status test, stay as
they are and must keep passing.

On the server, the provider family becomes a routing input:

```
providersFor(task, family)      family = "gemini" (default) | "nadhra"
  gemini → today's chain: Gemini models, then OpenRouter where it is allowed today
  nadhra → local engines declared for that task (locality: "local"), never a cloud one
```

### 2.2 No silent switching between providers

- With **Nadhra AI** chosen, a task Nadhra can't do yet is **refused out loud**, never quietly sent to Google. For example: «نظرة ما تنجمش تعمل هاذي توّا. قول "استعمل جيميني" باش تستعمل Gemini.» Choosing Nadhra is often a privacy choice, and a silent fallback would break it.
- With **Gemini AI** chosen, Gemini's failures behave as today. Gemini never falls back to Nadhra on its own either. The user hears that Gemini is down and can switch.
- An optional, explicit setting, "use Gemini when Nadhra can't" (off by default), can come later if you want it. Using it would show Gemini's consent first.

### 2.3 Server policy vs user choice

`AI_MODE` (Phase 2) stays as the **server's policy** and decides which providers this machine offers:

| AI_MODE | Offered | Notes |
|---|---|---|
| `cloud` (default) | Gemini only | Today's deployment (Vercel): Nadhra isn't offered at all. Nothing changes |
| `hybrid` | Gemini and Nadhra | The user chooses; default stays Gemini |
| `offline` | Nadhra only | Nothing leaves the device |

A further switch, `NADHRA_AI_ENABLED` (off by default), keeps the option hidden until the engines are installed
and healthy. `GET /api/vision` reports which providers are offered, and which tasks each can do, so the page
never offers something that isn't there.

### 2.4 Where Nadhra AI runs

A **Nadhra machine** runs the existing Next.js server, plus the local engines as separate processes on 127.0.0.1
(see §4). The browser that uses it can be:

1. a browser on the same machine (now, on this PC);
2. the phone on the same Wi-Fi or a USB cable, opening the machine's address (testing);
3. later, the ARM64 device's own browser in kiosk mode, connected to the glasses' camera, microphone and speaker.

A phone using the public Vercel deployment can't use Nadhra AI, and the setting says so. Running
models inside the phone's browser (WebGPU/WASM) is a possible later path, not part of this plan.

## 3. How the user selects it (no redesign, no new button)

- **Settings sheet:** one more `select`, "AI" → "Gemini (Google, online)" / "Nadhra (on this device)", built like the existing language select. Under it, one line says what the chosen provider can and can't do yet, taken from the server's status. It is not a new main-screen button, so the single-screen, voice-first rule holds.
- **Voice:** «استعمل نظرة» / «استعمل جيميني» (and the French and English equivalents), parsed by `commands.ts` like the other commands.
- **Spoken confirmation after a switch.** For example, Nadhra: "Nothing leaves this device now. I can read printed text and answer simple questions. I can't describe scenes yet." Gemini: today's consent if it hasn't been given yet.
- **Stored with the other settings** (`settings.ts`). Default: Gemini.
- **Consent notices follow the provider.** Gemini keeps today's notices word for word. Nadhra gets its own short notice, which says what runs locally and what the device cannot do.

## 4. Engines: what Nadhra AI is made of

Every engine is a separate process with a small HTTP API on 127.0.0.1 and a health check. Each one is
described by a **manifest** (name, version, licence, download URL, SHA-256, size, measured RAM, architectures),
kept in the repo, with the model files outside it (for example `~/.local/share/nadhra/models`).
Swapping a model means changing a manifest, not app code. Only permissive licences
(Apache-2.0, MIT, BSD) go into the product. Non-commercial models (MMS, XTTS, F5) are for research
benchmarks only, and labelled as such.

| Task | Candidate engines | Licence | Status / evidence |
|---|---|---|---|
| **Hazards** (people, vehicles, objects) | MediaPipe EfficientDet-Lite0, already in the browser | Apache-2.0 | Exists, shared by both providers |
| **Reading printed text** (documents, medicine boxes) | **Reader A:** PaddleOCR PP-OCRv5 (Arabic + Latin recognisers, v6 detector) on ONNX Runtime. **Reader B:** Tesseract 5 (ara+fra+eng) | Apache-2.0 / MIT / Apache-2.0 | Benchmarked on mocks: Paddle 87 % lines exact, Tesseract 77 %; **their agreement had 0 real misreads** (Phase 2 report §3). Real photographs next |
| **Speech → text: commands** | Closed-vocabulary keyword spotting (sherpa-onnx KWS) for the fixed command list | Apache-2.0 | To evaluate: commands are a short fixed list, so a constrained recogniser can be reliable where free speech recognition isn't |
| **Speech → text: free questions** | whisper.cpp (base, small, quantized); Qwen3-ASR 0.6B/1.7B (in llama.cpp); Derja fine-tunes such as FarukSTT (Whisper large-v3, reported 32 % WER on Derja against >50 % for base Whisper, licence to check) | MIT / to check / to check | Derja is the weak point. Measured with your recordings (Phase 2 report §4) |
| **Text → speech** | **Nabra-82M** (female `af_msa` voice), espeak-ng as the basic fallback | Apache-2.0 / GPL-3.0 | See §4.1. Standard Arabic only; no free female Tunisian voice exists |
| **Image questions** ("what's in front of me?", "what colour is this?") | Small vision-language model through llama.cpp `llama-server`: SmolVLM2 (256M / 500M / 2.2B), Qwen2-VL-2B, InternVL3 1B/2B, Gemma 3 4B, Gemma 4 E2B (all in llama.cpp's multimodal list); Qwen3-VL-2B (Apache-2.0, support to confirm) | Mostly Apache-2.0; Gemma has its own terms | To benchmark. Expect seconds per image on this CPU, and weak Arabic |
| **Chat** (camera off) | The same vision-language model (one model in memory instead of two), or a small text model such as Qwen3 1.7B / Gemma 3 1B via llama.cpp | Apache-2.0 / Gemma terms | To benchmark on the `e2e/chat` cases. Derja expected weak |
| **Scene scans** (automatic descriptions, stairs, drops) | Not offered by Nadhra at first: a model that takes seconds per frame can't keep up with walking | — | Nadhra keeps the MediaPipe warnings, and says plainly that stairs and holes aren't detected (the existing no-guarantee notices). A dedicated small stairs/curb detector is possible later, but needs a dataset and training |
| **Web search** | None | — | Answers say live information can't be checked, as today without search |

### 4.1 Nabra-82M: what's known (investigation, nothing installed)

- **Licence:** Apache-2.0, following Kokoro-82M (Apache-2.0) and StyleTTS2 (MIT). The **training data isn't named**: before shipping it, ask the author where the recordings came from and under what consent.
- **Voice:** one **female** voice, `af_msa`. 24 kHz mono. **Standard Arabic only:** the card says it is not trained for dialects, so Derja words will be pronounced as MSA.
- **Front end:** needs diacritized input. The published pipeline is normalize → diacritize (camel-tools) → phonemize (espeak-ng) → Kokoro. camel-tools and its disambiguation data are the heavy part, and an inaccurate diacritizer gives wrong pronunciation.
- **Size and runtime:**
  - The weights are a 327 MB PyTorch file plus a 0.5 MB voice file; the published code runs on PyTorch.
  - Quality figures: none. The card gives no listening (MOS) score or error rate, only "real-time factor below 1 on CPU".
  - Base Kokoro has ONNX builds (about 90 MB int8) that run on ONNX Runtime and in sherpa-onnx. Exporting Nabra the same way is the likely ARM64 path, but **unverified**.
  - No published ARM CPU measurements were found for Kokoro either.
- **To measure (needs your approval to install, in the bench venv like the OCR engines):**
  - real-time factor and peak RAM on this PC, with PyTorch and after an ONNX export;
  - pronunciation on a fixed list of app sentences, with and without the diacritizer;
  - how Derja sentences sound;
  - the int8 quality loss.

## 5. Medicine and document reading with Nadhra AI

The rule stays: **two independent readings, the pixel check, and every `document.ts` check.** Only the readers change:

```
frame A ─ PaddleOCR ──┐                                  lines + boxes + confidence
                      ├─ ocrToReading() adapter ─ two "readings" in the same JSON shape Gemini returns
frame B ─ Tesseract ──┘        (deterministic, no AI)            │
                                                                 ▼
                     sanitizeDocument(first, confirm: second, inspect: lineCheck)   ← unchanged
```

- **Two different engines, as today with two different Gemini models.** On the mock set, the same engine on both frames repeated its own mistakes («5» for «50» in both frames), while Paddle with Tesseract agreed on no misread at all. The two families are never mixed (Gemini for A, Nadhra for B), because that would send a picture to Google while Nadhra AI is selected.
- **The adapter is plain code:**
  - lines come with their real boxes (OCR boxes are native, so Gemini's "locate" step isn't needed);
  - a line counts as `confirmed` only above a calibrated recogniser confidence;
  - the document kind and fields (name, strength, expiry) come from fixed rules (units, «ordonnance», «Dr», «EXP»…);
  - an unsure kind is treated as **medical**, the stricter path.
- **Picture quality comes from the device's own checks.** Blur, darkness, glare and cut edges are measured on the pixels, so they don't depend on a model admitting a problem.
- **No AI explanation, as today.** Nadhra doesn't phrase or explain medical text with a language model.
- **Handwriting is not read.** OCR on handwriting is unreliable. A handwritten prescription is refused with the reason, not guessed.
- **Gate:** Nadhra reading is switched on only after the real-photo kit sessions show **zero critical errors**. The pass criteria are the same as `PHASE1_REAL_CAMERA_TEST_PROTOCOL.md` §6. Until then it stays a benchmark.

## 6. PC first, then Linux ARM64

| Stage | What runs | Notes |
|---|---|---|
| **This PC** (x86_64, 2 cores, 7.6 GB, ~2.4 GB free, CPU only) | Next server, engines as user processes, Chromium | A good proxy for a small ARM board: if it fits here, it is close to fitting there |
| **Build check for ARM64** (no hardware) | Cross-compiled or QEMU-emulated builds of llama.cpp, whisper.cpp, sherpa-onnx; ONNX Runtime and Tesseract aarch64 packages | Proves everything builds and runs. **Not** speed |
| **ARM64 device** (when you decide; a 4–8 GB ARM64 board or puck connected to the glasses) | The same manifests with aarch64 builds, systemd user services, Chromium kiosk | Speeds, RAM and temperature measured again there. GPU/NPU acceleration (Vulkan, RKNN, Hailo…) only as an engine-launch option in the manifest, never in app code |

Glasses themselves usually don't have the compute for this. The realistic target is an ARM64 unit worn or
carried with them, linked by cable or a local network, which this design already assumes.

**RAM budget.** The engines can't all stay loaded on a 4 GB device, so they start on demand and stop after an idle time:

| Component | Rough RAM | Resident? |
|---|---|---|
| OS + Chromium + Next server | 0.8–1.2 GB | always |
| MediaPipe (in the browser) | ~100 MB | always (safety layer) |
| Keyword spotting (commands) | <100 MB | always |
| OCR pair | ~0.6 GB measured (Paddle 561 MB, Tesseract 136 MB) | during a reading |
| Speech recognition (whisper base/small) | 0.2–1 GB | while listening to a question |
| Text-to-speech (Nabra ONNX / espeak-ng) | 0.1–0.4 GB (to measure) | while speaking |
| Vision-language model 1–2B, Q4 | 1–2 GB | on demand |

`deviceCapabilities.ts` (Phase 2) already reports free memory and temperature. The engine launcher uses them to
refuse loading a model that won't fit, and to say why, instead of letting the system swap or freeze.

## 7. Modular, low-cost, independent

- Each engine sits behind the same provider interface. Its `tasks` are declared from **benchmarks**, never assumed.
- Models are replaceable through manifests. No engine is linked into the app; each is a process with an HTTP API.
- No paid API and no account. Model downloads are pinned and checksummed. Disk: about 1–3 GB of models for the first set.
- Licences are recorded per model in its manifest, and a test fails if a manifest lacks one or uses a non-commercial licence outside `bench/`.
- No Docker requirement (it adds RAM and complexity on ARM boards), though it can be offered later for the PC.

## 8. Testing Nadhra AI without changing Gemini

1. **Gemini is frozen by tests:**
   - all 352 current tests pass unchanged;
   - new tests prove that a request without `provider` produces exactly today's upstream calls and responses, and that `GET /api/vision` stays the same in cloud mode.
2. **Nadhra engines are faked in unit tests:** small HTTP fakes, as the Gemini tests fake Google. No model is needed to run `npm test`.
3. **The same safety tests run for both providers.** The reading invariants (`phase1Safety`, `safetyInvariants`, `document.test.ts`) are run with Nadhra-shaped readings from the adapter as well.
4. **Same inputs for both providers in benchmarks:**
   - the 31-case mock set and the real-photo kit sessions (reading);
   - the `e2e/chat` cases (chat);
   - your Derja recordings (speech);
   - a fixed set of scene photos (image questions).
   Gemini runs only with your approval and quota. Nadhra runs are free, and run with the network blocked.
5. **Browser end to end:** the existing fake-camera e2e scenarios, with Nadhra selected and engines faked, then once with the real engines on this PC.
6. **Off by default:** `NADHRA_AI_ENABLED` unset means the option doesn't exist and the production deployment is untouched.

## 9. Proposed order of work (each step stops for your approval)

| Step | Content | Done when |
|---|---|---|
| **N1** Selection plumbing | `provider` field, Settings select, voice commands, consent per provider, status per provider; Nadhra declares **no task** yet and refuses honestly | Gemini byte-identical (tests); Nadhra refuses every task out loud |
| **N2** Engine runtime | Manifests, launcher (on-demand start/stop, health, RAM check), no models in the app | Starts and stops fake and real engines on this PC; refuses when RAM is short |
| **N3** Nadhra reading | OCR pair + adapter → unchanged `document.ts` | Real-photo kit: zero critical errors under the protocol's criteria; then a flag turns it on |
| **N4** Nadhra voice out | espeak-ng fallback, then Nabra-82M if its evaluation passes | Your listening approval of a fixed sentence list |
| **N5** Nadhra commands and questions by voice | Keyword spotting, then free speech recognition | Derja plan thresholds (95 % commands quiet, 85 % noisy) |
| **N6** Nadhra image questions and chat | VLM through llama-server, declared `limited` | Benchmark on fixed scene photos; honest refusals for what it can't do |
| **N7** ARM64 | aarch64 builds, device bring-up, re-measurement | Same tests and benchmarks on the device |

Research that can continue meanwhile, without integration:
- the OCR benchmark on your real photographs;
- the Nabra-82M measurements (after you approve installing it in the bench venv);
- the Derja evaluation once the recordings exist.

## 10. Decisions needed

1. Approve this architecture (or change it): provider field, no silent fallback, `AI_MODE` as server policy, `NADHRA_AI_ENABLED`.
2. Approve **N1** as the first implementation step?
3. May I install Nabra-82M (and its diacritizer) in the separate bench environment to measure it?
4. The wording of the Nadhra switch and refusal sentences in Derja: draft them for your review in N1?

Sources:
- [Nabra-82M model card](https://huggingface.co/oddadmix/Nabra-82M-v0.1) and [files](https://huggingface.co/oddadmix/Nabra-82M-v0.1/tree/main)
- [llama.cpp multimodal models](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)
- Qwen3-VL-2B licence (third-party listings): [Qualcomm AI Hub](https://aihub.qualcomm.com/mobile/models/qwen3_vl_2b_instruct), [Unsloth GGUF mirror](https://mixpeek.com/model/unsloth/Qwen3-VL-2B-Instruct-GGUF)
- Kokoro on CPU/ARM (no reliable ARM benchmark found): [PromptQuorum](https://www.promptquorum.com/power-local-llm/best-local-tts-raspberry-pi), [OCDevel](https://dev.ocdevel.com/blog/20260711-quantized-cpu-tts)
- Derja ASR: [FarukSTT](https://huggingface.co/medyas/FarukSTT), [SLURP-TN](https://arxiv.org/pdf/2603.21940), [TUNIFRA, ArabicNLP 2025](https://aclanthology.org/2025.arabicnlp-main.5.pdf)
- Earlier TTS and OCR sources: `OFFLINE_PHASE2_REPORT.md` §2–3
