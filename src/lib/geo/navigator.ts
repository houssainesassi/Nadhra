// Turn-by-turn walking guidance from GPS positions. Pure logic, no timers and no network: the caller
// feeds each position and speaks the events. The routing engine's manoeuvres are the only source of
// directions; this only decides WHEN to say them, and how precisely, given the GPS accuracy.
//
// GPS on a phone is often 5-15 m in the open and 30-60 m between buildings. So:
//   - a turn is announced «now» only when accuracy is good enough to place it (≤ PRECISE_M);
//     between that and USABLE_M it is announced as approximate, with the advice to check;
//   - beyond USABLE_M nothing about turns is said (once: "GPS isn't precise"), and leaving the route
//     isn't judged either;
//   - leaving the route needs several positions over several seconds beyond a threshold that grows
//     with the accuracy, so one bad position never triggers a recalculation.
// Every announcement has a key and is said at most once.
import { cumulativeLengths, haversine, projectOnLine } from "./math.ts";
import { arriveSide, geoSpeech, sentence, stepAction } from "./phrases.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { Fix, LatLon, WalkingRoute } from "./types.ts";

export const NAV = {
  /** Accuracy (m) good enough to say «now, turn right». */
  PRECISE_M: 20,
  /** Accuracy (m) beyond which no turn is announced and no deviation is judged. */
  USABLE_M: 40,
  /** «In about 50 metres…» is said this far before a turn… */
  PREPARE_M: 70,
  /** …when the stretch before it is at least this long (otherwise the two would run together). */
  PREPARE_MIN_STEP_M: 45,
  /** «Now…» this close to the turn. */
  NOW_M: 15,
  /** A stretch longer than this after a turn gets «keep going for about …». */
  LONG_STRETCH_M: 250,
  /** Off the route: at least this far from it… */
  OFF_ROUTE_MIN_M: 30,
  /** …for this many positions in a row… */
  OFF_ROUTE_FIXES: 3,
  /** …over at least this long. */
  OFF_ROUTE_MS: 6_000,
  /** Arrived within this distance of the destination (or of the route's end). */
  ARRIVE_M: 15,
  /** Going back along the route by this much (with precise GPS) is the wrong way. */
  WRONG_WAY_M: 25,
  WRONG_WAY_REPEAT_MS: 30_000,
} as const;

export type NavEvent =
  | { kind: "instruction"; stage: "prepare" | "now" | "approx" | "keep-going" | "destination-ahead"; step: number; text: string }
  | { kind: "off-route"; distance: number }
  | { kind: "wrong-way" }
  | { kind: "accuracy-poor" }
  | { kind: "accuracy-ok" }
  | { kind: "arrived" };

export interface NavProgress {
  /** Metres still to walk along the route (approximate). */
  remaining: number;
  /** Index of the next manoeuvre in route.steps, or null after the last. */
  nextStep: number | null;
  distanceToNext: number | null;
  /** The next manoeuvre in words, for the screen. */
  nextText: string | null;
  distanceFromRoute: number;
  offRoute: boolean;
  accuracy: number;
  /** GPS too imprecise for directions. */
  poorAccuracy: boolean;
}

export class RouteNavigator {
  readonly route: WalkingRoute;
  readonly destination: LatLon & { name: string };
  private lang: SpeechLang;
  private cum: number[];
  /** Distance along the route of each manoeuvre. */
  private offsets: number[];
  private said = new Set<string>();
  private nextStep = 1;
  private offCount = 0;
  private offSince: number | null = null;
  private offReported = false;
  private poor = false;
  private maxAlong = 0;
  private lastWrongWayAt = -Infinity;
  private arrived = false;
  progress: NavProgress | null = null;

  constructor(route: WalkingRoute, destination: LatLon & { name: string }, lang: SpeechLang) {
    this.route = route;
    this.destination = destination;
    this.lang = lang;
    this.cum = cumulativeLengths(route.geometry);
    // Each manoeuvre's place on the line, projected, so offsets and positions use the same measure.
    this.offsets = route.steps.map((s, i) => (i === 0 ? 0 : projectOnLine(s.location, route.geometry, this.cum).along));
    for (let i = 1; i < this.offsets.length; i++) this.offsets[i] = Math.max(this.offsets[i], this.offsets[i - 1]);
  }

  get length() {
    return this.cum[this.cum.length - 1] ?? this.route.distance;
  }

  get hasArrived() {
    return this.arrived;
  }

  /** The first thing to do, as a sentence: «ابدا امشي في نهج روما. بعد حوالي 80 متر، دور على يمينك.» */
  firstInstruction(): string {
    const p = geoSpeech(this.lang);
    const steps = this.route.steps;
    const depart = steps[0] ? stepAction(steps[0], this.lang) : null;
    const nextIdx = steps.findIndex((s, i) => i > 0 && s.type !== "arrive" && stepAction(s, this.lang));
    const parts: string[] = [];
    if (depart) parts.push(`${sentence(depart)}.`);
    if (nextIdx > 0) {
      const action = stepAction(steps[nextIdx], this.lang)!;
      parts.push(p.inDistance(p.metres(this.offsets[nextIdx]), action));
      // Said just now: «in about 70 m» for the same turn a few steps later would only repeat it.
      if (this.offsets[nextIdx] <= NAV.PREPARE_M * 2) this.said.add(`prepare:${nextIdx}`);
    } else {
      parts.push(p.destinationAhead(this.destination.name, p.metres(this.length)));
    }
    return sentence(parts.join(" "));
  }

  /** The next manoeuvre in words, for the screen and for get_navigation_status. */
  private describe(i: number | null, dist: number | null): string | null {
    if (i == null) return null;
    const step = this.route.steps[i];
    const p = geoSpeech(this.lang);
    if (step.type === "arrive" || !stepAction(step, this.lang)) return p.destinationAhead(this.destination.name, p.metres(dist ?? 0));
    return p.inDistance(p.metres(dist ?? 0), stepAction(step, this.lang)!);
  }

  update(fix: Fix): NavEvent[] {
    const events: NavEvent[] = [];
    if (this.arrived) return events;
    const p = geoSpeech(this.lang);
    const proj = projectOnLine(fix, this.route.geometry, this.cum);
    const along = proj.along;

    // Arrival: near the destination itself, or at the end of the route (with usable GPS).
    const toDest = haversine(fix, this.destination);
    const arriveWithin = Math.max(NAV.ARRIVE_M, Math.min(fix.accuracy, 25));
    if (fix.accuracy <= NAV.USABLE_M && (toDest <= arriveWithin || (this.length - along <= NAV.ARRIVE_M && proj.distance <= Math.max(NAV.OFF_ROUTE_MIN_M, fix.accuracy)))) {
      this.arrived = true;
      this.progress = { remaining: 0, nextStep: null, distanceToNext: null, nextText: null, distanceFromRoute: proj.distance, offRoute: false, accuracy: fix.accuracy, poorAccuracy: false };
      events.push({ kind: "arrived" });
      return events;
    }

    // Too imprecise: say so once, and judge nothing.
    if (fix.accuracy > NAV.USABLE_M) {
      if (!this.poor) events.push({ kind: "accuracy-poor" });
      this.poor = true;
      this.offCount = 0;
      this.offSince = null;
      this.progress = { ...(this.progress ?? this.emptyProgress(fix)), accuracy: fix.accuracy, poorAccuracy: true };
      return events;
    }
    if (this.poor) {
      this.poor = false;
      events.push({ kind: "accuracy-ok" });
    }

    // Off the route: only after several positions in a row, over several seconds.
    const offLimit = Math.max(NAV.OFF_ROUTE_MIN_M, fix.accuracy * 1.5);
    if (proj.distance > offLimit) {
      this.offCount++;
      this.offSince ??= fix.at;
      if (!this.offReported && this.offCount >= NAV.OFF_ROUTE_FIXES && fix.at - this.offSince >= NAV.OFF_ROUTE_MS) {
        this.offReported = true;
        events.push({ kind: "off-route", distance: proj.distance });
      }
      this.progress = { ...this.track(along, fix, proj.distance), offRoute: this.offReported };
      return events;
    }
    this.offCount = 0;
    this.offSince = null;
    this.offReported = false;

    // Going back along the route, with precise GPS: the wrong way.
    if (along > this.maxAlong) this.maxAlong = along;
    else if (fix.accuracy <= NAV.PRECISE_M && this.maxAlong - along >= NAV.WRONG_WAY_M && fix.at - this.lastWrongWayAt >= NAV.WRONG_WAY_REPEAT_MS) {
      this.lastWrongWayAt = fix.at;
      this.maxAlong = along;
      events.push({ kind: "wrong-way" });
    }

    // The next manoeuvre: the first one still ahead.
    const before = this.nextStep;
    while (this.nextStep < this.offsets.length && this.offsets[this.nextStep] <= along + 3) this.nextStep++;
    const i = this.nextStep < this.route.steps.length ? this.nextStep : null;
    const dist = i == null ? null : this.offsets[i] - along;

    if (i != null && dist != null) {
      const step = this.route.steps[i];
      const action = stepAction(step, this.lang);
      const stretch = this.offsets[i] - this.offsets[i - 1];
      // Just past a turn, a long stretch follows: one reminder of how far, nothing more.
      if (this.nextStep > before && before >= 1 && stretch >= NAV.LONG_STRETCH_M) this.once(`keep:${i}`, events, "keep-going", i, p.keepGoing(p.metres(dist)));
      if (step.type === "arrive" || !action) {
        if (dist <= NAV.PREPARE_M) {
          const side = arriveSide(step, this.lang);
          this.once(`dest:${i}`, events, "destination-ahead", i, `${p.destinationAhead(this.destination.name, p.metres(dist))}${side ? ` ${sentence(side)}.` : ""}`);
        }
      } else if (dist <= Math.max(NAV.NOW_M, fix.accuracy * 0.75)) {
        // At the turn. Precise GPS: «now». Otherwise: approximately here, check.
        if (fix.accuracy <= NAV.PRECISE_M) this.once(`now:${i}`, events, "now", i, p.now(action));
        else if (!this.said.has(`now:${i}`)) this.once(`approx:${i}`, events, "approx", i, p.nearApprox(action));
      } else if (dist <= NAV.PREPARE_M && stretch >= NAV.PREPARE_MIN_STEP_M && !this.said.has(`now:${i}`) && !this.said.has(`approx:${i}`)) {
        this.once(`prepare:${i}`, events, "prepare", i, p.inDistance(p.metres(dist), action));
      }
    }

    this.progress = this.track(along, fix, proj.distance);
    return events;
  }

  private once(key: string, events: NavEvent[], stage: Extract<NavEvent, { kind: "instruction" }>["stage"], step: number, text: string) {
    if (this.said.has(key)) return;
    this.said.add(key);
    events.push({ kind: "instruction", stage, step, text: sentence(text) });
  }

  private emptyProgress(fix: Fix): NavProgress {
    return { remaining: this.length, nextStep: 1, distanceToNext: null, nextText: null, distanceFromRoute: 0, offRoute: false, accuracy: fix.accuracy, poorAccuracy: false };
  }

  private track(along: number, fix: Fix, fromRoute: number): NavProgress {
    const i = this.nextStep < this.route.steps.length ? this.nextStep : null;
    const dist = i == null ? null : Math.max(0, this.offsets[i] - along);
    return {
      remaining: Math.max(0, this.length - along),
      nextStep: i,
      distanceToNext: dist,
      nextText: this.describe(i, dist),
      distanceFromRoute: fromRoute,
      offRoute: this.offReported,
      accuracy: fix.accuracy,
      poorAccuracy: false,
    };
  }
}
