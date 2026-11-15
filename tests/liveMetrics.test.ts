// Live conversation measurements: latency percentiles, frames, token tally by modality, cost only
// from configured prices (never assumed), device totals, and the anonymous report code.
import test from "node:test";
import assert from "node:assert/strict";
import { addToTotals, estimateCost, LiveMetrics, percentile, summaryCode } from "../src/lib/live/metrics.ts";
import { livePricing } from "../src/lib/server/liveToken.ts";

test("percentile: nearest rank, empty is null", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([900, 1100, 1400, 1000, 3400], 50), 1100);
  assert.equal(percentile([900, 1100, 1400, 1000, 3400], 90), 3400);
  assert.equal(percentile([700], 90), 700);
});

test("metrics: timing, frames, audio, reconnects", () => {
  let now = 10_000;
  const m = new LiveMetrics(() => now);
  now = 11_200;
  m.opened();
  now = 12_000;
  m.opened(); // only the first connection counts
  m.answerLatency(1100);
  m.answerLatency(900);
  m.answerLatency(-5); // nonsense ignored
  for (let i = 0; i < 6; i++) m.frameSent();
  m.frameSkipped("blurry");
  m.frameSkipped("unchanged");
  m.audioSent(32_000 * 10);
  m.audioReceived(48_000 * 4);
  m.reconnect("go-away");
  m.reconnect("go-away");
  m.reconnect("closed-1006:<script>");
  now = 70_000;
  m.end();
  now = 999_999; // after end, time stops
  const s = m.summary();
  assert.equal(s.connectMs, 1200);
  assert.equal(s.firstAnswerMs, 1100);
  assert.equal(s.answers, 2);
  assert.equal(s.latencyMedianMs, 900);
  assert.equal(s.durationMs, 60_000);
  assert.equal(s.framesPerMinute, 6);
  assert.deepEqual(s.framesSkipped, { unchanged: 1, blurry: 1, "too-soon": 0 });
  assert.equal(s.audioSentS, 10);
  assert.equal(s.audioReceivedS, 4);
  assert.equal(s.reconnects, 3);
  assert.deepEqual(s.reconnectReasons, { "go-away": 2, "closed-1006script": 1 });
});

test("metrics: tokens added per turn, by modality; undetailed tokens kept as other", () => {
  const m = new LiveMetrics(() => 0);
  m.usage({ promptTokenCount: 1000, responseTokenCount: 200, totalTokenCount: 1200, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 600 }, { modality: "IMAGE", tokenCount: 258 }, { modality: "TEXT", tokenCount: 142 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 200 }] });
  m.usage({ promptTokenCount: 500, responseTokenCount: 50, promptTokensDetails: [{ modality: "VIDEO", tokenCount: 300 }] });
  m.usage(undefined);
  const t = m.summary().tokens;
  assert.deepEqual(t.input, { audio: 600, image: 558, text: 142, other: 200 });
  assert.deepEqual(t.output, { audio: 200, image: 0, text: 0, other: 50 });
  assert.equal(t.total, 1750);
  assert.equal(t.turns, 2);
});

test("cost: only with configured prices; a used modality without a price gives no cost at all", () => {
  const tokens = { input: { audio: 1_000_000, image: 500_000, text: 0, other: 0 }, output: { audio: 200_000, image: 0, text: 0, other: 0 }, total: 1_700_000, turns: 3 };
  assert.equal(estimateCost(tokens, null), null);
  assert.equal(estimateCost(tokens, { currency: "USD", input: { audio: 2, image: 1 }, output: {} }), null, "output audio unpriced");
  assert.equal(estimateCost(tokens, { currency: "USD", input: { audio: 2, image: 1 }, output: { audio: 10 } }), 2 + 0.5 + 2);
  const m = new LiveMetrics(() => 0);
  m.usage({ promptTokenCount: 10 });
  assert.equal(m.summary().cost, null, "no pricing set");
  m.pricing = { currency: "EUR", input: { other: 1 }, output: {} };
  assert.equal(m.summary().cost, 10 / 1_000_000);
  assert.equal(m.summary().currency, "EUR");
});

test("pricing: read from the environment only, junk refused, nothing set means null", () => {
  assert.equal(livePricing({}), null);
  assert.equal(livePricing({ GEMINI_LIVE_PRICE_IN_AUDIO: "abc", GEMINI_LIVE_PRICE_OUT_AUDIO: "-1" }), null);
  assert.deepEqual(livePricing({ GEMINI_LIVE_PRICE_IN_AUDIO: " 3 ", GEMINI_LIVE_PRICE_IN_IMAGE: "0.5", GEMINI_LIVE_PRICE_OUT_AUDIO: "12", GEMINI_LIVE_PRICE_CURRENCY: "eur" }), { currency: "EUR", input: { audio: 3, image: 0.5 }, output: { audio: 12 } });
  assert.equal(livePricing({ GEMINI_LIVE_PRICE_IN_TEXT: "1", GEMINI_LIVE_PRICE_CURRENCY: "dollars" })?.currency, "USD");
});

test("device totals and report code", () => {
  const m = new LiveMetrics(() => 0);
  m.usage({ totalTokenCount: 41_600, promptTokenCount: 40_000, responseTokenCount: 1600 });
  m.pricing = { currency: "USD", input: { other: 1 }, output: { other: 1 } };
  const s = { ...m.summary(), durationMs: 5 * 60_000, latencyMedianMs: 1130, reconnects: 1, framesPerMinute: 21.4 };
  const t1 = addToTotals(null, s, 5);
  const t2 = addToTotals(t1, { ...s, cost: null }, 9);
  assert.equal(t2.sessions, 2);
  assert.equal(t2.tokens, 83_200);
  assert.equal(t2.unpriced, 1);
  assert.equal(t2.since, 5);
  assert.ok(Math.abs(t2.cost - 0.0416) < 1e-9);
  assert.equal(summaryCode(s), "m5.k42.l1100.r1.f21");
  assert.match(summaryCode(s), /^[a-z0-9][a-z0-9._:-]{0,47}$/, "accepted by report()");
});

test("cost status: complete estimate, no prices, or incomplete (unpriced or undetailed tokens) — never a partial sum", () => {
  const m = new LiveMetrics(() => 0);
  m.usage({ promptTokenCount: 1100, responseTokenCount: 50, promptTokensDetails: [{ modality: "AUDIO", tokenCount: 600 }, { modality: "IMAGE", tokenCount: 400 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 50 }] });
  let s = m.summary();
  assert.equal(s.costStatus, "no-prices");
  assert.equal(s.cost, null);
  m.pricing = { currency: "USD", input: { audio: 3, image: 1, text: 0.75 }, output: { audio: 12 } };
  s = m.summary();
  assert.equal(s.costStatus, "incomplete", "100 prompt tokens weren't broken down by type");
  assert.equal(s.cost, null);
  assert.equal(s.unpricedTokens, 100);
  m.pricing = { currency: "USD", input: { audio: 3, image: 1, other: 1 }, output: { audio: 12 } };
  s = m.summary();
  assert.equal(s.costStatus, "ok");
  assert.equal(s.unpricedTokens, 0);
  assert.ok(Math.abs(s.cost! - (600 * 3 + 400 + 100 + 50 * 12) / 1e6) < 1e-12);
});
