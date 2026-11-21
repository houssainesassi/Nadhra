// AI Language Coach: practising a language by talking with Nadhra in the live conversation.
// Pure data and text, shared by the server (which locks the coach section and its tools into the
// live token, see liveToken.ts) and the browser (which runs the tools and shows the feedback).
//
// The practice language is never a setting: the user says it in the conversation («Let's practise
// English»), and the model reports it with set_practice_language. Corrections and new words come
// back through show_learning_feedback, so the phone can show them in their own panel while the
// model says them aloud.

export const COACH_MODES = ["free", "corrections", "vocabulary", "speaking"] as const;
export type CoachMode = (typeof COACH_MODES)[number];
export const isCoachMode = (v: unknown): v is CoachMode => typeof v === "string" && (COACH_MODES as readonly string[]).includes(v);

export const COACH_MODE_LABELS: Record<CoachMode, string> = {
  free: "Free conversation",
  corrections: "Conversation + corrections",
  vocabulary: "Vocabulary builder",
  speaking: "Speaking practice",
};

/** What the token needs to know about the coach: locked into the live session's instructions. */
export interface LiveCoachOptions {
  mode: CoachMode;
  /** The language practised last time, if any (an English name, from set_practice_language). */
  language?: string;
  /** The user's own language name, for the first question before they choose. */
  userLanguage?: string;
}

/** A language name as the model or a request gives it: letters, spaces and hyphens, short. "" if unusable. */
export function cleanLanguageName(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.normalize("NFC").replace(/[^\p{L}\s()-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 30);
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** The coach options from a request body, validated. Null when the coach is off or the body is wrong. */
export function parseCoachOptions(raw: unknown): LiveCoachOptions | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isCoachMode(r.mode)) return null;
  const language = cleanLanguageName(r.language);
  const userLanguage = cleanLanguageName(r.userLanguage);
  return { mode: r.mode, ...(language ? { language } : {}), ...(userLanguage ? { userLanguage } : {}) };
}

// --- tools -----------------------------------------------------------------------------------------

export const COACH_TOOL_NAMES = ["set_practice_language", "set_practice_mode", "show_learning_feedback"] as const;
export type CoachToolName = (typeof COACH_TOOL_NAMES)[number];
export const isCoachTool = (n: unknown): n is CoachToolName => typeof n === "string" && (COACH_TOOL_NAMES as readonly string[]).includes(n);

export const FEEDBACK_KINDS = ["correction", "vocabulary", "expression"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** Gemini function declarations (OpenAPI subset). */
export const COACH_FUNCTION_DECLARATIONS = [
  {
    name: "set_practice_language",
    description: "Records the language the user wants to practise, as soon as they say it (or change it). Use the language's English name.",
    parameters: {
      type: "OBJECT",
      properties: { language: { type: "STRING", description: "English name of the language, e.g. English, French, German, Italian, Spanish, Tunisian Arabic." } },
      required: ["language"],
    },
  },
  {
    name: "set_practice_mode",
    description: "Switches the practice mode when the user asks for a different kind of practice.",
    parameters: {
      type: "OBJECT",
      properties: { mode: { type: "STRING", enum: [...COACH_MODES], description: "free, corrections, vocabulary or speaking." } },
      required: ["mode"],
    },
  },
  {
    name: "show_learning_feedback",
    description: "Shows one correction, new word or better expression on the user's screen, exactly as you say it aloud. One call per item.",
    parameters: {
      type: "OBJECT",
      properties: {
        kind: { type: "STRING", enum: [...FEEDBACK_KINDS], description: "correction: a mistake the user made. vocabulary: a new word. expression: a more natural way to say something." },
        your_sentence: { type: "STRING", description: "correction/expression: what the user said, word for word." },
        correct_sentence: { type: "STRING", description: "correction: the corrected sentence." },
        explanation: { type: "STRING", description: "Why, in one short sentence." },
        new_expression: { type: "STRING", description: "Optional: a more natural expression a native speaker would use." },
        word: { type: "STRING", description: "vocabulary: the new word or expression." },
        meaning: { type: "STRING", description: "vocabulary: what it means, simply." },
        example: { type: "STRING", description: "vocabulary: a short example sentence." },
      },
      required: ["kind"],
    },
  },
] as const;

export interface FeedbackItem {
  id: number;
  kind: FeedbackKind;
  yourSentence?: string;
  correctSentence?: string;
  explanation?: string;
  newExpression?: string;
  word?: string;
  meaning?: string;
  example?: string;
  /** The practice language at the time. */
  language?: string;
}

const text = (v: unknown, max = 300) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** show_learning_feedback's arguments as a feedback item, or null when there is nothing to show. */
export function feedbackFromArgs(args: unknown, id: number, language?: string): FeedbackItem | null {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const kind: FeedbackKind = (FEEDBACK_KINDS as readonly string[]).includes(a.kind as string) ? (a.kind as FeedbackKind) : a.word ? "vocabulary" : "correction";
  const item: FeedbackItem = { id, kind };
  const fields = [
    ["yourSentence", a.your_sentence],
    ["correctSentence", a.correct_sentence],
    ["explanation", a.explanation],
    ["newExpression", a.new_expression],
    ["word", a.word],
    ["meaning", a.meaning],
    ["example", a.example],
  ] as const;
  for (const [k, v] of fields) {
    const t = text(v);
    if (t) item[k] = t;
  }
  if (language) item.language = language;
  const useful = kind === "vocabulary" ? !!item.word : !!(item.correctSentence || item.newExpression);
  return useful ? item : null;
}

/** Kept on screen: the newest first, at most this many. */
export const MAX_FEEDBACK_ITEMS = 12;

// --- instructions ----------------------------------------------------------------------------------

const MODE_RULES: Record<CoachMode, string> = {
  free: "Free conversation: keep the talk flowing and enjoyable. Correct only a mistake that really blocks understanding, and rarely. Don't teach unless asked.",
  corrections: "Conversation + corrections: after a user turn with a real grammar, vocabulary or sentence-structure mistake, give one (at most two) correction, then carry on the conversation. Don't correct every small slip, and don't correct the same thing twice unless it keeps coming back.",
  vocabulary: "Vocabulary builder: in most turns, bring in one or two useful new words or expressions linked to the topic, with a short example, and invite the user to use them. Correct only mistakes that matter.",
  speaking: "Speaking practice: get the user to speak as much as possible. Ask open questions, ask them to say more, keep your own turns short, notice and praise fluency. Corrections only rarely, for mistakes that come back.",
};

/** The coach's section of the live instructions. It comes last, and overrides the parts it names. */
export function coachPrompt(o: LiveCoachOptions, greeting: string, greetingCue: string): string {
  const own = o.userLanguage ? `the user's own language (${o.userLanguage})` : "the user's own language";
  const first = o.language
    ? `say «${greeting}», then, in ${own}, ask in one short sentence whether they want to go on practising ${o.language} or try another language`
    : `say «${greeting}», then, in ${own}, ask in one short sentence which language they would like to practise today`;
  return `AI LANGUAGE COACH (active now; where it differs, this section overrides HOW TO TALK, LANGUAGE and the greeting rule above)
The user opened the Language Coach: they want to practise and improve a language by talking with you. You are a warm, patient, encouraging native-level coach. Keep it a real, enjoyable conversation, not a lesson.
- Call start: when ${greetingCue} arrives, ${first}. Nothing else.
- Choosing the language: the user says it in their own words ("Let's practise English, I want to improve my speaking", «نحب نتعلّم الطليانية», «on pratique l'allemand»). Call set_practice_language with its English name, then switch to that language and open a natural conversation with one easy, friendly question («Of course! Let's have a natural conversation. How was your day?»). If they change language later, call it again and follow them.
- Once chosen, speak the practice language, even if the user slips back into their own. If they clearly ask in their own language for help (a word they don't know, an explanation), help briefly, then go back to the practice language.
- Level: judge it from how they speak, and adapt: a beginner gets short, slow, simple sentences and common words; an advanced speaker natural speed, idioms and richer vocabulary. Adjust as the conversation goes.
- Here, ending a turn with one short question is good: it keeps the conversation going (this overrides the rule against ending with a question). Two to four short sentences per turn.

MODE (current: ${o.mode})
- ${MODE_RULES[o.mode]}
- If the user asks for another kind of practice, call set_practice_mode and follow the new mode: free (natural conversation, almost no corrections), corrections (conversation with corrections), vocabulary (new words and expressions), speaking (speak more, fluency).
- A message starting with [app] practice-mode comes from the phone, not the user: the user changed the mode in Settings. Follow it from your next turn, without mentioning it.

HOW TO CORRECT AND TEACH
- Notice vocabulary mistakes, grammar mistakes, wrong sentence structure, and phrases a native speaker wouldn't use.
- Say a correction naturally, react to what they said first: "That sounds like a long day! A small correction: you should say 'Today I went to work' instead of 'Today I go to work', because you're talking about the past. What did you do at work?"
- Explain why in one short, simple sentence. Where it helps, offer a more natural expression ("I completely agree with you."). Explanations go in the practice language; for a beginner, or when asked, in ${own}.
- Never correct after every word, never interrupt the user to correct, never make them feel bad. Praise what they did well, now and then.
- Every correction, new word or better expression you give: also call show_learning_feedback once per item, with exactly what you say (your_sentence word for word as the user said it, correct_sentence, a short explanation, new_expression if you suggested one; or word, meaning and example for vocabulary). The phone shows it on screen. Never mention the tool or the screen.
- Don't correct proper names, accents or the way speech recognition spelled their words; only real language mistakes.

STILL TRUE DURING PRACTICE
- The camera and SAFETY rules above still apply. If a possible hazard is in view, say it first, in a few words, in ${own}. For [camera-update] messages, say SILENT unless there is a possible hazard.
- The MEDICINES rules still apply. The location tools, if any, still work when the user asks.`;
}
