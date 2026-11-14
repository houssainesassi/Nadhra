// What the machine running the server can do: the PC today, the ARM device in the glasses later.
// Server only. Read-only facts (architecture, CPU, memory, temperature) plus one network fact, whether
// the internet is reachable, for routing in hybrid mode (router.ts).
//
// Whether the internet is reachable matters only in hybrid mode. By default it is learned PASSIVELY,
// from the cloud requests the user actually makes with Gemini (noteCloudReachable, called by
// ai/http.ts): a network failure means "down" for a minute, any HTTP answer means "up". Nothing is
// ever sent just to check, so choosing Nadhra never causes a request to Google or anyone else.
// An active probe exists only when the operator opts in with INTERNET_PROBE_URL (a plain GET; any HTTP
// answer counts as reachable): point it at something neutral, such as the local router.
import { readdirSync, readFileSync } from "node:fs";
import { arch, cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { aiMode, type AiMode } from "../ai/router.ts";

const PROBE_TIMEOUT_MS = 3_000;
/** A reachability learned from a real cloud request is trusted this long, then unknown again. */
const PASSIVE_TTL_MS = 60_000;
/** The opt-in probe target, or null: no probe at all. */
const probeUrl = () => process.env.INTERNET_PROBE_URL?.trim() || null;
/** A known answer is reused this long; after that the next caller starts a new probe in the background. */
const PROBE_TTL_MS = 30_000;

export interface DeviceInfo {
  arch: string;
  platform: string;
  cpuModel: string | null;
  cpuCount: number;
  /** 1-minute load average divided by the CPU count: about 1 means every core is busy. */
  load: number | null;
  memTotalMB: number;
  /** MemAvailable from /proc/meminfo (what can be used without swapping), else the OS's free memory. */
  memAvailableMB: number;
  /** Hottest thermal zone in °C, or null where the system doesn't report one. */
  temperatureC: number | null;
  node: string;
  aiMode: AiMode;
  /** true / false from the last probe (hybrid mode only), null when not probed or not yet known. */
  internet: boolean | null;
}

export interface ReadDeps {
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
}

const defaultRead = (p: string) => readFileSync(p, "utf8");
const defaultDir = (p: string) => readdirSync(p);

/** MemAvailable in MB from /proc/meminfo text, or null. */
export function parseMemAvailableMB(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

/** The hottest thermal zone in °C (sysfs gives millidegrees), or null. Implausible values are ignored. */
export function hottestZoneC(deps: ReadDeps = {}): number | null {
  const read = deps.readFile ?? defaultRead;
  const dir = deps.readDir ?? defaultDir;
  let zones: string[];
  try {
    zones = dir("/sys/class/thermal").filter((z) => z.startsWith("thermal_zone"));
  } catch {
    return null;
  }
  let max: number | null = null;
  for (const z of zones) {
    try {
      const c = Number(read(`/sys/class/thermal/${z}/temp`).trim()) / 1000;
      if (Number.isFinite(c) && c > -40 && c < 150) max = max === null ? c : Math.max(max, c);
    } catch {}
  }
  return max === null ? null : Math.round(max * 10) / 10;
}

export function deviceInfo(deps: ReadDeps = {}): DeviceInfo {
  const read = deps.readFile ?? defaultRead;
  let available: number | null = null;
  try {
    available = parseMemAvailableMB(read("/proc/meminfo"));
  } catch {}
  const cpu = cpus();
  const count = cpu.length || 1;
  const load = platform() === "win32" ? null : Math.round((loadavg()[0] / count) * 100) / 100;
  return {
    arch: arch(),
    platform: platform(),
    cpuModel: cpu[0]?.model?.trim() || null,
    cpuCount: count,
    load,
    memTotalMB: Math.round(totalmem() / 1024 / 1024),
    memAvailableMB: available ?? Math.round(freemem() / 1024 / 1024),
    temperatureC: hottestZoneC(deps),
    node: process.version,
    aiMode: aiMode(),
    internet: internetKnown(),
  };
}

// --- internet reachability (hybrid mode) --------------------------------------------------------

let known: { ok: boolean; at: number } | null = null;
let probing: Promise<boolean> | null = null;

/**
 * One probe, shared by concurrent callers. Resolves true on any HTTP answer, false on a network failure
 * or timeout. Without INTERNET_PROBE_URL nothing is sent: it resolves with what is already known
 * (true when nothing is), so the cloud is simply tried, as when the state is unknown.
 */
export function probeInternet(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const url = probeUrl();
  if (!url) return Promise.resolve(known ? known.ok : true);
  probing ??= (async () => {
    let ok = false;
    try {
      const res = await fetchImpl(url, { method: "GET", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      ok = true;
      void res.body?.cancel().catch(() => {});
    } catch {
      ok = false;
    }
    known = { ok, at: Date.now() };
    return ok;
  })().finally(() => (probing = null));
  return probing;
}

/** The last known answer, or null. Never probes. */
export function internetKnown(): boolean | null {
  return known ? known.ok : null;
}

/**
 * For routing: in hybrid mode, the last known answer, or undefined (unknown: the cloud may be tried).
 * Other modes return undefined. Without INTERNET_PROBE_URL the answer is passive only and expires after
 * a minute. With it (opt-in), a stale answer starts a background probe, unless `probe` is false (the
 * page's status request never starts one).
 */
export function internetForRouting(mode: AiMode, now = Date.now(), { probe = true }: { probe?: boolean } = {}): boolean | undefined {
  if (mode !== "hybrid") return undefined;
  if (!probeUrl()) return known && now - known.at <= PASSIVE_TTL_MS ? known.ok : undefined;
  if (probe && (!known || now - known.at > PROBE_TTL_MS)) void probeInternet().catch(() => {});
  return known ? known.ok : undefined;
}

/**
 * Called after every real cloud request (ai/http.ts): any HTTP answer means reachable, a network
 * failure means not. Aborted requests (timeouts, the user moving on) say nothing and aren't counted.
 */
export function noteCloudReachable(ok: boolean, now = Date.now()) {
  known = { ok, at: now };
}

/** For tests. */
export function resetDeviceCapabilities(state: { internet?: boolean; at?: number } = {}) {
  probing = null;
  known = state.internet === undefined ? null : { ok: state.internet, at: state.at ?? Date.now() };
}
