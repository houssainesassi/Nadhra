#!/usr/bin/env python3
"""Draws both readings' line boxes on the picture (red: first reading on frame a, blue: second on b),
from e2e/read/out/diag/<ID>.json written by diagnose.ts.   python3 e2e/read/draw_boxes.py P01 [out.png]"""
import json, sys
from PIL import Image, ImageDraw

def unwrap(b):
    while isinstance(b, list) and len(b) == 1 and isinstance(b[0], list):
        b = b[0]
    return b if isinstance(b, list) and len(b) == 4 else None

cid = sys.argv[1]
d = json.load(open(f"e2e/read/out/diag/{cid}.json"))
im = Image.open(f"e2e/read/out/plan/{cid}_a.jpg").convert("RGB")
W, H = im.size
dr = ImageDraw.Draw(im)
for key, col in (("first", (230, 0, 0)), ("second", (0, 80, 255))):
    for l in d[key].get("lines", []):
        b = unwrap(l.get("box"))
        if not b: continue
        y0, x0, y1, x1 = b
        dr.rectangle([x0 / 1000 * W, y0 / 1000 * H, x1 / 1000 * W, y1 / 1000 * H], outline=col, width=3)
im.save(sys.argv[2] if len(sys.argv) > 2 else f"e2e/read/out/diag/{cid}.png")
