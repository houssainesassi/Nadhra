# Phase 1: Medication & Document Reader (status)

**Date:** 2026-11-13. **Branch:** `mai`, not committed. **Status:** implemented and tested in software. Not yet tested on a real Android phone, with real medicine boxes, or with blind users.

How it works, and the safety rules, are described in [ARCHITECTURE.md](ARCHITECTURE.md#reading-documents-and-medicine-boxes).

## What works

| Requirement | How | Verified by |
|---|---|---|
| Recognise medicine packaging | `doc_type` from the model; header «هاذي علبة دوا» | real model, rendered boxes |
| Read medicine name and labels | name, substance, strength, form, quantity, expiry, each checked against the read lines | unit + real model |
| Read prescriptions and medical papers | confirmed lines word for word | unit + real model |
| Read bills, letters, printed papers | confirmed and likely lines; long papers: start + «اقرا الكل» | unit + real model (Arabic bill, Arabic letter) |
| OCR | the existing vision provider chain (Gemini free tier, OpenRouter fallback), dedicated prompt, temperature 0 | real model |
| Read aloud in Derja, Arabic, French, English | labels in the user's language; the paper's text in its own language's voice (French box → French voice) | unit + Chromium |
| Questions about the document | 5-minute page memory; answer = checked quote + labelled explanation | unit + real model + Chromium |
| Blurry or uncertain text → scan again | on-device darkness and blur check before sending; model-reported legibility and per-line confidence; a tip for the cause (glare, blur, cut off, …) | unit + real model + Chromium |
| Never invent names, doses, instructions | grounding of fields and quotes; numbers in explanations must be printed; doses held back when the paper is reported as hard to read | unit + real model |
| Extracted text vs AI explanation | separate spoken parts; explanation always introduced as the assistant's | unit + Chromium |
| Never recommend or change medication | advice removed from explanations; advice questions get the doctor/pharmacist answer | unit + real model |

No new buttons: everything is by voice. Existing modes (scan, question, chat, live) are unchanged.

## Tests run (2026-11-13)

- `npm test`: **243/243** pass (204 before; 39 new or extended).
- `npx tsc --noEmit`: no errors. `npm run build`: succeeds.
- `e2e/read/run.ts` (real Gemini, 16 cases): all pass on the final code. Earlier runs found two real problems that are now fixed: the model filled in a dose hidden by glare and marked it confirmed, and a follow-up question lost the medical rules.
- `e2e/read/browser.mjs` (production build, Chromium, real Gemini, fake camera and speech): **13/13**.
- Regression: `e2e/redesign.mjs` **45/45**; `e2e/vision.mjs` mocked scenarios **15/15** (one mock updated to the reading contract).

## Bugs found and fixed along the way

1. **"/" read as "or"** (existing speech code): «EXP 03/2027» was spoken «03 ou 2027», and «1/2 comprimé» would have been «1 ou 2». Fixed for dates, fractions and units.
2. Glare over a dose: the model completed «500 m…» to «500 mg» and called it confirmed. Doses and dates on medical papers now wait for a clear picture when the model reports glare, blur and so on.
3. On-device blur check: camera noise made blurred frames look sharp. The measure now smooths first; noise alone no longer passes.

## Limits and open points

- **Not tested with real photos.** The test pictures are rendered with Pillow and made to look photographed (perspective, lighting, noise, blur, glare). Real crumpled boxes, curved bottles, blister packs and handwriting are untested. Next step: 20 to 30 photos of real Tunisian boxes and prescriptions, taken by you, through `e2e/read/run.ts`.
- **Blur limit calibrated on rendered pages only** (`READ_BLUR_LIMIT = 20`). It is set low, to catch only gross blur; it should be checked on real phone frames.
- **The full-resolution still photo** (ImageCapture) is untested on a real phone. It falls back to the 720p video frame. Chromium's fake camera gives the same size, so the fallback path is what ran.
- **Handwriting:** handwritten doses are held back and the user is told to ask the pharmacist. This is by design.
- **Images still go to Google Gemini** (free tier), as for the rest of the app. On-device OCR (for example Tesseract, open source) was not added. Its Arabic accuracy on photos is weak, and a misread dose with no reliable confidence is the main risk. It could give offline reading of simple French text; that is your decision.
- The model's Derja explanations are sometimes awkward or wrong in wording. In one run it said the medicine is used «باش توجّع الراس» ("to cause a headache") instead of "for headaches". Explanations are labelled as the assistant's and carry no numbers that aren't printed, but their wording is not checked.
- An expiry date is judged only in numeric forms (03/2027, 2027-03, 12/11/2026); month names are read but not judged.
- When the scan narration offers «تحب نقراهالك؟», a plain «إيه» goes to an ordinary question, not to the reading mode.
