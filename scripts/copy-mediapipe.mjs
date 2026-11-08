// Copies the MediaPipe WASM runtime into public/ and downloads the object detection model once, so
// the on-device safety layer is served by this app and needs no CDN at runtime.
import { cpSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "mediapipe");
mkdirSync(join(dest, "wasm"), { recursive: true });
cpSync(join(root, "node_modules", "@mediapipe", "tasks-vision", "wasm"), join(dest, "wasm"), { recursive: true });
console.log("[mediapipe] wasm runtime copied to public/mediapipe/wasm");

const MODEL = "efficientdet_lite0.tflite";
const URL = `https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/int8/1/${MODEL}`;
const modelPath = join(dest, MODEL);
if (!existsSync(modelPath) || statSync(modelPath).size < 1000) {
  try {
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
    console.log(`[mediapipe] downloaded ${MODEL}`);
  } catch (e) {
    // The app still runs: the page reports that the on-device detector is off.
    console.warn(`[mediapipe] could not download the model (${e.message}). Download it manually from ${URL} to ${modelPath}`);
  }
}
