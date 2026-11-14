// Which AI providers may handle a task. Pure functions, no network: the caller (ai/vision.ts) passes
// the providers, the mode and what it knows about the internet, and gets back the ones to try, in order.
//
// Honesty rule: a provider is only ever chosen for a task it declares. Nothing here makes a local
// engine "try" a task it can't do; a task with no allowed provider gets no provider, and the caller
// says so out loud (see `RouteRefusal`).

/** The jobs an AI provider can be asked to do. */
export type AiTask = "scan" | "question" | "chat" | "read" | "transcribe";
export const AI_TASKS: readonly AiTask[] = ["scan", "question", "chat", "read", "transcribe"];

/** local: runs on this device, nothing leaves it. cloud: data goes over the internet to a company. */
export type Locality = "local" | "cloud";

/** full: does the task as well as the app needs. limited: usable, with known weaknesses (benchmarked). */
export type TaskSupport = "full" | "limited";

export interface RoutableProvider {
  locality: Locality;
  /** Only the tasks listed here can be routed to this provider. */
  tasks: Partial<Record<AiTask, TaskSupport>>;
}

/**
 * cloud   (default) today's behaviour: cloud providers only, in their configured order.
 * hybrid  local providers that do the task fully first, then cloud, then local ones marked limited.
 *         Cloud is skipped when the internet is known to be unreachable.
 * offline local providers only. Nothing leaves the device.
 */
export type AiMode = "cloud" | "hybrid" | "offline";
export const AI_MODES: readonly AiMode[] = ["cloud", "hybrid", "offline"];

/** AI_MODE from the environment. Anything unknown is `cloud`, the current behaviour, with a warning. */
export function aiMode(env: Record<string, string | undefined> = process.env): AiMode {
  const v = (env.AI_MODE ?? "").trim().toLowerCase();
  if (!v) return "cloud";
  if ((AI_MODES as readonly string[]).includes(v)) return v as AiMode;
  if (!warnedMode) {
    warnedMode = true;
    console.warn(`[ai] AI_MODE "${v}" is not cloud, hybrid or offline: using cloud`);
  }
  return "cloud";
}
let warnedMode = false;

export interface RouteContext {
  mode: AiMode;
  /** false: known to be unreachable (hybrid skips cloud). true or unknown: cloud may be tried. */
  internet?: boolean;
}

/** The providers allowed for `task`, in the order to try them. */
export function routeProviders<P extends RoutableProvider>(providers: P[], task: AiTask, ctx: RouteContext): P[] {
  const able = providers.filter((p) => !!p.tasks[task]);
  const local = able.filter((p) => p.locality === "local");
  const cloud = able.filter((p) => p.locality === "cloud");
  switch (ctx.mode) {
    case "cloud":
      return cloud;
    case "offline":
      return [...local.filter((p) => p.tasks[task] === "full"), ...local.filter((p) => p.tasks[task] === "limited")];
    case "hybrid": {
      const reachable = ctx.internet === false ? [] : cloud;
      return [...local.filter((p) => p.tasks[task] === "full"), ...reachable, ...local.filter((p) => p.tasks[task] === "limited")];
    }
  }
}

/**
 * Why a task got no provider, when the mode or the connection is the reason (not missing keys):
 *   offline-mode  the device is set to work offline and nothing local can do this task;
 *   no-internet   hybrid mode, the internet is unreachable, and nothing local can do it.
 * null: the usual reasons apply (not configured, or every provider failed).
 */
export type RouteRefusal = "offline-mode" | "no-internet";

export function routeRefusal(providers: RoutableProvider[], task: AiTask, ctx: RouteContext): RouteRefusal | null {
  if (routeProviders(providers, task, ctx).length) return null;
  if (ctx.mode === "offline") return "offline-mode";
  if (ctx.mode === "hybrid" && ctx.internet === false) return "no-internet";
  return null;
}

// --- provider families (Nadhra AI proposal, step N1) ----------------------------------------------
// The user picks one AI in Settings: "gemini" (the existing providers, unchanged) or "nadhra" (the
// project's own engines, on this machine). A request names Nadhra with `provider: "nadhra"`; without
// that exact value it is a Gemini request and takes today's path, untouched. The two families never
// stand in for each other: a task Nadhra can't do is refused out loud, never sent to a cloud provider.

export type ProviderFamily = "gemini" | "nadhra";

/** Only the exact value "nadhra" selects Nadhra AI. Absent or anything else: Gemini, as today. */
export const requestedFamily = (v: unknown): ProviderFamily => (v === "nadhra" ? "nadhra" : "gemini");

/**
 * What Nadhra AI can do, per task. Declared from benchmarks only, never assumed. N1: nothing yet,
 * because no local engine is connected, so every Nadhra request is refused (`nadhra-unavailable`).
 */
export const NADHRA_TASKS: Readonly<Partial<Record<AiTask, TaskSupport>>> = Object.freeze({});

/** NADHRA_AI_ENABLED: off unless set to 1/true/yes. */
export const nadhraEnabled = (env: Record<string, string | undefined> = process.env) => /^(1|true|yes)$/i.test(env.NADHRA_AI_ENABLED?.trim() ?? "");

/**
 * The server offers Nadhra AI as a choice: switched on, and AI_MODE allows local engines (hybrid or
 * offline). In cloud mode (the default, the public deployment) it is never offered.
 */
export const nadhraOffered = (env: Record<string, string | undefined> = process.env) => nadhraEnabled(env) && aiMode(env) !== "cloud";

/** The tasks Nadhra AI declares now (none in N1). */
export const nadhraTasks = (): AiTask[] => AI_TASKS.filter((t) => !!NADHRA_TASKS[t]);
