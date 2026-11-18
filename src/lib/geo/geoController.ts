// Location, nearby places and walking guidance on the phone. The main controller owns one of these:
// it runs the live model's location tools, the buttons in the Navigation panel and the guidance
// itself. No DOM here (the GPS and the map routes come in as interfaces), so all of it runs in tests.
//
// Privacy: nothing about location happens before the user has agreed to the spoken notice, and the
// browser's own permission is asked only then. The GPS is read once per question; it is watched
// continuously only while guidance runs, and stops the moment guidance ends. The AI model never gets
// coordinates: only place ids, names, addresses and rounded distances.
import { haversine, roundDistance, roundMinutes } from "./math.ts";
import { RouteNavigator, type NavEvent } from "./navigator.ts";
import { geoSpeech, sentence } from "./phrases.ts";
import { GeoApiError, PositionError, type GeoApi, type PositionErrorCode, type PositionSource } from "./client.ts";
import { isPlaceCategory, type Fix, type LatLon, type Place, type PlaceCategory, type WalkingRoute } from "./types.ts";
import type { GeoToolName } from "./tools.ts";
import type { SpeechLang } from "../assistant/lang.ts";

export const GEO_TIMING = {
  /** A position this recent is reused for a question instead of asking the GPS again. */
  REUSE_FIX_MS: 10_000,
  LOCATE_TIMEOUT_MS: 12_000,
  /** Guidance: positions closer together than this are not re-evaluated. */
  MIN_UPDATE_MS: 1_000,
  /** No position for this long during guidance: the signal is lost. */
  SIGNAL_LOST_MS: 20_000,
  SIGNAL_CHECK_MS: 5_000,
  /** Between two route recalculations. */
  REROUTE_GAP_MS: 15_000,
  MAX_REROUTES: 12,
  /** After the user said no to location, the model's tools don't ask again for this long. */
  REFUSED_QUIET_MS: 120_000,
} as const;

export interface PlaceView {
  id: string;
  name: string | null;
  category: Place["category"];
  lat: number;
  lon: number;
  /** Straight-line metres from the position used for the search. */
  distance: number;
  address: string | null;
}

export interface RouteView {
  id: string;
  placeId: string;
  destination: string;
  lat: number;
  lon: number;
  distance: number;
  duration: number;
  geometry: LatLon[];
  first: string;
}

export interface NavView {
  routeId: string;
  destination: string;
  remaining: number;
  nextText: string | null;
  accuracy: number | null;
  offRoute: boolean;
  signal: "ok" | "weak" | "lost";
  rerouting: boolean;
}

export interface GeoState {
  /** The location notice was agreed to (kept on this device). */
  consent: boolean;
  /** The notice is being asked (said, and shown with its two buttons). */
  asking: boolean;
  status: "idle" | "locating" | "ready" | "error";
  error: PositionErrorCode | "service" | null;
  fix: Fix | null;
  address: string | null;
  /** The GPS is watched continuously (only during guidance). */
  tracking: boolean;
  search: { category: PlaceCategory | null; status: "idle" | "loading" | "ready" | "error"; partial: boolean; places: PlaceView[] };
  /** The last calculated route (started or not). */
  route: RouteView | null;
  routeStatus: "idle" | "calculating" | "ready" | "failed";
  nav: NavView | null;
}

export const GEO_IDLE: GeoState = {
  consent: false,
  asking: false,
  status: "idle",
  error: null,
  fix: null,
  address: null,
  tracking: false,
  search: { category: null, status: "idle", partial: false, places: [] },
  route: null,
  routeStatus: "idle",
  nav: null,
};

/** How the main controller should say something: at a turn, information, or a status line. */
export type GeoSayKind = "now" | "info" | "status";

export interface GeoDeps {
  lang(): SpeechLang;
  say(text: string, kind: GeoSayKind): void;
  onChange(s: GeoState): void;
  position: PositionSource;
  api: GeoApi;
  consent: { get(): boolean; set(v: boolean): void };
  /** Tells the live conversation's model something (the user allowed location). */
  toLive?(text: string): void;
  now?(): number;
}

export interface ToolContext {
  /** Counts the user's turns in the live conversation: confirmation must come in a later one. */
  userTurn: number;
}

export interface ToolOutcome {
  response: Record<string, unknown>;
  /** The phone spoke for this call (the notice, the start of guidance): the model's words are cut. */
  appSpoke: boolean;
}

interface StoredRoute {
  view: RouteView;
  route: WalkingRoute;
  /** The user turn in which the model told the user about it. */
  presentedTurn: number;
}

const quality = (acc: number) => (acc <= 20 ? "good" : acc <= 50 ? "fair" : "poor");

export class GeoController {
  state: GeoState;
  private deps: GeoDeps;
  private places = new Map<string, Place>();
  private placeIds = new Map<string, string>();
  private nextPlace = 1;
  private nextRoute = 1;
  private routes = new Map<string, StoredRoute>();
  private lastPlaceId: string | null = null;
  private locating: Promise<Fix> | null = null;
  private stopWatch: (() => void) | null = null;
  private signalTimer: ReturnType<typeof setInterval> | null = null;
  private navigator: RouteNavigator | null = null;
  private navRoute: StoredRoute | null = null;
  private lastUpdateAt = -Infinity;
  private lastFixAt = 0;
  private signalLostSaid = false;
  private reroutes = 0;
  private lastRerouteAt = -Infinity;
  private navGen = 0;
  private refusedAt = -Infinity;
  /** The model asked for location before consent: told to go on once the user agrees. */
  private resumeLive = false;

  constructor(deps: GeoDeps) {
    this.deps = deps;
    this.state = { ...GEO_IDLE, consent: deps.consent.get() };
  }

  private get now() {
    return this.deps.now?.() ?? Date.now();
  }
  private get p() {
    return geoSpeech(this.deps.lang());
  }
  private patch(part: Partial<GeoState>) {
    this.state = { ...this.state, ...part };
    this.deps.onChange(this.state);
  }

  // --- consent ---------------------------------------------------------------------------------------

  /** Says the location notice and waits for «موافق» or the button. */
  askConsent() {
    if (this.state.asking) return;
    this.patch({ asking: true });
    this.deps.say(this.p.consentNotice, "info");
  }

  acceptConsent() {
    this.deps.consent.set(true);
    this.refusedAt = -Infinity;
    this.patch({ consent: true, asking: false });
    this.deps.say(this.p.consentGiven, "status");
    // The browser's own permission prompt appears now, right after the user's yes.
    void this.locate().then(
      () => {
        if (this.resumeLive) this.deps.toLive?.("[app] location-allowed: the user agreed to use their location. Now do what they asked before, with the tools.");
        this.resumeLive = false;
      },
      (e) => {
        this.resumeLive = false;
        this.deps.say(this.errorText(e), "info");
      },
    );
  }

  declineConsent() {
    this.refusedAt = this.now;
    this.resumeLive = false;
    this.patch({ asking: false });
    this.deps.say(this.p.consentRefused, "status");
  }

  /** "Forget my location permission": everything stops, and the notice is asked again next time. */
  withdrawConsent() {
    this.deps.consent.set(false);
    this.stopTracking(false);
    this.patch({ consent: false, asking: false });
  }

  // --- position ---------------------------------------------------------------------------------------

  /** A recent position, or a fresh one. Concurrent callers share one GPS request. */
  locate(fresh = false): Promise<Fix> {
    const f = this.state.fix;
    if (!fresh && f && this.now - f.at <= GEO_TIMING.REUSE_FIX_MS) return Promise.resolve(f);
    if (this.locating) return this.locating;
    this.patch({ status: "locating", error: null });
    this.locating = this.deps.position
      .current({ timeoutMs: GEO_TIMING.LOCATE_TIMEOUT_MS, maxAgeMs: fresh ? 0 : 5_000 })
      .then(
        (fix) => {
          this.patch({ status: "ready", error: null, fix });
          return fix;
        },
        (e) => {
          const code = e instanceof PositionError ? e.code : "unavailable";
          this.patch({ status: "error", error: code });
          throw new PositionError(code);
        },
      )
      .finally(() => (this.locating = null));
    return this.locating;
  }

  private errorText(e: unknown): string {
    const p = this.p;
    if (e instanceof PositionError) return { denied: p.denied, unavailable: p.unavailable, timeout: p.timeout, unsupported: p.unsupported }[e.code];
    if (e instanceof GeoApiError) return e.code === "too-far" ? p.tooFar : e.code === "no-route" ? p.routeFailed : p.serviceDown;
    return p.serviceDown;
  }

  private errorCode(e: unknown): string {
    if (e instanceof PositionError) return e.code === "denied" ? "permission_denied" : `gps_${e.code}`;
    if (e instanceof GeoApiError) return e.code === "too-far" ? "too_far_to_walk" : e.code === "no-route" ? "no_walking_route" : "map_service_unavailable";
    return "map_service_unavailable";
  }

  // --- what the buttons and the tools share ---------------------------------------------------------------

  async address(): Promise<{ fix: Fix; label: string | null; name: string | null }> {
    const fix = await this.locate();
    const r = await this.deps.api.reverse(fix, this.deps.lang());
    this.patch({ address: r.label });
    return { fix, label: r.label, name: r.name };
  }

  private register(place: Place): string {
    let id = this.placeIds.get(place.osmId);
    if (!id) {
      id = `p${this.nextPlace++}`;
      this.placeIds.set(place.osmId, id);
    }
    this.places.set(id, place);
    return id;
  }

  async search(category: PlaceCategory, radius?: number): Promise<{ places: PlaceView[]; partial: boolean; radius: number; accuracy: number }> {
    this.patch({ search: { category, status: "loading", partial: false, places: this.state.search.places } });
    try {
      const fix = await this.locate();
      const r = await this.deps.api.nearby(fix, category, radius, this.deps.lang());
      const places = r.places.map((pl) => ({ id: this.register(pl), name: pl.name, category: pl.category, lat: pl.lat, lon: pl.lon, distance: haversine(fix, pl), address: pl.address }));
      places.sort((a, b) => a.distance - b.distance);
      if (places[0]) this.lastPlaceId = places[0].id;
      this.patch({ search: { category, status: "ready", partial: r.partial, places } });
      return { places, partial: r.partial, radius: r.radius, accuracy: fix.accuracy };
    } catch (e) {
      this.patch({ search: { category, status: "error", partial: false, places: [] } });
      throw e;
    }
  }

  placeName(id: string): string {
    return this.places.get(id)?.name ?? this.p.unnamed;
  }

  async calculateRoute(placeId: string, presentedTurn = 0): Promise<RouteView> {
    const place = this.places.get(placeId);
    if (!place) throw new GeoApiError("unknown-place");
    this.lastPlaceId = placeId;
    this.patch({ routeStatus: "calculating" });
    try {
      const fix = await this.locate();
      const route = await this.deps.api.route(fix, place);
      const id = `r${this.nextRoute++}`;
      const destination = place.name ?? this.p.unnamed;
      const first = new RouteNavigator(route, { ...place, name: destination }, this.deps.lang()).firstInstruction();
      const view: RouteView = { id, placeId, destination, lat: place.lat, lon: place.lon, distance: route.distance, duration: route.duration, geometry: route.geometry, first };
      this.routes.set(id, { view, route, presentedTurn });
      this.patch({ route: view, routeStatus: "ready" });
      return view;
    } catch (e) {
      this.patch({ routeStatus: "failed" });
      throw e;
    }
  }

  // --- guidance ------------------------------------------------------------------------------------------

  get navigating() {
    return !!this.navigator;
  }

  /** Starts (or replaces) guidance on a calculated route. The user has confirmed it. */
  startNavigation(routeId: string): boolean {
    const stored = this.routes.get(routeId);
    if (!stored) return false;
    this.endGuidance();
    const gen = ++this.navGen;
    const v = stored.view;
    this.navRoute = stored;
    this.navigator = new RouteNavigator(stored.route, { lat: v.lat, lon: v.lon, name: v.destination }, this.deps.lang());
    this.reroutes = 0;
    this.lastRerouteAt = -Infinity;
    this.lastUpdateAt = -Infinity;
    this.lastFixAt = this.now;
    this.signalLostSaid = false;
    const p = this.p;
    this.deps.say(p.routeStart(v.destination, p.metres(v.distance), p.minutes(v.duration), v.first), "info");
    this.patch({ route: v, tracking: true, nav: { routeId, destination: v.destination, remaining: v.distance, nextText: v.first, accuracy: this.state.fix?.accuracy ?? null, offRoute: false, signal: "ok", rerouting: false } });
    this.stopWatch = this.deps.position.watch(
      (fix) => gen === this.navGen && this.onFix(fix),
      (code) => gen === this.navGen && this.onWatchError(code),
    );
    this.signalTimer = setInterval(() => gen === this.navGen && this.checkSignal(), GEO_TIMING.SIGNAL_CHECK_MS);
    // In Node (tests, server rendering) a running guidance mustn't keep the process alive.
    (this.signalTimer as { unref?: () => void }).unref?.();
    return true;
  }

  /** Ends guidance. True when some was running. The GPS stops being watched at once. */
  stopNavigation(speak = true): boolean {
    const was = !!this.navigator;
    this.endGuidance();
    if (was) this.patch({ nav: null, tracking: false });
    if (speak) this.deps.say(was ? this.p.stopped : this.p.noNavigation, "status");
    return was;
  }

  private endGuidance() {
    this.navGen++;
    this.stopWatch?.();
    this.stopWatch = null;
    if (this.signalTimer) clearInterval(this.signalTimer);
    this.signalTimer = null;
    this.navigator = null;
    this.navRoute = null;
  }

  /** "Stop using my location": guidance, the GPS and everything known about the position go. */
  stopTracking(speak = true) {
    this.endGuidance();
    this.locating = null;
    this.places.clear();
    this.placeIds.clear();
    this.routes.clear();
    this.lastPlaceId = null;
    this.patch({ ...GEO_IDLE, consent: this.state.consent });
    if (speak) this.deps.say(this.p.trackingStopped, "status");
  }

  /** The page is going away. */
  destroy() {
    this.endGuidance();
  }

  private checkSignal() {
    if (!this.navigator || this.signalLostSaid) return;
    if (this.now - this.lastFixAt < GEO_TIMING.SIGNAL_LOST_MS) return;
    this.signalLostSaid = true;
    this.deps.say(this.p.signalLost, "info");
    this.patchNav({ signal: "lost" });
  }

  private onWatchError(code: PositionErrorCode) {
    if (code === "denied" || code === "unsupported") {
      this.deps.say(code === "denied" ? this.p.denied : this.p.unsupported, "info");
      this.stopNavigation(false);
      this.patch({ status: "error", error: code });
    }
    // A timeout or a lost fix: the signal check says it, once, when it lasts.
  }

  private patchNav(part: Partial<NavView>) {
    if (this.state.nav) this.patch({ nav: { ...this.state.nav, ...part } });
  }

  /** One position during guidance. */
  onFix(fix: Fix) {
    const nav = this.navigator;
    if (!nav) return;
    this.lastFixAt = this.now;
    this.patch({ fix, status: "ready", error: null });
    if (this.signalLostSaid) {
      this.signalLostSaid = false;
      this.deps.say(this.p.signalBack, "status");
    }
    if (this.now - this.lastUpdateAt < GEO_TIMING.MIN_UPDATE_MS) return;
    this.lastUpdateAt = this.now;
    const events = nav.update(fix);
    for (const ev of events) this.handle(ev, fix);
    if (!this.navigator) return; // arrived, or stopped meanwhile
    const pr = this.navigator.progress;
    if (pr) this.patchNav({ remaining: pr.remaining, nextText: pr.nextText, accuracy: fix.accuracy, offRoute: pr.offRoute, signal: pr.poorAccuracy ? "weak" : "ok" });
    // Still off the route after a failed recalculation: try again, not too often.
    if (pr?.offRoute && !this.state.nav?.rerouting && this.now - this.lastRerouteAt >= GEO_TIMING.REROUTE_GAP_MS * 2) void this.reroute(fix);
  }

  private handle(ev: NavEvent, fix: Fix) {
    const p = this.p;
    switch (ev.kind) {
      case "instruction":
        return this.deps.say(ev.text, ev.stage === "now" || ev.stage === "approx" ? "now" : "info");
      case "wrong-way":
        return this.deps.say(p.wrongWay, "now");
      case "accuracy-poor":
        return this.deps.say(p.gpsWeak, "status");
      case "accuracy-ok":
        return this.deps.say(p.gpsBack, "status");
      case "off-route":
        this.deps.say(p.offRoute, "info");
        return void this.reroute(fix);
      case "arrived": {
        const dest = this.navRoute?.view.destination ?? p.unnamed;
        this.deps.say(p.arrived(dest), "info");
        this.endGuidance();
        this.patch({ nav: null, tracking: false });
        return;
      }
    }
  }

  private async reroute(fix: Fix) {
    const stored = this.navRoute;
    if (!stored || this.state.nav?.rerouting) return;
    if (this.reroutes >= GEO_TIMING.MAX_REROUTES || this.now - this.lastRerouteAt < GEO_TIMING.REROUTE_GAP_MS) return;
    this.reroutes++;
    this.lastRerouteAt = this.now;
    const gen = this.navGen;
    this.patchNav({ rerouting: true });
    try {
      const v = stored.view;
      const route = await this.deps.api.route(fix, v);
      if (gen !== this.navGen) return;
      this.navigator = new RouteNavigator(route, { lat: v.lat, lon: v.lon, name: v.destination }, this.deps.lang());
      const view = { ...v, distance: route.distance, duration: route.duration, geometry: route.geometry, first: this.navigator.firstInstruction() };
      this.navRoute = { ...stored, view, route };
      this.routes.set(v.id, this.navRoute);
      this.deps.say(this.p.rerouted(view.first), "info");
      this.patch({ route: view, nav: { ...this.state.nav!, rerouting: false, offRoute: false, remaining: route.distance, nextText: view.first } });
    } catch {
      if (gen !== this.navGen) return;
      this.deps.say(this.p.rerouteFailed, "info");
      this.patchNav({ rerouting: false });
    }
  }

  status() {
    const nav = this.state.nav;
    if (!nav) return { active: false };
    return {
      active: true,
      destination: nav.destination,
      remaining_m: roundDistance(nav.remaining),
      next_direction: nav.nextText,
      gps_accuracy_m: nav.accuracy == null ? null : Math.round(nav.accuracy),
      off_route: nav.offRoute,
      recalculating: nav.rerouting,
      gps_signal: nav.signal,
    };
  }

  // --- the live model's tools -----------------------------------------------------------------------------

  /** Runs one tool call. Never throws: failures are answers the model can say. */
  async runTool(name: GeoToolName, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutcome> {
    const ok = (response: Record<string, unknown>, appSpoke = false): ToolOutcome => ({ response: { ok: true, ...response }, appSpoke });
    const fail = (error: string, extra: Record<string, unknown> = {}, appSpoke = false): ToolOutcome => ({ response: { ok: false, error, ...extra }, appSpoke });
    const failWith = (e: unknown) => fail(this.errorCode(e), { user_message: this.errorText(e) });

    // Nothing that needs the position before the user agreed.
    const needsPosition = name !== "stop_navigation" && name !== "get_navigation_status";
    if (needsPosition && !this.state.consent) {
      if (this.now - this.refusedAt < GEO_TIMING.REFUSED_QUIET_MS) return fail("permission_refused", { user_message: this.p.consentRefused, note: "The user said no to using their location. Don't ask again unless they bring it up." });
      this.resumeLive = true;
      this.askConsent();
      return fail("permission_pending", { note: "The phone is reading the location notice to the user and asks them to agree. Say nothing now; you will be told when they agree." }, true);
    }

    try {
      switch (name) {
        case "get_current_location": {
          const fix = await this.locate();
          return ok({ accuracy_m: Math.round(fix.accuracy), age_s: Math.max(0, Math.round((this.now - fix.at) / 1000)), quality: quality(fix.accuracy), navigating: this.navigating });
        }
        case "reverse_geocode": {
          const a = await this.address();
          return ok({
            address: a.label,
            // A building or shop the map puts at this address: NOT a statement of where it is
            // relative to the user (GPS can't tell which way they face).
            named_place_at_address: a.name,
            accuracy_m: Math.round(a.fix.accuracy),
            approximate: a.fix.accuracy > 50,
            source: "OpenStreetMap",
            note: a.label
              ? "named_place_at_address is near this address; never say it is in front of, behind or beside the user."
              : "The map has no address for this spot. Say so; don't guess one.",
          });
        }
        case "search_nearby_places": {
          const category = isPlaceCategory(args.category) ? args.category : "any";
          const radius = typeof args.radius_m === "number" && Number.isFinite(args.radius_m) ? args.radius_m : undefined;
          const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.min(8, Math.max(1, Math.round(args.limit))) : 5;
          const r = await this.search(category, radius);
          const places = r.places.slice(0, limit).map((pl) => ({ place_id: pl.id, name: pl.name, category: pl.category, distance_m: roundDistance(pl.distance), address: pl.address }));
          return ok({
            category,
            radius_m: r.radius,
            places,
            found: r.places.length,
            distances: "straight line from the user's GPS position, approximate; the walk is longer",
            gps_accuracy_m: Math.round(r.accuracy),
            list_may_be_incomplete: r.partial,
            source: "OpenStreetMap (may be incomplete or out of date)",
            ...(places.length ? {} : { user_message: this.p.notFound }),
          });
        }
        case "get_place_details": {
          const id = typeof args.place_id === "string" ? args.place_id : "";
          const pl = this.places.get(id);
          if (!pl) return fail("unknown_place", { note: "Use a place_id from search_nearby_places in this conversation, or search again." });
          this.lastPlaceId = id;
          const fix = this.state.fix;
          return ok({
            place_id: id,
            name: pl.name,
            category: pl.category,
            kind: pl.kind,
            address: pl.address,
            opening_hours: pl.openingHours,
            phone: pl.phone,
            wheelchair: pl.wheelchair,
            distance_m: fix ? roundDistance(haversine(fix, pl)) : null,
            note: "Only what the map has; null means unknown. Map data may be out of date.",
          });
        }
        case "calculate_walking_route": {
          const id = typeof args.place_id === "string" && args.place_id ? args.place_id : this.lastPlaceId;
          if (!id || !this.places.has(id)) return fail("unknown_place", { note: "Search for the place first with search_nearby_places." });
          const v = await this.calculateRoute(id, ctx.userTurn);
          return ok({
            route_id: v.id,
            destination: v.destination,
            walking_distance_m: roundDistance(v.distance),
            walking_minutes: roundMinutes(v.duration),
            first_direction: v.first,
            note: "Tell the user the walking distance and time, then ask if they want to start. Call start_navigation only after they say yes.",
          });
        }
        case "start_navigation": {
          const id = typeof args.route_id === "string" ? args.route_id : "";
          const stored = this.routes.get(id);
          if (!stored) return fail("unknown_route", { note: "Calculate the route first with calculate_walking_route." });
          // The user must have spoken after hearing the route: their yes, not the model's guess.
          if (ctx.userTurn <= stored.presentedTurn) return fail("needs_user_confirmation", { note: "Tell the user the distance and time and ask if they want to start. Wait for their yes." });
          this.startNavigation(id);
          return ok({ started: true, destination: stored.view.destination, note: "The phone is speaking the directions itself now. Say nothing more about the route." }, true);
        }
        case "stop_navigation": {
          const was = this.stopNavigation(this.navigating);
          return ok({ was_running: was, ...(was ? { note: "The phone said it stopped. Say nothing more." } : {}) }, was);
        }
        case "get_navigation_status":
          return ok(this.status());
      }
    } catch (e) {
      return failWith(e);
    }
    return fail("unknown_tool");
  }

  // --- the buttons (the app says the results itself) ------------------------------------------------------------

  async whereAmIByUser() {
    if (!this.state.consent) return this.askConsent();
    const p = this.p;
    try {
      const a = await this.address();
      const sep = this.deps.lang() === "fr" || this.deps.lang() === "en" ? ", " : "، ";
      const text = a.label ? p.youAreAt(a.name ? `${a.label}${sep}${p.near(a.name)}` : a.label) : a.name ? p.youAreAt(p.near(a.name)) : p.noAddress;
      this.deps.say(a.fix.accuracy > 50 ? `${text} ${p.approximate(p.metres(a.fix.accuracy))}` : text, "info");
    } catch (e) {
      this.deps.say(this.errorText(e), "info");
    }
  }

  async searchByUser(category: PlaceCategory) {
    if (!this.state.consent) return this.askConsent();
    const p = this.p;
    try {
      const r = await this.search(category);
      if (!r.places.length) return this.deps.say(p.notFound, "info");
      const first = r.places[0];
      this.deps.say(`${p.found(r.places.length)} ${p.nearest(first.name ?? p.unnamed, p.metres(first.distance))}`, "info");
    } catch (e) {
      this.deps.say(this.errorText(e), "info");
    }
  }

  async routeByUser(placeId: string) {
    if (!this.state.consent) return this.askConsent();
    const p = this.p;
    try {
      const v = await this.calculateRoute(placeId);
      this.deps.say(p.routeReady(v.destination, p.metres(v.distance), p.minutes(v.duration)), "info");
    } catch (e) {
      this.deps.say(this.errorText(e), "info");
    }
  }

  async refreshByUser() {
    if (!this.state.consent) return this.askConsent();
    try {
      const fix = await this.locate(true);
      this.deps.say(sentence(this.p.approximate(this.p.metres(fix.accuracy))), "status");
    } catch (e) {
      this.deps.say(this.errorText(e), "info");
    }
  }
}
