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
  /**
   * Switch between the front and back camera (on a computer: to the next webcam). Resolves false when
   * there is no other camera or it couldn't be opened; the previous camera is then on again. Throws
   * only if no camera could be reopened at all.
   */
  switchDevice?(): Promise<boolean>;
  /** The camera in use, so the next start (after Stop, or coming back to the page) opens the same one. */
  lens?(): CameraPick | null;
}

/** Which camera to open. `exact`: `facing` is known for certain (it was asked for exactly). */
export interface CameraPick {
  facing: "user" | "environment";
  deviceId?: string;
  exact?: boolean;
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
  /** What was asked for. Prefers the back camera; a laptop simply gives its only webcam. */
  private pick: CameraPick;
  /** stop() was called: a camera that finishes opening after that (during a switch) is closed at once. */
  private halted = false;

  constructor(video: HTMLVideoElement, pick?: CameraPick | null) {
    this.video = video;
    this.pick = pick ?? { facing: "environment" };
  }

  get facing(): "user" | "environment" | "unknown" {
    const f = this.stream?.getVideoTracks()[0]?.getSettings().facingMode;
    if (f === "user" || f === "environment") return f;
    // Some Android browsers don't say; a camera opened with an exact facing is that facing.
    return this.stream && this.pick.exact ? this.pick.facing : "unknown";
  }

  async start() {
    this.halted = false;
    await this.openPicked();
  }

  private async openPicked() {
    if (!this.pick.deviceId) return this.open(this.pick);
    try {
      await this.open(this.pick);
    } catch (e) {
      // The remembered camera is gone (unplugged) or busy: any camera facing the same way.
      if (e instanceof CameraError && e.code === "denied") throw e;
      await this.open({ facing: this.pick.facing });
    }
  }

  private async open(pick: CameraPick) {
    // 720p so small print stays readable.
    const stream = await openCamera(pick.facing, { width: 1280, height: 720, frameRate: 15 }, { deviceId: pick.deviceId, exact: pick.exact });
    if (this.halted) {
      stream.getTracks().forEach((t) => t.stop());
      throw new CameraError("unknown", "The camera was stopped.");
    }
    this.stream = stream;
    this.pick = { ...pick, deviceId: stream.getVideoTracks()[0]?.getSettings().deviceId || pick.deviceId };
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (this.stream === stream) this.ended?.();
    });
    try {
      await attachStream(this.video, stream);
    } catch (e) {
      this.release();
      throw new CameraError("unknown", (e as Error).message);
    }
  }

  lens(): CameraPick | null {
    if (!this.stream) return null;
    const f = this.facing;
    return f === "unknown" ? { ...this.pick } : { ...this.pick, facing: f, exact: true };
  }

  stop() {
    this.halted = true;
    this.release();
  }

  private release() {
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
    const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    if (cameras.length < 2) return false;
    const before = this.lens() ?? this.pick;
    const facing = this.facing;
    const to: "user" | "environment" = (facing === "unknown" ? this.pick.facing : facing) === "user" ? "environment" : "user";
    // The next webcam in the list, for computers (their webcams don't say which way they face).
    const at = cameras.findIndex((d) => d.deviceId === before.deviceId);
    const next = cameras[(at + 1) % cameras.length];
    const tries: CameraPick[] = [{ facing: to, exact: true }];
    if (next?.deviceId && next.deviceId !== before.deviceId) tries.push({ facing: to, deviceId: next.deviceId });
    // A phone can't open its second camera while the first is still open.
    this.release();
    for (const pick of tries) {
      if (this.halted) break;
      try {
        await this.open(pick);
      } catch (e) {
        if (e instanceof CameraError && e.code === "denied") break;
        continue;
      }
      if (!before.deviceId || this.pick.deviceId !== before.deviceId) return true;
      this.release(); // the same camera again: not a switch
    }
    if (this.halted) return false;
    // No other camera would open: the one the user had comes back.
    this.pick = before;
    await this.openPicked();
    return false;
  }
}

/** Register other camera sources here. */
export function createCameraSource(kind: "webcam", video: HTMLVideoElement, pick?: CameraPick | null): CameraSource {
  switch (kind) {
    case "webcam":
      return new WebcamSource(video, pick);
  }
}
