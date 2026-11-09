// Short tones that say what happened without words: a blind user hears the state change.
export type Earcon = "on" | "off" | "listen" | "urgent" | "error" | "alive";

const TONES: Record<Earcon, [frequency: number, startSec: number, durationSec: number][]> = {
  on: [[523, 0, 0.1], [784, 0.1, 0.14]],
  off: [[784, 0, 0.1], [523, 0.1, 0.14]],
  listen: [[880, 0, 0.12]],
  urgent: [[988, 0, 0.1], [988, 0.15, 0.1], [988, 0.3, 0.1]],
  error: [[220, 0, 0.28]],
  alive: [[660, 0, 0.05]],
};

export class Earcons {
  private ctx: AudioContext | null = null;

  /** Call during a key press or tap: browsers keep audio locked until then. */
  unlock() {
    try {
      if (!this.ctx) {
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (Ctx) this.ctx = new Ctx();
      }
      void this.ctx?.resume().catch(() => {});
    } catch {}
  }

  /** scale: the speech volume setting, so tones stay in proportion to the voice. */
  play(name: Earcon, scale = 1) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return;
    try {
      // An urgent warning stays audible even at the lowest volume setting.
      const volume = (name === "alive" ? 0.04 : 0.15) * (name === "urgent" ? Math.max(scale, 0.8) : scale);
      for (const [frequency, start, duration] of TONES[name]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const at = ctx.currentTime + start;
        osc.frequency.value = frequency;
        gain.gain.setValueAtTime(volume, at);
        gain.gain.exponentialRampToValueAtTime(0.001, at + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(at);
        osc.stop(at + duration);
      }
    } catch {}
  }

  close() {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
