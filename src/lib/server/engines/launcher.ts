// Nadhra engine launcher (step N2). Server only.
//
// Starts a local engine (a separate process with a small HTTP API on 127.0.0.1) when it is needed, and
// stops it after it has been idle, so a small device never holds every model in memory at once.
//
//   acquire(id) → starts the engine if it isn't running (once, however many callers ask at the same
//                 time), waits for its health check, and returns a handle; release() on the handle.
//   The last release starts the idle timer; when it ends, the engine is stopped.
//
// Refusals, each with a reason the caller can say out loud: unknown engine, research-only engine,
// wrong processor architecture, not enough free memory (checked BEFORE starting, so the system never
// swaps or freezes), the program can't be started, no healthy answer in time, a crash.
//
// Privacy isolation: an engine gets a minimal environment (no API keys, tokens or other secrets of this
// server), is asked to listen on 127.0.0.1 only, and the launcher only ever contacts 127.0.0.1. It never
// runs a command through a shell.
//
// N2: no real engine is configured (engines/manifests is empty) and nothing calls the launcher yet:
// Nadhra still declares no task (router.ts NADHRA_TASKS).
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { homedir, arch as osArch } from "node:os";
import { join } from "node:path";
import { deviceInfo } from "../deviceCapabilities.ts";
import { loadManifests, type EngineArch, type EngineManifest } from "./manifest.ts";

export type EngineState = "stopped" | "starting" | "ready" | "stopping" | "failed";

export type EngineErrorCode =
  | "unknown-engine"
  | "bench-only"
  | "unsupported-arch"
  | "insufficient-memory"
  | "start-failed"
  | "start-timeout"
  | "unhealthy"
  | "crashed"
  | "shutting-down";

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: Record<string, unknown>;
  constructor(code: EngineErrorCode, detail: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export interface EngineHandle {
  id: string;
  /** Always http://127.0.0.1:<port> */
  baseUrl: string;
  /** Once per acquire. The last release starts the idle timer. */
  release(): void;
}

export interface EngineStatus {
  id: string;
  state: EngineState;
  users: number;
  pid: number | null;
  port: number | null;
  lastError: EngineErrorCode | null;
}

export interface LauncherOptions {
  spawn?: typeof nodeSpawn;
  fetch?: typeof fetch;
  /** Free memory in MB right now, or null when unknown (then nothing is started). */
  availableMB?: () => number | null;
  arch?: () => EngineArch | null;
  pickPort?: () => Promise<number>;
  modelDir?: string;
  /** Kept free on top of an engine's measured peak, for the browser, the server and the OS. */
  reserveMB?: number;
  startupTimeoutMs?: number;
  idleShutdownMs?: number;
  /** While an engine runs, its health is checked this often; two failures in a row stop it. */
  healthIntervalMs?: number;
  /** SIGTERM, then SIGKILL after this long. */
  stopGraceMs?: number;
  /** The environment the minimal engine environment is taken from (only allowlisted names). */
  env?: Record<string, string | undefined>;
}

/** The only variables an engine inherits. Everything else (keys, tokens, URLs) stays with the server. */
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"];
const HOST = "127.0.0.1";

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export function currentArch(): EngineArch | null {
  const a = osArch();
  return a === "x64" ? "x86_64" : a === "arm64" ? "aarch64" : null;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

interface Running {
  m: EngineManifest;
  state: EngineState;
  users: number;
  child: ChildProcess | null;
  port: number | null;
  starting: Promise<void> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  healthTimer: ReturnType<typeof setInterval> | null;
  healthFailures: number;
  lastError: EngineErrorCode | null;
  exited: Promise<void> | null;
}

export class EngineLauncher {
  private engines = new Map<string, Running>();
  private o: Required<Omit<LauncherOptions, "env">> & { env: Record<string, string | undefined> };
  private closing = false;

  constructor(manifests: EngineManifest[], opts: LauncherOptions = {}) {
    const env = opts.env ?? process.env;
    this.o = {
      spawn: opts.spawn ?? nodeSpawn,
      fetch: opts.fetch ?? fetch,
      availableMB: opts.availableMB ?? (() => deviceInfo().memAvailableMB ?? null),
      arch: opts.arch ?? currentArch,
      pickPort: opts.pickPort ?? freePort,
      modelDir: opts.modelDir ?? env.NADHRA_MODEL_DIR ?? join(homedir(), ".local/share/nadhra/models"),
      reserveMB: opts.reserveMB ?? num(env.NADHRA_RAM_RESERVE_MB, 512),
      startupTimeoutMs: opts.startupTimeoutMs ?? 60_000,
      idleShutdownMs: opts.idleShutdownMs ?? num(env.NADHRA_IDLE_SHUTDOWN_MS, 120_000),
      healthIntervalMs: opts.healthIntervalMs ?? 15_000,
      stopGraceMs: opts.stopGraceMs ?? 3_000,
      env,
    };
    for (const m of manifests) {
      this.engines.set(m.id, { m, state: "stopped", users: 0, child: null, port: null, starting: null, idleTimer: null, healthTimer: null, healthFailures: 0, lastError: null, exited: null });
    }
  }

  status(): EngineStatus[] {
    return [...this.engines.values()].map((r) => ({ id: r.m.id, state: r.state, users: r.users, pid: r.child?.pid ?? null, port: r.port, lastError: r.lastError }));
  }

  /** Starts the engine if needed and returns a handle. Throws EngineError with the reason otherwise. */
  async acquire(id: string): Promise<EngineHandle> {
    if (this.closing) throw new EngineError("shutting-down");
    const r = this.engines.get(id);
    if (!r) throw new EngineError("unknown-engine", { id });
    if (r.m.benchOnly) throw new EngineError("bench-only", { id, licence: r.m.licence });
    const arch = this.o.arch();
    if (!arch || !r.m.arch.includes(arch)) throw new EngineError("unsupported-arch", { id, arch, supported: r.m.arch });

    r.users++;
    this.clearIdle(r);
    try {
      if (r.state !== "ready") {
        r.starting ??= this.start(r).finally(() => (r.starting = null));
        await r.starting;
      }
      if (r.state !== "ready") throw new EngineError(r.lastError ?? "crashed", { id });
    } catch (e) {
      r.users = Math.max(0, r.users - 1);
      throw e;
    }
    let released = false;
    return {
      id,
      baseUrl: `http://${HOST}:${r.port}`,
      release: () => {
        if (released) return;
        released = true;
        r.users = Math.max(0, r.users - 1);
        if (r.users === 0 && r.state === "ready") this.armIdle(r);
      },
    };
  }

  /** Stops one engine now (SIGTERM, then SIGKILL after the grace time). */
  async stop(id: string): Promise<void> {
    const r = this.engines.get(id);
    if (r) await this.kill(r, "stopped");
  }

  /** Synchronous last resort when the server process exits: every engine gets SIGTERM, no waiting. */
  killAllNow() {
    this.closing = true;
    for (const r of this.engines.values()) {
      try {
        r.child?.kill("SIGTERM");
      } catch {}
    }
  }

  /** Stops every engine: the server is shutting down. Nothing can be acquired afterwards. */
  async stopAll(): Promise<void> {
    this.closing = true;
    await Promise.all([...this.engines.values()].map((r) => this.kill(r, "stopped")));
  }

  // --- internals -------------------------------------------------------------------------------------

  private async start(r: Running): Promise<void> {
    const m = r.m;
    // Free memory first: an engine that doesn't fit is refused, never started into swap.
    const available = this.o.availableMB();
    const needMB = m.ramMB + this.o.reserveMB;
    if (available === null || available < needMB) {
      r.lastError = "insufficient-memory";
      r.state = "failed";
      throw new EngineError("insufficient-memory", { id: m.id, needMB, availableMB: available });
    }
    r.state = "starting";
    r.lastError = null;
    const port = await this.o.pickPort();
    r.port = port;
    const args = m.command.args.map((a) => a.replaceAll("{host}", HOST).replaceAll("{port}", String(port)).replaceAll("{modelDir}", this.o.modelDir));
    const env: Record<string, string> = {};
    for (const k of ENV_ALLOWLIST) if (this.o.env[k] !== undefined) env[k] = this.o.env[k]!;
    env.NADHRA_MODEL_DIR = this.o.modelDir;
    env.NADHRA_ENGINE_HOST = HOST;
    env.NADHRA_ENGINE_PORT = String(port);

    let child: ChildProcess;
    try {
      child = this.o.spawn(m.command.exec, args, { env: env as NodeJS.ProcessEnv, stdio: "ignore", shell: false, detached: false });
    } catch (e) {
      return this.failStart(r, "start-failed", { error: (e as Error).message });
    }
    r.child = child;
    let spawnError: string | null = null;
    r.exited = new Promise<void>((resolve) => {
      child.once("error", (e) => {
        spawnError = e.message;
        resolve();
      });
      child.once("exit", () => resolve());
    });
    void r.exited.then(() => this.onExit(r, child));

    // Health: any 2xx on the engine's own port, before the deadline.
    const deadline = Date.now() + (m.startupTimeoutMs ?? this.o.startupTimeoutMs);
    let answered = false;
    while (Date.now() < deadline) {
      if (spawnError) return this.failStart(r, "start-failed", { error: spawnError });
      if (r.child !== child || child.exitCode !== null || child.signalCode !== null) return this.failStart(r, "crashed", {});
      const health = await this.ping(port, m.health.path);
      if (health === "ok") {
        r.state = "ready";
        r.healthFailures = 0;
        this.armHealth(r);
        return;
      }
      if (health === "bad") answered = true;
      await sleep(Math.min(200, Math.max(10, deadline - Date.now())));
    }
    return this.failStart(r, answered ? "unhealthy" : "start-timeout", { timeoutMs: m.startupTimeoutMs ?? this.o.startupTimeoutMs });
  }

  private async failStart(r: Running, code: EngineErrorCode, detail: Record<string, unknown>): Promise<never> {
    await this.kill(r, "failed");
    r.lastError = code;
    throw new EngineError(code, { id: r.m.id, ...detail });
  }

  /** "ok": 2xx. "bad": answered, but not 2xx. "none": no answer (not listening, or too slow). */
  private async ping(port: number, path: string): Promise<"ok" | "bad" | "none"> {
    try {
      const res = await this.o.fetch(`http://${HOST}:${port}${path}`, { cache: "no-store", signal: AbortSignal.timeout(1_000) });
      void res.body?.cancel().catch(() => {});
      return res.ok ? "ok" : "bad";
    } catch {
      return "none";
    }
  }

  private armHealth(r: Running) {
    this.clearHealth(r);
    r.healthTimer = setInterval(() => {
      if (r.state !== "ready" || r.port === null) return;
      void this.ping(r.port, r.m.health.path).then((h) => {
        if (r.state !== "ready") return;
        r.healthFailures = h === "ok" ? 0 : r.healthFailures + 1;
        // Two failed checks in a row: it is stopped rather than trusted.
        if (r.healthFailures >= 2) {
          r.lastError = "unhealthy";
          void this.kill(r, "failed");
        }
      });
    }, this.o.healthIntervalMs);
    r.healthTimer.unref?.();
  }

  private armIdle(r: Running) {
    this.clearIdle(r);
    r.idleTimer = setTimeout(() => {
      r.idleTimer = null;
      if (r.users === 0 && r.state === "ready") void this.kill(r, "stopped");
    }, r.m.idleShutdownMs ?? this.o.idleShutdownMs);
    r.idleTimer.unref?.();
  }

  private clearIdle(r: Running) {
    if (r.idleTimer) clearTimeout(r.idleTimer);
    r.idleTimer = null;
  }

  private clearHealth(r: Running) {
    if (r.healthTimer) clearInterval(r.healthTimer);
    r.healthTimer = null;
  }

  private onExit(r: Running, child: ChildProcess) {
    if (r.child !== child) return;
    r.child = null;
    r.port = null;
    this.clearHealth(r);
    this.clearIdle(r);
    // It ended by itself, while in use or idle: a crash. The next acquire starts it again.
    if (r.state === "ready" || r.state === "starting") {
      r.state = "failed";
      r.lastError = "crashed";
    }
  }

  private async kill(r: Running, end: "stopped" | "failed") {
    this.clearIdle(r);
    this.clearHealth(r);
    const child = r.child;
    const exited = r.exited;
    if (child && child.exitCode === null && child.signalCode === null) {
      r.state = "stopping";
      try {
        child.kill("SIGTERM");
      } catch {}
      const forced = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, this.o.stopGraceMs);
      await exited;
      clearTimeout(forced);
    }
    if (r.child === child) {
      r.child = null;
      r.port = null;
    }
    r.state = end;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let shared: EngineLauncher | null = null;

/**
 * The server's launcher, built from the repo's manifests. Broken manifests are logged and left out.
 * Every engine is stopped when the server process exits. Not used by any route in N2.
 */
export function engineLauncher(): EngineLauncher {
  if (shared) return shared;
  const { manifests, errors } = loadManifests();
  for (const e of errors) console.warn(`[engines] ${e.file}: ${e.errors.join("; ")}`);
  const launcher = new EngineLauncher(manifests);
  // No signal handlers here: they would keep the server from exiting on SIGTERM/SIGINT. On exit
  // (however it happens) the engines get SIGTERM synchronously.
  process.once("exit", () => launcher.killAllNow());
  shared = launcher;
  return launcher;
}
