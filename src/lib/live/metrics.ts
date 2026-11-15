// Measurements of one live conversation: speed, camera frames, connection stability, token use and
// an estimated cost. Pure logic with an injectable clock, tested in Node.
//
// Token counts come from Gemini's `usageMetadata` messages. Each one covers one model turn (the
// prompt count includes the context the model re-read for that turn), which is also how a turn is
// billed, so turns are added up. Prices are never assumed: they come from the server's
// configuration (GEMINI_LIVE_PRICE_*), and without them no cost is shown.

export type TokenModality = "audio" | "image" | "text" | "other";

/** US dollars per million tokens, by direction and modality. Missing entries count as unknown. */
export interface LivePricing {
  currency: string;
  input: Partial<Record<TokenModality, number>>;
  output: Partial<Record<TokenModality, number>>;
}

export interface UsageMetadata {
  promptTokenCount?: number;
  responseTokenCount?: number;
  totalTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  responseTokensDetails?: { modality?: string; tokenCount?: number }[];
}

export type FrameSkip = "unchanged" | "blurry" | "too-soon";

export interface LiveSummary {
  /** Start pressed → first connection ready. */
  connectMs: number | null;
  /** End of the user's first question → first audio of the answer. */
  firstAnswerMs: number | null;
  answers: number;
  latencyMedianMs: number | null;
  latencyP90Ms: number | null;
  durationMs: number;
  framesSent: number;
  framesPerMinute: number;
  framesSkipped: Record<FrameSkip, number>;
  /** Seconds of microphone audio sent and of answer audio received. */
  audioSentS: number;
  audioReceivedS: number;
  reconnects: number;
  reconnectReasons: Record<string, number>;
  proactiveCues: number;
  proactiveSpoken: number;
  tokens: { input: Record<TokenModality, number>; output: Record<TokenModality, number>; total: number; turns: number };
  /** Estimated cost of the session; null unless every token used has a configured price. */
  cost: number | null;
  /**
   * "ok": a complete estimate. "no-prices": no price configured. "incomplete": some tokens can't be
   * priced (a token type without a configured price, or tokens Gemini didn't break down by type), so
   * no cost is given: a partial sum would read as the whole.
   */
  costStatus: CostStatus;
  /** Tokens without a price (counted in the totals above, left out of any cost). */
  unpricedTokens: number;
  currency: string;
}

export type CostStatus = "ok" | "no-prices" | "incomplete";

const MODALITIES: TokenModality[] = ["audio", "image", "text", "other"];
const emptyTokens = (): Record<TokenModality, number> => ({ audio: 0, image: 0, text: 0, other: 0 });

function modalityOf(m: string | undefined): TokenModality {
  const s = (m ?? "").toUpperCase();
  if (s === "AUDIO") return "audio";
  if (s === "IMAGE" || s === "VIDEO") return "image";
  if (s === "TEXT") return "text";
  return "other";
}

const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/** Nearest-rank percentile of a list (0..100). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Tokens of a tally that the given prices don't cover. */
export function unpricedTokens(tokens: LiveSummary["tokens"], pricing: LivePricing | null): number {
  let n = 0;
  for (const dir of ["input", "output"] as const) for (const m of MODALITIES) if (tokens[dir][m] && typeof pricing?.[dir][m] !== "number") n += tokens[dir][m];
  return n;
}

/**
 * Cost of a token tally with the given prices. Null if a modality with tokens has no price: a
 * partial sum would look like a real total.
 */
export function estimateCost(tokens: LiveSummary["tokens"], pricing: LivePricing | null): number | null {
  if (!pricing) return null;
  let usd = 0;
  for (const dir of ["input", "output"] as const) {
    for (const m of MODALITIES) {
      const n = tokens[dir][m];
      if (!n) continue;
      const price = pricing[dir][m];
      if (typeof price !== "number") return null;
      usd += (n / 1_000_000) * price;
    }
  }
  return usd;
}

export class LiveMetrics {
  private readonly now: () => number;
  private startAt: number;
  private endAt: number | null = null;
  private openAt: number | null = null;
  private latencies: number[] = [];
  private framesSent = 0;
  private skipped: Record<FrameSkip, number> = { unchanged: 0, blurry: 0, "too-soon": 0 };
  private audioSentBytes = 0;
  private audioReceivedBytes = 0;
  private reconnects = 0;
  private reasons: Record<string, number> = {};
  private cues = 0;
  private cuesSpoken = 0;
  private tokens = { input: emptyTokens(), output: emptyTokens(), total: 0, turns: 0 };
  pricing: LivePricing | null = null;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
    this.startAt = now();
  }

  opened() {
    this.openAt ??= this.now();
  }

  answerLatency(ms: number) {
    if (Number.isFinite(ms) && ms >= 0) this.latencies.push(ms);
  }

  frameSent() {
    this.framesSent++;
  }

  frameSkipped(why: FrameSkip) {
    this.skipped[why]++;
  }

  /** 16-bit PCM bytes. */
  audioSent(bytes: number) {
    this.audioSentBytes += bytes;
  }

  audioReceived(bytes: number) {
    this.audioReceivedBytes += bytes;
  }

  reconnect(reason: string) {
    this.reconnects++;
    const key = reason.replace(/[^a-z0-9-]/gi, "").slice(0, 30) || "other";
    this.reasons[key] = (this.reasons[key] ?? 0) + 1;
  }

  proactiveCue() {
    this.cues++;
  }

  proactiveSpoken() {
    this.cuesSpoken++;
  }

  usage(u: UsageMetadata | undefined) {
    if (!u || typeof u !== "object") return;
    this.tokens.turns++;
    const add = (dir: "input" | "output", details: UsageMetadata["promptTokensDetails"], total: unknown) => {
      let detailed = 0;
      for (const d of Array.isArray(details) ? details : []) {
        const n = count(d?.tokenCount);
        this.tokens[dir][modalityOf(d?.modality)] += n;
        detailed += n;
      }
      // Tokens the details don't account for (or no details at all) are kept as "other".
      const rest = count(total) - detailed;
      if (rest > 0) this.tokens[dir].other += rest;
    };
    add("input", u.promptTokensDetails, u.promptTokenCount);
    add("output", u.responseTokensDetails, u.responseTokenCount);
    this.tokens.total += count(u.totalTokenCount) || count(u.promptTokenCount) + count(u.responseTokenCount);
  }

  end() {
    this.endAt ??= this.now();
  }

  summary(): LiveSummary {
    const end = this.endAt ?? this.now();
    const durationMs = Math.max(0, end - this.startAt);
    const tokens = { input: { ...this.tokens.input }, output: { ...this.tokens.output }, total: this.tokens.total, turns: this.tokens.turns };
    const cost = estimateCost(tokens, this.pricing);
    return {
      connectMs: this.openAt == null ? null : this.openAt - this.startAt,
      firstAnswerMs: this.latencies[0] ?? null,
      answers: this.latencies.length,
      latencyMedianMs: percentile(this.latencies, 50),
      latencyP90Ms: percentile(this.latencies, 90),
      durationMs,
      framesSent: this.framesSent,
      framesPerMinute: durationMs > 0 ? (this.framesSent / durationMs) * 60_000 : 0,
      framesSkipped: { ...this.skipped },
      audioSentS: this.audioSentBytes / (16_000 * 2),
      audioReceivedS: this.audioReceivedBytes / (24_000 * 2),
      reconnects: this.reconnects,
      reconnectReasons: { ...this.reasons },
      proactiveCues: this.cues,
      proactiveSpoken: this.cuesSpoken,
      tokens,
      cost,
      costStatus: !this.pricing ? "no-prices" : cost == null ? "incomplete" : "ok",
      unpricedTokens: this.pricing ? unpricedTokens(tokens, this.pricing) : 0,
      currency: this.pricing?.currency ?? "USD",
    };
  }
}

/** Running totals on this device (there are no accounts: "per user" means per device). */
export interface DeviceTotals {
  sessions: number;
  durationMs: number;
  tokens: number;
  /** Sum of the sessions whose cost could be estimated. */
  cost: number;
  /** Sessions without a cost (no price configured). */
  unpriced: number;
  since: number;
}

const TOTALS_KEY = "nadhra.liveTotals.v1";

export function addToTotals(prev: DeviceTotals | null, s: LiveSummary, now = Date.now()): DeviceTotals {
  const t = prev ?? { sessions: 0, durationMs: 0, tokens: 0, cost: 0, unpriced: 0, since: now };
  return {
    sessions: t.sessions + 1,
    durationMs: t.durationMs + s.durationMs,
    tokens: t.tokens + s.tokens.total,
    cost: t.cost + (s.cost ?? 0),
    unpriced: t.unpriced + (s.cost == null ? 1 : 0),
    since: t.since,
  };
}

export function loadTotals(): DeviceTotals | null {
  try {
    const raw = JSON.parse(localStorage.getItem(TOTALS_KEY) ?? "null") as DeviceTotals | null;
    return raw && typeof raw.sessions === "number" ? raw : null;
  } catch {
    return null;
  }
}

export function saveTotals(t: DeviceTotals) {
  try {
    localStorage.setItem(TOTALS_KEY, JSON.stringify(t));
  } catch {}
}

/** A short machine code for the anonymous report: duration and tokens, rounded. No content. */
export function summaryCode(s: LiveSummary): string {
  const min = Math.round(s.durationMs / 60_000);
  const kTok = Math.round(s.tokens.total / 1000);
  const lat = s.latencyMedianMs == null ? "na" : String(Math.round(s.latencyMedianMs / 100) * 100);
  return `m${min}.k${kTok}.l${lat}.r${s.reconnects}.f${Math.round(s.framesPerMinute)}`.slice(0, 48);
}
