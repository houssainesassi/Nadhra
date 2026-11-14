// Cheap checks on a small grayscale copy of the frame, done on the device: is the picture usable,
// and has the scene changed enough to be worth a request? Pure logic.

export interface FrameStats {
  /** 0..255 */
  meanLuma: number;
  /** Standard deviation of brightness: very low means a covered lens or a blank surface. */
  contrast: number;
  /** Variance of the Laplacian: low means blurred. */
  sharpness: number;
}

export type LocalQuality = "ok" | "dark" | "bright" | "flat" | "blurry";

export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const gray = new Uint8Array(rgba.length >> 2);
  for (let i = 0; i < gray.length; i++) {
    const p = i << 2;
    gray[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return gray;
}

export function frameStats(gray: Uint8Array, width: number, height: number): FrameStats {
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < gray.length; i++) {
    sum += gray[i];
    sumSq += gray[i] * gray[i];
  }
  const n = gray.length || 1;
  const mean = sum / n;
  const contrast = Math.sqrt(Math.max(0, sumSq / n - mean * mean));

  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      lapSum += lap;
      lapSq += lap * lap;
      count++;
    }
  }
  const lapMean = count ? lapSum / count : 0;
  return { meanLuma: mean, contrast, sharpness: count ? lapSq / count - lapMean * lapMean : 0 };
}

export const QUALITY_LIMITS = { dark: 30, bright: 245, flat: 7, blurry: 12 };

export function classifyQuality(s: FrameStats): LocalQuality {
  if (s.meanLuma < QUALITY_LIMITS.dark) return "dark";
  if (s.meanLuma > QUALITY_LIMITS.bright) return "bright";
  if (s.contrast < QUALITY_LIMITS.flat) return "flat";
  if (s.sharpness < QUALITY_LIMITS.blurry) return "blurry";
  return "ok";
}

/**
 * Fraction of pixels (0..1) whose brightness changed noticeably. Counts pixels rather than averaging
 * so sensor noise doesn't add up, while one person entering part of the view still does.
 */
export function changedFraction(a: Uint8Array, b: Uint8Array, pixelDelta = 28): number {
  if (a.length !== b.length || !a.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > pixelDelta) changed++;
  return changed / a.length;
}

/**
 * Sharpness of the sharpest part of the frame: the variance of the Laplacian in the best of a 4×4
 * grid of tiles. Text often fills only part of the picture, so the whole-frame average would call a
 * sharp label on a plain table blurred. The frame is first smoothed with a 3×3 box: camera noise
 * alone otherwise scores like sharp detail, and a blurred page from a noisy camera passed as sharp.
 * Meant for a frame of about 640 px wide.
 */
export function sharpestTile(gray: Uint8Array, width: number, height: number, grid = 4): number {
  const smooth = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      smooth[i] = (gray[i - width - 1] + gray[i - width] + gray[i - width + 1] + gray[i - 1] + gray[i] + gray[i + 1] + gray[i + width - 1] + gray[i + width] + gray[i + width + 1]) / 9;
    }
  }
  let best = 0;
  const tw = Math.floor(width / grid);
  const th = Math.floor(height / grid);
  for (let ty = 0; ty < grid; ty++) {
    for (let tx = 0; tx < grid; tx++) {
      let sum = 0, sumSq = 0, n = 0;
      for (let y = Math.max(2, ty * th); y < Math.min(height - 2, (ty + 1) * th); y++) {
        for (let x = Math.max(2, tx * tw); x < Math.min(width - 2, (tx + 1) * tw); x++) {
          const i = y * width + x;
          const lap = smooth[i - 1] + smooth[i + 1] + smooth[i - width] + smooth[i + width] - 4 * smooth[i];
          sum += lap;
          sumSq += lap * lap;
          n++;
        }
      }
      if (n) best = Math.max(best, sumSq / n - (sum / n) ** 2);
    }
  }
  return best;
}

/**
 * Below this, small print can't be read (sharpestTile on 640 × 480). Calibrated on rendered
 * documents photographed in software (e2e/read/make_documents.py), with camera noise added after
 * the blur as a real camera does: sharp pages score 280-460, slightly soft but readable ones 22-80,
 * a Gaussian blur of 6 px at 1600 px (unreadable small print) 8-15 with noise. Set low, so a real
 * but dull frame isn't refused: only gross blur is caught here, and the model reports the rest.
 * Not yet calibrated on real phone frames.
 */
export const READ_BLUR_LIMIT = 20;
