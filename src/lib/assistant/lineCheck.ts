// Is a printed line really all there in the picture? A check on the pixels, made without any AI,
// of the place where the model says the line is (its "box"). The model was seen to complete a dose
// hidden by glare («500 m…» → «500 mg») or a finger, and a date cut by the frame, and to call those
// lines confirmed and fully visible, the same way in two independent readings. A line on a medical
// paper is only read out when this check passes in both frames (document.ts).
//
// What it looks for, around the box:
//   edge        the line touches the edge of the picture: it may continue outside it
//   covered     a solid mass (a finger, a sticker, a dark band) over the line or right after it
//   incomplete  a stretch inside the box with no ink: characters claimed where nothing is printed
//               (glare washes ink out; the model's box still spans the text it says is there)
//   faint       almost no ink anywhere in the box (a misplaced box, or nothing legible)
//   (width)     the printed ink is far too narrow for the characters claimed: a box drawn around only
//               the visible part («50» for «500 mg») → incomplete; far too wide: the box is on
//               another, longer line → mismatch
//   no-box      no usable position: the line can't be checked, so it isn't read
//
// Calibrated on the rendered test documents (e2e/read/make_plan_set.py) with real model boxes, on
// 2026-11-13: clean lines had empty stretches of at most 0.48 line heights and no solid mass; glare
// hiding «0 mg» left an empty stretch of 0.97; a finger after «50» a solid run of 0.71–0.73; a cut
// line a solid mass of 18. NOT calibrated on real phone photos. Blister foil and similar patterned
// backgrounds read as "covered": their numbered lines are then not read (safe, but less useful).
// Pure logic, no browser or Node APIs.

export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export type LineProblem = "no-box" | "edge" | "covered" | "incomplete" | "faint" | "mismatch";

/** Thresholds, in line heights unless noted. See the calibration notes above. */
export const LINE_CHECK = {
  /** Distance to the picture's edge, as a fraction of its size. */
  edge: 0.015,
  /** A pixel is ink when it differs this much from the line's background. */
  inkDelta: 40,
  /** A slice of the line, 1/4 of its height wide, with this much ink, is solid. */
  solid: 0.75,
  /** A slice with less ink than this is empty. */
  empty: 0.02,
  /** Solid inside the box over at least this length. */
  solidInside: 0.7,
  /** Solid right after the box (where the line would continue) over at least this length. */
  solidAfter: 0.5,
  /** Empty inside the box over at least this length. */
  emptyInside: 0.75,
  /** Mean ink in the box below this: nothing legible. */
  faint: 0.04,
  /** Smallest line height checked, in pixels. */
  minHeight: 6,
  /**
   * Ink width per character claimed, in line heights. Clean lines measured 0.26-0.97 (n=182, both
   * models, 2026-11-13); «50» boxed for «500 mg» gives about 0.20.
   */
  minWidthPerChar: 0.22,
  maxWidthPerChar: 1.3,
} as const;

/** [ymin, xmin, ymax, xmax] in thousandths of the picture, as Gemini gives it; also accepted wrapped once in an array. */
export function parseBox(v: unknown): [number, number, number, number] | null {
  let b = v;
  while (Array.isArray(b) && b.length === 1 && Array.isArray(b[0])) b = b[0];
  if (!Array.isArray(b) || b.length !== 4 || !b.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const [y0, x0, y1, x1] = b as number[];
  if (!(y0 >= 0 && x0 >= 0 && y1 <= 1000 && x1 <= 1000 && y1 > y0 && x1 > x0)) return null;
  return [y0, x0, y1, x1];
}

/** Characters as the space they take: a space is narrower. */
const charCount = (text: string) => text.replace(/\s+/g, "").length + 0.5 * (text.match(/\s+/g)?.length ?? 0);

/** The problem with this line in this picture, or null when it is all there. */
export function inspectLine(img: GrayImage, box: unknown, text: string): LineProblem | null {
  const b = parseBox(box);
  if (!b) return "no-box";
  const { width: W, height: H, data } = img;
  const y0 = (b[0] / 1000) * H, x0 = (b[1] / 1000) * W, y1 = (b[2] / 1000) * H, x1 = (b[3] / 1000) * W;
  const h = y1 - y0;
  if (h < LINE_CHECK.minHeight || x1 - x0 < LINE_CHECK.minHeight) return "no-box";
  if (Math.min(x0 / W, y0 / H, 1 - x1 / W, 1 - y1 / H) < LINE_CHECK.edge) return "edge";

  // The line's background: the median of a band just above and just below the box.
  const pad = Math.max(2, Math.round(0.25 * h));
  const hist = new Uint32Array(256);
  let ringCount = 0;
  const addRows = (ya: number, yb: number) => {
    for (let y = Math.max(0, Math.floor(ya)); y < Math.min(H, Math.ceil(yb)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
        hist[data[y * W + x]]++;
        ringCount++;
      }
    }
  };
  addRows(y0 - pad, y0);
  addRows(y1, y1 + pad);
  if (!ringCount) addRows(y0, y1);
  let bg = 0;
  for (let acc = 0, half = ringCount / 2; bg < 255 && (acc += hist[bg]) < half; bg++);

  const sw = Math.max(2, Math.round(0.25 * h));
  const rowA = Math.max(0, Math.floor(y0)), rowB = Math.min(H, Math.ceil(y1));
  const inkOf = (xa: number, xb: number): number => {
    let ink = 0, n = 0;
    for (let y = rowA; y < rowB; y++) {
      for (let x = Math.max(0, Math.floor(xa)); x < Math.min(W, Math.ceil(xb)); x++) {
        if (Math.abs(data[y * W + x] - bg) > LINE_CHECK.inkDelta) ink++;
        n++;
      }
    }
    return n ? ink / n : 0;
  };
  const slices = (xa: number, xb: number) => {
    const out: number[] = [];
    for (let x = xa; x < xb - 1; x += sw) out.push(inkOf(x, Math.min(xb, x + sw)));
    return out;
  };
  /** The longest run of slices meeting `cond`, in line heights. */
  const longest = (list: number[], cond: (ink: number) => boolean) => {
    let best = 0, cur = 0;
    for (const v of list) best = Math.max(best, (cur = cond(v) ? cur + 1 : 0));
    return (best * sw) / h;
  };

  const inside = slices(x0, x1);
  // Where the line would go on if the box is shorter than the characters claimed, and a little more.
  const need = charCount(text) * 0.42 * h;
  const after = slices(x1, Math.min(W, x1 + Math.max(0.6 * h, need - (x1 - x0))));
  const meanInk = inside.reduce((a, v) => a + v, 0) / Math.max(1, inside.length);

  if (longest(inside, (v) => v > LINE_CHECK.solid) >= LINE_CHECK.solidInside) return "covered";
  if (longest(after, (v) => v > LINE_CHECK.solid) >= LINE_CHECK.solidAfter) return "covered";
  if (meanInk < LINE_CHECK.faint) return "faint";
  if (longest(inside, (v) => v < LINE_CHECK.empty) >= LINE_CHECK.emptyInside) return "incomplete";
  const perChar = inkWidthPerChar(img, b, text);
  if (perChar !== null && perChar < LINE_CHECK.minWidthPerChar) return "incomplete";
  if (perChar !== null && perChar > LINE_CHECK.maxWidthPerChar) return "mismatch";
  return null;
}

/**
 * How wide the printed ink in the box is, per character claimed, in line heights: from the first to
 * the last column with ink. Null when there is no usable box or no ink. Used to catch a box drawn
 * around only the visible part of a line («50» for «500 mg») or around another line.
 */
export function inkWidthPerChar(img: GrayImage, box: unknown, text: string): number | null {
  const b = parseBox(box);
  if (!b) return null;
  const { width: W, height: H, data } = img;
  const y0 = (b[0] / 1000) * H, x0 = (b[1] / 1000) * W, y1 = (b[2] / 1000) * H, x1 = (b[3] / 1000) * W;
  const h = y1 - y0;
  const chars = charCount(text);
  if (h < LINE_CHECK.minHeight || chars < 1) return null;
  const pad = Math.max(2, Math.round(0.25 * h));
  const hist = new Uint32Array(256);
  let n = 0;
  for (const [ya, yb] of [[y0 - pad, y0], [y1, y1 + pad]]) {
    for (let y = Math.max(0, Math.floor(ya)); y < Math.min(H, Math.ceil(yb)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) (hist[data[y * W + x]]++, n++);
    }
  }
  let bg = 0;
  for (let acc = 0; bg < 255 && (acc += hist[bg]) < n / 2; bg++);
  let first = -1, last = -1;
  for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x1)); x++) {
    let ink = 0, rows = 0;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(H, Math.ceil(y1)); y++, rows++) if (Math.abs(data[y * W + x] - bg) > LINE_CHECK.inkDelta) ink++;
    if (rows && ink / rows > 0.05) {
      if (first < 0) first = x;
      last = x;
    }
  }
  return first < 0 ? null : (last - first + 1) / h / chars;
}

/** RGBA (as decoded from a JPEG) to one byte of brightness per pixel. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    const p = i << 2;
    data[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  }
  return { data, width, height };
}
