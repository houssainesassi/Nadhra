// The answer's language follows the question's, the voice follows the answer, and older iPhones
// (no AbortSignal.any) can still ask questions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { questionLang } from "../src/lib/assistant/lang.ts";
import { SpeechQueue } from "../src/lib/assistant/speechQueue.ts";
import type { SpeakOptions, TtsEngine } from "../src/lib/speech/tts.ts";
import type { SpeechLang } from "../src/lib/assistant/lang.ts";

test("question language: Derja, standard Arabic, French, English and Arabizi are told apart", () => {
  assert.equal(questionLang("شنوّة اللي قدّامي؟", "tn"), "tn");
  assert.equal(questionLang("شنوّة اللي قدّامي؟", "ar"), "tn", "Derja asked with MSA chosen gets Derja");
  assert.equal(questionLang("ماذا يوجد أمامي؟", "tn"), "ar");
  assert.equal(questionLang("ما هذا؟", "tn"), "tn", "one standard word isn't enough to leave Derja");
  assert.equal(questionLang("ماذا يوجد أمامي؟", "ar"), "ar");
  assert.equal(questionLang("Qu'est-ce qu'il y a devant moi ?", "tn"), "fr");
  assert.equal(questionLang("What is in front of me?", "tn"), "en");
  assert.equal(questionLang("chnowa hedha?", "fr"), "tn");
  assert.equal(questionLang("9odemi chnia?", "en"), "tn");
  assert.equal(questionLang("شنوة هذا le truc?", "fr"), "tn", "Derja with a French word is Derja");
});

test("question language: unclear input keeps the chosen language", () => {
  assert.equal(questionLang("OK", "tn"), "tn");
  assert.equal(questionLang("500", "fr"), "fr");
  assert.equal(questionLang("", "en"), "en");
  assert.equal(questionLang("باب", "fr"), "ar", "Arabic script without Derja words, with French chosen");
});

class LangEngine implements TtsEngine {
  readonly name = "fake";
  langs: SpeechLang[] = [];
  said: { text: string; lang: SpeechLang | undefined }[] = [];
  private current: SpeechLang | undefined;
  private live: SpeakOptions | null = null;
  available() { return true; }
  voiceInfo() { return null; }
  setLanguage(lang: SpeechLang) { this.current = lang; this.langs.push(lang); }
  speak(text: string, opts: SpeakOptions) { this.said.push({ text, lang: this.current }); this.live = opts; }
  stop() { this.live = null; }
  end() { const l = this.live; this.live = null; l?.onEnd?.(); }
}

test("speech: an answer in another language is spoken with that voice, then the usual voice returns", () => {
  const engine = new LangEngine();
  const q = new SpeechQueue(engine, { rate: () => 1, lang: () => "tn" });
  q.say("Il y a une porte devant vous.", "answer", "fr");
  q.say("رد بالك، فمّا درج قدّامك.", "status");
  engine.end();
  engine.end();
  assert.deepEqual(engine.said, [{ text: "Il y a une porte devant vous.", lang: "fr" }, { text: "رد بالك، فمّا درج قدّامك.", lang: "tn" }]);
  q.say("جملة أخرى.", "status");
  assert.deepEqual(engine.langs, ["fr", "tn"], "the voice is only changed when the language changes");
});

test("older iPhones without AbortSignal.any can still ask (fallback signal)", async () => {
  const real = AbortSignal.any;
  // @ts-expect-error simulating Safari before 17.4
  delete AbortSignal.any;
  try {
    const { anySignal } = await import("../src/lib/assistant/client.ts");
    const a = new AbortController();
    const s = anySignal([a.signal, new AbortController().signal]);
    assert.equal(s.aborted, false);
    a.abort();
    assert.equal(s.aborted, true);
  } finally {
    AbortSignal.any = real;
  }
});
