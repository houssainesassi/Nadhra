// A fake Nadhra engine for tests/engines.test.ts: a real process with a tiny HTTP API, no model.
//   node fake-engine.mjs --host 127.0.0.1 --port 4567 --mode ok|unhealthy|silent|crash-after-ready|fail-later [--ms 200]
// /health → 200 (or 500), /info → its arguments and the NAMES of its environment variables (never values).
import { createServer } from "node:http";

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const host = arg("host", "127.0.0.1");
const port = Number(arg("port", "0"));
const mode = arg("mode", "ok");
const ms = Number(arg("ms", "200"));
const started = Date.now();

if (mode === "silent") setInterval(() => {}, 1 << 30); // runs, never listens
else {
  createServer((req, res) => {
    if (req.url === "/health") {
      const bad = mode === "unhealthy" || (mode === "fail-later" && Date.now() - started > ms);
      res.writeHead(bad ? 500 : 200).end(bad ? "bad" : "ok");
      return;
    }
    if (req.url === "/info") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ argv: process.argv.slice(2), envKeys: Object.keys(process.env).sort(), pid: process.pid }));
      return;
    }
    res.writeHead(404).end();
  }).listen(port, host, () => {
    if (mode === "crash-after-ready") setTimeout(() => process.exit(3), ms);
  });
}
