// Live audio cleanup: a microphone that finishes opening after the conversation ended (a permission
// prompt can take seconds) is stopped at once, and close() releases everything. Fake browser APIs.
import test from "node:test";
import assert from "node:assert/strict";

class FakeTrack { kind = "audio"; stopped = false; stop() { this.stopped = true; } }
class FakeNode { connected = 0; disconnected = 0; connect() { this.connected++; } disconnect() { this.disconnected++; } port = { onmessage: null as unknown }; gain = { value: 1, setTargetAtTime() {} }; }
class FakeCtx {
  static last: FakeCtx | null = null;
  sampleRate = 48_000; currentTime = 0; destination = new FakeNode(); closed = false;
  audioWorklet = { addModule: async () => {} };
  constructor() { FakeCtx.last = this; }
  resume() { return Promise.resolve(); }
  close() { this.closed = true; return Promise.resolve(); }
  createGain() { return new FakeNode(); }
  createMediaStreamSource() { return new FakeNode(); }
  createScriptProcessor() { return new FakeNode(); }
}

function install(gum: () => Promise<{ getTracks(): FakeTrack[] }>) {
  Object.defineProperty(globalThis, "window", { value: { AudioContext: FakeCtx, isSecureContext: true }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: { getUserMedia: gum } }, configurable: true });
  Object.defineProperty(globalThis, "AudioWorkletNode", { value: class extends FakeNode {}, configurable: true });
}

const { LiveAudio } = await import("../src/lib/live/audioIO.ts");

test("live audio: ended while the microphone was still opening — its track is stopped as soon as it arrives", async () => {
  const track = new FakeTrack();
  let open!: () => void;
  install(() => new Promise((r) => (open = () => r({ getTracks: () => [track] }))));
  const a = new LiveAudio();
  const starting = a.startMic({ chunk() {} });
  await new Promise((r) => setTimeout(r, 5));
  a.close(); // End pressed during the permission prompt
  open();
  await assert.rejects(starting);
  assert.equal(track.stopped, true, "the microphone doesn't stay on");
  assert.equal(FakeCtx.last?.closed, true);
});

test("live audio: close() after the microphone is open stops its track and closes the audio context", async () => {
  const track = new FakeTrack();
  install(async () => ({ getTracks: () => [track] }));
  const a = new LiveAudio();
  await a.startMic({ chunk() {} });
  assert.equal(track.stopped, false);
  a.close();
  assert.equal(track.stopped, true);
  assert.equal(FakeCtx.last?.closed, true);
});

test("live audio: ended while the audio worklet was loading — nothing is connected, the track is stopped", async () => {
  const track = new FakeTrack();
  install(async () => ({ getTracks: () => [track] }));
  const a = new LiveAudio();
  let loaded!: () => void;
  FakeCtx.last!.audioWorklet.addModule = () => new Promise<void>((r) => (loaded = r));
  const starting = a.startMic({ chunk() {} });
  await new Promise((r) => setTimeout(r, 5));
  a.close();
  loaded();
  await starting;
  assert.equal(track.stopped, true);
});
