// Adaptive rate of the on-device detector: bounded main-thread share, with the settings the app uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameBudget } from "../src/lib/camera/frameBudget.ts";

// Long enough that the unthrottled warm-up frames do not dominate.
function simulate(costMs: number, seconds = 300) {
  const b = new FrameBudget(0.2, 3_000);
  let busyUntil = 0, busy = 0;
  for (let now = 0; now < seconds * 1000; now += 100) {
    if (now < busyUntil || !b.shouldProcess(now)) continue;
    b.record(costMs, now);
    busyUntil = now + costMs;
    busy += costMs;
  }
  return busy / (seconds * 1000);
}

test("detection never takes over the main thread, so buttons stay responsive", () => {
  for (const ms of [50, 150, 300]) {
    const duty = simulate(ms);
    assert.ok(duty <= 0.25, `${ms} ms/frame -> duty ${duty.toFixed(2)}`);
  }
});

test("a very slow device still gets a result within the maximum interval", () => {
  const b = new FrameBudget(0.2, 3_000);
  for (let i = 0; i < 20; i++) b.record(2000, i * 3000);
  assert.equal(b.minIntervalMs(), 3_000);
});

test("no throttling during warm-up (first frames include model compilation)", () => {
  const b = new FrameBudget(0.2, 3_000);
  for (let i = 0; i < 5; i++) b.record(300, i);
  assert.equal(b.minIntervalMs(), 0);
});
