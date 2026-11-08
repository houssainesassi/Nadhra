# بصيرة (Basira): vision assistant for blind people

A web app for blind and visually impaired people. Point a camera at your surroundings and hear them described in Tunisian Arabic, get warnings about hazards, have text read aloud, and ask questions with your voice.

> **This is an aid. It does not replace a white cane, a guide dog or other mobility assistance.** It can be wrong, a warning can arrive seconds late, and silence never means the way is safe.

This is an independent project. It shares no code, dependencies or configuration with the Tunisian Sign Language translator.

## Run it

Requires Node.js 22 or newer.

```bash
npm install          # also downloads the on-device detection model
cp .env.example .env.local   # then add at least GEMINI_API_KEY (skip if .env.local exists)
npm run dev          # http://localhost:3000
```

Open the address, press **شعّل الكاميرا**, and accept the privacy notice. The camera and microphone only work on `http://localhost` or HTTPS, so to test on a phone, use a deployed HTTPS address.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` then `npm start` | Production build and server |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit tests (no network, no keys) |
| `npm run e2e -- <fixtures> [url] [screenshots]` | Browser tests, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#browser-tests) |

## Using it

Everything can be done without seeing the screen. The assistant speaks every state change, and short tones mark events.

| Action | Button | Key | Voice |
|---|---|---|---|
| Camera on or off | شعّل / سكّر الكاميرا | `C` | «شعّل الكاميرا»، «سكّر الكاميرا» |
| Hands-free microphone on or off | شعّل / سكّر المساعد الصوتي | `V` | «سكّر الميكرو» |
| Ask one question | اسأل بالصوت | `Q` | any question, with the assistant on |
| Pause or resume analysis | وقّف / كمّل التحليل | `P` | «وقّف التحليل»، «كمّل» |
| Repeat the last sentence | عاود آخر جملة | `R` | «عاود» |
| Stop talking | اسكت | `Esc` | «اسكت» |

Questions can also be asked with the ready-made buttons or by typing. Screen readers often capture letter keys in browse mode, so use their pass-through mode for the shortcuts, or use the buttons.

**Set the camera direction in Settings.** It decides whether left and right are correct. A laptop webcam normally looks at you, so it is treated as a mirror: what is on the image's left is on your right. If you point the webcam away from you, choose «تشوف قدّامي».

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

## Known limits

- **Warnings are not instant.** The on-device detector reacts in under a second, but only knows common objects. Stairs, floor-level changes and other hazards rely on the cloud model, which takes about 2–3 s when healthy and more when busy. A fast car can arrive before any warning.
- **"Near" and "far" are judged from the picture,** never measured. No distances are given, because a single camera can't measure them reliably.
- **The Derja is written by an AI model and spoken by a synthetic voice.** It needs review by Tunisian blind users. Browser voices that aren't `ar-TN` will pronounce it less naturally.
- **Offline, only on-device warnings work,** and the voice works only if the device has an Arabic voice installed.
- **Free-tier services can be busy or change.** The Edge voice in particular is an unofficial endpoint with no guarantee.
- **Hands-free mode treats any nearby speech as a question,** which uses quota. Use the Ask button in noisy places.
- **Smart glasses are not supported yet.** The camera input is modular so they can be added ([docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#adding-another-camera)), but nothing has been tested on real glasses.
