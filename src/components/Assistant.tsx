"use client";
// The whole app is this one screen, in the order a screen reader meets it: what the assistant just
// said, the main controls, questions, then details. Every action works by keyboard, screen reader or
// voice, and every state change is spoken, so nothing depends on seeing the screen.
import { useEffect, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { SmartVisionController, type AnalysisState, type CameraState, type MicState } from "@/lib/assistant/controller";
import { RATE_CHOICES, type FacingSetting } from "@/lib/assistant/settings";
import type { Confidence, Hazard, Motion, Proximity, Side } from "@/lib/assistant/types";

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
const SIDE_LABEL: Record<Side, string> = { left: "على اليسار", right: "على اليمين", center: "قدّام", unknown: "البلاصة موش واضحة" };
const PROXIMITY_LABEL: Record<Proximity, string> = { near: "قريب", mid: "موش بعيد", far: "بعيد", unknown: "" };
const CONFIDENCE_LABEL: Record<Confidence, string> = { confirmed: "مؤكّد", likely: "محتمل", uncertain: "موش متأكّد" };
const MOTION_LABEL: Record<Motion, string> = { approaching: "يقرّب", moving_away: "يبعد", crossing: "يتعدّى", stationary: "", unknown: "" };

const describe = (item: { label: string; side: Side; proximity: Proximity; confidence: Confidence; motion: Motion }) =>
  [item.label, SIDE_LABEL[item.side], PROXIMITY_LABEL[item.proximity], MOTION_LABEL[item.motion], `(${CONFIDENCE_LABEL[item.confidence]})`].filter(Boolean).join("، ");

const HUGE = "min-h-28 w-full rounded-3xl px-4 py-4 text-3xl font-extrabold transition active:scale-[0.98] sm:text-4xl";
const BIG = "min-h-20 rounded-2xl px-4 py-3 text-xl font-bold transition active:scale-[0.98] sm:text-2xl";
const MEDIUM = "min-h-16 rounded-2xl px-4 py-2 text-lg font-bold";
const ON = "bg-accent text-accent-ink";
const STOP = "bg-danger text-danger-ink border-4 border-danger-ink";
const PLAIN = "border-[3px] border-edge bg-bg text-ink";
const PANEL = "rounded-3xl border-2 border-edge bg-panel p-4 sm:p-5";
const FIELD = "min-h-14 rounded-xl border-[3px] border-edge bg-bg px-3 text-lg text-ink";

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [theme, setTheme] = useTheme();

  useEffect(() => {
    if (videoRef.current) controller.attach(videoRef.current);
    startRef.current?.focus({ preventScroll: true });
    return () => controller.detach();
  }, [controller]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (s.needsConsent && !dialog.open) {
      dialog.showModal();
      acceptRef.current?.focus();
    } else if (!s.needsConsent && dialog.open) {
      dialog.close();
    }
  }, [s.needsConsent]);

  const cameraOn = s.camera === "on";
  const paused = s.analysis === "paused";
  const consentOpen = s.needsConsent;

  // Physical key positions, so these work with an Arabic keyboard layout too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || consentOpen) return;
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
  }, [controller, consentOpen]);

  const echo = s.settings.screenReaderEcho || s.ttsFailed;
  const providers = s.status?.providers.map((p) => p.label).join("، ") || "خدمة ذكاء اصطناعي خارجية";
  const voiceText = s.voice
    ? `${s.voice.name}${s.voice.exactDialect ? " (تونسي)" : " (عربي، موش تونسي)"}`
    : s.ttsFailed
      ? "الصوت ما يخدمش، النص يتبعث لقارئ الشاشة"
      : "نلوّج على صوت عربي…";
  const local = s.localHazards;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5 px-4 py-5">
      <header>
        <h1 className="text-4xl font-extrabold">بصيرة</h1>
        <p className="mt-1 text-lg text-soft">مساعد البصر: الكاميرا توصفلك اللي قدّامك، واسألها بصوتك.</p>
      </header>

      <main className="flex flex-col gap-5">
        {/* Screen-reader channel. Silent unless asked for, or the page's own voice has failed. */}
        <div aria-live={echo && !s.announce.urgent ? "polite" : "off"} className="sr-only">{echo && !s.announce.urgent ? s.announce.text : ""}</div>
        <div role={echo && s.announce.urgent ? "alert" : undefined} className="sr-only">{echo && s.announce.urgent ? s.announce.text : ""}</div>

        <section aria-labelledby="said-title" className={s.lastUrgent ? "rounded-3xl border-4 border-danger-ink bg-danger p-4 text-danger-ink sm:p-5" : PANEL}>
          <h2 id="said-title" className={`text-base font-semibold ${s.lastUrgent ? "" : "text-soft"}`}>آخر حاجة قالها المساعد</h2>
          <p data-testid="last-spoken" data-urgent={s.lastUrgent} className="mt-2 min-h-20 text-3xl font-bold leading-relaxed">
            {s.lastSpoken || "اضغط على «شعّل الكاميرا» باش نبداو."}
          </p>
          {s.lastHeard && <p className="mt-2 text-lg">سمعت منك: «{s.lastHeard}»</p>}
        </section>

        {s.cameraError && <p role="alert" className="rounded-2xl bg-danger p-4 text-xl font-semibold text-danger-ink">{s.cameraError}</p>}

        <div className="flex flex-col gap-3">
          {cameraOn || s.camera === "starting" ? (
            <button ref={startRef} type="button" onClick={() => controller.stopCamera()} aria-keyshortcuts="C" className={`${HUGE} ${STOP}`}>سكّر الكاميرا</button>
          ) : (
            <button ref={startRef} type="button" onClick={() => void controller.startCamera()} aria-keyshortcuts="C" className={`${HUGE} ${ON}`}>شعّل الكاميرا</button>
          )}
          <button type="button" onClick={() => controller.toggleAssistant()} aria-pressed={s.assistantOn} aria-keyshortcuts="V" className={`${HUGE} ${s.assistantOn ? STOP : ON}`}>
            {s.assistantOn ? "سكّر المساعد الصوتي" : "شعّل المساعد الصوتي"}
          </button>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <button type="button" onClick={() => void controller.askByVoice()} aria-keyshortcuts="Q" className={`${BIG} ${PLAIN} ${s.mic === "listening" ? "is-active" : ""}`}>
              {s.mic === "listening" && !s.assistantOn ? "كمّلت، ابعث السؤال" : "اسأل بالصوت"}
            </button>
            <button type="button" onClick={() => controller.stopSpeech()} aria-keyshortcuts="Escape" className={`${BIG} ${PLAIN} ${s.speaking ? "is-active" : ""}`}>اسكت</button>
            {cameraOn && (
              <button type="button" onClick={() => (paused ? controller.resume() : controller.pause())} aria-pressed={paused} aria-keyshortcuts="P" className={`${BIG} ${PLAIN}`}>
                {paused ? "كمّل التحليل" : "وقّف التحليل"}
              </button>
            )}
            <button type="button" onClick={() => controller.repeat()} aria-keyshortcuts="R" className={`${BIG} ${PLAIN}`}>عاود آخر جملة</button>
          </div>
        </div>

        <p className="rounded-2xl border-[3px] border-accent bg-bg p-4 text-lg font-medium">
          المساعد هذا يعاونك برك، وما يعوّضش العصا ولا الكلب المرشد. ينجم يغلط، والتنبيه ينجم يتأخّر بثواني. كي ما يقول شي، موش معناها الطريق آمن.
        </p>

        <section aria-labelledby="ask-title" className={PANEL}>
          <h2 id="ask-title" className="mb-3 text-2xl font-bold">اسأل</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {QUICK_QUESTIONS.map((q) => (
              <button key={q} type="button" onClick={() => void controller.ask(q)} className={`${MEDIUM} ${PLAIN}`}>{q}</button>
            ))}
          </div>
          <form
            className="mt-3 flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void controller.ask(typed);
              setTyped("");
            }}
          >
            <label htmlFor="question" className="sr-only">اكتب سؤالك</label>
            <input id="question" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={300} placeholder="ولا اكتب سؤالك هنا" className={`${FIELD} min-w-0 flex-1 placeholder:text-soft`} />
            <button type="submit" disabled={!typed.trim()} className={`${MEDIUM} px-8 ${ON} disabled:opacity-50`}>ابعث</button>
          </form>
        </section>

        <section aria-labelledby="status-title" className={PANEL}>
          <h2 id="status-title" className="mb-3 text-2xl font-bold">الحالة</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xl">
            <dt className="font-bold">الكاميرا:</dt>
            <dd data-testid="camera-status">{CAMERA_LABEL[s.camera]}</dd>
            <dt className="font-bold">الميكرو:</dt>
            <dd data-testid="mic-status">{s.assistantOn && s.mic === "off" ? "يستنّى" : MIC_LABEL[s.mic]}</dd>
            <dt className="font-bold">التحليل:</dt>
            <dd data-testid="analysis-status">{ANALYSIS_LABEL[s.analysis]}{s.lastLatencyMs != null && cameraOn ? ` (آخر صورة: ${(s.lastLatencyMs / 1000).toFixed(1)} ث)` : ""}</dd>
            <dt className="font-bold">الصوت:</dt>
            <dd data-testid="voice-status" className="break-words">{voiceText}</dd>
            {cameraOn && (
              <>
                <dt className="font-bold">الكشف في الجهاز:</dt>
                <dd>{s.detector === "ready" ? "خدّام" : s.detector === "loading" ? "يتحمّل…" : s.detector === "failed" ? "ما خدمش، يبقى التحليل السحابي برك" : "واقف"}</dd>
              </>
            )}
            {s.status && !s.status.available && (
              <>
                <dt className="font-bold">الخدمة:</dt>
                <dd>مفتاح الذكاء الاصطناعي موش مضبوط على الخادم.</dd>
              </>
            )}
          </dl>
        </section>

        <section aria-labelledby="seen-title" className={PANEL}>
          <h2 id="seen-title" className="mb-3 text-2xl font-bold">شنوة يشوف توّة</h2>
          <video ref={videoRef} muted playsInline aria-label="المعاينة الحيّة متاع الكاميرا" className={`mb-3 max-h-64 w-full rounded-2xl bg-black object-contain ${cameraOn ? "" : "hidden"}`} />
          {!cameraOn && <p className="text-lg text-soft">الكاميرا مطفية، وما تتبعث حتى صورة.</p>}
          <div className="flex flex-col gap-3 text-xl">
            {s.environment && <p>البلاصة: {s.environment.label} ({CONFIDENCE_LABEL[s.environment.confidence]})</p>}
            {local.length > 0 && (
              <div>
                <h3 className="font-bold">كشف الجهاز:</h3>
                <ul className="list-inside list-disc" data-testid="local-hazards">{local.map((h: Hazard, i) => <li key={i}>{describe(h)}</li>)}</ul>
              </div>
            )}
            {s.detections.length > 0 && (
              <div>
                <h3 className="font-bold">التحليل السحابي:</h3>
                <ul className="list-inside list-disc" data-testid="detections">{s.detections.map((d, i) => <li key={i}>{describe(d)}{d.action ? `، ${d.action}` : ""}</li>)}</ul>
              </div>
            )}
            {s.texts.length > 0 && (
              <div>
                <h3 className="font-bold">الكتابة اللي بانت:</h3>
                <ul className="list-inside list-disc">{s.texts.map((t, i) => <li key={i} dir="auto">{t.content} ({CONFIDENCE_LABEL[t.confidence]})</li>)}</ul>
              </div>
            )}
          </div>
        </section>

        <details className={PANEL}>
          <summary className="min-h-12 cursor-pointer text-2xl font-bold">الإعدادات والمفاتيح</summary>
          <div className="mt-4 flex flex-col gap-5 text-xl">
            <label className="flex flex-col gap-1">
              <span className="font-bold">سرعة الكلام</span>
              <select value={String(s.settings.rate)} onChange={(e) => controller.updateSettings({ rate: Number(e.target.value) })} className={FIELD}>
                {RATE_CHOICES.map((r) => <option key={r} value={r}>{r < 0.9 ? "بطيء" : r === 0.9 ? "عادي" : r === 1 ? "شوية أسرع" : "سريع"} ({r})</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-bold">وين تشوف الكاميرا؟ (باش اليمين واليسار يكونو صحاح)</span>
              <select value={s.settings.facing} onChange={(e) => controller.updateSettings({ facing: e.target.value as FacingSetting })} className={FIELD}>
                <option value="auto">وحدها (الآن: {s.facing === "user" ? "تشوف فيّ" : "تشوف قدّامي"})</option>
                <option value="outward">تشوف قدّامي (تليفون، ولا كاميرا موجّهة لبرّا)</option>
                <option value="user">تشوف فيّ (كاميرا الحاسوب في وجهي)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-bold">الألوان</span>
              <select value={theme} onChange={(e) => setTheme(e.target.value === "light" ? "light" : "dark")} className={FIELD}>
                <option value="dark">خلفية كحلة</option>
                <option value="light">خلفية بيضة</option>
              </select>
            </label>
            <label className="flex min-h-12 items-center gap-3">
              <input type="checkbox" checked={s.settings.narration} onChange={(e) => controller.updateSettings({ narration: e.target.checked })} className="size-7 shrink-0" />
              وصف أوتوماتيكي للي قدّامي (التنبيهات والأجوبة يبقاو خدّامين)
            </label>
            <label className="flex min-h-12 items-center gap-3">
              <input type="checkbox" checked={s.settings.screenReaderEcho} onChange={(e) => controller.updateSettings({ screenReaderEcho: e.target.checked })} className="size-7 shrink-0" />
              ابعث الكلام لقارئ الشاشة زادة
            </label>
            {s.canSwitchCamera && cameraOn && (
              <button type="button" onClick={() => void controller.switchCamera()} className={`${MEDIUM} ${PLAIN}`}>بدّل الكاميرا</button>
            )}
            <div>
              <h3 className="font-bold">مفاتيح لوحة المفاتيح</h3>
              <ul className="list-inside list-disc">
                <li>C: شعّل ولا سكّر الكاميرا</li>
                <li>V: شعّل ولا سكّر المساعد الصوتي</li>
                <li>Q: اسأل بالصوت</li>
                <li>P: وقّف ولا كمّل التحليل</li>
                <li>R: عاود آخر جملة</li>
                <li>Esc: اسكت</li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold">الأوامر بالصوت</h3>
              <p>«اسكت»، «عاود»، «وقّف التحليل»، «كمّل»، «شعّل الكاميرا»، «سكّر الكاميرا»، «سكّر الميكرو».</p>
            </div>
          </div>
        </details>

        <details className={PANEL}>
          <summary className="min-h-12 cursor-pointer text-2xl font-bold">الخصوصية</summary>
          <PrivacyText providers={providers} />
        </details>
      </main>

      <dialog ref={dialogRef} onCancel={(e) => { e.preventDefault(); controller.declineConsent(); }} aria-labelledby="consent-title" className="m-auto w-[min(92vw,38rem)] rounded-3xl border-4 border-edge bg-bg p-5 text-ink backdrop:bg-black/80">
        <h2 id="consent-title" className="mb-3 text-3xl font-bold">قبل ما نشعّل الكاميرا</h2>
        <PrivacyText providers={providers} />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <button ref={acceptRef} type="button" onClick={() => controller.acceptConsent()} className={`${BIG} ${ON}`}>موافق</button>
          <button type="button" onClick={() => controller.declineConsent()} className={`${BIG} ${PLAIN}`}>موش موافق</button>
        </div>
      </dialog>
    </div>
  );
}

function PrivacyText({ providers }: { providers: string }) {
  return (
    <ul className="mt-2 flex list-inside list-disc flex-col gap-2 text-xl">
      <li>باش نوصفلك اللي قدّامك، صور من الكاميرا تتبعث لخدمة ذكاء اصطناعي خارجية: {providers}.</li>
      <li>التطبيق ما يسجّلش فيديو وما يخزّنش الصور.</li>
      <li>أما الخدمة الخارجية تنجم تحتفظ بيهم وتستعملهم حسب شروطها، خاصة في النسخة المجانية. ما توجّهش الكاميرا لأوراق شخصية ولا بطاقات بنكية، ورد بالك من صور الناس اللي حذاك.</li>
      <li>كي تسأل بالصوت، صوتك يتبعث لخدمة التعرّف على الكلام متاع المتصفح (Google في Chrome) ولا لنفس الخدمة الخارجية.</li>
      <li>كي تسكّر الكاميرا ولا تخرج من الصفحة، الكاميرا والميكرو يتسكّرو.</li>
    </ul>
  );
}
