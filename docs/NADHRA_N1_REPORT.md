# Nadhra AI, step N1: choosing the AI provider

Status: **implemented and tested. Not committed, pushed or deployed.** Written 2026-11-14.
Scope: N1 only, as approved (`NADHRA_AI_PROPOSAL.md` §9). N2 and later are not started.

## 1. What changed for the user

- **Settings → "AI"** (first item in the existing Settings sheet, no new main-screen button):
  "Gemini AI (Google, online)" or "Nadhra AI (on this device, experimental)". A line under it says what
  the chosen AI does and doesn't do.
- **Where it appears.** It appears only when the server offers Nadhra AI: `NADHRA_AI_ENABLED=1` and
  `AI_MODE=hybrid` or `offline`. It also stays visible if Nadhra was already selected. The default
  deployment (`AI_MODE` unset = cloud) shows nothing new.
- **Default: Gemini AI.** Switching is explicit (the select only) and is saved with the other settings
  in `localStorage`. The app never switches by itself.
- **With Nadhra AI selected:**
  - every AI feature is refused out loud, in the question's language: questions, descriptions,
    "what's in front of me", reading, medicine questions, the live conversation and turning automatic
    descriptions on. The refusal says that Nadhra can't do this yet, that nothing was sent, and that
    the user can choose Gemini in Settings;
  - the camera and the on-device MediaPipe warnings (people, vehicles) still work. The camera notice
    says that stairs and holes aren't detected;
  - voice commands are off, because the browser's speech recognition sends the voice to Google, and
    the user is told so;
  - the Google consent notice isn't asked, because nothing is sent;
  - the main-screen status line reads "Nadhra AI (experimental): on-device warnings only".
- **Back to Gemini:** everything works as before. If the Google consent was never given and the
  camera is running, the camera stops and the existing notice is asked first.

## 2. Guarantees, and where they are enforced

| Guarantee | Enforced in | Tested in |
|---|---|---|
| A request without `provider: "nadhra"` is handled exactly as today | `requestedFamily()` in `router.ts`: only the exact string `"nadhra"` selects Nadhra; the field is never forwarded upstream | `nadhraServer`: same upstream calls for no field / `"gemini"` / any other value |
| `provider: "nadhra"` never reaches Gemini, OpenRouter or Google Live | `/api/vision`, `/api/vision/transcribe` and `/api/live/token` return `503 {"error":"nadhra-unavailable"}` before validation, budget or any network call | `nadhraServer`: every request kind, in all 3 `AI_MODE`s, with the flag on and off, gives zero outgoing calls |
| Nadhra declares no ability it doesn't have | `NADHRA_TASKS = {}`; status reports `nadhra: { experimental: true, tasks: [] }` | `nadhraServer` |
| Nothing leaves the page while Nadhra is selected | 1) Controller gates in `ask`, `readDocument`, `runTask`, `startLive`, scans, motion frames, voice input. 2) **Backstop:** `apiFetch` throws `LocalOnlyError` for every request; failure reports are dropped. 3) The voice is local only: no Edge cloud voice, and no browser voice with `localService === false` | `nadhraController` (all `fetch` calls recorded: none except the status GET); `nadhraTts` |
| The guard is closed on page load when Nadhra was chosen earlier | `attach()` applies the provider before anything can be sent | `nadhraController` |
| Default cloud status is byte-identical | the `nadhra` key is only added when offered | `nadhraServer`, plus the untouched exact-match test in `visionRoute.test.ts` |
| Medicine reading unchanged | `document.ts` and `lineCheck.ts` not edited (byte-identical to the 2026-11-14 backup). `readDocument` gained one gate line at its entry; the rest of the function is unchanged | existing `phase1Safety`, `safetyInvariants`, `document`, `lineCheck` tests pass unchanged |

## 3. Changed files

Server:
- `src/lib/ai/router.ts`: `ProviderFamily`, `requestedFamily`, `NADHRA_TASKS` (empty), `nadhraEnabled`, `nadhraOffered`, `nadhraTasks`.
- `src/lib/ai/vision.ts`: the status gets `nadhra` only when it is offered.
- `src/app/api/vision/route.ts`, `src/app/api/vision/transcribe/route.ts`, `src/app/api/live/token/route.ts`: the Nadhra refusal.
- `.env.example`: `NADHRA_AI_ENABLED`, documented, off by default.

Page:
- `src/lib/assistant/settings.ts`: `provider?: "nadhra"`. When absent, the provider is Gemini, so the default settings object is unchanged. Adds `providerOf()`.
- `src/lib/assistant/api.ts`: `setLocalOnly` / `LocalOnlyError` guard in `apiFetch` and `report`.
- `src/lib/assistant/client.ts`: the guard's error becomes `VisionApiError("nadhra-unavailable")`.
- `src/lib/speech/tts.ts`: `setLocalOnly()` on the engine; `pickVoice({ localOnly })` keeps installed voices only.
- `src/lib/assistant/controller.ts`: the gates, the `"local"` analysis state, the provider switch, and the refusal sentences.
- `src/lib/assistant/phrases.ts`, `src/lib/assistant/uiText.ts`: the Nadhra sentences (§5).
- `src/lib/assistant/types.ts`: `VisionStatus.nadhra`.
- `src/components/Assistant.tsx`: the "AI" select in Settings and the status line.

Tests (new): `tests/nadhraServer.test.ts` (11), `tests/nadhraTts.test.ts` (3), `tests/nadhraController.test.ts` (10).

## 4. Verification

- `npm test`: **376 / 376 pass** (the 352 existing tests, unchanged, plus 24 new).
- `tsc --noEmit`: clean.
- No Gemini quota used. Every test fakes the network.
- **Not done:**
  - no `next build`, so the existing `.next` build is left as it is;
  - no Chromium end-to-end run with the new select;
  - no manual test on a phone.
  These are the next checks to run if you want them.
- The 09:05 reading test was not restarted. The backup `~/nadhra-backups/2026-11-14_0017` was not touched
  (`sha256sum -c` OK).

**To try it locally:** run `AI_MODE=hybrid NADHRA_AI_ENABLED=1 npm run dev`, then open Settings → AI.

## 5. Wording: proposed Tunisian Derja (for your approval, NOT integrated)

Until you approve, the **Tunisian voice speaks the Standard Arabic sentences** (column 3); they are
marked in the code as awaiting approval. French and English are integrated. Nadhra AI is called «ذكاء نظرة»
so it isn't confused with the app's own name «نظرة».

| # | When | Proposed Derja | Integrated now (MSA, also used for Tunisian) |
|---|---|---|---|
| 1 | Nadhra AI selected | اخترت ذكاء نظرة. راهو تجريبي ومازال في التطوير: الذكاء متاعو مازال موش مربوط، يعني توّا ما ينجمش يوصف، ولا يقرا، ولا يجاوب على الأسئلة، ولا يفهم الأوامر بالصوت. حتى شي ما يخرج من الجهاز هذا. كي تكون الكاميرا خدّامة، كان التحذيرات اللي في الجهاز على العباد والكراهب اللي تخدم، والدروج والحفر ما نشوفهمش. باش تستعمل الحاجات هاذي، اختار Gemini من الإعدادات. | تم اختيار ذكاء نظرة. هو تجريبي وما زال قيد التطوير: ذكاؤه الاصطناعي غير موصول بعد… |
| 2 | Gemini AI selected | اخترت Gemini. الصور والأسئلة وصوتك يتبعثو لـ Google Gemini، كيما مكتوب في الخصوصية والسلامة. | تم اختيار Gemini. الصور والأسئلة والصوت تُرسَل إلى Google Gemini… |
| 3 | Nadhra is experimental (camera start, and while walking) | ذكاء نظرة تجريبي: كان التحذيرات اللي في الجهاز على العباد والكراهب اللي تخدم. الدروج والحفر ما نشوفهمش. حتى شي ما يخرج من الجهاز هذا. | ذكاء نظرة تجريبي: تعمل فقط تنبيهات الجهاز… |
| 4 | A feature isn't available locally yet | ذكاء نظرة مازال ما ينجمش يعمل هاذي: الذكاء متاعو موش مربوط في الجهاز هذا. ما تبعث حتى شي. | ذكاء نظرة لا يستطيع فعل هذا بعد… لم يُرسَل أي شيء. |
| 5 | The task needs Gemini (always follows #4) | باش تعمل هاذي، اختار Gemini من الإعدادات. | لهذا، اختر Gemini في الإعدادات. |
| 6 | Voice commands with Nadhra | مع ذكاء نظرة، الأوامر بالصوت مازالت ما تخدمش، خاطر التعرّف على الكلام في المتصفح يبعث صوتك لـ Google. استعمل الأزرار. | مع ذكاء نظرة، الأوامر الصوتية لا تعمل بعد… |
| 7 | Status line on the main screen | ذكاء نظرة (تجريبي): كان تحذيرات الجهاز | ذكاء نظرة (تجريبي): تنبيهات الجهاز فقط |

Questions for you:
- Is «ذكاء نظرة» the right name to say, or do you prefer «نظرة AI»?
- Should the voice say «جيميني» in Arabic letters, or keep "Gemini" (as the existing notices do)?
- Voice commands for switching («استعمل ذكاء نظرة» / «استعمل جيميني») were in the proposal's N1 but not in
  your N1 list, and they need approved wording. They are **not implemented**. Add them once the wording is approved?

## 6. Risks and limits

1. **No voice commands with Nadhra.** A blind user has only the buttons and the screen reader in this mode
   until a local recogniser exists (N5). The app says so when the mode is chosen and when the microphone is used.
2. **The device must have an installed voice.** Nadhra uses only voices whose `localService` is true, a flag the browser reports.
   With none for the language, the app's own voice stays silent and the screen reader announces the sentences
   (the existing fallback). Linux Chromium (speech-dispatcher) has local voices. Android's TTS engine reports
   its voices as local, but whether a given Android voice itself uses the network is outside the page's control.
3. **Non-AI requests still made.** These requests carry no user data and are not blocked: the status `GET /api/vision`, the cloud-voice availability
   `GET /api/tts`, and the MediaPipe files (served by the same server).
   The emergency sheet's location uses the browser's geolocation, which on some devices asks a network location
   service. That is the user's own emergency action, and it is unchanged.
4. **The Tunisian sentences are Standard Arabic** until §5 is approved.
5. **Not verified in a real browser yet** (§4).
6. **Nadhra has no separate stored consent.** The spoken confirmation on selecting it, and the camera
   notice, say what runs and that nothing is sent. Gemini's consent rules are unchanged.

## 7. N1 verification (2026-11-14, second round)

- **Naming applied** (UI only): "Gemini AI" / "Nadhra AI (experimental)". The spoken wording is unchanged and awaits approval (§5 is superseded by the revised draft given in the chat report).
- **`next build`:** OK (Next 16.4.5, 20 s, TypeScript included).
  - The previous `.next` was moved aside and **put back afterwards**.
  - The N1 build is kept at `~/.cache/nadhra-e2e/next-n1`.
  - The backup `~/nadhra-backups/2026-11-14_0017` was not touched (`sha256sum -c` OK).
- **Chromium end to end** (`node --experimental-strip-types e2e/nadhra/run.mjs <fixtures>`): **44/44, twice.**
  - It runs the production build, a fake camera, and **no mocked API route**.
  - There are three `next start` servers:
    - hybrid + `NADHRA_AI_ENABLED=1`;
    - `NADHRA_AI_ENABLED=1` alone;
    - nothing set.
  - Each server runs under `e2e/nadhra/netlog.mjs`, a test-only preload that records **and blocks** every outgoing connection or fetch of the server.
  - Fake keys override `.env.local`, so no quota is used and nothing leaves.
  - Hybrid's internet check is pointed at the local server.
- **Results:**
  - **Public configuration:** no `nadhra` in the status, no selector, and the status is identical with or without the flag.
  - **Default:** Gemini is the default, and no provider is stored.
  - **Gemini consent (existing behaviour):** Open camera asks first; declining sends no AI request.
  - **Nadhra:**
    - the camera starts without the Google notice, with analysis `local`;
    - the camera notice is spoken;
    - describe, read, identify and live are each refused out loud, and voice commands are refused with the reason;
    - **the page sent no POST and contacted no other origin**;
    - **the server made zero outgoing attempts**;
    - a direct `provider:"nadhra"` POST returns `503 nadhra-unavailable` with no outgoing attempt.
  - **Reload:** Nadhra persists.
  - **Back to Gemini without consent:**
    - the camera stops and the notice comes first; nothing is sent before "I agree";
    - then the existing `manual` state returns;
    - a question is posted **without a provider field**;
    - the server tries today's chain (3 Gemini models, then OpenRouter; all blocked by the harness);
    - the failure is said honestly.
- **Unit tests:** 376/376. **tsc:** clean.

## 8. Approved wording and the switch control (2026-11-14, third round)

- **Names, as decided:**
  - shown everywhere: "Gemini" and "Nadhra (experimental)" (no "Gemini AI" / "Nadhra AI" anywhere);
  - spoken in Arabic: «جيميني» and «ذكاء نظرة»;
  - spoken in French and English: "Gemini" and "Nadhra".
- **Wording integrated:**
  - the approved Derja, with both adjustments: «لخدمة جيميني متاع Google عبر الإنترنت» and «ما يتبعث حتى تصويرة ولا معلومة من جهازك لخدمات الذكاء الاصطناعي»;
  - Standard Arabic, French and English rewritten to say the same;
  - the Tunisian slot now uses `NADHRA_TN`.
- **Settings → AI:**
  - two large options side by side, the active one filled and marked "Active", one tap to switch;
  - built as native radio buttons, so screen readers announce them as a choice of two;
  - the explanation of the active provider sits under the options;
  - a short confirmation ("Now using Nadhra (experimental)." / "Now using Gemini.") appears in a status line, in addition to the spoken confirmation.
- **Where it appears.** Nadhra is offered only when the server offers it. If Nadhra was chosen earlier and the server no
  longer offers it, it shows as "Active · this server doesn't offer it", so the user can switch back to Gemini.
- **Verification:**
  - unit tests 376/376; tsc clean;
  - `next build` OK (the earlier `.next` was put back afterwards; the N1 build is kept at `~/.cache/nadhra-e2e/next-n1`);
  - Chromium **55/55, twice**, now including a second round trip with consent given and the camera running, the
    confirmation line, the "Active" mark, and a check that no "Gemini AI" or "Nadhra AI" text is on screen.
- **Next fixes:** the proposals for screen-reader repetition, the internet probe and in-flight requests are in
  `NADHRA_N1_SAFETY_PROPOSAL.md`. They are not implemented.

## 9. Safety fixes and the home-screen switch (2026-11-14, fourth round)

1. **Repeated announcements** (`announcer.ts`, `Assistant.tsx`, `controller.ts`):
   - two polite regions and two alert regions, used in turn, so every announcement is a fresh insertion into an empty region, even the same sentence twice;
   - a sentence whose voice fails is no longer announced a second time by the failure handler.
2. **No connectivity probe by default** (`deviceCapabilities.ts`, `ai/http.ts`, `vision.ts`):
   - reachability is passive, learned from the real Gemini/OpenRouter requests (a network failure means down for 60 s; any HTTP answer means up);
   - `INTERNET_PROBE_URL` is opt-in, and the status request never starts a probe.
3. **Cancelling on the switch to Nadhra:**
   - the page: every `apiFetch` carries an "epoch" abort signal, and the switch aborts it first of all (`api.ts`, `controller.ts`);
   - transcription stops its provider chain on disconnect (`transcribe/route.ts`, `vision.ts`);
   - the cloud voice doesn't retry or connect once the page has gone, and doesn't count that as an upstream failure (`edgeTts.ts`);
   - a late live token opens nothing (`session.ts`).
   - The approved warning («أوقفنا أي إرسال إضافي…») and its MSA, French and English versions are said only when something was actually in progress.
4. **The switch moved to the home screen** (at your request), and removed from Settings:
   - a two-part pill at the top of the main area, visible with the camera on or off;
   - cloud icon for Gemini, device icon for Nadhra, the active side filled;
   - native radios; the confirmation "✓ Gemini" / "✓ Nadhra (experimental)" plus the spoken one.
   - It is shown only where the server offers Nadhra, or where Nadhra is already active.
   - The names are never cut: on narrow screens "(experimental)" moves to a second line.

**Verification:**
- unit tests 398/398 (21 new in `announcer.test.ts`, `nadhraSafety.test.ts`, `nadhraController.test.ts`); tsc clean;
- `next build` OK (the earlier `.next` was put back afterwards);
- `e2e/nadhra/run.mjs` **67/67, twice**, with the hybrid server in its default configuration;
- the layout regression `e2e/redesign.mjs` 53/53.
