// Assistant settings, kept per device in localStorage and validated on load.
import { isSpeechLang, type SpeechLang } from "./lang.ts";

export type AiProvider = "gemini" | "nadhra";

export type FacingSetting = "auto" | "outward" | "user";

export interface VisionSettings {
  rate: number;
  /** Speech volume, 0.2..1. */
  volume: number;
  facing: FacingSetting;
  /**
   * Send a picture to the cloud analysis every few seconds, for descriptions and the warnings only it
   * can give (stairs, drops). Off by default: then no picture leaves the phone unless the user asks
   * (a question, a reading, a live conversation), so no paper in view is ever sent by itself. The
   * on-device warnings run either way.
   */
  autoDescribe: boolean;
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
  /**
   * The AI the user chose. Absent: Gemini AI, the default and today's behaviour. "nadhra": Nadhra AI,
   * the project's own engines on this device (experimental). With Nadhra AI nothing is sent from this
   * page, and a feature it can't do yet is refused out loud, never handed to Gemini.
   */
  provider?: AiProvider;
}

export const DEFAULT_VISION_SETTINGS: VisionSettings = {
  rate: 1,
  volume: 1,
  facing: "auto",
  autoDescribe: false,
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
    // A setting saved before this one existed («narration») is not carried over: off until chosen.
    autoDescribe: bool(r.autoDescribe, d.autoDescribe),
    screenReaderEcho: bool(r.screenReaderEcho, d.screenReaderEcho),
    language: isSpeechLang(r.language) ? r.language : d.language,
    vibration: bool(r.vibration, d.vibration),
    textScale: num(r.textScale, 1, 2, d.textScale),
    emergencyName: typeof r.emergencyName === "string" ? r.emergencyName.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) : d.emergencyName,
    emergencyPhone: cleanPhone(r.emergencyPhone),
    // Only an explicit choice of Nadhra is kept; anything else is Gemini (the field stays absent).
    ...(r.provider === "nadhra" ? { provider: "nadhra" as const } : {}),
  };
}

/** The AI in use: Gemini unless Nadhra was chosen. */
export const providerOf = (s: Pick<VisionSettings, "provider">): AiProvider => (s.provider === "nadhra" ? "nadhra" : "gemini");

export const SETTINGS_KEY = "assistant.settings";
// v2: the notice now also covers the live conversation (voice and camera to Google) and the cloud
// voice (sentences to Microsoft), so consent given to the older notice is asked for again.
// v3: the notice names Google Gemini and OpenRouter, and says Google's free service may keep the images.
export const CONSENT_KEY = "assistant.consent.v3";
/** The spoken notice about documents (two pictures to Google, no real prescriptions) was accepted. */
export const READ_CONSENT_KEY = "assistant.readConsent.v1";
/** The spoken notice about the live conversation (voice and a picture a second to Google) was accepted. */
export const LIVE_CONSENT_KEY = "assistant.liveConsent.v1";

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

export function hasReadConsent(): boolean {
  try {
    return localStorage.getItem(READ_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setReadConsent(granted: boolean) {
  try {
    if (granted) localStorage.setItem(READ_CONSENT_KEY, "1");
    else localStorage.removeItem(READ_CONSENT_KEY);
  } catch {}
}

export function hasLiveConsent(): boolean {
  try {
    return localStorage.getItem(LIVE_CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLiveConsent(granted: boolean) {
  try {
    if (granted) localStorage.setItem(LIVE_CONSENT_KEY, "1");
    else localStorage.removeItem(LIVE_CONSENT_KEY);
  } catch {}
}
