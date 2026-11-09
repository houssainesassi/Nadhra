// Everything the assistant says on its own, in each speech language. Warnings are built from
// validated fields by these templates, not by the model, so the wording always matches the
// confidence level. Tunisian is the reference: the other languages say the same thing.
import type { Hazard, Side } from "./types.ts";
import type { SpeechLang } from "./lang.ts";

const TN = {
  disclaimer: "هذا المساعد تجريبي ويعاونك برك. ما يعوّضش العصا ولا الكلب المرشد ولا معاونة الناس، ونجم يغلط.",
  privacy: "باش نوصفلك اللي قدّامك، الصور تتبعث لخدمة ذكاء اصطناعي خارجية. ما نسجّلوش فيديو وما نخزّنوش الصور. إذا موافق، اضغط موافق.",
  consentRefused: "باهي، ما شعّلتش الكاميرا وما تبعثت حتى صورة.",
  cameraOn: "الكاميرا خدّامة.",
  cameraOff: "الكاميرا تسكّرت.",
  cameraNeeded: "الكاميرا مطفية. شعّلها الأول باش نجم نجاوبك.",
  cameraLost: "الكاميرا وقفت. ثبّت فيها وشعّلها مرة أخرى.",
  detectorFailed: "التحذيرات اللي في الجهاز ما تخدمش. توّة كان التحليل بالإنترنت اللي ينجم ينبّهك، وهو أبطأ. كمّل ثبّت بالعصا. سكّر الكاميرا وشعّلها باش نعاود نجرّب.",
  wasAway: "الكاميرا تسكّرت وقت اللي خرجت من التطبيق.",
  paused: "وقّفت التحليل.",
  resumed: "رجعت نحلّل.",
  assistantOn: "المساعد الصوتي خدّام. اسألني وقت اللي تحب.",
  assistantOff: "سكّرت الميكرو.",
  listening: "نسمع فيك.",
  noQuestionHeard: "ما سمعتش سؤال. عاود قولو.",
  micDenied: "ما عنديش الإذن باش نستعمل الميكرو. اسمح بيه من إعدادات المتصفح، ولا اكتب سؤالك.",
  micMissing: "ما لقيتش ميكرو يخدم. تنجم تكتب سؤالك.",
  voiceFallback: "التعرّف على الكلام في المتصفح هذا ما يخدمش، باش نسجّل صوتك ونبعثو للخدمة.",
  voiceUnavailable: "الأسئلة بالصوت ما تخدمش هنا. استعمل الأزرار ولا اكتب سؤالك.",
  analysisDown: "التحليل واقف توّة وما نجمش نوصفلك. رد بالك وما تعتمدش عليّ.",
  analysisBack: "رجع التحليل يخدم.",
  aiNotConfigured: "خدمة التحليل موش مفعّلة على الخادم.",
  rateLimited: "طلبات برشة في وقت قصير. نستنّى شوية ونرجع.",
  questionFailed: "ما نجمتش نجاوبك توّة، صار مشكل في الخدمة. عاود بعد شوية.",
  thinking: "لحظة، نشوف.",
  tooDark: "الصورة مظلمة برشة وما نشوفش مليح. ما نجمش نقلّك شنوة قدّامك.",
  obstructed: "ما نشوف شي واضح. يمكن الكاميرا مغطّية ولا موجّهة لحيط.",
  imageBack: "الصورة رجعت واضحة.",
  nothingToRepeat: "مازلت ما قلت شي.",
  unsure: "ما نجمتش نتأكّد من اللي في الصورة. حرّك الكاميرا شوية وعاود اسألني.",
  pathCaveat: "أما ما نجمش نأكّدلك إلي الطريق آمن، كمّل ثبّت بالعصا.",
  pathUnknown: "ما نجمش نأكّدلك إلي الطريق آمن. ثبّت بالعصا واسأل شكون حذاك إذا تنجم.",
  help: "تنجم تقول: شنوة قدّامي، وصفلي البلاصة، اقرالي الكتابة، شنوة هاذي الحاجة، عاود، اسكت، وقّف التحليل، كمّل، رجّع، ولا نجدة. ولا اسألني أي سؤال على اللي قدّامك.",
  cancelled: "باهي، بطّلت.",
  closed: "سكّرت.",
  offline: "ما فمّاش إنترنت. التحليل واقف، والتحذيرات اللي في الجهاز برك اللي تخدم، على العباد والكراهب وبعض الحوايج.",
  online: "رجع الإنترنت.",
  emergency: "صفحة النجدة محلولة. تنجم تعيّط للشخص اللي اخترتو، ولا تبعثلو بلاصتك في ميساج، ولا تعيّط للسامو 190، ولا للبوليس 197، ولا للحماية المدنية 198. قول عيّط باش تعيّط للشخص متاعك.",
  noContact: "ما زلت ما زدتش رقم شخص للنجدة. زيدو في الإعدادات.",
  calling: "زر التعيّط مختار. اضغط عليه مرتين ولا اضغط إنتر باش تعيّط.",
  louder: "علّيت الصوت.",
  quieter: "هبّطت الصوت.",
  faster: "توّة نحكي أسرع.",
  slower: "توّة نحكي بالشوية.",
  limit: "هذا آخر حد.",
  notSafe: "هذا ما يعنيش إلي الطريق آمن.",
  locating: "نلوّج على بلاصتك.",
  noLocation: "ما نجمتش نعرف بلاصتك. باش نحلّك الميساج من غير بلاصة.",
  smsReady: "حلّيتلك الميساج. اضغط على زر البعث.",
  languageSet: "باهي، توّة نحكي بالتونسي.",
  ask: {
    front: "شنوة قدّامي؟",
    describe: "وصفلي البلاصة اللي أنا فيها.",
    read: "اقرالي الكتابة اللي في الصورة كلمة بكلمة.",
    identify: "شنوة الحاجة هاذي اللي قدّام الكاميرا؟ إذا فمّا ماركة ولا إتيكات اقراها.",
  },
  sms: "محتاج معاونة. هاذي بلاصتي:",
  smsNoLocation: "محتاج معاونة. عيّطلي.",
};

export type Phrases = typeof TN;

const AR: Phrases = {
  disclaimer: "هذا المساعد تجريبي وللمساعدة فقط. لا يعوّض العصا البيضاء ولا الكلب المرشد ولا مساعدة الناس، وقد يخطئ.",
  privacy: "لأصف لك ما أمامك، تُرسل الصور إلى خدمة ذكاء اصطناعي خارجية. لا نسجّل الفيديو ولا نحفظ الصور. إذا كنت موافقًا، اضغط موافق.",
  consentRefused: "حسنًا، لم أشغّل الكاميرا ولم تُرسل أي صورة.",
  cameraOn: "الكاميرا تعمل.",
  cameraOff: "أُطفئت الكاميرا.",
  cameraNeeded: "الكاميرا مطفأة. شغّلها أولًا حتى أستطيع الإجابة.",
  cameraLost: "توقّفت الكاميرا. تحقّق منها وشغّلها مرة أخرى.",
  detectorFailed: "تحذيرات الجهاز لا تعمل. لا ينبّهك الآن إلا التحليل عبر الإنترنت، وهو أبطأ. واصل استعمال العصا. أطفئ الكاميرا وشغّلها لأحاول من جديد.",
  wasAway: "أُطفئت الكاميرا عندما غادرت التطبيق.",
  paused: "أوقفت التحليل.",
  resumed: "عدت إلى التحليل.",
  assistantOn: "المساعد الصوتي يعمل. اسألني متى شئت.",
  assistantOff: "أطفأت الميكروفون.",
  listening: "أنا أستمع.",
  noQuestionHeard: "لم أسمع سؤالًا. أعد من فضلك.",
  micDenied: "ليس لدي إذن لاستعمال الميكروفون. اسمح به من إعدادات المتصفح، أو اكتب سؤالك.",
  micMissing: "لم أجد ميكروفونًا يعمل. يمكنك كتابة سؤالك.",
  voiceFallback: "التعرّف على الكلام لا يعمل في هذا المتصفح، لذلك سأسجّل صوتك وأرسله إلى الخدمة.",
  voiceUnavailable: "الأسئلة الصوتية لا تعمل هنا. استعمل الأزرار أو اكتب سؤالك.",
  analysisDown: "التحليل متوقّف الآن ولا أستطيع الوصف. انتبه ولا تعتمد عليّ.",
  analysisBack: "عاد التحليل إلى العمل.",
  aiNotConfigured: "خدمة التحليل غير مفعّلة على الخادم.",
  rateLimited: "طلبات كثيرة في وقت قصير. سأنتظر قليلًا ثم أعود.",
  questionFailed: "لم أستطع الإجابة الآن، حدثت مشكلة في الخدمة. أعد المحاولة بعد قليل.",
  thinking: "لحظة، أنظر.",
  tooDark: "الصورة مظلمة جدًا ولا أرى جيدًا. لا أستطيع أن أخبرك بما أمامك.",
  obstructed: "لا أرى شيئًا واضحًا. ربما الكاميرا مغطّاة أو موجّهة إلى حائط.",
  imageBack: "عادت الصورة واضحة.",
  nothingToRepeat: "لم أقل شيئًا بعد.",
  unsure: "لم أستطع التأكّد مما في الصورة. حرّك الكاميرا قليلًا واسألني مرة أخرى.",
  pathCaveat: "لكن لا أستطيع أن أؤكّد أن الطريق آمن، واصل التحقّق بالعصا.",
  pathUnknown: "لا أستطيع أن أؤكّد أن الطريق آمن. تحقّق بالعصا واسأل من حولك إن أمكن.",
  help: "يمكنك أن تقول: ماذا أمامي، صف المكان، اقرأ النص، ما هذا الشيء، أعد، اسكت، أوقف التحليل، تابع، رجوع، أو نجدة. أو اسألني أي سؤال عمّا أمامك.",
  cancelled: "حسنًا، ألغيت.",
  closed: "أغلقت.",
  offline: "لا يوجد اتصال بالإنترنت. التحليل متوقّف، وتعمل فقط التحذيرات على الجهاز، للأشخاص والسيارات وبعض الأشياء.",
  online: "عاد الاتصال بالإنترنت.",
  emergency: "صفحة الطوارئ مفتوحة. يمكنك الاتصال بالشخص الذي اخترته، أو إرسال موقعك إليه في رسالة، أو الاتصال بالإسعاف 190، أو الشرطة 197، أو الحماية المدنية 198. قل اتصل للاتصال بجهة الطوارئ.",
  noContact: "لم تضف بعد رقم شخص للطوارئ. أضفه في الإعدادات.",
  calling: "زر الاتصال محدّد. انقر عليه مرتين أو اضغط إدخال للاتصال.",
  louder: "رفعت الصوت.",
  quieter: "خفضت الصوت.",
  faster: "سأتحدث الآن بسرعة أكبر.",
  slower: "سأتحدث الآن ببطء أكثر.",
  limit: "هذا هو الحد الأقصى.",
  notSafe: "هذا لا يعني أن الطريق آمن.",
  locating: "أبحث عن موقعك.",
  noLocation: "لم أستطع تحديد موقعك. سأفتح الرسالة بدون موقع.",
  smsReady: "فتحت لك الرسالة. اضغط زر الإرسال.",
  languageSet: "حسنًا، سأتحدّث الآن بالعربية الفصحى.",
  ask: {
    front: "ماذا أمامي؟",
    describe: "صف لي المكان الذي أنا فيه.",
    read: "اقرأ لي النص الموجود في الصورة كلمة بكلمة.",
    identify: "ما هذا الشيء الموجود أمام الكاميرا؟ إذا كانت هناك علامة تجارية أو ملصق فاقرأه.",
  },
  sms: "أحتاج إلى مساعدة. هذا موقعي:",
  smsNoLocation: "أحتاج إلى مساعدة. اتصل بي.",
};

const FR: Phrases = {
  disclaimer: "Cet assistant est expérimental et n'est qu'une aide. Il ne remplace ni la canne blanche, ni le chien guide, ni l'aide d'une personne, et il peut se tromper.",
  privacy: "Pour vous décrire ce qui est devant vous, les images sont envoyées à un service d'intelligence artificielle externe. Aucune vidéo n'est enregistrée et aucune image n'est conservée. Si vous êtes d'accord, appuyez sur J'accepte.",
  consentRefused: "D'accord, la caméra reste éteinte et aucune image n'a été envoyée.",
  cameraOn: "La caméra est allumée.",
  cameraOff: "La caméra est éteinte.",
  cameraNeeded: "La caméra est éteinte. Allumez-la d'abord pour que je puisse répondre.",
  cameraLost: "La caméra s'est arrêtée. Vérifiez-la et rallumez-la.",
  detectorFailed: "Les alertes de l'appareil ne fonctionnent pas. Seule l'analyse par Internet peut vous prévenir maintenant, et elle est plus lente. Gardez votre canne. Éteignez puis rallumez la caméra pour réessayer.",
  wasAway: "La caméra était éteinte pendant que vous étiez hors de l'application.",
  paused: "Analyse en pause.",
  resumed: "Je reprends l'analyse.",
  assistantOn: "L'assistant vocal est actif. Posez-moi une question quand vous voulez.",
  assistantOff: "Micro éteint.",
  listening: "Je vous écoute.",
  noQuestionHeard: "Je n'ai pas entendu de question. Répétez, s'il vous plaît.",
  micDenied: "Je n'ai pas l'autorisation d'utiliser le micro. Autorisez-le dans les réglages du navigateur, ou écrivez votre question.",
  micMissing: "Je n'ai pas trouvé de micro qui fonctionne. Vous pouvez écrire votre question.",
  voiceFallback: "La reconnaissance vocale ne fonctionne pas dans ce navigateur. J'enregistre donc votre voix et je l'envoie au service.",
  voiceUnavailable: "Les questions vocales ne fonctionnent pas ici. Utilisez les boutons ou écrivez votre question.",
  analysisDown: "L'analyse est arrêtée et je ne peux pas décrire. Soyez prudent et ne comptez pas sur moi.",
  analysisBack: "L'analyse fonctionne de nouveau.",
  aiNotConfigured: "Le service d'analyse n'est pas activé sur le serveur.",
  rateLimited: "Trop de demandes en peu de temps. J'attends un peu et je reviens.",
  questionFailed: "Je n'ai pas pu répondre, le service a un problème. Réessayez dans un moment.",
  thinking: "Un instant, je regarde.",
  tooDark: "L'image est trop sombre et je vois mal. Je ne peux pas vous dire ce qui est devant vous.",
  obstructed: "Je ne vois rien de net. La caméra est peut-être couverte ou tournée vers un mur.",
  imageBack: "L'image est de nouveau nette.",
  nothingToRepeat: "Je n'ai encore rien dit.",
  unsure: "Je n'ai pas pu être sûr de ce qu'il y a sur l'image. Bougez un peu la caméra et redemandez-moi.",
  pathCaveat: "Mais je ne peux pas confirmer que le chemin est sans risque. Continuez à vérifier avec la canne.",
  pathUnknown: "Je ne peux pas confirmer que le chemin est sans risque. Vérifiez avec la canne et demandez aux personnes autour si possible.",
  help: "Vous pouvez dire : qu'y a-t-il devant moi, décris les alentours, lis le texte, qu'est-ce que c'est, répète, tais-toi, mets en pause, continue, retour, ou urgence. Ou posez-moi n'importe quelle question sur ce qui est devant vous.",
  cancelled: "D'accord, j'annule.",
  closed: "Fermé.",
  offline: "Pas de connexion Internet. L'analyse est arrêtée. Seules les alertes de l'appareil fonctionnent, pour les personnes, les véhicules et quelques objets.",
  online: "La connexion Internet est revenue.",
  emergency: "Page d'urgence ouverte. Vous pouvez appeler votre contact, lui envoyer votre position par SMS, ou appeler le SAMU au 190, la police au 197 ou la protection civile au 198. Dites appelle pour appeler votre contact.",
  noContact: "Vous n'avez pas encore ajouté de contact d'urgence. Ajoutez-le dans les réglages.",
  calling: "Le bouton d'appel est sélectionné. Touchez-le deux fois ou appuyez sur Entrée pour appeler.",
  louder: "J'ai monté le volume.",
  quieter: "J'ai baissé le volume.",
  faster: "Je parle plus vite.",
  slower: "Je parle plus lentement.",
  limit: "C'est la limite.",
  notSafe: "Cela ne veut pas dire que le chemin est sans risque.",
  locating: "Je cherche votre position.",
  noLocation: "Je n'ai pas pu trouver votre position. J'ouvre le message sans position.",
  smsReady: "Le message est prêt. Appuyez sur envoyer.",
  languageSet: "D'accord, je parle maintenant en français.",
  ask: {
    front: "Qu'y a-t-il devant moi ?",
    describe: "Décris-moi l'endroit où je suis.",
    read: "Lis-moi le texte de l'image, mot pour mot.",
    identify: "Quel est cet objet devant la caméra ? S'il y a une marque ou une étiquette, lis-la.",
  },
  sms: "J'ai besoin d'aide. Voici ma position :",
  smsNoLocation: "J'ai besoin d'aide. Appelle-moi.",
};

const EN: Phrases = {
  disclaimer: "This assistant is experimental and only helps. It doesn't replace a white cane, a guide dog or help from people, and it can be wrong.",
  privacy: "To describe what's in front of you, images are sent to an external AI service. No video is recorded and no images are stored. If you agree, press I agree.",
  consentRefused: "Okay, the camera stays off and no image was sent.",
  cameraOn: "The camera is on.",
  cameraOff: "The camera is off.",
  cameraNeeded: "The camera is off. Turn it on first so I can answer.",
  cameraLost: "The camera stopped. Check it and turn it on again.",
  detectorFailed: "On-device warnings aren't working. Only the internet analysis can warn you now, and it is slower. Keep using your cane. Turn the camera off and on to try again.",
  wasAway: "The camera was off while you were away from the app.",
  paused: "Analysis paused.",
  resumed: "Analysis resumed.",
  assistantOn: "The voice assistant is on. Ask me anything, any time.",
  assistantOff: "Microphone off.",
  listening: "I'm listening.",
  noQuestionHeard: "I didn't hear a question. Please say it again.",
  micDenied: "I don't have permission to use the microphone. Allow it in your browser settings, or type your question.",
  micMissing: "I couldn't find a working microphone. You can type your question.",
  voiceFallback: "Speech recognition doesn't work in this browser, so I'll record your voice and send it to the service.",
  voiceUnavailable: "Voice questions don't work here. Use the buttons or type your question.",
  analysisDown: "Analysis has stopped and I can't describe anything. Be careful and don't rely on me.",
  analysisBack: "Analysis is working again.",
  aiNotConfigured: "The analysis service isn't set up on the server.",
  rateLimited: "Too many requests in a short time. I'll wait a little and come back.",
  questionFailed: "I couldn't answer, the service had a problem. Try again in a moment.",
  thinking: "One moment, looking.",
  tooDark: "The image is too dark to see well. I can't tell you what's in front of you.",
  obstructed: "I can't see anything clearly. The camera may be covered or facing a wall.",
  imageBack: "The image is clear again.",
  nothingToRepeat: "I haven't said anything yet.",
  unsure: "I couldn't be sure what's in the image. Move the camera a little and ask me again.",
  pathCaveat: "But I can't confirm the way is without risk. Keep checking with your cane.",
  pathUnknown: "I can't confirm the way is without risk. Check with your cane, and ask someone nearby if you can.",
  help: "You can say: what's in front of me, describe my surroundings, read this text, what is this, repeat, stop, pause analysis, continue, go back, or emergency. Or ask me any question about what's in front of you.",
  cancelled: "Okay, cancelled.",
  closed: "Closed.",
  offline: "No internet connection. Analysis has stopped. Only the on-device warnings work, for people, vehicles and a few objects.",
  online: "The internet connection is back.",
  emergency: "Emergency page open. You can call your contact, send them your location by text message, or call SAMU on 190, the police on 197, or civil protection on 198. Say call to call your contact.",
  noContact: "You haven't added an emergency contact yet. Add one in Settings.",
  calling: "The call button is selected. Double-tap it or press Enter to call.",
  louder: "Volume up.",
  quieter: "Volume down.",
  faster: "Speaking faster.",
  slower: "Speaking slower.",
  limit: "That's the limit.",
  notSafe: "That doesn't mean the way is safe.",
  locating: "Finding your location.",
  noLocation: "I couldn't find your location. I'll open the message without it.",
  smsReady: "The message is ready. Press send.",
  languageSet: "Okay, I'll speak English now.",
  ask: {
    front: "What's in front of me?",
    describe: "Describe the place I'm in.",
    read: "Read me the text in the image, word for word.",
    identify: "What is this object in front of the camera? If there's a brand or label, read it.",
  },
  sms: "I need help. This is my location:",
  smsNoLocation: "I need help. Please call me.",
};

export const PHRASES: Record<SpeechLang, Phrases> = { tn: TN, ar: AR, fr: FR, en: EN };

/** Tunisian, the default. Kept for code and tests that predate the other languages. */
export const SPEECH = TN;

export const speech = (lang: SpeechLang): Phrases => PHRASES[lang] ?? TN;

export type CameraErrorCode = "denied" | "not-found" | "busy" | "insecure" | "unsupported" | "unknown";

const CAMERA_ERROR_TEXT: Record<SpeechLang, Record<CameraErrorCode, string>> = {
  tn: {
    denied: "ما عنديش الإذن باش نستعمل الكاميرا. اسمح بيها من إعدادات المتصفح وعاود.",
    "not-found": "ما لقيتش كاميرا في الجهاز هذا.",
    busy: "الكاميرا مستعملة في برنامج آخر. سكّرو وعاود.",
    insecure: "الكاميرا تحتاج رابط آمن https.",
    unsupported: "المتصفح هذا ما يدعمش الكاميرا.",
    unknown: "ما نجمتش نشعّل الكاميرا. عاود جرّب.",
  },
  ar: {
    denied: "ليس لدي إذن لاستعمال الكاميرا. اسمح بها من إعدادات المتصفح وأعد المحاولة.",
    "not-found": "لم أجد كاميرا في هذا الجهاز.",
    busy: "الكاميرا مستعملة في برنامج آخر. أغلقه وأعد المحاولة.",
    insecure: "الكاميرا تحتاج إلى رابط آمن https.",
    unsupported: "هذا المتصفح لا يدعم الكاميرا.",
    unknown: "لم أستطع تشغيل الكاميرا. أعد المحاولة.",
  },
  fr: {
    denied: "Je n'ai pas l'autorisation d'utiliser la caméra. Autorisez-la dans les réglages du navigateur et réessayez.",
    "not-found": "Aucune caméra trouvée sur cet appareil.",
    busy: "La caméra est utilisée par une autre application. Fermez-la et réessayez.",
    insecure: "La caméra a besoin d'une adresse sécurisée en https.",
    unsupported: "Ce navigateur ne prend pas en charge la caméra.",
    unknown: "Je n'ai pas pu allumer la caméra. Réessayez.",
  },
  en: {
    denied: "I don't have permission to use the camera. Allow it in your browser settings and try again.",
    "not-found": "No camera was found on this device.",
    busy: "The camera is being used by another app. Close it and try again.",
    insecure: "The camera needs a secure https address.",
    unsupported: "This browser doesn't support the camera.",
    unknown: "I couldn't start the camera. Try again.",
  },
};

export const cameraErrorText = (lang: SpeechLang, code: string): string => {
  const table = CAMERA_ERROR_TEXT[lang] ?? CAMERA_ERROR_TEXT.tn;
  return table[code as CameraErrorCode] ?? table.unknown;
};

/** Tunisian, the default. */
export const CAMERA_ERRORS: Record<string, string> = CAMERA_ERROR_TEXT.tn;

// --- warnings ------------------------------------------------------------------------------------

const FEMININE = new Set(["كرهبة", "بسكلات", "دراجة", "موتو", "شاحنة", "حافلة", "سيارة", "حاجة", "طاولة"]);
const isFeminine = (label: string) => FEMININE.has(label) || label.endsWith("ة");

const DEFAULT_LABEL: Record<SpeechLang, Record<Hazard["kind"], string>> = {
  tn: { stairs: "درج", drop: "تبديل في مستوى القاعة", vehicle: "كرهبة", person: "شخص", obstacle: "حاجة" },
  ar: { stairs: "درج", drop: "تغيّر في مستوى الأرض", vehicle: "سيارة", person: "شخص", obstacle: "عائق" },
  fr: { stairs: "un escalier", drop: "un changement de niveau du sol", vehicle: "un véhicule", person: "une personne", obstacle: "un obstacle" },
  en: { stairs: "a staircase", drop: "a change in floor level", vehicle: "a vehicle", person: "a person", obstacle: "an obstacle" },
};

const WHERE: Record<SpeechLang, Record<Side, string>> = {
  tn: { left: "على يسارك", right: "على يمينك", center: "قدّامك", unknown: "قريب منك" },
  ar: { left: "على يسارك", right: "على يمينك", center: "أمامك", unknown: "بالقرب منك" },
  fr: { left: "à votre gauche", right: "à votre droite", center: "devant vous", unknown: "près de vous" },
  en: { left: "on your left", right: "on your right", center: "ahead of you", unknown: "near you" },
};

const FROM: Record<SpeechLang, Record<Side, string>> = {
  tn: { left: "من اليسار", right: "من اليمين", center: "قدّامك", unknown: "" },
  ar: { left: "من اليسار", right: "من اليمين", center: "من الأمام", unknown: "" },
  fr: { left: "par la gauche", right: "par la droite", center: "par devant", unknown: "" },
  en: { left: "from the left", right: "from the right", center: "from ahead", unknown: "" },
};

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const end = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.,]?$/, ".");

/** The sentence for one hazard. Its wording states how sure we are. */
export function warningPhrase(h: Hazard, lang: SpeechLang = "tn"): string {
  const name = h.label || DEFAULT_LABEL[lang][h.kind];
  const where = WHERE[lang][h.side];
  const from = FROM[lang][h.side];
  const likely = h.confidence === "likely";
  const coming = h.motion === "approaching" && (h.kind === "vehicle" || h.kind === "person");
  const nearVehicle = h.kind === "vehicle" && h.proximity === "near";

  switch (lang) {
    case "tn": {
      if (h.confidence === "uncertain") return `يظهرلي فمّا ${name} ${where}، أما موش متأكّد.`;
      const hedge = likely ? "يظهرلي " : "";
      if (coming) {
        const verb = isFeminine(name) ? "جاية" : "جاي";
        const opener = h.kind === "vehicle" ? "رد بالك، " : "";
        return end(`${opener}${hedge}فمّا ${name} ${verb} لجيهتك ${from}`);
      }
      if (nearVehicle) return end(`رد بالك، ${hedge}${name} ${isFeminine(name) ? "قريبة" : "قريب"} منك ${from}`);
      if (h.kind === "person") return `${hedge}فمّا ${name} ${where}.`;
      return `رد بالك، ${hedge}فمّا ${name} ${where}.`;
    }
    case "ar": {
      if (h.confidence === "uncertain") return `يبدو أن هناك ${name} ${where}، لكنني لست متأكّدًا.`;
      const hedge = likely ? "يبدو أن " : "";
      if (coming) {
        const verb = isFeminine(name) ? "تقترب" : "يقترب";
        const opener = h.kind === "vehicle" ? "انتبه، " : "";
        return end(`${opener}${hedge}${likely ? "" : "هناك "}${name} ${verb} نحوك ${from}`);
      }
      if (nearVehicle) return end(`انتبه، ${hedge}${name} ${isFeminine(name) ? "قريبة" : "قريب"} منك ${from}`);
      const there = likely ? "يبدو أن هناك" : "هناك";
      if (h.kind === "person") return `${there} ${name} ${where}.`;
      return `انتبه، ${there} ${name} ${where}.`;
    }
    case "fr": {
      if (h.confidence === "uncertain") return `Il y a peut-être ${name} ${where}, mais je n'en suis pas sûr.`;
      // "semble" avoids elision ("qu'une") and the subjunctive with labels the model chose.
      if (coming) {
        const opener = h.kind === "vehicle" ? "Attention, " : "";
        return end(capitalize(`${opener}${name} ${likely ? "semble arriver" : "arrive"} vers vous ${from}`));
      }
      if (nearVehicle) return end(`Attention, ${name} ${likely ? "semble être" : "est"} près de vous, ${where}`);
      const there = likely ? "il semble y avoir" : "il y a";
      if (h.kind === "person") return `${capitalize(there)} ${name} ${where}.`;
      return `Attention, ${there} ${name} ${where}.`;
    }
    case "en": {
      if (h.confidence === "uncertain") return `There may be ${name} ${where}, but I'm not sure.`;
      const there = likely ? "there seems to be" : "there's";
      if (coming) {
        const opener = h.kind === "vehicle" ? "Careful, " : "";
        const subject = likely ? `${opener}${name} seems to be` : `${opener}${name} is`;
        return end(capitalize(`${subject} coming toward you ${from}`));
      }
      if (nearVehicle) return end(`Careful, ${name} ${likely ? "seems to be" : "is"} close to you, ${where}`);
      if (h.kind === "person") return `${capitalize(there)} ${name} ${where}.`;
      return `Careful, ${there} ${name} ${where}.`;
    }
  }
}

/** Names for the on-device detector's classes. */
export const LOCAL_LABELS: Record<string, Record<SpeechLang, string>> = {
  person: { tn: "شخص", ar: "شخص", fr: "une personne", en: "a person" },
  car: { tn: "كرهبة", ar: "سيارة", fr: "une voiture", en: "a car" },
  motorcycle: { tn: "موتور", ar: "دراجة نارية", fr: "une moto", en: "a motorcycle" },
  bicycle: { tn: "بسكلات", ar: "دراجة", fr: "un vélo", en: "a bicycle" },
  bus: { tn: "كار", ar: "حافلة", fr: "un bus", en: "a bus" },
  truck: { tn: "كميون", ar: "شاحنة", fr: "un camion", en: "a truck" },
  train: { tn: "تران", ar: "قطار", fr: "un train", en: "a train" },
  chair: { tn: "كرسي", ar: "كرسي", fr: "une chaise", en: "a chair" },
  bench: { tn: "بنك", ar: "مقعد", fr: "un banc", en: "a bench" },
  couch: { tn: "فوتاي", ar: "أريكة", fr: "un canapé", en: "a sofa" },
  "dining table": { tn: "طاولة", ar: "طاولة", fr: "une table", en: "a table" },
  "potted plant": { tn: "نبتة", ar: "نبتة", fr: "une plante", en: "a plant" },
  suitcase: { tn: "فاليجة", ar: "حقيبة سفر", fr: "une valise", en: "a suitcase" },
  "fire hydrant": { tn: "حنفية حريق", ar: "صنبور إطفاء", fr: "une bouche d'incendie", en: "a fire hydrant" },
};
