"""Median pitch (F0) of speech files, to check a voice is female (about 165-255 Hz) and not male
(about 85-155 Hz). Usage: python3 e2e/live/pitch.py file.wav|file.mp3 ...  Needs numpy and ffmpeg."""
import sys, wave, subprocess
import numpy as np

def load(p):
    if p.endswith(".wav"):
        w = wave.open(p)
        sr = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
        if w.getnchannels() == 2:
            x = x[::2]
        return x, sr
    raw = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", p, "-ac", "1", "-ar", "24000", "-f", "s16le", "-"], capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(float), 24000

def median_f0(x, sr):
    f0, n, hop = [], int(0.04 * sr), int(0.01 * sr)
    lo, hi = int(sr / 400), int(sr / 70)
    for i in range(0, len(x) - n, hop):
        fr = x[i:i + n] * np.hanning(n)
        if np.sqrt(np.mean(fr ** 2)) < 300:
            continue
        ac = np.correlate(fr, fr, "full")[n - 1:]
        if ac[0] <= 0:
            continue
        k = lo + np.argmax(ac[lo:hi])
        if ac[k] / ac[0] > 0.45:
            f0.append(sr / k)
    return (float(np.median(f0)), len(f0)) if len(f0) >= 10 else (None, len(f0))

for p in sys.argv[1:]:
    x, sr = load(p)
    m, frames = median_f0(x, sr)
    if m is None:
        print(f"{p}: too little voiced audio")
        continue
    verdict = "FEMALE range" if m > 165 else "MALE range" if m < 155 else "ambiguous"
    print(f"{p.split('/')[-1]:32s} median F0 {m:6.1f} Hz  ({frames} voiced frames, {len(x)/sr:.1f}s)  {verdict}")
