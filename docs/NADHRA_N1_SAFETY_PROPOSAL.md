# Before N2: three safety and privacy fixes (proposal, NOT implemented)

Status: **approved and implemented 2026-11-14** (see `NADHRA_N1_REPORT.md` §9). Written as a proposal first; kept for the reasoning. Implementation notes: the announcer takes its own turn counter (not the controller id), and a blocked or failed voice no longer creates a second announcement for the same sentence.

## 1. A repeated message must be announced again

**Problem.**
- When the device has no usable voice (often the case with Nadhra, which uses installed voices only),
  sentences reach the user through a hidden `aria-live` region (`Assistant.tsx`, the `announce` divs).
- React writes the text into the same element. When the new sentence is identical to the previous one
  (the same refusal twice), the DOM doesn't change, so **screen readers say nothing**.
- The Chromium test confirmed it: the second identical refusal produced no mutation.

**Fix (page only, no new dependency).** Use two alternating live regions, the pattern used by established announcer
libraries:
1. Each announcement carries an increasing id. The controller already has one: `announce.id`.
2. The page keeps two hidden regions, A and B. Announcement *n* empties the other region and writes the text into region
   `n % 2`, one animation frame later. The text is therefore always a **new insertion** in a live region,
   even when it is identical, and nothing is read twice.
3. Urgent messages keep their own `role="alert"` pair, built the same way.
4. The visible caption doesn't change.

**Tests.**
- Unit: a pure `announcerFrames(prev, next)` helper. For any sequence, including the same text three times,
  each announcement ends up as the only text in exactly one region, and that region alternates.
- Chromium (`e2e/nadhra/run.mjs`): press Describe twice with Nadhra selected and no voice. Expect **two** insertions of
  the refusal into live regions, with no Help in between (the workaround the test uses today goes away).
- Manual, on the devices you choose later: NVDA + Chrome, TalkBack + Chrome on Android, VoiceOver + Safari.
  The same refusal three times must be read three times.

## 2. No request to Google just to check the connection

**Problem.**
- In hybrid mode, `deviceCapabilities.ts` checks the internet with a GET to `https://generativelanguage.googleapis.com/`
  (keyless, no user data) every 30 s.
- The check is started by *any* routing call. That includes the page's status request
  `GET /api/vision`, so a page with Nadhra selected still causes a request to Google.

**Fix (server only).**
1. **No probe by default.** Reachability is learned **passively** from the cloud requests the user actually makes
   with Gemini:
   - a network failure (DNS, connection refused, timeout before any answer) marks the internet as down for 60 s;
   - any HTTP answer marks it as up.
   Nadhra requests never touch this state, and `GET /api/vision` never starts anything.
2. **`INTERNET_PROBE_URL` becomes opt-in.** It is used only when the operator sets it, for example to the
   local router or their own server. There is no Google default.
3. **The first Gemini request in hybrid mode is simply tried.** That is today's behaviour while the state is unknown.
   If it fails at the network level, it is refused as `no-internet`, as today.
4. The page's own `navigator.onLine` is unchanged; it makes no request.
5. **Outside the app:** on the future device image, the operating system's own connectivity checks
   (NetworkManager, Chromium) are switched off. This is part of the device bring-up in N7, noted here so it isn't forgotten.

**Tests.**
- Unit (`aiMode.test.ts`, extended):
  - hybrid with no `INTERNET_PROBE_URL`: status and routing make **no** fetch at all;
  - a Gemini network failure marks the internet as down, and an HTTP 4xx/5xx marks it as up;
  - a `provider:"nadhra"` request never reads or changes the state;
  - with `INTERNET_PROBE_URL` set, exactly that URL is probed.
- Chromium: remove the test's `INTERNET_PROBE_URL` override and run with the default hybrid configuration. The server's
  network log must have **zero** attempts during the whole Nadhra phase, status requests included.

## 3. Requests still in progress when switching to Nadhra

**What can be in flight at the moment of the switch, and what happens today:**

| Request | Carries | Today after the switch | Proposed |
|---|---|---|---|
| Question / reading / scan (`/api/vision`) | picture(s), question | The page aborts it. The server stops the provider chain when the request is aborted, so it doesn't go on to OpenRouter | Keep. Add a test proving the server makes no further provider attempt after the abort |
| Spoken question recording (`/api/vision/transcribe`) | your voice | **The server ignores the abort.** If Gemini fails, the recording can still be passed to the next provider after the switch | Pass the request's abort signal to the provider chain (`transcribeAudio`), and give the page's transcription an abort signal it cancels on the switch |
| Cloud voice (`/api/tts`) | sentence text, which can be **document text read aloud** | The page stops playing but **doesn't abort the request**. The server **retries** a refused handshake without checking whether the page is still there (that was the attempt seen in the test) | The page aborts every in-flight voice request on the switch. The server links the request's abort signal to its own, so there is no retry once the page has gone |
| Live conversation | voice, a picture a second | Closed at once (`stopLive`) | Keep. Add a test: a token request that finishes after the switch must not open the connection |
| Failure reports (`/api/report`) | fixed codes only | Queue dropped on the switch | Keep |

**Mechanism (page).**
- One `AbortController` per provider "epoch" in `api.ts`. Every `apiFetch` uses its signal, together with the request's own signal.
- Switching to Nadhra aborts it **before** anything else, so every request of the page that is still open stops at once,
  whatever it is.
- This is in addition to the existing guard, which refuses new requests.

**Mechanism (server).**
- Every AI route ties its upstream work to `req.signal`, as `/api/vision` already does:
  - no next provider after an abort;
  - no retry after an abort;
  - no new upstream connection after an abort.

**What can't be cancelled.** Once the bytes of a request have reached Google, OpenRouter or Microsoft, they are
**received**. Aborting stops the answer and anything further (other providers, retries), but it can't recall data already
delivered. Those companies' own terms decide what happens to it (for example, Google's free tier may keep it).

That happens only for a request **made under Gemini, before the switch**. After the switch, nothing new is sent (proven by the
Chromium test).

**Wording (needs your approval).** When the switch actually cancelled something, the confirmation could add one honest
sentence, for example in Derja: «طلب كان تبعث قبل ما تبدّل وقفناه، أما اللي وصل لجيميني قبل ما يتوقّف ما يرجعش.»
The fix works without it. Tell me if you want it.

**Tests.**
- Unit (page):
  - switching to Nadhra aborts an in-flight `apiFetch` (a fake server that never answers): rejected with `AbortError`,
    and no second call;
  - `CloudTts` in-flight fetches are aborted, and none follows.
- Unit (server):
  - **transcribe**: provider 1 hangs, the request is aborted, and provider 2 is **never** called;
  - **TTS**: a handshake failure followed by an abort means **no** second `synthesize`;
  - **vision**: the existing abort path, now covered explicitly (abort during provider 1, provider 2 never called);
  - **live**: a token that arrives after the switch opens no WebSocket.
- Chromium (`e2e/nadhra/run.mjs`): the network harness **delays** blocked upstream calls by 2 s instead of failing them at
  once. Then:
  - ask a question and switch to Nadhra during the delay;
  - expect: no OpenRouter attempt after the Gemini one, no voice-service retry, zero server attempts from the switch on;
  - repeat with a cloud-voice sentence in progress.

## Scope and risks of these fixes

- Changes to Gemini's behaviour are limited to stopping work the user has left (no retry or fallback after the page has
  aborted), and to the hybrid-mode internet check.
- The cloud-mode default (the public deployment) is unchanged:
  - it never probes;
  - its abort handling becomes stricter only on transcription and the voice.
- Files touched by the fixes: `Assistant.tsx` (announcer), `api.ts`, `tts.ts`, `controller.ts` (switch),
  `deviceCapabilities.ts`, `vision.ts` (transcribe signal), `transcribe/route.ts`, `edgeTts.ts`, plus tests.
  The medicine-reading pipeline is not touched.
