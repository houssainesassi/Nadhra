// Assistant settings, kept per device in localStorage and validated on load.
export type FacingSetting = "auto" | "outward" | "user";

export interface VisionSettings {
  rate: number;
  facing: FacingSetting;
  /** Describe the surroundings automatically. Warnings and answers stay on either way. */
  narration: boolean;
  /** Also send every sentence to the screen reader (off by default, as it would double the voice). */
  screenReaderEcho: boolean;
}

export const DEFAULT_VISION_SETTINGS: VisionSettings = { rate: 0.9, facing: "auto", narration: true, screenReaderEcho: false };
export const RATE_CHOICES = [0.7, 0.8, 0.9, 1, 1.15, 1.3] as const;

export function sanitizeVisionSettings(raw: unknown): VisionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_VISION_SETTINGS;
  return {
    rate: typeof r.rate === "number" && Number.isFinite(r.rate) ? Math.min(1.5, Math.max(0.5, r.rate)) : d.rate,
    facing: r.facing === "outward" || r.facing === "user" || r.facing === "auto" ? r.facing : d.facing,
    narration: typeof r.narration === "boolean" ? r.narration : d.narration,
    screenReaderEcho: typeof r.screenReaderEcho === "boolean" ? r.screenReaderEcho : d.screenReaderEcho,
  };
}

const KEY = "assistant.settings";
const CONSENT_KEY = "assistant.consent.v1";

export function loadVisionSettings(): VisionSettings {
  try {
    return sanitizeVisionSettings(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return DEFAULT_VISION_SETTINGS;
  }
}

export function saveVisionSettings(s: VisionSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
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
