import { toLocal } from "../geo";
import type { FlightRoute } from "../routes";
import { greatCircle } from "./arcs";
import type { Coord } from "./track-history";

/**
 * The selected aircraft's path on the map, in three parts that say how much of it is known. The observed
 * line is the track this page actually saw. The origin airport to where that track begins, and the
 * aircraft to its destination, are only great circles between airports: estimates, drawn fainter and
 * dashed so they are never read as flown or planned. With no route there is only the observed line.
 */

export interface SelectedPath {
  /** The origin airport to the first point seen: estimated, empty with no origin or nothing between. */
  from: Coord[];
  /** The track seen, ending at the aircraft. */
  observed: Coord[];
  /** The aircraft to its destination: estimated, empty with no destination or none left to fly. */
  ahead: Coord[];
}

/** An estimate shorter than this, metres, is the airport the track starts at (or ends at): nothing to draw. */
const MIN_ESTIMATE_M = 8_000;
/** Metres a great circle is cut into one segment per. */
const SEGMENT_M = 40_000;

const placed = (end: FlightRoute["origin"]): Coord | null => (end.latitude === undefined || end.longitude === undefined ? null : [end.longitude, end.latitude]);
const metres = (a: Coord, b: Coord) => Math.hypot(...toLocal({ latitude: a[1], longitude: a[0] }, b[1], b[0]));

function estimate(a: Coord, b: Coord): Coord[] {
  const d = metres(a, b);
  return d < MIN_ESTIMATE_M ? [] : greatCircle(a, b, Math.min(96, Math.max(2, Math.ceil(d / SEGMENT_M))));
}

/** `track` is what was seen (oldest first), `aircraft` where it is drawn now. */
export function selectedPath(track: readonly Coord[], aircraft: Coord, route: FlightRoute | null): SelectedPath {
  const last = track.at(-1);
  // The line runs on to the aircraft as drawn, so it never stops short of the glyph.
  const observed = last && metres(last, aircraft) < 1 ? [...track] : [...track, aircraft];
  const origin = route && placed(route.origin);
  const destination = route && placed(route.destination);
  return {
    from: origin ? estimate(origin, observed[0]) : [],
    observed,
    ahead: destination ? estimate(aircraft, destination) : [],
  };
}

export type SelectionFeatures = {
  type: "FeatureCollection";
  features: (
    | { type: "Feature"; geometry: { type: "LineString"; coordinates: Coord[] }; properties: { part: "from" | "observed" | "ahead" } }
    | { type: "Feature"; geometry: { type: "Point"; coordinates: Coord }; properties: { part: "aircraft"; track: number; altitude: number; lost: boolean } }
  )[];
};

/** The path and the aircraft as the map's selection source holds them: the aircraft at its height, so it can be drawn to the traffic's scale, and `lost` once it has left the feed. */
export function selectionFeatures(path: SelectedPath, aircraft: Coord, headingDeg: number, altitudeFt: number, lost = false): SelectionFeatures {
  const features: SelectionFeatures["features"] = [];
  for (const part of ["from", "observed", "ahead"] as const) {
    if (path[part].length > 1) features.push({ type: "Feature", geometry: { type: "LineString", coordinates: path[part] }, properties: { part } });
  }
  features.push({ type: "Feature", geometry: { type: "Point", coordinates: aircraft }, properties: { part: "aircraft", track: headingDeg, altitude: altitudeFt, lost } });
  return { type: "FeatureCollection", features };
}

/** Whether any of the path is an estimate, which the card then says. */
export const isEstimated = (path: SelectedPath): boolean => path.from.length > 1 || path.ahead.length > 1;
