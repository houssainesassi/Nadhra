#!/bin/sh
# Test inputs for the live conversation checks: a photo (Wikimedia Commons, CC licence) and spoken
# Derja questions as 16 kHz PCM (and WAV for Chromium's fake microphone).
# Usage: sh e2e/live/make_fixtures.sh   (needs node on PATH, ffmpeg, network)
set -e
cd "$(dirname "$0")/../.."
OUT=e2e/live/out
mkdir -p "$OUT"
[ -s "$OUT/mech.jpg" ] || curl -sf -A "nadhra-test/1.0" -o "$OUT/mech.jpg" "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a6/Mechanic_repairing_car_engine_1.jpg/960px-Mechanic_repairing_car_engine_1.jpg"
q() {
  [ -s "$OUT/$1.pcm" ] && return
  node --experimental-strip-types --conditions=react-server e2e/live/synth.ts ar-TN-HediNeural "$2" "$OUT/$1.mp3" >/dev/null 2>&1
  ffmpeg -loglevel error -y -i "$OUT/$1.mp3" -ar 16000 -ac 1 -f s16le "$OUT/$1.pcm"
}
q q_mech "شنوة قاعد يصير توّا؟"
q q_right "وشنوّة فمّا على يميني؟"
q q_before "شنوّة قلتلي قبل شويّة؟"
q q_interrupt "استنّى استنّى، قلّي كان شنوّة لون الكرهبة؟"
ls -la "$OUT"
