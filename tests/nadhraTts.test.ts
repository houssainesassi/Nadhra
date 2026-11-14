// Nadhra AI step N1, the voice: with Nadhra selected, no sentence goes to the cloud voice (Microsoft
// Edge, through /api/tts) or to a browser voice that is a network service. Only voices installed on
// the device speak; with none, speaking fails (the screen reader takes over). Gemini: unchanged.
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
class FakeUtterance {
  text: string;
  lang = "";
  voice: { name: string } | null = null;
  rate = 1;
  volume = 1;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  constructor(t: string) { this.text = t; }
}
type Voice = { name: string; lang: string; localService: boolean; default?: boolean };
let voices: Voice[] = [];
const spoken: { text: string; voice: string | null }[] = [];
const g = globalThis as Record<string, unknown>;
g.window = g;
g.AudioContext = FakeAudioContext;
g.SpeechSynthesisUtterance = FakeUtterance;
g.speechSynthesis = {
  speaking: false,
  getVoices: () => voices,
  addEventListener() {},
  cancel() {},
  speak(u: FakeUtterance) {
    spoken.push({ text: u.text, voice: u.voice?.name ?? null });
    setTimeout(() => (u.onstart?.(), u.onend?.()), 0);
  },
};
g.addEventListener = () => {};
g.removeEventListener = () => {};
Object.defineProperty(globalThis, "navigator", { value: { onLine: true }, configurable: true });

const posts: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (!init?.method) return new Response(JSON.stringify({ configured: true, voice: "ar-TN-ReemNeural", languageCode: "ar-TN" }));
  posts.push(String(url));
  return new Response("audio");
}) as typeof fetch;

const { HybridTts, pickVoice } = await import("../src/lib/speech/tts.ts");
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const v = (name: string, lang: string, localService: boolean): Voice => ({ name, lang, localService });
const asVoices = (list: Voice[]) => list as unknown as SpeechSynthesisVoice[];

test("pickVoice localOnly: network voices are never picked, even when they are the only ones", () => {
  const remote = v("Google العربية", "ar-SA", false);
  const local = v("Hoda", "ar-EG", true);
  assert.equal(pickVoice(asVoices([remote, local]), "tn", { localOnly: true })?.name, "Hoda");
  assert.equal(pickVoice(asVoices([remote]), "tn", { localOnly: true }), null);
  // Without localOnly: unchanged (a network voice may be picked).
  assert.equal(pickVoice(asVoices([remote]), "tn")?.name, "Google العربية");
});

test("HybridTts localOnly: the cloud voice is never asked, the installed voice speaks", async () => {
  voices = [v("Google العربية", "ar-SA", false), v("Hoda", "ar-EG", true)];
  posts.length = 0;
  spoken.length = 0;
  const tts = new HybridTts();
  await tick();
  assert.equal(tts.voiceInfo()?.source, "cloud", "Gemini (default): the cloud voice, as today");
  tts.setLocalOnly(true);
  assert.deepEqual(tts.voiceInfo(), { name: "Hoda", lang: "ar-EG", exactDialect: false, source: "browser" });
  const log: string[] = [];
  tts.speak("عسلامة.", { rate: 1, onStart: () => log.push("start"), onEnd: () => log.push("end"), onError: (e) => log.push(`error:${e}`) });
  await tick(30);
  assert.deepEqual(posts, [], "no sentence sent to /api/tts");
  assert.deepEqual(spoken, [{ text: "عسلامة.", voice: "Hoda" }]);
  assert.deepEqual(log, ["start", "end"]);

  // Back to Gemini: the cloud voice again.
  tts.setLocalOnly(false);
  tts.speak("مرحبا.", { rate: 1 });
  await tick(30);
  assert.deepEqual(posts, ["/api/tts"]);
  tts.dispose();
});

test("HybridTts localOnly with no installed voice: fails (screen reader takes over), nothing sent or spoken", async () => {
  voices = [v("Google العربية", "ar-SA", false)];
  posts.length = 0;
  spoken.length = 0;
  const tts = new HybridTts();
  await tick();
  tts.setLocalOnly(true);
  assert.equal(tts.voiceInfo(), null);
  const errors: string[] = [];
  tts.speak("عسلامة.", { rate: 1, onError: (e) => errors.push(e) });
  await tick(30);
  assert.equal(errors.length, 1);
  assert.deepEqual(spoken, [], "the browser's own choice (possibly a network voice) is not used");
  assert.deepEqual(posts, []);
  tts.dispose();
});
