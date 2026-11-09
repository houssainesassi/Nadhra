// Properties of the source code itself that must not change silently: the app never places a call,
// sends a message or asks for the location by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
// Comments may mention these words; only code counts.
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const sources = files("src").map((p) => ({ p, src: code(p) }));

test("no call or message is ever started by code: only links the user taps", () => {
  for (const { p, src } of sources) {
    assert.ok(!/location\.(href\s*=|assign|replace)|window\.open\(|\.click\(\)|navigator\.share\(/.test(src), `${p} navigates or clicks by itself`);
  }
  const tel = sources.filter(({ src }) => /`tel:|`sms:|"tel:|"sms:/.test(src)).map(({ p }) => p);
  assert.deepEqual(tel, ["src/components/Assistant.tsx"], "tel:/sms: only in the screen's links");
  const screen = sources.find(({ p }) => p.endsWith("Assistant.tsx"))!.src;
  for (const use of screen.matchAll(/(telHref|smsHref)\(/g)) {
    const before = screen.slice(Math.max(0, use.index! - 6), use.index);
    assert.ok(/href=\{$/.test(before) || /const $/.test(before.slice(-6)) || before.endsWith("const "), `${use[1]} is only used as an href (found …${before})`);
  }
});

test("the location is only asked for in one place, the Emergency page", () => {
  const uses = sources.filter(({ src }) => /geolocation\.(getCurrentPosition|watchPosition)/.test(src));
  assert.deepEqual(uses.map(({ p }) => p), ["src/lib/assistant/controller.ts"]);
  const ctrl = uses[0].src;
  assert.equal(ctrl.match(/geolocation\.getCurrentPosition/g)?.length, 1);
  assert.ok(!/watchPosition/.test(ctrl), "never tracked continuously");
  assert.equal(ctrl.match(/this\.locate\(\)/g)?.length, 1, "locate() has one caller");
  assert.match(ctrl, /if \(sheet !== "emergency"\) return;[\s\S]{0,300}this\.locate\(\)/, "and that caller is opening the Emergency page");
  for (const { p, src } of sources) {
    if (/lat|lng/.test(src) && /fetch\(|postJson\(/.test(src)) assert.ok(!/lat[^e]|lng/.test(src.match(/fetch\([\s\S]{0,400}/g)?.join("") ?? ""), `${p} may send a location`);
  }
});
