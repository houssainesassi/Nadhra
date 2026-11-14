#!/usr/bin/env python3
"""Offline OCR benchmark, one engine per process (so its peak memory is its own).

Not part of the app: nothing in src/ imports this, and the engines live in a separate virtualenv.

    ~/.cache/nadhra-bench/venv/bin/python bench/ocr/run_ocr.py ENGINE PLAN_DIR OUT.json

ENGINE:
  tesseract-best   Tesseract 5 (tesserocr), tessdata_best ara+fra+eng, page segmentation "auto"
  tesseract-fast   the same with tessdata_fast (smaller, faster integer models)
  paddle-v5        PaddleOCR PP-OCRv5 models on ONNX Runtime (RapidOCR): one text detector, then two
                   recognisers (Arabic, Latin) on every box; each box keeps the reading with the higher
                   score. Boxes on the same row are joined into one line.

PLAN_DIR is e2e/read/out/plan (from e2e/read/make_plan_set.py): the same 31 cases x 2 frames the
Gemini reading test uses. Writes, per image, the lines read and the time taken, plus the load time,
peak RSS and the model files' size.
"""
import json
import os
import resource
import sys
import time

TESS_ROOT = os.path.expanduser("~/.cache/nadhra-bench")


def tesseract(variant):
    import tesserocr
    from PIL import Image

    path = os.path.join(TESS_ROOT, f"tessdata_{variant}")
    files = [os.path.join(path, f"{l}.traineddata") for l in ("ara", "fra", "eng")]
    api = tesserocr.PyTessBaseAPI(path=path, lang="ara+fra+eng", psm=tesserocr.PSM.AUTO)

    def read(img_path):
        api.SetImage(Image.open(img_path))
        text = api.GetUTF8Text()
        return [l.strip() for l in text.splitlines() if l.strip()]

    return read, files


def paddle():
    from rapidocr import RapidOCR
    from rapidocr.utils.typings import LangRec, OCRVersion, ModelType

    def engine(lang):
        return RapidOCR(params={
            "Rec.lang_type": lang, "Rec.ocr_version": OCRVersion.PPOCRV5, "Rec.model_type": ModelType.MOBILE,
            "Global.use_cls": False, "Global.log_level": "error",
        })

    ar, la = engine(LangRec.ARABIC), engine(LangRec.LATIN)

    def read(img_path):
        # Detect once, then give the very same crops to both recognisers (their public __call__ would
        # each run the detector and filter boxes on their own, so the two lists wouldn't line up).
        img, record = ar.preprocess_img(ar.load_img(img_path))
        try:
            crops, det = ar.detect_and_crop(img, record)
        except Exception:
            return []
        if det.boxes is None or not len(crops):
            return []
        ra, rl = ar.recognize_txt(crops), la.recognize_txt(crops)
        items = []
        for box, ta, sa, tl, sl in zip(det.boxes, ra.txts, ra.scores, rl.txts, rl.scores):
            text, score = (ta, sa) if sa >= sl else (tl, sl)
            if score < 0.5 or not text.strip():
                continue
            ys = [p[1] for p in box]
            xs = [p[0] for p in box]
            items.append({"text": text, "y": (min(ys) + max(ys)) / 2, "h": max(ys) - min(ys), "x": min(xs)})
        return join_rows(items)

    import rapidocr
    model_dir = os.path.join(os.path.dirname(rapidocr.__file__), "models")
    used = ["PP-OCRv6_det_small.onnx", "arabic_PP-OCRv5_rec_mobile.onnx", "latin_PP-OCRv5_rec_mobile.onnx"]
    return read, [os.path.join(model_dir, f) for f in used]


def is_arabic(s):
    letters = [c for c in s if c.isalpha()]
    return bool(letters) and sum("؀" <= c <= "ۿ" for c in letters) > len(letters) / 2


def join_rows(items):
    """Boxes whose vertical centres are within half a box height are one printed line."""
    items.sort(key=lambda i: i["y"])
    rows = []
    for it in items:
        if rows and abs(rows[-1][-1]["y"] - it["y"]) < 0.5 * max(it["h"], rows[-1][-1]["h"]):
            rows[-1].append(it)
        else:
            rows.append([it])
    lines = []
    for row in rows:
        row.sort(key=lambda i: i["x"])
        text = " ".join(i["text"] for i in row)
        if is_arabic(text):
            text = " ".join(i["text"] for i in reversed(row))
        if text.strip():
            lines.append(text.strip())
    return lines


def block_network():
    """NO_NETWORK=1: any socket use from Python (a model download, for example) fails the run. Weaker
    than a network namespace (`unshare -rn`), which this was also meant to run under where permitted."""
    def hook(event, args):
        if event.startswith("socket.") and event not in ("socket.__new__",):
            raise RuntimeError(f"network use blocked: {event}")
        if event == "socket.__new__":
            raise RuntimeError("network use blocked: socket created")
    sys.addaudithook(hook)


def main():
    engine, plan_dir, out = sys.argv[1:4]
    if os.environ.get("NO_NETWORK") == "1":
        block_network()
    t0 = time.perf_counter()
    if engine.startswith("tesseract-"):
        read, files = tesseract(engine.split("-", 1)[1])
    elif engine == "paddle-v5":
        read, files = paddle()
    else:
        sys.exit(f"unknown engine {engine}")
    load_ms = (time.perf_counter() - t0) * 1000
    images = sorted(f for f in os.listdir(plan_dir) if f.endswith(".jpg"))
    results = []
    first = True
    for name in images:
        t = time.perf_counter()
        lines = read(os.path.join(plan_dir, name))
        ms = (time.perf_counter() - t) * 1000
        results.append({"image": name, "lines": lines, "ms": round(ms, 1), "warmup": first})
        first = False
        print(f"{name}: {len(lines)} lines, {ms:.0f} ms", file=sys.stderr)
    usage = resource.getrusage(resource.RUSAGE_SELF)
    size = sum(os.path.getsize(f) for f in files if os.path.isfile(f))
    json.dump({
        "engine": engine,
        "load_ms": round(load_ms),
        "peak_rss_mb": round(usage.ru_maxrss / 1024),
        "cpu_s": round(usage.ru_utime + usage.ru_stime, 1),
        "model_mb": round(size / 1024 / 1024, 1),
        "model_files": [os.path.basename(f) for f in files],
        "results": results,
    }, open(out, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
