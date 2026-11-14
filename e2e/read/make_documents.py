#!/usr/bin/env python3
"""Makes photo-like test pictures of documents for the reading tests (e2e/read/run.ts).

    python3 e2e/read/make_documents.py e2e/read/out/images

Each document is rendered flat, then photographed in software: put on a table, tilted in
perspective, lit unevenly, with sensor noise and JPEG compression. Some get the problems the
reader must refuse to guess through: blur, glare over the dose, a cut-off edge, darkness.

Brand names are invented on purpose (FEBRALIX, GASTRONIL, AMOXINEL): a model that "corrects"
them into a real brand is inventing a medicine name, which the tests catch.

These are rendered, not real photographs: they prove the software path and the safety checks,
not the reading quality on real crumpled boxes and handwriting. Needs Pillow (with raqm for
Arabic) and numpy.
"""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont, features

FONTS = {
    "sans": ["/run/host/fonts/noto/NotoSans-Regular.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf"],
    "bold": ["/run/host/fonts/noto/NotoSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"],
    "serif": ["/run/host/fonts/noto/NotoSerif-Regular.ttf", "/usr/share/fonts/dejavu/DejaVuSerif.ttf"],
    # DejaVu first: the Noto Arabic fonts have no "/" (dates came out as empty boxes).
    "arabic": ["/usr/share/fonts/dejavu/DejaVuSans.ttf", "/run/host/fonts/noto/NotoNaskhArabic-Regular.ttf"],
    "arabic-bold": ["/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf", "/run/host/fonts/noto/NotoSansArabic-Bold.ttf"],
}


def font(kind, size):
    for path in FONTS[kind]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    raise SystemExit(f"no font for {kind}")


def text(draw, xy, s, kind="sans", size=28, fill=(20, 20, 20), anchor="la"):
    rtl = kind.startswith("arabic")
    draw.text(xy, s, font=font(kind, size), fill=fill, anchor=("ra" if rtl and anchor == "la" else anchor),
              direction=("rtl" if rtl else None), language=("ar" if rtl else None))


# --- documents, flat ---------------------------------------------------------------------------

def medicine_box():
    img = Image.new("RGB", (1000, 640), (250, 250, 247))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 1000, 120], fill=(0, 92, 160))
    text(d, (40, 22), "FEBRALIX®", "bold", 64, (255, 255, 255))
    text(d, (40, 150), "500 mg", "bold", 56, (0, 92, 160))
    text(d, (40, 230), "Paracétamol", "sans", 40)
    text(d, (40, 290), "16 comprimés pelliculés", "sans", 34)
    text(d, (40, 345), "Voie orale", "sans", 30)
    text(d, (40, 395), "Adultes et enfants à partir de 27 kg", "sans", 26, (60, 60, 60))
    d.rectangle([0, 470, 1000, 640], fill=(236, 240, 244))
    text(d, (40, 490), "Lot : 4K217", "sans", 28)
    text(d, (40, 535), "EXP : 03/2027", "bold", 30)
    text(d, (40, 585), "Laboratoires Medisud – Tunis", "sans", 24, (90, 90, 90))
    text(d, (960, 160), "باراسيتامول", "arabic", 40, anchor="ra")
    return img


def medicine_back_expired():
    img = Image.new("RGB", (900, 420), (255, 253, 245))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, 900, 90], fill=(170, 30, 40))
    text(d, (30, 14), "AMOXINEL 1 g", "bold", 52, (255, 255, 255))
    text(d, (30, 120), "Amoxicilline", "sans", 36)
    text(d, (30, 175), "12 comprimés dispersibles", "sans", 32)
    text(d, (30, 250), "LOT 22B91", "sans", 30)
    text(d, (30, 300), "EXP 05/2025", "bold", 34)
    text(d, (30, 355), "Médicament soumis à prescription médicale", "sans", 24, (80, 80, 80))
    return img


def prescription():
    img = Image.new("RGB", (900, 1250), (255, 255, 255))
    d = ImageDraw.Draw(img)
    text(d, (50, 50), "Dr Sami Ben Salem", "bold", 40)
    text(d, (50, 105), "Médecin généraliste", "sans", 28)
    text(d, (50, 145), "12, rue des Oliviers – Tunis   Tél : 71 000 000", "sans", 22, (70, 70, 70))
    d.line([50, 195, 850, 195], fill=(0, 0, 0), width=2)
    text(d, (560, 225), "Tunis, le 10/11/2026", "serif", 26)
    text(d, (50, 290), "Mme Leila Trabelsi", "serif", 30)
    text(d, (330, 360), "ORDONNANCE", "bold", 36)
    text(d, (50, 450), "1) FEBRALIX 500 mg", "bold", 32)
    text(d, (90, 500), "1 comprimé 3 fois par jour pendant 5 jours", "serif", 28)
    text(d, (50, 580), "2) GASTRONIL 20 mg", "bold", 32)
    text(d, (90, 630), "1 gélule le matin à jeun pendant 14 jours", "serif", 28)
    text(d, (50, 710), "3) Sirop TUSSIDEX", "bold", 32)
    text(d, (90, 760), "1 cuillère à café le soir si toux", "serif", 28)
    text(d, (560, 1000), "Signature et cachet", "serif", 24, (90, 90, 90))
    d.ellipse([600, 1040, 800, 1160], outline=(40, 60, 160), width=4)
    return img


def invoice_ar():
    img = Image.new("RGB", (900, 1100), (255, 255, 255))
    d = ImageDraw.Draw(img)
    R = 850
    text(d, (R, 50), "شركة الأمل لتوزيع الماء", "arabic-bold", 40)
    text(d, (R, 115), "فاتورة استهلاك", "arabic-bold", 36)
    d.line([50, 180, 850, 180], fill=(0, 0, 0), width=2)
    rows = [
        ("اسم الحريف: محمد الهادي بن عمر", "arabic"),
        ("رقم العقد: 45 1209 87", "arabic"),
        ("الفترة: من 01/08/2026 إلى 31/10/2026", "arabic"),
        ("الاستهلاك: 38 متر مكعب", "arabic"),
        ("المبلغ الجملي: 87,450 دينار", "arabic-bold"),
        ("آخر أجل للدفع: 25/11/2026", "arabic-bold"),
    ]
    y = 220
    for s, k in rows:
        text(d, (R, y), s, k, 34)
        y += 80
    text(d, (R, 800), "يمكن الخلاص في مكاتب البريد أو عبر الإنترنت", "arabic", 28, (80, 80, 80))
    return img


def letter_ar():
    img = Image.new("RGB", (900, 1150), (252, 252, 250))
    d = ImageDraw.Draw(img)
    R = 850
    text(d, (R, 50), "الجمهورية التونسية", "arabic-bold", 34)
    text(d, (R, 105), "بلدية الياسمين", "arabic-bold", 34)
    text(d, (R, 200), "إلى السيد كمال الشريف", "arabic", 32)
    text(d, (R, 270), "الموضوع: استدعاء", "arabic-bold", 32)
    lines = [
        "نطلب منكم الحضور بمقر البلدية يوم الخميس 20/11/2026",
        "على الساعة العاشرة صباحا لإتمام ملف رخصة البناء.",
        "الرجاء إحضار بطاقة التعريف الوطنية.",
    ]
    y = 350
    for s in lines:
        text(d, (R, y), s, "arabic", 30)
        y += 64
    text(d, (R, 620), "رئيس البلدية", "arabic", 30)
    return img


# --- photographing them --------------------------------------------------------------------------

def perspective_coeffs(src, dst):
    """Coefficients for Image.transform(PERSPECTIVE) mapping output points dst to input points src."""
    a = []
    for (x, y), (u, v) in zip(dst, src):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
    b = np.array(src, dtype=float).reshape(8)
    return np.linalg.solve(np.array(a, dtype=float), b).tolist()


def photograph(doc, seed, out_size=(1600, 1200), tilt=0.06, scale=0.78, light=0.25, noise=6.0):
    rng = np.random.default_rng(seed)
    W, H = out_size
    # A wooden-ish table.
    yy, xx = np.mgrid[0:H, 0:W]
    grain = (np.sin(xx / 7.0 + np.sin(yy / 60.0) * 3) * 10 + rng.normal(0, 4, (H, W)))
    table = np.stack([150 + grain, 110 + grain * 0.8, 75 + grain * 0.6], axis=-1)
    canvas = Image.fromarray(np.clip(table, 0, 255).astype(np.uint8))

    w, h = doc.size
    fit = min(W * scale / w, H * scale / h)
    dw, dh = w * fit, h * fit
    cx, cy = W / 2 + rng.uniform(-30, 30), H / 2 + rng.uniform(-30, 30)
    j = lambda: rng.uniform(-tilt, tilt) * dw
    dst = [(cx - dw / 2 + j(), cy - dh / 2 + j()), (cx + dw / 2 + j(), cy - dh / 2 + j()),
           (cx + dw / 2 + j(), cy + dh / 2 + j()), (cx - dw / 2 + j(), cy + dh / 2 + j())]
    src = [(0, 0), (w, 0), (w, h), (0, h)]
    coeffs = perspective_coeffs(src, dst)
    warped = doc.convert("RGBA").transform((W, H), Image.PERSPECTIVE, coeffs, Image.BICUBIC)
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).polygon([(x + 12, y + 14) for x, y in dst], fill=(0, 0, 0, 90))
    canvas = Image.alpha_composite(canvas.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(12)))
    canvas = Image.alpha_composite(canvas, warped).convert("RGB")

    arr = np.asarray(canvas).astype(float)
    gx = np.linspace(1 - light, 1 + light * 0.4, W)[None, :, None]
    gy = np.linspace(1 + light * 0.2, 1 - light * 0.6, H)[:, None, None]
    arr = arr * gx * gy + rng.normal(0, noise, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def glare(img, box):
    """A bright reflection, as from a lamp on glossy cardboard."""
    over = Image.new("L", img.size, 0)
    ImageDraw.Draw(over).ellipse(box, fill=255)
    over = over.filter(ImageFilter.GaussianBlur(25))
    white = Image.new("RGB", img.size, (255, 255, 255))
    return Image.composite(white, img, over)


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    if not features.check("raqm"):
        print("warning: Pillow has no raqm: Arabic will be rendered unshaped", file=sys.stderr)
    save = lambda img, name: img.save(os.path.join(out, name), "JPEG", quality=88)

    box = photograph(medicine_box(), 1)
    save(box, "medicine_fr.jpg")
    save(box.filter(ImageFilter.GaussianBlur(9)), "medicine_blurry.jpg")
    # The reflection sits over the strength ("500 mg").
    save(glare(box, (300, 300, 760, 520)), "medicine_glare.jpg")
    save(photograph(medicine_back_expired(), 2), "medicine_expired.jpg")
    rx = photograph(prescription(), 3, out_size=(1200, 1600))
    save(rx, "prescription_fr.jpg")
    # Cut off: only the top and the first medicine are in the frame.
    save(rx.crop((0, 0, 1200, 820)).resize((1200, 820)), "prescription_cut.jpg")
    save(photograph(invoice_ar(), 4, out_size=(1200, 1600)), "invoice_ar.jpg")
    save(photograph(letter_ar(), 5, out_size=(1200, 1600)), "letter_ar.jpg")
    dark = np.asarray(photograph(medicine_box(), 6)).astype(float) * 0.12
    save(Image.fromarray(np.clip(dark + np.random.default_rng(6).normal(0, 4, dark.shape), 0, 255).astype(np.uint8)), "medicine_dark.jpg")
    # No text at all: an empty table.
    save(photograph(Image.new("RGB", (10, 10), (150, 110, 75)), 7, scale=0.01), "no_text.jpg")
    print("wrote", sorted(os.listdir(out)))


if __name__ == "__main__":
    main()
