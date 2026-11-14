// Test harness only (never imported by the app): loaded into the Next server with
//   NODE_OPTIONS="--import <abs path>/e2e/nadhra/netlog.mjs" NETLOG_FILE=<file> [NETLOG_DELAY_FILE=<file>]
// Records every connection and fetch the server process tries to make to a non-local host, and
// BLOCKS it: nothing reaches Google, OpenRouter, Microsoft or anyone else, and no quota is used, but
// every attempt is in the log. Local connections (the browser, 127.0.0.1) pass untouched.
//
// A blocked fetch answers HTTP 502 (as an unreachable upstream behind a gateway would): the server
// then sees "reachable but failing", which keeps its passive connectivity state at "up" and puts no
// provider in cooldown. A blocked socket is destroyed. When NETLOG_DELAY_FILE holds a number, each
// blocked attempt waits that many ms first (read on every call), so a test can switch providers while
// a request is still in progress.
import fs from "node:fs";
import net from "node:net";

const FILE = process.env.NETLOG_FILE;
const DELAY_FILE = process.env.NETLOG_DELAY_FILE;
const local = (host) => !host || /^(localhost|127\.|::1$|::ffff:127\.|0\.0\.0\.0)/.test(String(host));
const log = (entry) => FILE && fs.appendFileSync(FILE, JSON.stringify({ t: Date.now(), pid: process.pid, ...entry }) + "\n");
const delayMs = () => {
  if (!DELAY_FILE) return 0;
  try {
    return Number(fs.readFileSync(DELAY_FILE, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};
const abortError = () => Object.assign(new Error("This operation was aborted"), { name: "AbortError" });

const realFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  if (host && !local(host)) {
    log({ via: "fetch", method: init?.method ?? (typeof input === "object" && input?.method) ?? "GET", url });
    const signal = init?.signal;
    const ms = delayMs();
    if (ms) {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        const t = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => (clearTimeout(t), reject(abortError())), { once: true });
      });
    }
    if (signal?.aborted) throw abortError();
    return new Response("blocked by the e2e network harness", { status: 502 });
  }
  return realFetch.call(this, input, init);
};

// Every other way out (http/https modules, WebSockets, DNS-then-connect) goes through net.Socket.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  let o = args[0];
  if (Array.isArray(o)) o = o[0];
  const host = o && typeof o === "object" ? (o.path ? "unix" : o.host) : typeof args[1] === "string" ? args[1] : "localhost";
  if (host !== "unix" && !local(host)) {
    log({ via: "socket", host, port: o && typeof o === "object" ? o.port : o });
    const ms = delayMs();
    const kill = () => this.destroy(new Error(`e2e netlog: blocked ${host}`));
    if (ms) setTimeout(kill, ms);
    else process.nextTick(kill);
    return this;
  }
  return realConnect.apply(this, args);
};
