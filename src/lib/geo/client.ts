// The browser's side of location: the device GPS (Geolocation API) and the app's map routes.
// Both behind small interfaces, so the controller can be tested with fakes and no network.
import { apiFetch } from "../assistant/api.ts";
import type { SpeechLang } from "../assistant/lang.ts";
import type { Fix, LatLon, NearbyResult, PlaceCategory, ReverseResult, WalkingRoute } from "./types.ts";

export type PositionErrorCode = "denied" | "unavailable" | "timeout" | "unsupported";

export class PositionError extends Error {
  readonly code: PositionErrorCode;
  constructor(code: PositionErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface PositionSource {
  /** One position. Rejects with a PositionError. */
  current(opts: { timeoutMs: number; maxAgeMs: number }): Promise<Fix>;
  /** Positions as the device produces them, until the returned function is called. */
  watch(onFix: (f: Fix) => void, onError: (code: PositionErrorCode) => void): () => void;
}

const toFix = (p: GeolocationPosition): Fix => ({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: Math.max(1, p.coords.accuracy || 9999), at: p.timestamp || Date.now() });
const toCode = (e: GeolocationPositionError | null): PositionErrorCode => (e?.code === 1 ? "denied" : e?.code === 3 ? "timeout" : "unavailable");

/** The device's GPS. High accuracy is asked for: walking directions need it. */
export class BrowserPosition implements PositionSource {
  private get api(): Geolocation | null {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return null;
    // Browsers refuse location on plain http (except localhost) without asking anyone.
    if (typeof window !== "undefined" && window.isSecureContext === false) return null;
    return navigator.geolocation;
  }

  current({ timeoutMs, maxAgeMs }: { timeoutMs: number; maxAgeMs: number }): Promise<Fix> {
    const api = this.api;
    if (!api) return Promise.reject(new PositionError("unsupported"));
    return new Promise((resolve, reject) =>
      api.getCurrentPosition((p) => resolve(toFix(p)), (e) => reject(new PositionError(toCode(e))), { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maxAgeMs }),
    );
  }

  watch(onFix: (f: Fix) => void, onError: (code: PositionErrorCode) => void): () => void {
    const api = this.api;
    if (!api) {
      onError("unsupported");
      return () => {};
    }
    const id = api.watchPosition((p) => onFix(toFix(p)), (e) => onError(toCode(e)), { enableHighAccuracy: true, maximumAge: 1_000, timeout: 20_000 });
    return () => api.clearWatch(id);
  }
}

/** A map route refused or failed: the server's error code, or "network". */
export class GeoApiError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface GeoApi {
  reverse(at: LatLon, lang: SpeechLang): Promise<ReverseResult>;
  nearby(at: LatLon, category: PlaceCategory, radius: number | undefined, lang: SpeechLang): Promise<NearbyResult>;
  route(from: LatLon, to: LatLon): Promise<WalkingRoute>;
}

const point = (p: LatLon) => ({ lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)) });

async function post<T>(url: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await apiFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal: AbortSignal.timeout(28_000) });
  } catch (e) {
    throw new GeoApiError((e as { code?: string })?.code === "nadhra-unavailable" ? "nadhra-unavailable" : "network");
  }
  const d = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok || !d) throw new GeoApiError(d?.error ?? `http-${res.status}`);
  return d;
}

/** The app's own map routes (/api/geo/*). The position goes there and on to OpenStreetMap services. */
export const httpGeoApi: GeoApi = {
  reverse: (at, lang) => post<ReverseResult>("/api/geo/reverse", { ...point(at), lang }),
  nearby: (at, category, radius, lang) => post<NearbyResult>("/api/geo/nearby", { ...point(at), category, radius, lang }),
  route: async (from, to) => (await post<{ route: WalkingRoute }>("/api/geo/route", { from: point(from), to: point(to) })).route,
};
