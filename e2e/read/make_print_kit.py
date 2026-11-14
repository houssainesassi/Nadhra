#!/usr/bin/env python3
"""A printable kit of the synthetic test documents, for the real-camera sessions
(docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md).

    python3 e2e/read/make_print_kit.py e2e/read/out/kit

Writes kit.pdf (A4, print at 100 %, no scaling) and kit.json (the ground truth of each document, the
same as the 31-case plan). Every document is invented: FEBRALIX, AMOXINEL and the others don't exist,
and the patients and doctors are fictional. Each page says so, outside the cut line, so a printed
page can't be mistaken for a real medicine or prescription.

What is printed is the clean document. Glare, fingers, blur, darkness, distance, angles and cut-off
edges are made physically during the session (see the protocol), not printed.
"""
import json
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_plan_set as plan  # noqa: E402
from make_documents import font  # noqa: E402

DPI = 300
A4 = (2480, 3508)
# Printed width in cm: boxes and flaps at the size of a real box face, papers at about A6/A5.
WIDTH_CM = {"medicine": 9.0, "prescription": 14.8, "medical": 14.8}
# The kit holds each physical document once. The glare, finger, blur, dim, cut-off cases (M16-M20)
# are made with the FEBRALIX box (M01) during the session.
KIT = ["M01", "M02", "M03", "M04", "M05", "M06", "M07", "M08", "M09", "M10", "M11", "M12", "M13", "M14", "M15",
       "P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10"]
NOTES = {
    "M04": "Wrap around a round bottle (about 5 cm across), text facing out.",
    "M07": "Glue onto the flap of an empty box.",
    "M08": "Printed shading only: real embossing can't be printed. Press the characters into thin card with a dry ballpoint for a real test.",
    "M13": "Print on glossy or metallic photo paper, or cover with clear tape, to get foil-like reflections.",
    "M14": "Smallest print of the kit: print at 100 %.",
    "M15": "Glue onto a small dropper bottle.",
    "P07": "Same as P01: photograph it at about 45 degrees.",
}


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    tmp = os.path.join(out, "_plan_tmp")
    plan.build(tmp)  # fills plan.FLAT and plan.CASES
    flat = dict(plan.FLAT)
    flat["M04"] = plan.syrup_label(flat=True)
    truth = {c["id"]: c for c in plan.CASES}
    pages = []
    cover = Image.new("RGB", A4, "white")
    d = ImageDraw.Draw(cover)
    d.text((150, 150), "Nadhra test kit: synthetic documents", font=font("bold", 80), fill="black")
    lines = ["Everything in this kit is invented: no real medicine, patient or doctor.",
             "Print at 100 % (no scaling). Cut along the dashed lines.",
             "Use only for the real-camera sessions in docs/PHASE1_REAL_CAMERA_TEST_PROTOCOL.md.", ""]
    lines += [f"{cid}  {truth[cid]['title']}" + (f"  ({NOTES[cid]})" if cid in NOTES else "") for cid in KIT]
    for i, l in enumerate(lines):
        d.text((150, 330 + i * 70), l, font=font("sans", 40), fill="black")
    pages.append(cover)
    for cid in KIT:
        doc = flat[cid]
        kind = truth[cid]["kind"]
        w = int(WIDTH_CM.get(kind, 9.0) / 2.54 * DPI)
        h = int(doc.height * w / doc.width)
        img = doc.resize((w, h), Image.LANCZOS)
        page = Image.new("RGB", A4, "white")
        pd = ImageDraw.Draw(page)
        x, y = (A4[0] - w) // 2, 400
        page.paste(img, (x, y))
        for k in range(0, w, 30):  # dashed cut line
            pd.line([x + k, y - 20, x + k + 15, y - 20], fill="gray", width=3)
            pd.line([x + k, y + h + 20, x + k + 15, y + h + 20], fill="gray", width=3)
        for k in range(0, h, 30):
            pd.line([x - 20, y + k, x - 20, y + k + 15], fill="gray", width=3)
            pd.line([x + w + 20, y + k, x + w + 20, y + k + 15], fill="gray", width=3)
        pd.text((150, 150), f"{cid}: {truth[cid]['title']}. FICTIONAL SPECIMEN, not a medicine or a prescription.", font=font("sans", 44), fill="black")
        if cid in NOTES:
            pd.text((150, y + h + 80), NOTES[cid], font=font("sans", 36), fill="black")
        pages.append(page)
    pages[0].save(os.path.join(out, "kit.pdf"), save_all=True, append_images=pages[1:], resolution=DPI)
    os.makedirs(os.path.join(out, "preview"), exist_ok=True)
    for i, pg in enumerate(pages):
        pg.resize((A4[0] // 5, A4[1] // 5)).save(os.path.join(out, "preview", f"{i:02d}.png"))
    with open(os.path.join(out, "kit.json"), "w") as f:
        json.dump([truth[c] for c in KIT], f, ensure_ascii=False, indent=1)
    print(f"{len(KIT)} documents: {out}/kit.pdf, {out}/kit.json")


if __name__ == "__main__":
    main()
