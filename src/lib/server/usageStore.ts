// SERVER-ONLY. Counters for rate limits and daily budgets.
//
// By default they live in this server instance's memory. On a serverless host each instance has its
// own memory, so limits are per instance there: set UPSTASH_REDIS_REST_URL and
// UPSTASH_REDIS_REST_TOKEN to share them between instances (Upstash's REST API, no dependency).
// If the shared store can't be reached, the memory store answers instead, so a store outage never
// blocks the assistant; it is logged.
import "server-only";

export interface CounterHit {
  key: string;
  /** The counter expires this long after it was created. */
  ttlSec: number;
}

export interface UsageStore {
  readonly kind: "memory" | "upstash";
  /** Adds one to each counter and returns the new values, in order. */
  incr(hits: CounterHit[]): Promise<number[]>;
  /** Current values without changing them (0 when absent). */
  peek(keys: string[]): Promise<number[]>;
}

export class MemoryStore implements UsageStore {
  readonly kind = "memory";
  private counters = new Map<string, { n: number; expires: number }>();
  private maxKeys: number;
  private now: () => number;

  constructor(maxKeys = 50_000, now: () => number = Date.now) {
    this.maxKeys = maxKeys;
    this.now = now;
  }

  private live(key: string, now: number) {
    const c = this.counters.get(key);
    if (c && c.expires <= now) {
      this.counters.delete(key);
      return undefined;
    }
    return c;
  }

  async incr(hits: CounterHit[]): Promise<number[]> {
    const now = this.now();
    const out = hits.map(({ key, ttlSec }) => {
      const c = this.live(key, now) ?? { n: 0, expires: now + ttlSec * 1000 };
      c.n++;
      this.counters.delete(key); // re-insert: Map order = least recently used first
      this.counters.set(key, c);
      return c.n;
    });
    while (this.counters.size > this.maxKeys) this.counters.delete(this.counters.keys().next().value!);
    return out;
  }

  async peek(keys: string[]): Promise<number[]> {
    const now = this.now();
    return keys.map((k) => this.live(k, now)?.n ?? 0);
  }

  clear() {
    this.counters.clear();
  }
}

/** Upstash Redis over its REST pipeline endpoint: one HTTP request per call. */
export class UpstashStore implements UsageStore {
  readonly kind = "upstash";
  private url: string;
  private token: string;
  constructor(url: string, token: string) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
  }

  private async pipeline(commands: (string | number)[][]): Promise<unknown[]> {
    const res = await fetch(`${this.url}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { result?: unknown; error?: string }[];
    return data.map((d) => {
      if (d.error) throw new Error("command failed");
      return d.result;
    });
  }

  async incr(hits: CounterHit[]): Promise<number[]> {
    // INCR, then set the expiry only if the key has none yet (NX), so a window never slides.
    const commands = hits.flatMap(({ key, ttlSec }) => [["INCR", key], ["EXPIRE", key, ttlSec, "NX"]]);
    const results = await this.pipeline(commands);
    return hits.map((_, i) => Number(results[i * 2]) || 0);
  }

  async peek(keys: string[]): Promise<number[]> {
    if (!keys.length) return [];
    const [values] = await this.pipeline([["MGET", ...keys]]);
    return (values as (string | null)[]).map((v) => Number(v) || 0);
  }
}

/** Uses the shared store, and this instance's memory whenever the shared store fails. */
class FallbackStore implements UsageStore {
  readonly kind = "upstash";
  private primary: UsageStore;
  private backup: UsageStore;
  private warnedAt = 0;
  constructor(primary: UsageStore, backup: UsageStore) {
    this.primary = primary;
    this.backup = backup;
  }
  private warn() {
    if (Date.now() - this.warnedAt < 60_000) return;
    this.warnedAt = Date.now();
    console.warn("[usage] shared store unavailable; using this instance's memory");
  }
  async incr(hits: CounterHit[]) {
    try {
      return await this.primary.incr(hits);
    } catch {
      this.warn();
      return this.backup.incr(hits);
    }
  }
  async peek(keys: string[]) {
    try {
      return await this.primary.peek(keys);
    } catch {
      this.warn();
      return this.backup.peek(keys);
    }
  }
}

let store: UsageStore | null = null;

export function usageStore(): UsageStore {
  if (store) return store;
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  store = url && token ? new FallbackStore(new UpstashStore(url, token), new MemoryStore()) : new MemoryStore();
  return store;
}

/** For tests. */
export function setUsageStore(s: UsageStore | null) {
  store = s;
}
