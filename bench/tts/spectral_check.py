#!/usr/bin/env python3
"""How far ONNX fp32 / int8 audio is from PyTorch, against PyTorch's own run-to-run spread
(the vocoder adds random noise each run). Log-magnitude spectrum distance in dB, phase-insensitive.
Run after `export_onnx.py validate`, with the same venv: python -I bench/tts/spectral_check.py"""
import json, sys, warnings
from pathlib import Path
warnings.filterwarnings("ignore")
sys.path.insert(0, str(Path(__file__).resolve().parent))
import numpy as np, soundfile as sf, torch
from export_onnx import load_torch, OUT

def logspec(a, n=1024, hop=256):
    a = np.asarray(a, np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(a, n)[::hop] * np.hanning(n)
    return 20 * np.log10(np.abs(np.fft.rfft(frames, axis=1)) + 1e-4)

def dist(a, b):
    sa, sb = logspec(a), logspec(b)
    m = min(len(sa), len(sb))
    return float(np.mean(np.abs(sa[:m] - sb[:m])))

torch_, kmodel, voice = load_torch()
cases = json.loads((OUT / "onnx-cases.json").read_text())
rows = []
for c in cases:
    ids = torch.LongTensor([c["ids"]]); ref = torch.tensor(c["ref_s"])
    with torch.inference_mode():
        a1 = kmodel.forward_with_tokens(ids, ref, 1.0)[0].numpy()
        a2 = kmodel.forward_with_tokens(ids, ref, 1.0)[0].numpy()
    f32, _ = sf.read(OUT / "wav" / f"{c['key']}.onnx-fp32.wav")
    i8, _ = sf.read(OUT / "wav" / f"{c['key']}.onnx-int8.wav")
    rows.append({"key": c["key"], "torch_vs_torch_db": round(dist(a1, a2), 2), "torch_vs_fp32_db": round(dist(a1, f32), 2), "torch_vs_int8_db": round(dist(a1, i8), 2)})
    print(rows[-1], flush=True)
med = lambda k: round(sorted(r[k] for r in rows)[len(rows)//2], 2)
summary = {k: med(k) for k in ("torch_vs_torch_db", "torch_vs_fp32_db", "torch_vs_int8_db")}
print("median", summary)
(OUT / "results-spectral.json").write_text(json.dumps({"summary": summary, "rows": rows}, indent=1))
