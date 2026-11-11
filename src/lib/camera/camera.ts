// Camera management (WebRTC getUserMedia) with human-readable errors.

export type CameraErrorCode = "unsupported" | "insecure" | "denied" | "not-found" | "busy" | "unknown";

export class CameraError extends Error {
  code: CameraErrorCode;
  constructor(code: CameraErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export async function openCamera(
  facingMode: "user" | "environment" = "user",
  size: { width: number; height: number; frameRate: number } = { width: 640, height: 480, frameRate: 30 },
): Promise<MediaStream> {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new CameraError("insecure", "Camera access needs HTTPS (or http://localhost).");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError("unsupported", "This browser does not support camera access.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode, width: { ideal: size.width }, height: { ideal: size.height }, frameRate: { ideal: size.frameRate, max: 30 } },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError")
      throw new CameraError("denied", "Camera permission was denied. Allow camera access in the browser settings and try again.");
    if (name === "NotFoundError" || name === "OverconstrainedError")
      throw new CameraError("not-found", "No camera was found on this device.");
    if (name === "NotReadableError" || name === "AbortError")
      throw new CameraError("busy", "The camera is being used by another application.");
    throw new CameraError("unknown", `Could not start the camera (${name ?? String(e)}).`);
  }
  return stream;
}

export async function attachStream(video: HTMLVideoElement, stream: MediaStream) {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  if (!video.videoWidth) {
    // Some phones fire loadeddata before the listener is in place: don't wait for it forever.
    // Frames are only captured once the video has a size (WebcamSource.ready), so this is safe.
    await new Promise<void>((r) => {
      const done = () => r();
      video.addEventListener("loadeddata", done, { once: true });
      video.addEventListener("resize", done, { once: true });
      setTimeout(done, 3_000);
    });
  }
}

export function stopCamera(video: HTMLVideoElement | null, stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
}
