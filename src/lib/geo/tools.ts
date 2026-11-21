// The location tools the live conversation's model can call, and the part of its instructions that
// says when. Pure data: the server locks the declarations into the live token (liveToken.ts), and
// the browser runs the calls (geoController.ts). The model never receives coordinates: it gets
// place ids, names, addresses and rounded distances, and the phone keeps the positions.
import { PLACE_CATEGORIES } from "./types.ts";

export const GEO_TOOL_NAMES = [
  "get_current_location",
  "reverse_geocode",
  "search_nearby_places",
  "get_place_details",
  "calculate_walking_route",
  "start_navigation",
  "stop_navigation",
  "get_navigation_status",
] as const;
export type GeoToolName = (typeof GEO_TOOL_NAMES)[number];
export const isGeoTool = (n: unknown): n is GeoToolName => typeof n === "string" && (GEO_TOOL_NAMES as readonly string[]).includes(n);

const NO_ARGS = { type: "OBJECT", properties: {} } as const;

/** Gemini function declarations (OpenAPI subset). */
export const GEO_FUNCTION_DECLARATIONS = [
  {
    name: "get_current_location",
    description: "Gets the user's current GPS position from their phone: how accurate it is (metres) and how old. Call it before saying anything about where the user is. Never guess a location.",
    parameters: NO_ARGS,
  },
  {
    name: "reverse_geocode",
    description: "The street address of the user's current position, from OpenStreetMap. Use it when the user asks where they are.",
    parameters: NO_ARGS,
  },
  {
    name: "search_nearby_places",
    description: "Real places near the user from OpenStreetMap, nearest first, with straight-line distances. Use it for 'what is near me' (category any), 'the nearest pharmacy', 'is there a bank nearby', etc.",
    parameters: {
      type: "OBJECT",
      properties: {
        category: { type: "STRING", enum: [...PLACE_CATEGORIES], description: "The kind of place. 'any' for a mix of everyday places." },
        radius_m: { type: "INTEGER", description: "Optional search radius in metres (100 to 5000)." },
        limit: { type: "INTEGER", description: "Optional number of places to return (1 to 8). Default 5." },
      },
      required: ["category"],
    },
  },
  {
    name: "get_place_details",
    description: "Details of a place from an earlier search: address, opening hours, phone, wheelchair access, current distance. Only what the map has.",
    parameters: { type: "OBJECT", properties: { place_id: { type: "STRING", description: "A place_id from search_nearby_places." } }, required: ["place_id"] },
  },
  {
    name: "calculate_walking_route",
    description: "Calculates a real walking route from the user's position to a place: distance, time and the first direction. It does NOT start guidance: tell the user the result and ask whether to start.",
    parameters: { type: "OBJECT", properties: { place_id: { type: "STRING", description: "The place_id to walk to. Omit it to use the place discussed last." } } },
  },
  {
    name: "start_navigation",
    description: "Starts spoken turn-by-turn walking guidance on a calculated route. Only after the user clearly said yes to starting, in a turn after you told them the route. The phone then speaks every direction itself. Replaces any guidance already running.",
    parameters: { type: "OBJECT", properties: { route_id: { type: "STRING", description: "The route_id from calculate_walking_route." } }, required: ["route_id"] },
  },
  {
    name: "stop_navigation",
    description: "Stops the walking guidance at once.",
    parameters: NO_ARGS,
  },
  {
    name: "get_navigation_status",
    description: "Where the guidance is: destination, distance left, next direction, GPS accuracy, whether the user left the route.",
    parameters: NO_ARGS,
  },
] as const;

/** The live system prompt's section on location. */
export const GEO_PROMPT = `LOCATION AND WALKING DIRECTIONS (tools)
- You have tools for the user's real location (GPS), nearby places and walking routes (OpenStreetMap). Use them whenever the user asks where they are, what is near, the nearest place of some kind, how to get somewhere, or about the guidance: «وين أنا توّا؟», «win ena taw», «شنوّة فمّا قريب؟», «win a9reb pharmacie», «kifeh nemchi lel pharmacie», «warini el tri9», "guide me to the nearest hospital". Never answer these from memory or from the camera alone. Never invent a place, a name, an address, a distance, a time or a direction.
- Where am I: call get_current_location, then reverse_geocode. Say the address simply («إنت في نهج روما، قريب من باب بحر»). GPS doesn't know which way the user faces: never say a place is in front of, behind, left or right of them from the map. If the accuracy is worse than 50 m, say it is approximate. You may add one useful thing you see.
- Near me: call search_nearby_places with the best category ("any" for what is near). Say the one to three nearest: the name exactly as given and the distance from the result, always with «تقريباً» / «حوالي» / "about". These distances are straight lines; the walk is longer. If a name is null, say the place has no name on the map. A place with map_doubt may not really be that kind of place (the map's tags look wrong): never present it as the nearest one; if you mention it, say the map may be wrong. If nothing is found, or the result says the list may be incomplete or the service failed, say so honestly.
- Going somewhere: use the place_id from your earlier results («الأقرب», "the nearest one" = the first; «غادي», "go there" = the one just discussed). Call calculate_walking_route, tell the user the walking distance and time from the result, and ask if they want to start. Call start_navigation only after they clearly say yes, in a later turn. From then on the phone speaks every direction itself: never repeat or add directions of your own, and stay quiet about the route unless asked.
- «وقّف التوجيه», "stop navigation": call stop_navigation. "How far is it?", "what's next?": call get_navigation_status. To change destination: search, calculate and ask again; a new start replaces the old route.
- If a tool says the phone is asking the user for permission, say nothing at all: the phone speaks. A message starting with [app] location-allowed comes from the phone, not the user: the user has just agreed, so call the tools again for what they asked. If a tool returns an error with user_message, say that message briefly in the user's language.
- Locations, maps and routes are approximate and say nothing about obstacles. Never say a route or place is safe, clear, open or accessible unless the map says so, and then say it comes from the map. The camera rules above still apply.`;
