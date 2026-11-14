// Provider routing (src/lib/ai/router.ts) and the capabilities the real providers declare.
// No network: providers are plain objects here, and the real ones are only inspected.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.GEMINI_API_KEY = "gem-test";
process.env.OPENROUTER_API_KEY = "or-test";
process.env.GEMINI_VISION_MODELS = "model-a,model-b";
console.warn = () => {};

const { aiMode, routeProviders, routeRefusal, AI_TASKS } = await import("../src/lib/ai/router.ts");
const { getVisionProviders, providersFor } = await import("../src/lib/ai/vision.ts");

type P = { name: string; locality: "local" | "cloud"; tasks: Record<string, "full" | "limited"> };
const cloudA: P = { name: "cloudA", locality: "cloud", tasks: { scan: "full", question: "full", chat: "full", read: "full" } };
const cloudB: P = { name: "cloudB", locality: "cloud", tasks: { scan: "full", chat: "full" } };
const localOcr: P = { name: "localOcr", locality: "local", tasks: { read: "limited" } };
const localLlm: P = { name: "localLlm", locality: "local", tasks: { chat: "full" } };
const localWeak: P = { name: "localWeak", locality: "local", tasks: { chat: "limited", scan: "limited" } };
const all = [cloudA, localWeak, cloudB, localOcr, localLlm];
const names = (ps: P[]) => ps.map((p) => p.name);

test("AI_MODE: cloud by default, unknown values fall back to cloud", () => {
  assert.equal(aiMode({}), "cloud");
  assert.equal(aiMode({ AI_MODE: "" }), "cloud");
  assert.equal(aiMode({ AI_MODE: "Offline" }), "offline");
  assert.equal(aiMode({ AI_MODE: " hybrid " }), "hybrid");
  assert.equal(aiMode({ AI_MODE: "local" }), "cloud");
});

test("cloud mode: cloud providers only, in their configured order, never a local one", () => {
  assert.deepEqual(names(routeProviders(all, "chat", { mode: "cloud" })), ["cloudA", "cloudB"]);
  assert.deepEqual(names(routeProviders(all, "read", { mode: "cloud", internet: false })), ["cloudA"]);
});

test("a provider is never given a task it doesn't declare", () => {
  for (const mode of ["cloud", "hybrid", "offline"] as const) {
    for (const task of AI_TASKS) {
      for (const p of routeProviders(all, task, { mode })) assert.ok(p.tasks[task], `${p.name} got ${task} in ${mode}`);
    }
  }
  assert.deepEqual(routeProviders(all, "transcribe", { mode: "hybrid" }), []);
});

test("offline mode: local providers only, full before limited; nothing cloud even when online", () => {
  assert.deepEqual(names(routeProviders(all, "chat", { mode: "offline", internet: true })), ["localLlm", "localWeak"]);
  assert.deepEqual(names(routeProviders(all, "question", { mode: "offline" })), []);
  for (const task of AI_TASKS) for (const p of routeProviders(all, task, { mode: "offline", internet: true })) assert.equal(p.locality, "local");
});

test("hybrid mode: local full first, then cloud, then local limited; cloud skipped when the internet is down", () => {
  assert.deepEqual(names(routeProviders(all, "chat", { mode: "hybrid" })), ["localLlm", "cloudA", "cloudB", "localWeak"]);
  assert.deepEqual(names(routeProviders(all, "chat", { mode: "hybrid", internet: true })), ["localLlm", "cloudA", "cloudB", "localWeak"]);
  assert.deepEqual(names(routeProviders(all, "scan", { mode: "hybrid", internet: false })), ["localWeak"]);
  assert.deepEqual(names(routeProviders(all, "question", { mode: "hybrid", internet: false })), []);
});

test("refusal reasons: said only when the mode or the connection is the cause", () => {
  assert.equal(routeRefusal(all, "question", { mode: "offline" }), "offline-mode");
  assert.equal(routeRefusal(all, "chat", { mode: "offline" }), null);
  assert.equal(routeRefusal(all, "question", { mode: "hybrid", internet: false }), "no-internet");
  assert.equal(routeRefusal(all, "question", { mode: "hybrid", internet: true }), null);
  assert.equal(routeRefusal(all, "transcribe", { mode: "cloud" }), null); // not configured: the usual message
});

test("real providers: all cloud, Gemini does every task, OpenRouter never reads documents or transcribes", () => {
  const ps = getVisionProviders();
  assert.ok(ps.length >= 3);
  for (const p of ps) assert.equal(p.locality, "cloud", p.id);
  for (const p of ps.filter((p) => p.family === "gemini")) assert.deepEqual(Object.keys(p.tasks).sort(), [...AI_TASKS].sort());
  const or = ps.find((p) => p.family === "openrouter")!;
  assert.equal(or.tasks.read, undefined);
  assert.equal(or.tasks.transcribe, undefined);
  assert.equal(typeof or.transcribe, "undefined");
  // Every provider with a transcribe method declares the task, and the other way round.
  for (const p of ps) assert.equal(!!p.transcribe, !!p.tasks.transcribe, p.id);
});

test("default routing keeps today's provider order for every task", () => {
  delete process.env.AI_MODE;
  const ids = (task: Parameters<typeof providersFor>[0]) => providersFor(task).map((p) => p.id);
  assert.deepEqual(ids("scan"), ["gemini:model-a", "gemini:model-b", "openrouter"]);
  assert.deepEqual(ids("question"), ["gemini:model-a", "gemini:model-b", "openrouter"]);
  assert.deepEqual(ids("chat"), ["gemini:model-a", "gemini:model-b", "openrouter"]);
  assert.deepEqual(ids("read"), ["gemini:model-a", "gemini:model-b"]);
  assert.deepEqual(ids("transcribe"), ["gemini:model-a", "gemini:model-b"]);
});
