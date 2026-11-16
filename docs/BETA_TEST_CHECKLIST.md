# Beta test checklist: Android Chrome and iOS Safari

For the first supervised beta sessions. Each session has a blind or visually impaired tester and a sighted companion who stays within arm's reach. The full Android walkthrough is in `ANDROID_TESTING.md`. This sheet adds what changed since then, and iOS.

**The current screen.** Home: the greeting «عسلامة» and exactly three buttons, **Camera**, **Microphone** (the live conversation) and **Settings** (language, Privacy & safety and the other options are in there). During a session: the camera picture, its status, what the assistant says, and **one** button, "Stop assistance" (or "End live conversation"). Describe surroundings, Read text, Identify object, Ask a question and Pause descriptions are **not drawn**: they are reached with TalkBack or VoiceOver (swipe from the caption), by voice, or by keyboard. Don't expect "Open camera", "Talk live", a language selector at the top, or a row of buttons under the camera: they no longer exist. Settings can't be opened during a session.

**Stop the session** if the app says a road or crossing is safe, describes something that isn't there as if it were sure, or stays silent on stairs or a vehicle close by. Write down what was asked and what was said.

## Before the session
- [ ] The app is open over **HTTPS** (the camera and microphone don't work over plain http on a phone).
- [ ] The device, OS version and browser version are written down: Android version + Chrome version, or iOS version (Settings › General › About).
- [ ] The tester has heard the consent notice: images and questions go to Google Gemini (and the voice to Microsoft). Nothing is recorded by NADHRA.
- [ ] The phone is charged, its volume is up, and on iPhone **the silent switch is off** (see iOS below).
- [ ] The companion has a stopwatch to note answer times. (For the live conversation, the app's own measurements can be read in Settings after the call: "Measurements of the last live conversation".)

## Both platforms
### Greeting
- [ ] Open the app in a new tab. Nothing is said until the first tap (the browser blocks sound before it). The first tap anywhere, or on Camera or Settings, gives «عسلامة», once.
- [ ] In a new tab, press **Microphone** first: the phone says no «عسلامة»; when the live conversation starts, Gemini says «عسلامة» instead. Only one greeting per visit: a later live conversation, or one after a Camera session, doesn't greet again.

### Camera and permissions
- [ ] First "Camera": after the consent notice, the browser asks for the camera and the microphone; allow them. You hear "the camera is on". Only "Stop assistance" is visible on the session screen.
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
- [ ] Ask a long question that needs a long answer: it starts speaking before the whole answer has arrived, and the text appears on screen as it comes.
- [ ] **Camera off** (say «سكّر الكاميرا» during a session: the session stays while the microphone listens), ask a general question («علاش السماء زرقاء؟»): it answers. Ask «شنوّة قدّامي؟» with the camera off: it says the camera must be on. It does not guess.
- [ ] Ask in French with Derja selected (the default) («C'est quoi ça ?»): the answer and the voice are French. The next warning is back in Derja.
- [ ] Ask in Arabizi («chnowa hedha?»): the answer is in Derja.

### Live information (web search)
- [ ] Ask «شنوّة الطقس اليوم في تونس؟».
  - Without a billed search key, the app must say it **can't check live information**. It must never say «حسب البحث» or "according to a search".
  - With a billed search key, the answer says it comes from a search on the internet.

### Network
- [ ] Turn on airplane mode **while** an answer is coming: you hear "no internet" or "the answer was cut off". No made-up ending.
- [ ] Turn the network back on: you hear that it's back, and questions work again.
- [ ] Weak signal (outside, 3G/4G): note answer times.

### Voice and microphone
- [ ] "Ask a question" (screen reader, or the **Q** key), with voice commands off (say «سكّر الميكرو» during the session): the microphone opens with a tone, the button becomes "Done, send question", and the question is heard ("Heard «…»" on screen).
- [ ] "Ask a question" with voice commands on (the default after Camera): a tone, and the question you then speak is answered. What you were already saying is not cut off.
- [ ] The screen-reader actions (Describe surroundings, Read text, Identify object, Ask a question, and Pause descriptions when automatic descriptions are on) each work with one double-tap, in the chosen language. A sighted companion sees none of them on screen.
- [ ] "Microphone" (home screen): the first tap only reads the notice and the button becomes "I agree: start the live conversation"; the second tap starts it. Note the seconds to the first word of an answer. "End live conversation" ends it and returns to the home screen.
- [ ] Hands-free mode on (the default with Camera), then «اسكت»/«سكّر الكاميرا»: each works. «سكّر الميكرو»: the microphone indicator goes off.
- [ ] While the assistant speaks, it doesn't hear itself and answer its own words.

## Android Chrome only
- [ ] The voice: note whether it sounds Tunisian, other Arabic, or like the cloud voice. (The app only shows the voice's name during a live conversation.)
- [ ] Add to home screen (menu › Add to Home screen): it opens as "Nadhra" and the camera still works.
- [ ] TalkBack on: focus starts on "Camera"; swiping reads the greeting heading, then Camera, Microphone and Settings, nothing else. After the camera starts, focus is on "Stop assistance"; swiping right from the caption reaches the five actions (four when automatic descriptions are off), then Stop assistance. Each works with a double-tap. The answer text is readable with TalkBack. Full steps: `ANDROID_TESTING.md`, sections 1 to 6.

## iOS Safari only
- [ ] **Silent switch on (ringer off): is the voice still heard?** Web audio can be muted by the silent switch on iPhone. If there's no voice with the switch on, note it: testers must keep it off. This is not yet confirmed on a real iPhone.
- [ ] First tap after opening the page (on Camera or Settings): «عسلامة» is heard, and later answers play (iOS only allows sound after a tap; the first tap unlocks it).
- [ ] Voice input: if Safari's speech recognition fails or doesn't understand Derja, the app switches to recording, says so, and still understands the question. Note which one happened.
- [ ] iOS asks for the camera **and** the microphone separately. Allow both. Note whether it asks again on every visit.
- [ ] Older iPhones (iOS 16 or 17.0–17.3): questions still work. They depended on a browser feature added in iOS 17.4, and a fallback now covers it.
- [ ] VoiceOver on: the greeting heading, Camera, Microphone and Settings at home; in a session, the answer text, the screen-reader actions (including Ask a question; swipe from the caption) and Stop assistance are reachable, read correctly, and work with a double-tap.
- [ ] Add to Home Screen (Share › Add to Home Screen): note whether the camera still works there.

## Write down for each session
- Device, OS, browser, network (Wi-Fi/4G/3G).
- For 5 questions: seconds to the first word of the answer, and whether the answer was right.
- Every wrong answer: what was asked, what was in front of the camera, what was said.
- Every time the voice sounded wrong, robotic or in the wrong language.
- Anything the app said that sounded like a safety promise.
