import type { Airport } from "./airports";
import { toLocal } from "./geo";
import { MAX_POSITION_AGE, num, RADIUS_NM, str } from "./traffic";
import { pointQuery, type Query, type Read, type ReadOptions, upstream } from "./upstream";

/**
 * The live aircraft over a region, for the map between the world view and an airport. The world is
 * cut into a fixed grid and each cell is one adsb.lol query at a fixed radius around its centre, so
 * every reader looking at the same part of the world shares the same few upstream reads.
 */

/** Degrees of latitude and longitude between cell centres. */
export const CELL_DEG = 4;
/**
 * The radius each cell asks for, nautical miles: enough to reach the cell's corners at the equator
 * (170 NM) with an airport's 20 NM circle beyond them, inside adsb.lol's 250 NM limit.
 */
export const REGION_RADIUS_NM = 200;
/** The farthest north or south a cell centre goes: the grid stops short of the poles. */
const MAX_CELL_LAT = 88;

/** A grid cell, by its centre. */
export interface Cell {
  latitude: number;
  longitude: number;
}

/** One aircraft as the map draws it. */
export interface RegionAircraft {
  id: string;
  callsign: string | null;
  typeCode: string | null;
  /** Flagged military in adsb.lol's aircraft database (the first bit of dbFlags). */
  military: boolean;
  latitude: number;
  longitude: number;
  /** Feet above mean sea level; 0 on the ground, null when not broadcast. */
  altitudeFt: number | null;
  onGround: boolean;
  groundSpeedKt: number | null;
  /** Degrees true. */
  trackDeg: number | null;
  /** Feet per minute, up positive. */
  verticalRateFpm: number | null;
  /**
   * Seconds before the response's `time` that this position was received (adsb.lol's `seen_pos`): a fix up
   * to MAX_POSITION_AGE old is kept, so the map must place it back in time as the diorama does. Absent in
   * an answer a CDN still holds from before the field existed, which reads as current.
   */
  positionAgeS?: number;
}

export interface RegionSnapshot {
  cell: Cell;
  /** UTC seconds the upstream built the response. */
  time: number;
  aircraft: RegionAircraft[];
}

/** Adding 0 turns -0 into 0, so a cell has one spelling and one cache entry. */
const snap = (deg: number) => Math.round(deg / CELL_DEG) * CELL_DEG + 0;

function normaliseLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180 + 0;
}

export function cellAt(latitude: number, longitude: number): Cell {
  return { latitude: Math.max(-MAX_CELL_LAT, Math.min(MAX_CELL_LAT, snap(latitude))), longitude: normaliseLon(snap(longitude)) };
}

export function cellOf(airport: Airport): Cell {
  return cellAt(airport.latitude, airport.longitude);
}

/** A plain decimal: `Number()` alone would take "", " ", "0x10" and "1e2". */
const DECIMAL = /^-?\d{1,3}(\.\d{1,12})?$/;

/** The one address of a cell's answer: `/api/region?lat=32&lon=-84`, in this order, the cell's own numbers as they print. The map asks it, and the route sends anything else here. */
export function regionPath(cell: Cell): string {
  return `/api/region?lat=${cell.latitude}&lon=${cell.longitude}`;
}

/** The cell a `?lat=&lon=` query falls in, or null when either is not a decimal number in range. */
export function readCell(params: URLSearchParams): Cell | null {
  const lat = params.get("lat");
  const lon = params.get("lon");
  if (lat === null || lon === null || !DECIMAL.test(lat) || !DECIMAL.test(lon)) return null;
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  return cellAt(latitude, longitude);
}

/** Built from the snapped cell only, never from what the request said. */
export function regionQuery(cell: Cell): Query {
  return pointQuery(cell.latitude, cell.longitude, REGION_RADIUS_NM);
}

function parseAircraft(raw: unknown): RegionAircraft | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.hex)?.toLowerCase();
  const latitude = num(r.lat);
  const longitude = num(r.lon);
  if (!id || latitude === null || longitude === null) return null;
  const positionAge = num(r.seen_pos) ?? num(r.seen) ?? 0;
  if (positionAge < 0 || positionAge > MAX_POSITION_AGE) return null;
  const onGround = r.alt_baro === "ground";
  return {
    id,
    callsign: str(r.flight),
    typeCode: str(r.t),
    military: ((num(r.dbFlags) ?? 0) & 1) === 1,
    latitude,
    longitude,
    altitudeFt: onGround ? 0 : (num(r.alt_baro) ?? num(r.alt_geom)),
    onGround,
    groundSpeedKt: num(r.gs),
    trackDeg: num(r.track) ?? num(r.true_heading),
    verticalRateFpm: num(r.baro_rate) ?? num(r.geom_rate),
    positionAgeS: positionAge,
  };
}

/**
 * The aircraft in an adsb.lol answer as the map draws them, whatever was asked (a point, one hex), each
 * once, at its freshest. Throws when the body is not an adsb.lol response: an outage must not read as
 * an empty sky.
 */
export function parseAircraftList(json: unknown, name = "region"): { time: number; aircraft: RegionAircraft[] } {
  if (typeof json !== "object" || json === null || Array.isArray(json)) throw new Error(`${name}: response is not an object`);
  const body = json as Record<string, unknown>;
  const now = num(body.now);
  if (now === null) throw new Error(`${name}: response has no time`);
  if (!Array.isArray(body.ac)) throw new Error(`${name}: response has no aircraft list`);
  const freshest = new Map<string, { a: RegionAircraft; age: number }>();
  for (const raw of body.ac) {
    const a = parseAircraft(raw);
    if (!a) continue;
    const r = raw as Record<string, unknown>;
    const age = num(r.seen_pos) ?? num(r.seen) ?? 0;
    const seen = freshest.get(a.id);
    if (!seen || age < seen.age) freshest.set(a.id, { a, age });
  }
  // adsb.lol stamps `now` in milliseconds.
  return { time: now / 1000, aircraft: [...freshest.values()].map((f) => f.a) };
}

/** Throws when the body is not an adsb.lol response: an outage must not read as an empty sky. */
export function parseRegion(json: unknown, cell: Cell): RegionSnapshot {
  return { cell, ...parseAircraftList(json) };
}

export async function fetchRegion(cell: Cell, read: Read = upstream.read, options?: ReadOptions): Promise<RegionSnapshot> {
  return parseRegion(JSON.parse((await read(regionQuery(cell), options)).body), cell);
}

/** The cells whose ground a map view shows. `east` may run past 180 where the view crosses the antimeridian. */
export function cellsCovering(bounds: { west: number; south: number; east: number; north: number }): Cell[] {
  const cells = new Map<string, Cell>();
  const south = Math.max(-MAX_CELL_LAT, snap(bounds.south));
  const north = Math.min(MAX_CELL_LAT, snap(bounds.north));
  for (let lat = south; lat <= north; lat += CELL_DEG) {
    for (let lon = snap(bounds.west); lon <= snap(bounds.east); lon += CELL_DEG) {
      const cell = cellAt(lat, lon);
      cells.set(`${cell.latitude}/${cell.longitude}`, cell);
    }
  }
  return [...cells.values()];
}

/** An airport's live count is the traffic within the same radius the airport's own view asks for. */
const COUNT_RADIUS_M = RADIUS_NM * 1852;

export interface AirportCount {
  total: number;
  ground: number;
}

/** How many of these aircraft are within 20 NM of each airport, and how many of those are on the ground. */
export function countsNear(
  airports: readonly Airport[],
  aircraft: readonly Pick<RegionAircraft, "latitude" | "longitude" | "onGround">[],
): Partial<Record<Airport["code"], AirportCount>> {
  const counts: Partial<Record<Airport["code"], AirportCount>> = {};
  for (const airport of airports) {
    const count = { total: 0, ground: 0 };
    for (const a of aircraft) {
      const [x, y] = toLocal(airport, a.latitude, a.longitude);
      if (Math.hypot(x, y) > COUNT_RADIUS_M) continue;
      count.total++;
      if (a.onGround) count.ground++;
    }
    counts[airport.code] = count;
  }
  return counts;
}
