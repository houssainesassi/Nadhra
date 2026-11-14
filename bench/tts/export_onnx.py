#!/usr/bin/env python3
"""Nabra-82M → ONNX (research only, not used by the app).

  export   : torch → ONNX fp32 (dynamic phoneme length), then int8 dynamic quantization
  validate : same phoneme ids through PyTorch, ONNX fp32 and ONNX int8; compares the audio
             (length, SNR against PyTorch) and the time; writes token ids for the ort-only run
  ort-only : ONNX Runtime alone (no torch, no kokoro, no camel-tools): what a device would load.
             Measures resident memory and speed with 1 and 2 threads.

Run (venv and paths as in run_nabra.py):
  CAMELTOOLS_DATA=~/.cache/nadhra-bench/camel_data ~/.cache/nadhra-bench/venv-tts/bin/python -I bench/tts/export_onnx.py export
  ... validate
  ~/.cache/nadhra-bench/venv-tts/bin/python -I bench/tts/export_onnx.py ort-only --model fp32|int8 --threads 1|2
"""
import argparse
import json
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
HOME = Path.home()
BENCH = HOME / ".cache/nadhra-bench"
MODEL_DIR = BENCH / "nabra/model"
ONNX_DIR = BENCH / "nabra/onnx"
OUT = Path("bench/out/tts")
sys.path.insert(0, str(BENCH / "nabra/g2p"))
sys.path.insert(0, str(Path(__file__).resolve().parent))


def mem():
    out = {}
    for line in open("/proc/self/status"):
        if line.startswith(("VmRSS:", "VmHWM:")):
            k, v = line.split(":")
            out["rss" if k == "VmRSS" else "peak"] = round(int(v.split()[0]) / 1024, 1)
    return out


def load_torch():
    import torch
    from kokoro import KModel
    from arabic_g2p import EXTRA_SYMBOLS

    kmodel = KModel(repo_id="oddadmix/Nabra-82M-v0.1", config=str(MODEL_DIR / "config.json"), model=str(MODEL_DIR / "kokoro_arabic.pth"), disable_complex=True).eval()
    kmodel.vocab.update(EXTRA_SYMBOLS)
    voice = torch.load(MODEL_DIR / "af_msa.pt", map_location="cpu", weights_only=True)
    return torch, kmodel, voice


def export():
    torch, kmodel, voice = load_torch()
    from kokoro.model import KModelForONNX

    ONNX_DIR.mkdir(parents=True, exist_ok=True)
    wrapper = KModelForONNX(kmodel).eval()
    ids = torch.LongTensor([[0, *range(10, 60), 0]])
    ref_s = voice[ids.shape[1] - 3]  # the pipeline picks pack[len(phonemes) - 1]
    speed = torch.tensor([1.0])
    fp32 = ONNX_DIR / "nabra-fp32.onnx"
    t = time.perf_counter()
    torch.onnx.export(
        wrapper, (ids, ref_s, speed), str(fp32),
        input_names=["input_ids", "ref_s", "speed"], output_names=["waveform", "duration"],
        dynamic_axes={"input_ids": {1: "tokens"}, "waveform": {0: "samples"}, "duration": {0: "tokens"}},
        opset_version=17, dynamo=False,
    )
    print(f"export fp32: {time.perf_counter() - t:.1f}s, {fp32.stat().st_size / 1e6:.1f} MB")

    from onnxruntime.quantization import QuantType, quantize_dynamic

    int8 = ONNX_DIR / "nabra-int8.onnx"
    t = time.perf_counter()
    quantize_dynamic(str(fp32), str(int8), weight_type=QuantType.QInt8)
    print(f"quantize int8: {time.perf_counter() - t:.1f}s, {int8.stat().st_size / 1e6:.1f} MB")


def snr(ref, x):
    import numpy as np

    n = min(len(ref), len(x))
    if not n:
        return None
    err = ref[:n] - x[:n]
    return round(float(10 * np.log10((ref[:n] ** 2).sum() / max((err ** 2).sum(), 1e-12))), 1)


def validate():
    import numpy as np
    import onnxruntime as ort
    import soundfile as sf
    from run_nabra import SENTENCES
    from arabic_g2p import ArabicG2P, clean_phonemes, normalize_text

    torch, kmodel, voice = load_torch()
    g2p = ArabicG2P(diacritize=True)
    sessions = {}
    for name in ("fp32", "int8"):
        so = ort.SessionOptions()
        so.intra_op_num_threads = 2
        sessions[name] = ort.InferenceSession(str(ONNX_DIR / f"nabra-{name}.onnx"), so, providers=["CPUExecutionProvider"])
    (OUT / "wav").mkdir(parents=True, exist_ok=True)
    cases, rows = [], []
    for key, _kind, raw in SENTENCES:
        norm, _ = normalize_text(raw)
        _, ph = g2p.process(norm)
        ph = clean_phonemes(ph)
        tok = [i for i in (kmodel.vocab.get(p) for p in ph) if i is not None][:508]
        ids = [0, *tok, 0]
        ref = voice[len(tok) - 1].numpy()
        cases.append({"key": key, "ids": ids, "ref_s": ref.tolist()})
        with torch.inference_mode():
            t = time.perf_counter()
            a_t, _ = kmodel.forward_with_tokens(torch.LongTensor([ids]), torch.from_numpy(ref), 1.0)
            t_torch = time.perf_counter() - t
        a_t = a_t.numpy()
        row = {"key": key, "tokens": len(ids), "torch_s": round(t_torch, 3), "audio_s": round(len(a_t) / 24000, 3)}
        for name, sess in sessions.items():
            sess.run(None, {"input_ids": np.array([ids], np.int64), "ref_s": ref, "speed": np.array([1.0], np.float32)})  # warm per shape
            t = time.perf_counter()
            a, _ = sess.run(None, {"input_ids": np.array([ids], np.int64), "ref_s": ref, "speed": np.array([1.0], np.float32)})
            row[f"{name}_s"] = round(time.perf_counter() - t, 3)
            row[f"{name}_len_diff"] = int(len(a) - len(a_t))
            row[f"{name}_snr_db"] = snr(a_t, a)
            sf.write(OUT / "wav" / f"{key}.onnx-{name}.wav", a, 24000)
        rows.append(row)
        print(row, flush=True)
    (OUT / "onnx-cases.json").write_text(json.dumps(cases))
    (OUT / "results-onnx-validate.json").write_text(json.dumps(rows, indent=1))


def ort_only(model: str, threads: int):
    import numpy as np

    m0 = mem()
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = threads
    so.inter_op_num_threads = 1
    t = time.perf_counter()
    sess = ort.InferenceSession(str(ONNX_DIR / f"nabra-{model}.onnx"), so, providers=["CPUExecutionProvider"])
    load_s = time.perf_counter() - t
    m1 = mem()
    cases = json.loads((OUT / "onnx-cases.json").read_text())
    rows = []
    for c in cases:
        feed = {"input_ids": np.array([c["ids"]], np.int64), "ref_s": np.array(c["ref_s"], np.float32), "speed": np.array([1.0], np.float32)}
        sess.run(None, feed)  # first run per shape is slower; counted separately
        t = time.perf_counter()
        a, _ = sess.run(None, feed)
        dt = time.perf_counter() - t
        rows.append({"key": c["key"], "synth_s": round(dt, 3), "audio_s": round(len(a) / 24000, 3), "rtf": round(dt / (len(a) / 24000), 3)})
    rtfs = sorted(r["rtf"] for r in rows)
    res = {"model": model, "threads": threads, "size_mb": round((ONNX_DIR / f"nabra-{model}.onnx").stat().st_size / 1e6, 1),
           "load_s": round(load_s, 2), "rss_before_mb": m0["rss"], "rss_loaded_mb": m1["rss"], "peak_rss_mb": mem()["peak"],
           "rtf_median": rtfs[len(rtfs) // 2], "rtf_max": rtfs[-1], "first_short_sentence_s": rows[0]["synth_s"], "rows": rows}
    print(json.dumps({k: v for k, v in res.items() if k != "rows"}))
    (OUT / f"results-ort-{model}-t{threads}.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["export", "validate", "ort-only"])
    ap.add_argument("--model", default="fp32")
    ap.add_argument("--threads", type=int, default=2)
    a = ap.parse_args()
    {"export": export, "validate": validate}.get(a.cmd, lambda: ort_only(a.model, a.threads))()
