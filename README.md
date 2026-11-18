# Nadhra (نظرة): vision assistant for blind people

A web app for blind and visually impaired people. Point a camera at your surroundings and hear them described in Tunisian Arabic (Derja), Modern Standard Arabic, French or English, get warnings about hazards, have text read aloud, and ask questions with your voice.

> **This is an experimental test version and an aid only. It does not replace a white cane, a guide dog, or help from other people.** It can be wrong, a warning can arrive seconds late, and silence never means the way is safe.

This is an independent project. It shares no code, dependencies or configuration with the Tunisian Sign Language translator.

## Run it

Requires Node.js 22 or newer.

```bash
npm install          # also downloads the on-device detection model
cp .env.example .env.local   # then add at least GEMINI_API_KEY (skip if .env.local exists)
npm run dev          # http://localhost:3000
```

Open the address, press **Open camera**, and accept the privacy notice. The camera and microphone only work on `http://localhost` or HTTPS, so to test on a phone, use a deployed HTTPS address.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` then `npm start` | Production build and server |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (no network, no keys) |
| `npm run e2e -- <fixtures> [url] [screenshots]` | Browser tests, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#browser-tests) |

## Using it

**The assistant speaks and listens in the language chosen with the selector at the top or in Settings:** Tunisian Arabic (Derja, the default), Modern Standard Arabic, French or English. A language you chose is remembered on the device. It answers a question in the question's own language when that is clearly one of the four. Voice commands are understood in all four, whatever the setting. The main screen's words follow the chosen language. Settings, Privacy & safety, the Emergency page and the consent notice are in English.

Everything can be done without seeing the screen: the assistant speaks every state change, short tones mark events, and phones vibrate (this can be turned off).

**The main screen** has two large buttons: **Open camera** and **Talk live**. Open camera shows the privacy notice the first time, then turns on the camera, the on-device warnings and hands-free voice commands. While assistance is on, the screen shows the camera, what the assistant last said, and these buttons:

| Action | Button | Key | Voice (examples) |
|---|---|---|---|
| Describe the surroundings | Describe surroundings | `D` | «وصفلي البلاصة», "Describe my surroundings" |
| Read text, a document or a medicine box | Read text | `T` | «اقرالي الكتابة», "Read this text", « Lis le texte » |
| Identify an object or product | Identify object | `I` | «شنوة هاذي؟», "What is this?" |
| Ask one question | Ask a question (press again to send) | `Q` | with voice commands on, just ask |
| Pause or resume automatic descriptions | Pause descriptions / Resume descriptions (only when descriptions are automatic) | `P` | «وقّف التحليل», «كمّل», "Pause", "Continue" |
| Stop everything | Stop assistance | `C` | «سكّر الكاميرا», "Close camera" |
| Live conversation on or off | Talk live / End live conversation (next to Open camera at rest; beside Stop assistance while assisting) | `L` | «وقّف المحادثة», "Stop live" |

Describe, Read and Identify start the camera first if it is off.

These have **no button on the main screen**:

| Action | Where | Key | Voice (examples) |
|---|---|---|---|
| Hands-free voice commands on or off | Settings: Voice commands | `V` | «سكّر الميكرو», "Stop listening" |
| What's in front of me | | | «شنوة قدّامي؟», "What's in front of me?" |
| Read the whole document | | | «اقرا الكل», "Read all" |
| Repeat the last sentence | | `R` | «عاود», "Repeat", « Répète » |
| Stop talking | | `Esc` | «اسكت», "Stop talking" |
| Hear what you can say | | `H` | «شنوة نجم نقول؟», "Help", « Aide » |
| Close a panel, or cancel a question | Close | `Esc` in a panel | «رجّع», "Go back", « Retour » |
| Volume and speed | Settings | | "Louder", "Quieter", "Faster", "Slower" |
| Change language | Selector, Settings | | "Speak French", «احكي بالتونسي», « Parle anglais » |
| Automatic descriptions on or off | Settings | | «شعّل الوصف التلقائي», "Turn off automatic descriptions" |
| Emergency page | Settings: Open the Emergency page | | «نجدة», "Emergency", « Au secours » |

Help speaks the list of voice commands. There is no typed question box.

**Automatic descriptions are off by default.** No picture leaves the phone unless you ask: a button, a question, a reading or a live conversation. On-device warnings for people and vehicles run either way. **Stairs and drops are only detected by the cloud analysis,** so they are not detected while automatic descriptions are off (except every 8 s or so during a live conversation). Turning automatic descriptions on sends a picture to Google every few seconds.

**Talk live** is a spoken conversation, like a phone call. It turns the camera on, and from then on you just talk: ask about what the camera shows, follow up, or interrupt the answer whenever you like. The assistant answers in a female voice, in the chosen language, and starts speaking about a second after you stop. It asks for its own consent first. The microphone and camera stream to Google's Gemini Live service while it is on, and the assistant reminds you every 5 minutes. On-device warnings for people and vehicles keep working, and cut the conversation off when they speak. Press it again, press `L`, or press Stop assistance to end it.

**Reading documents and medicine boxes** (Read text, «اقرالي الدوا», "read the prescription"): the app takes two pictures, has them read by two different models, and checks each printed line in the pictures. A name, dose or date is only read if both readings agree word for word and the line is fully visible. Each is followed by "check it with the pharmacist". Doses are held back when the picture has glare or blur, handwritten doses are never read, and the app never gives medical advice. This has only been tested with rendered sample documents, not real boxes. Don't use real prescriptions while testing: the pictures go to Google's free service.

**Emergency assistance** calls or texts a contact saved in Settings (kept on the device only), with the current location as a map link when the browser can get it, and lists Tunisia's emergency numbers (SAMU 190, police 197, civil protection 198). Browsers only open the phone app from a real tap, so saying "call" selects the Call button, ready for one tap or double-tap. Nothing is dialled or sent without that. If the location can't be found (refused, unavailable or not supported), the assistant says so after the page's opening sentence: the message will ask them to call you.

**Location and walking directions** (Gemini only; details in [docs/NAVIGATION.md](docs/NAVIGATION.md)). In a conversation, ask «وين أنا توّا؟», «chnowa fama 9ribi?», «win a9reb pharmacie?», «kifeh nemchi lel pharmacie?» or "guide me to the nearest hospital". The live model calls location tools instead of guessing: the phone's GPS, OpenStreetMap addresses and places, and real walking routes (OSRM). It says the walking distance and time and asks before starting. Then the phone itself speaks each direction in Sulafat's voice, from the route, with more caution when GPS is imprecise. It notices when you leave the route or walk the wrong way, works out a new route, and says when the GPS signal is lost. «وقّف التوجيه» / "stop navigation" stops at once. Location has its own spoken consent, asked the first time. Guidance keeps running after the conversation ends, with a large Stop navigation button on the main screen. The same things work with buttons in Settings → Location & directions, which also has an optional map (Leaflet + OpenStreetMap). The map is never needed.

Settings also has speech speed and volume, text size (on top of the browser's own font size, which the page follows), colours, vibration, sending speech to your screen reader, and switching camera.

Screen readers often capture letter keys in browse mode, so use their pass-through mode for the shortcuts, or use the buttons.

**Set the camera direction in Settings.** It decides whether left and right are correct. A laptop webcam normally looks at you, so it is treated as a mirror: what is on the image's left is on your right. If you point the webcam away from you, choose "Ahead of me".

**Gemini or Nadhra.** When the server sets `NADHRA_AI_ENABLED`, a switch at the top of the main screen chooses between Gemini (the cloud AI described above) and Nadhra (experimental), the project's own on-device engines. **No Nadhra engine is connected yet.** With Nadhra chosen, nothing is sent from the page: only the on-device warnings, the device's own voices and the Emergency page work, and every other request is refused out loud.

## Supervised Android test build

Follow [docs/ANDROID_TESTING.md](docs/ANDROID_TESTING.md) for every session. The camera, microphone and location only work on `localhost` or HTTPS.

**Option A: from this computer, over USB (nothing is deployed).** Chrome treats `localhost` as secure, so this needs no certificate.

1. `npm install`, then `cp .env.example .env.local` (skip if it exists) and set `GEMINI_API_KEY` in it.
2. `npm test && npm run build && npm start`. The app runs on port 3000.
3. On the phone: in Settings, About phone, tap Build number 7 times. Then in Developer options, turn on USB debugging.
4. Connect the phone by USB and accept the prompt on the phone. Run `adb devices`; the phone should be listed. Then run `adb reverse tcp:3000 tcp:3000`.
5. In Chrome on the phone, open `http://localhost:3000`. The phone must stay connected by USB while testing.

**Option B: a private HTTPS preview on Vercel** (needed for testing away from the computer).

1. In the Vercel dashboard, create a project with this folder as its root. Under Settings, Deployment Protection, keep **Vercel Authentication** on, so only signed-in team members can open previews.
2. Add `GEMINI_API_KEY` (and optionally `OPENROUTER_API_KEY`) for the **Preview** environment.
3. From this folder, run `npx vercel deploy`. Without `--prod`, this makes a preview, not the public site.
4. Open the preview address in Chrome on the phone and sign in to Vercel there.

## Configuration

Set these in `.env.local`, or in the Vercel project settings. Keys are read only on the server. [.env.example](.env.example) lists every option.

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Main vision provider, and speech-to-text for browsers without speech recognition |
| `OPENROUTER_API_KEY` | Optional last-resort fallback, free models only |
| `GEMINI_VISION_MODELS` | Models to try, in order |
| `GEMINI_TTS_MODEL` | Gemini TTS model for the assistant's own sentences (default `gemini-3.8-flash-tts`). The voice is always `Sulafat`; there is no fallback voice. `GEMINI_TTS_DISABLED=1` turns it off |
| `GEMINI_LIVE_MODELS` | Live conversation models, tried in order. Default `gemini-3.1-flash-live-preview,gemini-3.8-live` |
| `GEMINI_LIVE_VOICE` | Ignored: the live conversation always uses `Sulafat`, the app's only voice |
| `GEMINI_LIVE_SILENCE_MS` | Silence that ends your turn in a live conversation (default 500) |
| `GEMINI_LIVE_DISABLED` | `1` turns the live conversation off |
| `DAILY_*_GLOBAL`, `DAILY_*_PER_SESSION` | Daily budgets per kind of call (vision, transcribe, tts, live, search). The global values are the hard daily ceiling |
| `SESSION_SECRET` | Optional key for the session cookie (otherwise derived from `GEMINI_API_KEY`) |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Optional shared counters, so limits hold across serverless instances |
| `HEALTH_TOKEN` | Lets `/api/health` show counters and today's usage |
| `GEMINI_SEARCH_API_KEY` | Optional key from a billed Gemini project, used only for web-search answers (search isn't in the free tier). `GEMINI_SEARCH_ENABLED=false` turns search off |
| `AI_MODE` | `cloud` (default), `hybrid` or `offline`: which AI providers a task may use ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#ai-mode-and-routing-offline-track)). `offline` sends nothing and refuses what needs the cloud |
| `NADHRA_AI_ENABLED` | `1` shows the Gemini / Nadhra switch. No Nadhra engine is connected yet, so Nadhra requests are refused |
| `INTERNET_PROBE_URL` | Optional, hybrid mode only: an address checked to tell whether the internet is reachable |
| `GEO_DISABLED` | `1` turns location and directions off (the live model is then told it has no location). Off in `AI_MODE=offline` too |
| `OVERPASS_URLS`, `NOMINATIM_URL`, `OSRM_FOOT_URL` | Map services (defaults: the public OpenStreetMap ones). Point them at your own instances for real traffic |
| `GEO_CONTACT_EMAIL` | Optional contact added to the User-Agent the map services see, as the Nominatim policy asks |
| `GEO_RATE_LIMIT_PER_MIN`, `DAILY_GEO_PER_SESSION`, `DAILY_GEO_GLOBAL` | Limits on map requests (defaults 20 a minute, 400 a day per session, 5,000 a day in total) |

The API routes only answer this site's own page: a request needs the page's Origin and its anonymous session cookie, then per-minute limits and daily budgets apply ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#api-protection-and-cost-control)). This is not authentication: a determined script can still get a cookie. The daily totals are what cap the cost.

Paid models are refused by design, so a misconfiguration can't produce a bill. To use a paid tier, change this check in [src/lib/ai/vision.ts](src/lib/ai/vision.ts).

## Deploy to Vercel

1. Put this folder in its own Git repository, or run `vercel` from it.
2. Create a Vercel project with this folder as the root. No special build settings are needed. `npm install` runs the model download.
3. Add `GEMINI_API_KEY` (and optionally `OPENROUTER_API_KEY`), and set `APP_URL` to your site's address.
4. Deploy, then test the camera and microphone on the HTTPS address.

## Privacy

- The browser asks permission for the camera and microphone, and the app asks for consent first. Consent can be withdrawn in Privacy & safety: the camera and live conversation stop, the conversation and any remembered document are forgotten, and the notice comes back before the next start.
- Monitoring counts failures by fixed name and short code only (`/api/report`, `/api/health`). No images, audio, questions, answers or locations are logged.
- No video is recorded and no image or audio is stored by this app. Frames are held in memory only long enough to send.
- **Camera images go to an external AI service** (Google Gemini, or OpenRouter as the fallback). Under free-tier terms, these services may keep the content and use it to improve their products, and it may be seen by human reviewers. Check the current terms before offering this to real users, and consider a paid tier that excludes this. People around the user appear in these images too.
- **In a live conversation,** microphone audio and camera frames (at most one a second, fewer when nothing changes) go straight from the browser to Google Gemini Live. This app's server only hands out a one-time token that expires within minutes; the API key never reaches the browser, and no audio or image passes through the server.
- **Spoken questions** go to the browser's speech service (Google, in Chrome), or to Gemini when recording is used.
- Text sent to the fallback voice goes to Microsoft's online service.
- The camera and microphone are released when turned off or when the page is left.
- For the Emergency page, location is only requested when the page opens, and is only put into a text message that the user sends from their own phone app. It never reaches this app's server.
- **Location & directions is separate, with its own spoken consent.** After it, the position goes through this app's server to the OpenStreetMap services: Nominatim for addresses, Overpass for places, and the FOSSGIS OSRM server for walking routes. It is not logged. Answers are cached in server memory by rounded position, for at most a day. In a conversation, place names, addresses and rounded distances go to Gemini, but never coordinates. GPS is read once per question, and continuously only while guidance runs. "Stop using my location" forgets the position and places; "Forget my location permission" withdraws the consent.

## Known limits

- **Nothing has been tested on a real phone, with TalkBack, or by blind or low-vision users yet.** All testing so far is automated, on a computer, with a fake camera and microphone. The full status of every feature is in [docs/NAHDRA_COMPLETE_FEATURE_AUDIT.md](docs/NAHDRA_COMPLETE_FEATURE_AUDIT.md).
- **The medicine and document reader has only been tested on rendered sample documents.** Many readable lines are held back on purpose, and real boxes, bottles and handwriting are untested.
- **Live answers start about 1–1.5 s after you stop talking** (measured Nov 2026 with Gemini 3.1 Flash Live: median 1.07 s on our connection, occasionally 3 s). About half of that is the service waiting to be sure you have finished. The live model can still be wrong, including about left and right: in one of our test runs it answered about the wrong side. It was also told never to invent movement it can't see; check what matters.
- **The live voice's Tunisian accent was checked by a second AI model and by pitch measurement, not yet by Tunisian listeners.**
- **Warnings are not instant.** The on-device detector reacts in under a second, but only knows common objects. Stairs, floor-level changes and other hazards rely on the cloud model, which takes about 2–3 s when healthy and more when busy. A fast car can arrive before any warning.
- **Walking directions come from OpenStreetMap and phone GPS, both approximate.** GPS is often 10–50 m off between buildings, so precise turns are only announced when the reported accuracy is 20 m or better. Map data can be missing, wrong or out of date: in central Tunis, the nearest "hospital" on the map was a dentists' professional body, tagged as a hospital. Routes say nothing about obstacles, works, crossings or traffic lights. The public OpenStreetMap servers are for light use only. The GPS doesn't know which way you are facing, so the first direction is "start walking", and a wrong direction is noticed after about 25 m. Not yet tested on a real phone or outdoors.
- **"Near" and "far" are judged from the picture,** never measured. No distances are given, because a single camera can't measure them reliably.
- **The French, English and Standard Arabic wording, and the Derja,** were written without native-speaker review. The Derja is also written by an AI model and spoken by a synthetic voice. It needs review by Tunisian blind users. Browser voices that aren't `ar-TN` will pronounce it less naturally.
- **Pause stops descriptions, not on-device warnings.** Those keep running and the pause notice says so.
- **During Talk live,** stairs and drops still come from cloud scans, every 8 s at most, so they arrive later than outside the conversation. A live answer that promises safety is cut and corrected, but its first words may already have been heard.
- **Limits are per server instance** unless the Upstash store is configured. On Vercel, budgets are then approximate.
- **Offline, only on-device warnings work.** The app says so and stops sending frames. The voice then works only if the device has a voice installed for the chosen language. The app can't be opened without a connection (there is no offline cache), and no Nadhra engine works offline yet.
- **Free-tier services can be busy or change.** The voice (Gemini TTS, Sulafat) has a low per-minute limit on the free tier and takes 2–5 s per sentence; when it fails there is no other voice, the page shows it and the screen reader reads.
- **Speech recognition has only been tested on synthetic speech.** Real voices, accents and noise will do worse. Check "I heard" on screen when an answer seems wrong.
- **Hands-free mode treats any nearby speech as a question,** which uses quota. Use the Ask button in noisy places.
- **Smart glasses are not supported yet.** The camera input is modular so they can be added ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-another-camera)), but nothing has been tested on real glasses.
