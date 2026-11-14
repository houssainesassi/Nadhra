#!/usr/bin/env bash
# Waits for the free Gemini quota to come back (both fast reading models answer), then runs the full
# 31-case plan (3 readings each) and the Chromium voice-reading test on the production build.
# Logs: e2e/read/out/final-plan.log, e2e/read/out/final-browser.log, e2e/read/out/after_quota.log
cd "$(dirname "$0")/../.."
export PATH=~/.nvm/versions/node/v24.20.0/bin:$PATH
log=e2e/read/out/after_quota.log
echo "$(date) waiting for quota" > "$log"
# Both fast models must answer in the same probe.
ready() { local out; out=$(node e2e/read/quota_probe.mjs); echo "$out" >> "$log"; grep -q "3.5-flash-lite 200" <<<"$out" && grep -q "3.1-flash-lite 200" <<<"$out"; }
until ready; do
  sleep 1200
  echo "$(date) still waiting" >> "$log"
done
echo "$(date) quota back: plan run" >> "$log"
RUNS=3 node --experimental-strip-types --conditions=react-server e2e/read/plan.ts e2e/read/out/plan > e2e/read/out/final-plan.log 2>&1
echo "plan exit $?" >> e2e/read/out/final-plan.log
cp e2e/read/out/plan-results.json e2e/read/out/final-plan-results.json
echo "$(date) browser test" >> "$log"
npx next start -p 3100 > e2e/read/out/final-server.log 2>&1 &
server=$!
for i in $(seq 1 60); do curl -s -o /dev/null http://localhost:3100/api/health && break; sleep 1; done
node e2e/read/browser.mjs e2e/read/out/fixtures http://localhost:3100 > e2e/read/out/final-browser.log 2>&1
echo "browser exit $?" >> e2e/read/out/final-browser.log
kill "$server"
echo "$(date) done" >> "$log"
