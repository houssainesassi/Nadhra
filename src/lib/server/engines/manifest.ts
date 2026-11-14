// Nadhra engine manifests (step N2). Server only, pure apart from reading the manifest folder.
//
// Every local engine Nadhra may run is described by one JSON manifest kept in the repo
// (engines/manifests/*.json). The model files stay outside the repo, in the model directory
// (NADHRA_MODEL_DIR, default ~/.local/share/nadhra/models). Swapping a model means changing a
// manifest, never app code.
//
// A manifest DESCRIBES an engine; it never makes Nadhra claim an ability. What Nadhra can do is
// declared separately, from benchmarks only (router.ts NADHRA_TASKS, empty until a task is proven),
// so `candidateTasks` here is informational.
//
// Licences: only permissive ones may be used by the product. A non-commercial or unknown licence is
// accepted only with `benchOnly: true`, and such an engine can't be loaded by the launcher.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AI_TASKS, type AiTask } from "../../ai/router.ts";

export const PERMISSIVE_LICENCES = ["Apache-2.0", "MIT", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Zlib", "Unlicense"] as const;
export type EngineArch = "x86_64" | "aarch64";
export const ENGINE_ARCHES: readonly EngineArch[] = ["x86_64", "aarch64"];
/** The only placeholders an engine's arguments may use. */
export const ARG_PLACEHOLDERS = ["{host}", "{port}", "{modelDir}"] as const;

export interface EngineFile {
  /** Path inside the model directory. */
  path: string;
  /** Where it was downloaded from (recorded, never fetched by the app). */
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface EngineManifest {
  /** Lowercase id, e.g. "ocr-paddle". */
  id: string;
  name: string;
  version: string;
  /** SPDX identifier of the engine AND its model files (the stricter of the two). */
  licence: string;
  /** Research only: may use any licence, but is never loaded by the launcher. */
  benchOnly?: boolean;
  /** Informational: what the engine is meant for. It does NOT enable anything (see above). */
  candidateTasks: AiTask[];
  /** The program to run: an absolute path, or a bare program name looked up on PATH. Never a shell. */
  command: { exec: string; args: string[] };
  /** Health check, on the engine's own port: any 2xx answer means ready. */
  health: { path: string };
  /** Peak resident memory measured on a benchmark, in MB. The launcher refuses to start without it free. */
  ramMB: number;
  arch: EngineArch[];
  files: EngineFile[];
  /** Overrides of the launcher's defaults, in ms. */
  startupTimeoutMs?: number;
  idleShutdownMs?: number;
}

export type ManifestResult = { ok: true; manifest: EngineManifest } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 200) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const posInt = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v > 0 && v <= max;

/** Validates a parsed manifest. Every problem is listed; nothing is guessed or defaulted silently. */
export function validateManifest(raw: unknown): ManifestResult {
  const e: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["not an object"] };
  const r = raw;
  if (!(typeof r.id === "string" && /^[a-z][a-z0-9-]{1,40}$/.test(r.id))) e.push("id: lowercase letters, digits and dashes");
  if (!str(r.name)) e.push("name required");
  if (!str(r.version, 60)) e.push("version required");
  const benchOnly = r.benchOnly === true;
  if (r.benchOnly !== undefined && typeof r.benchOnly !== "boolean") e.push("benchOnly must be true or false");
  if (!str(r.licence, 80)) e.push("licence required");
  else if (!benchOnly && !(PERMISSIVE_LICENCES as readonly string[]).includes(r.licence as string)) {
    e.push(`licence "${r.licence}" is not permissive: only ${PERMISSIVE_LICENCES.join(", ")} (or benchOnly: true)`);
  }
  if (!Array.isArray(r.candidateTasks) || !r.candidateTasks.every((t) => (AI_TASKS as readonly unknown[]).includes(t))) e.push(`candidateTasks: a list of ${AI_TASKS.join(", ")}`);

  const cmd = r.command;
  if (!isObj(cmd) || !str(cmd.exec, 300) || !Array.isArray(cmd.args) || !cmd.args.every((a) => typeof a === "string" && a.length <= 300)) {
    e.push("command: { exec, args[] }");
  } else {
    const exec = cmd.exec as string;
    if (!(exec.startsWith("/") || /^[A-Za-z0-9._-]+$/.test(exec))) e.push("command.exec: an absolute path or a bare program name");
    if (/\s|[;&|`$<>]/.test(exec)) e.push("command.exec: no spaces or shell characters (engines never run through a shell)");
    for (const a of cmd.args as string[]) {
      for (const m of a.match(/\{[^}]*\}/g) ?? []) if (!(ARG_PLACEHOLDERS as readonly string[]).includes(m)) e.push(`command.args: unknown placeholder ${m}`);
    }
  }
  if (!isObj(r.health) || !(typeof r.health.path === "string" && /^\/[\w./-]*$/.test(r.health.path))) e.push("health.path: an absolute path such as /health");
  if (!posInt(r.ramMB, 64_000)) e.push("ramMB: the measured peak, in MB");
  if (!Array.isArray(r.arch) || !r.arch.length || !r.arch.every((a) => (ENGINE_ARCHES as readonly unknown[]).includes(a))) e.push(`arch: a list of ${ENGINE_ARCHES.join(", ")}`);
  if (!Array.isArray(r.files)) e.push("files: a list (may be empty)");
  else {
    r.files.forEach((f, i) => {
      if (!isObj(f)) return void e.push(`files[${i}]: an object`);
      if (!(typeof f.path === "string" && f.path.length > 0 && !f.path.startsWith("/") && !f.path.split("/").includes(".."))) e.push(`files[${i}].path: relative, inside the model directory`);
      if (!(typeof f.url === "string" && /^https:\/\//.test(f.url))) e.push(`files[${i}].url: https`);
      if (!(typeof f.sha256 === "string" && /^[0-9a-f]{64}$/.test(f.sha256))) e.push(`files[${i}].sha256: 64 lowercase hex characters`);
      if (!posInt(f.sizeBytes, 64e9)) e.push(`files[${i}].sizeBytes`);
    });
  }
  for (const k of ["startupTimeoutMs", "idleShutdownMs"] as const) if (r[k] !== undefined && !posInt(r[k], 3_600_000)) e.push(`${k}: ms`);
  return e.length ? { ok: false, errors: e } : { ok: true, manifest: r as unknown as EngineManifest };
}

/** The repo's manifest folder. Empty in N2: no engine is connected. */
export const MANIFEST_DIR = "engines/manifests";

/**
 * Reads every *.json manifest in `dir`. A broken manifest is reported, never half-used. A missing
 * folder means no engine. Duplicate ids are an error for both.
 */
export function loadManifests(dir = MANIFEST_DIR): { manifests: EngineManifest[]; errors: { file: string; errors: string[] }[] } {
  const manifests: EngineManifest[] = [];
  const errors: { file: string; errors: string[] }[] = [];
  if (!existsSync(dir)) return { manifests, errors };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      errors.push({ file, errors: ["not valid JSON"] });
      continue;
    }
    const res = validateManifest(parsed);
    if (!res.ok) errors.push({ file, errors: res.errors });
    else if (manifests.some((m) => m.id === res.manifest.id)) errors.push({ file, errors: [`duplicate id ${res.manifest.id}`] });
    else manifests.push(res.manifest);
  }
  return { manifests, errors };
}
