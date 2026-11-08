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
