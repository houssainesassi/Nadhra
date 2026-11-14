#!/usr/bin/env python3
"""Nabra-82M benchmark (PyTorch, CPU). Research only: NOT part of the app, nothing here is imported by it.

Environment (separate from the app and from the OCR bench venv):
  ~/.cache/nadhra-bench/venv-tts   (see bench/tts/README.md for how it was built)
  ~/.cache/nadhra-bench/nabra/model/{kokoro_arabic.pth, af_msa.pt, config.json}
  ~/.cache/nadhra-bench/nabra/g2p/arabic_g2p.py   (the model author's G2P front-end, gist rev 827b541)
  CAMELTOOLS_DATA=~/.cache/nadhra-bench/camel_data (disambig-mle-calima-msa-r13)

Run:
  CAMELTOOLS_DATA=~/.cache/nadhra-bench/camel_data \
    ~/.cache/nadhra-bench/venv-tts/bin/python -I bench/tts/run_nabra.py [--threads N] [--out bench/out/tts]

Measures, per sentence: diacritization, phonemization and synthesis time, CPU time, audio length,
real-time factor (synthesis time / audio length), and the process's resident memory at each stage.
Writes WAVs (with and without the diacritizer) for listening, and results.json.
"""
import argparse
import json
import os
import resource
import sys
import time
import warnings
from pathlib import Path

warnings.filterwarnings("ignore")
HOME = Path.home()
BENCH = HOME / ".cache/nadhra-bench"
MODEL_DIR = BENCH / "nabra/model"
sys.path.insert(0, str(BENCH / "nabra/g2p"))


def mem():
    """Current and peak resident memory of this process, in MB (from /proc)."""
    out = {}
    for line in open("/proc/self/status"):
        if line.startswith(("VmRSS:", "VmHWM:")):
            k, v = line.split(":")
            out["rss" if k == "VmRSS" else "peak"] = round(int(v.split()[0]) / 1024, 1)
    return out


# Fixed sentence list. MSA: sentences the app says (Standard Arabic table) and reading-style lines.
# Derja: Tunisian sentences, to hear how an MSA-only model handles them. "latin": Latin words in an
# Arabic sentence, which the author's normalize_text() drops.
SENTENCES = [
    ("msa-camera", "msa", "الكاميرا تعمل."),
    ("msa-warning", "msa", "درج أمامك، قريب. انتبه."),
    ("msa-vehicle", "msa", "سيارة على يمينك، تقترب."),
    ("msa-disclaimer", "msa", "هذا المساعد تجريبي ويساعدك فقط. لا يعوّض العصا ولا الكلب المرشد ولا مساعدة الناس، وقد يخطئ."),
    ("msa-nadhra-unavailable", "msa", "ذكاء نظرة لا يستطيع فعل هذا بعد: ذكاؤه الاصطناعي غير موصول على هذا الجهاز. لم يُرسَل أي شيء."),
    ("msa-read-medicine", "msa", "قرأت: باراسيتامول خمسمائة مليغرام، أقراص. تحقّق من الصيدلي."),
    ("msa-digits", "msa", "الجرعة 500 ملغ، مرتين في اليوم، تنتهي في 03/2027."),
    ("msa-long", "msa", "الوصف التلقائي مطفأ: لا تُرسَل أي صورة إلا عندما تسألني. تنبيهات الجهاز تعمل على الأشخاص والمركبات، أما الدرج والحفر فلا أراها."),
    ("tn-camera", "derja", "الكاميرا خدّامة."),
    ("tn-vehicle", "derja", "كرهبة على يمينك، قريبة."),
    ("tn-question", "derja", "شنوة قدّامي؟"),
    ("tn-nadhra", "derja", "ذكاء نظرة مازال ما ينجمش يعمل هاذي: الذكاء متاعو موش مربوط في الجهاز هذا. ما تبعث حتى شي."),
    ("tn-consent", "derja", "باش نوصفلك اللي قدّامك، الصور تتبعث لـ Google Gemini، ووقت اللي يطيح لـ OpenRouter."),
    ("latin-mg", "latin", "باراسيتامول 500 mg، أقراص."),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--threads", type=int, default=0, help="torch threads (0 = torch default)")
    ap.add_argument("--out", default="bench/out/tts")
    ap.add_argument("--no-wav", action="store_true")
    args = ap.parse_args()
    out = Path(args.out)
    (out / "wav").mkdir(parents=True, exist_ok=True)

    stages = {"start": mem()}
    t = time.perf_counter()
    import numpy as np
    import soundfile as sf
    import torch

    if args.threads:
        torch.set_num_threads(args.threads)
    stages["torch_import"] = {**mem(), "s": round(time.perf_counter() - t, 2)}

    t = time.perf_counter()
    from kokoro import KModel, KPipeline
    from kokoro import pipeline as kpipeline_mod
    from arabic_g2p import EXTRA_SYMBOLS, ArabicG2P, clean_phonemes, normalize_text

    kmodel = KModel(repo_id="oddadmix/Nabra-82M-v0.1", config=str(MODEL_DIR / "config.json"), model=str(MODEL_DIR / "kokoro_arabic.pth"), disable_complex=True).eval()
    kmodel.vocab.update(EXTRA_SYMBOLS)
    kpipeline_mod.LANG_CODES.setdefault("ar", "ar")
    pipeline = KPipeline(lang_code="ar", repo_id="oddadmix/Nabra-82M-v0.1", model=kmodel)
    orig_g2p = pipeline.g2p

    def g2p_clean(text):
        ph, tokens = orig_g2p(text)
        return clean_phonemes(ph), tokens

    pipeline.g2p = g2p_clean
    voice = torch.load(MODEL_DIR / "af_msa.pt", map_location="cpu", weights_only=True)
    stages["model_loaded"] = {**mem(), "s": round(time.perf_counter() - t, 2)}

    t = time.perf_counter()
    g2p = ArabicG2P(diacritize=True)
    stages["diacritizer_loaded"] = {**mem(), "s": round(time.perf_counter() - t, 2)}

    vocab = kmodel.vocab

    def synth(text):
        """Returns (audio, phonemes, seconds, cpu_seconds)."""
        c0, w0 = time.process_time(), time.perf_counter()
        chunks, phs = [], []
        with torch.inference_mode():
            for _, ph, audio in pipeline(text, voice=voice, speed=1.0):
                phs.append(ph)
                if audio is not None:
                    chunks.append(audio.detach().cpu().numpy())
        wall, cpu = time.perf_counter() - w0, time.process_time() - c0
        audio = np.concatenate(chunks).astype(np.float32) if chunks else np.zeros(0, np.float32)
        return audio, " | ".join(phs), wall, cpu

    synth("مَرْحَبًا.")  # warm-up, not counted
    stages["warm"] = mem()

    rows = []
    for key, kind, raw in SENTENCES:
        norm, dropped = normalize_text(raw)
        t0 = time.perf_counter()
        diac = g2p.diacritize(norm)
        t_diac = time.perf_counter() - t0
        row = {"key": key, "kind": kind, "text": raw, "normalized": norm, "latin_dropped": dropped, "diacritized": diac, "diac_ms": round(t_diac * 1000, 1)}
        for variant, text in (("diac", diac), ("raw", norm)):
            audio, ph, wall, cpu = synth(text)
            dur = len(audio) / 24000
            oov = sorted({c for c in ph if c not in vocab and c not in " |"})
            row[variant] = {
                "phonemes": ph,
                "oov_dropped": oov,  # phoneme symbols Kokoro has no id for: silently skipped
                "synth_s": round(wall, 3),
                "cpu_s": round(cpu, 3),
                "audio_s": round(dur, 3),
                "rtf": round(wall / dur, 3) if dur else None,
                "cores_busy": round(cpu / wall, 2) if wall else None,
                "peak_abs": round(float(np.abs(audio).max()), 3) if len(audio) else 0,
                "silence_frac": round(float((np.abs(audio) < 0.01).mean()), 3) if len(audio) else 1,
            }
            if not args.no_wav and len(audio):
                sf.write(out / "wav" / f"{key}.{variant}.wav", audio, 24000)
        rows.append(row)
        d = row["diac"]
        print(f"{key:24s} audio {d['audio_s']:5.2f}s  synth {d['synth_s']:5.2f}s  RTF {d['rtf']}  diac {row['diac_ms']}ms  latin-dropped {dropped}  oov {d['oov_dropped']}", flush=True)
    stages["end"] = mem()

    rtfs = [r["diac"]["rtf"] for r in rows if r["diac"]["rtf"]]
    summary = {
        "threads": torch.get_num_threads(),
        "torch": torch.__version__,
        "cpu": next((l.split(":", 1)[1].strip() for l in open("/proc/cpuinfo") if l.startswith("model name")), "?"),
        "rtf_median": round(sorted(rtfs)[len(rtfs) // 2], 3),
        "rtf_max": max(rtfs),
        "audio_total_s": round(sum(r["diac"]["audio_s"] for r in rows), 2),
        "synth_total_s": round(sum(r["diac"]["synth_s"] for r in rows), 2),
        "peak_rss_mb": stages["end"]["peak"],
        "ru_maxrss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
    }
    print(json.dumps({"stages": stages, "summary": summary}, ensure_ascii=False, indent=1))
    name = f"results-torch-t{summary['threads']}.json"
    (out / name).write_text(json.dumps({"stages": stages, "summary": summary, "rows": rows}, ensure_ascii=False, indent=1))
    print("wrote", out / name)


if __name__ == "__main__":
    main()
