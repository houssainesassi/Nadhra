# Beta test checklist: Android Chrome and iOS Safari

For the first supervised beta sessions. Each session has a blind or visually impaired tester and a sighted companion who stays within arm's reach. The full Android walkthrough is in `ANDROID_TESTING.md`. This sheet adds what changed since then, and iOS.

**Stop the session** if the app says a road or crossing is safe, describes something that isn't there as if it were sure, or stays silent on stairs or a vehicle close by. Write down what was asked and what was said.

## Before the session
- [ ] The app is open over **HTTPS** (the camera and microphone don't work over plain http on a phone).
- [ ] The device, OS version and browser version are written down: Android version + Chrome version, or iOS version (Settings › General › About).
- [ ] The tester has heard the consent notice: images and questions go to Google Gemini (and the voice to Microsoft). Nothing is recorded by NADHRA.
- [ ] The phone is charged, its volume is up, and on iPhone **the silent switch is off** (see iOS below).
- [ ] The companion has a stopwatch, or uses the latency shown in the app, to note answer times.

## Both platforms
### Camera and permissions
- [ ] First "Start assistance": the browser asks for the camera; allow it. You hear "the camera is on".
- [ ] It's the **back** camera. Hold an object to the tester's left: the app says left.
- [ ] Deny the camera once (reset it afterwards in the browser's site settings): the app says it has no permission. It doesn't crash or go silent.
- [ ] Lock the phone and unlock it: the camera comes back on, and you hear that it was off.
- [ ] Switch to another app and back: the same. While away, the camera light/indicator is off.
- [ ] Phone held upright (portrait), then sideways: descriptions still make sense, and left/right stay correct.
- [ ] A dark room: the app says it can't see well, and doesn't describe things it can't see.

### Questions (answers made by the model at the moment you ask)
- [ ] «شنوّة اللي قدّامي؟»: you hear «لحظة، نشوف» and then the answer starts. **Note the seconds** until the first word of the answer.
- [ ] Point at a different object and ask «شنوّة هذا؟»: the answer is about the new object, not the earlier one.
- [ ] Follow-up: ask about a box, then «وقتاش يوفى؟»: it answers about the same box.
- [ ] Two questions quickly, one after the other: only the second is answered.
- [ ] Ask a long reading (a full page): it starts speaking before the whole text has arrived, and the screen shows "Answer so far" while it comes.
- [ ] **Camera off**, ask a general question («علاش السماء زرقاء؟»): it answers. Ask «شنوّة قدّامي؟» with the camera off: it says the camera must be on. It does not guess.
- [ ] Ask in French with Derja selected («C'est quoi ça ?»): the answer and the voice are French. The next warning is back in Derja.
- [ ] Ask in Arabizi («chnowa hedha?»): the answer is in Derja.

### Live information (web search)
- [ ] Ask «شنوّة الطقس اليوم في تونس؟».
  - Without a billed search key, the app must say it **can't check live information**. It must never say «حسب البحث» or "according to a search", and the screen must not say "from a web search".
  - With a billed search key, the answer says it comes from a search on the internet, and the screen says "Answer (from a web search)".

### Network
- [ ] Turn on airplane mode **while** an answer is coming: you hear "no internet" or "the answer was cut off". No made-up ending.
- [ ] Turn the network back on: you hear that it's back, and questions work again.
- [ ] Weak signal (outside, 3G/4G): note answer times.

### Voice and microphone
- [ ] "Ask" (push to talk): the microphone opens with a tone, and the question is heard ("I heard: …" on screen).
- [ ] Hands-free mode on, then «اسكت»/«سكّر الكاميرا»: each works. Turn hands-free off: the microphone indicator goes off.
- [ ] While the assistant speaks, it doesn't hear itself and answer its own words.

## Android Chrome only
- [ ] The voice: Settings shows which voice is used. Note whether it is Tunisian, other Arabic, or the cloud voice.
- [ ] Add to home screen (menu › Add to Home screen): it opens as "Nadhra" and the camera still works.
- [ ] TalkBack on: "Start assistance" is the first item; the answer text is readable with TalkBack.

## iOS Safari only
- [ ] **Silent switch on (ringer off): is the voice still heard?** Web audio can be muted by the silent switch on iPhone. If there's no voice with the switch on, note it: testers must keep it off. This is not yet confirmed on a real iPhone.
- [ ] First question after opening the page: the voice plays (iOS only allows sound after a tap; the first tap on Start unlocks it).
- [ ] Voice input: if Safari's speech recognition fails or doesn't understand Derja, the app switches to recording, says so, and still understands the question. Note which one happened.
- [ ] iOS asks for the camera **and** the microphone separately. Allow both. Note whether it asks again on every visit.
- [ ] Older iPhones (iOS 16 or 17.0–17.3): questions still work. They depended on a browser feature added in iOS 17.4, and a fallback now covers it.
- [ ] VoiceOver on: Start assistance, Ask and the answer text are reachable and read correctly.
- [ ] Add to Home Screen (Share › Add to Home Screen): note whether the camera still works there.

## Write down for each session
- Device, OS, browser, network (Wi-Fi/4G/3G).
- For 5 questions: seconds to the first word of the answer, and whether the answer was right.
- Every wrong answer: what was asked, what was in front of the camera, what was said.
- Every time the voice sounded wrong, robotic or in the wrong language.
- Anything the app said that sounded like a safety promise.
