// A real Gemini Live conversation using the location tools, end to end: the app's own token route,
// LiveSession, GeoController, and the app's map routes calling the real OpenStreetMap services.
// The only stand-in is the GPS (this machine has none): a fixed position in central Tunis.
// Uses real Gemini Live quota (a few turns) and a handful of OpenStreetMap requests.
//   node --experimental-strip-types --conditions=react-server e2e/geo/live-tools.ts
import { readFileSync } from "node:fs";
import { LiveSession } from "../../src/lib/live/session.ts";
import { POST as tokenPOST } from "../../src/app/api/live/token/route.ts";
import { POST as reversePOST } from "../../src/app/api/geo/reverse/route.ts";
import { POST as nearbyPOST } from "../../src/app/api/geo/nearby/route.ts";
import { POST as routePOST } from "../../src/app/api/geo/route/route.ts";
import { GeoController } from "../../src/lib/geo/geoController.ts";
import { isGeoTool } from "../../src/lib/geo/tools.ts";
import type { GeoApi, PositionSource } from "../../src/lib/geo/client.ts";
import { issueSessionToken, SESSION_COOKIE } from "../../src/lib/server/session.ts";

for (const line of readFileSync(new URL("../../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
}
process.env.AI_MODE = "cloud";

const headers = () => ({ host: "localhost", origin: "http://localhost", cookie: `${SESSION_COOKIE}=${issueSessionToken().token}`, "content-type": "application/json" });
const call = async (fn: (r: Request) => Promise<Response>, body: unknown) => {
  const res = await fn(new Request("http://localhost/api/geo", { method: "POST", headers: headers(), body: JSON.stringify(body) }));
  const d = await res.json();
  if (!res.ok) throw Object.assign(new Error(d.error), { code: d.error });
  return d;
};
const api: GeoApi = {
  reverse: (at, lang) => call(reversePOST, { ...at, lang }),
  nearby: (at, category, radius, lang) => call(nearbyPOST, { ...at, category, radius, lang }),
  route: async (from, to) => (await call(routePOST, { from, to })).route,
};
// Rue de Grèce, Tunis (Bab Bhar), accuracy 12 m.
const HERE = { lat: 36.7993, lon: 10.1802 };
const gps: PositionSource = { current: async () => ({ ...HERE, accuracy: 12, at: Date.now() }), watch: () => () => {} };

const spoken: string[] = [];
const log = (s: string) => console.log(s);
let userTurn = 0;
const geo = new GeoController({ lang: () => "tn", say: (t, k) => (spoken.push(t), log(`  [phone ${k}] ${t}`)), onChange: () => {}, position: gps, api, consent: { get: () => true, set: () => {} }, now: () => Date.now() });

let said = "";
let turnDone: (() => void) | null = null;
const toolLog: string[] = [];
const s = new LiveSession({ lang: "tn", facing: "outward", fetchImpl: async (_u, init) => tokenPOST(new Request("http://localhost/api/live/token", { ...(init as RequestInit), headers: headers() })) }, {
  aiText: (p) => (said += p),
  turnComplete: () => turnDone?.(),
  toolCall: async (calls) => {
    for (const c of calls) {
      const t0 = Date.now();
      const out = isGeoTool(c.name) ? await geo.runTool(c.name, c.args, { userTurn }) : { response: { ok: false, error: "unknown_tool" }, appSpoke: false };
      toolLog.push(c.name);
      log(`  [tool] ${c.name}(${JSON.stringify(c.args)}) → ${JSON.stringify(out.response).slice(0, 300)} (${Date.now() - t0} ms)`);
      s.sendToolResponse([{ id: c.id, name: c.name, response: out.response }]);
    }
  },
});

async function ask(text: string) {
  userTurn++;
  said = "";
  toolLog.length = 0;
  log(`\nUSER: ${text}`);
  const done = new Promise<void>((r) => (turnDone = r));
  s.sendText(text);
  await Promise.race([done, new Promise((r) => setTimeout(r, 45_000))]);
  log(`NADHRA: ${said.trim() || "(nothing)"}`);
  return { said: said.trim(), tools: [...toolLog] };
}

await s.start();
log(`connected: ${s.model}`);
const results = [];
results.push(await ask("وين أنا توّا؟"));
results.push(await ask("Chnowa fama 9ribi?"));
results.push(await ask("Win a9reb pharmacie?"));
results.push(await ask("Nheb nemchi lel a9reb pharmacie."));
results.push(await ask("إيه، يزّي نبداو"));
results.push(await ask("قدّاش باقي؟"));
results.push(await ask("وقّف التوجيه"));
s.stop();
geo.destroy();
log("\nSUMMARY");
results.forEach((r, i) => log(`${i + 1}. tools: ${r.tools.join(", ") || "none"}`));
log(`navigation started: ${spoken.some((t) => t.startsWith("نبداو."))}`);
process.exit(0);
