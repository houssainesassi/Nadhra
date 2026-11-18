// Everything the app itself says about location and walking directions, in each speech language.
// Directions are built here from the routing engine's manoeuvres, never by the AI model, so a turn
// is only ever announced when the route really has one. Tunisian is the reference.
// Rules for every sentence: distances are always "about" (GPS and maps are approximate), nothing
// promises that a way is safe or clear, and the cane, dog or a person stays the user's guarantee.
import { roundDistance, roundMinutes } from "./math.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { RouteStep } from "./types.ts";

type Modifier = "uturn" | "sharp right" | "right" | "slight right" | "straight" | "slight left" | "left" | "sharp left";

interface GeoPhrases {
  metres: (m: number) => string;
  minutes: (s: number) => string;
  turn: Record<Modifier, string>;
  depart: (street: string) => string;
  departUnnamed: string;
  continueOn: (street: string) => string;
  continueStraight: string;
  endOfRoad: (turn: string) => string;
  fork: (side: string) => string;
  roundabout: (exit: number | null) => string;
  onto: (turn: string, street: string) => string;
  arriveSide: Record<"left" | "right" | "straight", string>;
  /** «بعد حوالي 50 متر، …» */
  inDistance: (metres: string, action: string) => string;
  /** At the turn, GPS good enough. */
  now: (action: string) => string;
  /** At the turn, GPS not precise enough to say exactly where. */
  nearApprox: (action: string) => string;
  /** After a turn, a long stretch follows. */
  keepGoing: (metres: string) => string;
  destinationAhead: (name: string, metres: string) => string;

  // --- the app's own sentences ---------------------------------------------------------------------
  /** The location notice: said, and shown, before any position is used. */
  consentNotice: string;
  consentGiven: string;
  consentRefused: string;
  locating: string;
  /** A tool takes a few seconds (a map service is slow): said so the wait isn't silent. */
  searching: string;
  denied: string;
  unavailable: string;
  timeout: string;
  unsupported: string;
  serviceDown: string;
  notFound: string;
  routeStart: (dest: string, distance: string, time: string, first: string) => string;
  routeFailed: string;
  tooFar: string;
  offRoute: string;
  rerouted: (first: string) => string;
  rerouteFailed: string;
  wrongWay: string;
  gpsWeak: string;
  gpsBack: string;
  signalLost: string;
  signalBack: string;
  arrived: (dest: string) => string;
  stopped: string;
  trackingStopped: string;
  noNavigation: string;
  unnamed: string;
  navReminder: string;
  /** Said by the app itself when the user pressed a button (in a conversation the AI says it). */
  youAreAt: (address: string) => string;
  /** A named place at that address: "near" it, never "in" it (GPS can't tell). */
  near: (name: string) => string;
  approximate: (metres: string) => string;
  noAddress: string;
  nearest: (name: string, distance: string) => string;
  found: (n: number) => string;
  routeReady: (dest: string, distance: string, time: string) => string;
}

const tnMetres = (m: number) => {
  const r = roundDistance(m);
  return r >= 1000 ? `حوالي ${(r / 1000).toLocaleString("en", { maximumFractionDigits: 1 })} كيلومتر` : `حوالي ${r} متر`;
};

const TN: GeoPhrases = {
  metres: tnMetres,
  minutes: (s) => {
    const m = roundMinutes(s);
    return m === 1 ? "حوالي دقيقة" : m === 2 ? "حوالي دقيقتين" : `حوالي ${m} دقايق`;
  },
  turn: {
    uturn: "ارجع على تاليك",
    "sharp right": "دور برشا على يمينك",
    right: "دور على يمينك",
    "slight right": "ميل شويّة على يمينك",
    straight: "كمّل دوغري",
    "slight left": "ميل شويّة على يسارك",
    left: "دور على يسارك",
    "sharp left": "دور برشا على يسارك",
  },
  depart: (st) => `ابدا امشي في ${st}`,
  departUnnamed: "ابدا امشي",
  continueOn: (st) => `كمّل في ${st}`,
  continueStraight: "كمّل دوغري",
  endOfRoad: (t) => `في آخر الثنية، ${t}`,
  fork: (side) => `وين تتفرّق الثنية، خوذ ${side}`,
  roundabout: (n) => (n ? `في الرّون بوان، اخرج من المخرج رقم ${n}` : "في الرّون بوان، دور معاه واخرج"),
  onto: (t, st) => `${t} في ${st}`,
  arriveSide: { left: "على يسارك", right: "على يمينك", straight: "قدّامك" },
  inDistance: (d, a) => `بعد ${d}، ${a}.`,
  now: (a) => `توّا، ${a}.`,
  nearApprox: (a) => `قرّبت، ${a}. الـGPS موش دقيق توّا، ثبّت بالعصا ولا اسأل حد.`,
  keepGoing: (d) => `كمّل ${d}.`,
  destinationAhead: (n, d) => `${n} بعد ${d}.`,
  consentNotice:
    "باش نعرف وين إنت ونلقالك البلايص اللي قريبة ونمشّيك ليها، نحتاج بلاصتك. البلاصة تتعدّى على سيرفر نظرة لخدمات خرائط OpenStreetMap، وأسماء البلايص والمسافات تتبعث لجيميني باش يجاوبك. ما تتسجّلش. التلفون باش يسألك زادا. إذا موافق، قول «موافق».",
  consentGiven: "باهي. نلوّج على بلاصتك.",
  consentRefused: "باهي، ما نستعملش بلاصتك.",
  locating: "نلوّج على بلاصتك.",
  searching: "نلوّج في الخريطة، لحظة.",
  denied: "ما عنديش الإذن باش نعرف بلاصتك. تنجّم تعطيه من إعدادات المتصفح، في إذن الموقع.",
  unavailable: "ما نجّمتش نلقى بلاصتك توّا. ثبّت إلي الـGPS شاعل، وإذا إنت داخل بناية، جرّب قريب من باب ولا شبّاك.",
  timeout: "الـGPS طوّل برشا وما جاوبش. عاود بعد شويّة.",
  unsupported: "المتصفح هذا ما يعطيش البلاصة.",
  serviceDown: "خدمة الخرائط ما جاوبتش توّا. عاود بعد شويّة.",
  notFound: "ما لقيت حتى بلاصة من هالنوع قريب منك على الخريطة. الخريطة تنجّم تكون ناقصة.",
  routeStart: (dest, d, t, first) => `نبداو. ${dest}، ${d} على ساقيك، ${t}. ${first} ما نجّمش نضمن إلي الثنية آمنة: ثبّت بالعصا ولا بالكلب.`,
  routeFailed: "ما نجّمتش نحسب طريق على ساقيك لهالبلاصة.",
  tooFar: "البلاصة هاذي بعيدة برشا باش تمشيلها على ساقيك.",
  offRoute: "يظهرلي خرجت من الطريق. نحسب طريق جديد.",
  rerouted: (first) => `لقيت طريق جديد. ${first}`,
  rerouteFailed: "ما نجّمتش نحسب طريق جديد. وقّف ولا اسأل حد، ونعاود نجرّب بعد شويّة.",
  wrongWay: "يظهرلي ماشي في العكس. ارجع على تاليك.",
  gpsWeak: "الـGPS موش دقيق توّا. نوقّف التعليمات الدقيقة حتى يرجع.",
  gpsBack: "الـGPS رجع دقيق.",
  signalLost: "ضاع الـGPS. التعليمات واقفة حتى يرجع. ما تمشيش برشا وحدك في هالوقت.",
  signalBack: "الـGPS رجع. نكمّلو.",
  arrived: (dest) => `وصلت تقريباً لـ${dest}. الخريطة والـGPS تقريبيّين: ثبّت بالعصا ولا اسأل حد.`,
  stopped: "وقّفت التوجيه.",
  trackingStopped: "وقّفت استعمال بلاصتك.",
  noNavigation: "ما فمّا حتى توجيه شاعل.",
  unnamed: "بلاصة ما عندهاش اسم على الخريطة",
  navReminder: "التوجيه مازال شاعل. قول «وقّف التوجيه» باش توقّفو.",
  youAreAt: (a) => `إنت في ${a}.`,
  near: (n) => `قريب من ${n}`,
  approximate: (d) => `البلاصة تقريبية، بفرق ${d}.`,
  noAddress: "ما لقيتش عنوان لهالبلاصة على الخريطة.",
  nearest: (n, d) => `الأقرب: ${n}، ${d} في خط مستقيم.`,
  found: (n) => (n === 1 ? "لقيت بلاصة وحدة." : `لقيت ${n} بلايص.`),
  routeReady: (dest, d, t) => `${dest}: ${d} على ساقيك، ${t}. اضغط «ابدا التوجيه» باش نبداو.`,
};

const arMetres = (m: number) => {
  const r = roundDistance(m);
  return r >= 1000 ? `حوالي ${(r / 1000).toLocaleString("en", { maximumFractionDigits: 1 })} كيلومتر` : `حوالي ${r} متر`;
};

const AR: GeoPhrases = {
  metres: arMetres,
  minutes: (s) => {
    const m = roundMinutes(s);
    return m === 1 ? "حوالي دقيقة" : m === 2 ? "حوالي دقيقتين" : `حوالي ${m} دقائق`;
  },
  turn: {
    uturn: "عُد إلى الخلف",
    "sharp right": "انعطف بحدّة إلى اليمين",
    right: "انعطف إلى اليمين",
    "slight right": "انحرف قليلًا إلى اليمين",
    straight: "استمر إلى الأمام",
    "slight left": "انحرف قليلًا إلى اليسار",
    left: "انعطف إلى اليسار",
    "sharp left": "انعطف بحدّة إلى اليسار",
  },
  depart: (st) => `ابدأ السير في ${st}`,
  departUnnamed: "ابدأ السير",
  continueOn: (st) => `استمر في ${st}`,
  continueStraight: "استمر إلى الأمام",
  endOfRoad: (t) => `في نهاية الطريق، ${t}`,
  fork: (side) => `عند التفرع، خذ ${side}`,
  roundabout: (n) => (n ? `عند الدوّار، اخرج من المخرج رقم ${n}` : "عند الدوّار، دُر معه ثم اخرج"),
  onto: (t, st) => `${t} في ${st}`,
  arriveSide: { left: "على يسارك", right: "على يمينك", straight: "أمامك" },
  inDistance: (d, a) => `بعد ${d}، ${a}.`,
  now: (a) => `الآن، ${a}.`,
  nearApprox: (a) => `اقتربت، ${a}. نظام تحديد الموقع غير دقيق الآن، تأكّد بالعصا أو اسأل أحدًا.`,
  keepGoing: (d) => `استمر ${d}.`,
  destinationAhead: (n, d) => `${n} بعد ${d}.`,
  consentNotice:
    "لأعرف أين أنت وأجد الأماكن القريبة وأرشدك إليها، أحتاج إلى موقعك. يمرّ الموقع عبر خادم نظرة إلى خدمات خرائط OpenStreetMap، وتُرسَل أسماء الأماكن والمسافات إلى جيميني ليجيبك. لا يُحفَظ. سيطلب الهاتف إذنك أيضًا. إذا كنت موافقًا، قل «موافق».",
  consentGiven: "حسنًا. أبحث عن موقعك.",
  consentRefused: "حسنًا، لن أستعمل موقعك.",
  locating: "أبحث عن موقعك.",
  searching: "أبحث في الخريطة، لحظة.",
  denied: "ليس لديّ إذن لمعرفة موقعك. يمكنك منحه من إعدادات المتصفح، في إذن الموقع.",
  unavailable: "لم أستطع تحديد موقعك الآن. تأكّد أن نظام تحديد الموقع مفعّل، وإن كنت داخل مبنى فجرّب قرب باب أو نافذة.",
  timeout: "استغرق نظام تحديد الموقع وقتًا طويلًا دون إجابة. حاول بعد قليل.",
  unsupported: "هذا المتصفح لا يوفّر الموقع.",
  serviceDown: "خدمة الخرائط لم تُجب الآن. حاول بعد قليل.",
  notFound: "لم أجد مكانًا من هذا النوع قريبًا منك على الخريطة. قد تكون الخريطة ناقصة.",
  routeStart: (dest, d, t, first) => `لنبدأ. ${dest}، ${d} سيرًا، ${t}. ${first} لا أستطيع ضمان أن الطريق آمن: اعتمد على العصا أو الكلب.`,
  routeFailed: "لم أستطع حساب طريق سيرًا إلى هذا المكان.",
  tooFar: "هذا المكان بعيد جدًا للذهاب إليه سيرًا.",
  offRoute: "يبدو أنك خرجت عن الطريق. أحسب طريقًا جديدًا.",
  rerouted: (first) => `وجدت طريقًا جديدًا. ${first}`,
  rerouteFailed: "لم أستطع حساب طريق جديد. توقّف أو اسأل أحدًا، وسأحاول مجددًا بعد قليل.",
  wrongWay: "يبدو أنك تسير في الاتجاه المعاكس. عُد إلى الخلف.",
  gpsWeak: "نظام تحديد الموقع غير دقيق الآن. أوقفت التعليمات الدقيقة حتى يعود.",
  gpsBack: "عاد نظام تحديد الموقع دقيقًا.",
  signalLost: "فُقدت إشارة تحديد الموقع. التعليمات متوقفة حتى تعود. لا تبتعد كثيرًا وحدك في هذه الأثناء.",
  signalBack: "عادت الإشارة. نتابع.",
  arrived: (dest) => `وصلت تقريبًا إلى ${dest}. الخريطة والموقع تقريبيان: تأكّد بالعصا أو اسأل أحدًا.`,
  stopped: "أوقفت الإرشاد.",
  trackingStopped: "أوقفت استعمال موقعك.",
  noNavigation: "لا يوجد إرشاد قيد التشغيل.",
  unnamed: "مكان بلا اسم على الخريطة",
  navReminder: "الإرشاد ما زال يعمل. قل «أوقف الإرشاد» لإيقافه.",
  youAreAt: (a) => `أنت في ${a}.`,
  near: (n) => `قرب ${n}`,
  approximate: (d) => `الموقع تقريبي، بهامش ${d}.`,
  noAddress: "لم أجد عنوانًا لهذا الموقع على الخريطة.",
  nearest: (n, d) => `الأقرب: ${n}، ${d} في خط مستقيم.`,
  found: (n) => (n === 1 ? "وجدت مكانًا واحدًا." : `وجدت ${n} أماكن.`),
  routeReady: (dest, d, t) => `${dest}: ${d} سيرًا، ${t}. اضغط «ابدأ الإرشاد» لنبدأ.`,
};

const frMetres = (m: number) => {
  const r = roundDistance(m);
  return r >= 1000 ? `environ ${(r / 1000).toLocaleString("fr", { maximumFractionDigits: 1 })} kilomètre${r >= 2000 ? "s" : ""}` : `environ ${r} mètres`;
};

const FR: GeoPhrases = {
  metres: frMetres,
  minutes: (s) => {
    const m = roundMinutes(s);
    return `environ ${m} minute${m > 1 ? "s" : ""}`;
  },
  turn: {
    uturn: "faites demi-tour",
    "sharp right": "tournez franchement à droite",
    right: "tournez à droite",
    "slight right": "serrez légèrement à droite",
    straight: "continuez tout droit",
    "slight left": "serrez légèrement à gauche",
    left: "tournez à gauche",
    "sharp left": "tournez franchement à gauche",
  },
  depart: (st) => `Commencez à marcher sur ${st}`,
  departUnnamed: "Commencez à marcher",
  continueOn: (st) => `continuez sur ${st}`,
  continueStraight: "continuez tout droit",
  endOfRoad: (t) => `au bout de la rue, ${t}`,
  fork: (side) => `à l'embranchement, prenez ${side}`,
  roundabout: (n) => (n ? `au rond-point, prenez la sortie numéro ${n}` : "au rond-point, suivez-le puis sortez"),
  onto: (t, st) => `${t} sur ${st}`,
  arriveSide: { left: "sur votre gauche", right: "sur votre droite", straight: "devant vous" },
  inDistance: (d, a) => `Dans ${d}, ${a}.`,
  now: (a) => `Maintenant, ${a}.`,
  nearApprox: (a) => `Vous approchez : ${a}. Le GPS n'est pas précis en ce moment, vérifiez avec votre canne ou demandez à quelqu'un.`,
  keepGoing: (d) => `Continuez ${d}.`,
  destinationAhead: (n, d) => `${n} dans ${d}.`,
  consentNotice:
    "Pour savoir où vous êtes, trouver les lieux proches et vous y guider, j'ai besoin de votre position. Elle passe par le serveur de Nadhra vers les services de cartes OpenStreetMap, et les noms des lieux et les distances sont envoyés à Gemini pour vous répondre. Rien n'est enregistré. Le téléphone vous demandera aussi l'autorisation. Si vous êtes d'accord, dites « j'accepte ».",
  consentGiven: "D'accord. Je cherche votre position.",
  consentRefused: "D'accord, je n'utilise pas votre position.",
  locating: "Je cherche votre position.",
  searching: "Je cherche sur la carte, un instant.",
  denied: "Je n'ai pas l'autorisation de connaître votre position. Vous pouvez la donner dans les réglages du navigateur, à l'autorisation de localisation.",
  unavailable: "Je n'ai pas pu trouver votre position. Vérifiez que le GPS est activé ; dans un bâtiment, essayez près d'une porte ou d'une fenêtre.",
  timeout: "Le GPS a mis trop de temps à répondre. Réessayez dans un moment.",
  unsupported: "Ce navigateur ne donne pas la position.",
  serviceDown: "Le service de cartes n'a pas répondu. Réessayez dans un moment.",
  notFound: "Je n'ai trouvé aucun lieu de ce type près de vous sur la carte. La carte peut être incomplète.",
  routeStart: (dest, d, t, first) => `On y va. ${dest} : ${d} à pied, ${t}. ${first} Je ne peux pas garantir que le chemin est sûr : fiez-vous à votre canne ou à votre chien.`,
  routeFailed: "Je n'ai pas pu calculer d'itinéraire à pied vers ce lieu.",
  tooFar: "Ce lieu est trop loin pour y aller à pied.",
  offRoute: "Vous semblez avoir quitté l'itinéraire. Je calcule un nouvel itinéraire.",
  rerouted: (first) => `Nouvel itinéraire trouvé. ${first}`,
  rerouteFailed: "Je n'ai pas pu calculer de nouvel itinéraire. Arrêtez-vous ou demandez à quelqu'un ; je réessaierai dans un moment.",
  wrongWay: "Vous semblez aller dans le mauvais sens. Faites demi-tour.",
  gpsWeak: "Le GPS n'est pas précis en ce moment. Je suspends les indications précises jusqu'à son retour.",
  gpsBack: "Le GPS est de nouveau précis.",
  signalLost: "Signal GPS perdu. Les indications sont suspendues jusqu'à son retour. Ne vous éloignez pas trop seul en attendant.",
  signalBack: "Le GPS est revenu. On continue.",
  arrived: (dest) => `Vous êtes presque arrivé à ${dest}. La carte et le GPS sont approximatifs : vérifiez avec votre canne ou demandez à quelqu'un.`,
  stopped: "Guidage arrêté.",
  trackingStopped: "Je n'utilise plus votre position.",
  noNavigation: "Aucun guidage n'est en cours.",
  unnamed: "un lieu sans nom sur la carte",
  navReminder: "Le guidage est toujours actif. Dites « arrête le guidage » pour l'arrêter.",
  youAreAt: (a) => `Vous êtes ${a.match(/^\d/) ? "au" : "à"} ${a}.`,
  near: (n) => `près de ${n}`,
  approximate: (d) => `Position approximative, à ${d} près.`,
  noAddress: "Je n'ai pas trouvé d'adresse pour cet endroit sur la carte.",
  nearest: (n, d) => `Le plus proche : ${n}, à ${d} à vol d'oiseau.`,
  found: (n) => (n === 1 ? "J'ai trouvé un lieu." : `J'ai trouvé ${n} lieux.`),
  routeReady: (dest, d, t) => `${dest} : ${d} à pied, ${t}. Appuyez sur « Démarrer le guidage » pour commencer.`,
};

const enMetres = (m: number) => {
  const r = roundDistance(m);
  return r >= 1000 ? `about ${(r / 1000).toLocaleString("en", { maximumFractionDigits: 1 })} kilometre${r >= 2000 ? "s" : ""}` : `about ${r} metres`;
};

const EN: GeoPhrases = {
  metres: enMetres,
  minutes: (s) => {
    const m = roundMinutes(s);
    return `about ${m} minute${m > 1 ? "s" : ""}`;
  },
  turn: {
    uturn: "turn around",
    "sharp right": "turn sharply right",
    right: "turn right",
    "slight right": "bear right",
    straight: "continue straight on",
    "slight left": "bear left",
    left: "turn left",
    "sharp left": "turn sharply left",
  },
  depart: (st) => `Start walking along ${st}`,
  departUnnamed: "Start walking",
  continueOn: (st) => `continue along ${st}`,
  continueStraight: "continue straight on",
  endOfRoad: (t) => `at the end of the street, ${t}`,
  fork: (side) => `where the way splits, take the ${side}`,
  roundabout: (n) => (n ? `at the roundabout, take exit number ${n}` : "at the roundabout, follow it round and leave it"),
  onto: (t, st) => `${t} onto ${st}`,
  arriveSide: { left: "on your left", right: "on your right", straight: "ahead of you" },
  inDistance: (d, a) => `In ${d}, ${a}.`,
  now: (a) => `Now, ${a}.`,
  nearApprox: (a) => `You are getting close: ${a}. GPS isn't precise right now, so check with your cane or ask someone.`,
  keepGoing: (d) => `Keep going for ${d}.`,
  destinationAhead: (n, d) => `${n} in ${d}.`,
  consentNotice:
    "To know where you are, find places nearby and guide you there, I need your location. It goes through Nadhra's server to the OpenStreetMap map services, and place names and distances are sent to Gemini to answer you. Nothing is stored. Your phone will also ask for permission. If you agree, say “I agree”.",
  consentGiven: "OK. Finding your location.",
  consentRefused: "OK, I won't use your location.",
  locating: "Finding your location.",
  searching: "Searching the map, one moment.",
  denied: "I don't have permission to know your location. You can allow it in your browser's settings, under location permission.",
  unavailable: "I couldn't find your location. Check that GPS is on; inside a building, try near a door or window.",
  timeout: "GPS took too long to answer. Try again in a moment.",
  unsupported: "This browser doesn't provide a location.",
  serviceDown: "The map service didn't answer. Try again in a moment.",
  notFound: "I found no place of that kind near you on the map. The map can be incomplete.",
  routeStart: (dest, d, t, first) => `Let's go. ${dest}: ${d} on foot, ${t}. ${first} I can't guarantee the way is safe: rely on your cane or dog.`,
  routeFailed: "I couldn't work out a walking route to that place.",
  tooFar: "That place is too far to walk to.",
  offRoute: "You seem to have left the route. Working out a new one.",
  rerouted: (first) => `New route found. ${first}`,
  rerouteFailed: "I couldn't work out a new route. Stop or ask someone; I'll try again in a moment.",
  wrongWay: "You seem to be going the wrong way. Turn around.",
  gpsWeak: "GPS isn't precise right now. Precise directions are paused until it is.",
  gpsBack: "GPS is precise again.",
  signalLost: "GPS signal lost. Directions are paused until it comes back. Don't go far on your own meanwhile.",
  signalBack: "GPS is back. Let's continue.",
  arrived: (dest) => `You have almost arrived at ${dest}. The map and GPS are approximate: check with your cane or ask someone.`,
  stopped: "Navigation stopped.",
  trackingStopped: "I've stopped using your location.",
  noNavigation: "No navigation is running.",
  unnamed: "a place with no name on the map",
  navReminder: "Navigation is still on. Say “stop navigation” to end it.",
  youAreAt: (a) => `You are at ${a}.`,
  near: (n) => `near ${n}`,
  approximate: (d) => `The position is approximate, to within ${d}.`,
  noAddress: "I found no address for this spot on the map.",
  nearest: (n, d) => `The nearest: ${n}, ${d} in a straight line.`,
  found: (n) => (n === 1 ? "I found one place." : `I found ${n} places.`),
  routeReady: (dest, d, t) => `${dest}: ${d} on foot, ${t}. Press “Start navigation” to begin.`,
};

export const GEO_PHRASES: Record<SpeechLang, GeoPhrases> = { tn: TN, ar: AR, fr: FR, en: EN };
export const geoSpeech = (lang: SpeechLang): GeoPhrases => GEO_PHRASES[lang] ?? TN;

const MODIFIERS = new Set<string>(["uturn", "sharp right", "right", "slight right", "straight", "slight left", "left", "sharp left"]);
const mod = (m: string | null): Modifier => (m && MODIFIERS.has(m) ? (m as Modifier) : "straight");

/** The words of one manoeuvre ("turn right onto Rue de Rome"), without timing. Null for "arrive". */
export function stepAction(step: RouteStep, lang: SpeechLang): string | null {
  const p = geoSpeech(lang);
  const turn = p.turn[mod(step.modifier)];
  const st = step.name.trim();
  switch (step.type) {
    case "depart":
      return st ? p.depart(st) : p.departUnnamed;
    case "arrive":
      return null;
    case "continue":
    case "new name":
    case "notification":
      return mod(step.modifier) === "straight" ? (st ? p.continueOn(st) : p.continueStraight) : st ? p.onto(turn, st) : turn;
    case "end of road":
      return p.endOfRoad(st ? p.onto(turn, st) : turn);
    case "fork": {
      const side = step.modifier?.includes("left") ? p.turn.left : step.modifier?.includes("right") ? p.turn.right : p.turn.straight;
      // Only the side word: «خوذ اليمين» reads better than a full turn sentence.
      const word = lang === "tn" ? (side === p.turn.left ? "اليسار" : side === p.turn.right ? "اليمين" : "اللي قدّامك")
        : lang === "ar" ? (side === p.turn.left ? "اليسار" : side === p.turn.right ? "اليمين" : "الأمام")
        : lang === "fr" ? (side === p.turn.left ? "à gauche" : side === p.turn.right ? "à droite" : "tout droit")
        : side === p.turn.left ? "left" : side === p.turn.right ? "right" : "middle";
      return p.fork(word);
    }
    case "roundabout":
    case "rotary":
    case "roundabout turn":
      return p.roundabout(step.exit);
    case "exit roundabout":
    case "exit rotary":
      return st ? p.continueOn(st) : p.continueStraight;
    default:
      // turn, merge, on ramp, off ramp, use lane…: the direction is what matters on foot.
      return st ? p.onto(turn, st) : turn;
  }
}

/** Where the destination is when the user arrives («على يمينك»), from the arrive step's modifier. */
export function arriveSide(step: RouteStep | undefined, lang: SpeechLang): string | null {
  const m = step?.modifier;
  if (!m) return null;
  const p = geoSpeech(lang);
  return m.includes("left") ? p.arriveSide.left : m.includes("right") ? p.arriveSide.right : m === "straight" ? p.arriveSide.straight : null;
}

/** First letter up, for a sentence that starts with an action ("turn right" → "Turn right"). */
export const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
