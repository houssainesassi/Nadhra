#!/usr/bin/env python3
"""Builds fake-webcam files for e2e/vision.mjs from ordinary photos.

  python e2e/make_vision_camera.py <photo_dir> <out_dir>

photo_dir needs street.jpg (people and vehicles) and person.jpg. Writes street.mjpeg, dark.mjpeg
and approaching.mjpeg (the person growing on a still photo). Chromium plays these through --use-file-for-fake-video-capture.
"""
import os
import sys

import cv2
import numpy as np

W, H = 1280, 720
FPS = 30
PERSON_BOX = (0.35, 0.31, 0.24, 0.67)


def fit(img):
    h, w = img.shape[:2]
    s = max(W / w, H / h)
    img = cv2.resize(img, (int(w * s) + 1, int(h * s) + 1), interpolation=cv2.INTER_AREA)
    y, x = (img.shape[0] - H) // 2, (img.shape[1] - W) // 2
    return img[y : y + H, x : x + W]


def write(path, frames):
    with open(path, "wb") as f:
        for frame in frames:
            f.write(cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes())


def main(photos, out):
    os.makedirs(out, exist_ok=True)
    street = fit(cv2.imread(os.path.join(photos, "street.jpg")))
    write(os.path.join(out, "street.mjpeg"), [street] * FPS)

    rng = np.random.default_rng(1)
    dark = (street * 0.03).astype(np.uint8)
    write(os.path.join(out, "dark.mjpeg"), [np.clip(dark + rng.integers(0, 3, dark.shape, dtype=np.uint8), 0, 255) for _ in range(FPS)])

    # The person in person.jpg grows on the unchanged photo, like someone walking up to a fixed camera.
    # PERSON_BOX is where the detector finds them (x, y, w, h as fractions of the image).
    scene = cv2.resize(cv2.imread(os.path.join(photos, "person.jpg")), (W, H), interpolation=cv2.INTER_AREA)
    x0, y0, bw, bh = PERSON_BOX
    px, py, pw, ph = int(x0 * W), int(y0 * H), int(bw * W), int(bh * H)
    cut = scene[py : py + ph, px : px + pw]
    frames = []
    seconds = 5
    for i in range(FPS * seconds):
        scale = 1 + 0.45 * i / (FPS * seconds - 1)
        height, width = min(H, int(ph * scale)), int(pw * scale)
        frame = scene.copy()
        x = max(0, px + pw // 2 - width // 2)
        width = min(width, W - x)
        frame[py + ph - height : py + ph, x : x + width] = cv2.resize(cut, (width, height), interpolation=cv2.INTER_LINEAR)
        frames.append(frame)
    write(os.path.join(out, "approaching.mjpeg"), frames)
    print("wrote", out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
