# Phase 1 reader: Android device checklist

**For:** the sighted test operator (Stage B of the [validation plan](PHASE1_REAL_WORLD_TEST_PLAN.md)). With blind participants, the general rules in [ANDROID_TESTING.md](ANDROID_TESTING.md) also apply.

Record each line as ✅ works, ⚠️ works with a problem (write it down), or ❌ fails. Copy what the app said from "I heard" on screen, or note it by ear.

## 0. Setup (no deployment needed)

1. On the laptop: `npm run build && npx next start -p 3100`.
2. Phone in developer mode, USB debugging on, connected by cable. Then run `adb reverse tcp:3100 tcp:3100`.
3. On the phone, Chrome: `http://localhost:3100`. Through `adb reverse` this counts as a secure address, so the camera and microphone work.
4. On the laptop, Chrome: `chrome://inspect` → the phone's tab → **Inspect**, for the console and network checks below.

Record: phone model, Android version, Chrome version, RAM, rear-camera megapixels.

## 1. Camera resolution and capture path

In the remote console, after Open Camera:

```js
const t = document.querySelector("video").srcObject.getVideoTracks()[0];
t.getSettings();                                   // actual video width × height, frame rate
typeof ImageCapture === "function" && (await new ImageCapture(t).getPhotoCapabilities());  // full photo size
```

- [ ] Video resolution as delivered: ______ × ______ (the app asks for 1280 × 720)
- [ ] ImageCapture available: yes / no. Maximum photo size: ______ × ______
- [ ] During a reading, the network tab (`/api/vision`, `mode: "read"`) shows image length ______ characters. Over about 300,000 usually means the full-resolution still was used; about 100,000–200,000 means the video frame was.
- [ ] The preview freezes or flickers while the still is taken: yes / no, for how long
- [ ] The flash fires: never / sometimes (note the lighting)
- [ ] A shutter sound plays: yes / no
- [ ] Time from the end of «اقرالي الدوا» to «لحظة، نقرا» ("one moment, reading"): ______ s
- [ ] Time from the end of «اقرالي الدوا» to the first word of the reading: ______ s (three readings)

## 2. Focus and distance (box M01, good light)

Hold the box at each distance and say «اقرالي الدوا».

| Distance | Sharp in preview? | On-device refusal? | Strength read correctly? |
|---|---|---|---|
| 8 cm | | | |
| 15 cm | | | |
| 25 cm | | | |
| 40 cm | | | |

- [ ] The closest distance that still reads: ______ cm. Blind users tend to hold objects too close: this number goes into the user instructions.
- [ ] When the box fills less than a quarter of the frame, the "too small, come closer" tip is said.
- [ ] When part of the box is outside the frame, the "cut off, move back" tip is said.

## 3. On-device refusals

- [ ] Dim room (under about 20 lux): «الضو قليل…» ("too dark…") is said, and **no** `mode: "read"` request appears in the network tab.
- [ ] Hand moving during the command: «الصورة مهزوزة…» ("the picture is blurred…") within about 3 s, and no request is sent. Or, if the frame was sharp enough, a normal reading.
- [ ] Still hand, good light: **never** refused. A false refusal here means the blur limit is too strict for this camera. Write down the phone.

## 4. Voice interaction

With the phone speaker, then wired earphones, then Bluetooth earphones:

- [ ] «اقرالي الدوا» is understood on the first try (out of 5 tries: ______)
- [ ] «اقرالي الوصفة», «اقرالي الورقة» (read me the prescription / the paper)
- [ ] «lis l'ordonnance», "read the prescription"
- [ ] «اقرا الكل» (read all) reads the whole text **without** a new request in the network tab
- [ ] «وقتاش يوفى؟» (when does it expire?) after a reading: a request with `document` in it, and an answer that starts «مكتوب:» ("it says:")
- [ ] «اسكت» (stop) in the middle of a reading stops it at once
- [ ] «عاود» (repeat) repeats the last sentence
- [ ] A question asked while the reading is still playing: heard, or lost? (lost questions are a known issue to report)
- [ ] Background noise (TV or street): the commands are still understood (______ / 5)
- [ ] Bluetooth: the microphone used is the headset's or the phone's (note which); the voice comes through the headset

## 5. How the voices say the hard parts

Listen carefully and write down exactly what is heard:

| Printed | Voice | Heard | OK? |
|---|---|---|---|
| `500 mg` | French | | |
| `2,5 mg` | French | | |
| `2,5 mg` | Derja (if read by the Arabic voice) | | |
| `875 mg/125 mg` | French | | |
| `120 mg/5 ml` | French | | |
| `½ comprimé` | French | | |
| `1/2 cp` | French | | |
| `EXP 03/2027` | French | | |
| `03/2027` inside a Derja sentence | Derja | | |
| `باراسيتامول 500 ملغ` | Derja | | |
| `1000 UI` | French | | |

Any reading that changes the meaning ("deux virgule cinq" is fine; "deux cinq" or "un ou deux" is not) is a **critical** finding.

## 6. With TalkBack on

- [ ] TalkBack and the app's voice don't talk over each other in a way that hides the dose
- [ ] The answer caption can be read with TalkBack after the voice finishes
- [ ] Open Camera, and Stop, are reachable and announced

## 7. Resources

- [ ] Data used for 10 readings (Android Settings → data usage → Chrome, before and after): ______ MB
- [ ] Battery for 20 readings over about 15 minutes: ______ %
- [ ] Phone temperature after 15 minutes: normal / warm / hot
- [ ] Wi-Fi off and mobile data off: the user hears that analysis is down, and nothing is read from memory as if it were new

## 8. Privacy behaviour

- [ ] The consent notice is shown and spoken before the camera starts. Note whether it names Google: today it doesn't in speech (review finding P2).
- [ ] Withdrawing consent, then «اقرا الكل», says nothing has been read (the document was forgotten)
- [ ] Leaving the app and coming back: the camera was released (Android status-bar camera dot gone)
