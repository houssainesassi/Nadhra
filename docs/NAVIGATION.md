# Location, nearby places and walking directions

Status 2026-11-20: implemented, hardened, tested automatically. **Not yet tested on a phone, outdoors, or by blind users.** Nothing is committed or deployed.

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

- **Separate, explicit consent.** A spoken notice (`GEO_PHRASES.*.consentNotice`), also shown with two buttons, is given the first time a location tool or button is used. Only «موافق» / "I agree" or the button grants it; «إيه» doesn't. An unanswered notice lapses after 60 s, so a later «موافق» isn't taken as the answer. A refusal isn't asked again for 2 minutes. The browser's own permission prompt appears only after the yes. The camera and live-conversation consents don't cover location.
- **What the notice and the in-app Privacy & safety text say** (updated 2026-11-20 at the owner's request): GPS coordinates are sent to Nadhra's server, which asks OpenStreetMap services for the address, places and routes; they are not stored. In a conversation, the address, place names and distances (not the coordinates) are shared with Google Gemini. GPS is read on request, and continuously only during navigation. The Emergency page line now says only that its location goes into a message the user sends. The obsolete Microsoft voice line was replaced with the Gemini/Sulafat voice it actually uses.
- "Stop using my location" forgets the position and places; "Forget my location permission" withdraws the consent, stops guidance, and the notice is asked again next time.

## Map services: what was found (2026-11-20)

- **Why Overpass failed.** The public servers refuse or queue automated requests. overpass-api.de answers **406** to requests that look automated (curl, generic or URL-bearing User-Agents). When it does accept one, it answers *"at capacity… intended for browser-based and human-operated tools. For automated or high-volume use, run a local Overpass API instance."* The mirrors (kumi.systems, private.coffee, mail.ru, osm.jp) timed out or answered 504. This is not specific to this machine, and a Vercel region would very likely be treated the same. **Treat public Overpass as unavailable**: set `OVERPASS_URLS=off`, or point it at your own instance.
- Overpass now has a 5 s timeout. A 406/403 skips it for an hour; other failures skip it for 5 minutes.
- **Nominatim fallback, checked live in central Tunis:** every category returns real places in 0.2–3.3 s ("any" ~3.3 s). Some categories need several type words: clinics are found as "doctors" (not "clinic"), groceries as "greengrocer"/"bakery". The fallback finds fewer places than Overpass, so its lists are flagged as possibly incomplete.
- **Nominatim rate limit:** one request a second for the whole app. It is spaced in each server instance and also takes that second's slot in the shared counters (Upstash when configured), so serverless instances don't add up. Measured: four parallel requests went out 1.10 s apart. Without Upstash on Vercel, two instances could still each send one a second.
- **Misleading categories** (`placeDoubt` in `osm.ts`), for pharmacy, hospital and clinic:
  - A place is *doubtful* when its name is an organisation's (an order, union, ministry, association… in French or Arabic), when it is also tagged as an office, or when it names a smaller place (a dental or doctor's practice, a laboratory or a pharmacy under "hospital"; a parapharmacy under "pharmacy").
  - A name that confirms the category («Pharmacie de l'Ordre», «مستشفى…») isn't doubted, and «معهد» / "Institut" isn't either, because it names real Tunisian hospitals.
  - Doubtful places are never ranked first or taken as "the nearest"/"go there". The model gets `map_doubt`, and the button path says the map may be wrong.
  - Disused, abandoned, closed or ended places are dropped.
  - Checked live: for "hospital", the dentists' order and a dental practice were flagged, and the nearest result became a real hospital (Hôpital Aziza Othmana).
- **Testing the deployment:** `GET /api/health?geo=1` with `Authorization: Bearer <HEALTH_TOKEN>` makes one light request to each service from the deployment's region and reports status and latency. `e2e/geo/services.ts` does the same from a machine, plus the category and rate checks. **It has not been run on Vercel**, because deploying needs approval.

## Android and background behaviour

Nadhra is a web app in Chrome on Android: **there is no Capacitor or native project in this repository.**

| Situation | What happens |
|---|---|
| Screen on, Nadhra in front | Guidance works: GPS watched with high accuracy, directions spoken. A **screen wake lock** keeps the screen from turning off by itself during guidance (Chrome Android supports it; released when guidance ends). |
| Screen locked, or another app in front | Chrome gives a hidden page no positions, throttles its timers and the app stops its own speech. Guidance **pauses**: the GPS watch is released (no battery spent for nothing), and nothing is judged or said. The strip shows "paused". The start of guidance says once: keep the screen on and Nadhra open. |
| Back to Nadhra | Said: «التوجيه كان واقف… نكمّلو، نلوّج على بلاصتك». The GPS is watched again, and guidance continues from the next position, with a new route if the user is now off it. |
| Tab or browser closed | Guidance ends (the page is gone). |
| Live conversation | It ends when the page is hidden (as before). Guidance survives it; ending a conversation by voice or with End says how to stop guidance without a microphone. Focus moves to Stop navigation, and the N key stops it too. |

**Battery** (estimated, not measured):
- The biggest costs are the screen kept on and high-accuracy GPS, then the live conversation (microphone, camera and about one picture a second over the network, plus TTS audio).
- Guidance alone (screen on, GPS) might use roughly 10–20 % an hour on a mid-range phone, and a live conversation on top much more.
- Mitigations in place: GPS only on request or during guidance, released at once when guidance ends or the page is hidden; positions evaluated at most once a second; routes recalculated at most every 15 s; map answers cached.
- Measure on the target phones before longer walks.

**Permissions and configuration needed today (Chrome, no native app):**
- Android Settings → Apps → Chrome → Permissions → **Location: "Allow only while using the app"** (background location isn't needed and wouldn't help a web page).
- **"Use precise location" ON** for Chrome (Android 12+). With approximate location, accuracy is around 1–3 km and every direction stays paused ("GPS isn't precise").
- Device location ON. Google Location Accuracy ON helps in cities.
- In Chrome, the site's Location permission set to Allow (asked after Nadhra's own notice). The site must be served over HTTPS (Vercel is). The server already sends `Permissions-Policy: geolocation=(self)`.
- Battery saver: some phones (Samsung, Xiaomi) may stop GPS or lower its accuracy. Turn it off for a test walk.

**If a native Android wrapper (Capacitor) is built later**, guidance with the screen off needs native work. A WebView in the background doesn't run JavaScript reliably or play its audio. Required:
- `AndroidManifest.xml`: `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` (both, to be offered precise location on Android 12+); `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_LOCATION` (Android 14+); `POST_NOTIFICATIONS` (Android 13+, for the service's ongoing notification); `INTERNET`. `WAKE_LOCK` is only needed if a partial wake lock is used.
- A foreground `Service` with `android:foregroundServiceType="location"`, started while the app is visible (when the user starts guidance). Location then keeps flowing with only "while in use" permission. **Avoid `ACCESS_BACKGROUND_LOCATION`**: it needs "Allow all the time", a Play Console declaration and review, and isn't needed with a foreground service.
- The navigation logic (`RouteNavigator`) and speech running in the service, natively or via a plugin that delivers locations to native code, plus native audio focus for the voice. Directions can't depend on the WebView's JavaScript while the screen is off.
- Plugins to evaluate: `@capacitor/geolocation` (foreground only), `@capacitor-community/background-geolocation` (foreground-service based). A Play Store "prominent disclosure" for location is also needed.

## Tests

| | Result (2026-11-20) |
|---|---|
| Unit + integration (`npm test`) | 534/534. Includes background pause and resume (real `visibilitychange`), GPS loss and recovery (watch errors, signal check, loss twice), consent (pending, lapse, refusal, withdrawal, separation), every way of stopping (button, tool, voice on the partial transcript, N key, stop tracking, late positions ignored), misleading categories, the privacy text |
| `e2e/geo/live-tools.ts`: **real** Gemini Live + **real** OpenStreetMap, fixed GPS position, 7 turns (run 2026-11-18) | right tool every turn, start only after «إيه», no invented places or positions relative to the user |
| `e2e/geo/services.ts`: real services from the dev machine | Nominatim and OSRM OK; Overpass refused or at capacity; all 15 categories answered by the fallback; 1.1 s spacing kept |
| `e2e/geo/browser.mjs`: production build in Chromium, real map services, emulated GPS | see the final report |
| `e2e/controls.mjs` (existing camera/microphone e2e) | 57/57 |

Recorded fixtures (`tests/fixtures/geo/`) are real answers from Nominatim and OSRM for central Tunis, captured 2026-11-18. They are used only by tests; production never uses mock places or positions.

## Known limitations

- **Untested on a real phone, outdoors, with TalkBack, or by blind users.** GPS behaviour on real streets (multipath between buildings, jumps) is only simulated.
- **OpenStreetMap data quality:** places can be missing, wrong or out of date. In central Tunis, "hospital" returned a dentists' professional body tagged as a hospital, and many places have no name. Opening hours, when present, may be stale.
- **Public Overpass refuses or queues automated use** (see above). In practice the Nominatim fallback is the place search, and it finds fewer places. Overpass parsing is only tested with constructed answers.
- **The public servers (Nominatim, Overpass, FOSSGIS OSRM) are for light use.** Before real traffic, use your own instances or a provider (`NOMINATIM_URL`, `OVERPASS_URLS`, `OSRM_FOOT_URL`). Rate limits are per server instance unless Upstash is configured.
- **No compass:** the phone doesn't know which way the user faces, so the first direction is "start walking", and a wrong direction is only noticed after ~25 m.
- **Routes say nothing about safety:** pavements, crossings, traffic lights, works and obstacles aren't known. Every start and arrival says so, and the camera warnings keep running.
- **No guidance with the screen off.** It pauses, says so on return, and continues. Real background guidance needs a native foreground service (see Android).
- **Not testable without a physical Android phone:** real GPS accuracy, jumps and multipath in streets; whether Chrome on a given phone really delivers no positions when hidden (Nadhra pauses either way); the wake lock in a pocket or bag; TalkBack's reading of the strip and panel; hearing Sulafat in street noise, and audio with other apps; battery drain; approximate-location permission; vendor battery savers.
- **Walking time is OSRM's estimate** (~5 km/h), probably optimistic for many blind walkers.
- **The model's wording** of names and distances is checked only by prompt rules. It spelled a French name in Arabic letters once («دريرة عثمان»).
- **The OSM tile server** used by the optional map is also light-use only.
- **Navigation phrases** in MSA, French and English and the Derja were written without native-speaker review.
