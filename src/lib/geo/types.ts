// Location, places and walking routes: the shapes shared by the browser, the server routes and the
// tests. Pure types and constants, no DOM and no network.

export interface LatLon {
  lat: number;
  lon: number;
}

/** One position from the device's GPS. `accuracy` is the radius in metres (68% confidence). */
export interface Fix extends LatLon {
  accuracy: number;
  /** When it was measured (ms since epoch). */
  at: number;
}

/** What the user can ask for. `any` is a mix of the everyday ones. */
export const PLACE_CATEGORIES = [
  "pharmacy",
  "hospital",
  "clinic",
  "restaurant",
  "cafe",
  "supermarket",
  "grocery",
  "atm",
  "bank",
  "bus_stop",
  "train_station",
  "hotel",
  "public_place",
  "shop",
  "any",
] as const;
export type PlaceCategory = (typeof PLACE_CATEGORIES)[number];
export type ConcreteCategory = Exclude<PlaceCategory, "any">;

export const isPlaceCategory = (v: unknown): v is PlaceCategory => typeof v === "string" && (PLACE_CATEGORIES as readonly string[]).includes(v);

/** A real place from OpenStreetMap. Fields that the map doesn't have are null, never guessed. */
export interface Place extends LatLon {
  /** Stable OpenStreetMap id, e.g. "n123" (node), "w45" (way). */
  osmId: string;
  name: string | null;
  category: ConcreteCategory;
  /** The raw OpenStreetMap value (pharmacy, fast_food, bus_stop…). */
  kind: string;
  address: string | null;
  openingHours: string | null;
  phone: string | null;
  wheelchair: string | null;
  /**
   * Why this may not really be what its category says (the map's tags are wrong or misleading), e.g.
   * a professional body tagged as a hospital. Null or absent: nothing contradicts the category.
   */
  doubt?: "name" | "office" | null;
}

/** One manoeuvre of a walking route, as the routing engine (OSRM) gives it. */
export interface RouteStep {
  /** OSRM manoeuvre type: depart, turn, continue, new name, end of road, fork, roundabout, arrive… */
  type: string;
  /** left, right, slight left, sharp right, straight, uturn… or null. */
  modifier: string | null;
  /** The street walked AFTER this manoeuvre ("" when the map has no name). */
  name: string;
  /** Metres from this manoeuvre to the next one. */
  distance: number;
  /** Seconds, the routing engine's estimate. */
  duration: number;
  /** Where the manoeuvre is. */
  location: LatLon;
  /** Roundabout exit number, when there is one. */
  exit: number | null;
}

export interface WalkingRoute {
  /** Metres. */
  distance: number;
  /** Seconds (the routing engine's walking estimate). */
  duration: number;
  /** The path to walk, start to end. */
  geometry: LatLon[];
  steps: RouteStep[];
}

/** Server answers for the browser. */
export interface ReverseResult {
  /** A short spoken address («نهج روما، باب بحر، تونس»), or null when the map has nothing. */
  label: string | null;
  road: string | null;
  houseNumber: string | null;
  neighbourhood: string | null;
  city: string | null;
  /** A named place at that exact spot (a building, a shop), when there is one. */
  name: string | null;
}

export interface NearbyResult {
  places: Place[];
  source: "overpass" | "nominatim";
  /** True when the fallback was used or the search was cut short: the list may miss places. */
  partial: boolean;
  radius: number;
}

export const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
