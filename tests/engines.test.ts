// Nadhra step N2: engine manifests and the launcher, with fake engines only (tests/fixtures/fake-engine.mjs,
// a real Node process with a tiny HTTP API and no model). Covers the lifecycle (start once, reuse, idle
// shutdown, stop), refusals (memory, architecture, research-only licence), health failures and crashes,
// and privacy isolation (no secrets in the engine's environment, 127.0.0.1 only, no shell). Nothing is
// downloaded; no real model exists anywhere in this test.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateManifest, loadManifests, MANIFEST_DIR, PERMISSIVE_LICENCES, type EngineManifest } from "../src/lib/server/engines/manifest.ts";
import { EngineLauncher, EngineError } from "../src/lib/server/engines/launcher.ts";
import { NADHRA_TASKS, nadhraTasks } from "../src/lib/ai/router.ts";

const FAKE = resolve("tests/fixtures/fake-engine.mjs");
const SHA = "a".repeat(64);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

function manifest(over: Partial<EngineManifest> & { mode?: string; ms?: number } = {}): EngineManifest {
  const { mode = "ok", ms = 200, ...rest } = over;
  return {
    id: "fake-ocr",
    name: "Fake OCR",
    version: "0.0.1",
    licence: "Apache-2.0",
    candidateTasks: ["read"],
    command: { exec: process.execPath, args: [FAKE, "--host", "{host}", "--port", "{port}", "--mode", mode, "--ms", String(ms), "--models", "{modelDir}"] },
    health: { path: "/health" },
    ramMB: 600,
    arch: ["x86_64", "aarch64"],
    files: [],
    ...rest,
  };
}

const launchers: EngineLauncher[] = [];
function launcher(m: EngineManifest[], over: ConstructorParameters<typeof EngineLauncher>[1] = {}) {
  const l = new EngineLauncher(m, { availableMB: () => 4_000, reserveMB: 512, startupTimeoutMs: 4_000, idleShutdownMs: 300, healthIntervalMs: 100, stopGraceMs: 500, modelDir: "/tmp/nadhra-test-models", ...over });
  launchers.push(l);
  return l;
}
afterEach(async () => {
  for (const l of launchers.splice(0)) await l.stopAll();
});

// --- manifests -----------------------------------------------------------------------------------------

test("manifest: a complete, permissive manifest is accepted", () => {
  const r = validateManifest({ ...manifest(), files: [{ path: "ocr/det.onnx", url: "https://example.org/det.onnx", sha256: SHA, sizeBytes: 4_700_000 }] });
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("manifest: missing or non-permissive licence is refused, unless research-only", () => {
  const { licence: _l, ...noLicence } = manifest();
  assert.equal(validateManifest(noLicence).ok, false);
  for (const licence of ["CC-BY-NC-4.0", "GPL-3.0", "proprietary", "Gemma"]) {
    const r = validateManifest({ ...manifest(), licence });
    assert.equal(r.ok, false, licence);
    assert.equal(validateManifest({ ...manifest(), licence, benchOnly: true }).ok, true, `${licence} as benchOnly`);
  }
  for (const licence of PERMISSIVE_LICENCES) assert.equal(validateManifest({ ...manifest(), licence }).ok, true, licence);
});

test("manifest: unsafe or incomplete fields are refused, each reported", () => {
  const bad = (over: Record<string, unknown>) => validateManifest({ ...manifest(), ...over });
  assert.equal(bad({ id: "Bad Id" }).ok, false);
  assert.equal(bad({ command: { exec: "sh -c 'x'", args: [] } }).ok, false, "no shell");
  assert.equal(bad({ command: { exec: "run;rm", args: [] } }).ok, false);
  assert.equal(bad({ command: { exec: "relative/path", args: [] } }).ok, false);
  assert.equal(bad({ command: { exec: "llama-server", args: ["--key", "{GEMINI_API_KEY}"] } }).ok, false, "only {host} {port} {modelDir}");
  assert.equal(bad({ ramMB: 0 }).ok, false, "a measured peak is required");
  assert.equal(bad({ arch: ["riscv"] }).ok, false);
  assert.equal(bad({ candidateTasks: ["fly"] }).ok, false);
  assert.equal(bad({ health: { path: "health" } }).ok, false);
  assert.equal(bad({ files: [{ path: "../etc/passwd", url: "https://x", sha256: SHA, sizeBytes: 1 }] }).ok, false);
  assert.equal(bad({ files: [{ path: "m.onnx", url: "http://insecure", sha256: SHA, sizeBytes: 1 }] }).ok, false);
  assert.equal(bad({ files: [{ path: "m.onnx", url: "https://x", sha256: "abc", sizeBytes: 1 }] }).ok, false);
  const many = bad({ id: "X", ramMB: -1, arch: [] });
  assert.ok(!many.ok && many.errors.length >= 3, "every problem listed");
});

test("loader: broken and duplicate manifests are reported and left out; a missing folder means no engine", () => {
  const dir = mkdtempSync(join(tmpdir(), "nadhra-manifests-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify(manifest()));
  writeFileSync(join(dir, "b.json"), JSON.stringify(manifest()));
  writeFileSync(join(dir, "c.json"), "{ not json");
  writeFileSync(join(dir, "d.json"), JSON.stringify({ ...manifest({ id: "nc-model" }), licence: "CC-BY-NC-4.0" }));
  const { manifests, errors } = loadManifests(dir);
  assert.deepEqual(manifests.map((m) => m.id), ["fake-ocr"]);
  assert.deepEqual(errors.map((e) => e.file), ["b.json", "c.json", "d.json"]);
  assert.deepEqual(loadManifests(join(dir, "missing")), { manifests: [], errors: [] });
});

test("repo: every manifest in engines/manifests is valid and permissive (none in N2), and Nadhra still declares no task", () => {
  const { manifests, errors } = loadManifests(MANIFEST_DIR);
  assert.deepEqual(errors, []);
  for (const m of manifests) assert.ok(m.benchOnly || (PERMISSIVE_LICENCES as readonly string[]).includes(m.licence), m.id);
  assert.equal(manifests.length, 0, "N2: no real engine is connected");
  assert.deepEqual(NADHRA_TASKS, {});
  assert.deepEqual(nadhraTasks(), []);
});

// --- lifecycle ---------------------------------------------------------------------------------------------

test("lifecycle: started once for concurrent callers, healthy, reused, idle-stopped after the last release", async () => {
  const spawns: string[] = [];
  const l = launcher([manifest()], { spawn: ((cmd: string, args: string[], o: object) => (spawns.push(cmd), spawn(cmd, args, o))) as typeof spawn });
  const [a, b] = await Promise.all([l.acquire("fake-ocr"), l.acquire("fake-ocr")]);
  assert.equal(spawns.length, 1, "one process for both callers");
  assert.match(a.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(a.baseUrl, b.baseUrl);
  const [st] = l.status();
  assert.equal(st.state, "ready");
  assert.equal(st.users, 2);
  const pid = st.pid;
  assert.ok(alive(pid));
  assert.equal((await fetch(`${a.baseUrl}/health`)).status, 200);

  a.release();
  a.release(); // a second release of the same handle counts once
  await sleep(450);
  assert.equal(l.status()[0].state, "ready", "still used by b: no idle stop");
  b.release();
  assert.equal(l.status()[0].users, 0);
  await sleep(150);
  assert.equal(l.status()[0].state, "ready", "idle timer not over yet");
  await sleep(500);
  assert.equal(l.status()[0].state, "stopped", "stopped after the idle time");
  assert.equal(alive(pid), false, "the process is gone");

  const c = await l.acquire("fake-ocr"); // started again on demand
  assert.equal(l.status()[0].state, "ready");
  assert.notEqual(l.status()[0].pid, pid);
  c.release();
});

test("lifecycle: acquiring again before the idle time ends cancels the idle stop", async () => {
  const l = launcher([manifest()]);
  const a = await l.acquire("fake-ocr");
  const pid = l.status()[0].pid;
  a.release();
  await sleep(150);
  const b = await l.acquire("fake-ocr");
  await sleep(400);
  assert.equal(l.status()[0].state, "ready");
  assert.equal(l.status()[0].pid, pid, "the same process, never restarted");
  b.release();
});

test("stop and stopAll: the process is ended; nothing can be acquired after stopAll", async () => {
  const l = launcher([manifest(), manifest({ id: "fake-tts" })]);
  await l.acquire("fake-ocr");
  await l.acquire("fake-tts");
  const pids = l.status().map((s) => s.pid);
  await l.stop("fake-ocr");
  assert.equal(alive(pids[0]), false);
  assert.equal(l.status()[0].state, "stopped");
  await l.stopAll();
  assert.equal(alive(pids[1]), false);
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && e.code === "shutting-down");
});

// --- refusals -----------------------------------------------------------------------------------------------

test("memory: not enough free memory → refused before anything is started, with the numbers", async () => {
  let spawned = 0;
  const l = launcher([manifest({ ramMB: 800 })], { availableMB: () => 1_000, spawn: ((...a: Parameters<typeof spawn>) => (spawned++, spawn(...a))) as typeof spawn });
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && e.code === "insufficient-memory" && e.detail.needMB === 1_312 && e.detail.availableMB === 1_000);
  assert.equal(spawned, 0);
  assert.equal(l.status()[0].state, "failed");
  assert.equal(l.status()[0].users, 0);
});

test("memory: unknown free memory → refused too (never started blind)", async () => {
  const l = launcher([manifest()], { availableMB: () => null });
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && e.code === "insufficient-memory");
});

test("memory: enough once memory is freed → the next acquire starts it", async () => {
  let free = 500;
  const l = launcher([manifest({ ramMB: 600 })], { availableMB: () => free });
  await assert.rejects(l.acquire("fake-ocr"));
  free = 2_000;
  const h = await l.acquire("fake-ocr");
  assert.equal(l.status()[0].state, "ready");
  h.release();
});

test("refusals: unknown engine, wrong architecture, research-only licence", async () => {
  const l = launcher([manifest({ arch: ["aarch64"] }), { ...manifest({ id: "nc-bench" }), licence: "CC-BY-NC-4.0", benchOnly: true }], { arch: () => "x86_64" });
  await assert.rejects(l.acquire("nope"), (e: unknown) => e instanceof EngineError && e.code === "unknown-engine");
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && e.code === "unsupported-arch");
  await assert.rejects(l.acquire("nc-bench"), (e: unknown) => e instanceof EngineError && e.code === "bench-only");
});

// --- health failures and crashes --------------------------------------------------------------------------

test("health: an engine answering 500 is refused as unhealthy and killed", async () => {
  const pids: number[] = [];
  const l = launcher([manifest({ mode: "unhealthy", startupTimeoutMs: 800 })], { spawn: ((...a: Parameters<typeof spawn>) => { const c = spawn(...a); pids.push(c.pid!); return c; }) as typeof spawn });
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && e.code === "unhealthy");
  await sleep(100);
  assert.equal(alive(pids[0]), false, "not left running");
  assert.equal(l.status()[0].state, "failed");
});

test("health: an engine that never listens times out and is killed", async () => {
  const pids: number[] = [];
  const l = launcher([manifest({ mode: "silent", startupTimeoutMs: 600 })], { spawn: ((...a: Parameters<typeof spawn>) => { const c = spawn(...a); pids.push(c.pid!); return c; }) as typeof spawn });
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && e.code === "start-timeout");
  await sleep(100);
  assert.equal(alive(pids[0]), false);
});

test("health: a missing program is a clear start failure", async () => {
  const l = launcher([manifest({ command: { exec: "/nonexistent/nadhra-engine", args: [] } })]);
  await assert.rejects(l.acquire("fake-ocr"), (e: unknown) => e instanceof EngineError && (e.code === "start-failed" || e.code === "crashed"));
  assert.equal(l.status()[0].state, "failed");
});

test("health: a running engine that turns unhealthy is stopped (two failed checks), and restarted on the next acquire", async () => {
  const l = launcher([manifest({ mode: "fail-later", ms: 300 })]);
  const h = await l.acquire("fake-ocr");
  const pid = l.status()[0].pid;
  await sleep(900);
  assert.equal(l.status()[0].state, "failed");
  assert.equal(l.status()[0].lastError, "unhealthy");
  assert.equal(alive(pid), false);
  h.release();
  const again = await l.acquire("fake-ocr"); // a fresh process is healthy again for 300 ms
  assert.equal(l.status()[0].state, "ready");
  again.release();
});

test("crash: an engine that exits by itself is marked crashed; the next acquire starts a new one", async () => {
  const l = launcher([manifest({ mode: "crash-after-ready", ms: 150 })]);
  const h = await l.acquire("fake-ocr");
  await sleep(400);
  assert.equal(l.status()[0].state, "failed");
  assert.equal(l.status()[0].lastError, "crashed");
  h.release();
  const again = await l.acquire("fake-ocr");
  assert.equal(l.status()[0].state, "ready");
  again.release();
});

// --- privacy isolation ---------------------------------------------------------------------------------------

test("privacy: the engine gets no secret of the server, only an allowlisted environment", async () => {
  const env = { PATH: process.env.PATH, HOME: "/home/test", LANG: "C.UTF-8", GEMINI_API_KEY: "secret-1", OPENROUTER_API_KEY: "secret-2", HEALTH_TOKEN: "secret-3", UPSTASH_REDIS_REST_TOKEN: "secret-4", EDGE_TTS_VOICE: "x", NODE_OPTIONS: "--import evil.mjs", RANDOM_VAR: "y" };
  const l = launcher([manifest()], { env });
  const h = await l.acquire("fake-ocr");
  const info = await (await fetch(`${h.baseUrl}/info`)).json();
  assert.deepEqual(info.envKeys.filter((k: string) => !["PATH", "HOME", "LANG", "NADHRA_MODEL_DIR", "NADHRA_ENGINE_HOST", "NADHRA_ENGINE_PORT"].includes(k)), [], JSON.stringify(info.envKeys));
  assert.deepEqual(info.argv, ["--host", "127.0.0.1", "--port", h.baseUrl.split(":").pop(), "--mode", "ok", "--ms", "200", "--models", "/tmp/nadhra-test-models"]);
  h.release();
});

test("privacy: the launcher only ever contacts 127.0.0.1, and never uses a shell", async () => {
  const urls: string[] = [];
  const shells: unknown[] = [];
  const l = launcher([manifest({ mode: "fail-later", ms: 250 })], {
    fetch: ((u: string, i?: RequestInit) => (urls.push(String(u)), fetch(u, i))) as typeof fetch,
    spawn: ((cmd: string, args: string[], o: { shell?: unknown }) => (shells.push(o.shell), spawn(cmd, args, o as never))) as typeof spawn,
  });
  const h = await l.acquire("fake-ocr");
  await sleep(700); // health checks while running, until it turns unhealthy
  h.release();
  assert.ok(urls.length >= 3);
  assert.ok(urls.every((u) => u.startsWith("http://127.0.0.1:")), urls.join(" "));
  assert.deepEqual(shells, [false]);
});

test("privacy: the engine listens on 127.0.0.1 only (not reachable on other addresses)", async () => {
  const l = launcher([manifest()]);
  const h = await l.acquire("fake-ocr");
  const port = h.baseUrl.split(":").pop();
  const viaLoopback = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.status, () => 0);
  assert.equal(viaLoopback, 200);
  const nets = (await import("node:os")).networkInterfaces();
  const external = Object.values(nets).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
  if (external) {
    const viaLan = await fetch(`http://${external}:${port}/health`, { signal: AbortSignal.timeout(800) }).then((r) => r.status, () => 0);
    assert.equal(viaLan, 0, "not reachable from the network");
  }
  h.release();
});
