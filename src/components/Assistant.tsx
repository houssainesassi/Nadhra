"use client";
// The whole app is one screen with two states. At rest: one large Open camera button. While
// assisting: the camera preview, what the assistant is saying, a microphone indicator and one Stop
// button. Everything else is done by voice (and by keyboard), and every state change is spoken, so
// nothing depends on seeing the screen. Settings, Privacy & safety and the Emergency page are
// panels over the screen; the Emergency page opens by voice («نجدة», «عيّط»).
//
// The main screen's words follow the language selector. The panels stay in English.
import { Fragment, useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/useStore";
import { SmartVisionController, type SheetName, type VisionState } from "@/lib/assistant/controller";
import { commandExamples, type VoiceCommand } from "@/lib/assistant/commands";
import { LANGS, SPEECH_LANGS, type SpeechLang } from "@/lib/assistant/lang";
import { cameraErrorText } from "@/lib/assistant/phrases";
import { providerOf, RATE_CHOICES, TEXT_SCALE_CHOICES, VOLUME_CHOICES, type AiProvider, type FacingSetting } from "@/lib/assistant/settings";
import { UI_TEXT, type UiText } from "@/lib/assistant/uiText";
import { announcerRegions, EMPTY_REGIONS, type Announcement, type Regions } from "@/lib/assistant/announcer";
import { CameraIcon, CameraOffIcon, ChevronIcon, CloudIcon, DeviceIcon, CloseIcon, GlobeIcon, LogoMark, MessageIcon, MicIcon, MicOffIcon, PhoneIcon, SettingsIcon, ShieldIcon } from "./icons";

const SHORTCUTS = [
  ["C", "Open the camera, or stop assistance"],
  ["L", "Start or end a live conversation"],
  ["D", "Describe my surroundings"],
  ["T", "Read text"],
  ["I", "Identify an object"],
  ["V", "Turn voice commands on or off"],
  ["Q", "Ask by voice"],
  ["P", "Pause or resume analysis"],
  ["R", "Repeat the last sentence"],
  ["H", "Help: hear what you can say"],
  ["Esc", "Stop talking"],
] as const;

const COMMAND_LIST: [VoiceCommand, string][] = [
  ["front", "What's in front of me"],
  ["describe", "Describe my surroundings"],
  ["read", "Read text"],
  ["identify", "Identify an object"],
  ["repeat", "Repeat"],
  ["stop-speech", "Stop talking"],
  ["back", "Go back or cancel"],
  ["help", "Help"],
  ["pause", "Pause analysis"],
  ["resume", "Resume"],
  ["camera-on", "Start the camera"],
  ["camera-off", "Stop the camera"],
  ["louder", "Louder (also: quieter)"],
  ["slower", "Slower (also: faster)"],
  ["emergency", "Emergency page (then «عيّط» / “call” selects the call button)"],
  ["assistant-off", "Turn off voice commands"],
];

/** Tunisia's emergency numbers. */
const EMERGENCY_NUMBERS = [
  { number: "190", label: "SAMU (ambulance)" },
  { number: "197", label: "Police" },
  { number: "198", label: "Civil protection (fire and rescue)" },
];

/** A warning stays readable this long, even if the voice fails or the next sentence follows at once. */
const WARNING_HOLD_MS = 5_000;

const LIVE_LABEL: Record<VisionState["live"]["status"], string> = {
  off: "Off",
  idle: "Off",
  connecting: "Connecting…",
  open: "Listening",
  reconnecting: "Reconnecting…",
  closed: "Off",
  failed: "Not available",
};

function liveLabel(s: VisionState): string {
  if (s.live.status !== "open") return LIVE_LABEL[s.live.status];
  if (s.live.playing) return "Speaking";
  if (s.live.userTalking) return "Hearing you";
  return "Listening";
}

const isLiveOn = (s: VisionState) => s.live.status !== "off" && s.live.status !== "closed" && s.live.status !== "failed";

/**
 * The live regions for the current announcement. Each new announcement takes the next turn, so it is
 * written into the region the previous one left empty: always a fresh insertion, even for the same
 * sentence again, and never in two regions at once.
 */
function useAnnouncer(a: Announcement, echo: boolean): Regions {
  const turn = useRef(0);
  const [regions, setRegions] = useState<Regions>(EMPTY_REGIONS);
  useEffect(() => {
    if (!echo || !a.text) return setRegions(EMPTY_REGIONS);
    turn.current++;
    setRegions(announcerRegions({ ...a, id: turn.current }, echo));
  }, [a.id, echo]); // a new announcement is a new id
  return regions;
}

/** The one-line state shown on the camera, and its colour. */
function assistanceStatus(s: VisionState, ui: UiText, urgent: boolean): { text: string; tone: "urgent" | "active" | "quiet" } {
  if (urgent) return { text: ui.warning, tone: "urgent" };
  if (s.camera === "starting") return { text: ui.starting, tone: "quiet" };
  if (s.camera === "on" && s.analysis === "paused") return { text: ui.paused, tone: "quiet" };
  if (s.camera === "on" && s.analysis === "local" && !s.speaking && !s.answer.live) return { text: ui.nadhra, tone: "quiet" };
  if (s.camera === "on" && s.analysis === "manual" && !s.speaking && !s.live.playing && !s.answer.live && s.mic !== "processing") return { text: ui.manual, tone: "quiet" };
  if (s.speaking || s.live.playing) return { text: ui.speaking, tone: "active" };
  if (s.analysis === "analyzing" || s.mic === "processing" || s.answer.live) return { text: ui.looking, tone: "active" };
  return { text: ui.active, tone: "active" };
}

function micStatus(s: VisionState, ui: UiText): { text: string; on: boolean } {
  if (isLiveOn(s)) return { text: ui.live, on: true };
  if (s.mic === "denied") return { text: ui.mic.denied, on: false };
  if (s.mic === "unavailable") return { text: ui.mic.unavailable, on: false };
  if (s.mic === "listening") return { text: ui.mic.listening, on: true };
  if (s.mic === "processing") return { text: ui.mic.processing, on: true };
  if (s.assistantOn) return { text: ui.mic.on, on: true };
  return { text: ui.mic.off, on: false };
}

function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark"), []);
  const choose = (next: "dark" | "light") => {
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {}
  };
  return [theme, choose] as const;
}

function useHeldWarning(text: string, urgent: boolean) {
  const [held, setHeld] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!urgent || !text) return;
    setHeld(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setHeld(null), WARNING_HOLD_MS);
  }, [text, urgent]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return held;
}

const telHref = (phone: string) => `tel:${phone.replace(/\s+/g, "")}`;
const smsHref = (phone: string, body: string) => `sms:${phone.replace(/\s+/g, "")}?body=${encodeURIComponent(body)}`;

export default function Assistant() {
  const [controller] = useState(() => new SmartVisionController());
  const s = useStore(controller.store);
  const videoRef = useRef<HTMLVideoElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const stopRef = useRef<HTMLButtonElement>(null);
  const consentRef = useRef<HTMLDialogElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const privacyRef = useRef<HTMLDialogElement>(null);
  const emergencyRef = useRef<HTMLDialogElement>(null);
  const callRef = useRef<HTMLAnchorElement>(null);
  const [theme, setTheme] = useTheme();
  const heldWarning = useHeldWarning(s.lastSpoken, s.lastUrgent);

  const liveOn = isLiveOn(s);
  const cameraOn = s.camera === "on";
  // Assisting while the camera runs or starts, or while the microphone is still being listened to
  // (after «سكّر الكاميرا», say): the Stop button must stay in reach until everything is off.
  const active = cameraOn || s.camera === "starting" || s.assistantOn || liveOn;

  useEffect(() => {
    if (videoRef.current) controller.attach(videoRef.current);
    openRef.current?.focus({ preventScroll: true });
    return () => controller.detach();
  }, [controller]);

  useEffect(() => {
    const dialog = consentRef.current;
    if (!dialog) return;
    if (s.needsConsent && !dialog.open) {
      dialog.showModal();
      acceptRef.current?.focus();
    } else if (!s.needsConsent && dialog.open) {
      dialog.close();
    }
  }, [s.needsConsent]);

  // The controller owns which panel is open, so voice commands can open and close them too.
  useEffect(() => {
    const sheets: [SheetName, HTMLDialogElement | null][] = [["settings", settingsRef.current], ["privacy", privacyRef.current], ["emergency", emergencyRef.current]];
    for (const [name, dialog] of sheets) if (dialog?.open && name !== s.sheet) dialog.close();
    for (const [name, dialog] of sheets) {
      if (!dialog || dialog.open || name !== s.sheet) continue;
      dialog.showModal();
      // In an emergency, focus starts on the action, not on Close: one double-tap calls.
      dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
  }, [s.sheet]);

  useEffect(() => {
    if (s.focus.target === "call") callRef.current?.focus();
  }, [s.focus]);

  // The pressed button disappears when the screen changes: focus moves to the one that replaced it.
  // After the dialog effects above, so a consent notice closing in the same render doesn't block it.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current === active) return;
    wasActive.current = active;
    if (document.querySelector("dialog[open]")) return;
    (active ? stopRef : openRef).current?.focus({ preventScroll: true });
  }, [active]);

  useEffect(() => {
    document.documentElement.style.setProperty("--text-scale", String(s.settings.textScale));
  }, [s.settings.textScale]);

  // Physical key positions, so these work with an Arabic or French keyboard layout too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (document.querySelector("dialog[open]")) return; // Esc and typing belong to the open dialog
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable]")) return;
      const st = controller.state;
      const actions: Record<string, () => void> = {
        Escape: () => controller.stopSpeech(),
        KeyC: () => (st.camera === "on" || st.camera === "starting" || st.assistantOn || isLiveOn(st) ? controller.stopAssistance() : void controller.startAssistance()),
        KeyD: () => void controller.runTask("describe"),
        KeyT: () => void controller.runTask("read"),
        KeyI: () => void controller.runTask("identify"),
        KeyV: () => controller.toggleAssistant(),
        KeyL: () => controller.toggleLive(),
        KeyQ: () => void controller.askByVoice(),
        KeyP: () => (controller.isPaused ? controller.resume() : controller.pause()),
        KeyR: () => controller.repeat(),
        KeyH: () => controller.help(),
      };
      const action = actions[e.code];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [controller]);

  const language = s.settings.language;
  const provider = providerOf(s.settings);
  const lang = LANGS[language];
  const ui = UI_TEXT[language];
  const rtl = lang.dir === "rtl";
  const echo = s.settings.screenReaderEcho || s.ttsFailed;
  const regions = useAnnouncer(s.announce, echo);
  const urgentNow = !!heldWarning;
  const status = assistanceStatus(s, ui, urgentNow);
  const mic = micStatus(s, ui);
  const providers = s.status?.providers.map((p) => p.label).join(", ") || "an external AI service";
  const examples = commandExamples(language);
  const contact = s.settings.emergencyPhone;
  const contactName = s.settings.emergencyName || "my emergency contact";

  // What the assistant is saying: a held warning first, then a live or streaming answer.
  const caption = heldWarning ?? (liveOn && s.live.ai.trim() ? s.live.ai.trim() : s.answer.live && s.answer.text ? s.answer.text : s.lastSpoken);
  const heard = liveOn ? s.live.user.trim() : s.lastHeard;
  const notices = cameraOn
    ? [
        !s.online && ui.offline,
        s.detector === "failed" && ui.detectorFailed,
        s.online && (s.analysis === "unavailable" || (s.status && !s.status.available)) && ui.serviceDown,
      ].filter((n): n is string => !!n)
    : [];

  return (
    <>
      <div className={`app ${rtl ? "arabic" : ""}`} lang={lang.bcp47} dir={lang.dir} data-active={active}>
        {/* Screen-reader channel. Silent unless asked for, or the page's own voice has failed. */}
        {/* Two regions per kind, used in turn, so the same sentence twice is still read twice (announcer.ts). */}
        <div aria-live="polite" className="sr-only" data-testid="announce-polite-0">{regions.polite[0]}</div>
        <div aria-live="polite" className="sr-only" data-testid="announce-polite-1">{regions.polite[1]}</div>
        <div role="alert" className="sr-only" data-testid="announce-alert-0">{regions.alert[0]}</div>
        <div role="alert" className="sr-only" data-testid="announce-alert-1">{regions.alert[1]}</div>

        <header className="topbar">
          <div className="brand">
            <LogoMark />
            <h1 lang="en" dir="ltr">Nadhra</h1>
            <span lang="ar" dir="rtl" className="brand-ar arabic">نظرة</span>
          </div>
          <nav aria-label={`${ui.language}, ${ui.privacySafety}, ${ui.settings}`} className="tools">
            <label className="lang-select">
              <span className="sr-only">{ui.language}</span>
              <GlobeIcon size={20} />
              <select value={language} onChange={(e) => controller.updateSettings({ language: e.target.value as SpeechLang })} data-testid="language">
                {SPEECH_LANGS.map((l) => (
                  <option key={l} value={l} lang={LANGS[l].bcp47}>{UI_TEXT[l].name}</option>
                ))}
              </select>
              <ChevronIcon size={16} />
            </label>
            <button type="button" onClick={() => controller.openSheet("privacy")} className="icon-button" aria-label={ui.privacySafety} title={ui.privacySafety} data-testid="open-privacy">
              <ShieldIcon size={22} />
            </button>
            <button type="button" onClick={() => controller.openSheet("settings")} className="icon-button" aria-label={ui.settings} title={ui.settings} data-testid="open-settings">
              <SettingsIcon size={22} />
            </button>
          </nav>
        </header>

        <main className="main">
          {/* The AI in use, on the home screen. Only where the server offers Nadhra, or it is already
              chosen (so the user can always switch back). */}
          {(s.status?.nadhra || provider === "nadhra") && (
            <ProviderSwitch provider={provider} offered={!!s.status?.nadhra} onChange={(p) => controller.updateSettings({ provider: p })} />
          )}
          {!active && (
            <section className="home" aria-label={ui.openCamera}>
              <button ref={openRef} type="button" onClick={() => void controller.startAssistance()} aria-keyshortcuts="C" aria-describedby="tagline" className="open-camera" data-testid="open-camera">
                <span className="open-camera-icon" aria-hidden="true">
                  <CameraIcon size={44} />
                </span>
                <span>{ui.openCamera}</span>
              </button>
              <div className="home-text">
                <p id="tagline" className="tagline">{ui.tagline}</p>
                {s.cameraError && (
                  <p role="alert" className="home-alert">{cameraErrorText(language, s.cameraError)}</p>
                )}
                <p className="footnote">
                  {ui.safetyNote}{" "}
                  <button type="button" onClick={() => controller.openSheet("privacy")} className="link">{ui.privacySafety}</button>
                </p>
              </div>
            </section>
          )}

          <section className="stage" hidden={!active} aria-label={ui.active} data-on={cameraOn} data-urgent={urgentNow} data-testid="stage"
            // The controller's state, for automated tests: the status panels are gone from the screen.
            data-camera={s.camera} data-analysis={s.analysis} data-detector={s.detector} data-mic={s.mic} data-voice-commands={s.assistantOn}
            data-detections={s.detections.length} data-local-hazards={s.localHazards.map((h) => `${h.kind}:${h.motion}`).join(" ")}>
            <video ref={videoRef} muted playsInline aria-hidden="true" tabIndex={-1} />

            {!cameraOn && (
              <div className="stage-empty">
                {s.camera === "starting" ? (
                  <p className="stage-empty-text">{ui.starting}</p>
                ) : (
                  <>
                    <p className="stage-empty-text">{s.cameraError ? cameraErrorText(language, s.cameraError) : ui.cameraOff}</p>
                    <button type="button" onClick={() => void controller.startCamera()} className="pill-button" data-testid="reopen-camera">
                      <CameraIcon size={22} />
                      <span>{ui.openCamera}</span>
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="stage-top">
              <p className="pill" data-tone={status.tone} data-testid="assistant-state">
                <i aria-hidden="true" />
                {status.text}
              </p>
              <p className="pill" data-tone={mic.on ? "listen" : "quiet"} data-testid="mic-status">
                {mic.on ? <MicIcon size={18} /> : <MicOffIcon size={18} />}
                {mic.text}
              </p>
            </div>
            {notices.length > 0 && (
              <ul className="notices" role="status">
                {notices.map((n) => <li key={n} className="pill" data-tone="notice">{n}</li>)}
              </ul>
            )}

            <div className="caption-box" data-urgent={urgentNow}>
              {heard && (
                <p className="heard" data-testid={liveOn ? "live-user" : "last-heard"}>
                  <span className="sr-only">{ui.heard}: </span>
                  <MicIcon size={16} /> <span dir="auto">«{heard}»</span>
                </p>
              )}
              {caption ? (
                <p dir="auto" data-testid="last-spoken" data-urgent={urgentNow} className="caption">{caption}</p>
              ) : (
                <p data-testid="last-spoken" data-urgent="false" className="caption caption-hint">{ui.prompt(examples.front ?? "")}</p>
              )}
            </div>
          </section>

          {active && (
            <button ref={stopRef} type="button" onClick={() => controller.stopAssistance()} aria-keyshortcuts="C" aria-describedby="stop-hint" className="stop-button" data-testid="stop-assistance">
              <CameraOffIcon size={26} />
              <span>{ui.stop}</span>
            </button>
          )}
          <p id="stop-hint" className="sr-only">{ui.stopHint}</p>
        </main>
      </div>

      <Sheet dialogRef={settingsRef} title="Settings" onClose={() => controller.closeSheet("settings")}>
        <div className="flex flex-col gap-6 text-lg">
          <div className="flex flex-col gap-3">
            <h3 className="font-medium">Conversation</h3>
            <Toggle testId="voice-commands" label="Voice commands" hint="On by itself with Open camera. Say a command or ask any question." checked={s.assistantOn} onChange={() => controller.toggleAssistant()} />
            <button type="button" onClick={() => controller.toggleLive()} aria-pressed={liveOn} aria-keyshortcuts="L" aria-describedby="live-hint" data-testid="live-toggle" data-live-status={s.live.status} className={`control ${liveOn ? "control-listening" : "control-quiet"} min-h-16`}>
              <MicIcon />
              <span className="min-w-0">{liveOn ? "End live conversation" : s.liveNotice ? "I agree: start the live conversation" : "Talk live"}</span>
              {liveOn && (
                <span aria-hidden="true" data-testid="live-status" className="ms-auto shrink-0 rounded-full border border-current px-3 py-0.5 text-base font-medium">{liveLabel(s)}</span>
              )}
            </button>
            <p id="live-hint" className="text-base text-ink-2">A spoken conversation, like a phone call: talk any time while showing the camera, and interrupt whenever you like. While it is on, your voice and about one picture a second go to Google Gemini. To stop sending, press “End live conversation” or “Stop assistance”: that stops on this phone, without sending anything. Saying “stop live” or «وقّف المحادثة» works too, but those words are recognised by Gemini Live, so they reach Google. On-device warnings keep running.</p>
            {liveOn && (
              <p role="status" className="text-base text-ink-2" data-testid="live-meta">
                {liveLabel(s)}
                {s.live.latencyMs != null && <> · answered in {(s.live.latencyMs / 1000).toFixed(2)} s</>}
                {s.live.voice && <> · voice {s.live.voice}</>}
                {s.live.framesSent > 0 && <> · {s.live.framesSent} frames sent</>}
              </p>
            )}
            {liveOn && s.live.ai && (
              <p className="text-base text-ink-2">Nadhra: <span dir="auto" lang={lang.bcp47} data-testid="live-ai" className={rtl ? "arabic" : ""}>{s.live.ai.trim()}</span></p>
            )}
          </div>
          <Choice label="Speech speed" value={String(s.settings.rate)} onChange={(v) => controller.updateSettings({ rate: Number(v) })}>
            {RATE_CHOICES.map((r) => <option key={r} value={r}>{r < 0.9 ? "Slow" : r === 0.9 ? "Normal" : r === 1 ? "A little faster" : "Fast"} ({r})</option>)}
          </Choice>
          <Choice label="Speech volume" hint="Warning tones stay loud." value={String(s.settings.volume)} onChange={(v) => controller.updateSettings({ volume: Number(v) })}>
            {VOLUME_CHOICES.map((v) => <option key={v} value={v}>{Math.round(v * 100)}%</option>)}
          </Choice>
          <Choice label="Text size" value={String(s.settings.textScale)} onChange={(v) => controller.updateSettings({ textScale: Number(v) })}>
            {TEXT_SCALE_CHOICES.map((v) => <option key={v} value={v}>{v === 1 ? "Standard" : `${Math.round(v * 100)}%`}</option>)}
          </Choice>
          <Choice label="Where does the camera point?" hint="This keeps left and right correct." value={s.settings.facing} onChange={(v) => controller.updateSettings({ facing: v as FacingSetting })}>
            <option value="auto">Automatic (now: {s.facing === "user" ? "at me" : "ahead of me"})</option>
            <option value="outward">Ahead of me (phone, or camera pointing away)</option>
            <option value="user">At me (computer webcam facing my face)</option>
          </Choice>
          <Choice label="Colors" value={theme} onChange={(v) => setTheme(v === "light" ? "light" : "dark")}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
          </Choice>
          <Toggle label="Describe my surroundings automatically" hint="Off: no picture is sent unless you ask. On: a picture goes to Google Gemini every few seconds, papers in view included; stairs and drops are only detected when this is on. The phone's own warnings for people and vehicles work either way." checked={s.settings.autoDescribe} onChange={(v) => controller.updateSettings({ autoDescribe: v })} />
          <Toggle label="Vibrate on warnings and events" hint="On phones that can vibrate." checked={s.settings.vibration} onChange={(v) => controller.updateSettings({ vibration: v })} />
          <Toggle label="Also send speech to my screen reader" checked={s.settings.screenReaderEcho} onChange={(v) => controller.updateSettings({ screenReaderEcho: v })} />
          {s.canSwitchCamera && cameraOn && (
            <button type="button" onClick={() => void controller.switchCamera()} className="control control-quiet min-h-16">Switch camera</button>
          )}

          <fieldset className="flex flex-col gap-4 border-t border-hairline pt-6">
            <legend className="float-left mb-1 font-medium">Emergency contact</legend>
            <p className="clear-left text-base text-ink-2">Kept on this device only. Say «نجدة» or “emergency” to open the Emergency page, then «عيّط» or “call” to select the call button.</p>
            <label className="flex flex-col gap-2">
              <span>Name</span>
              <input type="text" autoComplete="off" dir="auto" maxLength={40} value={s.settings.emergencyName} onChange={(e) => controller.updateSettings({ emergencyName: e.target.value })} className="field" />
            </label>
            <label className="flex flex-col gap-2">
              <span>Phone number</span>
              <input type="tel" inputMode="tel" autoComplete="off" dir="ltr" maxLength={20} value={s.settings.emergencyPhone} onChange={(e) => controller.updateSettings({ emergencyPhone: e.target.value.replace(/[^\d+\s]/g, "") })} className="field" />
            </label>
            <button type="button" onClick={() => controller.openSheet("emergency")} className="control control-emergency min-h-16">
              <PhoneIcon />
              <span>Open the Emergency page</span>
            </button>
          </fieldset>

          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">Camera consent</h3>
            <p className="mt-1 text-base text-ink-2">{s.consentGiven ? "You agreed to send camera images to the AI service." : "Not given. You'll be asked before the camera starts."}</p>
            {s.consentGiven && (
              <button type="button" onClick={() => controller.withdrawConsent()} className="control control-quiet mt-3 min-h-16" data-testid="withdraw-consent">Withdraw consent and stop the camera</button>
            )}
          </div>

          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">Voice commands</h3>
            <p className="mt-1 text-base text-ink-2">They work in all four languages. Anything else is taken as a question.</p>
            <ul className="mt-3 flex flex-col gap-2.5 text-base">
              {COMMAND_LIST.map(([cmd, what]) => (
                <li key={cmd} className="flex items-baseline justify-between gap-4 border-b border-hairline pb-2.5">
                  <span>{what}</span>
                  <span lang={lang.bcp47} dir={lang.dir} className={`font-medium ${rtl ? "arabic" : ""}`}>{examples[cmd]}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">Keyboard shortcuts</h3>
            <p className="mt-1 text-base text-ink-2">With a screen reader, use its pass-through mode, or use the buttons.</p>
            <ul className="mt-3 flex flex-col gap-2.5 text-base">
              {SHORTCUTS.map(([key, what]) => (
                <li key={key} className="flex items-center gap-3"><kbd>{key}</kbd><span>{what}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </Sheet>

      <Sheet dialogRef={privacyRef} title="Privacy & safety" onClose={() => controller.closeSheet("privacy")}>
        <div className="safety-note">
          <h3 className="font-semibold">Experimental test version</h3>
          <p className="mt-1">
            This assistant only helps. It doesn&apos;t replace a white cane, a guide dog or help from people. It can make mistakes, and a warning can arrive seconds late or not at all. Silence doesn&apos;t mean the way is safe.
          </p>
        </div>
        <h3 className="mt-6 font-semibold">Privacy</h3>
        <PrivacyText providers={providers} />
        {s.consentGiven && (
          <button type="button" onClick={() => controller.withdrawConsent()} className="control control-quiet mt-6 min-h-16">Withdraw consent and stop the camera</button>
        )}
      </Sheet>

      <Sheet dialogRef={emergencyRef} title="Emergency assistance" onClose={() => controller.closeSheet("emergency")}>
        <div className="flex flex-col gap-4 text-lg">
          {contact ? (
            <>
              <a ref={callRef} href={telHref(contact)} data-autofocus className="control control-primary">
                <PhoneIcon />
                <span>Call {contactName}</span>
              </a>
              <a href={smsHref(contact, controller.emergencyMessage())} aria-describedby="location-status" className="control control-quiet">
                <MessageIcon />
                <span>Text my location to {contactName}</span>
              </a>
              <p id="location-status" role="status" className="text-base text-ink-2">
                {s.location.status === "pending" && "Finding your location… The message can be sent now without it."}
                {s.location.status === "ready" && `Location found, accurate to about ${Math.max(5, Math.round(s.location.accuracy))} m. It's added to the message as a map link.`}
                {s.location.status === "failed" && "Location unavailable. The message will ask them to call you."}
              </p>
            </>
          ) : (
            <div className="flex flex-col gap-3">
              <p>No emergency contact yet. Add a name and phone number in Settings to call or text them from here.</p>
              <button type="button" data-autofocus onClick={() => controller.openSheet("settings")} className="control control-quiet min-h-16">Add an emergency contact</button>
            </div>
          )}
          <h3 className="mt-4 font-medium">Emergency numbers in Tunisia</h3>
          <ul className="flex flex-col gap-3">
            {EMERGENCY_NUMBERS.map((n) => (
              <li key={n.number}>
                <a href={telHref(n.number)} className="control control-emergency min-h-16 justify-between">
                  <span>{n.label}</span>
                  <span className="tabular-nums">{n.number}</span>
                </a>
              </li>
            ))}
          </ul>
          <p className="text-base text-ink-2">Calls and messages open your phone&apos;s own app; nothing is sent until you press call or send there. Your location is only put into the message on this device.</p>
        </div>
      </Sheet>

      <dialog ref={consentRef} lang="en" dir="ltr" onCancel={(e) => { e.preventDefault(); controller.declineConsent(); }} aria-labelledby="consent-title" className="modal m-auto w-[min(92vw,40rem)] rounded-[1.75rem] p-6 shadow-2xl sm:p-8">
        <LogoMark />
        <h2 id="consent-title" className="mt-3 text-[1.75rem] leading-tight font-semibold tracking-tight">Before the camera starts</h2>
        <PrivacyText providers={providers} />
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button ref={acceptRef} type="button" onClick={() => controller.acceptConsent()} className="control control-primary min-h-[4.5rem]">I agree</button>
          <button type="button" onClick={() => controller.declineConsent()} className="control control-quiet min-h-[4.5rem]">I don&apos;t agree</button>
        </div>
      </dialog>
    </>
  );
}

const PROVIDER_NAMES: Record<AiProvider, string> = { gemini: "Gemini", nadhra: "Nadhra (experimental)" };

/**
 * The AI in use, on the home screen: a two-part switch, the active side filled, one tap to change.
 * Native radio buttons, so screen readers announce a choice of two and which one is selected. The
 * choice goes through the controller (privacy and consent rules, spoken confirmation) and is saved
 * on the device. Nadhra is never offered as a new choice when the server doesn't offer it.
 */
function ProviderSwitch({ provider, offered, onChange }: { provider: AiProvider; offered: boolean; onChange: (p: AiProvider) => void }) {
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (!changed) return;
    const t = setTimeout(() => setChanged(false), 4_000);
    return () => clearTimeout(t);
  }, [changed, provider]);
  const pick = (p: AiProvider) => {
    if (p === provider) return;
    onChange(p);
    setChanged(true);
  };
  return (
    <fieldset className="ai-switch" data-testid="ai-provider" data-active={provider} lang="en" dir="ltr">
      <legend className="sr-only">AI</legend>
      <div className="ai-switch-track">
        {(["gemini", "nadhra"] as const).map((p) => {
          const active = provider === p;
          const unavailable = p === "nadhra" && !offered;
          const Icon = p === "gemini" ? CloudIcon : DeviceIcon;
          return (
            <label key={p} className="ai-switch-option" data-active={active} data-testid={`ai-provider-${p}`} title={unavailable ? "This server doesn't offer Nadhra" : undefined}>
              <input type="radio" name="ai-provider" value={p} checked={active} disabled={unavailable && !active} onChange={() => pick(p)} className="sr-only" />
              <Icon size={20} />
              {/* The exact name, never cut: on a very narrow screen it breaks before "(experimental)". */}
              <span className="ai-switch-name">
                {PROVIDER_NAMES[p].split(" ").map((w, i) => (
                  <Fragment key={i}>
                    {i > 0 && " "}
                    <span>{w}</span>
                  </Fragment>
                ))}
              </span>
            </label>
          );
        })}
      </div>
      <p role="status" className="ai-switch-note" data-testid="ai-provider-notice">
        {changed ? `✓ ${PROVIDER_NAMES[provider]}` : ""}
      </p>
    </fieldset>
  );
}

function Choice({ label, hint, value, onChange, children }: { label: string; hint?: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="font-medium">{label}</span>
      {hint && <span className="text-base text-ink-2">{hint}</span>}
      <span className="select">
        <select value={value} onChange={(e) => onChange(e.target.value)} className="field pe-12">{children}</select>
        <ChevronIcon size={20} />
      </span>
    </label>
  );
}

function Toggle({ label, hint, checked, onChange, testId }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; testId?: string }) {
  return (
    <label className="flex min-h-14 items-center justify-between gap-4">
      <span>{label}{hint && <span className="block text-base text-ink-2">{hint}</span>}</span>
      <input type="checkbox" role="switch" data-testid={testId} checked={checked} onChange={(e) => onChange(e.target.checked)} className="switch" />
    </label>
  );
}

/** A side panel. A native modal dialog: traps focus, closes on Esc, and returns focus to its opener. */
function Sheet({ dialogRef, title, onClose, children }: { dialogRef: React.RefObject<HTMLDialogElement | null>; title: string; onClose: () => void; children: React.ReactNode }) {
  const close = () => dialogRef.current?.close();
  return (
    <dialog
      ref={dialogRef}
      lang="en"
      dir="ltr"
      aria-label={title}
      className="sheet p-0"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) close(); // the backdrop
      }}
    >
      <div className="flex min-h-full flex-col px-6 pb-10 sm:px-8">
        <div className="sticky top-0 z-10 -mx-2 mb-4 flex min-h-20 items-center justify-between gap-3 bg-surface px-2">
          <h2 className="text-[1.75rem] leading-tight font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={close} className="ghost">
            <CloseIcon size={22} />
            <span>Close</span>
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function PrivacyText({ providers }: { providers: string }) {
  return (
    <ul className="mt-3 flex flex-col text-lg leading-relaxed">
      {[
        "This is an experimental test version. It doesn't replace a white cane, a guide dog or help from people, and it can be wrong or late.",
        `While the camera is on, a camera image is sent to an external AI service (${providers}) every few seconds when the view changes, and with each question you ask.`,
        "Open camera also turns on voice commands: the microphone listens for your questions once your browser allows it. Say “stop listening” or press Stop to turn it off.",
        "In a live conversation, your microphone and the camera (about one image a second) go straight to Google Gemini for as long as the conversation is on.",
        "On-device warnings (people, vehicles, some objects) are worked out on this phone and send nothing.",
        "This app doesn't record or store video, images or your voice, on this device or on its server.",
        "The external service may keep and use them under its own terms, especially on a free plan. Don't point the camera at personal documents or bank cards, and be mindful of people around you.",
        "When you ask by voice, your voice goes to your browser's speech service (Google, in Chrome) or to the same external service.",
        "When the browser has no suitable voice, the sentences the assistant says are sent to Microsoft's online voice service to be spoken.",
        "Your emergency contact and location stay on this device. The location is only added to a message you send yourself.",
        "When you stop the camera, switch to another app or leave the page, the camera and microphone turn off. You can withdraw your consent in Settings at any time.",
      ].map((line) => (
        <li key={line} className="border-b border-hairline py-3 last:border-0">{line}</li>
      ))}
    </ul>
  );
}
