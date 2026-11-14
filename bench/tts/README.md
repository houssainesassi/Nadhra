# bench/tts: Nabra-82M benchmark (research only, not part of the app)

The results and conclusions are in `docs/NABRA_BENCH_REPORT.md`. Nothing here is imported by the app.

Environment (outside the repo):
- `~/.cache/nadhra-bench/venv-tts`: Python 3.13 venv. Exact versions are in `requirements-tts.txt`.
  1. `pip install torch --index-url https://download.pytorch.org/whl/cpu`
  2. `pip install --no-deps --ignore-requires-python misaki==0.9.4`
  3. `pip install addict regex phonemizer-fork espeakng-loader soundfile huggingface_hub numpy loguru transformers num2words spacy camel-tools onnx onnxruntime onnxscript`
  4. `pip install --no-deps "kokoro @ git+https://github.com/Oddadmix/kokoro.git@main"`
- `~/.cache/nadhra-bench/camel_data`: run `CAMELTOOLS_DATA=… camel_data -i disambig-mle-calima-msa-r13` (the data is GPL v2).
- `~/.cache/nadhra-bench/nabra/model`: `kokoro_arabic.pth`, `af_msa.pt`, `config.json` from `oddadmix/Nabra-82M-v0.1` at revision `adf6abf3`.
- `~/.cache/nadhra-bench/nabra/g2p/arabic_g2p.py`: the author's front-end (gist rev `827b541`).
- `~/.cache/nadhra-bench/nabra/onnx`: the exported models (made by `export_onnx.py export`).

Run from the repo root, with `CAMELTOOLS_DATA=~/.cache/nadhra-bench/camel_data` and `PY=~/.cache/nadhra-bench/venv-tts/bin/python`:

    $PY -I bench/tts/run_nabra.py [--threads 1]     # PyTorch: speed, RAM, WAVs, diacritization
    $PY -I bench/tts/export_onnx.py export          # ONNX fp32 and int8
    $PY -I bench/tts/export_onnx.py validate        # same phonemes: torch vs ONNX, WAVs
    $PY -I bench/tts/spectral_check.py              # log-spectrum distance vs torch's own spread
    $PY -I bench/tts/export_onnx.py ort-only --model fp32 --threads 2   # ONNX Runtime alone

The outputs go to `bench/out/tts/` (gitignored).
