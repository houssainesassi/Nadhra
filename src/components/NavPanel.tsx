"use client";
// The Location & directions panel: the same things the voice conversation does («وين أنا توّا؟»,
// «win a9reb pharmacie», «kifeh nemchi…»), with buttons. Every result is also said aloud by the
// assistant's voice and written here as text, so the optional map is never needed. English, like
// the other panels.
import dynamic from "next/dynamic";
import { useState } from "react";
import type { SmartVisionController, VisionState } from "@/lib/assistant/controller";
import { geoSpeech } from "@/lib/geo/phrases";
import { roundMinutes } from "@/lib/geo/math";
import type { PlaceCategory } from "@/lib/geo/types";

const NavMap = dynamic(() => import("./NavMap"), { ssr: false, loading: () => <p className="text-base text-ink-2">Loading the map…</p> });

const CATEGORIES: [PlaceCategory, string][] = [
  ["any", "Everything nearby"],
  ["pharmacy", "Pharmacies"],
  ["hospital", "Hospitals"],
  ["clinic", "Clinics and doctors"],
  ["supermarket", "Supermarkets"],
  ["grocery", "Grocery shops"],
  ["restaurant", "Restaurants"],
  ["cafe", "Cafés"],
  ["atm", "Cash machines (ATM)"],
  ["bank", "Banks"],
  ["bus_stop", "Bus stops"],
  ["train_station", "Train and tram stations"],
  ["hotel", "Hotels"],
  ["public_place", "Public places"],
  ["shop", "Shops"],
];
const CATEGORY_NAME: Record<string, string> = Object.fromEntries(CATEGORIES);
const SINGULAR: Record<string, string> = {
  pharmacy: "Pharmacy", hospital: "Hospital", clinic: "Clinic", supermarket: "Supermarket", grocery: "Grocery", restaurant: "Restaurant", cafe: "Café",
  atm: "Cash machine", bank: "Bank", bus_stop: "Bus stop", train_station: "Station", hotel: "Hotel", public_place: "Public place", shop: "Shop",
};

const metres = (m: number) => geoSpeech("en").metres(m);
const time = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const ERRORS: Record<string, string> = {
  denied: "Location permission is blocked. Allow it in your browser's site settings (Location), then try again.",
  unavailable: "Your position couldn't be found. Check that location (GPS) is on; inside a building, try near a door or window.",
  timeout: "GPS took too long to answer. Try again in a moment.",
  unsupported: "This browser doesn't provide a location (it needs a secure https page).",
  service: "The map service didn't answer. Try again in a moment.",
};

export default function NavPanel({ controller, s }: { controller: SmartVisionController; s: VisionState }) {
  const g = s.geo;
  const [showMap, setShowMap] = useState(false);
  const nav = g.nav;

  return (
    <div className="flex flex-col gap-6 text-lg" data-testid="nav-panel">
      <p className="text-base text-ink-2">
        In a conversation with Nadhra, just ask: «وين أنا توّا؟», «win a9reb pharmacie?», «kifeh nemchi lel pharmacie?», “where am I?”, “guide me to the nearest hospital”. Nadhra
        asks before starting guidance, then the directions are spoken at each turn. Say «وقّف التوجيه» or “stop navigation” to stop at any time.
      </p>

      {!g.consent && (
        <section className="safety-note flex flex-col gap-3" aria-labelledby="loc-consent-title" data-testid="nav-consent">
          <h3 id="loc-consent-title" className="font-semibold">Before using your location</h3>
          <p>
            To tell you where you are, find places near you and guide you there, Nadhra needs your location. Your position goes through Nadhra&apos;s server to the OpenStreetMap
            services (Nominatim for addresses, Overpass for places, OSRM by FOSSGIS for walking routes). In a conversation, place names, addresses and distances (never your
            coordinates) also go to Google Gemini so it can answer you. Nothing is stored. GPS is read when you ask, and continuously only while guidance runs. Your browser will
            also ask for permission.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <button type="button" className="control control-primary min-h-16" onClick={() => controller.geoAccept()} data-autofocus data-testid="nav-allow">I agree, use my location</button>
            <button type="button" className="control control-quiet min-h-16" onClick={() => controller.geoDecline()}>Not now</button>
          </div>
        </section>
      )}

      {nav && (
        <section className="flex flex-col gap-3" aria-labelledby="nav-active-title" data-testid="nav-active">
          <h3 id="nav-active-title" className="font-semibold">Navigating to {nav.destination}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-base">
            <dt>Next</dt><dd dir="auto">{nav.rerouting ? "Finding a new route…" : nav.nextText ?? "—"}</dd>
            <dt>Left to walk</dt><dd>{metres(nav.remaining)}</dd>
            <dt>GPS</dt><dd>{nav.signal === "lost" ? "Signal lost: directions paused" : nav.signal === "weak" ? "Not precise: precise directions paused" : nav.accuracy != null ? `accurate to about ${Math.round(nav.accuracy)} m` : "waiting…"}{nav.offRoute ? " · off the route" : ""}</dd>
          </dl>
          <button type="button" className="control control-emergency min-h-16" onClick={() => controller.geoStop()} data-testid="nav-stop">Stop navigation</button>
        </section>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="loc-title">
        <h3 id="loc-title" className="font-semibold">My location</h3>
        <p role="status" className="text-base text-ink-2" data-testid="nav-location">
          {g.status === "locating" && "Finding your location…"}
          {g.status === "error" && (ERRORS[g.error ?? "service"] ?? ERRORS.service)}
          {g.status !== "locating" && g.status !== "error" && g.fix && (
            <>
              Found at {time(g.fix.at)}, accurate to about {Math.max(1, Math.round(g.fix.accuracy))} m{g.fix.accuracy > 50 ? " (approximate)" : ""}.
              {g.address && <> <span dir="auto">{g.address}</span>.</>}
              <span className="sr-only"> </span>
              <span className="block tabular-nums" dir="ltr">{g.fix.lat.toFixed(5)}, {g.fix.lon.toFixed(5)}</span>
            </>
          )}
          {g.status === "idle" && !g.fix && (g.consent ? "Not used yet. Nothing is tracked until you ask." : "Not allowed yet.")}
          {g.tracking && " Tracking during navigation."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" className="control control-primary min-h-16" onClick={() => controller.geoWhereAmI()} data-testid="nav-where">Where am I?</button>
          <button type="button" className="control control-quiet min-h-16" onClick={() => controller.geoRefresh()} disabled={!g.consent}>Refresh my location</button>
          {(g.fix || g.tracking) && (
            <button type="button" className="control control-quiet min-h-16" onClick={() => controller.geoStopTracking()} data-testid="nav-stop-tracking">Stop using my location</button>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="near-title">
        <h3 id="near-title" className="font-semibold">Places near me</h3>
        <label className="flex flex-col gap-2">
          <span>Find</span>
          <span className="select">
            <select className="field" data-testid="nav-category" defaultValue="" onChange={(e) => { if (e.target.value) controller.geoSearch(e.target.value as PlaceCategory); }}>
              <option value="" disabled>Choose a kind of place…</option>
              {CATEGORIES.map(([c, label]) => <option key={c} value={c}>{label}</option>)}
            </select>
          </span>
        </label>
        <div role="status" className="text-base text-ink-2">
          {g.search.status === "loading" && "Searching the map…"}
          {g.search.status === "error" && "The search failed. Try again in a moment."}
          {g.search.status === "ready" && (g.search.places.length ? `${g.search.places.length} found, nearest first${g.search.category ? ` (${CATEGORY_NAME[g.search.category]})` : ""}. Distances are straight lines; the walk is longer.` : "Nothing of that kind near you on the map. The map can be incomplete.")}
          {g.search.status === "ready" && g.search.partial && " This list may be incomplete: the backup map search was used."}
        </div>
        {g.search.places.length > 0 && (
          <ol className="flex flex-col" data-testid="nav-places">
            {g.search.places.slice(0, 10).map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline py-3 last:border-0">
                <span>
                  <span dir="auto" className="font-medium">{p.name ?? "No name on the map"}</span>
                  <span className="block text-base text-ink-2">{SINGULAR[p.category] ?? p.category} · {metres(p.distance)}{p.address ? <> · <span dir="auto">{p.address}</span></> : " · address not on the map"}</span>
                </span>
                <button type="button" className="control control-quiet min-h-14" onClick={() => controller.geoRoute(p.id)} aria-label={`Directions to ${p.name ?? "this place"}`}>Directions</button>
              </li>
            ))}
          </ol>
        )}
      </section>

      {(g.route || g.routeStatus === "calculating" || g.routeStatus === "failed") && (
        <section className="flex flex-col gap-3" aria-labelledby="route-title" data-testid="nav-route">
          <h3 id="route-title" className="font-semibold">Walking route</h3>
          <p role="status" className="text-base">
            {g.routeStatus === "calculating" && "Working out a walking route…"}
            {g.routeStatus === "failed" && "No walking route could be found to that place."}
            {g.routeStatus !== "calculating" && g.route && (
              <>
                <span dir="auto">{g.route.destination}</span>: {metres(g.route.distance)} on foot, about {roundMinutes(g.route.duration)} min (map estimate). <span dir="auto">{g.route.first}</span>
              </>
            )}
          </p>
          {g.route && (!nav || nav.routeId !== g.route.id) && g.routeStatus === "ready" && (
            <button type="button" className="control control-primary min-h-16" onClick={() => controller.geoStart(g.route!.id)} data-testid="nav-start">Start navigation</button>
          )}
          <p className="text-base text-ink-2">Routes come from OpenStreetMap and can be wrong or out of date. They say nothing about obstacles, works or crossings: keep using your cane, dog or a person.</p>
        </section>
      )}

      <section className="flex flex-col gap-3 border-t border-hairline pt-6">
        <label className="flex min-h-14 items-center justify-between gap-4">
          <span>Show map<span className="block text-base text-ink-2">Optional. Everything on it is also written above and said aloud.</span></span>
          <input type="checkbox" role="switch" className="switch" checked={showMap} onChange={(e) => setShowMap(e.target.checked)} data-testid="nav-map-toggle" />
        </label>
        {showMap && <NavMap geo={g} />}
        <p className="text-base text-ink-2">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a>. Routing: OSRM (FOSSGIS).</p>
        {g.consent && (
          <button type="button" className="control control-quiet min-h-16" onClick={() => controller.geoWithdraw()} data-testid="nav-withdraw">Forget my location permission</button>
        )}
      </section>
    </div>
  );
}
