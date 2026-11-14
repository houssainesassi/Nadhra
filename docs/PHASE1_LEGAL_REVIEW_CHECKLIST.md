# Legal review checklist before real patient documents are used

**For:** a lawyer qualified in Tunisian data-protection law, and the project owner. **Status:** questions to be answered; nothing here is legal advice, and nothing here has been reviewed by a lawyer yet.

**Rule until this review is done:** no real prescription or identifiable medical document is photographed with Nadhra. This holds for supervised testing too. Only mock documents for fictional patients, and medicine boxes, which carry no personal data.

**Decided 2026-11-13 (project owner):** the paid Gemini terms review and the Tunisian legal review (Law 2004-63, INPDP requirements) must both be completed before any real prescription is processed.

## 1. What Nadhra does with a document today (facts for the reviewer)

- After a spoken notice and a spoken «موافق» (agree), two photos of the paper are sent from the user's phone to Nadhra's server, which forwards them to **Google Gemini (free tier)**, in Google's data centres outside Tunisia. They are never sent to OpenRouter.
- Nadhra's server doesn't store the photos or the text. Its logs hold only short event codes.
- The phone keeps the text read for 5 minutes in memory, for follow-up questions. That text is sent back to Gemini with each follow-up.
- Automatic descriptions are **off by default**: no picture leaves the phone unless the user asks (a question, a reading, a live conversation). When the user turns them on, they're told that a picture goes to Google every few seconds, papers in view included.
- Google's free-tier terms (checked 2026-11-13, aistudio.google.com/docs/terms) say Google may use the content to improve its products, human reviewers may read it, and **"Do not submit sensitive, confidential, or personal information to the Unpaid Services."** For every tier: **"You may not use the Services in clinical practice, to provide medical advice."**

## 2. Tunisian law (Organic Law n° 2004-63 of 27 July 2004 on the protection of personal data; INPDP)

### Who is responsible

- [ ] Who is the data controller (responsable du traitement): the developer, a company or association running Nadhra, or the user? Does processing for the user's own private purposes change this?
- [ ] Is Google (or another provider) a processor (sous-traitant) under Tunisian law, and what contract is required with it?

### Nature of the data

- [ ] A prescription photo: name, sometimes ID or social-security number, the doctor's name, medicines and doses. Confirm it is **health data**, a sensitive category, and what that requires.
- [ ] Does processing that lasts only seconds, without storage, still count as processing that needs the full regime? (Assumed yes.)
- [ ] Data of **third parties** in the photo (a relative's prescription, the doctor), and of people in automatic scene frames.

### Prior formalities with the INPDP

- [ ] Is a declaration to the INPDP required? Is a prior **authorisation** required for health data?
- [ ] Which form and which information? How long does it take?
- [ ] Are there special conditions for processing health data outside a health professional's supervision?

### Consent

- [ ] What form of consent is valid for health data (express, written)? Is a **spoken** «موافق» in the app enough, or is a written or electronic signature needed?
- [ ] How can consent be given **accessibly** by a blind user, in a way the law recognises?
- [ ] Is consent valid at all when the provider's own terms ask that such data not be sent? (Our position: no. Consent doesn't make the use compliant, so real documents stay out until this is resolved.)
- [ ] Withdrawing consent: what must happen to data already sent to the provider?

### Transfer abroad

- [ ] Sending photos to Google's servers abroad: is an **INPDP authorisation** for the transfer required, and under what conditions (adequate protection of the receiving country, contract clauses)?
- [ ] Tunisia's accession to Council of Europe Convention 108 (to be confirmed by the reviewer): does it affect transfers?
- [ ] Is the location of Google's processing known and contractually fixed (region)?

### Information to the user

- [ ] Is the content of the spoken notices legally sufficient? They need to cover the controller's identity, purposes, recipients, transfer abroad, retention, rights and how to exercise them. Draft texts are in `src/lib/assistant/phrases.ts` (`privacy`, `doc.notice`).
- [ ] Does the information also have to be available in writing (a privacy policy page), and in Arabic?

### Rights and security

- [ ] How are the rights of access, rectification and opposition handled when Nadhra keeps nothing, but Google may?
- [ ] Required security measures and breach notification.

### Status of the law

- [ ] Is a newer data-protection law in force or expected, replacing or amending Law 2004-63? What changes?

## 3. Health regulation

- [ ] Does reading a medicine box or a prescription aloud to a patient make Nadhra a **medical device** or regulated health software under Tunisian rules (Ministry of Health, Direction de la Pharmacie et du Médicament)? Does it matter that the app refuses all advice and says "check with the pharmacist" after every dose?
- [ ] Liability if a user acts on a misreading. Is the experimental-version disclaimer sufficient?
- [ ] If Nadhra is ever offered in the EU: the Medical Device Regulation question, and Google's rule that EEA users may only be served through **paid** services.

## 4. Provider terms (any tier)

- [ ] Does reading a label aloud to its owner fall under Google's prohibition of use "in clinical practice, to provide medical advice"? Ask Google if needed, and keep the answer in writing.
- [ ] For a **paid tier**, check the actual terms, not assumptions:
  - [ ] Content not used for training. (The terms say so today; recheck.)
  - [ ] Retention for abuse monitoring: how long; whether human reviewers can see flagged content; whether a zero-retention option exists, and on which product (Gemini API vs Vertex AI).
  - [ ] Data processing addendum (DPA) and its transfer clauses.
  - [ ] Processing region, and whether it can be chosen.
  - [ ] The medical-use restriction, which applies to every tier.
  - [ ] Cost per reading at the expected volume: two images per reading. Not estimated here; current prices must be checked.
- [ ] OpenRouter: excluded from document reading. Should it also be excluded from scene descriptions, since faces and surroundings are personal data too?

## 5. Testing with people

- [ ] Is ethics approval needed for supervised sessions with blind participants (study protocol, consent forms read aloud)?
- [ ] Data handling for test photos and results: mock documents only, stored on one laptop, deleted at the end. Is this sufficient?

## 6. Known technical limits the reviewer should know

- Automatic descriptions are off by default, so no document is sent unless the user asks. If the user **turns them on**, the first automatic frame showing a document can still be sent before it is recognised (they're told this when turning them on).
- In a **live conversation** (started by the user), frames go to Gemini Live about once a second, documents in view included, until a reading pauses them.
