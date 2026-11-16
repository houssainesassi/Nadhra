# Supervised Android testing

A checklist for testing Nadhra on an Android phone. It's for the tester and the sighted person who
accompanies them. Nadhra is an **experimental test version**. In these sessions it is tested *alongside*
a white cane, guide dog or sighted guide, never instead of one.

## Rules for every session

- A sighted companion stays within arm's reach for every test that involves walking. They stop the test at once if anything is unsafe.
- Walk only in places you already know: indoors first, then a quiet pavement. No road crossings, platforms or stairs without the companion's hand on your arm.
- Keep using your usual mobility aid throughout. Act on what your cane or guide tells you, never on what the app says.
- Silence from the app means nothing. It doesn't mean the way is clear.
- For the Emergency tests, the contact must be the companion's own phone, and emergency services (190, 197, 198) are **never** called. The tests only check that the dialer opens.

**Stop testing and report it** if the app ever:
- says or implies a path, road or crossing is safe or clear, without adding that it can't confirm this
- gives a distance in metres or steps
- calls, texts or shares the location without a tap
- keeps the camera or microphone on after the session has ended (Stop assistance / End live conversation), or after leaving the app

## What the app looks like now

The app has two screens. Testers should not look for any other buttons: the old "Open camera", "Talk live", language selector, privacy link and the row of action buttons under the camera are gone.

**Home screen** (when no session is running), read in this order:
1. The name, Nadhra.
2. The greeting, as the page heading: «عسلامة» (Tunisian and Arabic), "Asslema" (French and English).
3. One line on what Nadhra does.
4. **Camera** («الكاميرا»): starts the camera assistant (camera, on-device warnings, and voice commands).
5. **Microphone** («الميكرو»): starts the live conversation with Google Gemini (it opens the camera too: Gemini sees about one picture a second).
6. **Settings** («الإعدادات»): language, the AI in use (only when the server offers a choice), Privacy & safety, voice commands, speech, text size, camera direction, colours, emergency contact.

**Session screen** (Camera or Microphone pressed): only the assistant.
- The camera picture (darkened in a live conversation, with a large round voice indicator: blue while listening, warm yellow while speaking).
- Two status labels at the top (for example "Assistance active" and "Mic on", or "Live conversation"), and what the assistant is saying at the bottom ("Heard «…»" above it when you spoke).
- **One visible button:** "Stop assistance" («وقّف المساعدة»), or "End live conversation" («وقّف المحادثة المباشرة») in a live conversation. It ends everything and returns to the home screen.
- **For TalkBack only:** Describe surroundings, Read text, Identify object, Ask a question and (sometimes) Pause descriptions are buttons that are **not drawn on screen** but are reached by swiping, between the caption and the end button. See section 4.

Settings, the language and Privacy & safety are **not reachable during a session**: end the session first. The Emergency page still opens by voice at any time («نجدة»).

## Before the session

1. Charge the phone to at least 80%.
2. Install and update Google Chrome.
3. In Android Settings, under Accessibility, set TalkBack up as you normally use it.
4. In Android Settings, under Apps, Chrome, Permissions, check the camera, microphone and location are "Ask every time" or "Allow while using the app".
5. Open the test address (see the README, "Supervised Android test build").
6. On the home screen, open **Settings**:
   - Language: the language being tested (Tunisian Arabic is the default).
   - Emergency contact: the companion's name and phone number.
   - Camera direction: leave it on Automatic.
   - Automatic descriptions: off by default. Write down whether it is on or off for the session: **stairs and drops are only detected when it is on.**
   Close Settings ("Close", or the back gesture).
7. For the greeting test (section 1), close the tab and open the address again in a **new tab**, so the app starts fresh.
8. For the keyboard test (section 5), have a Bluetooth or USB keyboard paired with the phone. If none is available, skip section 5 and note it.
9. Reading medicine boxes and documents has its own checklist: `PHASE1_ANDROID_READING_CHECKLIST.md`.

## Checklist

Record for each line: ✅ works, ⚠️ works but has a problem (write what), ❌ fails. Note what the app said, using "Heard «…»" on the screen and the companion's notes.

### 1. First launch and the greeting
The greeting is said **once per visit**, and only once: either the phone says «عسلامة», or (when the Microphone is the first thing pressed) Gemini says «عسلامة» at the start of the call. Never both. Chrome doesn't let a page speak before the first tap, so the phone's greeting comes with your first tap, not when the page opens.
- [ ] Open the app in a new tab, with TalkBack on. Nothing is spoken by the app yet. Note what TalkBack reads first, and where its focus is (the app puts focus on **Camera**).
- [ ] Swipe through the home screen. The order is: Nadhra, the greeting heading «عسلامة», the line about what Nadhra does, Camera (read with "Describes what's around you" / «توصفلك اللي حولك»), Microphone (read with "Talk with Nadhra live" and that voice and pictures go to Google Gemini), Settings. **Nothing else.** Note anything missing, extra, or read wrongly.
- [ ] Swiping alone doesn't make the app speak (TalkBack swipes don't reach the page).
- [ ] Double-tap **Settings** as the first action: you hear «عسلامة» once, and Settings opens. Close it. Double-tap Settings again: no second greeting.
- [ ] In a new tab, double-tap **Camera** as the first action: you hear «عسلامة», then the camera starts (or the consent notice, section 2). The greeting is said whole, not cut off.
- [ ] In a new tab, double-tap **Microphone** as the first action: the phone does **not** say «عسلامة». Continue in section 3: the greeting then comes from Gemini when the call starts.
- [ ] Without TalkBack: in a new tab, tap anywhere on the page (even an empty area). You hear «عسلامة». Tap again: nothing more.
- [ ] Change the language in Settings to French, then open a new tab: the heading says "Asslema" and the greeting is spoken in the French voice. Change it back.

### 2. Camera-first session and consent
- [ ] Double-tap Camera (first time on this phone). The dialog "Before the camera starts" opens with focus on "I agree", and the privacy notice is spoken, naming Google Gemini. (On a first launch you hear «عسلامة» first.)
- [ ] Choose "I don't agree". The camera stays off, you stay on the home screen, and you hear that no image was sent.
- [ ] Double-tap Camera again and choose "I agree" (or say «موافق»). Android asks for the camera and the microphone; allow them. You hear "the camera is on", a tone and a short vibration, then that automatic descriptions are off. Focus moves to "Stop assistance".
- [ ] The screen shows only the camera, the two status labels, the caption and "Stop assistance". The home buttons (Camera, Microphone, Settings) are gone. The companion confirms no other button is drawn.
- [ ] The microphone label on the camera says "Mic on": voice commands started with the camera.
- [ ] Within about 20 seconds you hear the experimental notice: it doesn't replace a cane, a guide dog or help from people, and it can't guarantee seeing stairs, holes or obstacles.

### 3. Microphone-first session (live conversation)
- [ ] From the home screen, double-tap **Microphone**. If the camera consent hasn't been given on this phone, the "Before the camera starts" dialog comes first; agree. The first press only speaks a notice: voice and about one picture a second go to Google. Nothing is sent yet. You stay on the home screen, and the button now says "I agree: start the live conversation" («موافق: ابدا المحادثة المباشرة»).
- [ ] Double-tap it again. Android asks for the camera and microphone if needed. The session screen opens: camera picture darkened, the round voice indicator, "Live conversation", and one button, "End live conversation". Focus is on it.
- [ ] You hear that voice and pictures are going to Google now. Then, **only if this is the first greeting of the visit** (Microphone pressed first, section 1), Gemini says «عسلامة» and nothing else. Write down Gemini's exact words.
- [ ] Ask about what the camera shows, then interrupt the answer: it stops and listens. The voice indicator turns yellow while Nadhra speaks and blue while it listens.
- [ ] Note the seconds from the end of your question to the first word of the answer (stopwatch: the in-app measurements can only be read after the call, in Settings).
- [ ] Say «وقّف المحادثة». The conversation ends, you hear that it has ended and no voice or picture is being sent, and the home screen comes back (the camera the call opened closes too).
- [ ] Start a second live conversation in the same visit: **no** greeting from Gemini this time.
- [ ] After a Camera session (section 2) in the same visit, start a live conversation: **no** «عسلامة» (the phone already greeted).
- [ ] After the call, open Settings: under "Live conversation (Microphone)", "Measurements of the last live conversation" shows the connection and answer times. Compare with the stopwatch.

### 4. TalkBack: navigation and the hidden actions
During a session the actions are not drawn on screen, so a sighted companion sees only "Stop assistance". TalkBack still reaches them.
- [ ] Start a Camera session (automatic descriptions **on** in Settings beforehand, so Pause is present). From the caption at the bottom of the camera, swipe right. The order is: Describe surroundings, Read text, Identify object, Ask a question, Pause descriptions, Stop assistance. They form a group named "Actions" («الأوامر»); note whether TalkBack says the group's name. Note any name read wrongly or not at all.
- [ ] Swipe left from "Stop assistance": the same items in reverse, up to the caption and the status labels.
- [ ] While TalkBack's focus is on an action, the companion notes whether anything appears on screen (it may stay invisible; either is acceptable, but note it).
- [ ] Each action works with one double-tap, with the phone upright and sideways:
  - [ ] **Read text:** hold a printed page about 30 cm away. The first time, you hear the notice about documents; say «موافق». The text is read word for word. If some is unreadable, it says so.
  - [ ] **Identify object:** a food box. It names the product and reads the brand and label. If it can't read the label, it suggests turning the box. (Medicine boxes: use the reading checklist.)
  - [ ] **Describe surroundings:** a short description of the room.
  - [ ] **Ask a question,** with voice commands on (the default): double-tap. You hear the listening tone, and "I'm listening" if the assistant was talking. Ask a question: it is answered. The microphone stays on afterwards.
  - [ ] **Ask a question,** with voice commands off (say «سكّر الميكرو» first; the session stays open while the camera is on): double-tap. You hear the tone, and the button becomes "Done, send question" («وفيت، ابعث السؤال»). Ask, then double-tap it: the question is answered.
  - [ ] **Pause descriptions:** TalkBack reads it with "Warnings keep running". Double-tap: you hear that descriptions are paused and on-device warnings stay on, and the button becomes "Resume descriptions". Double-tap again: descriptions resume.
- [ ] Pause descriptions is **not** in the list when automatic descriptions are off (it has nothing to pause), nor in a live conversation.
- [ ] Do Describe, Read and Identify with the camera off: say «سكّر الكاميرا» (the session stays, showing "The camera is off.", while voice commands are on; the actions stay in the TalkBack list). The action should start the camera first.
- [ ] **Repeat**, **Stop talking** and **Help** have no button: say «عاود», «اسكت» and «شنوة نجم نقول؟». Each works.
- [ ] The answer text (caption) is readable with TalkBack, and a new answer is read when it arrives (only if "Also send speech to my screen reader" is on, or the voice has failed).

### 5. Keyboard (Bluetooth or USB keyboard on the phone)
The keys work by their position, so they also work with an Arabic or French layout. They don't work while a panel (Settings, Privacy, Emergency, consent) is open or while typing in a field.
- [ ] Home screen: Tab goes Camera → Microphone → Settings, each with a visible yellow outline. Enter or Space presses the focused one.
- [ ] **C** starts a Camera session; **C** again ends it and returns to the home screen with focus on Camera.
- [ ] In a session: **D** describes, **T** reads text, **I** identifies, **Q** asks, **P** pauses and resumes (automatic descriptions on), **R** repeats, **H** gives help, **Esc** stops the current speech, **V** turns voice commands on and off.
- [ ] In a session, Shift+Tab from "Stop assistance": the action buttons are reached, and the focused one **appears** as a large button above "Stop assistance". Enter presses it. When focus leaves, it disappears again.
- [ ] **L** starts a live conversation from the home screen, and also on top of a running Camera session (the only way to do that without ending the camera session). **L** again ends the conversation; a camera that was already on keeps running.
- [ ] As the first key pressed in a new tab, **L** gives no phone greeting (like Microphone); any other letter key gives «عسلامة». Esc and Shift alone don't count.

### 6. Ending a session
- [ ] Camera session: double-tap "Stop assistance". The home screen comes back with Camera, Microphone and Settings, focus is on Camera, you hear «الكاميرا مسكّرة.» ("The camera is off."), and Android's green camera and microphone indicators turn off.
- [ ] Live conversation: double-tap "End live conversation". The same: home screen, «الكاميرا مسكّرة.», indicators off, and nothing more is sent.
- [ ] Camera session ended by voice: «سكّر الكاميرا» (the camera stops; the session stays, showing "The camera is off.", while the microphone listens), then «سكّر الميكرو»: you hear "Microphone off." and the home screen comes back.
- [ ] A live conversation started with **L** on top of a Camera session: "End live conversation" ends **both** the conversation and the camera. («وقّف المحادثة» or **L** end only the conversation.)
- [ ] After ending, wait 10 seconds: nothing is spoken about the camera, and the indicators stay off.

### 7. Camera direction (left and right)
- [ ] Settings (on the home screen) says the camera points "ahead of me" for the back camera ("Automatic (now: …)" shows what was detected during the last session).
- [ ] The companion holds an object to your left. The app says it is on your left.

### 8. Voice only (don't touch the phone)
Voice commands turn on by themselves with Camera (the microphone label on the camera says "Mic on"). Put the phone down, then only speak.
- [ ] «شنوة قدّامي؟», «وصفلي البلاصة», «اقرالي الكتابة», «شنوة هاذي؟»
- [ ] «عاود», «اسكت», «رجّع», «شنوة نجم نقول؟»
- [ ] «علّي الصوت», «هبّط الصوت», «احكي بالشوية»
- [ ] With automatic descriptions on: «وقّف التحليل» pauses, and you hear it. «كمّل» resumes.
- [ ] Note any beeps between commands, and every command that was misheard, using "Heard «…»".
- [ ] **False triggers:** the companion talks normally nearby for 2 minutes, using words like "wait", «استني», "English" and "read". Analysis must **not** pause, the language must not change, and the camera must not start.

### 9. Languages
- [ ] During a session, say "Speak French". The voice changes to French. « Qu'est-ce que c'est ? » and « Lis le texte » work.
- [ ] Say «تحدث بالعربية». Standard Arabic. «ماذا أمامي؟» works.
- [ ] Say "Speak English". "What is this?" and "Read this text" work.
- [ ] Say «احكي بالتونسي» to return to Tunisian.
- [ ] The words on the screen change language too, without reloading: the status labels, "Stop assistance", the TalkBack-only actions, and after the session the greeting heading and Camera, Microphone, Settings. (Settings and the other panels stay in English.) TalkBack reads them in the new language's voice.
- [ ] The language can also be changed on the home screen, in Settings → Language.
- [ ] Note any language whose voice sounds wrong or robotic.

### 10. Warnings (the companion within arm's reach)
- [ ] Walk slowly toward a chair, a closed door, and a person standing still. Note whether each warning came, and how late.
- [ ] At stairs (companion holding your arm), with automatic descriptions **on**: note whether there was a warning, and how it was worded. With them off, no stairs warning is expected; the app says so when the camera starts.
- [ ] On a quiet pavement, with a parked car: note the warning. Never test with moving traffic.
- [ ] An uncertain warning says it isn't sure: "…أما موش متأكّد", "…but I'm not sure".
- [ ] If the app says nothing is in front of you, it adds that this doesn't mean the way is safe.
- [ ] You feel a strong vibration on urgent warnings, and the caption turns red with a red edge round the camera.

### 11. Emergency (the companion's number only)
- [ ] During a session, say «نجدة». The Emergency page opens and is read out. Android asks for location; allow it.
- [ ] TalkBack focus is on "Call [name]" without swiping.
- [ ] Nothing has been dialled or sent yet.
- [ ] Say «عيّط». You hear that the call button is selected. Double-tap: the dialer opens with the companion's number, **and does not call until you press call**. Hang up.
- [ ] Double-tap "Text my location". Messages opens with the text and a maps link, **unsent**. Send it. The companion confirms the link shows the right place.
- [ ] SAMU 190: double-tap only to check the dialer opens with 190, then **cancel without calling**.
- [ ] In Android Settings, refuse location for Chrome (or for the site), then open Emergency again. After the opening sentence you hear that your location couldn't be found and the message will ask them to call you. Nothing is sent. Allow location again afterwards.
- [ ] On the home screen, Settings → "Open the Emergency page" opens it too.
- [ ] Remove the contact in Settings and open Emergency again. You hear that there's no contact, and focus is on "Add an emergency contact".

### 12. Connection
- [ ] With the camera on, turn on airplane mode. You hear that there's no internet and only on-device warnings work. A notice on the camera says "Offline: on-device warnings only".
- [ ] Turn airplane mode off. You hear that the connection is back. A voice command works again.

### 13. Camera, microphone and battery
- [ ] Stop assistance: Android's green camera indicator turns off.
- [ ] During a session, say «سكّر الميكرو» (or press **V**): you hear "Microphone off.", the microphone indicator turns off, and the camera keeps running. (Settings can't be opened during a session.)
- [ ] With the camera on, lock the phone, then switch to another app. The camera indicator turns off within about a second. Come back: you hear "the camera was off while you were away", then "camera on", without tapping anything.
- [ ] Same with hands-free voice commands on: the microphone indicator turns off while away, and listening resumes on return.
- [ ] Pull down the notification shade and open a permission prompt (Emergency page → location). Note whether the camera restarts. If it does, the page was hidden, and the brief restart should be recorded.
- [ ] Run for 15 minutes with the camera on. Note the battery percentage before and after, and whether the phone gets hot.

### 14. Reading and display
- [ ] In Android Settings, set font size to the largest, and in the app set Text size to 175%. Nothing is cut off, and nothing scrolls sideways. On the home screen, Camera and Microphone are one under the other, each with its whole label. In a session, "Stop assistance" shows its whole label. (The home screen may scroll up and down at this size; that is expected.)
- [ ] Phone sideways: on the home screen Camera and Microphone are side by side; in a session the end button is beside the camera.
- [ ] Light colours (Settings → Colors → Light): everything stays readable.
- [ ] Turn on "Also send speech to my screen reader". Note whether hearing it twice is helpful or confusing.

## What to report

For each problem: the checklist line, the language, what was said or done, what the app said ("Heard «…»" and the last sentence on screen), and the time. Report safety problems first, from the "Stop testing" list.

## What leaves the phone

- **Camera images go to Google Gemini** (OpenRouter if Gemini fails), only while the camera is on:
  - each question, Identify or Describe: one 1280 px picture, plus a smaller one from about a second earlier to judge motion.
  - each Read: two pictures, 0.4 s apart.
  - automatic descriptions, **off by default**: when on, one 768 px picture at most every 4 s, plus the smaller one. When nothing changes, this drops to one every 20 to 80 s.
  - live conversation (Microphone): the microphone and about one picture a second, for as long as it runs. When it is the visit's first greeting, the app also sends a short instruction asking Gemini to greet.
  - nothing is sent while the picture is too dark or covered, or while offline, paused or in the background.
- **With each picture:** the question, the last few things the app said, the last 3 questions and answers, the camera direction and the chosen language. No name, no location, no contact.
- **Spoken questions** go to Google's speech service through Chrome. In browsers without it, a short recording goes to Gemini.
- **The app's voice** (including «عسلامة») comes from the phone itself, or Microsoft's online voice when the phone has none for the language. Only the sentence text is sent.
- **The emergency contact and location** stay on the phone. The location only goes into a text message you send yourself.

On Gemini's free tier, Google may keep the pictures and use them to improve its services, and people may review them. Don't point the camera at bank cards, ID documents or people who haven't agreed to be filmed.
