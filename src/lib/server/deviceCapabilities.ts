// What the machine running the server can do: the PC today, the ARM device in the glasses later.
// Server only. Read-only facts (architecture, CPU, memory, temperature) plus one network fact, whether
// the internet is reachable, for routing in hybrid mode (router.ts).
//
// The internet probe runs only in hybrid mode: in cloud mode nothing changes, and in offline mode
// nothing leaves the device, not even a probe. It is a plain GET to INTERNET_PROBE_URL; any HTTP answer
// counts as reachable. The default is the Gemini API host without a key, which answers 404 and uses
// no quota.
import { readdirSync, readFileSync } from "node:fs";
import { arch, cpus, freemem, loadavg, platform, totalmem } from "node:os";
import { aiMode, type AiMode } from "../ai/router.ts";

const DEFAULT_PROBE_URL = "https://generativelanguage.googleapis.com/";
const PROBE_TIMEOUT_MS = 3_000;
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

/** One probe, shared by concurrent callers. Resolves true on any HTTP answer, false on a network failure or timeout. */
export function probeInternet(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  probing ??= (async () => {
    const url = process.env.INTERNET_PROBE_URL?.trim() || DEFAULT_PROBE_URL;
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
 * For routing: in hybrid mode, the last known answer (undefined until the first probe has finished),
 * and a fresh probe in the background when it is stale. Other modes never probe and return undefined.
 */
export function internetForRouting(mode: AiMode, now = Date.now()): boolean | undefined {
  if (mode !== "hybrid") return undefined;
  if (!known || now - known.at > PROBE_TTL_MS) void probeInternet().catch(() => {});
  return known ? known.ok : undefined;
}

/** For tests. */
export function resetDeviceCapabilities(state: { internet?: boolean; at?: number } = {}) {
  probing = null;
  known = state.internet === undefined ? null : { ok: state.internet, at: state.at ?? Date.now() };
}
