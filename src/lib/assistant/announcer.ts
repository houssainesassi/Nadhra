// What the page's hidden live regions contain, so a screen reader reads every sentence that the
// page's own voice can't say, including the same sentence twice in a row.
//
// A live region is only read when its content changes. Writing an identical sentence into the same
// element changes nothing, so a repeated refusal was silent. Instead there are two regions per kind
// (polite, alert) and announcement n goes into region n % 2 while the other one is empty: every
// announcement is a new insertion into an empty region, even when the text is the same, and nothing
// is read twice. Pure, shared with the tests.

export interface Announcement {
  text: string;
  urgent: boolean;
  /** The announcement's turn: increases by one with every announcement (the page counts them). */
  id: number;
}

export interface Regions {
  polite: [string, string];
  alert: [string, string];
}

export const EMPTY_REGIONS: Regions = { polite: ["", ""], alert: ["", ""] };

/** `echo` false: the page's voice is speaking and the screen reader isn't asked to repeat it. */
export function announcerRegions(a: Announcement, echo: boolean): Regions {
  if (!echo || !a.text) return EMPTY_REGIONS;
  const pair: [string, string] = a.id % 2 === 0 ? [a.text, ""] : ["", a.text];
  return a.urgent ? { polite: ["", ""], alert: pair } : { polite: pair, alert: ["", ""] };
}
