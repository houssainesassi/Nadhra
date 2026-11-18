# Location, nearby places and walking directions

Status 2026-11-18: implemented and tested automatically. **Not yet tested on a phone, outdoors, or by blind users.** Nothing is committed.

## What the user can do

In a Talk with Nadhra conversation (Gemini), by voice:

| Says | What happens |
|---|---|
| «وين أنا توّا؟», «win ena taw», "where am I?" | GPS position → OpenStreetMap address, said by Nadhra («إنت في نهج اليونان، باب البحر…») |
| «شنوّة فمّا قريب؟», «chnowa fama 9ribi» | Everyday places nearby (pharmacies, shops, cafés, banks, stops…), the nearest 1–3 with approximate straight-line distances |
| «win a9reb pharmacie», "nearest hospital" | The nearest of that kind, by its real name on the map |
| «nheb nemchi lel a9reb pharmacie», "guide me there", "go there" | A real walking route. Nadhra says the distance and time and **asks before starting** |
| «إيه», "yes" (in the next turn) | Guidance starts: the phone speaks every direction itself |
| «قدّاش باقي؟», "what's next?" | Distance left and next direction |
| «وقّف التوجيه», "stop navigation", «arrête le guidage» | Guidance stops as soon as the words are heard |

The same things work with buttons in **Settings → Location & directions**, a panel also reachable from the screen-reader actions in a session. It has where am I, refresh, stop using my location, a place-type list, the results in text with a Directions button each, Start/Stop navigation, an optional map, and "Forget my location permission". While guidance runs, the main screen (home and session) shows a strip with the destination, the distance left, the GPS state and a large **Stop navigation** button.

## How it works

```
Gemini Live (browser WebSocket)                       phone (browser)                         this server          OpenStreetMap
  model decides to call a tool  ── toolCall ──▶  LiveSession → controller.onLiveToolCall
                                                   GeoController.runTool
                                                     GPS (navigator.geolocation)
                                                     /api/geo/reverse  ───────────────────▶  geo.ts  ──▶ Nominatim
                                                     /api/geo/nearby   ───────────────────▶  geo.ts  ──▶ Overpass (→ Nominatim)
                                                     /api/geo/route    ───────────────────▶  geo.ts  ──▶ OSRM foot (FOSSGIS)
  model answers from the result ◀─ toolResponse ──  (ids, names, addresses, rounded distances; never coordinates)
                                                   RouteNavigator (each GPS position) → phone speaks directions (Sulafat)
```

- **The model never makes up directions.** It only finds and confirms. The route's manoeuvres (OSRM) become sentences through fixed templates in `src/lib/geo/phrases.ts` (Derja, MSA, French, English). The phone speaks them in Sulafat's voice, through the same speech queue as the warnings. A direction at a turn is spoken at warning priority: it interrupts and cuts off the live model.
- **Confirmation is enforced by the app, not left to the prompt.** `start_navigation` is refused (`needs_user_confirmation`) unless the user has spoken since the route was presented. The Start button counts as confirmation.
- **No coordinates go to Gemini.** Places get short ids (`p1`, `p2`…) and the phone keeps the positions. This also means the model can't invent a destination.
- When the phone speaks for a tool (the consent notice, the start of guidance, the stop), the model's words for that turn are neither played nor shown.
- When a tool takes more than 2.5 s (a slow map service), the phone says «نلوّج في الخريطة، لحظة» so the wait isn't silent.

### GPS accuracy (`src/lib/geo/navigator.ts`)

| Reported accuracy | Behaviour |
|---|---|
| ≤ 20 m | «In about 70 m, turn right» before the turn (when the stretch is ≥ 45 m), and «Now, turn right» within 15 m |
| 20–40 m | No «now». Near the turn: «You are getting close: turn right. GPS isn't precise right now, check with your cane or ask someone» |
| > 40 m | Directions pause. «GPS isn't precise» is said once, and leaving the route isn't judged |
| no position for 20 s | «GPS signal lost, directions paused», once, then «GPS is back» |

- **Off the route:** more than max(30 m, 1.5 × accuracy) away, for 3 positions over at least 6 s. It is said once, then one new route is requested. Recalculation happens at most every 15 s, up to 12 times, and is never requested for every position. A failed recalculation is said, and retried after 30 s.
- **Wrong way:** going back 25 m along the route with accuracy ≤ 20 m.
- **Arrival:** within max(15 m, accuracy up to 25 m) of the destination. The phone says «وصلت تقريباً… ثبّت بالعصا ولا اسأل حد» and the GPS watch stops.
- Each sentence has a key and is said at most once. The start sentence already gives the first turn, so its «in about 70 m» isn't repeated.
- The GPS is read once per question (reused for 10 s), and watched continuously only during guidance. It stops at once when guidance ends, on arrival, on "stop", on "stop using my location", or when permission is withdrawn.

### Server (`src/lib/server/geo.ts`, `geoRoute.ts`, `src/app/api/geo/*`)

- Same guard as every paid route: same-origin, session cookie, per-minute limits and daily budgets (`geo` kind). The routes are refused for Nadhra AI and `AI_MODE=offline`, and turned off by `GEO_DISABLED=1`.
- Nominatim: one request a second per instance, User-Agent `Nadhra/0.1 (… APP_URL[; GEO_CONTACT_EMAIL])`, results cached 24 h per ~11 m cell.
- Overpass first for places. If it fails, both servers are skipped for 5 minutes and Nominatim's structured `amenity=` search answers instead. That list is flagged `list_may_be_incomplete`, and the model and screen say so. Lists are cached 15 min (5 min from the fallback) per ~110 m cell, and distances are recomputed from the exact position.
- OSRM foot profile (`routing.openstreetmap.de/routed-foot`), cached 10 min. Routes over 20 km are refused as too far before any request.
- Timeouts on every call (8 s; 14 s total for a place search). Failures become typed errors (`timeout`, `rate-limited`, `upstream`, `no-route`, `too-far`), then short spoken messages.
- Positions are never logged. A test checks that the logs contain no coordinates.

## Privacy and consent

- **Location has its own spoken notice** (`GEO_PHRASES.*.consentNotice`), asked the first time a location tool or button is used. It is answered with «موافق» / "I agree" or the button. The browser's own permission prompt appears right after. If the user says no, the model's tools don't ask again for 2 minutes.
- The existing camera consent and the in-app Privacy text say location stays on the device. That is still true for the Emergency page, and location & directions can't be used without its own notice. **The in-app Privacy & safety text was not changed**, because privacy wording needs the project owner's approval. Proposed extra line:
  > "Location & directions (only after its own notice): your position goes through this app's server to OpenStreetMap services to find addresses, places and walking routes. It isn't stored. In a conversation, place names, addresses and distances (not your coordinates) go to Google Gemini. GPS is used continuously only during navigation."

## Tests

| | Result (2026-11-18) |
|---|---|
| Unit + integration (`npm test`, incl. `tests/geo*.test.ts`, live and controller additions) | all pass (see the final report) |
| `e2e/geo/live-tools.ts`: **real** Gemini Live + **real** OpenStreetMap, fixed GPS position in central Tunis, 7 turns | right tool every turn, start only after «إيه», Derja answers, no invented places |
| `e2e/geo/browser.mjs`: production build in Chromium, real map services, emulated GPS walked along the real route | 28/28 |
| `e2e/controls.mjs` (existing camera/microphone e2e) | 57/57 |

Recorded fixtures (`tests/fixtures/geo/`) are real answers from Nominatim and OSRM for central Tunis, captured 2026-11-18. They are used only by tests; production never uses mock places or positions.

## Known limitations

- **Untested on a real phone, outdoors, with TalkBack, or by blind users.** GPS behaviour on real streets (multipath between buildings, jumps) is only simulated.
- **OpenStreetMap data quality:** places can be missing, wrong or out of date. In central Tunis, "hospital" returned a dentists' professional body tagged as a hospital, and many places have no name. Opening hours, when present, may be stale.
- **Overpass was unreachable from the development machine** (HTTP 406 / timeouts on three mirrors). Everything was therefore tested through the Nominatim fallback, which finds fewer places, and "what's near" took about 9–11 s. Overpass itself is only tested with constructed answers. Check it from Vercel.
- **The public servers (Nominatim, Overpass, FOSSGIS OSRM) are for light use.** Before real traffic, use your own instances or a provider (`NOMINATIM_URL`, `OVERPASS_URLS`, `OSRM_FOOT_URL`). Rate limits are per server instance unless Upstash is configured.
- **No compass:** the phone doesn't know which way the user faces, so the first direction is "start walking", and a wrong direction is only noticed after ~25 m.
- **Routes say nothing about safety:** pavements, crossings, traffic lights, works and obstacles aren't known. Every start and arrival says so, and the camera warnings keep running.
- **In the background,** mobile browsers may pause GPS updates when the screen is off or another app is in front, so guidance may go silent. A native wrapper (Capacitor) would be needed for background guidance.
- **Walking time is OSRM's estimate** (~5 km/h), probably optimistic for many blind walkers.
- **The model's wording** of names and distances is checked only by prompt rules. It spelled a French name in Arabic letters once («دريرة عثمان»).
- **The OSM tile server** used by the optional map is also light-use only.
- **Navigation phrases** in MSA, French and English and the Derja were written without native-speaker review.
