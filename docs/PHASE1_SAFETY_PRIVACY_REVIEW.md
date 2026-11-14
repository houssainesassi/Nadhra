# Phase 1 reader: medical safety and privacy review

**Date:** 2026-11-13. **Scope:** the Phase 1 document and medicine reader as it is in the working tree (not committed). **Method:** each rule read in the code, then probed with small scripts against the real functions. Findings marked *confirmed* were reproduced. **No code was changed for this review.** Every fix below waits for your approval.

**Principle (yours):** the AI's confidence is never proof that a dose or a medical instruction is right.

---

## 1. Where the current design stands against that principle

The code guarantees one thing: **what is spoken matches what the model transcribed.** It cannot guarantee that the transcription matches the paper. Every "confirmed" in the system is the model grading its own work.

So today:
- `الجرعة المكتوبة: 500 mg` ("strength as written") is spoken as fact, but it rests on the model's word alone.
- `التاريخ هذا مازال ما جاش` ("this date hasn't come yet") is a reassurance computed from a date the model read. A misread date becomes a false "it's still good".
- The pharmacist reminder comes once, at the end of the reading, after the user has already heard the dose stated as written.

**The wording itself breaks your principle.** It needs to change before blind users test the reader, whatever else is decided (proposal S1 below).

## 2. Rule-by-rule review

| # | Rule | What it does guarantee | What it does not | Status |
|---|---|---|---|---|
| R1 | Name, substance, strength, form, quantity and expiry are said only when their text is in a clearly read line | The field and the transcription agree | That the transcription is right. **Bug: the match is a substring match.** | ❌ **F1** |
| R2 | Medical papers are read from "confirmed" lines only | Model-uncertain lines aren't read | "Confirmed" is the model's self-report | ⚠️ by design |
| R3 | A line containing `[?]`, `??`, `…` or `...` is uncertain | Marked gaps aren't read | **A single `?` inside a word or number (`5?0 mg`) is read out** | ❌ **F2** |
| R4 | On a medical paper reported as glare/blur/dark/angle/far/handwriting, lines with digits are held back | Doses wait for a clearer picture *when the model reports the problem* | **`½`, `¼` and `¾` are not digits, so `½ comprimé` is read under glare.** It also depends on the model admitting the problem. | ❌ **F3** |
| R5 | Explanation sentences with a number not printed on the paper are removed | Invented digits aren't spoken | **`½` isn't counted as a number.** Spelled numbers are checked only in dose sentences. | ❌ F3 |
| R6 | On medical papers, advice is removed unless it is attributed to the paper; spelled-out doses are removed | Plain advice («خوذ زوز») is removed | **Attribution is a free pass:** «Selon l'ordonnance, vous pouvez doubler la dose» and «الوصفة تقول تنجم تزيد حبة» are kept | ❌ **F4** |
| R7 | Medical claims in the explanation | — | **Invented indications and contraindications pass:** «هذا الدوا يصلح للصغار والمرا الحامل» is kept. The prompt *allows* "what the substance is commonly used for". | ❌ **F5** |
| R8 | "Can I take / stop / change…?" gets "only your doctor or pharmacist can tell you" | Inside reading mode | **«قداش من حبة ناخذ في النهار؟», «combien de comprimés par jour ?» and "how many pills a day?" don't reach reading mode.** The general question prompt tells the model to read dosage and doesn't forbid advice. The live conversation prompt has no medical rule at all. | ❌ **F6** |
| R9 | Quotes in answers must be in the text | Same as R1 | Same substring bug | ❌ F1 |
| R10 | Expiry status computed in code from numeric dates only, never from two dates | No guessing between FAB and EXP | The status is stated as fact on an AI-read date | ⚠️ S1 |
| R11 | Too dark or too blurred is refused on the phone, before sending | Gross blur and darkness | Calibrated only on rendered images | ⚠️ needs device data |
| R12 | Readings are never streamed: checked whole, then spoken | No unchecked sentence is heard | — | ✅ |
| R13 | Handwritten papers: lines with numbers held back | Handwritten doses aren't read | Relies on the model reporting "handwriting" | ⚠️ |
| R14 | A stairs warning interrupts a reading | Verified in Chromium | — | ✅ |

### Confirmed bugs (reproduced)

- **F1. Partial-number matching (critical).** `grounded("500 mg")` is true on a box that says **1500 mg**. Likewise `"2,5 mg"` on **12,5 mg** and `"5 mg"` on **12,5 mg**. If the model writes the field shorter than the line, the app says "strength as written: 500 mg" for a 1500 mg box. *Fix:* a number may only match a whole number: no digit, decimal mark or digit group touching it on either side.
- **F2. A single `?` (critical, rare).** `FEBRALIX 5?0 mg` marked confirmed is spoken as "strength as written: 5?0 mg". *Fix:* any `?` touching a letter or digit makes the line uncertain.
- **F3. Unicode fractions (high).** `½ ¼ ¾ ⅓ ⅔` are invisible to the number rules. *Fix:* treat them as numbers everywhere (hold-back, explanation check, matching), and test how each voice says them.
- **F4. Attribution as a loophole (critical).** The model can put any instruction behind "the prescription says". *Fix:* on medical papers, the explanation may not mention how to take a medicine at all. How to take it comes only from the verbatim line, plus the fixed glossary rendering in §4, which no model writes.
- **F5. Invented medical claims (high).** Uses, age groups, pregnancy, interactions. *Fix:* drop the "commonly used for" permission for medical papers. Remove explanation sentences that use indication or contraindication words (يصلح، يداوي، علاج، للحامل، للصغار، مضاد، indiqué, contre-indiqué, traitement, used for, treats, safe for, pregnant, children…).
- **F6. Medicine questions outside reading mode (critical).**
  - Route questions with medicine or dose words (حبة، كعبة، دوا، comprimé, cachet, pills, dose, mg…) to the reading rules.
  - Give the question and chat prompts the same "never advise on medicines or doses" rule.
  - For the live conversation, add the rule to its prompt. Live answers can't be filtered before they're heard, so also cut a live answer that states a dose, as is already done for safety promises, and say the refusal instead.

### Design proposals (beyond bug fixes)

- **S1. Wording that never presents an AI reading as fact** (strongly recommended; small).
  - «الجرعة المكتوبة: 500 mg» → «قريت الجرعة: 500 mg. ثبّت فيها مع الصيدلي قبل ما تاخذ الدوا.» ("I read the dose as 500 mg. Check it with the pharmacist before taking it.") The check sentence comes right after each dose and each instruction, not once at the end.
  - Expiry: «قريت التاريخ: EXP 03/2027. كان القراية صحيحة، التاريخ مازال ما فاتش.» ("I read the date as EXP 03/2027. If that reading is right, the date hasn't passed yet.")
  - The same change in the four languages.
- **S2. Two independent readings for doses and dates** (recommended after measuring; doubles the requests for medicine reads only).
  - Two frames a moment apart, two separate requests. A dose or date is spoken only when both readings agree character for character; otherwise «ما نجمتش نتأكّد من الجرعة» ("I couldn't confirm the dose").
  - This catches random misreads. It does **not** catch a systematic bias, where the model "knows" paracetamol is 500 mg and writes it both times.
  - The validation runs (each photo read 3 times) will show how often readings disagree, which tells us whether S2 is worth its cost.
- **S3. Plausibility check against the Tunisian medicines list** (needs research and your approval).
  - Check a read name + strength + form against the official nomenclature of medicines registered in Tunisia (DPM). Availability and licence of an offline copy are not yet checked.
  - Use it **only to warn** ("this strength doesn't match this medicine as registered, check it"). **Never to fill in or correct** a reading: that would be inventing.
- **S4. Barcodes** (later; overlaps Phase 3; not OCR). The box barcode, or a GS1 DataMatrix where present, read on the phone (`BarcodeDetector` in Chrome on Android) would identify the product and sometimes the expiry without any AI. Whether Tunisian boxes carry a DataMatrix with expiry is unknown and must be checked on real boxes.

**What none of this can do:** make the reader a source of truth for doses. Even with every fix, the honest product statement stays: *"Nadhra reads the label to you. Before taking any medicine, check the name and dose with a pharmacist or someone you trust."*

## 3. Privacy

### What happens today

- From Open Camera onward, frames go to **Google Gemini (free tier)** every few seconds, with **OpenRouter** as the fallback. This is the automatic description, not only "read". Any prescription in view is sent even if the user never asks for a reading.
- A reading sends one photo (up to 1920 px, so small print, names and ID numbers are legible).
- Follow-up questions resend the clearly read text. Readings also enter the last-3 conversation history, which is sent with later, unrelated questions.
- Nadhra's own server stores no images or text. Its logs hold only short codes (`monitor.ts`, `logFailures`). The page keeps the last document in memory for 5 minutes. It's forgotten when consent is withdrawn or the language changes.

### What Google's terms say (checked 2026-11-13, aistudio.google.com/docs/terms)

- **Free tier ("Unpaid Services"), which applies in Tunisia:**
  - Google uses submitted content and responses "to provide, improve" its products.
  - "human reviewers may read, annotate, and process your API input and output".
  - No retention period is given.
  - **"Do not submit sensitive, confidential, or personal information to the Unpaid Services."**
- **Paid tier:** prompts and responses are not used to improve products. They are logged "for a limited period" for abuse detection only.
- **For all tiers:** "You may not use the Services in clinical practice, to provide medical advice", and "Don't rely on the Services for medical … advice."

### Findings

- **P1 (critical).** A prescription carries a patient's name, often an ID or social-security number, and health information. Sending it to the free tier goes against Google's own instruction. This is not something consent from the user can fix: the instruction is Google's condition for the service.
- **P2 (high).** The spoken consent says «الصور تتبعث لخدمة ذكاء اصطناعي خارجية … ما نخزّنوش الصور» ("images are sent to an outside AI service … we don't store them"). It doesn't name Google. It doesn't say Google may keep the images and let staff see them. It doesn't mention medical papers. "We don't store them" is true of Nadhra but misleading by omission.
- **P3 (high).** OpenRouter's free routing sends images to whichever free model provider answers. Their retention is unknown. For medical papers this is not acceptable.
- **P4 (medium).** Automatic scans send documents that are merely in view (see above).
- **P5 (medium).** Readings leak into the general history sent with later questions.
- **P6 (low).** Readings appear as captions on screen. A blind user can't tell who is reading their screen.
- **P7 (legal, not assessed).** Tunisian law (Organic Law 2004-63 on personal data, overseen by the INPDP) treats health data as sensitive and restricts sending personal data abroad. **A legal check is needed before real users.** This review is not legal advice.

### Proposals (for your approval)

1. **Your decision, no code:** move reading (at least) to a **paid Gemini tier**, so content isn't used for training or human review. It costs money, so it needs your approval. Until then, keep the reader in supervised testing and never use real prescriptions with identifying details on them (see the test plan).
2. **Informed before transmission:** a one-time spoken notice the first time the user asks for a reading, *before* any photo is sent, with spoken «موافق» to continue. Draft (Derja):
   > «باش نقرالك الورقة ولا علبة الدوا، نصوّرها ونبعث الصورة لـ Google Gemini. في الخدمة المجانية، Google تنجم تحتفظ بالصورة وتستعملها، وتنجم يشوفها خدّام عندهم. ما تصوّرش ورقة فيها اسمك ولا رقم بطاقتك إلا إذا قابل بهذا. قول موافق باش نكمّل، ولا رجّع.»
   >
   > ("To read the paper or the medicine box, I photograph it and send the picture to Google Gemini. On the free service, Google may keep and use the picture, and its staff may see it. Don't photograph a paper with your name or ID number unless you accept this. Say موافق to continue, or رجّع to cancel.")

   Also update the camera consent to name Google and say the same in one sentence.
3. **No OpenRouter fallback for reading mode.** If Gemini is down, the user hears "reading is unavailable now".
4. **Readings stay out of the general history.** Follow-ups to the document still carry its text, as they must.
5. **Optional setting:** don't show readings as captions.
6. **Legal check** with someone who knows Law 2004-63 and the INPDP before any use outside supervised testing.

## 4. Better Derja explanations, without letting the AI invent medical information

The problem seen: a model-written explanation said the medicine is used «باش توجّع الراس» ("to cause a headache"). The cause is not only wording: the model is allowed to explain medical use at all. Proposal:

1. **Medical papers: the AI explains only what the paper is,** never what the medicine does. For example: «وصفة من الطبيب سامي بن سالم، فيها 3 أدوية، بتاريخ 10/11/2026.» ("A prescription from Dr Sami Ben Salem, with 3 medicines, dated 10/11/2026.") No uses, no age groups, no warnings that aren't printed. The F5 filter enforces this in code.
2. **How to take it, in Derja, from a fixed glossary, not from the AI.**
   - Code translates a confirmed instruction line word for word with a pharmacist-reviewed table. The numbers are copied by code. If a single word isn't in the table, no Derja rendering is given; the user hears only the original.
   - Example: `1 comprimé 3 fois par jour pendant 5 jours` → «يعني: 1 حبّة، 3 مرات في النهار، مدة 5 أيام».
   - Starting glossary for the pharmacist to review:

     | French | Derja |
     |---|---|
     | comprimé, cp | حبّة |
     | gélule | كبسولة |
     | sachet | باكو / كيس |
     | sirop | سيرو |
     | gouttes | قطرات |
     | cuillère à café / à soupe | مغرفة صغيرة / كبيرة |
     | fois par jour | مرات في النهار |
     | matin / midi / soir | الصباح / نص النهار / العشية |
     | au coucher | قبل ما ترقد |
     | à jeun | على الريق |
     | avant / après les repas | قبل / بعد الماكلة |
     | pendant N jours / semaines / mois | مدة N أيام / جمعات / شهورة |
     | si douleur / fièvre / toux | كان فمّا وجيعة / سخانة / كحّة |
     | ½ | نص |
   - Abbreviations like `3x/j` or `1-0-1` vary a lot, so they're rendered only after the pharmacist has listed them.
3. **The prompt's Derja block** gets pharmacy vocabulary (دوا، حبّة، الصيدلية، الأوردونونس، الوجيعة، السخانة) and examples of descriptive sentences. It still allows no medical claims.
4. **Measured, not assumed:** two native Derja speakers rate every explanation in the validation set as *correct / awkward / misleading*. Target: no misleading sentence.

## 5. Recommended order

1. **Fix F1–F6 and apply S1** (wording), with tests for each. Needs your approval. These are small, contained changes in `document.ts`, `phrases.ts`, `prompts.ts`, `controller.ts` and `live/config.ts`.
2. Privacy proposals 2–4 (notice before first reading, no OpenRouter for reading, history). Decide on the paid tier.
3. **Sighted bench validation** with real photos (test plan), measuring the model's raw error rate and how often its readings disagree between runs.
4. Decide S2 (double reading) from those numbers, and S3 (registry) after research.
5. Android device checklist with sighted testers, then a supervised session with blind users. **Only after zero critical errors** in the bench validation.

Step 3 can run on the current code, to measure the model itself. But **no blind participant should use the reader before steps 1 and 2.**
