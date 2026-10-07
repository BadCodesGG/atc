import { callsignFor } from "./airline-codes";
import { type FlightRoute, parseRoute, routeUrl } from "./routes";
import { type Read, upstream, UpstreamStatusError } from "./upstream";

/**
 * One flight anywhere, by callsign, from adsb.lol (free, no key, ODbL) or adsb.fi when adsb.lol cannot
 * answer (upstream.ts): `GET /v2/callsign/{callsign}` lists the aircraft sending that callsign right now. The callsign comes from a person's typing, so it
 * is upper-cased, a flight number is turned into its callsign, and only a value that passes
 * `lookupCallsign` ever reaches a URL.
 */

/** Callsigns as ADS-B sends them: letters and digits, at most eight. */
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

/** The callsign to ask about for what was typed ("dl3104" is "DAL3104"), or null when it cannot be one. */
export function lookupCallsign(input: string): string | null {
  const callsign = callsignFor(input);
  return CALLSIGN.test(callsign) ? callsign : null;
}

/** An aircraft in the air, wherever it is. */
export interface RemoteFlight {
  callsign: string | null;
  registration: string | null;
  typeCode: string | null;
  latitude: number;
  longitude: number;
  /** Feet above mean sea level (barometric, else geometric). */
  altitudeFt: number;
  groundSpeedKt: number | null;
}

/** What the flight route answers with: the flight, and its route where adsbdb knows it. */
export interface FlightAnswer extends RemoteFlight {
  route: FlightRoute | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The first aircraft in an upstream answer that is in the air and has a position, or null when none is. */
export function parseCallsignResponse(json: unknown): RemoteFlight | null {
  if (typeof json !== "object" || json === null) return null;
  const list = (json as Record<string, unknown>).ac;
  if (!Array.isArray(list)) return null;
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const latitude = num(r.lat);
    const longitude = num(r.lon);
    const altitudeFt = r.alt_baro === "ground" ? null : (num(r.alt_baro) ?? num(r.alt_geom));
    if (latitude === null || longitude === null || altitudeFt === null) continue;
    return { callsign: str(r.flight), registration: str(r.r), typeCode: str(r.t), latitude, longitude, altitudeFt, groundSpeedKt: num(r.gs) };
  }
  return null;
}

export type Fetcher = (url: string) => Promise<{ status: number; body: unknown }>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6_000),
    cache: "no-store",
    headers: { "User-Agent": "atc (live airport visualisation)", Accept: "application/json" },
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

export type FlightLookup = { kind: "bad" } | { kind: "none" } | { kind: "found"; flight: FlightAnswer };

/**
 * Finds a typed flight. Throws when neither adsb.lol nor adsb.fi can answer (an outage must not read
 * as "not airborne"); a 404, or an answer listing nothing in the air, is "none". A failed route lookup
 * only leaves the route out.
 */
export async function findFlight(input: string, read: Read = upstream.read, get: Fetcher = defaultFetcher): Promise<FlightLookup> {
  const callsign = lookupCallsign(input);
  if (!callsign) return { kind: "bad" };
  let body: unknown;
  try {
    body = JSON.parse((await read({ kind: "callsign", callsign })).body);
  } catch (error) {
    if (error instanceof UpstreamStatusError && error.status === 404) return { kind: "none" };
    throw error;
  }
  const flight = parseCallsignResponse(body);
  if (!flight) return { kind: "none" };
  let route: FlightRoute | null = null;
  try {
    const routeEndpoint = routeUrl(callsign);
    const answer = routeEndpoint ? await get(routeEndpoint) : null;
    route = answer?.status === 200 ? parseRoute(answer.body) : null;
  } catch {
    // The route is a nicety; the flight is still found.
  }
  return { kind: "found", flight: { ...flight, route } };
}
