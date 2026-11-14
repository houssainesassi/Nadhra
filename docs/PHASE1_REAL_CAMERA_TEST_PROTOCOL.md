# Phase 1 reader: real-camera test protocol (synthetic documents only)

**For:** the sighted test operator. **Status:** ready to run. Not run yet: it needs real phones and a person.

**Rules for every session:**
- **Only the printed synthetic kit.** No real prescription, no real medicine box, no identifiable paper.
- **No blind participants** in this stage.
- **No deployment:** the app runs on the operator's laptop.

## 1. What this stage measures

On real phone cameras, with printed mock documents:
1. **Safety:** does the reader ever say something not printed, or something hidden from the camera? The target is zero, whatever the conditions.
2. **Usefulness:** how much of what a person can read does it read, per device and per condition?
3. **Behaviour:**
   - Are the on-device refusals (too dark, too blurred) and the "move back / move your finger / tilt" tips right?
   - Is the check sentence actually heard after every name, dose and date?

## 2. Equipment

| Item | Notes |
|---|---|
| Android phone, low-end (Android 10–12, 2–3 GB RAM) | Chrome up to date |
| Android phone, mid-range | Chrome; has ImageCapture (full-resolution still photo) |
| iPhone (iOS 16+) | Safari. No ImageCapture: the video frame is used. Needs HTTPS (§3). |
| Laptop with the repo, a USB cable | Runs the app and keeps the captures |
| Printed kit: `python3 e2e/read/make_print_kit.py e2e/read/out/kit`, then `kit.pdf` printed at **100 %** on a colour printer | 25 synthetic documents, each labelled "fictional specimen" |
| Empty boxes (any brand, covered completely by the printed faces), a small round bottle, a dropper bottle | Supports for the printed labels |
| Glossy photo paper, or clear tape | Foil and gloss reflections (M13, glossy boxes) |
| Desk lamp, a window (daylight), a room that can be dimmed; optional free light-meter app | Lighting conditions |
| A ruler and a protractor (or a phone level app) | Distances and angles |

## 3. Running the app on the phones (no deployment)

On the laptop:
```bash
npm run build
READ_CAPTURE_DIR=e2e/read/out/session-$(date +%F) npx next start -p 3100
```
`READ_CAPTURE_DIR` saves every reading: both frames, both raw readings, what was said and why. That way the session is scored afterwards with no extra requests. It is for this test only: never set it with real documents, and it refuses to work on Vercel.

- **Android:** USB debugging on, then `adb reverse tcp:3100 tcp:3100`, then Chrome at `http://localhost:3100`. Through `adb reverse` this counts as a secure address, so the camera works.
- **iPhone:** the camera needs HTTPS. On the same Wi-Fi, run `npx next dev --experimental-https -p 3100` (a local self-signed certificate; accept it once on the iPhone) and open `https://<laptop-ip>:3100`.
  - With `next dev` the capture switch works the same way.
  - The development build is slower than production; note it.

In the app on each phone:
1. Accept the camera notice.
2. Leave automatic descriptions **off** (the default).
3. Say «اقرالي الدوا» ("read the medicine") and accept the document notice («موافق», "I agree").

## 4. The conditions

For each phone, each document below, under each condition: two readings by voice («اقرالي الدوا»). The operator writes one row per reading in `labels.csv` (§5).

| Group | Conditions | Documents |
|---|---|---|
| **Light** | daylight by a window; office ceiling light; dim lamp only (about 20 lux; the app should refuse "too dark") | M01, P01, M12 |
| **Glare and reflections** | desk lamp reflecting on the glossy box over the strength; on the blister foil (M13); on a laminated or taped prescription | M01, M13, P01 |
| **Distance** | 8, 15, 25, 40 cm | M01, M14 (smallest print), M15 (tiny bottle) |
| **Angle** | flat; 30°; 45° | P01, M01 |
| **Hidden on purpose** | finger over the end of the strength; frame edge cutting the expiry line; box half outside the picture | M01 (mark `hidden` in labels.csv) |
| **Shapes** | syrup label on a round bottle (M04); dropper bottle (M15); blister (M13) | M04, M13, M15 |
| **Languages** | Arabic side (M12); French and Arabic prescription (P08) | M12, P08 |
| **Hands** | held by hand, as a user would (not on a stand), for every row above unless noted | all |

About 25 documents × 2 phones (+ iPhone) × the relevant conditions ≈ 150–250 readings, two sessions of half a day.

For comparison, also take **camera-app photo pairs** of 5 documents under the same conditions: two photos about half a second apart, named `<id>_a.jpg` and `<id>_b.jpg` in the session folder. These test the reading code on full-resolution camera photos, independent of the app's own capture.

## 5. Labels and scoring

`labels.csv` in the session folder, one row per reading:

```
id,case,device,condition,hidden
2026-11-20T10-31-02-123Z,M01,pixel6a,lamp-glare,
2026-11-20T10-33-40-007Z,M01,pixel6a,finger-on-strength,strength
M01_iphone_dim,M01,iphone12,dim,
```

- **id:** the capture's file name without extension (the app writes `<id>.json`, `<id>_a.jpg`, `<id>_b.jpg`), or the photo pair's name.
- **case:** the kit document (`kit.json`).
- **hidden:** what was physically hidden or cut in that picture (`name`, `strength`, `expiry`, separated by `|`). Anything of it spoken counts as critical.

Then:

```bash
node --experimental-strip-types --conditions=react-server e2e/read/realcam.ts e2e/read/out/session-2026-11-20
```

This prints and writes `summary.md`: per device and condition, readings, readings with a critical error, facts read out of readable, and failed readings. `results.json` holds every line's verdict (`ok`, `disputed`, `faint:first`…) for diagnosis.

**Also note by ear** (the scorer can't hear): Is the check sentence heard after every dose? Were the tips right? Did the on-device "too dark / blurred" refusals happen before anything was sent?

## 6. Pass criteria for this stage

- **Zero readings with a critical error.**
- On-device refusals in the dim condition, every time.
- The check sentence heard after every spoken name, dose and date.
- Usefulness reported per device and condition, with the causes from the verdicts. No usefulness target is set for this stage: safety first, then a decision on what to improve.

## 7. Data handling

- Captures and photos contain only the printed kit. They stay on the laptop in a gitignored folder and are deleted after the analysis.
- Requests go to Gemini's free tier, which may keep them; that's acceptable for invented documents only.
