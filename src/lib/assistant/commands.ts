// Spoken commands that control the assistant, handled on the device instead of going to the model.
// Only short phrases match, so a real question that happens to contain one of these words still
// reaches the model. Pure logic.
import { normalizeArabic } from "./schema.ts";

export type VoiceCommand = "stop-speech" | "repeat" | "pause" | "resume" | "camera-off" | "camera-on" | "assistant-off" | "yes";

const clean = (text: string) => normalizeArabic(text).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

const COMMANDS: [VoiceCommand, string[]][] = [
  ["stop-speech", ["اسكت", "اسكت توة", "سكت", "بركة", "بركه", "يزي", "ايزي", "يزي برك", "وقف الكلام"]],
  ["repeat", ["عاود", "عاودلي", "عاود قول", "عاود قولي", "شنوة قلت", "شنوه قلت"]],
  ["pause", ["وقف التحليل", "وقف الوصف", "وقف شوية", "استني"]],
  ["resume", ["كمل", "كمل التحليل", "رجع التحليل", "كمل الوصف", "ابدا"]],
  ["camera-off", ["سكر الكاميرا", "طفي الكاميرا", "اطفي الكاميرا", "وقف الكاميرا"]],
  ["camera-on", ["شعل الكاميرا", "حل الكاميرا", "ولع الكاميرا"]],
  ["assistant-off", ["سكر الميكرو", "طفي الميكرو", "سكر المساعد", "طفي المساعد", "وقف المساعد"]],
  ["yes", ["موافق", "نعم موافق", "ايه موافق"]],
];

const LOOKUP = new Map(COMMANDS.flatMap(([cmd, phrases]) => phrases.map((p) => [clean(p), cmd] as const)));

export function parseCommand(text: string): VoiceCommand | null {
  return LOOKUP.get(clean(text)) ?? null;
}
