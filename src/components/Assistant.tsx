"use client";
// The whole app is this one screen, in the order a screen reader meets it: what the assistant just
// said, the main controls, the camera, questions, then details. Every action works by keyboard,
// screen reader or voice, and every state change is spoken, so nothing depends on seeing the screen.
//
// The interface is in English. Everything the assistant says stays in Tunisian Arabic, so that text
// is always marked lang="ar", which also makes screen readers switch voice for it.
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { SmartVisionController, type AnalysisState, type CameraState, type MicState, type VisionState } from "@/lib/assistant/controller";
import { CAMERA_ERRORS, SPEECH } from "@/lib/assistant/phrases";
import { RATE_CHOICES, type FacingSetting } from "@/lib/assistant/settings";
import type { Confidence, Motion, Proximity, Side } from "@/lib/assistant/types";
import { Iris, type IrisState } from "./Iris";
import { AskIcon, CameraIcon, CameraOffIcon, ChevronIcon, CloseIcon, ForwardIcon, LogoMark, MicIcon, MicOffIcon, PauseIcon, PlayIcon, RepeatIcon, SettingsIcon, ShieldIcon, SilenceIcon } from "./icons";

/** `ask` is what the model receives: the answer logic expects these Tunisian questions. */
const QUICK_QUESTIONS = [
  { label: "What's in front of me?", ask: "شنوة قدّامي؟" },
  { label: "Where is the door?", ask: "وين الباب؟" },
  { label: "What's on my right?", ask: "شنوة موجود على يميني؟" },
  { label: "Is anyone with me?", ask: "فمّا شكون معايا؟" },
  { label: "What does it say here?", ask: "شنوة مكتوب هنا؟" },
  { label: "Is anything in my way?", ask: "فمّا حاجات في طريقي؟" },
  { label: "Describe this place", ask: "وصفلي البلاصة اللي أنا فيها." },
];

const CAMERA_LABEL: Record<CameraState, string> = { off: "Off", starting: "Starting…", on: "On", error: "Problem" };
const MIC_LABEL: Record<MicState, string> = { off: "Off", listening: "Listening", processing: "Understanding…", denied: "No permission", unavailable: "Unavailable" };
const ANALYSIS_LABEL: Record<AnalysisState, string> = {
  off: "Stopped",
  watching: "Watching",
  analyzing: "Analyzing the image…",
  paused: "Paused",
  unavailable: "Service unavailable",
  "poor-image": "Image unclear",
  hidden: "Stopped (page hidden)",
};
const IRIS_LABEL: Record<IrisState, string> = { idle: "Ready", watching: "Watching", thinking: "Thinking", listening: "Listening", speaking: "Speaking", urgent: "Warning" };
const SIDE_LABEL: Record<Side, string> = { left: "on the left", right: "on the right", center: "ahead", unknown: "position unclear" };
const PROXIMITY_LABEL: Record<Proximity, string> = { near: "near", mid: "not far", far: "far", unknown: "" };
const CONFIDENCE_LABEL: Record<Confidence, string> = { confirmed: "Confirmed", likely: "Likely", uncertain: "Unsure" };
const MOTION_LABEL: Record<Motion, string> = { approaching: "approaching", moving_away: "moving away", crossing: "crossing", stationary: "", unknown: "" };

// The controller speaks camera errors in Tunisian. On screen they appear in English.
const CAMERA_ERROR_LABEL: Record<string, string> = {
  [CAMERA_ERRORS.denied]: "No permission to use the camera. Allow it in your browser settings and try again.",
  [CAMERA_ERRORS["not-found"]]: "No camera was found on this device.",
  [CAMERA_ERRORS.busy]: "The camera is being used by another app. Close it and try again.",
  [CAMERA_ERRORS.insecure]: "The camera needs a secure (https) address.",
  [CAMERA_ERRORS.unsupported]: "This browser doesn't support the camera.",
  [CAMERA_ERRORS.unknown]: "The camera couldn't start. Try again.",
  [SPEECH.cameraLost]: "The camera stopped. Check it and start it again.",
};

/** A warning stays readable this long, even if the voice fails or the next sentence follows at once. */
const WARNING_HOLD_MS = 5_000;

function irisState(s: VisionState): IrisState {
  if (s.lastUrgent && s.speaking) return "urgent";
  if (s.mic === "listening") return "listening";
  if (s.speaking) return "speaking";
  if (s.analysis === "analyzing" || s.mic === "processing") return "thinking";
  if (s.camera === "on" && s.analysis !== "paused") return "watching";
  return "idle";
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

export default function Assistant() {
  const [controller] = useState(() => new SmartVisionController());
  const s = useStore(controller.store);
  const videoRef = useRef<HTMLVideoElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const consentRef = useRef<HTMLDialogElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const privacyRef = useRef<HTMLDialogElement>(null);
  const [typed, setTyped] = useState("");
  const [theme, setTheme] = useTheme();
  const heldWarning = useHeldWarning(s.lastSpoken, s.lastUrgent);

  useEffect(() => {
    if (videoRef.current) controller.attach(videoRef.current);
    startRef.current?.focus({ preventScroll: true });
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

  // Physical key positions, so these work with an Arabic keyboard layout too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      if (document.querySelector("dialog[open]")) return; // Esc and typing belong to the open dialog
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, select, [contenteditable]")) return;
      const actions: Record<string, () => void> = {
        Escape: () => controller.stopSpeech(),
        KeyC: () => (controller.state.camera === "on" ? controller.stopCamera() : void controller.startCamera()),
        KeyV: () => controller.toggleAssistant(),
        KeyQ: () => void controller.askByVoice(),
        KeyP: () => (controller.isPaused ? controller.resume() : controller.pause()),
        KeyR: () => controller.repeat(),
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

  const cameraOn = s.camera === "on";
  const paused = s.analysis === "paused";
  const iris = irisState(s);
  const echo = s.settings.screenReaderEcho || s.ttsFailed;
  const urgentNow = !!heldWarning;
  const shownSentence = heldWarning ?? s.lastSpoken;
  const providers = s.status?.providers.map((p) => p.label).join(", ") || "an external AI service";
  const voiceText = s.voice
    ? `${s.voice.name}${s.voice.exactDialect ? " (Tunisian)" : " (Arabic, not Tunisian)"}`
    : s.ttsFailed
      ? "Voice unavailable, text goes to your screen reader"
      : "Looking for an Arabic voice…";
  const hasFindings = !!s.environment || s.detections.length > 0 || s.localHazards.length > 0 || s.texts.length > 0;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-5 pb-16 sm:px-8">
      <header className="rise flex min-h-20 items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <LogoMark />
          <div className="min-w-0">
            <h1 className="text-[1.75rem] leading-none font-semibold tracking-tight">Basira</h1>
            <p className="mt-1.5 hidden text-sm leading-tight text-ink-2 sm:block">Vision assistant that speaks Tunisian</p>
          </div>
        </div>
        <nav aria-label="Settings and privacy" className="flex shrink-0 items-center">
          <button type="button" onClick={() => privacyRef.current?.showModal()} className="ghost">
            <ShieldIcon size={22} />
            <span className="sr-only sm:not-sr-only">Privacy</span>
          </button>
          <button type="button" onClick={() => settingsRef.current?.showModal()} className="ghost">
            <SettingsIcon size={22} />
            <span className="sr-only sm:not-sr-only">Settings</span>
          </button>
        </nav>
      </header>

      <main className="grid gap-x-16 gap-y-10 pt-2 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-6">
        {/* Screen-reader channel. Silent unless asked for, or the page's own voice has failed. */}
        <div lang="ar" dir="rtl" aria-live={echo && !s.announce.urgent ? "polite" : "off"} className="sr-only">{echo && !s.announce.urgent ? s.announce.text : ""}</div>
        <div lang="ar" dir="rtl" role={echo && s.announce.urgent ? "alert" : undefined} className="sr-only">{echo && s.announce.urgent ? s.announce.text : ""}</div>

        {/* The assistant: its presence, its voice, and the controls. Stays in view on tall screens. */}
        <div className="flex min-w-0 flex-col gap-7 lg:self-start [@media(min-width:1024px)_and_(min-height:1100px)]:sticky [@media(min-width:1024px)_and_(min-height:1100px)]:top-6">
          <section aria-labelledby="said-title" className="voice-panel rise -m-4 p-4" data-urgent={urgentNow} style={{ "--at": "60ms" } as React.CSSProperties}>
            <div className="flex items-center gap-6">
              <Iris state={iris} className="size-32 shrink-0 sm:size-44" />
              <div className="min-w-0">
                <h2 id="said-title" className="quiet-text text-[0.95rem] text-ink-2">The assistant last said</h2>
                <p data-testid="assistant-state" className="mt-0.5 text-xl font-medium">{IRIS_LABEL[iris]}</p>
              </div>
            </div>
            {shownSentence ? (
              <p key={shownSentence} lang="ar" dir="rtl" data-testid="last-spoken" data-urgent={urgentNow} className="caption arabic mt-5 min-h-[6.5rem] text-[clamp(1.55rem,1.25rem+1.1vw,2.1rem)] leading-[1.5] font-medium">
                {shownSentence}
              </p>
            ) : (
              <p data-testid="last-spoken" data-urgent="false" className="caption mt-5 min-h-[6.5rem] text-[clamp(1.55rem,1.25rem+1.1vw,2.1rem)] leading-[1.35] font-medium tracking-tight">
                Press Start camera to begin.
              </p>
            )}
            {s.lastHeard && <p className="quiet-text mt-3 text-base text-ink-2">I heard: <span lang="ar" dir="auto">«{s.lastHeard}»</span></p>}
          </section>

          {s.cameraError && <p role="alert" className="rounded-2xl bg-alert p-4 text-lg font-medium text-alert-ink">{CAMERA_ERROR_LABEL[s.cameraError] ?? CAMERA_ERROR_LABEL[CAMERA_ERRORS.unknown]}</p>}

          <div className="rise flex flex-col gap-3" style={{ "--at": "120ms" } as React.CSSProperties}>
            {cameraOn || s.camera === "starting" ? (
              <button ref={startRef} type="button" onClick={() => controller.stopCamera()} aria-keyshortcuts="C" className="control control-stop">
                <CameraOffIcon />
                <span>Stop camera</span>
              </button>
            ) : (
              <button ref={startRef} type="button" onClick={() => void controller.startCamera()} aria-keyshortcuts="C" className="control control-primary">
                <CameraIcon />
                <span>Start camera</span>
              </button>
            )}
            <button type="button" onClick={() => controller.toggleAssistant()} aria-pressed={s.assistantOn} aria-keyshortcuts="V" className={`control ${s.assistantOn ? "control-listening" : "control-quiet"}`}>
              {s.assistantOn ? <MicOffIcon /> : <MicIcon />}
              <span>{s.assistantOn ? "Turn off voice assistant" : "Turn on voice assistant"}</span>
            </button>
            <div className="grid grid-cols-2 gap-3 [&>:last-child:nth-child(odd)]:col-span-2">
              <button type="button" onClick={() => void controller.askByVoice()} aria-keyshortcuts="Q" data-live={s.mic === "listening"} className="control control-quiet tile">
                <AskIcon />
                <span>{s.mic === "listening" && !s.assistantOn ? "Done, send question" : "Ask by voice"}</span>
              </button>
              <button type="button" onClick={() => controller.stopSpeech()} aria-keyshortcuts="Escape" data-live={s.speaking} className="control control-quiet tile">
                <SilenceIcon />
                <span>Stop talking</span>
              </button>
              {cameraOn && (
                <button type="button" onClick={() => (paused ? controller.resume() : controller.pause())} aria-pressed={paused} aria-keyshortcuts="P" className="control control-quiet tile">
                  {paused ? <PlayIcon /> : <PauseIcon />}
                  <span>{paused ? "Resume analysis" : "Pause analysis"}</span>
                </button>
              )}
              <button type="button" onClick={() => controller.repeat()} aria-keyshortcuts="R" className="control control-quiet tile">
                <RepeatIcon />
                <span>Repeat last sentence</span>
              </button>
            </div>
          </div>

          <p className="rise border-s-2 border-glow ps-4 text-base leading-relaxed text-ink-2" style={{ "--at": "180ms" } as React.CSSProperties}>
            This assistant only helps. It doesn&apos;t replace a white cane or a guide dog. It can make mistakes, and a warning can arrive seconds late. Silence doesn&apos;t mean the way is safe.
          </p>
        </div>

        {/* What it sees, and what you can ask about it. */}
        <div className="flex min-w-0 flex-col gap-12">
          <section aria-labelledby="stage-title" className="rise" style={{ "--at": "160ms" } as React.CSSProperties}>
            <h2 id="stage-title" className="sr-only">Camera</h2>
            <div className="stage" data-on={cameraOn} data-urgent={urgentNow}>
              <video ref={videoRef} muted playsInline aria-label="Live camera preview" className={cameraOn ? "" : "invisible"} />
              {s.analysis === "analyzing" && <div className="sweep" aria-hidden="true" />}
              <span className="corner corner-a" aria-hidden="true" />
              <span className="corner corner-b" aria-hidden="true" />
              <span className="corner corner-c" aria-hidden="true" />
              <span className="corner corner-d" aria-hidden="true" />
              {cameraOn ? (
                <p className="chip top-4 left-1/2 -translate-x-1/2">
                  <i aria-hidden="true" data-paused={paused} />
                  {paused ? "Paused" : "Live"}
                </p>
              ) : (
                <div className="absolute inset-0 grid place-items-center p-6 text-center">
                  <div>
                    <CameraIcon size={44} className="mx-auto text-ink-2" />
                    <p className="mt-3 text-lg text-ink-2">{s.camera === "starting" ? "Starting the camera…" : "The camera is off. No images are being sent."}</p>
                  </div>
                </div>
              )}
              {cameraOn && s.lastLatencyMs != null && (
                <p className="chip bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap">Last analysis: {(s.lastLatencyMs / 1000).toFixed(1)} s</p>
              )}
            </div>

            <dl className="mt-5 grid grid-cols-1 gap-x-10 sm:grid-cols-2">
              <Status term="Camera" testId="camera-status" value={CAMERA_LABEL[s.camera]} />
              <Status term="Microphone" testId="mic-status" value={s.assistantOn && s.mic === "off" ? "Waiting" : MIC_LABEL[s.mic]} />
              <Status term="Analysis" testId="analysis-status" value={ANALYSIS_LABEL[s.analysis]} />
              <Status term="On-device detection" value={!cameraOn ? "Stopped" : s.detector === "ready" ? "Running" : s.detector === "loading" ? "Loading…" : s.detector === "failed" ? "Failed, cloud analysis only" : "Stopped"} />
              <Status term="Voice" testId="voice-status" value={voiceText} wide />
              {s.status && !s.status.available && <Status term="Service" value="The AI key isn't set on the server." wide />}
            </dl>
          </section>

          <section aria-labelledby="ask-title" className="rise" style={{ "--at": "220ms" } as React.CSSProperties}>
            <h2 id="ask-title" className="text-[1.75rem] leading-tight font-semibold tracking-tight">Ask</h2>
            <form
              className="relative mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void controller.ask(typed);
                setTyped("");
              }}
            >
              <label htmlFor="question" className="sr-only">Type your question</label>
              <input id="question" dir="auto" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={300} placeholder="Type your question" className="field min-h-16 rounded-[1.25rem] pe-28" />
              <button type="submit" disabled={!typed.trim()} className="absolute inset-y-2 end-2 flex min-w-24 items-center justify-center gap-1.5 rounded-[0.9rem] bg-primary px-4 font-medium text-primary-ink transition-opacity disabled:opacity-40">
                <span>Send</span>
                <ForwardIcon size={20} />
              </button>
            </form>
            <div className="mt-3 grid gap-x-10 sm:grid-cols-2">
              {QUICK_QUESTIONS.map((q) => (
                <button key={q.ask} type="button" onClick={() => void controller.ask(q.ask)} className="row-button">
                  <span>{q.label}</span>
                  <ForwardIcon size={20} />
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="seen-title" className="rise" style={{ "--at": "280ms" } as React.CSSProperties}>
            <h2 id="seen-title" className="text-[1.75rem] leading-tight font-semibold tracking-tight">What it sees now</h2>
            {!hasFindings ? (
              <p className="mt-3 text-lg text-ink-2">{cameraOn ? "Nothing yet." : "Start the camera to begin."}</p>
            ) : (
              <div className="mt-4 flex flex-col gap-7">
                {s.environment && <p className="text-xl">Place: <span lang="ar" dir="auto" className="arabic font-medium">{s.environment.label}</span> <span className="text-base text-ink-2">({CONFIDENCE_LABEL[s.environment.confidence]})</span></p>}
                {s.localHazards.length > 0 && <Findings title="On-device detection" testId="local-hazards" items={s.localHazards} />}
                {s.detections.length > 0 && <Findings title="Cloud analysis" testId="detections" items={s.detections} />}
                {s.texts.length > 0 && (
                  <div>
                    <h3 className="text-base text-ink-2">Text it can read</h3>
                    <ul className="mt-1">
                      {s.texts.map((t, i) => (
                        <li key={i} className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5 text-lg">
                          <span dir="auto">{t.content}</span> <span className="shrink-0 text-sm text-ink-2">{CONFIDENCE_LABEL[t.confidence]}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </main>

      <Sheet dialogRef={settingsRef} title="Settings">
        <div className="flex flex-col gap-6 text-lg">
          <label className="flex flex-col gap-2">
            <span className="font-medium">Speech speed</span>
            <span className="select">
              <select value={String(s.settings.rate)} onChange={(e) => controller.updateSettings({ rate: Number(e.target.value) })} className="field pe-12">
                {RATE_CHOICES.map((r) => <option key={r} value={r}>{r < 0.9 ? "Slow" : r === 0.9 ? "Normal" : r === 1 ? "A little faster" : "Fast"} ({r})</option>)}
              </select>
              <ChevronIcon size={20} />
            </span>
          </label>
          <label className="flex flex-col gap-2">
            <span className="font-medium">Where does the camera point?</span>
            <span className="text-base text-ink-2">This keeps left and right correct.</span>
            <span className="select">
              <select value={s.settings.facing} onChange={(e) => controller.updateSettings({ facing: e.target.value as FacingSetting })} className="field pe-12">
                <option value="auto">Automatic (now: {s.facing === "user" ? "at me" : "ahead of me"})</option>
                <option value="outward">Ahead of me (phone, or camera pointing away)</option>
                <option value="user">At me (computer webcam facing my face)</option>
              </select>
              <ChevronIcon size={20} />
            </span>
          </label>
          <label className="flex flex-col gap-2">
            <span className="font-medium">Colors</span>
            <span className="select">
              <select value={theme} onChange={(e) => setTheme(e.target.value === "light" ? "light" : "dark")} className="field pe-12">
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
              <ChevronIcon size={20} />
            </span>
          </label>
          <label className="flex min-h-14 items-center justify-between gap-4">
            <span>Describe my surroundings automatically <span className="block text-base text-ink-2">Warnings and answers stay on.</span></span>
            <input type="checkbox" role="switch" checked={s.settings.narration} onChange={(e) => controller.updateSettings({ narration: e.target.checked })} className="switch" />
          </label>
          <label className="flex min-h-14 items-center justify-between gap-4">
            <span>Also send speech to my screen reader</span>
            <input type="checkbox" role="switch" checked={s.settings.screenReaderEcho} onChange={(e) => controller.updateSettings({ screenReaderEcho: e.target.checked })} className="switch" />
          </label>
          {s.canSwitchCamera && cameraOn && (
            <button type="button" onClick={() => void controller.switchCamera()} className="control control-quiet min-h-16">Switch camera</button>
          )}
          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">Keyboard shortcuts</h3>
            <ul className="mt-3 flex flex-col gap-2.5 text-base">
              {([["C", "Start or stop the camera"], ["V", "Turn the voice assistant on or off"], ["Q", "Ask by voice"], ["P", "Pause or resume analysis"], ["R", "Repeat the last sentence"], ["Esc", "Stop talking"]] as const).map(([key, what]) => (
                <li key={key} className="flex items-center gap-3"><kbd>{key}</kbd><span>{what}</span></li>
              ))}
            </ul>
          </div>
          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">Voice commands</h3>
            <p className="mt-1 text-base text-ink-2">Say these in Tunisian Arabic.</p>
            <ul className="mt-3 flex flex-col gap-2.5 text-base">
              {([["اسكت", "Stop talking"], ["عاود", "Repeat"], ["وقّف التحليل", "Pause analysis"], ["كمّل", "Resume"], ["شعّل الكاميرا", "Start the camera"], ["سكّر الكاميرا", "Stop the camera"], ["سكّر الميكرو", "Turn off the microphone"]] as const).map(([say, what]) => (
                <li key={say} className="flex items-baseline justify-between gap-4 border-b border-hairline pb-2.5"><span>{what}</span><span lang="ar" dir="rtl" className="arabic font-medium">{say}</span></li>
              ))}
            </ul>
          </div>
        </div>
      </Sheet>

      <Sheet dialogRef={privacyRef} title="Privacy">
        <PrivacyText providers={providers} />
      </Sheet>

      <dialog ref={consentRef} onCancel={(e) => { e.preventDefault(); controller.declineConsent(); }} aria-labelledby="consent-title" className="modal m-auto w-[min(92vw,40rem)] rounded-[1.75rem] p-6 shadow-2xl sm:p-8">
        <Iris state="watching" className="size-16" />
        <h2 id="consent-title" className="mt-3 text-[1.75rem] leading-tight font-semibold tracking-tight">Before the camera starts</h2>
        <PrivacyText providers={providers} />
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button ref={acceptRef} type="button" onClick={() => controller.acceptConsent()} className="control control-primary min-h-[4.5rem]">I agree</button>
          <button type="button" onClick={() => controller.declineConsent()} className="control control-quiet min-h-[4.5rem]">I don&apos;t agree</button>
        </div>
      </dialog>
    </div>
  );
}

function Status({ term, value, testId, wide }: { term: string; value: string; testId?: string; wide?: boolean }) {
  return (
    <div className={`flex min-h-12 items-baseline justify-between gap-4 border-b border-hairline py-2.5 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="shrink-0 text-base text-ink-2">{term}</dt>
      <dd data-testid={testId} className="min-w-0 text-end text-base font-medium break-words">{value}</dd>
    </div>
  );
}

function Findings({ title, testId, items }: { title: string; testId: string; items: { label: string; side: Side; proximity: Proximity; confidence: Confidence; motion: Motion; action?: string }[] }) {
  return (
    <div>
      <h3 className="text-base text-ink-2">{title}</h3>
      <ul data-testid={testId} className="mt-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5">
            <span className="min-w-0">
              {/* Names and actions come from the assistant, in Tunisian. */}
              <span lang="ar" dir="auto" className="arabic text-lg font-medium">{item.label}</span>
              <span className="text-base text-ink-2">
                {"  "}
                {[SIDE_LABEL[item.side], PROXIMITY_LABEL[item.proximity], MOTION_LABEL[item.motion]].filter(Boolean).join(", ")}
              </span>
              {item.action && <span lang="ar" dir="auto" className="arabic text-base text-ink-2">{"  "}{item.action}</span>}
            </span>
            <span className="shrink-0 text-sm text-ink-2">{CONFIDENCE_LABEL[item.confidence]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A side panel. A native modal dialog: traps focus, closes on Esc, and returns focus to its opener. */
function Sheet({ dialogRef, title, children }: { dialogRef: React.RefObject<HTMLDialogElement | null>; title: string; children: React.ReactNode }) {
  const close = () => dialogRef.current?.close();
  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      className="sheet p-0"
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
        `To describe your surroundings, images from the camera are sent to an external AI service: ${providers}.`,
        "This app doesn't record video or store images.",
        "The external service may keep and use them under its own terms, especially on a free plan. Don't point the camera at personal documents or bank cards, and be mindful of people around you.",
        "When you ask by voice, your voice goes to your browser's speech service (Google, in Chrome) or to the same external service.",
        "When you stop the camera or leave the page, the camera and microphone turn off.",
      ].map((line) => (
        <li key={line} className="border-b border-hairline py-3 last:border-0">{line}</li>
      ))}
    </ul>
  );
}
