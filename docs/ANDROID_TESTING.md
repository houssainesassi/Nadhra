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
- keeps the camera or microphone on after Stop camera, or after leaving the app

## Before the session

1. Charge the phone to at least 80%.
2. Install and update Google Chrome.
3. In Android Settings, under Accessibility, set TalkBack up as you normally use it.
4. In Android Settings, under Apps, Chrome, Permissions, check the camera, microphone and location are "Ask every time" or "Allow while using the app".
5. Open the test address (see the README, "Supervised Android test build").
6. Open Settings in the app:
   - Language: the one being tested.
   - Emergency contact: the companion's name and phone number.
   - Camera direction: leave it on Automatic.

## Checklist

Record for each line: ✅ works, ⚠️ works but has a problem (write what), ❌ fails. Note what the app said, using "I heard" on the screen and the companion's notes.

### 1. First start and consent
- [ ] With TalkBack on, the first item read on the page is "Start assistance".
- [ ] The header says "Experimental test version".
- [ ] Double-tap Start assistance. The consent screen is read out, starting with "This is an experimental test version…" and naming Google Gemini.
- [ ] Choose "I don't agree". The camera stays off, and you hear that no image was sent.
- [ ] Start again and choose "I agree". Android asks for the camera; allow it. You hear "the camera is on", a tone, and a short vibration.
- [ ] After the first description you hear the experimental notice: it doesn't replace a cane, a guide dog or help from people.

### 2. Camera direction (left and right)
- [ ] Settings says the camera points "ahead of me" for the back camera.
- [ ] The companion holds an object to your left. The app says it is on your left.

### 3. Main actions
Do each with the camera on, then again with the camera off. With the camera off, it should start the camera first.
- [ ] **Read text:** hold a printed page about 30 cm away. The text is read word for word. If some is unreadable, it says so.
- [ ] **Identify object:** a food or medicine box. It names the product and reads the brand and label. If it can't read the label, it suggests turning the box.
- [ ] **Describe surroundings:** a short description of the room.
- [ ] **Repeat**, **Stop talking** and **Help** each work.

### 4. Voice only (don't touch the phone)
Turn on Voice commands (one double-tap), put the phone down, then only speak.
- [ ] «شنوة قدّامي؟», «وصفلي البلاصة», «اقرالي الكتابة», «شنوة هاذي؟»
- [ ] «عاود», «اسكت», «رجّع», «شنوة نجم نقول؟»
- [ ] «علّي الصوت», «هبّط الصوت», «احكي بالشوية»
- [ ] «وقّف التحليل» pauses, and you hear it. «كمّل» resumes.
- [ ] Note any beeps between commands, and every command that was misheard, using "I heard".
- [ ] **False triggers:** the companion talks normally nearby for 2 minutes, using words like "wait", «استني», "English" and "read". Analysis must **not** pause, the language must not change, and the camera must not start.

### 5. Languages
- [ ] Say "Speak French". The voice changes to French. « Qu'est-ce que c'est ? » and « Lis le texte » work.
- [ ] Say «تحدث بالعربية». Standard Arabic. «ماذا أمامي؟» works.
- [ ] Say "Speak English". "What is this?" and "Read this text" work.
- [ ] Say «احكي بالتونسي» to return to Tunisian.
- [ ] Note any language whose voice sounds wrong or robotic.

### 6. Warnings (the companion within arm's reach)
- [ ] Walk slowly toward a chair, a closed door, and a person standing still. Note whether each warning came, and how late.
- [ ] At stairs (companion holding your arm): note whether there was a warning, and how it was worded.
- [ ] On a quiet pavement, with a parked car: note the warning. Never test with moving traffic.
- [ ] An uncertain warning says it isn't sure: "…أما موش متأكّد", "…but I'm not sure".
- [ ] If the app says nothing is in front of you, it adds that this doesn't mean the way is safe.
- [ ] You feel a strong vibration on urgent warnings.

### 7. Emergency (the companion's number only)
- [ ] Say «نجدة». The Emergency page opens and is read out. Android asks for location; allow it.
- [ ] TalkBack focus is on "Call [name]" without swiping.
- [ ] Nothing has been dialled or sent yet.
- [ ] Say «عيّط». You hear that the call button is selected. Double-tap: the dialer opens with the companion's number, **and does not call until you press call**. Hang up.
- [ ] Double-tap "Text my location". Messages opens with the text and a maps link, **unsent**. Send it. The companion confirms the link shows the right place.
- [ ] SAMU 190: double-tap only to check the dialer opens with 190, then **cancel without calling**.
- [ ] Remove the contact in Settings and open Emergency again. You hear that there's no contact, and focus is on "Add an emergency contact".

### 8. Connection
- [ ] With the camera on, turn on airplane mode. You hear that there's no internet and only on-device warnings work. The status shows Offline.
- [ ] Turn airplane mode off. You hear that the connection is back. A voice command works again.

### 9. Camera, microphone and battery
- [ ] Stop camera: Android's green camera indicator turns off.
- [ ] Turn Voice commands off: the microphone indicator turns off.
- [ ] With the camera on, lock the phone, then switch to another app. The camera indicator turns off within about a second. Come back: you hear "the camera was off while you were away", then "camera on", without tapping anything.
- [ ] Same with hands-free voice commands on: the microphone indicator turns off while away, and listening resumes on return.
- [ ] Pull down the notification shade and open a permission prompt (Emergency page → location). Note whether the camera restarts. If it does, the page was hidden, and the brief restart should be recorded.
- [ ] Run for 15 minutes with the camera on. Note the battery percentage before and after, and whether the phone gets hot.

### 10. Reading and display
- [ ] In Android Settings, set font size to the largest, and in the app set Text size to 175%. Nothing is cut off, and nothing scrolls sideways.
- [ ] Turn on "Also send speech to my screen reader". Note whether hearing it twice is helpful or confusing.

## What to report

For each problem: the checklist line, the language, what was said or done, what the app said (from "I heard" and the last sentence on screen), and the time. Report safety problems first, from the "Stop testing" list.

## What leaves the phone

- **Camera images go to Google Gemini** (OpenRouter if Gemini fails), only while the camera is on and analysis isn't paused:
  - automatic descriptions: one 768 px picture at most every 4 s, plus a smaller 384 px picture from about a second earlier to judge motion. When nothing changes, this drops to one every 20 to 80 s.
  - each question, Read, Identify or Describe: one 1280 px picture, plus the smaller one.
  - nothing is sent while the picture is too dark or covered, or while offline, paused or in the background.
- **With each picture:** the question, the last few things the app said, the last 3 questions and answers, the camera direction and the chosen language. No name, no location, no contact.
- **Spoken questions** go to Google's speech service through Chrome. In browsers without it, a short recording goes to Gemini.
- **The app's voice** comes from the phone itself, or Microsoft's online voice when the phone has none for the language. Only the sentence text is sent.
- **The emergency contact and location** stay on the phone. The location only goes into a text message you send yourself.

On Gemini's free tier, Google may keep the pictures and use them to improve its services, and people may review them. Don't point the camera at bank cards, ID documents or people who haven't agreed to be filmed.
