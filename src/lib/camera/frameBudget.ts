// Adaptive processing rate for the on-device detector on slow devices.
// MediaPipe runs on the main thread: if detection takes most of the time, the page stutters and
// buttons respond late. This limits the fraction of main-thread time it can use (duty cycle): the
// next frame is processed only after avgMs / maxDuty has passed since the previous one.

export class FrameBudget {
  avgMs = 0;
  private n = 0;
  private lastAt = -Infinity;
  /** max fraction of wall time spent tracking (0..1) */
  readonly maxDuty: number;
  /** upper bound for the interval between processed frames */
  readonly maxIntervalMs: number;
  /** measurements needed before throttling (first frames include warm-up/compilation) */
  readonly warmup: number;

  constructor(maxDuty = 0.6, maxIntervalMs = 140, warmup = 10) {
    this.maxDuty = maxDuty;
    this.maxIntervalMs = maxIntervalMs;
    this.warmup = warmup;
  }

  minIntervalMs(): number {
    if (this.n < this.warmup) return 0;
    return Math.min(this.maxIntervalMs, this.avgMs / this.maxDuty);
  }

  shouldProcess(now: number): boolean {
    return now - this.lastAt >= this.minIntervalMs();
  }

  record(ms: number, now: number) {
    this.n++;
    this.avgMs = this.n === 1 ? ms : 0.9 * this.avgMs + 0.1 * ms;
    this.lastAt = now;
  }
}
