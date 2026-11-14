# Offline track, Phase 2 report

Written 2026-11-14 (night of 13–14 Nov). Approved scope: steps 1–3 of `OFFLINE_ARCHITECTURE_PROPOSAL.md` §5,
offline Arabic TTS research (no install), an independent OCR benchmark (not integrated), and a Derja speech
evaluation plan. **Nothing committed, pushed or deployed. No Gemini quota used.** The reading pipeline
(`document.ts`, `lineCheck.ts`, the reading prompts, the two-readings rule) is untouched.

---

## 0. Uncommitted work before this phase

Before Phase 2 started, the tree held 30 modified files and 17 untracked entries. Sixteen of the
untracked entries were Phase 1 and response-quality work; the seventeenth was
`docs/OFFLINE_ARCHITECTURE_PROPOSAL.md` from the audit. Baseline: `tsc --noEmit` clean, `npm test` 328/328.

### Modified (30), by purpose

| Group | Files |
|---|---|
| Medicine and document reading (roadmap Phase 1, rounds 1–4) | `src/lib/ai/vision.ts` (two readings, locator, pixel check, test capture), `src/app/api/vision/route.ts` (read mode, second frame, document context), `src/lib/assistant/controller.ts` (voice-only reading, consent notice, document memory, double frames, reminders), `src/lib/assistant/frameAnalysis.ts` (sharp-tile check), `src/lib/assistant/cameraSource.ts` (`captureStill`), `src/lib/assistant/commands.ts` (reading commands), `src/lib/assistant/schema.ts` (`mentionsDose`), `src/lib/assistant/types.ts`, `src/lib/assistant/speechQueue.ts` (repeated check sentences no longer dropped), `src/lib/speech/tts.ts` (slash in dates and fractions) |
| Wording, languages, settings | `src/lib/assistant/phrases.ts`, `src/lib/assistant/uiText.ts`, `src/lib/assistant/settings.ts` (automatic descriptions off by default, reading consent), `src/lib/assistant/lang.ts` (Derja/Arabizi detection, `previous` language) |
| Response quality (separate request, 13 Nov) | `src/lib/assistant/prompts.ts` (answer rules, Arabizi hint, reading/locate prompts), `src/lib/live/config.ts` (two Live prompt lines), `lang.ts` |
| Server and monitoring | `src/lib/server/monitor.ts` (event name), `src/lib/assistant/api.ts` (report event) |
| UI | `src/components/Assistant.tsx` (7 lines) |
| Dependencies | `package.json` + `package-lock.json`: `jpeg-js` 0.4.4 (server-side JPEG decoding for the pixel check) |
| Tests | `tests/controller.test.ts`, `tests/visionRoute.test.ts`, `tests/visionClient.test.ts`, `tests/languages.test.ts`, `tests/tts.test.ts` |
| Browser tests | `e2e/vision.mjs`, `e2e/redesign.mjs` |
| Docs and config | `docs/ARCHITECTURE.md`, `.gitignore` (`e2e/read/out`, `e2e/chat/out`) |

### Untracked (16 Phase 1 entries, + the audit proposal)

- `docs/PHASE1_*.md` (9): reader report, safety/privacy review, real-world plan, Android checklist, safety fixes, round 3 and 4 reports, real-camera protocol, legal review checklist.
- `src/lib/assistant/document.ts`, `src/lib/assistant/lineCheck.ts`: the reading checks and the no-AI pixel check.
- `tests/document.test.ts`, `tests/lineCheck.test.ts`, `tests/responseQuality.test.ts`.
- `e2e/read/` (19 scripts: mock documents, 31-case plan, scorers, real-camera tools) and `e2e/chat/` (A/B eval with baselines).

### Risks of keeping this uncommitted

1. **No restore point.** About 2,350 changed lines and 5,500 new lines exist only in the working tree.
   A `git checkout .`, `git stash` or `git clean` mistake, or a disk failure, loses all of them.
   Suggestion: a backup outside the repo, for example
   `git diff > ~/nadhra-wip.patch && tar czf ~/nadhra-untracked.tgz $(git ls-files -o --exclude-standard)`.
   I haven't done this.
2. **`e2e/read/__pycache__/*.pyc` is not ignored.** `git add -A` would commit it.
3. **The two tracks now share files.** The offline-track edits sit in files Phase 1 also changed (`vision.ts`,
   `route.ts`, `controller.ts`, `phrases.ts`, `types.ts`, `ARCHITECTURE.md`, `controller.test.ts`). Committing
   the phases separately would need `git add -p`. §1 lists every offline-track change.
4. **The 09:05 reading test is not running.** The strict waiter
   (`…/199d28ce…/scratchpad/wait_and_run.sh`) has no process: it was not running when this phase started,
   probably ended with its session. Nothing will start at 09:05 unless it is restarted. I did not restart it.
5. **That test imports `src/lib/ai/vision.ts`,** which this phase changed. In the default `cloud` mode the
   provider order is proved identical by a test (`aiRouter.test.ts`, last test), and all 30 existing route
   tests pass unchanged. The `.next` production build the browser part uses was backed up before my build
   check and restored afterwards (same `BUILD_ID` `wOSZYtHBvnIXnO9tKrJxQ` and timestamp).

---

## 1. Phase 2 implementation (steps 1–3)

### What changed

| Step | Files | Behaviour |
|---|---|---|
| 1. Capabilities | `src/lib/ai/router.ts` (new), `src/lib/ai/vision.ts` | Each provider declares `locality` (`local`/`cloud`) and `tasks`. Gemini declares scan, question, chat, read and transcribe. OpenRouter declares scan, question and chat (never documents, as before). Calls are routed by task (`providersFor`). |
| 2. Modes | `router.ts`, `vision.ts`, `api/vision/route.ts`, `api/vision/transcribe/route.ts`, `api/live/token/route.ts`, `server/liveToken.ts`, `speech/edgeTts.ts`, `live/session.ts`, `assistant/controller.ts`, `assistant/phrases.ts`, `assistant/types.ts` | `AI_MODE=cloud` (default, unknown values too), `hybrid` or `offline`. A task the mode rules out answers 503 `offline-mode` or `no-internet` before any budget is counted, and the page says why (new `offlineMode` sentence in 4 languages). Offline mode turns off the Edge voice (the device voice speaks), Live, and the browser's cloud speech recognition. |
| 3. DeviceCapabilities | `src/lib/server/deviceCapabilities.ts` (new), `api/health/route.ts` | Architecture, CPU, load, MemAvailable, hottest thermal zone, AI mode, internet state; per-task routing summary. Shown only with the health token. The internet probe runs in **hybrid mode only**. |
| Docs | `docs/ARCHITECTURE.md` (new section), `.env.example` (`AI_MODE`, `INTERNET_PROBE_URL`), `.gitignore` (`bench/out`) | |

### Guarantees and how they're tested

- **Default unchanged.**
  - Cloud mode routes to the same providers in the same order for every task (test).
  - `GET /api/vision` returns exactly the same JSON as before: `mode` is left out in cloud mode, and the existing deep-equal test passes untouched.
  - No probe or other new request in cloud mode (tests).
- **Never a task a provider doesn't declare:** checked for every mode × task combination.
- **Offline sends nothing.** Every vision mode (streamed too), medicine questions, transcription, TTS and the live token are refused with zero upstream calls (tests). The status lists no company as a recipient.
- **Honest wording.** The no-internet sentence claims on-device warnings work only when the detector is running (test).
- **Real server smoke test.** I built for production and ran `next start` with `AI_MODE=offline`: all routes refused with `offline-mode`, and the status was `{"mode":"offline","available":false,"providers":[]...}`.

Results: `tsc --noEmit` clean; **352/352 tests** (the 328 existing, unchanged, plus 24 new in
`tests/aiRouter.test.ts`, `tests/aiMode.test.ts`, `tests/deviceCapabilities.test.ts` and 3 in
`tests/controller.test.ts`); `next build` passes.

### Known limits (stated, not hidden)

- **Offline mode today is a strict "warnings only" mode.** No on-device AI engine is wired in yet (steps 4–5 not approved). So in offline mode:
  - Descriptions, questions, reading and voice questions are refused out loud.
  - The MediaPipe hazard warnings and the device voice keep working.
- **No voice input in offline mode until there is on-device transcription.** That's the cost of not sending the voice to Google.
- **The page learns the mode from `GET /api/vision` at start.** Until that answer arrives (a fraction of a second after load), the voice-input choice doesn't know the mode yet. A user would have to speak before the page finished loading to hit this.
- **`hybrid` currently behaves like `cloud`.** It adds the reachability probe and the fast `no-internet` refusal. That changes once a local provider exists.
- **The Derja wording of `offlineMode` needs your review:** «المساعد مضبوط باش يخدم بلاش إنترنت، وهاذا يستحقّ الإنترنت.»

---

## 2. Offline Arabic TTS: research (nothing installed)

Requirement: female voice only, Tunisian preferred, free, offline, ARM64.

| Option | Arabic quality | Female? | Licence | ARM64 / memory | Verdict |
|---|---|---|---|---|---|
| **espeak-ng** | Formant synthesis: robotic, needs diacritized text to pronounce Arabic well | Yes, through variants (`+f2` etc.) | GPL-3.0, free for any use | Native C, a few MB, negligible CPU; packaged everywhere | The only option that is free, female and tiny. Intelligible but unpleasant: an emergency fallback, not a daily voice |
| **Piper** (`ar_JO-kareem`) | Good neural MSA voice with a Jordanian base | **No, male** (the only Arabic voice in the official `piper-voices` repo, `ar/ar_JO`) | Code MIT/GPL; this voice is labelled non-commercial on aggregators (to confirm on its model card) | Excellent: VITS ONNX, runs on Raspberry Pi-class CPUs | **Excluded** by the female-only rule |
| **Meta MMS-TTS** (`facebook/mms-tts-ara`) | Neural VITS, MSA-oriented, one fixed speaker | Not selectable | **CC-BY-NC 4.0** (non-commercial) | VITS, ONNX-exportable (sherpa-onnx runs MMS models), roughly 100–150 MB | Usable for **non-commercial testing only**. Voice gender is whatever the training data gave |
| **Nabra-82M** (Kokoro-82M fine-tuned for MSA) | Modern neural quality reported; pipeline: diacritizer (camel-tools) → espeak-ng phonemes → Kokoro | Not stated | Kokoro base reported Apache-2.0; Nabra's own licence **unconfirmed** | 82 M parameters: realistic on ARM CPU | **Most promising for MSA.** Needs licence and voice check. Not Derja |
| **Tunisian-TTS** (XTTS-v2 fine-tune, `Nouira-Oussema/Tunisian-TTS`) | The only ready Tunisian model found; voice cloning from a 6–30 s clip | Any (cloning) | Page header says CC-BY-NC-4.0 while its notes say MIT; base XTTS-v2 is **Coqui Public Model License, non-commercial**; gated | XTTS is large (GPT-style, ~1.8 GB class); slow on CPU, unrealistic on glasses | Interesting for research, **not deployable**: licence and size |
| **Habibi** (F5-TTS based, multi-dialect) | Zero-shot dialectal synthesis | Any (voice prompt) | Licence unstated; F5-TTS's own weights are CC-BY-NC | F5-TTS is ~335 M parameters, slower than real time on CPU in reports | **Tunisian not listed** among its demo dialects; not deployable |
| **TunArTTS** (Elyadata) | Tunisian single-speaker dataset and ESPnet training recipes | Speaker not stated | Repo licence file not shown on the page | Recipes, not a ready model | A **path to training our own** Tunisian voice, not a voice |
| Browser `SpeechSynthesis` on Linux | Usually speech-dispatcher → espeak-ng | As espeak-ng | — | — | Same as espeak-ng |

**Conclusion:** I found no free, commercially usable, female, Tunisian offline voice. Realistic paths, in order:

1. **Now:** keep the cloud female Derja voice when online. Use espeak-ng (female variant) as the honest offline
   fallback, and say once that the offline voice is a basic one.
2. **Evaluate** Nabra-82M: licence, voice gender, Arabic diacritization quality, RTF on this CPU. If it's acceptable, it is a reasonable
   offline **MSA** voice.
3. **Long term:** train or fine-tune a small female Tunisian voice (VITS/Piper or Kokoro-style) on
   recordings made with consent. This is real work (data, legal consent, GPU time) and needs your decision.

Sources:
- [rhasspy/piper-voices `ar`](https://huggingface.co/rhasspy/piper-voices/tree/main/ar)
- [facebook/mms-tts-ara](https://huggingface.co/facebook/mms-tts-ara)
- [Nabra-82M](https://huggingface.co/oddadmix/Nabra-82M-v0.1)
- [Tunisian-TTS](https://huggingface.co/Nouira-Oussema/Tunisian-TTS)
- [XTTS-v2 licence](https://huggingface.co/coqui/XTTS-v2/raw/v2.0.3/README.md)
- [Habibi](https://swivid.github.io/Habibi/) ([paper](https://arxiv.org/abs/2601.13802))
- [F5-TTS](https://github.com/SWivid/F5-TTS)
- [TunArTTS](https://github.com/elyadata/TunArTTS)
- [Piper Arabic voice listing (third party)](https://voicechanger.live/text-to-speech/arabic)

Licence claims from third-party pages are marked as such. Read every model card before use.

---

## 3. OCR benchmark (independent, not integrated)

**Setup**
- Engines live in a separate virtualenv (`~/.cache/nadhra-bench/venv`, 427 MB), outside the project. No app dependency was added.
- Scripts: `bench/ocr/run_ocr.py` (one engine per process) and `bench/ocr/score.ts` (uses the app's own `normForMatch`). Output goes to `bench/out/` (gitignored).
- **Inputs:** the same 31 cases × 2 frames as the Gemini reading test (`e2e/read/out/plan`). These are rendered mock documents, not photographs.
- Engines:
  - **Tesseract 5.5.4** (ara+fra+eng), `tessdata_fast` and `tessdata_best`;
  - **PaddleOCR PP-OCRv5** mobile recognisers (Arabic + Latin, best score per box) with the PP-OCRv6 small detector, on ONNX Runtime 1.32 through RapidOCR.
- **Machine:** this PC: i5-5300U, 2 cores / 4 threads, CPU only.

**Offline check:** both engines ran with every Python socket call blocked (`NO_NETWORK=1`), and the block was itself verified to stop a request. A network-namespace test (`unshare -rn`) is not permitted in this sandbox; repeat it on the PC or device.

| Engine | Lines exact | Mean CER | Arabic exact | Latin exact | Numbered lines right | Number errors | Hidden text read | Same in both frames | Median ms/image | Peak RSS | Model |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tesseract-fast | 77.7 % | 0.154 | 25.0 % | 79.0 % | 78.9 % | 12 | 1 | 73.6 % | 326 | 109 MB | 6.4 MB |
| tesseract-best | 77.4 % | 0.156 | 25.0 % | 78.8 % | 79.3 % | 12 | 1 | 74.0 % | 561 | 136 MB | 30.5 MB |
| paddle-v5 (ONNX) | **86.6 %** | **0.070** | **58.3 %** | **87.3 %** | **90.0 %** | **7** | **0** | **85.1 %** | 4,470 | 561 MB | 24.7 MB |

235 visible lines per frame, 470 in all. **Only 6 Arabic lines per frame** (12 in all), so the Arabic figures are anecdotes, not
measurements.

**Dangerous misreads seen**
- **Tesseract:**
  - «0,5 %» → «5 %» (10×), on a line hidden in the picture's must-not-say list;
  - «50» → «5» (M16b, M19: glare and a finger), identical in **both frames**;
  - «1 g» → «19»;
  - «Lot : 9C330» → «930»;
  - Arabic CER 0.74.
- **PaddleOCR:**
  - «LOT 3H771» → «3H7» (truncated);
  - handwriting «1 gélule» → «19 e e»;
  - «PER 09-27» → «0927»;
  - the Arabic expiry date dropped (M12). That is an omission, not a wrong value.
  - Its other two "number errors" are dropped list numbers («3)» before a medicine name).

**The two-readings rule with OCR as the readers.** Engine A reads frame A, engine B reads frame B, and only lines both give word for word count:

| Readers | Agreed lines | Real misreads among them | Coverage of visible lines |
|---|---|---|---|
| Paddle + Paddle | 209 | 2 («500 ma» for «500 mg»; «gastronl 20») | 85.1 % |
| Tesseract + Tesseract | 182 | 5, 4 with numbers («5» for «50» twice) | 74.0 % |
| **Paddle + Tesseract** (either order) | 182–185 | **0** | 76–77 % |

All other "disagreements with the ground truth" were scorer artifacts:
- table rows merged («Glycémie à jeun 1,26 g/l», printed on two lines);
- «½» read as «1/2».

Two **different** engines failed differently, so their agreement filtered every real misread in this set, much as
two different Gemini models do today. The same model twice agreed on its own mistakes.

**What this does and doesn't show**
- These are rendered mocks with clean fonts, so real photographs will be worse.
- The Arabic sample is tiny.
- Handwriting is a calligraphic font.
- No pixel check was applied here: in the app every agreed line would still go through `lineCheck.ts` and the other `document.ts` rules.
- The Gemini test's 63 % coverage (round 3) is measured *after* all checks, so it is not comparable.
- The result is still enough to say:
  - Tesseract alone is unsafe for numbers.
  - PaddleOCR is clearly better but 8–14× slower here (4.5 s per image, two recognisers per box; the cost could be cut by picking one recogniser by script).
  - Paddle + Tesseract is a credible pair of **independent offline readers** for a future integration, subject to real photographs and Arabic print.

**Repeat:**
```bash
V=~/.cache/nadhra-bench/venv/bin/python
for e in tesseract-fast tesseract-best paddle-v5; do NO_NETWORK=1 $V bench/ocr/run_ocr.py $e e2e/read/out/plan bench/out/$e.json; done
PAIRS="paddle-v5,paddle-v5;tesseract-best,tesseract-best;paddle-v5,tesseract-best;tesseract-best,paddle-v5" \
  node --experimental-strip-types --conditions=react-server bench/ocr/score.ts e2e/read/out/plan/plan.json bench/out tesseract-fast tesseract-best paddle-v5
```
Full per-case tables: `bench/out/ocr-summary.md`.

Installed for this benchmark only, all inside `~/.cache/nadhra-bench`:
- Python packages: `tesserocr` (bundles libtesseract 5.5.4), `rapidocr`, `onnxruntime`, `python-bidi`, Pillow, numpy;
- Tesseract `ara`/`fra`/`eng` data (fast and best);
- RapidOCR's ONNX models, downloaded by RapidOCR from modelscope.cn.

Delete that folder to remove everything.

---

## 4. Tunisian Derja speech recognition: evaluation plan

Nothing blocks on this. The plan is ready for when you provide recordings.

**Recordings (you)**
- 40 utterances, 16 kHz or higher, mono WAV, phone microphone at normal distance:
  - 12 questions about the scene («شنوة قدّامي؟», «فمّا مدارج؟»);
  - 10 app commands («وقّف», «اقرالي الدوا», «عاود», «شعّل الوصف التلقائي»);
  - 10 general questions;
  - 8 code-switched or Arabizi-style utterances (Derja + French: «chnowa el heure», «اقرالي l'ordonnance»).
- Two conditions if possible: a quiet room, and street or kitchen noise (same sentences, 20 + 20 is enough).
- More than one speaker helps (for example you plus one or two people, with consent). Speaker gender and age band go in the manifest, nothing else.
- **No personal data** in the sentences (no names, addresses, medicines you actually take).
- Folder outside git, for example `~/nadhra-speech/derja-v1/`, with `manifest.jsonl` lines:
  `{"file":"q01_quiet.wav","text":"شنوة قدّامي؟","category":"scene","condition":"quiet","speaker":"s1"}`.
  `text` is written exactly as said, in Arabic script (Latin words in Latin script).

**Engines to compare (same files, each run 3× for timing)**
- whisper.cpp `tiny`, `base`, `small` (quantized), language forced to Arabic and auto.
- sherpa-onnx: whisper ONNX, plus any Arabic streaming model available.
- Optional, only with your approval: the current cloud path (Gemini transcription) as a reference. That uses quota, about 40 calls.

**Metrics**
- WER and CER after the app's `normalizeArabic` and digit normalization; per category, condition and speaker.
- **Command accuracy:** the transcript goes through the app's own `parseCommand`; the share giving the intended command. This is the number that matters most for a voice-first device.
- **Language accuracy:** does `questionLang` on the transcript give `tn`?
- Real-time factor, peak RSS, model size; offline run with networking cut.

**Decision rule (proposal):** a local engine is declared `full` for `transcribe` only if command accuracy is
95 % or more in the quiet condition and 85 % or more in noise. Otherwise it is `limited`, or not used. Free questions can then still go
to the cloud in hybrid mode.

**Caveat:** synthetic speech (the Edge-TTS question files in `e2e/live`) may be used to check that the harness runs, never as
the quality result.

---

## 5. Decisions needed

1. **The 09:05 reading test:** the waiter isn't running. Restart it, run it by hand later, or drop it?
2. **Review the Derja `offlineMode` sentence** (§1).
3. **Offline voice direction:**
   - espeak-ng fallback now;
   - evaluate Nabra-82M (install it in the bench venv, as for OCR);
   - and/or plan a self-trained Tunisian voice.
4. **OCR next step** (still not in the app):
   - a real-photo run with the printed synthetic kit;
   - an Arabic-heavy mock set;
   - a faster single-recogniser Paddle variant;
   - or a design for Paddle + Tesseract as offline readers under the unchanged `document.ts` rules.
5. **When to approve steps 4–5** (local LLM provider, server-side OCR/STT/TTS interfaces).

---

## 6. Review of this report and remaining risks (added 2026-11-14)

Done since the report was first written:
- **Backup** at `/home/hello/nadhra-backups/2026-11-14_0017`: a full snapshot (everything except `node_modules`) plus a git-route patch and untracked archive, with `RESTORE.md` and `SHA256SUMS`.
  Verified:
  - checksums OK;
  - snapshot identical to the live tree;
  - git route byte-identical (138 files) with the same `git status`;
  - the restored copy passes `tsc` and 352/352 tests.
- **`__pycache__/`** added to `.gitignore`. The `.pyc` files stay on disk; `git add -A` no longer picks them up.
- **OCR on real photographs is prepared, not run.** No real photos exist yet (`e2e/read/out/session-demo` is synthetic).
  The OCR scorer now takes the real-camera protocol's `labels.csv` (`LABELS=…`), with hidden fields scored as hidden text.
  It was checked on the demo pair. Benchmark versions are pinned in `bench/ocr/requirements-bench.txt` and model checksums in `bench/ocr/models.sha256`.

Remaining risks of Phase 2, honestly:

1. **Possible silence in offline mode.** With the Edge voice off, speech falls back to the browser's installed voice.
   On a Linux PC without an Arabic system voice (espeak-ng isn't installed here), that may be the wrong language or nothing.
   For a blind user that is the most serious gap. It only affects `AI_MODE=offline`, which nobody uses yet. Not tested in a real browser.
2. **Android's "device" voice may itself be online.** Google's TTS on Android can use network voices, so "nothing leaves the device" holds on the
   server side but can't be fully promised for the phone's own voice.
3. **Some notices still mention Google in offline mode** (reading consent, live consent, camera notice). Nothing is sent, and the
   refusal follows, but the wording is misleading. To fix with the per-provider notices (Nadhra proposal §3).
4. **The internet probe is a request to Google** (hybrid mode only, every 30 s while used). It reveals the device's address to Google.
   It is configurable (`INTERNET_PROBE_URL`), and could point to a neutral host.
5. **The status chip in hybrid mode with no internet** reads "analysis service unavailable" rather than "no internet".
   Cosmetic, but it is not the precise reason.
6. **`AI_MODE` is a server-wide setting**, not a user choice. That is intended (policy), and the user choice comes with Nadhra AI.
7. **Coverage of the tests:** the new behaviour is unit-tested and smoke-tested over HTTP on a production build. No real-browser e2e run of
   offline mode was done.
8. **The scheduled 09:05 reading test is not running** (§0). Left as you asked. When it does run, it uses the Phase-2 `vision.ts` in cloud mode;
   routing order is identical by test.
9. **Benchmark supply chain:** the OCR engines and models come from PyPI, GitHub (tessdata) and modelscope.cn. They are now pinned and
   checksummed, but they were not reviewed beyond that. They live only in `~/.cache/nadhra-bench`, never in the app.
10. **Report accuracy:** I re-checked the numbers against the outputs. Test count: 328 + 24 = 352. The OCR table matches `bench/out/ocr-summary.json`.
    The "0 real misreads" for Paddle + Tesseract is on 31 rendered mock cases with 12 Arabic lines. It is not evidence about real photographs.
