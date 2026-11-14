// Where frames come from. The assistant only knows this interface, so another source (for example
// smart glasses that stream to the page) can be added by implementing it and registering it below.
// Only the webcam source exists today; nothing here has been tested with real glasses.
import { attachStream, CameraError, openCamera, stopCamera } from "../camera/camera.ts";

export interface CapturedFrame {
  /** JPEG, base64 without the data: prefix. */
  base64: string;
  at: number;
}

export interface GrayFrame {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface CameraSource {
  readonly kind: string;
  /** "environment": looks away from the user. "user": looks at the user. "unknown": the device doesn't say. */
  readonly facing: "user" | "environment" | "unknown";
  start(): Promise<void>;
  /** Must release the hardware. */
  stop(): void;
  isLive(): boolean;
  capture(maxSide: number, quality: number): CapturedFrame | null;
  /**
   * Optional: a still photo at the sensor's full resolution, for reading small print. Sources without
   * one, or a failed photo, fall back to `capture`.
   */
  captureStill?(maxSide: number, quality: number): Promise<CapturedFrame | null>;
  /** Small raw copy for quick checks on the device. */
  thumbnail(width: number, height: number): GrayFrame | null;
  /** For the on-device detector, when the source plays in a video element. */
  videoElement(): HTMLVideoElement | null;
  /** Called if the source dies on its own (unplugged, permission revoked). */
  onEnded(fn: () => void): void;
  /** Switch to the next camera, when there is more than one. Resolves false if there is none. */
  switchDevice?(): Promise<boolean>;
}

const STILL_TIMEOUT_MS = 3_000;
/** The server accepts up to 2 MB of base64. */
const MAX_STILL_CHARS = 1_900_000;

export class WebcamSource implements CameraSource {
  readonly kind = "webcam";
  private video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private ended: (() => void) | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private thumb: HTMLCanvasElement | null = null;
  private wanted: "user" | "environment" = "environment";

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  get facing(): "user" | "environment" | "unknown" {
    const f = this.stream?.getVideoTracks()[0]?.getSettings().facingMode;
    return f === "user" || f === "environment" ? f : "unknown";
  }

  async start() {
    await this.open();
  }

  private async open() {
    // Prefers the back camera; a laptop simply gives its only webcam. 720p so small print stays readable.
    const stream = await openCamera(this.wanted, { width: 1280, height: 720, frameRate: 15 });
    this.stream = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (this.stream === stream) this.ended?.();
    });
    try {
      await attachStream(this.video, stream);
    } catch (e) {
      this.stop();
      throw new CameraError("unknown", (e as Error).message);
    }
  }

  stop() {
    const stream = this.stream;
    this.stream = null; // an "ended" event from our own stop is not a failure
    stopCamera(this.video, stream);
  }

  isLive() {
    return !!this.stream?.getVideoTracks().some((t) => t.readyState === "live");
  }

  private ready() {
    return this.video.readyState >= 2 && this.video.videoWidth > 0;
  }

  capture(maxSide: number, quality: number): CapturedFrame | null {
    if (!this.ready()) return null;
    const scale = Math.min(1, maxSide / Math.max(this.video.videoWidth, this.video.videoHeight));
    const canvas = (this.canvas ??= document.createElement("canvas"));
    canvas.width = Math.round(this.video.videoWidth * scale);
    canvas.height = Math.round(this.video.videoHeight * scale);
    canvas.getContext("2d")?.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", quality);
    const comma = url.indexOf(",");
    return comma > 0 && url.startsWith("data:image/jpeg") ? { base64: url.slice(comma + 1), at: Date.now() } : null;
  }

  /**
   * A full-resolution photo through ImageCapture (Chrome on Android), scaled to maxSide. The video
   * runs at 720p for the detector and the battery; a photo is often twice as sharp, which matters
   * for the small print on a medicine box. Anything unsupported or slow falls back to a video frame.
   */
  async captureStill(maxSide: number, quality: number): Promise<CapturedFrame | null> {
    const track = this.stream?.getVideoTracks()[0];
    const Capture = (globalThis as { ImageCapture?: new (t: MediaStreamTrack) => { takePhoto(): Promise<Blob> } }).ImageCapture;
    if (!track || typeof Capture !== "function" || typeof createImageBitmap !== "function") return this.capture(maxSide, quality);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const blob = await Promise.race([
        new Capture(track).takePhoto(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("photo timed out")), STILL_TIMEOUT_MS))),
      ]);
      const bitmap = await createImageBitmap(blob);
      try {
        // A photo no better than the video isn't worth its larger upload.
        if (Math.max(bitmap.width, bitmap.height) <= Math.max(this.video.videoWidth, this.video.videoHeight)) return this.capture(maxSide, quality);
        const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        let url = canvas.toDataURL("image/jpeg", quality);
        if (url.length > MAX_STILL_CHARS) url = canvas.toDataURL("image/jpeg", 0.7);
        const comma = url.indexOf(",");
        if (comma < 0 || !url.startsWith("data:image/jpeg") || url.length > MAX_STILL_CHARS) return this.capture(maxSide, quality);
        return { base64: url.slice(comma + 1), at: Date.now() };
      } finally {
        bitmap.close();
      }
    } catch {
      return this.capture(maxSide, quality);
    } finally {
      clearTimeout(timer);
    }
  }

  thumbnail(width: number, height: number): GrayFrame | null {
    if (!this.ready()) return null;
    const canvas = (this.thumb ??= document.createElement("canvas"));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(this.video, 0, 0, width, height);
    return { rgba: ctx.getImageData(0, 0, width, height).data, width, height };
  }

  videoElement() {
    return this.video;
  }

  onEnded(fn: () => void) {
    this.ended = fn;
  }

  async switchDevice(): Promise<boolean> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.filter((d) => d.kind === "videoinput").length < 2) return false;
    this.stop();
    this.wanted = this.wanted === "environment" ? "user" : "environment";
    await this.open();
    return true;
  }
}

/** Register other camera sources here. */
export function createCameraSource(kind: "webcam", video: HTMLVideoElement): CameraSource {
  switch (kind) {
    case "webcam":
      return new WebcamSource(video);
  }
}
