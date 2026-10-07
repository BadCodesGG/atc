import type { Airport } from "./airports";
import { toLocal } from "./geo";
import type { FlightRoute } from "./routes";
import { pointQuery, type Query, type Read, type ReadOptions, upstream } from "./upstream";

/**
 * Live aircraft around an airport from adsb.lol (free, no key, ODbL), or adsb.fi when adsb.lol cannot
 * answer (upstream.ts): a point and radius returns every aircraft the receivers have heard. Nearly
 * every field is optional upstream, so nothing here is trusted until it has been checked.
 */

/** Default search radius, nautical miles. 20 NM is 37 km, inside the 40 km the parser keeps. */
export const RADIUS_NM = 20;

/** Older than this, a position says little about where the aircraft is now. */
export const MAX_POSITION_AGE = 60;

/** Aircraft farther than this from the reference point are outside the scene. */
export const MAX_RANGE_M = 40_000;

/** Within this of field elevation, and slow, counts as on the ground when the flag is not set. */
const GROUND_BAND_FT = 50;
const GROUND_SPEED_KT = 40;

export interface Aircraft {
  /** ICAO 24-bit address, lower-case hex (a leading `~` marks a non-ICAO TIS-B address). */
  id: string;
  callsign: string | null;
  registration: string | null;
  /** ICAO type designator, e.g. `A321`. */
  typeCode: string | null;
  /** Flagged military in adsb.lol's aircraft database. */
  military: boolean;
  /** ADS-B emitter category: A1..A7, B*, C1 surface emergency vehicle, C2 surface service vehicle, C3 obstacle. */
  category: string | null;
  latitude: number;
  longitude: number;
  /** Metres east and north of the airport reference point. */
  x: number;
  y: number;
  /** Feet above mean sea level; 0 on the ground. */
  altitudeFt: number;
  onGround: boolean;
  groundSpeedKt: number | null;
  /** Degrees true: the track, or the heading when only that is broadcast. */
  trackDeg: number | null;
  verticalRateFpm: number | null;
  /** Seconds between the position fix and the snapshot time. */
  positionAge: number;
  /** How the position was obtained: `adsb_icao`, `mlat`, `tisb_icao`, `adsr_icao`, `mode_s`... */
  source: string | null;
  squawk: string | null;
}

export interface TrafficSnapshot {
  airport: Airport["code"];
  /** UTC seconds the upstream built the response. */
  time: number;
  aircraft: Aircraft[];
  /** Where the flights are going and coming from, by callsign, as far as known (added by the API route). */
  routes?: Record<string, FlightRoute>;
  /** Set by the API route when the upstream failed and this is the last good answer, `ageS` seconds old. */
  stale?: boolean;
  ageS?: number;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

function parseAircraft(raw: unknown, airport: Airport): Aircraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.hex)?.toLowerCase();
  const latitude = num(r.lat);
  const longitude = num(r.lon);
  if (!id || latitude === null || longitude === null) return null;

  const positionAge = num(r.seen_pos) ?? num(r.seen) ?? 0;
  if (positionAge < 0 || positionAge > MAX_POSITION_AGE) return null;
  const [x, y] = toLocal(airport, latitude, longitude);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) > MAX_RANGE_M) return null;

  const groundSpeedKt = num(r.gs);
  const altitude = num(r.alt_baro) ?? num(r.alt_geom);
  const flaggedGround = r.alt_baro === "ground";
  // With no altitude at all an airborne aircraft cannot be placed in the scene.
  if (!flaggedGround && altitude === null) return null;
  const onGround =
    flaggedGround || (altitude !== null && Math.abs(altitude - airport.elevationFt) < GROUND_BAND_FT && groundSpeedKt !== null && groundSpeedKt < GROUND_SPEED_KT);

  return {
    id,
    callsign: str(r.flight),
    registration: str(r.r),
    typeCode: str(r.t),
    military: ((num(r.dbFlags) ?? 0) & 1) === 1,
    category: str(r.category),
    latitude,
    longitude,
    x,
    y,
    altitudeFt: onGround ? 0 : (altitude ?? 0),
    onGround,
    groundSpeedKt,
    trackDeg: num(r.track) ?? num(r.true_heading),
    verticalRateFpm: num(r.baro_rate) ?? num(r.geom_rate),
    positionAge,
    source: str(r.type),
    squawk: str(r.squawk),
  };
}

/** Throws when the body is not an adsb.lol response: an outage must not read as an empty sky. */
export function parseTraffic(json: unknown, airport: Airport): TrafficSnapshot {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error("traffic: response is not an object");
  const body = json as Record<string, unknown>;
  const now = num(body.now);
  if (now === null) throw new Error("traffic: response has no time");
  if (!Array.isArray(body.ac)) throw new Error("traffic: response has no aircraft list");

  // A hex listed twice (two receivers, or a bad merge) keeps its freshest report.
  const freshest = new Map<string, Aircraft>();
  for (const raw of body.ac) {
    const a = parseAircraft(raw, airport);
    if (!a) continue;
    const seen = freshest.get(a.id);
    if (!seen || a.positionAge < seen.positionAge) freshest.set(a.id, a);
  }
  // adsb.lol stamps `now` in milliseconds.
  return { airport: airport.code, time: now / 1000, aircraft: [...freshest.values()] };
}

export function trafficQuery(airport: Airport, radiusNm = RADIUS_NM): Query {
  return pointQuery(airport.latitude, airport.longitude, radiusNm);
}

export async function fetchTraffic(airport: Airport, read: Read = upstream.read, options?: ReadOptions): Promise<TrafficSnapshot> {
  return parseTraffic(JSON.parse((await read(trafficQuery(airport), options)).body), airport);
}
