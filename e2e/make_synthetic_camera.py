#!/usr/bin/env python3
"""Builds a synthetic fake-webcam file and a silent voice clip for the e2e scenarios that mock
every AI and voice request (no photos, no Gemini quota, no Microsoft voice).

  python e2e/make_synthetic_camera.py <out_dir>

Writes synthetic.mjpeg: textured frames that change every frame, so the image is "clear" and
the scene always counts as changed. Writes silence.mp3 (3 s), if ffmpeg is installed: the mocked
cloud voice plays it, so speech takes real time as on a phone. Needs Pillow only.
"""
import os
import random
import shutil
import subprocess
import sys

from PIL import Image

W, H = 640, 360
FRAMES = 60


def main(out):
    os.makedirs(out, exist_ok=True)
    rng = random.Random(1)
    with open(os.path.join(out, "synthetic.mjpeg"), "wb") as f:
        for _ in range(FRAMES):
            img = Image.effect_noise((W // 8, H // 8), 64).resize((W, H), Image.NEAREST).convert("RGB")
            # Shift the brightness a little so no two frames are alike.
            img = img.point(lambda v, d=rng.randint(-25, 25): max(0, min(255, v + d)))
            from io import BytesIO

            buf = BytesIO()
            img.save(buf, "JPEG", quality=85)
            f.write(buf.getvalue())
    if shutil.which("ffmpeg"):
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "3", "-q:a", "9", os.path.join(out, "silence.mp3")],
            check=True,
        )
    print("wrote", out)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
