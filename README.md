# Nadhra (نظرة): vision assistant for blind people

A web app for blind and visually impaired people. Point a camera at your surroundings and hear them described in Tunisian Arabic, get warnings about hazards, have text read aloud, and ask questions with your voice.

> **This is an experimental test version and an aid only. It does not replace a white cane, a guide dog, or help from other people.** It can be wrong, a warning can arrive seconds late, and silence never means the way is safe.

This is an independent project. It shares no code, dependencies or configuration with the Tunisian Sign Language translator.

## Run it

Requires Node.js 22 or newer.

```bash
npm install          # also downloads the on-device detection model
cp .env.example .env.local   # then add at least GEMINI_API_KEY (skip if .env.local exists)
npm run dev          # http://localhost:3000
```

Open the address, press **Start camera**, and accept the privacy notice. The camera and microphone only work on `http://localhost` or HTTPS, so to test on a phone, use a deployed HTTPS address.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` then `npm start` | Production build and server |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (no network, no keys) |
| `npm run e2e -- <fixtures> [url] [screenshots]` | Browser tests, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#browser-tests) |

## Using it

The interface is in English. **The assistant speaks and listens in the language chosen in Settings:** Tunisian Arabic (the default), Modern Standard Arabic, French or English. It answers in that language even when a question is typed in another. Voice commands are understood in all four, whatever the setting. Everything can be done without seeing the screen: the assistant speaks every state change, short tones mark events, and phones vibrate (this can be turned off).

| Action | Button | Key | Voice (examples) |
|---|---|---|---|
| Camera on or off | Start assistance / Stop camera | `C` | «شعّل الكاميرا», "Open camera", « Allume la caméra » |
| Describe the surroundings | Describe surroundings | `D` | «وصفلي البلاصة», "Describe my surroundings" |
| Read text aloud | Read text | `T` | «اقرالي الكتابة», "Read this text", « Lis le texte » |
| Identify an object or product | Identify object | `I` | «شنوة هاذي؟», "What is this?" |
| Hands-free voice commands on or off | Voice commands | `V` | «سكّر الميكرو», "Stop listening" |
| Ask one question | Ask by voice | `Q` | any question, with voice commands on |
| Pause or resume analysis | Pause / Resume analysis | `P` | «وقّف التحليل», «كمّل», "Pause", "Continue" |
| Repeat the last sentence | Repeat last sentence | `R` | «عاود», "Repeat", « Répète » |
| Stop talking | Stop talking | `Esc` | «اسكت», "Stop talking" |
| Hear what you can say | Help | `H` | «شنوة نجم نقول؟», "Help", « Aide » |
| Close a panel, or cancel a question | Close | `Esc` in a panel | «رجّع», "Go back", « Retour » |
| Volume and speed | Settings | | "Louder", "Quieter", "Faster", "Slower" |
| Change language | Settings | | "Speak French", «احكي بالتونسي», « Parle anglais » |
| Emergency page | Emergency assistance | | «نجدة», "Emergency", « Au secours » |

Describe, Read and Identify start the camera first if it is off. The full list of voice commands is in Settings.

**Emergency assistance** calls or texts a contact saved in Settings (kept on the device only), with the current location as a map link when the browser can get it, and lists Tunisia's emergency numbers (SAMU 190, police 197, civil protection 198). Browsers only open the phone app from a real tap, so saying "call" selects the Call button, ready for one tap or double-tap. Nothing is dialled or sent without that.

Settings also has speech volume, text size (on top of the browser's own font size, which the page follows), vibration, and whether descriptions are automatic.

Questions can also be asked with the ready-made buttons or by typing. Screen readers often capture letter keys in browse mode, so use their pass-through mode for the shortcuts, or use the buttons.

**Set the camera direction in Settings.** It decides whether left and right are correct. A laptop webcam normally looks at you, so it is treated as a mirror: what is on the image's left is on your right. If you point the webcam away from you, choose "Ahead of me".

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
| `EDGE_TTS_VOICE` | Fallback voice. Default is the Tunisian `ar-TN-HediNeural` |

Paid models are refused by design, so a misconfiguration can't produce a bill. To use a paid tier, change this check in [src/lib/ai/vision.ts](src/lib/ai/vision.ts).

## Deploy to Vercel

1. Put this folder in its own Git repository, or run `vercel` from it.
2. Create a Vercel project with this folder as the root. No special build settings are needed. `npm install` runs the model download.
3. Add `GEMINI_API_KEY` (and optionally `OPENROUTER_API_KEY`), and set `APP_URL` to your site's address.
4. Deploy, then test the camera and microphone on the HTTPS address.

## Privacy

- The browser asks permission for the camera and microphone, and the app asks for consent first.
- No video is recorded and no image or audio is stored by this app. Frames are held in memory only long enough to send.
- **Camera images go to an external AI service** (Google Gemini, or OpenRouter as the fallback). Under free-tier terms, these services may keep the content and use it to improve their products, and it may be seen by human reviewers. Check the current terms before offering this to real users, and consider a paid tier that excludes this. People around the user appear in these images too.
- **Spoken questions** go to the browser's speech service (Google, in Chrome), or to Gemini when recording is used.
- Text sent to the fallback voice goes to Microsoft's online service.
- The camera and microphone are released when turned off or when the page is left.
- Location is only requested when the Emergency page opens, and is only put into a text message that the user sends from their own phone app. It never reaches this app's server.

## Known limits

- **Warnings are not instant.** The on-device detector reacts in under a second, but only knows common objects. Stairs, floor-level changes and other hazards rely on the cloud model, which takes about 2–3 s when healthy and more when busy. A fast car can arrive before any warning.
- **"Near" and "far" are judged from the picture,** never measured. No distances are given, because a single camera can't measure them reliably.
- **The French, English and Standard Arabic wording, and the Derja,** were written without native-speaker review. The Derja is also written by an AI model and spoken by a synthetic voice. It needs review by Tunisian blind users. Browser voices that aren't `ar-TN` will pronounce it less naturally.
- **Offline, only on-device warnings work.** The app says so and stops sending frames. The voice then works only if the device has a voice installed for the chosen language.
- **Free-tier services can be busy or change.** The Edge voice in particular is an unofficial endpoint with no guarantee.
- **Speech recognition has only been tested on synthetic speech.** Real voices, accents and noise will do worse. Check "I heard" on screen when an answer seems wrong.
- **Hands-free mode treats any nearby speech as a question,** which uses quota. Use the Ask button in noisy places.
- **Smart glasses are not supported yet.** The camera input is modular so they can be added ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-another-camera)), but nothing has been tested on real glasses.
