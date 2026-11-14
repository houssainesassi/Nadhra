# Nabra-82M benchmark (approved research, not integrated)

Status: **measured on this PC, 2026-11-14.** Nothing was added to the app or changed in its code. Nabra is
not connected to Nadhra AI. The tooling is in `bench/tts/` and the outputs in `bench/out/tts/` (gitignored).
The environment lives outside the repo, in `~/.cache/nadhra-bench/`.

## 1. Summary

| Question | Answer |
|---|---|
| Does it run offline on this PC? | **Yes.** It runs end to end, with no network after the one-time downloads |
| Speed (i5-5300U, 2 cores, CPU only) | PyTorch: real-time factor **0.96** with 2 threads, **1.42** with 1 thread. ONNX Runtime fp32: **0.76** (2 threads), **1.16** (1 thread). Below 1 means faster than the speech itself |
| Latency | Each sentence is synthesized whole before it can play, so a 1.25 s sentence ("الكاميرا تعمل.") waits **1.2–1.9 s**. That is too slow for hazard warnings |
| RAM | Published PyTorch pipeline: **1.77 GB peak**. ONNX fp32 alone: **430 MB loaded, 811 MB peak**, plus a diacritizer (camel-tools: +400 MB) |
| CPU | It keeps both cores busy while it speaks (median 1.9 cores with 2 threads) |
| ONNX | **Works.** fp32 output is equivalent to PyTorch (§4). int8 dynamic quantization is **3× slower here and audibly different (likely)**: not recommended as is |
| ARM64 | Every component publishes aarch64 Linux wheels or is pure Python. Running it on ARM is **not verified** (no hardware or emulator here) |
| Voice quality | **Not judged by ear by me.** 56 WAV files are ready for your listening (§6). Objective checks found serious *text front-end* errors (§5) |
| Output quality | MSA only. The diacritizer makes meaning-changing mistakes on the app's own sentences; Latin words (drug names) are silently dropped; Derja is pronounced as MSA, with errors |
| Licensing | Model **Apache-2.0**, but **training data not disclosed**. The pipeline around it is **GPL** (camel-tools MSA data GPL v2; espeak-ng and phonemizer GPL-3.0). **Not cleared for commercial distribution** (§7) |

**Recommendation:**
- Keep Nabra as a candidate, not a decision. Do not ship it until its training-data provenance is answered in writing.
- If it continues, the usable shape is:
  - ONNX fp32 for the voice;
  - **the app's fixed sentences stored already diacritized**, which removes the diacritizer and its errors for everything Nadhra says on its own;
  - an Apache/MIT front-end instead of the GPL ones;
  - **pre-rendered audio for warnings**, which have a closed set of phrases, so they play instantly;
  - a separate French voice for French document text.
- Your listening test decides whether the voice is acceptable at all.

## 2. Setup

- Hardware: Intel i5-5300U (2 cores / 4 threads, AVX2, no AVX-512 or VNNI), 7.6 GB RAM (~2.3 GB free during the runs), no GPU.
- Separate virtualenv `~/.cache/nadhra-bench/venv-tts` (Python 3.13). The OCR bench venv was left untouched, so its
  pinned versions stay reproducible. Versions: `bench/tts/requirements-tts.txt` (torch 2.15.0+cpu,
  onnxruntime 1.32.0, camel-tools 1.6.0, the author's Kokoro fork, misaki 0.9.4).
- Model: `oddadmix/Nabra-82M-v0.1` at revision `adf6abf3`, copied to `~/.cache/nadhra-bench/nabra/model`:
  - `kokoro_arabic.pth` 313 MB, sha256 `81623d48…`;
  - `af_msa.pt` 0.5 MB, sha256 `93241456…`;
  - `config.json`, sha256 `5abb01e2…`.
- Front-end, as published: the author's `arabic_g2p.py` (gist rev `827b541`, read before use; it only does
  text normalization and phoneme cleanup) → camel-tools MLE diacritizer (`calima-msa-r13`, 124 MB of data) → espeak-ng
  via `espeakng-loader`, which bundles espeak-ng (no system install needed) → Kokoro.
- Install workarounds (bench only):
  - misaki declares Python < 3.13 only because of its English/Vietnamese extras, so it was installed with `--ignore-requires-python --no-deps`;
  - Kokoro imports misaki's English module unconditionally, which pulls in spaCy and num2words. A port wouldn't need them.
- Sentence set (`bench/tts/run_nabra.py`): 14 sentences:
  - 8 Standard Arabic: the app's sentences, a medicine reading, digits and a date;
  - 5 Derja;
  - 1 with a Latin unit.

## 3. Speed and memory

Real-time factor (RTF) = synthesis time ÷ audio length, measured after a warm-up.

| Runtime | Threads | RTF median | RTF worst | 1.25 s sentence takes | RAM loaded | RAM peak |
|---|---|---|---|---|---|---|
| PyTorch (published pipeline, with the diacritizer) | 2 | 0.96 | 1.10 | 1.26 s | 1.38 GB | 1.77 GB |
| PyTorch | 1 | 1.42 | 1.52 | 1.85 s | 1.38 GB | 1.81 GB |
| ONNX Runtime fp32 (model only) | 2 | **0.76** | 0.94 | 1.18 s | **430 MB** | **811 MB** |
| ONNX Runtime fp32 | 1 | 1.16 | 1.27 | 1.47 s | 430 MB | 811 MB |
| ONNX Runtime int8 (dynamic) | 2 | 2.25 | 2.93 | 2.93 s | 216 MB | 633 MB |

Where the PyTorch memory goes:
- the Python imports take 434 MB: torch 194 MB, spaCy 46 MB, transformers 18 MB, and the rest of Kokoro's imports;
- the fp32 model adds about 550 MB;
- the camel-tools diacritizer adds about 400 MB (its load takes 7.8 s, then 1–27 ms per sentence).

The ONNX peak comes from the longest sentence (220 phoneme tokens). Short sentences need less.

Reading the numbers:
- On 2 cores, ONNX fp32 speaks faster than real time, but it occupies the whole CPU while doing so. Other engines
  would compete for it (OCR, the browser's MediaPipe).
- A small ARM board's core is often slower than one Broadwell core. The 1-thread rows (RTF 1.16–1.42) are a rough
  warning, not a prediction. ARM must be measured on ARM.
- Kokoro doesn't stream within a sentence. The delay before the first sound is the whole sentence's synthesis time,
  so long sentences should be split at punctuation, as the app's speech queue already does.

## 4. ONNX conversion

- Kokoro's own `KModelForONNX` exports with the TorchScript exporter (`torch.onnx.export`, opset 17, dynamic
  phoneme length) when the model is built with `disable_complex=True` (a convolution-based STFT).
  The export took 11 s and produced **fp32 = 326 MB**.
- **fp32 is equivalent to PyTorch.** The vocoder adds random noise on every run, so waveforms never match exactly. The fair comparison is
  phase-insensitive (mean log-spectrum distance), against PyTorch's own run-to-run spread:

  | | median distance |
  |---|---|
  | PyTorch vs PyTorch (second run) | 1.27 dB |
  | PyTorch vs ONNX fp32 | **1.31 dB** (same durations, to the sample) |
  | PyTorch vs ONNX int8 | **5.96 dB** (up to 9.5 dB; durations change by up to 75 ms) |

- **int8 dynamic quantization is not usable as is.**
  - It is 114 MB on disk and loads in half the RAM.
  - But it is **3× slower** on this CPU, which has no fast int8 instructions.
  - Its sound drifts 4–5× more than the noise floor, worst on the medicine sentence.
  - Still to try: static quantization, fp16 on ARM, or int8 on an ARM CPU with dot-product instructions.

## 5. Output quality: what the measurements show (no listening involved)

1. **Without the diacritizer, it is unusable.** espeak-ng leaves vowel-less consonant clusters: «تقترب» → `tqtrb`,
   «يخطئ» → `jχtʔ`, «قرأت» → `qrʔt`.
2. **With the diacritizer, the app's own sentences get meaning-changing errors:**
   - «درج أمامك» → «دَرَجَ» (the verb "he walked", not "stairs"), in a hazard warning;
   - «انتبه» → «أَنْتَبِه» ("I pay attention", not "watch out");
   - «تحقّق من الصيدلي» → «تَحَقَّقَ» ("he checked", not "check with the pharmacist");
   - «لا يستطيع فعل هذا بعد» → «بُعْدَ» ("distance", not "yet");
   - «يُرسَل» → «يُرْسِل»: the passive turns active, despite the vowel written in the input.

   The diacritizer picks case endings and verb moods from statistics, without understanding the sentence.
3. **Latin text is silently dropped.** «لـ Google Gemini» becomes «لـ», and «500 mg» loses "mg". Tunisian medicine
   boxes are mostly French, so **French document text would vanish without a word**. That is not acceptable for
   reading.
4. **Numbers and dates.** «500» is read in Arabic correctly. «03/2027» becomes "zero three *slash* two thousand and
   twenty-seven", with the English word "slash". «ملغ» is read as letters (`mlɣ`). Expiry dates and doses would need
   our own normalization before speech.
5. **Derja is pronounced as MSA, with errors.** «شنوة قدّامي» → «شَنُّوهُ قُدامَى», «كرهبة» → `karahabh`,
   «خدّامة» ends in `h`. As the card says, the model is MSA only. There is still no free female Derja voice.
6. **Phoneme coverage.** No phoneme was dropped as out of vocabulary in any sentence.

## 6. Listening material (for you)

The files are in `bench/out/tts/wav/`, four per sentence:

| File | What it is |
|---|---|
| `<key>.diac.wav` | the published pipeline |
| `<key>.raw.wav` | without the diacritizer |
| `<key>.onnx-fp32.wav` | the same phonemes through ONNX fp32 |
| `<key>.onnx-int8.wav` | the same phonemes through ONNX int8 |

Keys: `msa-camera`, `msa-warning`, `msa-vehicle`, `msa-disclaimer`, `msa-nadhra-unavailable`,
`msa-read-medicine`, `msa-digits`, `msa-long`, `tn-camera`, `tn-vehicle`, `tn-question`, `tn-nadhra`,
`tn-consent`, `latin-mg`. The text and the diacritized form of each are in `results-torch-t2.json`.

Suggested listening:
- naturalness and gender of `msa-disclaimer.diac.wav`;
- whether `msa-warning.diac.wav` is understood as "stairs ahead";
- `msa-read-medicine` fp32 against int8;
- whether any Derja file is acceptable.

## 7. Licensing: before any commercial distribution

| Component | Licence | Issue |
|---|---|---|
| Nabra-82M weights | Apache-2.0 (card) | **Training data not disclosed.** The author's public datasets include `arabic-audio-collection-*` sets (podcasts and named people) and `tts-elda7ee7-*`, all `license: other`, with no source or consent stated. It is unknown whether the female `af_msa` voice comes from such recordings. **Ask the author in writing**: which recordings, under which licence, and the speaker's consent |
| Kokoro-82M (base model) | Apache-2.0 | Its card says it was trained partly on "synthetic audio generated by closed TTS models from large providers". Whether that is allowed depends on those providers' terms, which are unnamed. That is a known open question |
| Kokoro fork (`Oddadmix/kokoro`), kikiri-tts recipe, misaki | Apache-2.0 | OK |
| StyleTTS2 (architecture) | MIT | OK |
| camel-tools (code) | MIT | OK |
| **camel-tools data `calima-msa-r13`** (morphology DB + MLE model) | **GPL v2** (in its catalogue) | Shipping it means GPL obligations for that data. It can be avoided by pre-diacritizing fixed sentences, or by using CATT (Apache-2.0, neural, has ONNX) |
| **espeak-ng** (bundled by `espeakng-loader`, which is MIT) | **GPL-3.0** | Loaded in-process by `phonemizer-fork` (also **GPL-3.0**). Needs legal review, or a small Apache-licensed Arabic phonemizer of our own (feasible for diacritized text) |
| num2words (pulled in by Kokoro's import) | LGPL | Not needed by a port |
| torch / ONNX Runtime | BSD-style / MIT | OK |

**Conclusion:** the model is permissively licensed on paper, but provenance is unknown and the published
front-end is GPL. Do not recommend commercial distribution until:
1. the author confirms the training data and the speaker's consent;
2. the Kokoro synthetic-data question is assessed;
3. the GPL parts are removed or approved by a lawyer.

## 8. Limits of this benchmark

- No listening judgement (§6 is for you), and no Arabic speech recognizer was used for an automatic intelligibility check.
- One machine. ARM64 is checked only for package availability.
- 14 sentences: enough to find the front-end failures above, not to give an error rate.
- The model's 313 MB file also remains in the Hugging Face cache under VS Code's sandbox
  (`~/.var/app/com.visualstudio.code/cache/huggingface/`), from the first download. It can be deleted.
