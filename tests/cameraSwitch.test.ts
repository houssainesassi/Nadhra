// Front/back camera switching in WebcamSource, with a fake getUserMedia: a phone (cameras that say
// which way they face), a computer with two webcams (they don't), a switch that fails (the previous
// camera comes back), and Stop pressed during a switch (no camera left on). No real camera.
import test from "node:test";
import assert from "node:assert/strict";

type Cam = { deviceId: string; facing?: "user" | "environment"; broken?: boolean };
class Track {
  stopped = false;
  readonly cam: Cam;
  constructor(cam: Cam) { this.cam = cam; }
  stop() { this.stopped = true; }
  getSettings() { return { deviceId: this.cam.deviceId, ...(this.cam.facing ? { facingMode: this.cam.facing } : {}) }; }
  addEventListener() {}
  get readyState() { return this.stopped ? "ended" : "live"; }
}
let cams: Cam[] = [];
let opened: Track[] = [];
let gate: Promise<void> | null = null;

function overconstrained() { return Object.assign(new Error("over"), { name: "OverconstrainedError" }); }
async function getUserMedia(c: { video: { deviceId?: { exact: string }; facingMode?: string | { exact: string } } }) {
  if (gate) await gate;
  const v = c.video;
  let cam: Cam | undefined;
  if (v.deviceId) cam = cams.find((x) => x.deviceId === v.deviceId!.exact);
  else if (typeof v.facingMode === "object") cam = cams.find((x) => x.facing === (v.facingMode as { exact: string }).exact);
  else cam = cams.find((x) => x.facing === v.facingMode) ?? cams[0];
  if (!cam) throw overconstrained();
  if (cam.broken) throw Object.assign(new Error("busy"), { name: "NotReadableError" });
  const t = new Track(cam);
  opened.push(t);
  return { getTracks: () => [t], getVideoTracks: () => [t] };
}
Object.defineProperty(globalThis, "window", { value: { isSecureContext: true }, configurable: true });
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia, enumerateDevices: async () => cams.map((c) => ({ kind: "videoinput", deviceId: c.deviceId })) } },
});
const video = () => ({ srcObject: null as unknown, muted: false, playsInline: false, videoWidth: 1280, readyState: 4, play: async () => {}, addEventListener() {} }) as unknown as HTMLVideoElement;

const { WebcamSource } = await import("../src/lib/assistant/cameraSource.ts");
const live = () => opened.filter((t) => !t.stopped).map((t) => t.cam.deviceId);

test("phone: back camera first, switch → front (facing exact), switch → back; one camera open at a time", async () => {
  cams = [{ deviceId: "front", facing: "user" }, { deviceId: "back", facing: "environment" }];
  opened = [];
  const s = new WebcamSource(video());
  await s.start();
  assert.deepEqual(live(), ["back"]);
  assert.equal(s.facing, "environment");
  assert.equal(await s.switchDevice(), true);
  assert.deepEqual(live(), ["front"]);
  assert.equal(s.facing, "user");
  assert.deepEqual(s.lens(), { facing: "user", deviceId: "front", exact: true });
  assert.equal(await s.switchDevice(), true);
  assert.deepEqual(live(), ["back"]);
  s.stop();
  assert.deepEqual(live(), []);
});

test("a remembered camera is reopened at the next start", async () => {
  cams = [{ deviceId: "front", facing: "user" }, { deviceId: "back", facing: "environment" }];
  opened = [];
  const s = new WebcamSource(video(), { facing: "user", deviceId: "front", exact: true });
  await s.start();
  assert.deepEqual(live(), ["front"]);
  assert.equal(s.facing, "user");
});

test("computer with two webcams that don't say their facing: switch goes to the other webcam by device", async () => {
  cams = [{ deviceId: "laptop" }, { deviceId: "usb" }];
  opened = [];
  const s = new WebcamSource(video());
  await s.start();
  assert.deepEqual(live(), ["laptop"]);
  assert.equal(await s.switchDevice(), true);
  assert.deepEqual(live(), ["usb"]);
  assert.equal(await s.switchDevice(), true);
  assert.deepEqual(live(), ["laptop"]);
});

test("the other camera won't open → false, and the previous camera is on again", async () => {
  cams = [{ deviceId: "front", facing: "user", broken: true }, { deviceId: "back", facing: "environment" }];
  opened = [];
  const s = new WebcamSource(video());
  await s.start();
  assert.equal(await s.switchDevice(), false);
  assert.deepEqual(live(), ["back"]);
  assert.equal(s.isLive(), true);
});

test("only one camera → false without touching it", async () => {
  cams = [{ deviceId: "only" }];
  opened = [];
  const s = new WebcamSource(video());
  await s.start();
  assert.equal(await s.switchDevice(), false);
  assert.equal(opened.length, 1);
  assert.deepEqual(live(), ["only"]);
});

test("Stop pressed while the other camera is opening: it is closed as soon as it arrives", async () => {
  cams = [{ deviceId: "front", facing: "user" }, { deviceId: "back", facing: "environment" }];
  opened = [];
  const s = new WebcamSource(video());
  await s.start();
  let release!: () => void;
  gate = new Promise((r) => (release = r));
  const switching = s.switchDevice();
  await new Promise((r) => setTimeout(r, 5));
  s.stop();
  release();
  gate = null;
  assert.equal(await switching, false);
  assert.deepEqual(live(), [], "no camera left on");
  assert.equal(s.isLive(), false);
});
