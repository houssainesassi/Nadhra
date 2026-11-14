// Runs the assistant: camera, frame selection, cloud analysis, on-device warnings, speech and voice
// input. It has no React in it; components read its store and call its methods.
import { createStore } from "../store.ts";
import { HybridTts, type TtsEngine, type VoiceInfo } from "../speech/tts.ts";
import { FrameBudget } from "../camera/frameBudget.ts";
import { CameraError } from "../camera/camera.ts";
import { analyzeFrame, askStreaming, fetchVisionStatus, transcribeWav, VisionApiError } from "./client.ts";
import { parseCommand, type VoiceCommand } from "./commands.ts";
import { createCameraSource, type CameraSource, type CapturedFrame } from "./cameraSource.ts";
import { Earcons, type Earcon } from "./earcons.ts";
import { changedFraction, classifyQuality, frameStats, QUALITY_LIMITS, READ_BLUR_LIMIT, rgbaToGray, sharpestTile, type LocalQuality } from "./frameAnalysis.ts";
import { documentContext, isMedicalQuestion, isReadRequest, MAX_CONTEXT_LINES, mentionsDose, readAllSegments } from "./document.ts";
import { HazardTracker } from "./hazardTracker.ts";
import { hazardKey, hazardUrgency, WarningGate } from "./hazards.ts";
import { LocalDetector } from "./localDetector.ts";
import { cameraErrorText, PHRASES, speech, warningPhrase, type Phrases } from "./phrases.ts";
import { LANGS, questionLang, type SpeechLang } from "./lang.ts";
import { backoffMs, decideScan } from "./scheduler.ts";
import { flushReports, report, setLocalOnly } from "./api.ts";
import { isSafetyClaim, splitSentences } from "./schema.ts";
import { DEFAULT_VISION_SETTINGS, hasConsent, providerOf, type AiProvider, hasLiveConsent, hasReadConsent, loadVisionSettings, RATE_CHOICES, saveVisionSettings, setConsent, setLiveConsent, setReadConsent, VOLUME_CHOICES, type VisionSettings } from "./settings.ts";
import { isRepeat, SpeechQueue, type SpeechPriority } from "./speechQueue.ts";
import type { CameraFacing, Detection, DocumentReading, Hazard, SceneAnalysis, SceneText, SpeechSegment, VisionMode, VisionStatus } from "./types.ts";
import { RecognitionInput, RecorderInput, recognitionSupported, recordingSupported, VoiceError, type VoiceInput } from "./voiceInput.ts";
import { LiveSession, type LiveStatus } from "../live/session.ts";
import { LiveAudio, MicError } from "../live/audioIO.ts";
import { LIVE_CHANGE_THRESHOLD, LIVE_FRAME, LIVE_HEARTBEAT_FRAME_MS, LIVE_MIN_FRAME_GAP_MS, LIVE_SPEECH_FRAME_GAP_MS } from "../live/config.ts";

const TICK_MS = 500;
const THUMB = { width: 160, height: 120 };
const SCAN_FRAME = { maxSide: 768, quality: 0.7 };
const QUESTION_FRAME = { maxSide: 1280, quality: 0.82 }; // small print stays readable
const MOTION_FRAME = { maxSide: 384, quality: 0.5 };
/** Reading: a still photo when the phone can take one, so small print on a box stays readable. */
const READ_FRAME = { maxSide: 1920, quality: 0.85 };
/** The size of the on-device sharpness check before reading (see READ_BLUR_LIMIT). */
const READ_CHECK = { width: 640, height: 480 };
/** How long to wait for a steady, sharp frame before saying "hold still". */
const READ_STEADY_WAIT_MS = 2_500;
/** Questions within this time of a reading are about that document (and say so if they're not). */
const DOCUMENT_TTL_MS = 5 * 60_000;
/** The second frame for the independent second reading is taken this long after the first. */
const SECOND_FRAME_DELAY_MS = 400;
/**
 * While a document is in front of the camera, automatic frames (scans, live) stop. They start again
 * when the view has changed this much from it, on two ticks in a row: the paper was put away.
 */
const DOCUMENT_AWAY_CHANGE = 0.5;
/** While a live conversation runs, the user is reminded this often that it is sending to Google. */
const LIVE_REMINDER_MS = 5 * 60_000;
/** Moving camera with automatic descriptions off: reminded that stairs and holes aren't seen, at most this often… */
const WALKING_REMINDER_MS = 3 * 60_000;
/** …after the camera has kept moving this long. */
const WALKING_AFTER_MS = 4_000;
/** "What's in front of me?" answers carry the no-guarantee sentence at most this often. */
const FRONT_CAVEAT_MS = 5 * 60_000;
const MOTION_FRAME_EVERY_MS = 1_000;
/** A warning based on an older frame than this is no longer about "now". */
const MAX_RESULT_AGE_MS = 12_000;
const CAMERA_MOVING_FRACTION = 0.35;
const QUALITY_ANNOUNCE_AFTER_MS = 2_000;
const FAILURES_BEFORE_ANNOUNCE = 2;
const ALIVE_AFTER_SILENCE_MS = 45_000;
const RECENT_SPOKEN = 4;
const DISCLAIMER_LATEST_MS = 20_000;
/**
 * During a live conversation the cloud scans keep running for their hazards only (stairs, drops,
 * obstacles the on-device detector can't see), at a slower pace: the conversation itself already
 * describes the scene, and each scan costs quota.
 */
const LIVE_HAZARD_SCAN_MS = 8_000;
/** A spent daily budget doesn't come back soon: scans wait this long before trying again. */
const QUOTA_BACKOFF_MS = 15 * 60_000;

export type CameraState = "off" | "starting" | "on" | "error";
/**
 * "manual": automatic descriptions are off, so pictures go out only when the user asks.
 * "local": Nadhra AI is selected: no picture goes anywhere, only the on-device warnings run.
 */
export type AnalysisState = "off" | "watching" | "manual" | "local" | "analyzing" | "paused" | "unavailable" | "poor-image" | "hidden";
export type MicState = "off" | "listening" | "processing" | "denied" | "unavailable";
export type DetectorState = "off" | "loading" | "ready" | "failed";
/** The panels over the main screen. The controller owns this so voice can open and close them. */
export type SheetName = "none" | "settings" | "privacy" | "emergency";
/** Something the user asked for that runs once the camera is on. */
export type Task = "front" | "describe" | "read" | "identify";
export type LocationState = { status: "idle" | "pending" | "failed" } | { status: "ready"; lat: number; lng: number; accuracy: number };

/** Vibration patterns, in ms. Short and distinct, so they can be told apart by touch. */
const HAPTICS: Partial<Record<Earcon, number[]>> = {
  on: [40],
  off: [40, 80, 40],
  listen: [25],
  urgent: [200, 100, 200, 100, 200],
  error: [120, 80, 120],
};
const CAMERA_READY_WAIT_MS = 4_000;
/** Phone cameras adjust exposure and focus for a moment after starting: the first frames are often dark or blurred. */
const CAMERA_SETTLE_MS = 800;
/** A detector that hasn't loaded by then is treated as failed: the user must not believe it runs. */
const DETECTOR_LOAD_TIMEOUT_MS = 20_000;
const LOCATION_TIMEOUT_MS = 15_000;

export interface VisionState {
  camera: CameraState;
  /** A camera error code ("denied", "lost", …), or "". */
  cameraError: string;
  analysis: AnalysisState;
  mic: MicState;
  assistantOn: boolean;
  speaking: boolean;
  needsConsent: boolean;
  /** Consent to send camera images has been given (and not withdrawn). */
  consentGiven: boolean;
  lastSpoken: string;
  lastUrgent: boolean;
  lastHeard: string;
  /** For screen readers, when the page's own voice is off or failing. */
  announce: { text: string; urgent: boolean; id: number };
  environment: SceneAnalysis["environment"];
  detections: Detection[];
  texts: SceneText[];
  /** What the on-device detector believes right now. */
  localHazards: Hazard[];
  detector: DetectorState;
  voice: VoiceInfo | null;
  ttsFailed: boolean;
  status: VisionStatus | null;
  settings: VisionSettings;
  facing: CameraFacing;
  canSwitchCamera: boolean;
  lastLatencyMs: number | null;
  scansSent: number;
  sheet: SheetName;
  /** Asks the screen to move focus. The id changes on every request. */
  focus: { target: "call" | "none"; id: number };
  location: LocationState;
  online: boolean;
  /** The latest answer as it arrives, for the screen. `live` while it is still coming. */
  answer: { text: string; live: boolean; web: boolean; lang?: SpeechLang };
  /** Live conversation: microphone and camera stream to the model, which answers by voice. */
  live: LiveState;
  /** The notice about the live conversation was said and waits for «موافق» or a second press. */
  liveNotice: boolean;
}

export interface LiveState {
  status: "off" | LiveStatus;
  /** What the user last said, as recognized. */
  user: string;
  /** What the assistant is saying or last said. */
  ai: string;
  /** The assistant's voice is playing. */
  playing: boolean;
  /** The user is talking (by the on-device level detector). */
  userTalking: boolean;
  /** End of the user's speech to the first sound of the answer, for the last answer. */
  latencyMs: number | null;
  model: string;
  voice: string;
  framesSent: number;
}

const LIVE_OFF: LiveState = { status: "off", user: "", ai: "", playing: false, userTalking: false, latencyMs: null, model: "", voice: "", framesSent: 0 };

const INITIAL: VisionState = {
  liveNotice: false,
  camera: "off",
  cameraError: "",
  analysis: "off",
  mic: "off",
  assistantOn: false,
  speaking: false,
  needsConsent: false,
  consentGiven: false,
  lastSpoken: "",
  lastUrgent: false,
  lastHeard: "",
  announce: { text: "", urgent: false, id: 0 },
  environment: null,
  detections: [],
  texts: [],
  localHazards: [],
  detector: "off",
  voice: null,
  ttsFailed: false,
  status: null,
  settings: DEFAULT_VISION_SETTINGS,
  facing: "user",
  canSwitchCamera: false,
  lastLatencyMs: null,
  scansSent: 0,
  sheet: "none",
  focus: { target: "none", id: 0 },
  location: { status: "idle" },
  online: true,
  answer: { text: "", live: false, web: false },
  live: LIVE_OFF,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** "One moment" in every language: never counted as a description. */
const WAITING = new Set(Object.values(PHRASES).flatMap((p) => [p.thinking, p.thinkingNoCamera]));
const isTouchDevice = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches && (navigator.maxTouchPoints ?? 0) > 0;

export class SmartVisionController {
  readonly store = createStore<VisionState>(INITIAL);

  private video: HTMLVideoElement | null = null;
  private source: CameraSource | null = null;
  private tts: TtsEngine | null = null;
  private queue: SpeechQueue | null = null;
  private earcons = new Earcons();
  private detector = new LocalDetector();
  private tracker = new HazardTracker();
  private gate = new WarningGate();
  private budget = new FrameBudget(0.2, 3_000);

  private cleanups: (() => void)[] = [];
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private detectTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeLock: { release(): Promise<void> } | null = null;
  private session = 0; // bumped on every camera stop, so late results from the old session are ignored

  private paused = false;
  private scanCtrl: AbortController | null = null;
  private questionCtrl: AbortController | null = null;
  private lastScanAt = -Infinity;
  private lastScanGray: Uint8Array | null = null;
  private lastGray: Uint8Array | null = null;
  private motion = 0;
  private unchangedStreak = 0;
  private newObject = false;
  private blurSince: number | null = null;
  private poorQuality: { kind: LocalQuality; since: number; announced: boolean } | null = null;
  private motionFrames: CapturedFrame[] = [];
  private failures = 0;
  private downAnnounced = false;
  private backoffUntil = 0;
  private lastSoundAt = 0;

  private recent: string[] = [];
  private history: { q: string; a: string }[] = [];
  /** The language of the last answer: a follow-up too short to tell («OK», «w ba3d?») keeps it. */
  private lastAnswerLang: SpeechLang | undefined;
  private voiceInput: VoiceInput | null = null;
  private forceRecorder = false;
  private listening = false;
  private userTalking = false;
  private loopGen = 0;
  private spokeDisclaimer = false;
  private disclaimerDueAt = Infinity;
  /** The user pressed Ask: routine speech waits until they have finished. */
  private pushToTalkOpen = false;
  /** Asked for while the camera was off: runs once it is on. */
  private pendingTask: Task | null = null;
  /** The last document read, kept in this page's memory only, for follow-up questions and "read all". */
  private document: { reading: DocumentReading; at: number } | null = null;
  /** Shortened by tests. */
  private readSteadyWaitMs = READ_STEADY_WAIT_MS;
  /** The notice that automatic descriptions are off was said in this visit. */
  private autoNoticeSaid = false;
  /** The notice about what Nadhra AI can do with the camera was said in this visit. */
  private nadhraNoticeSaid = false;
  private cameraStarts = 0;
  private lastLiveReminderAt = 0;
  private movingSince: number | null = null;
  private lastWalkingReminderAt = -Infinity;
  private lastFrontCaveatAt = -Infinity;
  /** A reading waiting for the spoken notice about documents to be accepted («موافق»). */
  private pendingRead: { question?: string } | null = null;
  /** A document is in front of the camera: no automatic frame is sent until the view changes (see DOCUMENT_AWAY_CHANGE). */
  private docHold: { gray: Uint8Array | null; away: number } | null = null;
  private locationWatch = 0;
  /** The camera was released because the page was hidden: it comes back when the user does. */
  private resumeOnReturn = false;
  private liveSession: LiveSession | null = null;
  private liveAudio: LiveAudio | null = null;
  private liveGen = 0;
  private lastLiveFrameAt = -Infinity;
  private lastLiveGray: Uint8Array | null = null;
  /** The next recognized words start a new user turn / a new answer on screen. */
  private liveNewUserTurn = true;
  private liveNewAnswer = true;
  /** Consent was asked for on the way to a live conversation: it starts once given. */
  private pendingLive = false;
  /** Open Camera was pressed: hands-free listening starts once the camera is on (after consent, if asked). */
  private pendingVoice = false;
  /** How much of the live answer was already checked for safety promises. */
  private liveCheckedChars = 0;
  /** The rest of this live answer is not played: it promised safety and was corrected. */
  private liveMuted = false;
  /** The user's last live turn was already checked for an emergency command. */
  private liveCommandChecked = false;
  /** Replaceable in tests. */
  protected makeSource: (video: HTMLVideoElement) => CameraSource = (video) => createCameraSource("webcam", video);
  protected detectorLoadTimeoutMs = DETECTOR_LOAD_TIMEOUT_MS;

  get state() {
    return this.store.get();
  }

  private patch(p: Partial<VisionState>) {
    this.store.set({ ...this.state, ...p });
  }

  private get lang(): SpeechLang {
    return this.state.settings.language;
  }

  /** What the assistant says, in the current speech language. */
  private get t(): Phrases {
    return speech(this.lang);
  }

  /** Nadhra AI is selected: nothing may leave the device, and features it can't do yet are refused. */
  private get nadhra(): boolean {
    return providerOf(this.state.settings) === "nadhra";
  }

  /** Nadhra AI can't do this yet: said out loud, with how to get it. Nothing is sent, nor handed to Gemini. */
  private refuseNadhra(lang: SpeechLang = this.lang) {
    const t = speech(lang);
    this.feedback("error");
    this.queue?.stop();
    this.liveAudio?.flush();
    this.say(`${t.nadhra.unavailable} ${t.nadhra.needsGemini}`, "answer", lang);
  }

  /** Puts the page's network guard and the voice in line with the chosen AI. */
  private applyProvider(provider: AiProvider) {
    const local = provider === "nadhra";
    setLocalOnly(local);
    this.tts?.setLocalOnly?.(local);
    this.patch({ voice: this.tts?.voiceInfo() ?? null });
  }

  /** Offline: only claims that on-device warnings work when the detector is actually running. */
  private get offlineText(): string {
    return this.state.detector === "ready" ? this.t.offline : this.t.analysisDown;
  }

  /** Why a question or reading failed, in words. offline-mode / no-internet come from the server's AI_MODE routing. */
  private failureText(err: VisionApiError | null, t: Phrases): string {
    const detectorOn = this.state.detector === "ready";
    switch (err?.code) {
      case "offline-mode":
        return t.offlineMode;
      case "no-internet":
        return detectorOn ? t.offline : t.analysisDown;
      case "not-configured":
        return t.aiNotConfigured;
      case "quota-exhausted":
        return t.quotaExhausted;
      case "nadhra-unavailable":
        return `${t.nadhra.unavailable} ${t.nadhra.needsGemini}`;
    }
    return err?.status === 429 || err?.code === "rate-limited" ? t.rateLimited : t.questionFailed;
  }

  /** A tone, and a vibration where the device has one and the user hasn't turned it off. */
  private feedback(name: Earcon) {
    this.earcons.play(name, this.state.settings.volume);
    const pattern = HAPTICS[name];
    if (!pattern || !this.state.settings.vibration) return;
    try {
      navigator.vibrate?.(pattern);
    } catch {}
  }

  /** `deps.tts` replaces the voice, for tests. */
  attach(video: HTMLVideoElement, deps: { tts?: TtsEngine } = {}) {
    this.video = video;
    const refreshVoice = () => this.patch({ voice: this.tts?.voiceInfo() ?? null });
    this.tts = deps.tts ?? new HybridTts(refreshVoice);
    this.queue = new SpeechQueue(this.tts, {
      rate: () => this.state.settings.rate,
      lang: () => this.lang,
      volume: () => this.state.settings.volume,
      onSpeakingChange: (speaking) => {
        if (speaking) this.lastSoundAt = Date.now();
        this.patch({ speaking });
        // So an open microphone doesn't hear the assistant. While the user is talking it stays open.
        // After Ask, only an urgent warning can get here (see listenOnce), and that takes priority.
        if (speaking && this.listening && !this.userTalking) this.voiceInput?.abort();
        // A warning cuts the live answer off. The live microphone stays open: echo cancellation
        // keeps this voice out of it, and muting it would lose what the user says meanwhile.
        if (speaking && this.liveAudio && this.queue?.hasAtLeast("warning")) this.liveAudio.flush();
      },
      onUtterance: (text, priority) => {
        const urgent = priority === "urgent";
        // Counts as said only once it actually plays: a dropped description may be given again.
        if (priority === "narration" && !WAITING.has(text)) {
          this.recent = [...this.recent, text].slice(-RECENT_SPOKEN);
          this.sayDisclaimerOnce(); // right after the first description
        }
        this.patch({ lastSpoken: text, lastUrgent: urgent, announce: { text, urgent, id: this.state.announce.id + 1 } });
      },
      onFailure: (text) => {
        // The voice failed, so the screen reader takes over this sentence and the following ones.
        if (!this.state.ttsFailed) report("tts-failed");
        this.feedback("error");
        this.patch({ ttsFailed: true, announce: { text, urgent: false, id: this.state.announce.id + 1 } });
      },
      // A warning that was never heard mustn't be held back as "already said": the next detection
      // of the same hazard says it again, if it is still there.
      onDropped: (key) => {
        this.gate.forget(key);
        report("warning-expired");
      },
    });
    const settings = loadVisionSettings();
    this.tts.setLanguage?.(settings.language);
    this.patch({ settings, voice: this.tts.voiceInfo(), online: navigator.onLine !== false, consentGiven: hasConsent() });
    // Before anything can be sent: Nadhra AI chosen on an earlier visit closes the network at once.
    this.applyProvider(providerOf(settings));
    void fetchVisionStatus().then((status) => this.patch({ status }));

    // A lost connection stops the cloud analysis: the user must know, and frames aren't sent for nothing.
    const onOffline = () => {
      if (!this.state.online) return;
      this.patch({ online: false });
      if (this.state.camera === "on") {
        this.scanCtrl?.abort();
        this.feedback("error");
        this.say(this.offlineText, "answer");
      }
    };
    const onOnline = () => {
      if (this.state.online) return;
      this.patch({ online: true });
      this.failures = 0;
      this.backoffUntil = 0;
      this.downAnnounced = false;
      void fetchVisionStatus().then((status) => status && this.patch({ status }));
      if (this.state.camera === "on") {
        this.feedback("on");
        this.say(this.t.online, "status");
      }
    };
    addEventListener("offline", onOffline);
    addEventListener("online", onOnline);
    this.cleanups.push(() => {
      removeEventListener("offline", onOffline);
      removeEventListener("online", onOnline);
    });

    const onHide = () => {
      this.shutdown();
      flushReports();
    };
    // Switching apps, changing tabs or locking the phone hides the page. The camera and microphone
    // are released then, not only when the page closes, and the camera comes back with the user.
    const onVisibility = () => (document.hidden ? this.leaveWhileHidden() : this.returnFromHidden());
    addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    this.cleanups.push(() => {
      removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    });
  }

  /** The page is going away: the camera and microphone must be released. */
  detach() {
    this.shutdown();
    for (const fn of this.cleanups.splice(0)) fn();
    this.queue = null;
    this.tts?.dispose?.();
    this.tts = null;
    this.earcons.close();
    this.detector.close();
    this.video = null;
    this.store.set(INITIAL);
  }

  private leaveWhileHidden() {
    // The microphone mustn't keep streaming from the background.
    if (this.liveSession) this.stopLive(true);
    if (this.state.camera === "on" || this.state.camera === "starting") {
      this.resumeOnReturn = true;
      this.releaseCamera();
    }
    // An open microphone in the background would keep listening. Hands-free mode stays on and
    // starts listening again once the page is visible.
    if (this.listening) this.voiceInput?.abort();
    // Nothing can be watched while away: speech shouldn't carry on over another app either.
    this.queue?.stop();
  }

  private returnFromHidden() {
    if (!this.resumeOnReturn) return;
    this.resumeOnReturn = false;
    if (this.state.camera !== "off") return;
    this.say(this.t.wasAway, "status");
    void this.startCamera();
  }

  private shutdown() {
    this.resumeOnReturn = false;
    if (this.liveSession) this.stopLive(true);
    this.stopLocation();
    this.stopAssistantLoop();
    this.releaseCamera();
    this.queue?.stop();
  }

  /** `lang`: speak in that language's voice (an answer in the question's language). */
  private say(text: string, priority: SpeechPriority, lang?: SpeechLang, key?: string) {
    this.queue?.say(text, priority, lang && lang !== this.lang ? lang : undefined, key);
  }

  /** Must run inside a click or key press: browsers keep audio locked until then. */
  private unlockAudio() {
    this.tts?.unlock?.();
    this.earcons.unlock();
  }

  // --- camera ---------------------------------------------------------------------------------

  /** `quiet`: a tone instead of the spoken "camera on" (the live conversation says its own). */
  async startCamera(quiet = false) {
    this.unlockAudio();
    if (!this.video || this.state.camera === "on" || this.state.camera === "starting") return;
    // The notice is about sending pictures to Google: with Nadhra AI nothing is sent, so it isn't asked.
    if (!this.nadhra && !hasConsent()) {
      this.patch({ needsConsent: true, sheet: "none" });
      this.say(this.t.privacy, "answer");
      return;
    }
    this.patch({ camera: "starting", cameraError: "" });
    const source = this.makeSource(this.video);
    const session = this.session;
    try {
      await source.start();
    } catch (e) {
      const code = e instanceof CameraError ? e.code : "unknown";
      this.pendingTask = null;
      this.pendingVoice = false;
      this.patch({ camera: "error", cameraError: code });
      report("camera-error", code);
      this.feedback("error");
      this.say(cameraErrorText(this.lang, code), "answer");
      return;
    }
    if (session !== this.session) return source.stop();

    source.onEnded(() => {
      report("camera-error", "lost");
      this.releaseCamera();
      this.patch({ camera: "error", cameraError: "lost" });
      this.feedback("error");
      this.say(this.t.cameraLost, "urgent");
    });
    this.source = source;
    this.paused = false;
    this.resetAnalysisState();
    this.patch({ camera: "on", analysis: this.idleAnalysis(), facing: this.resolveFacing(), canSwitchCamera: false });
    this.feedback("on");
    if (!quiet) this.say(this.t.cameraOn, "status");
    // Nadhra AI: once per visit, what works (on-device warnings only) and that nothing is sent.
    if (!quiet && this.nadhra) {
      if (!this.nadhraNoticeSaid) this.say(this.t.nadhra.cameraNotice, "status");
      this.nadhraNoticeSaid = true;
    }
    // Once per visit: what "off" means, including that stairs and drops aren't detected then.
    else if (!quiet && !this.state.settings.autoDescribe && !this.autoNoticeSaid) {
      this.autoNoticeSaid = true;
      this.say(this.t.autoOffNotice, "status");
    }
    // The first start of a visit hears the safety notice (which says so); later starts a short reminder.
    if (!quiet && ++this.cameraStarts > 1) this.say(this.t.noGuarantee, "status");
    // The user came to hear what's in front of them, so the notice follows the first description,
    // but is never skipped if that description doesn't come.
    this.disclaimerDueAt = Date.now() + DISCLAIMER_LATEST_MS;
    void this.requestWakeLock();
    void navigator.mediaDevices.enumerateDevices().then((d) => {
      if (session === this.session) this.patch({ canSwitchCamera: d.filter((x) => x.kind === "videoinput").length > 1 });
    }).catch(() => {});
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    void this.startDetector(session);
    if (!this.state.online) this.say(this.offlineText, "answer");
    const task = this.pendingTask;
    this.pendingTask = null;
    if (task) void this.askWhenReady(task, session);
    if (this.pendingVoice) {
      this.pendingVoice = false;
      this.startHandsFree();
    }
  }

  /**
   * The Open Camera button: the camera, the on-device warnings and the cloud analysis, then
   * hands-free voice commands, in one press. Nothing is bypassed: the consent notice comes first
   * when it hasn't been given, and the browser asks for the camera and microphone itself.
   */
  async startAssistance() {
    this.unlockAudio();
    if (this.state.camera === "on" || this.state.camera === "starting") return this.startHandsFree();
    this.pendingVoice = true;
    await this.startCamera();
  }

  /** The Stop button: camera, voice commands and any live conversation all end. */
  stopAssistance() {
    this.unlockAudio();
    this.pendingVoice = false;
    this.pendingTask = null;
    if (this.liveSession) this.stopLive(true);
    if (this.state.assistantOn) this.stopAssistantLoop();
    if (this.state.camera === "on" || this.state.camera === "starting") return this.stopCamera();
    this.resumeOnReturn = false;
    if (this.state.camera === "error") this.patch({ camera: "off", cameraError: "" });
    this.feedback("off");
    this.queue?.stop();
    this.say(this.t.assistantOff, "status");
  }

  /** Voice commands on, without a second "on" sentence: the camera has just said it is on. */
  private startHandsFree() {
    if (this.state.assistantOn || this.liveSession) return;
    if (!this.pickVoiceInput()) {
      this.patch({ mic: "unavailable" });
      if (this.nadhra) this.say(this.t.nadhra.noVoice, "status");
      return;
    }
    this.patch({ assistantOn: true });
    void this.assistantLoop(++this.loopGen);
  }

  acceptConsent() {
    this.unlockAudio();
    setConsent(true);
    this.patch({ needsConsent: false, consentGiven: true });
    this.queue?.stop();
    if (this.pendingLive) {
      this.pendingLive = false;
      void this.startLive();
      return;
    }
    void this.startCamera();
  }

  declineConsent() {
    this.pendingTask = null;
    this.pendingLive = false;
    this.pendingVoice = false;
    this.patch({ needsConsent: false });
    this.queue?.stop();
    this.say(this.t.consentRefused, "answer");
  }

  /**
   * Withdraws consent: the camera and the live conversation stop, no image is sent any more, and
   * the notice is shown again before the camera can start. Settings and the emergency contact stay.
   */
  withdrawConsent() {
    this.unlockAudio();
    this.pendingTask = null;
    this.pendingLive = false;
    this.pendingVoice = false;
    if (this.liveSession) this.stopLive(true);
    this.resumeOnReturn = false;
    if (this.state.camera === "on" || this.state.camera === "starting") {
      this.releaseCamera();
      this.feedback("off");
    }
    setConsent(false);
    this.patch({ consentGiven: false });
    this.history = [];
    this.lastAnswerLang = undefined;
    this.document = null;
    this.pendingRead = null;
    setReadConsent(false);
    setLiveConsent(false);
    this.patch({ liveNotice: false });
    this.recent = [];
    report("consent-withdrawn");
    this.queue?.stop();
    this.say(this.t.consentWithdrawn, "answer");
  }

  stopCamera() {
    this.unlockAudio();
    this.resumeOnReturn = false;
    if (this.state.camera !== "on" && this.state.camera !== "starting") return;
    this.releaseCamera();
    this.feedback("off");
    this.queue?.stop();
    this.say(this.t.cameraOff, "status");
  }

  private releaseCamera() {
    this.session++;
    this.docHold = null;
    this.pendingTask = null; // asked for before a camera that was then stopped: not for the next one
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = null;
    this.scanCtrl?.abort();
    this.questionCtrl?.abort();
    this.source?.stop();
    this.source = null;
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    this.tracker.clear();
    this.motionFrames = [];
    this.lastScanGray = null;
    this.lastGray = null;
    this.patch({ camera: "off", analysis: "off", localHazards: [], detector: "off", detections: [], environment: null, texts: [] });
  }

  async switchCamera() {
    this.unlockAudio();
    if (!this.source?.switchDevice) return;
    try {
      await this.source.switchDevice();
      this.tracker.clear();
      this.resetAnalysisState();
      this.patch({ facing: this.resolveFacing() });
    } catch {
      this.say(cameraErrorText(this.lang, "unknown"), "answer");
    }
  }

  private resolveFacing(): CameraFacing {
    const { facing } = this.state.settings;
    if (facing !== "auto") return facing;
    // A laptop's webcam looks at the person using it. A phone reports its back camera as "environment".
    const reported = this.source?.facing;
    if (reported === "environment") return "outward";
    if (reported === "user") return "user";
    // Not reported (some Android browsers): on a phone or tablet the back camera was asked for, and
    // treating it as a mirror would swap left and right. A desktop webcam faces the user.
    return isTouchDevice() ? "outward" : "user";
  }

  private resetAnalysisState() {
    this.lastScanAt = -Infinity;
    this.lastScanGray = null;
    this.lastGray = null;
    this.unchangedStreak = 0;
    this.newObject = false;
    this.blurSince = null;
    this.poorQuality = null;
    this.motionFrames = [];
    this.failures = 0;
    this.downAnnounced = false;
    this.backoffUntil = 0;
    this.recent = [];
    this.gate.clear();
    this.lastSoundAt = Date.now();
  }

  private sayDisclaimerOnce() {
    if (this.spokeDisclaimer) return;
    this.spokeDisclaimer = true;
    this.say(this.t.disclaimer, "status");
  }

  private async requestWakeLock() {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {} // not available, or refused because the page is hidden: harmless
  }

  // --- scheduled analysis ---------------------------------------------------------------------

  /**
   * The camera keeps moving (the user is probably walking) while nothing looks for stairs or holes:
   * automatic descriptions off or paused, and no live conversation. Said at most every few minutes.
   */
  private remindWhileMoving(now: number) {
    const unwatched = (!this.state.settings.autoDescribe || this.paused || this.nadhra) && !this.liveSession;
    if (!unwatched || this.motion <= CAMERA_MOVING_FRACTION) {
      this.movingSince = null;
      return;
    }
    this.movingSince ??= now;
    if (now - this.movingSince < WALKING_AFTER_MS || now - this.lastWalkingReminderAt < WALKING_REMINDER_MS) return;
    this.lastWalkingReminderAt = now;
    this.say(this.nadhra ? this.t.nadhra.cameraNotice : this.t.walkingNoScan, "status");
  }

  /** The state between analyses: describing automatically, or only when asked. */
  private idleAnalysis(): AnalysisState {
    if (this.nadhra) return "local";
    return this.state.settings.autoDescribe ? "watching" : "manual";
  }

  pause() {
    this.unlockAudio();
    if (this.state.camera !== "on" || this.paused) return;
    this.paused = true;
    this.scanCtrl?.abort();
    // Only the descriptions and cloud analysis stop. The on-device warnings keep running: a pause
    // must never silently turn the safety layer off, and the user is told which one is still on.
    this.patch({ analysis: "paused" });
    this.feedback("off");
    this.say(this.state.detector === "ready" || this.state.detector === "loading" ? this.t.paused : this.t.pausedNoWarnings, "status");
  }

  resume() {
    this.unlockAudio();
    if (this.state.camera !== "on" || !this.paused) return;
    this.paused = false;
    this.lastScanAt = -Infinity; // describe the scene right away
    this.backoffUntil = 0;
    this.patch({ analysis: this.idleAnalysis() });
    this.feedback("on");
    this.say(this.nadhra ? this.t.nadhra.cameraNotice : this.state.settings.autoDescribe ? this.t.resumed : this.t.autoOffHint, "status");
  }

  get isPaused() {
    return this.paused;
  }

  private tick() {
    const source = this.source;
    if (!source || this.state.camera !== "on") return;
    const now = Date.now();
    if (now >= this.disclaimerDueAt) this.sayDisclaimerOnce();
    if (document.hidden) {
      if (!this.paused && this.state.analysis !== "hidden") this.patch({ analysis: "hidden" });
      return;
    }
    const thumb = source.thumbnail(THUMB.width, THUMB.height);
    if (!thumb) return;
    const gray = rgbaToGray(thumb.rgba);
    const quality = classifyQuality(frameStats(gray, thumb.width, thumb.height));
    // Measured while paused too: the on-device warnings need to know whether the camera is moving.
    this.motion = this.lastGray ? changedFraction(this.lastGray, gray) : 0;
    this.lastGray = gray;
    this.remindWhileMoving(now);
    if (this.liveSession?.isOpen && now - this.lastLiveReminderAt >= LIVE_REMINDER_MS) {
      this.lastLiveReminderAt = now;
      this.say(this.t.liveReminder, "status");
    }
    if (this.paused) return;
    this.blurSince = quality === "blurry" ? (this.blurSince ?? now) : null;
    this.trackQuality(quality, now);

    const live = !!this.liveSession;
    if (this.documentHeld(gray)) return; // no automatic frame of a document, scan or live
    if (live) this.liveFrameTick(gray, now);

    // The older frame sent with a request: the only evidence allowed for motion claims.
    // Offline (or with Nadhra AI) nothing can be sent, so it isn't encoded either.
    const newestMotion = this.motionFrames[this.motionFrames.length - 1];
    if (this.state.online && !this.nadhra && (!newestMotion || now - newestMotion.at >= MOTION_FRAME_EVERY_MS)) {
      const frame = source.capture(MOTION_FRAME.maxSide, MOTION_FRAME.quality);
      if (frame) this.motionFrames.push(frame);
      if (this.motionFrames.length > 3) this.motionFrames.shift();
    }

    // Automatic descriptions off (the default): no picture leaves the phone unless the user asks.
    // Nadhra AI: never; it has no scene analysis yet, and no picture may leave the device.
    const decision = !this.state.settings.autoDescribe || this.nadhra ? { send: false } : decideScan({
      now,
      lastScanAt: this.lastScanAt,
      changed: this.lastScanGray ? changedFraction(this.lastScanGray, gray) : 1,
      quality,
      // Offline, a frame can only fail: on-device warnings keep running without it.
      inFlight: !!this.scanCtrl || !!this.questionCtrl || !this.state.online,
      paused: false,
      hidden: false,
      backoffUntil: this.backoffUntil,
      unchangedStreak: this.unchangedStreak,
      newObject: this.newObject,
      blurSince: this.blurSince,
      ...(live ? { minIntervalMs: LIVE_HAZARD_SCAN_MS } : {}),
    });
    if (decision.send) void this.scan(gray);
    else if (this.state.analysis === "hidden") this.patch({ analysis: this.idleAnalysis() });

    // A long silence shouldn't feel like the assistant has died: a soft tone says it's still running.
    // (A live conversation has its own voice.)
    if (!live && now - this.lastSoundAt > ALIVE_AFTER_SILENCE_MS && !this.queue?.busy) {
      this.lastSoundAt = now;
      this.earcons.play("alive", this.state.settings.volume);
    }
  }

  private trackQuality(quality: LocalQuality, now: number) {
    const poor = quality === "dark" || quality === "bright" || quality === "flat";
    if (!poor) {
      if (this.poorQuality?.announced) {
        this.say(this.t.imageBack, "status");
        this.patch({ analysis: this.idleAnalysis() });
      }
      this.poorQuality = null;
      return;
    }
    if (this.poorQuality?.kind !== quality) this.poorQuality = { kind: quality, since: now, announced: this.poorQuality?.announced ?? false };
    if (!this.poorQuality.announced && now - this.poorQuality.since >= QUALITY_ANNOUNCE_AFTER_MS) {
      this.poorQuality.announced = true;
      this.patch({ analysis: "poor-image" });
      this.say(quality === "dark" ? this.t.tooDark : this.t.obstructed, "answer");
    }
  }

  private pickMotionFrame(now: number) {
    const frame = this.motionFrames.find((f) => now - f.at >= 700 && now - f.at <= 4_000);
    return frame ? { previousImage: frame.base64, previousAgeMs: now - frame.at } : {};
  }

  private async scan(gray: Uint8Array) {
    const source = this.source;
    if (!source) return;
    const frame = source.capture(SCAN_FRAME.maxSide, SCAN_FRAME.quality);
    if (!frame) return;
    const ctrl = new AbortController();
    const session = this.session;
    this.scanCtrl = ctrl;
    this.lastScanAt = frame.at;
    this.lastScanGray = gray;
    this.newObject = false;
    this.patch({ analysis: "analyzing", scansSent: this.state.scansSent + 1 });
    try {
      const res = await analyzeFrame({
        mode: "scan",
        image: frame.base64,
        ...this.pickMotionFrame(frame.at),
        cameraFacing: this.state.facing,
        lang: this.lang,
        recent: this.recent,
      }, ctrl.signal);
      if (session !== this.session || ctrl.signal.aborted) return;
      this.onScanSuccess();
      this.patch({ lastLatencyMs: res.latencyMs });
      this.unchangedStreak = res.analysis.changed ? 0 : this.unchangedStreak + 1;
      // Too old to be about "now". Better to say nothing than warn about where things used to be.
      if (Date.now() - frame.at <= MAX_RESULT_AGE_MS) this.applyAnalysis(res.analysis, "scan");
      // A paper or a medicine box was in that frame: no more automatic frames until it is put away.
      if (res.analysis.documentInView) this.holdDocument(this.source, true);
    } catch (e) {
      if (session !== this.session || ctrl.signal.aborted) return;
      this.onScanFailure(e);
    } finally {
      if (this.scanCtrl === ctrl) this.scanCtrl = null;
      if (session === this.session && !this.paused && !this.questionCtrl && this.state.analysis === "analyzing") {
        this.patch({ analysis: this.failures >= FAILURES_BEFORE_ANNOUNCE ? "unavailable" : this.idleAnalysis() });
      }
    }
  }

  private onScanSuccess() {
    this.failures = 0;
    this.backoffUntil = 0;
    if (this.downAnnounced) {
      this.downAnnounced = false;
      this.feedback("on");
      this.say(this.t.analysisBack, "status");
    }
  }

  private onScanFailure(e: unknown) {
    const err = e instanceof VisionApiError ? e : new VisionApiError(0, "network");
    this.failures++;
    this.backoffUntil = Date.now() + backoffMs(this.failures, err.retryAfterMs);
    if (this.failures === FAILURES_BEFORE_ANNOUNCE || err.code === "quota-exhausted") report("scan-failed", err.code);
    if (err.code === "not-configured" || err.code === "offline-mode" || err.code === "nadhra-unavailable") {
      // Neither changes by itself: scans wait, and the reason is said once.
      this.backoffUntil = Date.now() + 5 * 60_000;
      if (!this.downAnnounced) this.say(this.failureText(err, this.t), "answer");
      this.downAnnounced = true;
    } else if (err.code === "no-internet") {
      this.backoffUntil = Date.now() + 60_000;
      if (!this.downAnnounced) {
        this.feedback("error");
        this.say(this.offlineText, "answer");
      }
      this.downAnnounced = true;
    } else if (err.code === "quota-exhausted") {
      this.backoffUntil = Date.now() + Math.max(QUOTA_BACKOFF_MS, err.retryAfterMs);
      if (!this.downAnnounced) {
        this.feedback("error");
        this.say(this.t.quotaExhausted, "answer");
      }
      this.downAnnounced = true;
    } else if (this.failures >= FAILURES_BEFORE_ANNOUNCE && !this.downAnnounced && this.state.online) {
      // The user must not believe they're still being watched over when they aren't.
      // (Offline was already announced, with what still works.)
      this.downAnnounced = true;
      this.feedback("error");
      this.say(this.t.analysisDown, "answer");
    }
  }

  /** `spoken`: what is still to be said (a streamed answer has already said the rest). */
  private applyAnalysis(analysis: SceneAnalysis, mode: VisionMode, spoken = analysis.spoken, lang?: SpeechLang) {
    this.patch({ environment: analysis.environment, detections: analysis.detections, texts: analysis.texts });
    this.speakHazards(analysis.hazards, mode !== "scan");
    // In a live conversation the scans are only for their warnings: the conversation describes.
    if (mode === "scan" && this.liveSession) return;
    if (mode !== "scan") {
      if (spoken) this.say(spoken, "answer", lang);
      return;
    }
    // Scans keep running during a reading, for their warnings. Their description would only wait
    // behind the reading and be stale by then, so it is dropped.
    if (this.queue?.hasAtLeast("answer")) return;
    if (this.state.settings.autoDescribe && analysis.changed && analysis.spoken && !isRepeat(analysis.spoken, this.recent)) {
      this.say(analysis.spoken, "narration");
    }
  }

  private speakHazards(hazards: Hazard[], urgentOnly: boolean) {
    const now = Date.now();
    for (const hazard of hazards) {
      const urgency = hazardUrgency(hazard);
      if (urgentOnly && urgency !== "urgent") continue;
      if (!this.gate.admit(hazard, urgency, now)) continue;
      const key = hazardKey(hazard);
      if (urgency === "urgent") {
        this.feedback("urgent");
        this.say(warningPhrase(hazard, this.lang), "urgent", undefined, key);
      } else {
        this.say(warningPhrase(hazard, this.lang), "warning", undefined, key);
      }
    }
  }

  // --- on-device detector ----------------------------------------------------------------------

  /**
   * The detector stopped or never started. The cloud analysis may still work, so the page keeps
   * running, but the user is told out loud: a blind user can't see the status list.
   */
  private detectorFailed(session: number, why: string) {
    console.warn("[vision] on-device detector unavailable:", why);
    report("detector-failed", /timed out/.test(why) ? "timeout" : "error");
    this.detector.close(); // a broken instance isn't reused: the next camera start loads a new one
    if (session !== this.session) return;
    this.patch({ detector: "failed", localHazards: [] });
    this.tracker.clear();
    this.feedback("error");
    this.say(this.state.online ? this.t.detectorFailed : this.t.analysisDown, "warning");
  }

  private async startDetector(session: number) {
    this.patch({ detector: "loading" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.detector.load(),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("load timed out")), this.detectorLoadTimeoutMs))),
      ]);
    } catch (e) {
      this.detectorFailed(session, (e as Error).message);
      return;
    } finally {
      clearTimeout(timer);
    }
    if (session !== this.session) return;
    this.patch({ detector: "ready" });
    const run = () => {
      if (session !== this.session) return;
      const video = this.source?.videoElement();
      const now = performance.now();
      // Also while paused: the pause stops descriptions, never the safety layer.
      if (video && !document.hidden && this.budget.shouldProcess(now)) {
        try {
          const raw = this.detector.detect(video, now);
          this.budget.record(performance.now() - now, performance.now());
          const { hazards, newObject } = this.tracker.update(raw, now, { cameraMoving: this.motion > CAMERA_MOVING_FRACTION, facing: this.state.facing, lang: this.lang });
          if (newObject) this.newObject = true;
          this.speakHazards(hazards, false);
          if (JSON.stringify(hazards) !== JSON.stringify(this.state.localHazards)) this.patch({ localHazards: hazards });
        } catch (e) {
          this.detectorFailed(session, (e as Error).message);
          return;
        }
      }
      this.detectTimer = setTimeout(run, Math.max(250, this.budget.minIntervalMs()));
    };
    run();
  }

  // --- questions -------------------------------------------------------------------------------

  /**
   * Answers a question with the model, at the time it is asked. With the camera on, the frame
   * captured now goes with it; with the camera off, it is answered without a picture (general
   * questions), and a question about the surroundings asks for the camera. The answer is spoken
   * sentence by sentence as it arrives. A newer question cancels this one, here and on the server.
   */
  async ask(question: string, opts: { plain?: boolean; caveat?: boolean } = {}): Promise<void> {
    this.unlockAudio();
    const q = question.trim();
    if (!q) return;
    // Nadhra AI has no question answering yet: refused out loud, never sent to Gemini instead.
    if (this.nadhra) return this.refuseNadhra(questionLang(q, this.lang, this.lastAnswerLang));
    // Medicines and doses: never an ordinary answer, never the live model. Read under the reading
    // rules when there is a picture or a document, otherwise declined.
    if (isMedicalQuestion(q)) {
      if (!opts.plain && ((this.state.camera === "on" && this.source) || this.activeDocument())) return this.readDocument(q);
      const lang = questionLang(q, this.lang, this.lastAnswerLang);
      this.queue?.stop();
      this.liveAudio?.flush();
      this.say(speech(lang).doc.medicalDeclined, "answer", lang);
      return;
    }
    // A question about the document just read, or a request to read: answered from the text itself.
    if (!opts.plain && !this.liveSession?.isOpen) {
      if (this.activeDocument() || (isReadRequest(q) && this.state.camera === "on")) return this.readDocument(q);
    }
    // In a live conversation the question goes into it, with a fresh view of the camera.
    if (this.liveSession?.isOpen) {
      this.queue?.stop();
      this.liveAudio?.flush();
      this.sendLiveFrame(true);
      this.liveNewUserTurn = true;
      this.liveNewAnswer = true;
      this.patch({ live: { ...this.state.live, user: q, ai: "" } });
      this.liveSession.sendText(q);
      return;
    }
    // Answered in the language it was asked in, when that is clearly one the assistant speaks.
    const lang = questionLang(q, this.lang, this.lastAnswerLang);
    const t = speech(lang);
    const source = this.source;
    const cameraOn = !!source && this.state.camera === "on";
    const frame = cameraOn ? source.capture(QUESTION_FRAME.maxSide, QUESTION_FRAME.quality) : null;
    if (cameraOn && !frame) {
      this.say(t.questionFailed, "answer", lang);
      return;
    }
    if (!this.state.online) {
      this.feedback("error");
      this.say(cameraOn ? this.offlineText : this.t.analysisDown, "answer");
      return;
    }
    this.scanCtrl?.abort(); // the question is more important than the running description
    this.questionCtrl?.abort();
    const ctrl = new AbortController();
    const session = this.session;
    this.questionCtrl = ctrl;
    if (frame) this.lastScanAt = frame.at;
    this.queue?.stop();
    this.say(cameraOn ? t.thinking : t.thinkingNoCamera, "narration", lang); // the answer cuts this off
    this.patch({ answer: { text: "", live: true, web: false, lang }, ...(cameraOn ? { analysis: "analyzing" as const, scansSent: this.state.scansSent + 1 } : {}) });
    const current = () => session === this.session && !ctrl.signal.aborted;
    let streamed = "";
    try {
      const res = await askStreaming({
        mode: frame ? "question" : "chat",
        image: frame?.base64,
        ...(frame ? this.pickMotionFrame(frame.at) : {}),
        cameraFacing: this.state.facing,
        lang,
        question: q,
        history: this.history,
      }, (sentence) => {
        if (!current()) return;
        streamed = streamed ? `${streamed} ${sentence}` : sentence;
        this.patch({ answer: { text: streamed, live: true, web: false, lang } });
        this.say(sentence, "answer", lang);
      }, ctrl.signal);
      if (!current()) return;
      this.patch({ lastLatencyMs: res.latencyMs });
      if (res.analysis.needsCamera) {
        // About the surroundings, and the camera is off: no answer is made up.
        this.patch({ answer: { text: "", live: false, web: false, lang } });
        this.say(t.cameraNeeded, "answer", lang);
        return;
      }
      this.applyAnalysis(res.analysis, frame ? "question" : "chat", res.rest, lang);
      // "What's in front of me?" can sound like "nothing dangerous is there": once in a while, it can't promise that.
      if (opts.caveat && Date.now() - this.lastFrontCaveatAt >= FRONT_CAVEAT_MS) {
        this.lastFrontCaveatAt = Date.now();
        this.say(t.noGuarantee, "answer", lang);
      }
      this.patch({ answer: { text: res.analysis.spoken, live: false, web: !!res.analysis.usedWeb, lang } });
      this.history = [...this.history, { q, a: res.analysis.spoken }].slice(-3);
      this.lastAnswerLang = lang;
    } catch (e) {
      if (!current()) return;
      this.feedback("error");
      const err = e instanceof VisionApiError ? e : null;
      this.patch({ answer: { text: streamed, live: false, web: false, lang } });
      if (err?.code === "interrupted") {
        // The start was said: the user must know the rest is missing, not think the answer ended there.
        this.say(t.answerCut, "answer", lang);
        return;
      }
      report("question-failed", err?.code ?? "unknown");
      this.say(
        this.failureText(err, t),
        "answer",
        lang,
      );
    } finally {
      if (this.questionCtrl === ctrl) this.questionCtrl = null;
      if (this.state.answer.live && this.questionCtrl === null) this.patch({ answer: { ...this.state.answer, live: false } });
      if (session === this.session && this.state.analysis === "analyzing") this.patch({ analysis: this.paused ? "paused" : this.idleAnalysis() });
    }
  }

  // --- reading documents ---------------------------------------------------------------------------

  /** The document read in the last few minutes, if any. */
  private activeDocument(): DocumentReading | null {
    if (!this.document || Date.now() - this.document.at > DOCUMENT_TTL_MS) return (this.document = null);
    return this.document.reading;
  }

  /**
   * Reads the document or package in front of the camera (medicine, prescription, bill, letter), or
   * answers `question` about it. Too dark or too blurred a picture is refused on the device, before
   * anything is sent. What is said comes from the server already checked and labelled (document.ts):
   * text from the paper in its own language's voice, the assistant's words in the user's.
   */
  async readDocument(question?: string): Promise<void> {
    this.unlockAudio();
    const lang = question ? questionLang(question, this.lang, this.lastAnswerLang) : this.lang;
    // Nadhra AI has no reader yet: nothing is captured or sent, and the reading rules below are untouched.
    if (this.nadhra) return this.refuseNadhra(lang);
    const t = speech(lang);
    const known = question ? this.activeDocument() : null;
    const source = this.source;
    const cameraOn = !!source && this.state.camera === "on";
    if (!cameraOn && !known) {
      if (question) return this.ask(question, { plain: true }); // answered without a picture, as before
      return this.runTask("read");
    }
    if (!this.state.online) {
      this.feedback("error");
      this.say(this.t.analysisDown, "answer");
      return;
    }
    // Before the first document leaves the phone: who gets it, what Google may do with it on the
    // free service, and that real prescriptions don't belong in this test version. Spoken «موافق».
    if (!hasReadConsent()) {
      this.pendingRead = { question };
      this.queue?.stop();
      this.liveAudio?.flush();
      this.say(t.doc.notice, "answer", lang);
      return;
    }
    // In a live conversation the reading comes from here, checked, not from the live model.
    if (this.liveSession) {
      this.liveMuted = true;
      this.liveAudio?.flush();
    }
    this.scanCtrl?.abort();
    this.questionCtrl?.abort();
    const ctrl = new AbortController();
    const session = this.session;
    this.questionCtrl = ctrl;
    const current = () => session === this.session && !ctrl.signal.aborted;
    this.queue?.stop();
    this.say(t.doc.reading, "narration", lang);
    this.patch({ answer: { text: "", live: true, web: false, lang } });
    try {
      let image: string | undefined;
      let secondImage: string | undefined;
      if (cameraOn) {
        this.holdDocument(source);
        const check = await this.waitForReadableFrame(source, current);
        if (!current()) return;
        // A follow-up can still be answered from the text read before.
        if (check !== "ok" && !known) {
          this.feedback("error");
          this.queue?.stop();
          this.say(check === "dark" ? t.doc.tooDark : `${t.doc.unreadable} ${t.doc.tip.blurry}`, "answer", lang);
          this.patch({ answer: { text: "", live: false, web: false, lang } });
          return;
        }
        if (check === "ok") {
          const frame = (await source.captureStill?.(READ_FRAME.maxSide, READ_FRAME.quality)) ?? source.capture(READ_FRAME.maxSide, READ_FRAME.quality);
          if (!current()) return;
          image = frame?.base64;
          if (frame) this.lastScanAt = frame.at;
          // A second frame a moment later, for the independent second reading of doses and dates.
          await sleep(SECOND_FRAME_DELAY_MS);
          if (!current()) return;
          secondImage = image ? source.capture(READ_FRAME.maxSide, READ_FRAME.quality)?.base64 : undefined;
        }
        if (!image && !known) {
          this.say(t.questionFailed, "answer", lang);
          return;
        }
        this.patch({ analysis: "analyzing", scansSent: this.state.scansSent + (image ? 1 : 0) });
      }
      const body = { mode: "read" as const, image, secondImage, cameraFacing: this.state.facing, lang, question, ...(known ? { document: documentContext(known) } : {}) };
      let res;
      try {
        res = await analyzeFrame(body, ctrl.signal);
      } catch (e) {
        // A dropped connection before any answer: the reading is still wanted, so it is sent once more.
        if (!(e instanceof VisionApiError && e.code === "network") || !current() || navigator.onLine === false) throw e;
        await sleep(600);
        if (!current()) return;
        res = await analyzeFrame(body, ctrl.signal);
      }
      if (!current()) return;
      const doc = res.analysis.document;
      this.patch({ lastLatencyMs: res.latencyMs });
      if (!doc) throw new VisionApiError(0, "ai-unavailable");
      if (doc.notAboutDocument && question) {
        // Not about the paper: an ordinary question. The paper stays available for later questions.
        if (this.questionCtrl === ctrl) this.questionCtrl = null;
        return this.ask(question, { plain: true });
      }
      this.queue?.stop(); // the "reading…" notice
      this.speakSegments(doc.segments, lang);
      this.patch({ texts: res.analysis.texts, answer: { text: res.analysis.spoken, live: false, web: false, lang } });
      // Not added to the conversation history: what a paper says isn't sent along with later,
      // unrelated questions. Follow-ups about it carry its text on purpose (documentContext).
      this.rememberDocument(doc, known);
    } catch (e) {
      if (!current()) return;
      this.feedback("error");
      const err = e instanceof VisionApiError ? e : null;
      this.patch({ answer: { text: "", live: false, web: false, lang } });
      report("question-failed", err?.code ?? "unknown");
      this.queue?.stop();
      this.say(
        this.failureText(err, t),
        "answer",
        lang,
      );
    } finally {
      if (this.questionCtrl === ctrl) this.questionCtrl = null;
      if (session === this.session && this.state.analysis === "analyzing") this.patch({ analysis: this.paused ? "paused" : this.idleAnalysis() });
    }
  }

  /** «موافق» to the notice about documents: remembered, and the waiting reading goes ahead. */
  private acceptReadNotice() {
    const pending = this.pendingRead;
    this.pendingRead = null;
    setReadConsent(true);
    void this.readDocument(pending?.question);
  }

  /** A document is (or was just) in front of the camera: automatic frames stop until it is put away. */
  private holdDocument(source: CameraSource | null, announce = false) {
    const thumb = source?.thumbnail(THUMB.width, THUMB.height);
    const first = !this.docHold;
    this.docHold = { gray: thumb ? rgbaToGray(thumb.rgba) : this.lastGray, away: 0 };
    this.scanCtrl?.abort();
    if (announce && first) this.say(this.t.doc.inView, "status");
  }

  /** True while automatic frames are held for a document; releases the hold once the view has clearly moved on. */
  private documentHeld(gray: Uint8Array): boolean {
    const hold = this.docHold;
    if (!hold) return false;
    if (!hold.gray) {
      hold.gray = gray;
      return true;
    }
    hold.away = changedFraction(hold.gray, gray) > DOCUMENT_AWAY_CHANGE ? hold.away + 1 : 0;
    if (hold.away < 2) return true;
    this.docHold = null;
    return false;
  }

  /**
   * Waits for a frame that is bright and sharp enough to read, for up to READ_STEADY_WAIT_MS. The
   * thumbnail used for scene checks is too small to see blurred print, so this looks at 640 × 480.
   */
  private async waitForReadableFrame(source: CameraSource, current: () => boolean): Promise<"ok" | "dark" | "blurry"> {
    const until = Date.now() + this.readSteadyWaitMs;
    let last: "dark" | "blurry" = "blurry";
    while (current()) {
      const frame = source.thumbnail(READ_CHECK.width, READ_CHECK.height);
      if (frame) {
        const gray = rgbaToGray(frame.rgba);
        const stats = frameStats(gray, frame.width, frame.height);
        if (stats.meanLuma < QUALITY_LIMITS.dark) last = "dark";
        else if (sharpestTile(gray, frame.width, frame.height) < READ_BLUR_LIMIT) last = "blurry";
        else return "ok";
      }
      if (Date.now() >= until) return last;
      await sleep(250);
    }
    return last;
  }

  /** Each part in its voice: the paper's text in its own language, the rest in the user's. */
  private speakSegments(segments: SpeechSegment[], lang: SpeechLang) {
    for (const seg of segments) this.say(seg.text, "answer", seg.lang ?? lang);
  }

  /**
   * Keeps the document for follow-up questions. A follow-up that showed more of the same paper adds
   * its new lines; a new reading replaces it. Nothing readable: the earlier one stays.
   */
  private rememberDocument(doc: DocumentReading, known: DocumentReading | null) {
    const readable = documentContext(doc).lines;
    if (!known) {
      if (readable.length) this.document = { reading: doc, at: Date.now() };
      return;
    }
    const seen = new Set(documentContext(known).lines);
    const added = doc.lines.filter((l) => readable.includes(l.text) && !seen.has(l.text));
    const lines = [...known.lines, ...added].slice(0, MAX_CONTEXT_LINES * 2);
    this.document = { reading: { ...known, lines }, at: Date.now() };
  }

  /** "Read all": the whole text of the last document, from memory. No new picture is taken. */
  readAll() {
    this.unlockAudio();
    const doc = this.activeDocument();
    if (!doc) {
      if (this.state.camera === "on") return void this.readDocument();
      this.queue?.stop();
      return this.say(this.t.doc.nothingRead, "answer");
    }
    this.queue?.stop();
    const segments = readAllSegments(doc, this.lang);
    this.speakSegments(segments, this.lang);
    this.patch({ answer: { text: segments.map((x) => x.text).join(" "), live: false, web: false, lang: this.lang } });
    this.document = { reading: doc, at: Date.now() };
  }

  stopSpeech() {
    this.unlockAudio();
    this.queue?.stop();
    this.liveAudio?.flush();
  }

  repeat() {
    this.unlockAudio();
    this.queue?.stop();
    this.say(this.state.lastSpoken || this.t.nothingToRepeat, "answer");
  }

  // --- tasks, help, going back --------------------------------------------------------------------

  /** One of the main actions. Starts the camera first when it is off, then asks. */
  async runTask(task: Task): Promise<void> {
    this.unlockAudio();
    if (this.nadhra) return this.refuseNadhra(); // not even the camera is started for it
    if (this.state.camera === "on") return task === "read" ? this.readDocument() : this.ask(this.t.ask[task], { plain: true, caveat: task === "front" || task === "describe" });
    this.pendingTask = task;
    if (this.state.camera !== "starting") await this.startCamera();
  }

  /** The camera has just started: its first frames can take a moment to arrive. */
  private async askWhenReady(task: Task, session: number) {
    const until = Date.now() + CAMERA_READY_WAIT_MS;
    while (session === this.session && !this.source?.capture(64, 0.5) && Date.now() < until) await sleep(150);
    if (session === this.session) await sleep(CAMERA_SETTLE_MS);
    if (session !== this.session) return;
    if (task === "read") await this.readDocument();
    else await this.ask(this.t.ask[task], { plain: true, caveat: task === "front" || task === "describe" });
  }

  help() {
    this.unlockAudio();
    this.queue?.stop();
    this.say(this.t.help, "answer");
  }

  /** Closes the open panel, or cancels the question being answered, or stops the voice. */
  goBack() {
    this.unlockAudio();
    if (this.state.liveNotice) {
      this.patch({ liveNotice: false });
      this.queue?.stop();
      this.say(this.t.liveNoticeRefused, "status");
      return;
    }
    if (this.pendingRead) {
      this.pendingRead = null;
      this.queue?.stop();
      this.say(this.t.doc.noticeRefused, "status");
      return;
    }
    if (this.state.sheet !== "none") {
      this.closeSheet();
      this.queue?.stop();
      this.say(this.t.closed, "status");
      return;
    }
    const busy = !!this.questionCtrl || this.listening || !!this.queue?.busy;
    this.questionCtrl?.abort();
    if (this.listening && !this.state.assistantOn) this.voiceInput?.abort();
    this.queue?.stop();
    if (busy) this.say(this.t.cancelled, "status");
  }

  openSheet(sheet: Exclude<SheetName, "none">) {
    this.unlockAudio();
    this.patch({ sheet });
    if (sheet !== "emergency") return;
    this.queue?.stop();
    this.feedback("listen");
    this.say(this.t.emergency, "answer");
    if (!this.state.settings.emergencyPhone) this.say(this.t.noContact, "answer");
    this.locate();
  }

  /**
   * The screen calls this when a panel closes, however it was closed. A dialog's close event comes
   * late, so it only counts when that panel is still the current one, not one opened just after.
   */
  closeSheet(which: SheetName = this.state.sheet) {
    if (which !== this.state.sheet || which === "none") return;
    if (which === "emergency") this.stopLocation();
    this.patch({ sheet: "none" });
  }

  /**
   * Browsers only open the phone app from a real tap, so a voice command can't place the call.
   * It selects the call button, which a screen reader user activates with one double-tap.
   */
  requestCall() {
    if (this.state.sheet !== "emergency") return this.openSheet("emergency");
    if (!this.state.settings.emergencyPhone) return this.say(this.t.noContact, "answer");
    this.patch({ focus: { target: "call", id: this.state.focus.id + 1 } });
    this.queue?.stop();
    this.say(this.t.calling, "answer");
  }

  /** The location is only put into the message on this device. It is never sent to our server. */
  private locate() {
    if (!("geolocation" in navigator)) return this.patch({ location: { status: "failed" } });
    const watch = ++this.locationWatch;
    this.patch({ location: { status: "pending" } });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (watch !== this.locationWatch) return;
        this.patch({ location: { status: "ready", lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy } });
      },
      () => {
        if (watch !== this.locationWatch) return;
        this.patch({ location: { status: "failed" } });
      },
      { enableHighAccuracy: true, timeout: LOCATION_TIMEOUT_MS, maximumAge: 60_000 },
    );
  }

  private stopLocation() {
    this.locationWatch++;
    if (this.state.location.status !== "idle") this.patch({ location: { status: "idle" } });
  }

  /** The text of the emergency message, with a map link when the location is known. */
  emergencyMessage(): string {
    const loc = this.state.location;
    return loc.status === "ready" ? `${this.t.sms} https://maps.google.com/?q=${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}` : this.t.smsNoLocation;
  }

  /** Steps through the fixed choices, and says so at either end. */
  private step(key: "rate" | "volume", direction: 1 | -1) {
    const choices: readonly number[] = key === "rate" ? RATE_CHOICES : VOLUME_CHOICES;
    const current = this.state.settings[key];
    const index = choices.findIndex((c) => c >= current - 0.001);
    const next = choices[Math.min(choices.length - 1, Math.max(0, (index < 0 ? choices.length - 1 : index) + direction))];
    this.queue?.stop();
    if (next === current) return this.say(this.t.limit, "answer");
    this.updateSettings({ [key]: next });
    const t = this.t;
    this.say(key === "rate" ? (direction > 0 ? t.faster : t.slower) : direction > 0 ? t.louder : t.quieter, "answer");
  }

  // --- voice input -----------------------------------------------------------------------------

  private pickVoiceInput(): VoiceInput | null {
    // Nadhra AI: the browser's recognition sends the voice to Google, and recordings would go to the
    // server; neither is allowed. No local recogniser is connected yet.
    if (this.nadhra) return null;
    // Offline mode: the browser's speech recognition is a cloud service (Chrome sends the audio to
    // Google), so it is never used. Recording goes to the server, which transcribes only with an
    // engine on the device, and otherwise says that this needs the internet.
    const wantRecorder = this.forceRecorder || !recognitionSupported() || this.state.status?.mode === "offline";
    if (!wantRecorder) {
      if (this.voiceInput?.kind !== "recognition") this.voiceInput = new RecognitionInput(() => LANGS[this.lang].recognition);
    } else if (recordingSupported() && this.state.status?.canTranscribe) {
      if (this.voiceInput?.kind !== "recording") this.voiceInput = new RecorderInput();
    } else {
      this.voiceInput = null;
    }
    return this.voiceInput;
  }

  /** "Stop listening": only ever turns hands-free mode off, whichever way it was said. */
  stopAssistant() {
    this.unlockAudio();
    if (this.state.assistantOn) {
      this.stopAssistantLoop();
      this.feedback("off");
    }
    this.say(this.t.assistantOff, "status");
  }

  toggleAssistant() {
    this.unlockAudio();
    // Voice commands and the live conversation would both need the microphone.
    if (this.liveSession && !this.state.assistantOn) this.stopLive(true);
    if (this.state.assistantOn) {
      this.stopAssistantLoop();
      this.feedback("off");
      this.say(this.t.assistantOff, "status");
      return;
    }
    if (!this.pickVoiceInput()) {
      this.patch({ mic: "unavailable" });
      this.feedback("error");
      this.say(this.nadhra ? this.t.nadhra.noVoice : this.t.voiceUnavailable, "answer");
      return;
    }
    this.patch({ assistantOn: true });
    this.feedback("on");
    this.say(this.t.assistantOn, "status");
    void this.assistantLoop(++this.loopGen);
  }

  private stopAssistantLoop() {
    this.loopGen++;
    this.voiceInput?.abort();
    this.patch({ assistantOn: false, mic: this.state.mic === "denied" || this.state.mic === "unavailable" ? this.state.mic : "off" });
  }

  private async assistantLoop(gen: number) {
    while (gen === this.loopGen && this.state.assistantOn) {
      if (this.queue?.busy || this.questionCtrl || document.hidden || this.listening) {
        await sleep(200);
        continue;
      }
      // Speech recognition is an online service: retrying it offline only fails, and drains the battery.
      if (!this.state.online) {
        await sleep(1_000);
        continue;
      }
      await this.listenOnce(false);
      await sleep(250); // recognition needs a moment before it can restart
    }
  }

  /** The Ask button. With the assistant on, the microphone is already open: this only makes room. */
  async askByVoice() {
    this.unlockAudio();
    // Live: the microphone is always open. Ask only stops the answer so the user can talk.
    if (this.liveSession) {
      this.liveAudio?.flush();
      return;
    }
    if (this.listening) {
      this.voiceInput?.finish();
      return;
    }
    this.queue?.stop();
    if (this.state.assistantOn) return;
    await this.listenOnce(true);
  }

  private async listenOnce(pushToTalk: boolean) {
    const input = this.pickVoiceInput();
    if (!input) {
      this.patch({ mic: "unavailable" });
      if (pushToTalk) this.say(this.nadhra ? this.t.nadhra.noVoice : this.t.voiceUnavailable, "answer");
      return;
    }
    this.listening = true;
    this.patch({ mic: "listening" });
    if (pushToTalk) {
      this.pushToTalkOpen = true;
      this.queue?.setHold(true);
      this.feedback("listen");
    }
    try {
      const result = await input.listen({
        onSpeechStart: () => {
          this.userTalking = true;
          this.queue?.setHold(true);
        },
        onSpeechEnd: () => {
          this.userTalking = false;
          if (!this.pushToTalkOpen) this.queue?.setHold(false);
        },
      });
      this.listening = false;
      if (result.kind === "none") {
        this.patch({ mic: "off" });
        // Aborted because the user left the app: there is nobody to tell.
        if (pushToTalk && !document.hidden) this.say(this.t.noQuestionHeard, "answer");
        return;
      }
      if (result.kind === "text") {
        this.patch({ mic: "off" });
        await this.handleUtterance(result.text);
        return;
      }
      this.patch({ mic: "processing" });
      const { text } = await transcribeWav(result.wavBase64, this.lang);
      this.patch({ mic: "off" });
      if (text) await this.handleUtterance(text);
      else if (pushToTalk) this.say(this.t.noQuestionHeard, "answer");
    } catch (e) {
      this.listening = false;
      await this.handleVoiceError(e, pushToTalk);
    } finally {
      this.listening = false;
      this.userTalking = false;
      if (pushToTalk) this.pushToTalkOpen = false;
      this.queue?.setHold(false);
    }
  }

  private async handleVoiceError(e: unknown, pushToTalk: boolean) {
    const code = e instanceof VoiceError ? e.code : e instanceof VisionApiError ? "api" : "unknown";
    report("voice-error", code);
    if ((code === "service" || code === "api") && (!this.state.online || navigator.onLine === false)) {
      // Offline, not a browser without speech service: don't switch to recording for good.
      this.patch({ mic: "off" });
      if (pushToTalk) this.say(this.offlineText, "answer");
      return;
    }
    if (code === "service" && !this.forceRecorder && recordingSupported() && this.state.status?.canTranscribe) {
      // The browser has the API but its speech service doesn't answer (Brave, Chromium builds).
      this.forceRecorder = true;
      this.pushToTalkOpen = false;
      this.queue?.setHold(false);
      if (!pushToTalk) {
        this.say(this.t.voiceFallback, "status");
        return;
      }
      // The user is waiting to talk: only this notice plays first. It must finish, or the recording
      // would capture it, but routine speech must not keep the microphone closed behind it.
      this.queue?.stop();
      this.say(this.t.voiceFallback, "status");
      this.queue?.setHold(true);
      while (this.queue?.busy) await sleep(100);
      await this.listenOnce(true);
      return;
    }
    if (code === "api") {
      this.patch({ mic: "off" });
      if (pushToTalk || !this.queue?.busy) this.say(this.failureText(e as VisionApiError, this.t), "answer");
      return;
    }
    if (code === "unknown") {
      // Usually a brief conflict with a recognition session that hasn't fully ended.
      this.patch({ mic: "off" });
      if (pushToTalk) this.say(this.t.questionFailed, "answer");
      return;
    }
    const denied = code === "denied";
    this.stopAssistantLoop();
    this.patch({ mic: denied ? "denied" : "unavailable" });
    this.feedback("error");
    this.say(denied ? this.t.micDenied : code === "missing" ? this.t.micMissing : this.t.voiceUnavailable, "answer");
  }

  private async handleUtterance(text: string) {
    const heard = text.trim();
    if (heard.length < 2) return;
    this.patch({ lastHeard: heard });
    const command = parseCommand(heard);
    if (command && this.runCommand(command)) return;
    await this.ask(heard);
  }

  /** False when the words should go to the model as a question after all. */
  private runCommand(command: VoiceCommand): boolean {
    switch (command) {
      case "stop-speech": return (this.stopSpeech(), true);
      case "repeat": return (this.repeat(), true);
      case "pause": return (this.pause(), true);
      case "resume": return (this.resume(), true);
      case "camera-off": return (this.stopCamera(), true);
      case "camera-on": return (void this.startCamera(), true);
      case "assistant-off": return (this.stopAssistant(), true);
      case "help": return (this.help(), true);
      case "back": return (this.goBack(), true);
      case "front":
      case "describe":
      case "read":
      case "identify":
        return (void this.runTask(command), true);
      case "read-all": return (this.readAll(), true);
      case "auto-on": return (this.updateSettings({ autoDescribe: true }), true);
      case "auto-off": return (this.updateSettings({ autoDescribe: false }), true);
      case "live-off":
        if (this.state.liveNotice) return (this.goBack(), true);
        return (this.stopLive(), true);
      case "emergency": return (this.openSheet("emergency"), true);
      case "call": return (this.requestCall(), true);
      case "louder": return (this.step("volume", 1), true);
      case "quieter": return (this.step("volume", -1), true);
      case "faster": return (this.step("rate", 1), true);
      case "slower": return (this.step("rate", -1), true);
      case "yes":
        if (this.pendingRead) return (this.acceptReadNotice(), true);
        if (this.state.liveNotice) return (void this.startLive(), true);
        // Otherwise a follow-up («yes, read it») for the model.
        if (!this.state.needsConsent) return false;
        this.acceptConsent();
        return true;
      default: {
        const lang = command.slice(5) as SpeechLang;
        this.updateSettings({ language: lang });
        return true;
      }
    }
  }

  // --- live conversation ---------------------------------------------------------------------------
  // Microphone audio and camera frames stream to Gemini Live; it answers with a female Tunisian
  // voice as it thinks. The on-device detector keeps giving its warnings meanwhile.

  toggleLive() {
    if (this.liveSession) this.stopLive();
    else void this.startLive();
  }

  /** Must start in a click or key press: the audio output is unlocked there. */
  async startLive() {
    this.unlockAudio();
    if (this.liveSession) return;
    // The live conversation is Gemini Live: never opened while Nadhra AI is selected.
    if (this.nadhra) {
      this.pendingLive = false;
      this.patch({ liveNotice: false });
      return this.refuseNadhra();
    }
    if (!hasConsent()) {
      this.pendingLive = true;
      this.patch({ needsConsent: true, sheet: "none" });
      this.say(this.t.privacy, "answer");
      return;
    }
    // Its own consent: voice and a picture a second go to Google for as long as it runs. Nothing is
    // sent before «موافق» or a second press of the button.
    if (!hasLiveConsent()) {
      if (!this.state.liveNotice) {
        this.patch({ liveNotice: true });
        this.queue?.stop();
        this.say(this.t.liveNotice, "answer");
        return;
      }
      setLiveConsent(true);
      this.patch({ liveNotice: false });
    }
    let audio: LiveAudio;
    try {
      audio = new LiveAudio((playing) => this.patch({ live: { ...this.state.live, playing } })); // in the gesture
    } catch {
      this.say(this.t.liveFailed, "answer");
      return;
    }
    // The microphone is the live session's now.
    if (this.state.assistantOn) this.stopAssistantLoop();
    this.voiceInput?.abort();
    this.scanCtrl?.abort();
    this.questionCtrl?.abort();
    this.queue?.stop();
    const gen = ++this.liveGen;
    audio.setVolume(this.state.settings.volume);
    this.liveAudio = audio;
    this.lastLiveFrameAt = -Infinity;
    this.lastLiveGray = null;
    this.liveNewUserTurn = true;
    this.liveNewAnswer = true;
    this.liveCheckedChars = 0;
    this.liveMuted = false;
    this.liveCommandChecked = true;
    this.patch({ live: { ...LIVE_OFF, status: "connecting" } });

    if (this.state.camera !== "on") await this.startCamera(true);
    if (gen !== this.liveGen) return;

    const session = new LiveSession({ lang: this.lang, facing: this.state.facing }, {
      status: (status, detail) => this.onLiveStatus(gen, status, detail),
      audio: (pcm) => {
        if (gen !== this.liveGen || !this.liveAudio) return;
        if (this.liveNewAnswer) this.startLiveAnswer();
        if (this.checkLiveCommand()) return;
        if (this.liveMuted) return; // this answer promised safety: the correction replaced it
        this.liveAudio.play(pcm);
      },
      interrupted: () => {
        this.liveAudio?.flush();
        this.liveMuted = false;
      },
      userSpeechStart: () => this.sendLiveFrame(false),
      userText: (piece) => {
        if (gen !== this.liveGen) return;
        const user = this.liveNewUserTurn ? piece.trimStart() : this.state.live.user + piece;
        if (this.liveNewUserTurn) this.liveCommandChecked = false;
        this.liveNewUserTurn = false;
        this.liveNewAnswer = true;
        this.patch({ live: { ...this.state.live, user }, lastHeard: user });
        this.checkLiveStop(user);
      },
      aiText: (piece) => {
        if (gen !== this.liveGen) return;
        if (this.liveNewAnswer) this.startLiveAnswer();
        if (this.checkLiveCommand()) return;
        const ai = this.state.live.ai + (this.state.live.ai ? piece : piece.trimStart());
        this.patch({ live: { ...this.state.live, ai } });
        this.checkLiveSafety(false);
      },
      turnComplete: () => {
        if (gen !== this.liveGen) return;
        if (this.checkLiveCommand()) return;
        this.checkLiveSafety(true);
        this.liveMuted = false;
        this.liveNewUserTurn = true;
        this.liveNewAnswer = true;
        const text = this.state.live.ai.trim();
        // "Repeat" and the screen reader get the answer; the voice already said it.
        if (text) this.patch({ lastSpoken: text, ...(this.state.settings.screenReaderEcho ? { announce: { text, urgent: false, id: this.state.announce.id + 1 } } : {}) });
      },
      latency: (ms) => gen === this.liveGen && this.patch({ live: { ...this.state.live, latencyMs: ms } }),
    });
    this.liveSession = session;

    try {
      await audio.startMic({
        chunk: (pcm) => session.sendAudio(pcm),
        speechStart: () => {
          if (gen !== this.liveGen) return;
          // Talking over the answer: quieter at once; Gemini confirms and it stops (`interrupted`).
          if (this.liveAudio?.isPlaying) this.liveAudio.setDucked(true);
          // The user's words come first: a status sentence stops, and the rest waits (warnings don't).
          if (this.queue?.busy && !this.queue.hasAtLeast("warning")) this.queue.stop();
          this.queue?.setHold(true);
          this.sendLiveFrame(false);
          this.patch({ live: { ...this.state.live, userTalking: true } });
        },
        speechEnd: (at) => {
          if (gen !== this.liveGen) return;
          session.markSpeechEnd(at);
          this.liveAudio?.setDucked(false); // a cough isn't an interruption
          this.queue?.setHold(false);
          this.patch({ live: { ...this.state.live, userTalking: false } });
        },
      });
    } catch (e) {
      if (gen !== this.liveGen) return;
      const code = e instanceof MicError ? e.code : "unknown";
      this.stopLive(true);
      this.patch({ mic: code === "denied" ? "denied" : this.state.mic });
      this.feedback("error");
      this.say(code === "denied" ? this.t.micDenied : code === "not-found" ? this.t.micMissing : this.t.liveFailed, "answer");
      return;
    }
    if (gen !== this.liveGen) return;
    try {
      await session.start();
    } catch {
      if (gen !== this.liveGen) return;
      this.stopLive(true);
      this.feedback("error");
      this.say(this.t.liveFailed, "answer");
    }
  }

  /**
   * "Stop" in a live conversation acts as soon as it is heard, on the partial transcript of the
   * user's words: no more voice or pictures are sent. Not when the model starts answering.
   */
  private checkLiveStop(user: string): boolean {
    const stop = parseCommand(user);
    if (stop !== "live-off" && stop !== "assistant-off" && stop !== "camera-off") return false;
    this.stopLive();
    if (stop === "camera-off") this.stopCamera();
    return true;
  }

  /** The first sound or word of a new live answer. */
  private startLiveAnswer() {
    this.liveNewAnswer = false;
    this.liveCheckedChars = 0;
    this.liveMuted = false;
    this.patch({ live: { ...this.state.live, ai: "" } });
  }

  /**
   * What the user said in the live conversation, once their turn is over. Gemini would answer
   * «نجدة» with words; the Emergency page must open instead, and «سكّر» must end the conversation.
   * True when the conversation was ended for it.
   */
  private checkLiveCommand(): boolean {
    if (this.liveCommandChecked) return false;
    this.liveCommandChecked = true;
    const command = parseCommand(this.state.live.user);
    if (command === "emergency" || command === "call") {
      this.stopLive(true);
      this.openSheet("emergency");
      // Hands-free: «عيّط» then selects the call button.
      if (!this.state.assistantOn && this.pickVoiceInput()) {
        this.patch({ assistantOn: true });
        void this.assistantLoop(++this.loopGen);
      }
      return true;
    }
    if (command === "assistant-off" || command === "camera-off" || command === "live-off") {
      this.stopLive();
      if (command === "camera-off") this.stopCamera();
      return true;
    }
    // The answer to the notice about documents, said during a live conversation.
    if (this.pendingRead && (command === "yes" || command === "back")) {
      this.liveMuted = true;
      this.liveAudio?.flush();
      if (command === "yes") this.acceptReadNotice();
      else this.goBack();
      return true;
    }
    // Reading, and anything about medicines, is not left to the live model: its answer is cut and
    // the checked reading (or the refusal) is said instead.
    const user = this.state.live.user;
    if (command === "read" || command === "read-all" || isMedicalQuestion(user)) {
      this.liveMuted = true;
      this.liveAudio?.flush();
      report("live-medical");
      if (command === "read-all") this.readAll();
      else if (command === "read") void this.readDocument();
      else if (this.state.camera === "on" || this.activeDocument()) void this.readDocument(user);
      else this.say(this.t.doc.liveMedical, "answer");
      return true;
    }
    return false;
  }

  /**
   * Gemini Live speaks before its words can be checked, so a promise of safety («الطريق فارغ»,
   * «you can cross») can't be removed like in other answers. As soon as such a sentence shows up
   * in its transcript, the rest of that answer is cut and the correction is said instead.
   */
  private checkLiveSafety(final: boolean) {
    if (this.liveMuted) return;
    const ai = this.state.live.ai;
    // Only finished sentences, unless the answer is complete.
    const end = final ? ai.length : Math.max(ai.lastIndexOf("."), ai.lastIndexOf("!"), ai.lastIndexOf("؟"), ai.lastIndexOf("?")) + 1;
    if (end <= this.liveCheckedChars) return;
    const fresh = ai.slice(this.liveCheckedChars, end);
    this.liveCheckedChars = end;
    const sentences = splitSentences(fresh);
    // A dose from the live model is cut like a promise of safety: it was never checked.
    if (sentences.some(mentionsDose)) {
      this.liveMuted = true;
      this.liveAudio?.flush();
      report("live-medical");
      this.say(this.t.doc.liveMedical, "warning");
      return;
    }
    if (!sentences.some(isSafetyClaim)) return;
    this.liveMuted = true;
    this.liveAudio?.flush();
    report("live-safety-claim");
    this.say(this.t.pathCaveat, "warning");
  }

  private onLiveStatus(gen: number, status: LiveStatus, detail?: string) {
    if (gen !== this.liveGen) return;
    const before = this.state.live.status;
    this.patch({ live: { ...this.state.live, status, model: this.liveSession?.model ?? "", voice: this.liveSession?.voice ?? "" } });
    if (status === "open") {
      // A new connection has no current view yet (after a reconnect, an old one at best).
      this.lastLiveFrameAt = -Infinity;
      this.sendLiveFrame(true);
      if (before === "connecting") {
        this.feedback("on");
        this.lastLiveReminderAt = Date.now();
        this.say(this.t.liveOn, "status");
      } else if (before === "reconnecting") {
        this.say(this.t.liveBack, "status");
      }
    } else if (status === "reconnecting" && before === "open") {
      report("live-reconnect", detail && /^[a-z0-9-]{1,40}$/.test(detail) ? detail : "other");
      this.liveAudio?.flush();
      // The routine reconnect every ~10 minutes is announced by the server and is seamless.
      if (this.liveSession && this.state.online) setTimeout(() => {
        if (gen === this.liveGen && this.state.live.status === "reconnecting") this.say(this.t.liveReconnecting, "status");
      }, 2_500);
      else this.say(this.t.liveReconnecting, "status");
    } else if (status === "failed") {
      report("live-failed", detail && /^[a-z0-9-]{1,40}$/.test(detail) ? detail : "other");
      this.stopLive(true);
      this.feedback("error");
      this.say(detail === "quota-exhausted" ? this.t.quotaExhausted : detail === "offline-mode" ? this.t.offlineMode : this.t.liveFailed, "answer");
    }
  }

  /** `quiet`: no tone or sentence (the page is hidden, or another message follows). */
  stopLive(quiet = false) {
    this.liveGen++;
    this.pendingLive = false;
    const had = !!this.liveSession || !!this.liveAudio;
    this.liveSession?.stop();
    this.liveSession = null;
    this.liveAudio?.close();
    this.liveAudio = null;
    this.queue?.setHold(false);
    this.patch({ live: LIVE_OFF });
    if (had && !quiet) {
      this.feedback("off");
      this.say(this.t.liveOff, "status");
    }
  }

  /**
   * Called on every camera tick while live. At most one frame a second (the API's limit), and only
   * when the view changed or the last one is getting old, so a still scene costs almost nothing.
   */
  private liveFrameTick(gray: Uint8Array, now: number) {
    const since = now - this.lastLiveFrameAt;
    if (since < LIVE_MIN_FRAME_GAP_MS) return;
    const changed = this.lastLiveGray ? changedFraction(this.lastLiveGray, gray) : 1;
    if (changed < LIVE_CHANGE_THRESHOLD && since < LIVE_HEARTBEAT_FRAME_MS) return;
    if (this.sendLiveFrame(true)) this.lastLiveGray = gray;
  }

  /** `force`: send even if the last frame was sent a moment ago (but never twice in 500 ms). */
  private sendLiveFrame(force: boolean): boolean {
    const session = this.liveSession;
    const source = this.source;
    if (!session?.isOpen || !source || this.state.camera !== "on" || document.hidden || this.docHold) return false;
    const now = Date.now();
    if (now - this.lastLiveFrameAt < (force ? LIVE_SPEECH_FRAME_GAP_MS : LIVE_MIN_FRAME_GAP_MS / 2)) return false;
    const frame = source.capture(LIVE_FRAME.maxSide, LIVE_FRAME.quality);
    if (!frame || !session.sendFrame(frame.base64)) return false;
    this.lastLiveFrameAt = now;
    this.patch({ live: { ...this.state.live, framesSent: this.state.live.framesSent + 1 } });
    return true;
  }

  // --- settings --------------------------------------------------------------------------------

  updateSettings(p: Partial<VisionSettings>) {
    const before = this.state.settings;
    // Automatic descriptions are a Gemini feature: with Nadhra AI they can't be turned on (said why).
    if (this.nadhra && p.autoDescribe === true && p.provider === undefined) {
      const { autoDescribe: _refused, ...rest } = p;
      this.refuseNadhra();
      if (!Object.keys(rest).length) return;
      p = rest;
    }
    const settings = { ...before, ...p };
    saveVisionSettings(settings);
    this.patch({ settings });
    if (p.provider !== undefined && providerOf(settings) !== providerOf(before)) {
      this.switchProvider(providerOf(settings));
      return;
    }
    if (p.language && p.language !== before.language) {
      // Earlier sentences were in the other language: the model mustn't continue in it.
      this.recent = [];
      this.history = [];
      this.lastAnswerLang = undefined;
      this.document = null;
      this.gate.clear();
      this.queue?.stop();
      this.tts?.setLanguage?.(p.language);
      this.queue?.resetLanguage();
      this.patch({ voice: this.tts?.voiceInfo() ?? null, ttsFailed: false });
      this.say(this.t.languageSet, "answer");
    }
    if (typeof p.volume === "number") this.liveAudio?.setVolume(p.volume);
    if (typeof p.autoDescribe === "boolean" && p.autoDescribe !== before.autoDescribe) {
      if (!p.autoDescribe) this.scanCtrl?.abort();
      else this.lastScanAt = -Infinity; // describe at once
      if (this.state.camera === "on" && !this.paused && (this.state.analysis === "watching" || this.state.analysis === "manual")) this.patch({ analysis: this.idleAnalysis() });
      this.queue?.stop();
      this.say(p.autoDescribe ? this.t.autoOn : this.t.autoOff, "status");
    }
    // The instructions are fixed for a live session: a new language needs a new one.
    if (p.language && p.language !== before.language && this.liveSession) {
      this.stopLive(true);
      void this.startLive();
    }
    if (p.facing) {
      this.tracker.clear();
      this.gate.clear();
      this.patch({ facing: this.resolveFacing() });
    }
  }

  /**
   * The user chose the other AI, explicitly, in Settings. Never done by the app on its own.
   * To Nadhra: everything that sends stops at once (scans, questions, voice, live), and the network
   * guard closes. To Gemini: today's behaviour again, with today's consent asked first if it hasn't
   * been given (the camera, if it was running without it, waits for it).
   */
  private switchProvider(to: AiProvider) {
    this.queue?.stop();
    if (to === "nadhra") {
      this.scanCtrl?.abort();
      this.questionCtrl?.abort();
      if (this.liveSession) this.stopLive(true);
      if (this.state.assistantOn) this.stopAssistantLoop();
      else if (this.listening) this.voiceInput?.abort();
      this.voiceInput = null;
      this.pendingRead = null;
      this.pendingLive = false;
      this.pendingTask = null;
      this.motionFrames = [];
      this.applyProvider("nadhra");
      this.patch({ needsConsent: false, liveNotice: false, ...(this.state.camera === "on" && !this.paused ? { analysis: "local" as const } : {}) });
      this.nadhraNoticeSaid = true; // the confirmation below says the same
      this.say(this.t.nadhra.selected, "answer");
      return;
    }
    this.applyProvider("gemini");
    this.say(this.t.nadhra.geminiSelected, "answer");
    if (this.state.camera === "on" || this.state.camera === "starting") {
      if (!hasConsent()) {
        // Started under Nadhra without the notice about Google: it is asked before any picture goes out.
        this.releaseCamera();
        this.feedback("off");
        this.patch({ needsConsent: true, sheet: "none" });
        this.say(this.t.privacy, "answer");
        return;
      }
      this.resetAnalysisState();
      if (!this.paused) this.patch({ analysis: this.idleAnalysis() });
    }
  }
}
