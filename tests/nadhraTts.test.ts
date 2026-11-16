// Nadhra AI, the voice: with Nadhra selected, no sentence goes to the assistant's voice (Sulafat,
// Google Gemini TTS through /api/tts), and no other voice (browser or device) is used instead:
// speaking fails and the screen reader takes over. Gemini: Sulafat, unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";

class FakeAudioContext {
  state: "suspended" | "running" = "suspended";
  destination = {};
  async resume() { this.state = "running"; }
  createBufferSource() { return { connect() {}, start() {}, stop() {}, onended: null, buffer: null }; }
  createBuffer() { return "silence"; }
  async decodeAudioData(buf: ArrayBuffer) { return new TextDecoder().decode(buf); }
  async close() {}
}
const browserSpoken: string[] = [];
const g = globalThis as Record<string, unknown>;
g.window = g;
g.AudioContext = FakeAudioContext;
// A browser voice exists: it must never be used.
g.speechSynthesis = { speaking: false, getVoices: () => [{ name: "Hoda", lang: "ar-EG", localService: true }], addEventListener() {}, cancel() {}, speak: (u: { text: string }) => browserSpoken.push(u.text) };
g.addEventListener = () => {};
g.removeEventListener = () => {};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

const posts: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (!init?.method) return new Response(JSON.stringify({ configured: true, provider: "gemini", voice: "Sulafat" }));
  posts.push(String(url));
  return new Response("audio");
}) as typeof fetch;

const { SulafatTts } = await import("../src/lib/speech/tts.ts");
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("SulafatTts localOnly: nothing is sent, no other voice speaks, a clear error is given", async () => {
  posts.length = 0;
  browserSpoken.length = 0;
  const tts = new SulafatTts();
  await tts.ready();
  assert.equal(tts.voiceInfo()?.name, "Google Gemini Sulafat", "Gemini (default): Sulafat");
  tts.setLocalOnly(true);
  assert.equal(tts.voiceInfo(), null);
  assert.equal(tts.available(), false);
  const log: string[] = [];
  tts.speak("عسلامة.", { rate: 1, onStart: () => log.push("start"), onEnd: () => log.push("end"), onError: (e) => log.push(`error:${e}`) });
  await tick(30);
  assert.deepEqual(posts, [], "no sentence sent to /api/tts");
  assert.deepEqual(browserSpoken, [], "no browser or device voice");
  assert.equal(log.length, 1);
  assert.match(log[0], /^error:.*Sulafat/);

  // Back to Gemini: Sulafat again.
  tts.setLocalOnly(false);
  tts.speak("مرحبا.", { rate: 1 });
  await tick(30);
  assert.deepEqual(posts, ["/api/tts"]);
  assert.deepEqual(browserSpoken, []);
  tts.dispose();
});
