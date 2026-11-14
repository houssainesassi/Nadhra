// The pixel check of printed lines (lineCheck.ts): no AI, only the picture. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectLine, LINE_CHECK, parseBox, toGray, type GrayImage } from "../src/lib/assistant/lineCheck.ts";

const W = 800, H = 600;
/** A page with one printed line of text-like strokes in `box` (thousandths), and optional damage. */
function page(box: number[], opts: { erase?: number; finger?: boolean; inside?: boolean; bg?: number } = {}): GrayImage {
  const data = new Uint8Array(W * H).fill(opts.bg ?? 225);
  const [y0, x0, y1, x1] = [(box[0] / 1000) * H, (box[1] / 1000) * W, (box[2] / 1000) * H, (box[3] / 1000) * W].map(Math.round);
  const stop = opts.erase !== undefined ? x0 + (x1 - x0) * opts.erase : x1;
  for (let y = y0 + Math.round((y1 - y0) * 0.15); y < y1 - Math.round((y1 - y0) * 0.15); y++) for (let x = x0; x < stop; x++) if (x % 7 < 3) data[y * W + x] = 25;
  // A finger: a solid patch over the line's end and beyond it.
  if (opts.finger) for (let y = y0 - 10; y < y1 + 10; y++) for (let x = x1 - 20; x < x1 + 120; x++) data[y * W + x] = 150;
  if (opts.inside) for (let y = y0; y < y1; y++) for (let x = x0 + 40; x < x0 + 140; x++) data[y * W + x] = 60;
  return { data, width: W, height: H };
}
const BOX = [300, 200, 360, 520];

test("a whole printed line passes", () => {
  assert.equal(inspectLine(page(BOX), BOX, "FEBRALIX 500 mg"), null);
  assert.equal(inspectLine(page(BOX, { bg: 252 }), BOX, "FEBRALIX 500 mg"), null, "on white paper too");
});

test("characters claimed where nothing is printed (glare washing the end out) → incomplete", () => {
  assert.equal(inspectLine(page(BOX, { erase: 0.55 }), BOX, "FEBRALIX 500 mg"), "incomplete");
});

test("a solid mass over the line or right after it (a finger) → covered", () => {
  assert.equal(inspectLine(page(BOX, { finger: true }), BOX, "FEBRALIX 500 mg"), "covered");
  assert.equal(inspectLine(page(BOX, { inside: true }), BOX, "FEBRALIX 500 mg"), "covered");
});

test("a line at the edge of the picture → edge; nothing printed → faint; no usable box → no-box", () => {
  const atEdge = [300, 200, 360, 995];
  assert.equal(inspectLine(page(atEdge), atEdge, "FEBRALIX 500 mg"), "edge");
  assert.equal(inspectLine({ data: new Uint8Array(W * H).fill(225), width: W, height: H }, BOX, "FEBRALIX 500 mg"), "faint");
  for (const bad of [undefined, null, [1, 2, 3], [300, 600, 360, 200], [0, 0, 1001, 10], ["1", 2, 3, 4], [300, 200, 301, 520]]) assert.equal(inspectLine(page(BOX), bad, "x"), "no-box", JSON.stringify(bad));
});

test("box format: Gemini's [ymin, xmin, ymax, xmax] in thousandths, also wrapped once", () => {
  assert.deepEqual(parseBox([[300, 200, 360, 520]]), [300, 200, 360, 520]);
  assert.deepEqual(parseBox([300, 200, 360, 520]), [300, 200, 360, 520]);
  assert.equal(parseBox([[[1, 2]]]), null);
  assert.equal(LINE_CHECK.edge > 0 && LINE_CHECK.emptyInside < 1, true);
});

test("toGray: RGBA to brightness", () => {
  const g = toGray(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]), 3, 1);
  assert.deepEqual([...g.data], [255, 0, 76]);
});

test("a box drawn tightly around only the visible part («50» claimed as «500 mg») → incomplete", () => {
  // Ink only over the first 30 % of the line: a box around just that, but text claiming the whole line.
  const img = page(BOX, { erase: 0.3 });
  const tight = [BOX[0], BOX[1], BOX[2], BOX[1] + (BOX[3] - BOX[1]) * 0.3];
  assert.equal(inspectLine(img, tight, "FEBRALIX 500 mg"), "incomplete");
  assert.equal(inspectLine(img, tight, "FEBR"), null, "the same box for the text really shown passes");
});

test("a box on another, much longer line than the text claimed → mismatch", () => {
  assert.equal(inspectLine(page(BOX), BOX, "50"), "mismatch");
});

test("ink width per character: clean text is within the calibrated range", async () => {
  const { inkWidthPerChar } = await import("../src/lib/assistant/lineCheck.ts");
  const w = inkWidthPerChar(page(BOX), BOX, "FEBRALIX 500 mg")!;
  assert.ok(w > LINE_CHECK.minWidthPerChar && w < LINE_CHECK.maxWidthPerChar, String(w));
});
