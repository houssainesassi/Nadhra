"use client";
// The optional visual map (Leaflet + OpenStreetMap tiles). Only for people who can see it, or to
// show someone: everything here is also said and listed in text, and nothing needs it. Loaded only
// when "Show map" is switched on, so the page doesn't fetch Leaflet or map tiles otherwise.
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import type { GeoState } from "@/lib/geo/geoController";

type Leaflet = typeof import("leaflet");

export default function NavMap({ geo }: { geo: GeoState }) {
  const box = useRef<HTMLDivElement>(null);
  const L = useRef<Leaflet | null>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const layer = useRef<import("leaflet").LayerGroup | null>(null);
  const fitted = useRef("");

  useEffect(() => {
    let gone = false;
    void import("leaflet").then((mod) => {
      if (gone || !box.current) return;
      const leaflet = (mod as unknown as { default?: Leaflet }).default ?? (mod as Leaflet);
      L.current = leaflet;
      const m = leaflet.map(box.current, { zoomControl: true, attributionControl: true }).setView([36.8, 10.18], 15);
      leaflet.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(m);
      map.current = m;
      layer.current = leaflet.layerGroup().addTo(m);
      draw();
    });
    return () => {
      gone = true;
      map.current?.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => draw());

  function draw() {
    const leaflet = L.current;
    const m = map.current;
    const g = layer.current;
    if (!leaflet || !m || !g) return;
    g.clearLayers();
    const pts: [number, number][] = [];
    const route = geo.route;
    if (route) {
      const line = route.geometry.map((p) => [p.lat, p.lon] as [number, number]);
      leaflet.polyline(line, { color: "#2f7df6", weight: 6, opacity: 0.85 }).addTo(g);
      leaflet.circleMarker([route.lat, route.lon], { radius: 10, color: "#d33", fillColor: "#d33", fillOpacity: 0.9 }).bindTooltip(route.destination).addTo(g);
      pts.push(...line);
    }
    for (const p of geo.search.places.slice(0, 20)) {
      if (route && p.id === route.placeId) continue;
      leaflet.circleMarker([p.lat, p.lon], { radius: 7, color: "#b36b00", fillColor: "#f5a623", fillOpacity: 0.9 }).bindTooltip(p.name ?? "No name on the map").addTo(g);
      if (!route) pts.push([p.lat, p.lon]);
    }
    const f = geo.fix;
    if (f) {
      leaflet.circle([f.lat, f.lon], { radius: f.accuracy, color: "#2f7df6", weight: 1, fillOpacity: 0.12 }).addTo(g);
      leaflet.circleMarker([f.lat, f.lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#2f7df6", fillOpacity: 1 }).bindTooltip("You (approximate)").addTo(g);
      pts.push([f.lat, f.lon]);
    }
    // Re-fit only when what is shown changes (not on every position during navigation).
    const key = `${route?.id ?? ""}|${geo.search.places.length}|${f ? "f" : ""}`;
    if (pts.length && key !== fitted.current) {
      fitted.current = key;
      m.fitBounds(leaflet.latLngBounds(pts), { padding: [24, 24], maxZoom: 17 });
    }
  }

  const summary = [geo.fix && "your approximate position", geo.search.places.length && `${geo.search.places.length} places`, geo.route && `the route to ${geo.route.destination}`].filter(Boolean).join(", ");
  // A labelled region, not an image: Leaflet puts focusable zoom buttons and links inside it.
  return <div ref={box} className="nav-map" role="region" aria-label={`Map showing ${summary || "the area"}. Everything on it is also listed in text above.`} data-testid="nav-map" />;
}
