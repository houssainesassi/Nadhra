// Assistant settings, kept per device in localStorage and validated on load.
import { isSpeechLang, type SpeechLang } from "./lang.ts";

export type FacingSetting = "auto" | "outward" | "user";

export interface VisionSettings {
  rate: number;
  /** Speech volume, 0.2..1. */
  volume: number;
  facing: FacingSetting;
  /** Describe the surroundings automatically. Warnings and answers stay on either way. */
  narration: boolean;
  /** Also send every sentence to the screen reader (off by default, as it would double the voice). */
  screenReaderEcho: boolean;
  /** The language the assistant speaks and listens for. The interface stays in English. */
  language: SpeechLang;
  /** Vibrate on events and warnings, where the device can. */
  vibration: boolean;
  /** Multiplies the page's text size, on top of the browser's own setting. */
  textScale: number;
  /** Who the emergency page calls or messages. Kept on this device only. */
  emergencyName: string;
  emergencyPhone: string;
}

export const DEFAULT_VISION_SETTINGS: VisionSettings = {
  rate: 0.9,
  volume: 1,
  facing: "auto",
  narration: true,
  screenReaderEcho: false,
  language: "tn",
  vibration: true,
  textScale: 1,
  emergencyName: "",
  emergencyPhone: "",
};
export const RATE_CHOICES = [0.7, 0.8, 0.9, 1, 1.15, 1.3] as const;
export const VOLUME_CHOICES = [0.4, 0.6, 0.8, 1] as const;
export const TEXT_SCALE_CHOICES = [1, 1.25, 1.5, 1.75] as const;

/** Digits, spaces and a leading +: anything else could change what a tel: link does. */
export const cleanPhone = (v: unknown) =>
  typeof v === "string" ? v.replace(/[^\d+\s]/g, "").replace(/(?!^)\+/g, "").replace(/\s+/g, " ").trim().slice(0, 20) : "";

export function sanitizeVisionSettings(raw: unknown): VisionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_VISION_SETTINGS;
  const num = (v: unknown, min: number, max: number, def: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def);
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  return {
    rate: num(r.rate, 0.5, 1.5, d.rate),
    volume: num(r.volume, 0.2, 1, d.volume),
    facing: r.facing === "outward" || r.facing === "user" || r.facing === "auto" ? r.facing : d.facing,
    narration: bool(r.narration, d.narration),
    screenReaderEcho: bool(r.screenReaderEcho, d.screenReaderEcho),
    language: isSpeechLang(r.language) ? r.language : d.language,
    vibration: bool(r.vibration, d.vibration),
    textScale: num(r.textScale, 1, 2, d.textScale),
    emergencyName: typeof r.emergencyName === "string" ? r.emergencyName.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : d.emergencyName,
    emergencyPhone: cleanPhone(r.emergencyPhone),
  };
}

export const SETTINGS_KEY = "assistant.settings";
// v2: the notice now also covers the live conversation (voice and camera to Google) and the cloud
// voice (sentences to Microsoft), so consent given to the older notice is asked for again.
export const CONSENT_KEY = "assistant.consent.v2";

export function loadVisionSettings(): VisionSettings {
  try {
    return sanitizeVisionSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"));
  } catch {
    return DEFAULT_VISION_SETTINGS;
  }
}

export function saveVisionSettings(s: VisionSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {}
}

export function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setConsent(granted: boolean) {
  try {
    if (granted) localStorage.setItem(CONSENT_KEY, "1");
    else localStorage.removeItem(CONSENT_KEY);
  } catch {}
}
