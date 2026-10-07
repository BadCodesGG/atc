import type { Airport } from "../airports";
import type { Subject } from "../filters";
import type { FlightRoute } from "../routes";
import { KNOTS, type Origin, toGeo, toLocal } from "../geo";
import type { RegionSnapshot } from "../region";
import type { TrackedAircraft } from "../tracker";
import type { Aircraft, TrafficSnapshot } from "../traffic";

/**
 * The live sky on the world map: the region cells read together become one snapshot for the Tracker
 * (which moves each aircraft smoothly between reads, as it does on the diorama), and the tracker's
 * aircraft become what the map draws, each told by what it is doing: arriving at or departing from one
 * of the built airports, on the ground, or cruising past.
 */

/** The map's own metres are measured from the middle of the contiguous US. */
export const MAP_ORIGIN: Origin = { latitude: 39, longitude: -96 };

export type SkyKind = "arriving" | "departing" | "ground" | "cruise";

/** Within this of a built airport, metres (60 NM), and below ARRIVAL_CEILING_FT above it, an aircraft is coming or going there. */
const ARRIVAL_RANGE_M = 111_000;
const ARRIVAL_CEILING_FT = 12_000;
/** Below this above the field an aircraft is in the circuit: which way it heads says whether it is coming or going. */
const CIRCUIT_FT = 4_000;
/** Climbing or descending faster than this, feet per minute, is a climb or a descent rather than level flight. */
const CLIMB_FPM = 300;
/** Heading within this of the airport's bearing is heading for it. */
const TOWARD_DEG = 75;
/** Slower than this on the ground is standing or taxiing: no trail. */
const TRAIL_MIN_KT = 40;

/**
 * The cells of one read as one snapshot in `origin`'s metres. Each aircraft appears once (neighbouring
 * cells overlap), timed by the newest cell. A fix is as old as its cell is older than the newest, plus
 * how long before its cell it was received, which is what the tracker places it back in time by; where
 * cells overlap, the freshest fix wins, whichever cell listed it. With `rebase`, recordings made at
 * different moments are treated as one moment, as the fixture needs.
 */
export function mergeRegions(regions: readonly RegionSnapshot[], origin: Origin, { rebase = false } = {}): Pick<TrafficSnapshot, "time" | "aircraft"> {
  const time = Math.max(...regions.map((r) => r.time));
  const byId = new Map<string, Aircraft>();
  for (const region of regions) {
    const cellAge = rebase ? 0 : time - region.time;
    for (const a of region.aircraft) {
      const age = cellAge + (a.positionAgeS ?? 0);
      const held = byId.get(a.id);
      if (held && held.positionAge <= age) continue;
      const [x, y] = toLocal(origin, a.latitude, a.longitude);
      byId.set(a.id, {
        id: a.id,
        callsign: a.callsign,
        registration: null,
        typeCode: a.typeCode,
        military: a.military,
        category: null,
        latitude: a.latitude,
        longitude: a.longitude,
        x,
        y,
        altitudeFt: a.altitudeFt ?? 0,
        onGround: a.onGround,
        groundSpeedKt: a.groundSpeedKt,
        trackDeg: a.trackDeg,
        verticalRateFpm: a.verticalRateFpm,
        positionAge: age,
        source: null,
        squawk: null,
      });
    }
  }
  return { time, aircraft: [...byId.values()] };
}

/** Degrees between two compass bearings, 0 to 180. */
const apart = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

/** What an aircraft is doing, as the map colours it. */
export function classify(
  a: { latitude: number; longitude: number; altitudeFt: number; onGround: boolean; verticalRateFpm: number | null; headingDeg: number },
  airports: readonly Airport[],
): SkyKind {
  if (a.onGround) return "ground";
  let nearest: { airport: Airport; distance: number; x: number; y: number } | null = null;
  for (const airport of airports) {
    // The aircraft in the airport's metres: x east, y north of it.
    const [x, y] = toLocal(airport, a.latitude, a.longitude);
    const distance = Math.hypot(x, y);
    if (distance < ARRIVAL_RANGE_M && (!nearest || distance < nearest.distance)) nearest = { airport, distance, x, y };
  }
  if (!nearest) return "cruise";
  const above = a.altitudeFt - nearest.airport.elevationFt;
  if (above > ARRIVAL_CEILING_FT) return "cruise";
  const toward = apart(a.headingDeg, (Math.atan2(-nearest.x, -nearest.y) * 180) / Math.PI) < TOWARD_DEG;
  const rate = a.verticalRateFpm;
  if (rate !== null && rate <= -CLIMB_FPM && toward) return "arriving";
  if (rate !== null && rate >= CLIMB_FPM && !toward) return "departing";
  if ((rate === null || Math.abs(rate) < CLIMB_FPM) && above < CIRCUIT_FT) return toward ? "arriving" : "departing";
  return "cruise";
}

interface Point<P> {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: P;
}

interface Line<P> {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: P;
}

export interface SkyFeatures {
  aircraft: { type: "FeatureCollection"; features: Point<{ id: string; kind: SkyKind; track: number; altitude: number; fade: number; muted?: true }>[] };
  trails: { type: "FeatureCollection"; features: Line<{ kind: SkyKind }>[] };
}

/** How much of its opacity an aircraft the filters leave out keeps once fully faded: a hint of where it is, not a thing to read. */
const MUTED_OPACITY = 0.14;
/** Faded past this much, an aircraft counts as filtered out: it is not in the count and has no trail. */
const MUTED_FROM = 0.5;

/**
 * The tracker's aircraft as the map draws them: a point turned to its heading, and a trail back along
 * it as far as it flies in `trailSeconds`, tail first so the line fades in toward the aircraft. `ghost`
 * says how far the filters have faded an aircraft out (0 shown, 1 left out).
 */
export function skyFeatures(tracked: readonly TrackedAircraft[], origin: Origin, airports: readonly Airport[], trailSeconds: number, ghost: (a: TrackedAircraft, kind: SkyKind) => number = () => 0): SkyFeatures {
  const aircraft: SkyFeatures["aircraft"]["features"] = [];
  const trails: SkyFeatures["trails"]["features"] = [];
  for (const a of tracked) {
    const [latitude, longitude] = toGeo(origin, a.x, a.y);
    const kind = classify({ latitude, longitude, altitudeFt: a.altitudeFt, onGround: a.onGround, verticalRateFpm: a.verticalRateFpm, headingDeg: a.headingDeg }, airports);
    const g = ghost(a, kind);
    const muted = g >= MUTED_FROM;
    aircraft.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [longitude, latitude] },
      properties: { id: a.id, kind, track: a.headingDeg, altitude: a.altitudeFt, fade: g > 0 ? a.fade * (1 - g * (1 - MUTED_OPACITY)) : a.fade, ...(muted && { muted: true as const }) },
    });
    const speed = (a.groundSpeedKt ?? 0) * KNOTS;
    if (muted || !a.headingKnown || (a.groundSpeedKt ?? 0) < TRAIL_MIN_KT) continue;
    const h = (a.headingDeg * Math.PI) / 180;
    const back = speed * trailSeconds;
    const [tailLat, tailLon] = toGeo(origin, a.x - Math.sin(h) * back, a.y - Math.cos(h) * back);
    trails.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[tailLon, tailLat], [longitude, latitude]] },
      properties: { kind },
    });
  }
  return { aircraft: { type: "FeatureCollection", features: aircraft }, trails: { type: "FeatureCollection", features: trails } };
}

/** How many of the drawn aircraft are inside `bounds`, degrees, and how many of those the filters leave showing: the header's "N aircraft in view". */
export function countInView(aircraft: SkyFeatures["aircraft"], bounds: Bounds): { shown: number; total: number } {
  let shown = 0;
  let total = 0;
  for (const { geometry, properties } of aircraft.features) {
    if (!inBounds(geometry.coordinates, bounds)) continue;
    total++;
    if (!properties.muted) shown++;
  }
  return { shown, total };
}

type Bounds = { west: number; east: number; south: number; north: number };

function inBounds([lng, lat]: [number, number], bounds: Bounds): boolean {
  return lng >= bounds.west && lng <= bounds.east && lat >= bounds.south && lat <= bounds.north;
}

/** Slower than this on the ground is standing; the map cannot tell a gate from a hold, so a standing aircraft counts as at the gate. */
const STANDING_KT = 3;

/**
 * What an aircraft on the map looks like to the filters. The map has no ground plan, so its ground states
 * are coarser than the diorama's: a standing aircraft is at the gate, a moving one taxiing, none is
 * holding, and one cruising past is in no state at all.
 */
export function skySubject(a: TrackedAircraft, kind: SkyKind, route: FlightRoute | null): Subject {
  return {
    callsign: a.callsign,
    typeCode: a.typeCode,
    military: a.military,
    state: kind === "cruise" ? null : kind === "ground" ? ((a.groundSpeedKt ?? 0) < STANDING_KT ? "gate" : "taxiing") : kind,
    onGround: a.onGround,
    altitudeFt: a.altitudeFt,
    speedKt: a.groundSpeedKt,
    origin: route?.origin.code ?? null,
    destination: route?.destination.code ?? null,
  };
}

/** The filter subjects of the tracked aircraft whose drawn features (same order) are inside `bounds`: what the filters offer. */
/** The military aircraft among those drawn in view: who they are, for an alert. */
export function militaryInView(tracked: readonly TrackedAircraft[], aircraft: SkyFeatures["aircraft"], bounds: Bounds): { id: string; callsign: string | null; typeCode: string | null }[] {
  const out: { id: string; callsign: string | null; typeCode: string | null }[] = [];
  tracked.forEach((a, i) => {
    if (a.military && inBounds(aircraft.features[i].geometry.coordinates, bounds)) out.push({ id: a.id, callsign: a.callsign, typeCode: a.typeCode });
  });
  return out;
}

export function subjectsInView(tracked: readonly TrackedAircraft[], aircraft: SkyFeatures["aircraft"], bounds: Bounds, routeOf: (callsign: string | null) => FlightRoute | null): Subject[] {
  const out: Subject[] = [];
  tracked.forEach((a, i) => {
    const f = aircraft.features[i];
    if (inBounds(f.geometry.coordinates, bounds)) out.push(skySubject(a, f.properties.kind, routeOf(a.callsign)));
  });
  return out;
}
