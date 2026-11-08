"use client";
// The whole app is this one screen, in the order a screen reader meets it: what the assistant just
// said, the main controls, the camera, questions, then details. Every action works by keyboard,
// screen reader or voice, and every state change is spoken, so nothing depends on seeing the screen.
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { SmartVisionController, type AnalysisState, type CameraState, type MicState, type VisionState } from "@/lib/assistant/controller";
import { RATE_CHOICES, type FacingSetting } from "@/lib/assistant/settings";
import type { Confidence, Motion, Proximity, Side } from "@/lib/assistant/types";
import { Iris, type IrisState } from "./Iris";
import { AskIcon, CameraIcon, CameraOffIcon, ChevronIcon, CloseIcon, ForwardIcon, LogoMark, MicIcon, MicOffIcon, PauseIcon, PlayIcon, RepeatIcon, SettingsIcon, ShieldIcon, SilenceIcon } from "./icons";

const QUICK_QUESTIONS = [
  "شنوة قدّامي؟",
  "وين الباب؟",
  "شنوة موجود على يميني؟",
  "فمّا شكون معايا؟",
  "شنوة مكتوب هنا؟",
  "فمّا حاجات في طريقي؟",
  "وصفلي البلاصة اللي أنا فيها.",
];

const CAMERA_LABEL: Record<CameraState, string> = { off: "مطفية", starting: "تتشعل…", on: "خدّامة", error: "فمّا مشكل" };
const MIC_LABEL: Record<MicState, string> = { off: "مسكّر", listening: "يسمع فيك", processing: "يفهم في كلامك…", denied: "ما عندوش الإذن", unavailable: "موش متوفّر" };
const ANALYSIS_LABEL: Record<AnalysisState, string> = {
  off: "واقف",
  watching: "يراقب",
  analyzing: "يحلّل الصورة…",
  paused: "موقوف مؤقّتًا",
  unavailable: "الخدمة موش متوفّرة",
  "poor-image": "الصورة موش واضحة",
  hidden: "واقف (الصفحة مخفية)",
};
const IRIS_LABEL: Record<IrisState, string> = { idle: "مستعد", watching: "يراقب", thinking: "يخمّم", listening: "يسمع فيك", speaking: "يحكي", urgent: "رد بالك" };
const SIDE_LABEL: Record<Side, string> = { left: "على اليسار", right: "على اليمين", center: "قدّام", unknown: "البلاصة موش واضحة" };
const PROXIMITY_LABEL: Record<Proximity, string> = { near: "قريب", mid: "موش بعيد", far: "بعيد", unknown: "" };
const CONFIDENCE_LABEL: Record<Confidence, string> = { confirmed: "مؤكّد", likely: "محتمل", uncertain: "موش متأكّد" };
const MOTION_LABEL: Record<Motion, string> = { approaching: "يقرّب", moving_away: "يبعد", crossing: "يتعدّى", stationary: "", unknown: "" };

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
  const urgentNow = s.lastUrgent && !!s.lastSpoken;
  const providers = s.status?.providers.map((p) => p.label).join("، ") || "خدمة ذكاء اصطناعي خارجية";
  const voiceText = s.voice
    ? `${s.voice.name}${s.voice.exactDialect ? " (تونسي)" : " (عربي، موش تونسي)"}`
    : s.ttsFailed
      ? "الصوت ما يخدمش، النص يتبعث لقارئ الشاشة"
      : "نلوّج على صوت عربي…";
  const hasFindings = !!s.environment || s.detections.length > 0 || s.localHazards.length > 0 || s.texts.length > 0;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-5 pb-16 sm:px-8">
      <header className="rise flex min-h-20 items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <LogoMark />
          <div className="min-w-0">
            <h1 className="text-[1.75rem] leading-none font-semibold">بصيرة</h1>
            <p className="mt-1.5 hidden text-sm leading-tight text-ink-2 sm:block">مساعد البصر بالدارجة التونسية</p>
          </div>
        </div>
        <nav aria-label="الإعدادات والخصوصية" className="flex shrink-0 items-center">
          <button type="button" onClick={() => privacyRef.current?.showModal()} className="ghost">
            <ShieldIcon size={22} />
            <span className="sr-only sm:not-sr-only">الخصوصية</span>
          </button>
          <button type="button" onClick={() => settingsRef.current?.showModal()} className="ghost">
            <SettingsIcon size={22} />
            <span className="sr-only sm:not-sr-only">الإعدادات</span>
          </button>
        </nav>
      </header>

      <main className="grid gap-x-16 gap-y-10 pt-2 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:pt-6">
        {/* Screen-reader channel. Silent unless asked for, or the page's own voice has failed. */}
        <div aria-live={echo && !s.announce.urgent ? "polite" : "off"} className="sr-only">{echo && !s.announce.urgent ? s.announce.text : ""}</div>
        <div role={echo && s.announce.urgent ? "alert" : undefined} className="sr-only">{echo && s.announce.urgent ? s.announce.text : ""}</div>

        {/* The assistant: its presence, its voice, and the controls. Stays in view on large screens. */}
        <div className="flex min-w-0 flex-col gap-7 lg:self-start [@media(min-width:1024px)_and_(min-height:1100px)]:sticky [@media(min-width:1024px)_and_(min-height:1100px)]:top-6">
          <section aria-labelledby="said-title" className="voice-panel rise -m-4 p-4" data-urgent={urgentNow} style={{ "--at": "60ms" } as React.CSSProperties}>
            <div className="flex items-center gap-6">
              <Iris state={iris} className="size-32 shrink-0 sm:size-44" />
              <div className="min-w-0">
                <h2 id="said-title" className="quiet-text text-[0.95rem] text-ink-2">آخر حاجة قالها المساعد</h2>
                <p data-testid="assistant-state" className="mt-0.5 text-xl font-medium">{IRIS_LABEL[iris]}</p>
              </div>
            </div>
            <p key={s.lastSpoken} data-testid="last-spoken" data-urgent={s.lastUrgent} className="caption mt-5 min-h-[6.5rem] text-[clamp(1.55rem,1.25rem+1.1vw,2.1rem)] leading-[1.5] font-medium">
              {s.lastSpoken || "اضغط على «شعّل الكاميرا» باش نبداو."}
            </p>
            {s.lastHeard && <p className="quiet-text mt-3 text-base text-ink-2">سمعت منك: «{s.lastHeard}»</p>}
          </section>

          {s.cameraError && <p role="alert" className="rounded-2xl bg-alert p-4 text-lg font-medium text-alert-ink">{s.cameraError}</p>}

          <div className="rise flex flex-col gap-3" style={{ "--at": "120ms" } as React.CSSProperties}>
            {cameraOn || s.camera === "starting" ? (
              <button ref={startRef} type="button" onClick={() => controller.stopCamera()} aria-keyshortcuts="C" className="control control-stop">
                <CameraOffIcon />
                <span>سكّر الكاميرا</span>
              </button>
            ) : (
              <button ref={startRef} type="button" onClick={() => void controller.startCamera()} aria-keyshortcuts="C" className="control control-primary">
                <CameraIcon />
                <span>شعّل الكاميرا</span>
              </button>
            )}
            <button type="button" onClick={() => controller.toggleAssistant()} aria-pressed={s.assistantOn} aria-keyshortcuts="V" className={`control ${s.assistantOn ? "control-listening" : "control-quiet"}`}>
              {s.assistantOn ? <MicOffIcon /> : <MicIcon />}
              <span>{s.assistantOn ? "سكّر المساعد الصوتي" : "شعّل المساعد الصوتي"}</span>
            </button>
            <div className="grid grid-cols-2 gap-3 [&>:last-child:nth-child(odd)]:col-span-2">
              <button type="button" onClick={() => void controller.askByVoice()} aria-keyshortcuts="Q" data-live={s.mic === "listening"} className="control control-quiet tile">
                <AskIcon />
                <span>{s.mic === "listening" && !s.assistantOn ? "كمّلت، ابعث السؤال" : "اسأل بالصوت"}</span>
              </button>
              <button type="button" onClick={() => controller.stopSpeech()} aria-keyshortcuts="Escape" data-live={s.speaking} className="control control-quiet tile">
                <SilenceIcon />
                <span>اسكت</span>
              </button>
              {cameraOn && (
                <button type="button" onClick={() => (paused ? controller.resume() : controller.pause())} aria-pressed={paused} aria-keyshortcuts="P" className="control control-quiet tile">
                  {paused ? <PlayIcon /> : <PauseIcon />}
                  <span>{paused ? "كمّل التحليل" : "وقّف التحليل"}</span>
                </button>
              )}
              <button type="button" onClick={() => controller.repeat()} aria-keyshortcuts="R" className="control control-quiet tile">
                <RepeatIcon />
                <span>عاود آخر جملة</span>
              </button>
            </div>
          </div>

          <p className="rise border-s-2 border-glow ps-4 text-base leading-relaxed text-ink-2" style={{ "--at": "180ms" } as React.CSSProperties}>
            المساعد هذا يعاونك برك، وما يعوّضش العصا ولا الكلب المرشد. ينجم يغلط، والتنبيه ينجم يتأخّر بثواني. كي ما يقول شي، موش معناها الطريق آمن.
          </p>
        </div>

        {/* What it sees, and what you can ask about it. */}
        <div className="flex min-w-0 flex-col gap-12">
          <section aria-labelledby="stage-title" className="rise" style={{ "--at": "160ms" } as React.CSSProperties}>
            <h2 id="stage-title" className="sr-only">الكاميرا</h2>
            <div className="stage" data-on={cameraOn} data-urgent={urgentNow && s.speaking}>
              <video ref={videoRef} muted playsInline aria-label="المعاينة الحيّة متاع الكاميرا" className={cameraOn ? "" : "invisible"} />
              {s.analysis === "analyzing" && <div className="sweep" aria-hidden="true" />}
              <span className="corner corner-a" aria-hidden="true" />
              <span className="corner corner-b" aria-hidden="true" />
              <span className="corner corner-c" aria-hidden="true" />
              <span className="corner corner-d" aria-hidden="true" />
              {cameraOn ? (
                <p className="chip top-4 left-1/2 -translate-x-1/2">
                  <i aria-hidden="true" data-paused={paused} />
                  {paused ? "موقوف" : "مباشر"}
                </p>
              ) : (
                <div className="absolute inset-0 grid place-items-center p-6 text-center">
                  <div>
                    <CameraIcon size={44} className="mx-auto text-ink-2" />
                    <p className="mt-3 text-lg text-ink-2">{s.camera === "starting" ? "الكاميرا تتشعل…" : "الكاميرا مطفية، وما تتبعث حتى صورة."}</p>
                  </div>
                </div>
              )}
              {cameraOn && s.lastLatencyMs != null && (
                <p className="chip bottom-4 left-1/2 -translate-x-1/2 whitespace-nowrap">آخر تحليل: {(s.lastLatencyMs / 1000).toFixed(1)} ث</p>
              )}
            </div>

            <dl className="mt-5 grid grid-cols-1 gap-x-10 sm:grid-cols-2">
              <Status term="الكاميرا" testId="camera-status" value={CAMERA_LABEL[s.camera]} />
              <Status term="الميكرو" testId="mic-status" value={s.assistantOn && s.mic === "off" ? "يستنّى" : MIC_LABEL[s.mic]} />
              <Status term="التحليل" testId="analysis-status" value={ANALYSIS_LABEL[s.analysis]} />
              <Status term="الكشف في الجهاز" value={!cameraOn ? "واقف" : s.detector === "ready" ? "خدّام" : s.detector === "loading" ? "يتحمّل…" : s.detector === "failed" ? "ما خدمش، يبقى التحليل السحابي برك" : "واقف"} />
              <Status term="الصوت" testId="voice-status" value={voiceText} wide />
              {s.status && !s.status.available && <Status term="الخدمة" value="مفتاح الذكاء الاصطناعي موش مضبوط على الخادم." wide />}
            </dl>
          </section>

          <section aria-labelledby="ask-title" className="rise" style={{ "--at": "220ms" } as React.CSSProperties}>
            <h2 id="ask-title" className="text-[1.75rem] leading-tight font-semibold">اسأل</h2>
            <form
              className="relative mt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void controller.ask(typed);
                setTyped("");
              }}
            >
              <label htmlFor="question" className="sr-only">اكتب سؤالك</label>
              <input id="question" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={300} placeholder="اكتب سؤالك هنا" className="field min-h-16 rounded-[1.25rem] pe-28" />
              <button type="submit" disabled={!typed.trim()} className="absolute inset-y-2 end-2 flex min-w-24 items-center justify-center gap-1.5 rounded-[0.9rem] bg-primary px-4 font-medium text-primary-ink transition-opacity disabled:opacity-40">
                <span>ابعث</span>
                <ForwardIcon size={20} />
              </button>
            </form>
            <div className="mt-3 grid gap-x-10 sm:grid-cols-2">
              {QUICK_QUESTIONS.map((q) => (
                <button key={q} type="button" onClick={() => void controller.ask(q)} className="row-button">
                  <span>{q}</span>
                  <ForwardIcon size={20} />
                </button>
              ))}
            </div>
          </section>

          <section aria-labelledby="seen-title" className="rise" style={{ "--at": "280ms" } as React.CSSProperties}>
            <h2 id="seen-title" className="text-[1.75rem] leading-tight font-semibold">شنوة يشوف توّة</h2>
            {!hasFindings ? (
              <p className="mt-3 text-lg text-ink-2">{cameraOn ? "مازال ما فمّا شي." : "شعّل الكاميرا باش يبدا يشوف."}</p>
            ) : (
              <div className="mt-4 flex flex-col gap-7">
                {s.environment && <p className="text-xl">البلاصة: <span className="font-medium">{s.environment.label}</span> <span className="text-base text-ink-2">({CONFIDENCE_LABEL[s.environment.confidence]})</span></p>}
                {s.localHazards.length > 0 && <Findings title="كشف الجهاز" testId="local-hazards" items={s.localHazards} />}
                {s.detections.length > 0 && <Findings title="التحليل السحابي" testId="detections" items={s.detections} />}
                {s.texts.length > 0 && (
                  <div>
                    <h3 className="text-base text-ink-2">الكتابة اللي بانت</h3>
                    <ul className="mt-1">
                      {s.texts.map((t, i) => (
                        <li key={i} dir="auto" className="border-b border-hairline py-2.5 text-lg">
                          {t.content} <span className="text-base text-ink-2">({CONFIDENCE_LABEL[t.confidence]})</span>
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

      <Sheet dialogRef={settingsRef} title="الإعدادات">
        <div className="flex flex-col gap-6 text-lg">
          <label className="flex flex-col gap-2">
            <span className="font-medium">سرعة الكلام</span>
            <span className="select"><select value={String(s.settings.rate)} onChange={(e) => controller.updateSettings({ rate: Number(e.target.value) })} className="field pe-12">
              {RATE_CHOICES.map((r) => <option key={r} value={r}>{r < 0.9 ? "بطيء" : r === 0.9 ? "عادي" : r === 1 ? "شوية أسرع" : "سريع"} ({r})</option>)}
            </select><ChevronIcon size={20} /></span>
          </label>
          <label className="flex flex-col gap-2">
            <span className="font-medium">وين تشوف الكاميرا؟</span>
            <span className="text-base text-ink-2">باش اليمين واليسار يكونو صحاح.</span>
            <span className="select"><select value={s.settings.facing} onChange={(e) => controller.updateSettings({ facing: e.target.value as FacingSetting })} className="field pe-12">
              <option value="auto">وحدها (الآن: {s.facing === "user" ? "تشوف فيّ" : "تشوف قدّامي"})</option>
              <option value="outward">تشوف قدّامي (تليفون، ولا كاميرا موجّهة لبرّا)</option>
              <option value="user">تشوف فيّ (كاميرا الحاسوب في وجهي)</option>
            </select><ChevronIcon size={20} /></span>
          </label>
          <label className="flex flex-col gap-2">
            <span className="font-medium">الألوان</span>
            <span className="select"><select value={theme} onChange={(e) => setTheme(e.target.value === "light" ? "light" : "dark")} className="field pe-12">
              <option value="dark">خلفية كحلة</option>
              <option value="light">خلفية بيضة</option>
            </select><ChevronIcon size={20} /></span>
          </label>
          <label className="flex min-h-14 items-center justify-between gap-4">
            <span>وصف أوتوماتيكي للي قدّامي <span className="block text-base text-ink-2">التنبيهات والأجوبة يبقاو خدّامين.</span></span>
            <input type="checkbox" role="switch" checked={s.settings.narration} onChange={(e) => controller.updateSettings({ narration: e.target.checked })} className="switch" />
          </label>
          <label className="flex min-h-14 items-center justify-between gap-4">
            <span>ابعث الكلام لقارئ الشاشة زادة</span>
            <input type="checkbox" role="switch" checked={s.settings.screenReaderEcho} onChange={(e) => controller.updateSettings({ screenReaderEcho: e.target.checked })} className="switch" />
          </label>
          {s.canSwitchCamera && cameraOn && (
            <button type="button" onClick={() => void controller.switchCamera()} className="control control-quiet min-h-16">بدّل الكاميرا</button>
          )}
          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">مفاتيح لوحة المفاتيح</h3>
            <ul className="mt-3 flex flex-col gap-2.5 text-base">
              {([["C", "شعّل ولا سكّر الكاميرا"], ["V", "شعّل ولا سكّر المساعد الصوتي"], ["Q", "اسأل بالصوت"], ["P", "وقّف ولا كمّل التحليل"], ["R", "عاود آخر جملة"], ["Esc", "اسكت"]] as const).map(([key, what]) => (
                <li key={key} className="flex items-center gap-3"><kbd dir="ltr">{key}</kbd><span>{what}</span></li>
              ))}
            </ul>
          </div>
          <div className="border-t border-hairline pt-6">
            <h3 className="font-medium">الأوامر بالصوت</h3>
            <p className="mt-2 text-base leading-loose">«اسكت»، «عاود»، «وقّف التحليل»، «كمّل»، «شعّل الكاميرا»، «سكّر الكاميرا»، «سكّر الميكرو».</p>
          </div>
        </div>
      </Sheet>

      <Sheet dialogRef={privacyRef} title="الخصوصية">
        <PrivacyText providers={providers} />
      </Sheet>

      <dialog ref={consentRef} onCancel={(e) => { e.preventDefault(); controller.declineConsent(); }} aria-labelledby="consent-title" className="modal m-auto w-[min(92vw,40rem)] rounded-[1.75rem] p-6 shadow-2xl sm:p-8">
        <Iris state="watching" className="size-16" />
        <h2 id="consent-title" className="mt-3 text-[1.75rem] leading-tight font-semibold">قبل ما نشعّل الكاميرا</h2>
        <PrivacyText providers={providers} />
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <button ref={acceptRef} type="button" onClick={() => controller.acceptConsent()} className="control control-primary min-h-[4.5rem]">موافق</button>
          <button type="button" onClick={() => controller.declineConsent()} className="control control-quiet min-h-[4.5rem]">موش موافق</button>
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
              <span className="text-lg font-medium">{item.label}</span>
              <span className="text-base text-ink-2">
                {"، "}
                {[SIDE_LABEL[item.side], PROXIMITY_LABEL[item.proximity], MOTION_LABEL[item.motion], item.action].filter(Boolean).join("، ")}
              </span>
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
          <h2 className="text-[1.75rem] leading-tight font-semibold">{title}</h2>
          <button type="button" onClick={close} className="ghost">
            <CloseIcon size={22} />
            <span>سكّر</span>
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
        `باش نوصفلك اللي قدّامك، صور من الكاميرا تتبعث لخدمة ذكاء اصطناعي خارجية: ${providers}.`,
        "التطبيق ما يسجّلش فيديو وما يخزّنش الصور.",
        "أما الخدمة الخارجية تنجم تحتفظ بيهم وتستعملهم حسب شروطها، خاصة في النسخة المجانية. ما توجّهش الكاميرا لأوراق شخصية ولا بطاقات بنكية، ورد بالك من صور الناس اللي حذاك.",
        "كي تسأل بالصوت، صوتك يتبعث لخدمة التعرّف على الكلام متاع المتصفح (Google في Chrome) ولا لنفس الخدمة الخارجية.",
        "كي تسكّر الكاميرا ولا تخرج من الصفحة، الكاميرا والميكرو يتسكّرو.",
      ].map((line) => (
        <li key={line} className="border-b border-hairline py-3 last:border-0">{line}</li>
      ))}
    </ul>
  );
}
