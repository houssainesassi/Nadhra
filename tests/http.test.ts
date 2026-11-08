// Shared API request helpers: bounded body, same-origin check, rate limiter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSameOrigin, RateLimiter, readJsonBody } from "../src/lib/server/http.ts";

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://app.test/api/x", { method: "POST", body, headers: { host: "app.test", ...headers }, duplex: "half" } as RequestInit);

test("readJsonBody: parses small JSON, rejects invalid JSON with 400", async () => {
  assert.deepEqual(await readJsonBody(req('{"a":1}'), 100), { ok: true, value: { a: 1 } });
  const bad = await readJsonBody(req("{nope"), 100);
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.status, 400);
});

test("readJsonBody: declared Content-Length over the limit -> 413 without reading", async () => {
  const r = await readJsonBody(req('{"a":1}', { "content-length": "100000" }), 100);
  assert.equal(!r.ok && r.status, 413);
});

test("readJsonBody: a chunked body without Content-Length cannot exceed the limit", async () => {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new TextEncoder().encode('"' + "x".repeat(64)));
      if (pulled > 1000) c.close();
    },
  });
  const r = await readJsonBody(req(stream), 256);
  assert.equal(!r.ok && r.status, 413);
  assert.ok(pulled < 20, `stopped reading early (${pulled} chunks)`);
});

test("readJsonBody: multi-byte Arabic split across chunks is decoded correctly", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ w: "عسلامة" }));
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b])); // one byte per chunk
      c.close();
    },
  });
  assert.deepEqual(await readJsonBody(req(stream), 1000), { ok: true, value: { w: "عسلامة" } });
});

test("isSameOrigin: other sites refused, same host and missing Origin allowed", () => {
  assert.equal(isSameOrigin(req(null, { origin: "https://evil.example" })), false);
  assert.equal(isSameOrigin(req(null, { origin: "http://app.test" })), true);
  assert.equal(isSameOrigin(req(null, { origin: "not a url" })), false);
  assert.equal(isSameOrigin(req(null)), true);
  assert.equal(isSameOrigin(req(null, { origin: "https://my.vercel.app", "x-forwarded-host": "my.vercel.app" })), true);
});

test("RateLimiter: limit per key inside the window, freed after it, bounded memory", () => {
  const rl = new RateLimiter(2, 1000, 3);
  assert.equal(rl.hit("a", 0), true);
  assert.equal(rl.hit("a", 10), true);
  assert.equal(rl.hit("a", 20), false);
  assert.equal(rl.hit("b", 20), true); // other client unaffected
  assert.equal(rl.hit("a", 1011), true); // first hit left the window
  for (const k of ["c", "d", "e", "f"]) rl.hit(k, 2000);
  assert.ok(rl.size <= 3);
});
