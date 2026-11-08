// On-device object detection (MediaPipe, EfficientDet-Lite0): the fast safety layer. It answers in
// tens of milliseconds, sends nothing anywhere, and keeps working when the cloud model is slow or
// down. It only knows common objects (no stairs, for example): those come from the vision model.
import type { ObjectDetector } from "@mediapipe/tasks-vision";
import type { RawDetection } from "./hazardTracker.ts";

export class LocalDetector {
  private detector: ObjectDetector | null = null;

  async load() {
    if (this.detector) return;
    const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    this.detector = await ObjectDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "/mediapipe/efficientdet_lite0.tflite", delegate: "CPU" },
      runningMode: "VIDEO",
      scoreThreshold: 0.4,
      maxResults: 12,
    });
  }

  detect(video: HTMLVideoElement, timestampMs: number): RawDetection[] {
    if (!this.detector || !video.videoWidth) return [];
    const { detections } = this.detector.detectForVideo(video, timestampMs);
    const out: RawDetection[] = [];
    for (const d of detections) {
      const c = d.categories[0];
      const b = d.boundingBox;
      if (!c || !b) continue;
      out.push({
        label: c.categoryName,
        score: c.score,
        x: b.originX / video.videoWidth,
        y: b.originY / video.videoHeight,
        w: b.width / video.videoWidth,
        h: b.height / video.videoHeight,
      });
    }
    return out;
  }

  close() {
    try {
      this.detector?.close();
    } catch {}
    this.detector = null;
  }
}
