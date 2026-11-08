// Runs the assistant: camera, frame selection, cloud analysis, on-device warnings, speech and voice
// input. It has no React in it; components read its store and call its methods.
import { createStore } from "../store.ts";
import { HybridTts, type TtsEngine, type VoiceInfo } from "../speech/tts.ts";
import { FrameBudget } from "../camera/frameBudget.ts";
import { CameraError } from "../camera/camera.ts";
import { analyzeFrame, fetchVisionStatus, transcribeWav, VisionApiError } from "./client.ts";
import { parseCommand } from "./commands.ts";
import { createCameraSource, type CameraSource, type CapturedFrame } from "./cameraSource.ts";
import { Earcons } from "./earcons.ts";
import { changedFraction, classifyQuality, frameStats, rgbaToGray, type LocalQuality } from "./frameAnalysis.ts";
import { HazardTracker } from "./hazardTracker.ts";
import { hazardUrgency, WarningGate } from "./hazards.ts";
import { LocalDetector } from "./localDetector.ts";
import { CAMERA_ERRORS, SPEECH, warningPhrase } from "./phrases.ts";
import { backoffMs, decideScan } from "./scheduler.ts";
import { hasConsent, loadVisionSettings, saveVisionSettings, setConsent, type VisionSettings } from "./settings.ts";
import { isRepeat, SpeechQueue, type SpeechPriority } from "./speechQueue.ts";
import type { CameraFacing, Detection, Hazard, SceneAnalysis, SceneText, VisionMode, VisionStatus } from "./types.ts";
import { RecognitionInput, RecorderInput, recognitionSupported, recordingSupported, VoiceError, type VoiceInput } from "./voiceInput.ts";

const TICK_MS = 500;
const THUMB = { width: 160, height: 120 };
const SCAN_FRAME = { maxSide: 768, quality: 0.7 };
const QUESTION_FRAME = { maxSide: 1280, quality: 0.82 }; // small print stays readable
const MOTION_FRAME = { maxSide: 384, quality: 0.5 };
const MOTION_FRAME_EVERY_MS = 1_000;
/** A warning based on an older frame than this is no longer about "now". */
const MAX_RESULT_AGE_MS = 12_000;
const CAMERA_MOVING_FRACTION = 0.35;
const QUALITY_ANNOUNCE_AFTER_MS = 2_000;
const FAILURES_BEFORE_ANNOUNCE = 2;
const ALIVE_AFTER_SILENCE_MS = 45_000;
const RECENT_SPOKEN = 4;
const DISCLAIMER_LATEST_MS = 20_000;

export type CameraState = "off" | "starting" | "on" | "error";
export type AnalysisState = "off" | "watching" | "analyzing" | "paused" | "unavailable" | "poor-image" | "hidden";
export type MicState = "off" | "listening" | "processing" | "denied" | "unavailable";
export type DetectorState = "off" | "loading" | "ready" | "failed";

export interface VisionState {
  camera: CameraState;
  cameraError: string;
  analysis: AnalysisState;
  mic: MicState;
  assistantOn: boolean;
  speaking: boolean;
  needsConsent: boolean;
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
}

const INITIAL: VisionState = {
  camera: "off",
  cameraError: "",
  analysis: "off",
  mic: "off",
  assistantOn: false,
  speaking: false,
  needsConsent: false,
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
  settings: { rate: 0.9, facing: "auto", narration: true, screenReaderEcho: false },
  facing: "user",
  canSwitchCamera: false,
  lastLatencyMs: null,
  scansSent: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  private voiceInput: VoiceInput | null = null;
  private forceRecorder = false;
  private listening = false;
  private userTalking = false;
  private loopGen = 0;
  private spokeDisclaimer = false;
  private disclaimerDueAt = Infinity;
  /** The user pressed Ask: routine speech waits until they have finished. */
  private pushToTalkOpen = false;

  get state() {
    return this.store.get();
  }

  private patch(p: Partial<VisionState>) {
    this.store.set({ ...this.state, ...p });
  }

  attach(video: HTMLVideoElement) {
    this.video = video;
    const refreshVoice = () => this.patch({ voice: this.tts?.voiceInfo() ?? null });
    this.tts = new HybridTts(refreshVoice);
    this.queue = new SpeechQueue(this.tts, {
      rate: () => this.state.settings.rate,
      onSpeakingChange: (speaking) => {
        if (speaking) this.lastSoundAt = Date.now();
        this.patch({ speaking });
        // So an open microphone doesn't hear the assistant. While the user is talking it stays open.
        // After Ask, only an urgent warning can get here (see listenOnce), and that takes priority.
        if (speaking && this.listening && !this.userTalking) this.voiceInput?.abort();
      },
      onUtterance: (text, priority) => {
        const urgent = priority === "urgent";
        // Counts as said only once it actually plays: a dropped description may be given again.
        if (priority === "narration" && text !== SPEECH.thinking) {
          this.recent = [...this.recent, text].slice(-RECENT_SPOKEN);
          this.sayDisclaimerOnce(); // right after the first description
        }
        this.patch({ lastSpoken: text, lastUrgent: urgent, announce: { text, urgent, id: this.state.announce.id + 1 } });
      },
      onFailure: (text) => {
        // The voice failed, so the screen reader takes over this sentence and the following ones.
        this.earcons.play("error");
        this.patch({ ttsFailed: true, announce: { text, urgent: false, id: this.state.announce.id + 1 } });
      },
    });
    this.patch({ settings: loadVisionSettings(), voice: this.tts.voiceInfo() });
    void fetchVisionStatus().then((status) => this.patch({ status }));

    const onHide = () => this.shutdown();
    const onVisibility = () => {
      if (!document.hidden && this.state.camera === "on") void this.requestWakeLock();
    };
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

  private shutdown() {
    this.stopAssistantLoop();
    this.releaseCamera();
    this.queue?.stop();
  }

  private say(text: string, priority: SpeechPriority) {
    this.queue?.say(text, priority);
  }

  /** Must run inside a click or key press: browsers keep audio locked until then. */
  private unlockAudio() {
    this.tts?.unlock?.();
    this.earcons.unlock();
  }

  // --- camera ---------------------------------------------------------------------------------

  async startCamera() {
    this.unlockAudio();
    if (!this.video || this.state.camera === "on" || this.state.camera === "starting") return;
    if (!hasConsent()) {
      this.patch({ needsConsent: true });
      this.say(SPEECH.privacy, "answer");
      return;
    }
    this.patch({ camera: "starting", cameraError: "" });
    const source = createCameraSource("webcam", this.video);
    const session = this.session;
    try {
      await source.start();
    } catch (e) {
      const code = e instanceof CameraError ? e.code : "unknown";
      const message = CAMERA_ERRORS[code] ?? CAMERA_ERRORS.unknown;
      this.patch({ camera: "error", cameraError: message });
      this.earcons.play("error");
      this.say(message, "answer");
      return;
    }
    if (session !== this.session) return source.stop();

    source.onEnded(() => {
      this.releaseCamera();
      this.patch({ camera: "error", cameraError: SPEECH.cameraLost });
      this.earcons.play("error");
      this.say(SPEECH.cameraLost, "urgent");
    });
    this.source = source;
    this.paused = false;
    this.resetAnalysisState();
    this.patch({ camera: "on", analysis: "watching", facing: this.resolveFacing(), canSwitchCamera: false });
    this.earcons.play("on");
    this.say(SPEECH.cameraOn, "status");
    // The user came to hear what's in front of them, so the notice follows the first description,
    // but is never skipped if that description doesn't come.
    this.disclaimerDueAt = Date.now() + DISCLAIMER_LATEST_MS;
    void this.requestWakeLock();
    void navigator.mediaDevices.enumerateDevices().then((d) => {
      if (session === this.session) this.patch({ canSwitchCamera: d.filter((x) => x.kind === "videoinput").length > 1 });
    }).catch(() => {});
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    void this.startDetector(session);
  }

  acceptConsent() {
    this.unlockAudio();
    setConsent(true);
    this.patch({ needsConsent: false });
    this.queue?.stop();
    void this.startCamera();
  }

  declineConsent() {
    this.patch({ needsConsent: false });
    this.queue?.stop();
    this.say(SPEECH.consentRefused, "answer");
  }

  stopCamera() {
    this.unlockAudio();
    if (this.state.camera !== "on" && this.state.camera !== "starting") return;
    this.releaseCamera();
    this.earcons.play("off");
    this.queue?.stop();
    this.say(SPEECH.cameraOff, "status");
  }

  private releaseCamera() {
    this.session++;
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
      this.say(CAMERA_ERRORS.unknown, "answer");
    }
  }

  private resolveFacing(): CameraFacing {
    const { facing } = this.state.settings;
    if (facing !== "auto") return facing;
    // A laptop's webcam looks at the person using it. A phone reports its back camera as "environment".
    return this.source?.facing === "environment" ? "outward" : "user";
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
    this.say(SPEECH.disclaimer, "status");
  }

  private async requestWakeLock() {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {} // not available, or refused because the page is hidden: harmless
  }

  // --- scheduled analysis ---------------------------------------------------------------------

  pause() {
    this.unlockAudio();
    if (this.state.camera !== "on" || this.paused) return;
    this.paused = true;
    this.scanCtrl?.abort();
    this.tracker.clear();
    this.patch({ analysis: "paused", localHazards: [] });
    this.earcons.play("off");
    this.say(SPEECH.paused, "status");
  }

  resume() {
    this.unlockAudio();
    if (this.state.camera !== "on" || !this.paused) return;
    this.paused = false;
    this.lastScanAt = -Infinity; // describe the scene right away
    this.backoffUntil = 0;
    this.patch({ analysis: "watching" });
    this.earcons.play("on");
    this.say(SPEECH.resumed, "status");
  }

  get isPaused() {
    return this.paused;
  }

  private tick() {
    const source = this.source;
    if (!source || this.state.camera !== "on") return;
    const now = Date.now();
    if (now >= this.disclaimerDueAt) this.sayDisclaimerOnce();
    if (this.paused) return;
    if (document.hidden) {
      if (this.state.analysis !== "hidden") this.patch({ analysis: "hidden" });
      return;
    }
    const thumb = source.thumbnail(THUMB.width, THUMB.height);
    if (!thumb) return;
    const gray = rgbaToGray(thumb.rgba);
    const quality = classifyQuality(frameStats(gray, thumb.width, thumb.height));
    this.motion = this.lastGray ? changedFraction(this.lastGray, gray) : 0;
    this.lastGray = gray;
    this.blurSince = quality === "blurry" ? (this.blurSince ?? now) : null;
    this.trackQuality(quality, now);

    // The older frame sent with a request: the only evidence allowed for motion claims.
    const newestMotion = this.motionFrames[this.motionFrames.length - 1];
    if (!newestMotion || now - newestMotion.at >= MOTION_FRAME_EVERY_MS) {
      const frame = source.capture(MOTION_FRAME.maxSide, MOTION_FRAME.quality);
      if (frame) this.motionFrames.push(frame);
      if (this.motionFrames.length > 3) this.motionFrames.shift();
    }

    const decision = decideScan({
      now,
      lastScanAt: this.lastScanAt,
      changed: this.lastScanGray ? changedFraction(this.lastScanGray, gray) : 1,
      quality,
      inFlight: !!this.scanCtrl || !!this.questionCtrl,
      paused: false,
      hidden: false,
      backoffUntil: this.backoffUntil,
      unchangedStreak: this.unchangedStreak,
      speaking: !!this.queue?.busy,
      newObject: this.newObject,
      blurSince: this.blurSince,
    });
    if (decision.send) void this.scan(gray);
    else if (this.state.analysis === "hidden") this.patch({ analysis: "watching" });

    // A long silence shouldn't feel like the assistant has died: a soft tone says it's still running.
    if (now - this.lastSoundAt > ALIVE_AFTER_SILENCE_MS && !this.queue?.busy) {
      this.lastSoundAt = now;
      this.earcons.play("alive");
    }
  }

  private trackQuality(quality: LocalQuality, now: number) {
    const poor = quality === "dark" || quality === "bright" || quality === "flat";
    if (!poor) {
      if (this.poorQuality?.announced) {
        this.say(SPEECH.imageBack, "status");
        this.patch({ analysis: "watching" });
      }
      this.poorQuality = null;
      return;
    }
    if (this.poorQuality?.kind !== quality) this.poorQuality = { kind: quality, since: now, announced: this.poorQuality?.announced ?? false };
    if (!this.poorQuality.announced && now - this.poorQuality.since >= QUALITY_ANNOUNCE_AFTER_MS) {
      this.poorQuality.announced = true;
      this.patch({ analysis: "poor-image" });
      this.say(quality === "dark" ? SPEECH.tooDark : SPEECH.obstructed, "answer");
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
        recent: this.recent,
      }, ctrl.signal);
      if (session !== this.session || ctrl.signal.aborted) return;
      this.onScanSuccess();
      this.patch({ lastLatencyMs: res.latencyMs });
      this.unchangedStreak = res.analysis.changed ? 0 : this.unchangedStreak + 1;
      // Too old to be about "now". Better to say nothing than warn about where things used to be.
      if (Date.now() - frame.at <= MAX_RESULT_AGE_MS) this.applyAnalysis(res.analysis, "scan");
    } catch (e) {
      if (session !== this.session || ctrl.signal.aborted) return;
      this.onScanFailure(e);
    } finally {
      if (this.scanCtrl === ctrl) this.scanCtrl = null;
      if (session === this.session && !this.paused && !this.questionCtrl && this.state.analysis === "analyzing") {
        this.patch({ analysis: this.failures >= FAILURES_BEFORE_ANNOUNCE ? "unavailable" : "watching" });
      }
    }
  }

  private onScanSuccess() {
    this.failures = 0;
    this.backoffUntil = 0;
    if (this.downAnnounced) {
      this.downAnnounced = false;
      this.earcons.play("on");
      this.say(SPEECH.analysisBack, "status");
    }
  }

  private onScanFailure(e: unknown) {
    const err = e instanceof VisionApiError ? e : new VisionApiError(0, "network");
    this.failures++;
    this.backoffUntil = Date.now() + backoffMs(this.failures, err.retryAfterMs);
    if (err.code === "not-configured") {
      this.backoffUntil = Date.now() + 5 * 60_000;
      if (!this.downAnnounced) this.say(SPEECH.aiNotConfigured, "answer");
      this.downAnnounced = true;
    } else if (this.failures >= FAILURES_BEFORE_ANNOUNCE && !this.downAnnounced) {
      // The user must not believe they're still being watched over when they aren't.
      this.downAnnounced = true;
      this.earcons.play("error");
      this.say(SPEECH.analysisDown, "answer");
    }
  }

  private applyAnalysis(analysis: SceneAnalysis, mode: VisionMode) {
    this.patch({ environment: analysis.environment, detections: analysis.detections, texts: analysis.texts });
    this.speakHazards(analysis.hazards, mode === "question");
    if (mode === "question") {
      this.say(analysis.spoken, "answer");
      return;
    }
    if (this.state.settings.narration && analysis.changed && analysis.spoken && !isRepeat(analysis.spoken, this.recent)) {
      this.say(analysis.spoken, "narration");
    }
  }

  private speakHazards(hazards: Hazard[], urgentOnly: boolean) {
    const now = Date.now();
    for (const hazard of hazards) {
      const urgency = hazardUrgency(hazard);
      if (urgentOnly && urgency !== "urgent") continue;
      if (!this.gate.admit(hazard, urgency, now)) continue;
      if (urgency === "urgent") {
        this.earcons.play("urgent");
        try {
          navigator.vibrate?.([120, 60, 120]);
        } catch {}
        this.say(warningPhrase(hazard), "urgent");
      } else {
        this.say(warningPhrase(hazard), "answer");
      }
    }
  }

  // --- on-device detector ----------------------------------------------------------------------

  private async startDetector(session: number) {
    this.patch({ detector: "loading" });
    try {
      await this.detector.load();
    } catch (e) {
      // The cloud analysis still works without it, so the page keeps running.
      console.warn("[vision] on-device detector unavailable:", (e as Error).message);
      if (session === this.session) this.patch({ detector: "failed" });
      return;
    }
    if (session !== this.session) return;
    this.patch({ detector: "ready" });
    const run = () => {
      if (session !== this.session) return;
      const video = this.source?.videoElement();
      const now = performance.now();
      if (video && !this.paused && !document.hidden && this.budget.shouldProcess(now)) {
        try {
          const raw = this.detector.detect(video, now);
          this.budget.record(performance.now() - now, performance.now());
          const { hazards, newObject } = this.tracker.update(raw, now, { cameraMoving: this.motion > CAMERA_MOVING_FRACTION, facing: this.state.facing });
          if (newObject) this.newObject = true;
          this.speakHazards(hazards, false);
          if (JSON.stringify(hazards) !== JSON.stringify(this.state.localHazards)) this.patch({ localHazards: hazards });
        } catch (e) {
          console.warn("[vision] on-device detection failed:", (e as Error).message);
          this.patch({ detector: "failed" });
          return;
        }
      }
      this.detectTimer = setTimeout(run, Math.max(250, this.budget.minIntervalMs()));
    };
    run();
  }

  // --- questions -------------------------------------------------------------------------------

  async ask(question: string) {
    this.unlockAudio();
    const q = question.trim();
    if (!q) return;
    const source = this.source;
    if (!source || this.state.camera !== "on") {
      this.earcons.play("error");
      this.say(SPEECH.cameraNeeded, "answer");
      return;
    }
    const frame = source.capture(QUESTION_FRAME.maxSide, QUESTION_FRAME.quality);
    if (!frame) {
      this.say(SPEECH.questionFailed, "answer");
      return;
    }
    this.scanCtrl?.abort(); // the question is more important than the running description
    this.questionCtrl?.abort();
    const ctrl = new AbortController();
    const session = this.session;
    this.questionCtrl = ctrl;
    this.lastScanAt = frame.at;
    this.queue?.stop();
    this.say(SPEECH.thinking, "narration"); // the answer may cut this off
    this.patch({ analysis: "analyzing", scansSent: this.state.scansSent + 1 });
    try {
      const res = await analyzeFrame({
        mode: "question",
        image: frame.base64,
        ...this.pickMotionFrame(frame.at),
        cameraFacing: this.state.facing,
        question: q,
        history: this.history,
      }, ctrl.signal);
      if (session !== this.session || ctrl.signal.aborted) return;
      this.patch({ lastLatencyMs: res.latencyMs });
      this.applyAnalysis(res.analysis, "question");
      this.history = [...this.history, { q, a: res.analysis.spoken }].slice(-3);
    } catch (e) {
      if (session !== this.session || ctrl.signal.aborted) return;
      this.earcons.play("error");
      const err = e instanceof VisionApiError ? e : null;
      this.say(err?.code === "not-configured" ? SPEECH.aiNotConfigured : err?.status === 429 || err?.code === "rate-limited" ? SPEECH.rateLimited : SPEECH.questionFailed, "answer");
    } finally {
      if (this.questionCtrl === ctrl) this.questionCtrl = null;
      if (session === this.session && this.state.analysis === "analyzing") this.patch({ analysis: this.paused ? "paused" : "watching" });
    }
  }

  stopSpeech() {
    this.unlockAudio();
    this.queue?.stop();
  }

  repeat() {
    this.unlockAudio();
    this.queue?.stop();
    this.say(this.state.lastSpoken || SPEECH.nothingToRepeat, "answer");
  }

  // --- voice input -----------------------------------------------------------------------------

  private pickVoiceInput(): VoiceInput | null {
    const wantRecorder = this.forceRecorder || !recognitionSupported();
    if (!wantRecorder) {
      if (this.voiceInput?.kind !== "recognition") this.voiceInput = new RecognitionInput();
    } else if (recordingSupported() && this.state.status?.canTranscribe) {
      if (this.voiceInput?.kind !== "recording") this.voiceInput = new RecorderInput();
    } else {
      this.voiceInput = null;
    }
    return this.voiceInput;
  }

  toggleAssistant() {
    this.unlockAudio();
    if (this.state.assistantOn) {
      this.stopAssistantLoop();
      this.earcons.play("off");
      this.say(SPEECH.assistantOff, "status");
      return;
    }
    if (!this.pickVoiceInput()) {
      this.patch({ mic: "unavailable" });
      this.earcons.play("error");
      this.say(SPEECH.voiceUnavailable, "answer");
      return;
    }
    this.patch({ assistantOn: true });
    this.earcons.play("on");
    this.say(SPEECH.assistantOn, "status");
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
      await this.listenOnce(false);
      await sleep(250); // recognition needs a moment before it can restart
    }
  }

  /** The Ask button. With the assistant on, the microphone is already open: this only makes room. */
  async askByVoice() {
    this.unlockAudio();
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
      if (pushToTalk) this.say(SPEECH.voiceUnavailable, "answer");
      return;
    }
    this.listening = true;
    this.patch({ mic: "listening" });
    if (pushToTalk) {
      this.pushToTalkOpen = true;
      this.queue?.setHold(true);
      this.earcons.play("listen");
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
        if (pushToTalk) this.say(SPEECH.noQuestionHeard, "answer");
        return;
      }
      if (result.kind === "text") {
        this.patch({ mic: "off" });
        await this.handleUtterance(result.text);
        return;
      }
      this.patch({ mic: "processing" });
      const { text } = await transcribeWav(result.wavBase64);
      this.patch({ mic: "off" });
      if (text) await this.handleUtterance(text);
      else if (pushToTalk) this.say(SPEECH.noQuestionHeard, "answer");
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
    if (code === "service" && !this.forceRecorder && recordingSupported() && this.state.status?.canTranscribe) {
      // The browser has the API but its speech service doesn't answer (Brave, Chromium builds).
      this.forceRecorder = true;
      this.pushToTalkOpen = false;
      this.queue?.setHold(false);
      this.say(SPEECH.voiceFallback, "status");
      if (pushToTalk) {
        // Records only after the notice, or it would record itself and be cut off by it.
        while (this.queue?.busy) await sleep(100);
        await this.listenOnce(true);
      }
      return;
    }
    if (code === "api") {
      this.patch({ mic: "off" });
      if (pushToTalk || !this.queue?.busy) this.say(SPEECH.questionFailed, "answer");
      return;
    }
    if (code === "unknown") {
      // Usually a brief conflict with a recognition session that hasn't fully ended.
      this.patch({ mic: "off" });
      if (pushToTalk) this.say(SPEECH.questionFailed, "answer");
      return;
    }
    const denied = code === "denied";
    this.stopAssistantLoop();
    this.patch({ mic: denied ? "denied" : "unavailable" });
    this.earcons.play("error");
    this.say(denied ? SPEECH.micDenied : code === "missing" ? SPEECH.micMissing : SPEECH.voiceUnavailable, "answer");
  }

  private async handleUtterance(text: string) {
    const heard = text.trim();
    if (heard.length < 2) return;
    this.patch({ lastHeard: heard });
    switch (parseCommand(heard)) {
      case "stop-speech":
        return this.stopSpeech();
      case "repeat":
        return this.repeat();
      case "pause":
        return this.pause();
      case "resume":
        return this.resume();
      case "camera-off":
        return this.stopCamera();
      case "camera-on":
        return this.startCamera();
      case "assistant-off":
        return this.toggleAssistant();
      case "yes":
        if (this.state.needsConsent) return this.acceptConsent();
        break;
    }
    await this.ask(heard);
  }

  // --- settings --------------------------------------------------------------------------------

  updateSettings(p: Partial<VisionSettings>) {
    const settings = { ...this.state.settings, ...p };
    saveVisionSettings(settings);
    this.patch({ settings });
    if (p.facing) {
      this.tracker.clear();
      this.gate.clear();
      this.patch({ facing: this.resolveFacing() });
    }
  }
}
