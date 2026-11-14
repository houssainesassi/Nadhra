# The first real Nadhra engine: proposal

Status: **proposal for review, written 2026-11-14. Nothing has been downloaded, installed, executed or connected,
and no code has been changed.** It builds on `NADHRA_AI_PROPOSAL.md` (architecture), `OFFLINE_PHASE2_REPORT.md` §3
(OCR measurements on this PC) and N2 (`src/lib/server/engines/`).

## 1. Recommendation

The first engine should be **the OCR pair for reading printed text**, as two engines that are started and stopped separately:

| Role | Engine | Licence |
|---|---|---|
| **Reader A** | PaddleOCR PP-OCRv5 mobile recognisers (Arabic, Latin) + a PaddleOCR text detector, on ONNX Runtime | Apache-2.0 (models, conversion), MIT (ONNX Runtime) |
| **Reader B** | Tesseract 5 with `ara+fra+eng` trained data | Apache-2.0 (code and data), BSD-2 (Leptonica) |

Why this one first:
- **It is the only Nadhra task with a measured safety result.**
  - On the 31-case mock set, Paddle and Tesseract as two *independent* readers agreed on 182–185 lines, with **0 real misreads**.
  - The same engine twice repeated its own mistakes («5» for «50» in both frames).
  - This matches the app's existing two-readings rule (`document.ts`), which stays unchanged.
- It is **small**: about 0.7 GB for both together, measured. No language model is involved and nothing is generated, so nothing can be invented.
- It is the most useful offline ability for a blind user: medicine boxes, letters, bills.

Not first, and why:

| Task | Best candidates (permissive) | Why not now |
|---|---|---|
| Image questions, chat | llama.cpp (MIT) + SmolVLM2 / Qwen2-VL-2B (Apache-2.0) | 1–2 GB, seconds per image on this CPU, weak Arabic, untested; a language model can invent things |
| Speech → text | whisper.cpp (MIT), sherpa-onnx (Apache-2.0) | Derja is the weak point; it needs your recordings to measure (plan in `OFFLINE_PHASE2_REPORT.md` §4) |
| Text → speech | none acceptable | Nabra-82M rejected (licence provenance, pronunciation). Piper's Arabic voice is male. espeak-ng is GPL-3.0, outside the permissive rule |

## 2. Comparison (measured on this PC unless marked)

PC: i5-5300U, 2 cores / 4 threads, AVX2, 7.6 GB RAM (about 2.3 GB free in use), no GPU. Mock documents: 31 cases × 2 frames.

| | PaddleOCR (ONNX) | Tesseract `tessdata_best` | Tesseract `tessdata_fast` |
|---|---|---|---|
| Lines read exactly | **86.6 %** | 77.4 % | 77.7 % |
| Character error rate | **0.070** | 0.156 | 0.154 |
| Arabic lines exact (only 12 lines: anecdotal) | 58.3 % | 25.0 % | 25.0 % |
| Number errors | 7 | 12 | 12 |
| Time per image (median) | 4.5 s | 0.56 s | 0.33 s |
| Peak memory | 561 MB | 136 MB | 109 MB |
| Model files | 24.7 MB | 30.5 MB | 6.4 MB |
| CPU | x86_64 and aarch64: ONNX Runtime ships both (Python wheels; Node packages list Linux arm64 CPU) | Native C/C++, packaged for both | same |
| Startup (load) | **Not measured separately.** Expected a few seconds (Python + ONNX Runtime + 3 models): to measure first (§7, step 0) | Expected under 1 s: to measure | same |
| ARM speed | **Unknown**: must be measured on the device. A small ARM core is often slower than one of this PC's cores | Unknown | Unknown |

Known weaknesses:
- **Arabic.** Paddle's Arabic recogniser card states 81.3 % line accuracy, trained on a small set (2,676 images). The Arabic sample in our test was 12 lines. Real Arabic print must be measured.
- **Speed.** Paddle runs both recognisers on every box: 4.5 s per image. Choosing one recogniser by script should roughly halve that; to measure.
- **Mocks, not photographs.** Real photographs (glare, angle, blur) will be worse. The protocol in `PHASE1_REAL_CAMERA_TEST_PROTOCOL.md` is the gate.

## 3. Licences and official sources (verified 2026-11-14)

| Item | Licence | Official source | Note |
|---|---|---|---|
| PaddleOCR (code) | Apache-2.0 | github.com/PaddlePaddle/PaddleOCR | |
| `arabic_PP-OCRv5_mobile_rec` | Apache-2.0 | huggingface.co/PaddlePaddle/arabic_PP-OCRv5_mobile_rec (official organisation) | Paddle inference format |
| `latin_PP-OCRv5_mobile_rec` | Apache-2.0 | huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec | French is shown in its sample output, not listed by name |
| PP-OCRv6 small detector | PaddleOCR: Apache-2.0 | Its official page **couldn't be accessed** (HTTP 401) | **Provenance to confirm.** Fallback: the official PP-OCRv5 mobile detector (same licence) |
| ONNX conversions of these models | Apache-2.0 (RapidOCR), derived from the official PaddleOCR models | RapidOCR's model list pins each file by URL and SHA-256 (ModelScope, release v3.10.0) | **The three SHA-256 values match the files benchmarked here** (`bench/ocr/models.sha256`) |
| ONNX Runtime | MIT | github.com/microsoft/onnxruntime | Linux x64 and arm64 CPU builds |
| Tesseract 5 | Apache-2.0 (Leptonica BSD-2) | github.com/tesseract-ocr/tesseract | CLI and C/C++ API |
| `tessdata_best`, `tessdata_fast` (`ara`, `fra`, `eng`) | Apache-2.0 (whole repository) | github.com/tesseract-ocr/tessdata_best, …/tessdata_fast | Training-data sources aren't named, which is usual for these files |

Provenance options for the Paddle models (to decide):
1. **Use RapidOCR's ONNX files, pinned by SHA-256** (what was benchmarked), and keep **our own mirror** of them, so the device never depends on ModelScope.
2. **Convert the official Paddle models ourselves** (`paddle2onnx`, Apache-2.0) from the PaddlePaddle organisation, and check our output against RapidOCR's on the test set.
   - That gives the cleanest provenance, but needs tools installed (approval).

**Recommendation:** option 1 now, with option 2 as a one-time verification before any distribution.

## 4. Integration with the N2 launcher

Each reader is a separate engine with its own manifest in `engines/manifests/`, so each is started, stopped and memory-checked on its own.

**Engine process (recommended for the first engine): a small Python HTTP server per engine.**
- It uses what was benchmarked: `rapidocr` + `onnxruntime` for A, `tesserocr` for B. Everything is pinned with hashes, in its own virtualenv outside the repo (`~/.local/share/nadhra/engines/<id>/venv`).
- It is **not an app dependency**; the app talks to it only over HTTP.
- Alternatives, for later:
  - a Node engine with `onnxruntime-node` (MIT, x64/arm64) and our own TypeScript detection and decoding (more code);
  - C++ (RapidOcrOnnx, libtesseract): the fastest, and the most work. Worth it on ARM if Python is too heavy there.

**Engine API** (the same for both readers):
- `GET /health`: 200 once the models are loaded.
- `POST /read` with `{ image: <base64 JPEG>, maxSide }` answers `{ lines: [{ text, box: [ymin,xmin,ymax,xmax] in thousandths, confidence }], ms }`.
  - Limits: 4 MB body, JPEG only, one request at a time (a queue of 1), 20 s time limit.
- Nothing is logged except timings and error codes, never text or images.

**Example manifest (Reader B; values from the measurements, rounded up with margin):**
```json
{
  "id": "ocr-tesseract",
  "name": "Tesseract 5 (ara+fra+eng, best)",
  "version": "5.5.4+tessdata_best-4.1.0",
  "licence": "Apache-2.0",
  "candidateTasks": ["read"],
  "command": { "exec": "/home/<user>/.local/share/nadhra/engines/ocr-tesseract/venv/bin/python",
               "args": ["-I", "/opt/nadhra/engines/ocr/tesseract_engine.py", "--host", "{host}", "--port", "{port}", "--models", "{modelDir}/tessdata_best"] },
  "health": { "path": "/health" },
  "ramMB": 200,
  "arch": ["x86_64", "aarch64"],
  "files": [{ "path": "tessdata_best/ara.traineddata", "url": "https://github.com/tesseract-ocr/tessdata_best/raw/<commit>/ara.traineddata",
              "sha256": "ab9d157d8e38ca00e7e39c7d5363a5239e053f5b0dbdb3167dde9d8124335896", "sizeBytes": 0 }]
}
```
Reader A: `ocr-paddle`, `ramMB: 700`, three ONNX files with the SHA-256 values above.

**From the reading request to `document.ts` (N3 proper, after this proposal):**
```
provider:"nadhra", mode:"read"  →  acquire(ocr-paddle) on frame A, acquire(ocr-tesseract) on frame B
                                →  ocrToReading() adapter: plain code, no AI (NADHRA_AI_PROPOSAL.md §5)
                                →  sanitizeDocument(first, confirm: second, inspect: lineCheck)   ← unchanged
```
- `NADHRA_TASKS.read` stays **empty** until the real-photo sessions pass the protocol's criteria with **zero critical errors**.
- Until then, the engines can run only in a benchmark mode, never for users.

## 5. Security and sandboxing requirements

Already in N2:
- a minimal environment (no keys or tokens);
- listening on 127.0.0.1 only;
- no shell;
- research-only licences never loaded.

To add before the first real engine runs:

| Requirement | How | Notes |
|---|---|---|
| **No network at all for the engine** | Run it in its own network namespace with **bubblewrap** (`bwrap --unshare-all --die-with-parent`, unprivileged) | Such an engine can't listen on the host's 127.0.0.1, so **the API moves to a Unix socket** in a private folder (manifest placeholder `{socket}` instead of `{port}`). Needs a small launcher change and a manifest-format change |
| **Read-only files** | bwrap binds: engine code and model folder read-only, a private `/tmp`, no home folder, no `/run/user` | The engine can't read the user's files or keys |
| **Hard memory limit** | `systemd-run --user --scope -p MemoryMax=<ramMB × 1.25>M -p CPUQuota=…` (cgroup v2 user delegation) | An engine that grows beyond its share is killed alone, and the system never freezes. To check that delegation works on your Arch PC |
| **Model integrity** | The launcher checks each file's SHA-256 against the manifest before the first start (cached until the file changes), and refuses on a mismatch | Protects against corrupted or replaced models |
| **No runtime downloads** | Explicit model paths (RapidOCR's auto-download off), network blocked by the namespace anyway | |
| **Pinned packages** | `pip install --require-hashes` from a lock file per engine | Supply-chain protection |
| **Input limits** | Size, type and time limits in the engine (§4); the launcher restarts an engine after N requests or on any timeout | Limits damage from a malformed image |
| **Privacy of content** | No text or images in logs; nothing written to disk except in the private `/tmp` | The same rule as the app's server logs |

- **Fallback if bubblewrap isn't available on a device:** the N2 isolation still applies (no secrets, loopback only), and the gap is stated plainly.
- The sandbox **couldn't be tested inside this assistant's environment** (`unshare` isn't permitted here), so it has to be verified on your PC.

## 6. Keeping several engines within the memory budget

**Today (N2):** every start checks the *current* free memory on its own. Two engines starting together could both pass.

**Proposed:**
1. **One start at a time.** A launcher-wide lock makes "check and reserve" a single step.
2. **A reservation ledger.**
   - The budget is `min(MemTotal − OS/browser/server reserve, NADHRA_ENGINE_BUDGET_MB)`.
   - Every starting or running engine holds its `ramMB`.
   - A start needs both:
     - `reserved + ramMB ≤ budget`;
     - the live `MemAvailable ≥ ramMB + reserve`.
3. **Make room by stopping idle engines first,** least recently used, and only those with no user. An engine in use is never stopped to make room. If there still isn't room, the request is refused with `insufficient-memory` and the numbers, and the user hears why.
4. **Watch actual use.**
   - Each engine's resident memory is read from `/proc/<pid>/status` every health check.
   - If it runs more than 25 % over its declared `ramMB`, the ledger uses the real figure and a warning is logged.
   - The cgroup limit (§5) is the hard stop.
5. **Pairs.**
   - A reading needs both readers. A then B **in sequence** halves the peak (about 0.7 GB instead of 0.85 GB) but adds Tesseract's load time.
   - Together, they fit on this PC and on a 4 GB device: about 0.9 GB including margins, plus the 512 MB reserve.
   - Recommendation: in parallel when the budget allows it, otherwise in sequence. The ledger decides.

Tests (fake engines, as in N2):
- two engines that each fit alone but not together: the second makes room by stopping an idle one, or is refused;
- an engine in use is never stopped to make room;
- "one start at a time": concurrent starts never overspend the budget;
- the RSS overrun detection: the fake engine allocates beyond its declared `ramMB`.

## 7. Proposed order of work (each step needs your approval)

| Step | Content | Installs / downloads? |
|---|---|---|
| 0 | Measure the engines **as servers**: startup time, RAM at rest and peak, time per image, one recogniser by script | Uses the existing bench venv and models; no new download |
| 1 | Launcher hardening: Unix-socket API, bubblewrap, cgroup limit, SHA-256 checks, memory ledger and eviction (all with fake engines) | **Yes, to test the sandbox:** `bubblewrap` (system package). Your approval |
| 2 | The two engine servers (Python), per-engine pinned venvs, manifests, the model mirror | **Yes:** Python packages and model files (the same versions as the benchmark). Your approval |
| 3 | The `ocrToReading()` adapter, plus Nadhra reading in **benchmark mode only** (never offered to users) | No |
| 4 | Real photographs, under `PHASE1_REAL_CAMERA_TEST_PROTOCOL.md` | No, but it needs your photo sessions |
| 5 | Only if step 4 has **zero critical errors**: declare `read` for Nadhra, with your approval of the wording | No |

## 8. Decisions needed

1. Approve the OCR pair (Paddle A + Tesseract B) as the first engine?
2. Paddle model provenance: RapidOCR's ONNX pinned and mirrored now, plus our own conversion check before distribution?
3. Engine processes in Python for the first version (C++ or Node later, if ARM needs it)?
4. The sandbox design: bubblewrap + Unix socket + cgroup limit. This changes the N2 manifest format (`{socket}`).
5. The memory budget design: the lock, the ledger, evicting idle engines only, parallel-or-sequential pairs.
6. Which step to start with. Step 0 needs no installation.

## Sources

- PaddleOCR repository and licence: https://github.com/PaddlePaddle/PaddleOCR
- Arabic recogniser card (Apache-2.0, 81.27 %): https://huggingface.co/PaddlePaddle/arabic_PP-OCRv5_mobile_rec
- Latin recogniser card (Apache-2.0, 84.7 %): https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec
- PP-OCRv5 multilingual recognition (Arabic training set size): https://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html
- RapidOCR (Apache-2.0, ONNX conversions of PaddleOCR): https://github.com/RapidAI/RapidOCR
- RapidOCR model list with URLs and SHA-256: https://github.com/RapidAI/RapidOCR/blob/main/python/rapidocr/default_models.yaml
- Tesseract (Apache-2.0, CLI and C API): https://github.com/tesseract-ocr/tesseract
- tessdata_best / tessdata_fast (Apache-2.0): https://github.com/tesseract-ocr/tessdata_best, https://github.com/tesseract-ocr/tessdata_fast
- onnxruntime-node platform support (Linux arm64 CPU): https://npmjs.com/package/onnxruntime-node
