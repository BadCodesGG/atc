import type { Airport } from "./airports";
import { airportFromParam, withAirport } from "./airport-url";
import { type Filters, readFilters, withFilters } from "./filters";
import { type CameraMode, MODES } from "./scene/cameras";
import { type ThemeKey, themeKey } from "./scene/theme";

/**
 * A link that opens the view it was made from: the airport or the map's position, the selected flight,
 * the camera mode, the theme and the filters. Built from the page's own address, so it reuses what the
 * page already reads (`?airport=`, `?flight=`, `?theme=`, the map's hash) and keeps any other parameter,
 * a fixture's included. Replay time is not in it: the replay holds only what the page has seen since it
 * opened, so there is nothing for another reader's page to open on.
 */

/** Where the world map is looking: MapLibre's own hash, `#map=zoom/lat/lng/bearing/pitch`. */
export interface MapHash {
  zoom: number;
  lat: number;
  lng: number;
  bearing: number;
  pitch: number;
}

export interface ShareView {
  airport: Airport["code"];
  theme: ThemeKey;
  /** The selected flight's callsign (its hex, upper case, where it has none), or null: the diorama's or the map's. */
  flight: string | null;
  /** The diorama's camera mode. */
  camera: CameraMode;
  filters: Filters;
  /** Set when the world map leads: the link then opens on the map, there. */
  map: MapHash | null;
}

const MAX_ZOOM = 24;
const MAX_PITCH = 85;

/**
 * Reads the map's view out of an address hash. Defensive: a hash the map wrote with a NaN in it, or one
 * made by hand, is read as no view at all rather than handed to the map, which would throw on it.
 */
export function parseMapHash(hash: string): MapHash | null {
  const raw = /(?:^#|&)map=([^&]*)/.exec(hash)?.[1];
  if (!raw) return null;
  const parts = raw.split("/");
  if (parts.length < 3 || parts.length > 5) return null;
  const nums = parts.map((p) => (/^-?\d+(\.\d+)?$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [zoom, lat, lng, bearing = 0, pitch = 0] = nums;
  if (zoom < 0 || zoom > MAX_ZOOM || Math.abs(lat) > 90 || Math.abs(lng) > 360 || pitch < 0 || pitch > MAX_PITCH) return null;
  return { zoom, lat, lng, bearing, pitch };
}

/** The hash the map reads for a view: bearing and pitch only when they are not nothing. */
export function formatMapHash(h: MapHash): string {
  const tail = h.pitch !== 0 ? `/${h.bearing}/${h.pitch}` : h.bearing !== 0 ? `/${h.bearing}` : "";
  return `#map=${h.zoom}/${h.lat}/${h.lng}${tail}`;
}

/**
 * The address for a view, from the address the page is at now: the parameters the view owns are set or
 * removed, every other kept. A map view takes the hash and the flight selected on it, and leaves out the camera.
 */
export function shareLink(href: string, view: ShareView): URL {
  const url = withFilters(withAirport(href, view.airport).href, view.filters);
  const set = (key: string, value: string | null) => (value ? url.searchParams.set(key, value) : url.searchParams.delete(key));
  set("theme", view.theme === "light" ? null : view.theme);
  set("flight", view.flight);
  set("camera", view.map || view.camera === "orbit" ? null : view.camera);
  url.hash = view.map ? formatMapHash(view.map) : "";
  return url;
}

/** The view an address opens on: what shareLink wrote, with the page's own defaults for anything missing or not valid. */
export function readShareView(href: string): ShareView {
  const url = new URL(href);
  const camera = url.searchParams.get("camera");
  return {
    airport: airportFromParam(url.searchParams.get("airport")).code,
    theme: themeKey(url.searchParams.get("theme")),
    flight: url.searchParams.get("flight")?.trim().toUpperCase() || null,
    camera: MODES.find((m) => m === camera) ?? "orbit",
    filters: readFilters(Object.fromEntries(url.searchParams)),
    map: parseMapHash(url.hash),
  };
}
