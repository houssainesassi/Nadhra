// The screen-reader channel (announcer.ts): every announcement, even the same sentence twice in a
// row, is a new insertion into an empty live region, and nothing is in two regions at once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { announcerRegions, EMPTY_REGIONS } from "../src/lib/assistant/announcer.ts";

const filled = (r: ReturnType<typeof announcerRegions>) =>
  [...r.polite.map((t, i) => ["polite", i, t] as const), ...r.alert.map((t, i) => ["alert", i, t] as const)].filter(([, , t]) => t);

test("the same refusal three times: three insertions, alternating regions, one region at a time", () => {
  const text = "ذكاء نظرة مازال ما ينجمش يعمل هاذي.";
  let prev = EMPTY_REGIONS;
  const used: number[] = [];
  for (const id of [7, 8, 9]) {
    const next = announcerRegions({ text, urgent: false, id }, true);
    const f = filled(next);
    assert.equal(f.length, 1, "exactly one region holds the sentence");
    const [kind, i] = f[0];
    assert.equal(kind, "polite");
    assert.equal(prev.polite[i], "", "written into a region that was empty: a fresh insertion");
    used.push(i);
    prev = next;
  }
  assert.deepEqual(used, [1, 0, 1]);
});

test("urgent sentences use the alert pair, the others the polite pair", () => {
  assert.deepEqual(announcerRegions({ text: "درج قدّامك", urgent: true, id: 4 }, true), { polite: ["", ""], alert: ["درج قدّامك", ""] });
  assert.deepEqual(announcerRegions({ text: "عسلامة", urgent: false, id: 5 }, true), { polite: ["", "عسلامة"], alert: ["", ""] });
});

test("nothing is announced when the page's own voice is speaking (echo off) or there is no text", () => {
  assert.deepEqual(announcerRegions({ text: "عسلامة", urgent: false, id: 1 }, false), EMPTY_REGIONS);
  assert.deepEqual(announcerRegions({ text: "", urgent: true, id: 2 }, true), EMPTY_REGIONS);
});
