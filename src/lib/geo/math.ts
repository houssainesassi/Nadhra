// Distances on the ground, and where a position falls on a route. Pure functions.
// Walking distances are short, so a flat projection around the point is accurate to well under a
// metre here; the great-circle formula is used for point-to-point distances.
import type { LatLon } from "./types.ts";

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const isValidLatLon = (lat: unknown, lon: unknown): boolean =>
  typeof lat === "number" && typeof lon === "number" && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);

/** Metres east (x) and north (y) of `origin`. */
function toXY(p: LatLon, origin: LatLon): [number, number] {
  return [rad(p.lon - origin.lon) * Math.cos(rad(origin.lat)) * R, rad(p.lat - origin.lat) * R];
}

/** Cumulative length of a polyline at each vertex (first is 0). */
export function cumulativeLengths(line: LatLon[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1] + haversine(line[i - 1], line[i]));
  return out;
}

export interface Projection {
  /** Metres from the point to the nearest part of the line. */
  distance: number;
  /** Metres along the line to that nearest part. */
  along: number;
  /** Index of the segment it is on. */
  segment: number;
}

/** The nearest point of a polyline to `p`. `cum` from cumulativeLengths(line). */
export function projectOnLine(p: LatLon, line: LatLon[], cum: number[] = cumulativeLengths(line)): Projection {
  if (line.length === 0) return { distance: Infinity, along: 0, segment: 0 };
  if (line.length === 1) return { distance: haversine(p, line[0]), along: 0, segment: 0 };
  let best: Projection = { distance: Infinity, along: 0, segment: 0 };
  for (let i = 0; i < line.length - 1; i++) {
    const [ax, ay] = toXY(line[i], p);
    const [bx, by] = toXY(line[i + 1], p);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // The point is the origin (0, 0): t of its foot on the segment, clamped.
    const t = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const fx = ax + t * dx;
    const fy = ay + t * dy;
    const d = Math.hypot(fx, fy);
    if (d < best.distance) best = { distance: d, along: cum[i] + t * (cum[i + 1] - cum[i]), segment: i };
  }
  return best;
}

/**
 * A distance as it should be said: never more precise than GPS and maps can be. Under 100 m to the
 * nearest 10, under 1 km to the nearest 50, then to the nearest 100. Never 0.
 */
export function roundDistance(m: number): number {
  if (!Number.isFinite(m) || m < 0) return 0;
  if (m < 100) return Math.max(10, Math.round(m / 10) * 10);
  if (m < 1000) return Math.round(m / 50) * 50;
  return Math.round(m / 100) * 100;
}

/** Minutes, at least 1. */
export const roundMinutes = (seconds: number) => Math.max(1, Math.round(seconds / 60));
