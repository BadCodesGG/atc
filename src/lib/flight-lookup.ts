import { callsignFor } from "./airline-codes";
import { readHex } from "./hex";
import { type FlightRoute, parseRoute, routeUrl } from "./routes";
import { type Query, type Read, upstream, UpstreamStatusError } from "./upstream";

/**
 * One flight anywhere, by callsign or tail number, from adsb.lol (free, no key, ODbL) or adsb.fi when
 * adsb.lol cannot answer (upstream.ts): `GET /v2/callsign/{callsign}` lists the aircraft sending that
 * callsign right now, and the registration lookup the aircraft registered as that tail. The value comes
 * from a person's typing, so it is upper-cased, a flight number is turned into its callsign, and only a
 * value that passes `lookupCallsign` or `lookupRegistration` ever reaches a URL.
 */

/** Callsigns as ADS-B sends them: letters and digits, at most eight. */
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

/** The callsign to ask about for what was typed ("dl3104" is "DAL3104"), or null when it cannot be one. */
export function lookupCallsign(input: string): string | null {
  const callsign = callsignFor(input);
  return CALLSIGN.test(callsign) ? callsign : null;
}

/**
 * Tail numbers worth asking the registration lookup about: a US N-number ("N3596W": N, a digit other
 * than 0, up to four more), a prefix and mark joined by the hyphen the feeds keep ("G-ZBKJ", "9H-ABC",
 * "B-1234"; asked for without it they find nothing), and the Japanese and Korean marks written without
 * one ("JA8089", "HL7611"). Many GA aircraft send their tail as their callsign; airliners never do.
 */
const REGISTRATION = /^(?:N[1-9][0-9A-Z]{0,4}|[A-Z0-9]{1,2}-[A-Z0-9]{1,5}|(?:JA|HL)[0-9][0-9A-Z]{3})$/;

/** The tail number to ask about for what was typed, upper-cased, or null when it cannot be one. */
export function lookupRegistration(input: string): string | null {
  const registration = input.trim().toUpperCase();
  return REGISTRATION.test(registration) ? registration : null;
}

/**
 * The one spelling a typed flight is looked up and remembered by: the callsign it names ("dl3104" is
 * "DAL3104"), else the tail it names ("g-zbkj" is "G-ZBKJ"), else null.
 */
export function flightKey(input: string): string | null {
  return lookupCallsign(input) ?? lookupRegistration(input);
}

/** An aircraft in the air, wherever it is. */
export interface RemoteFlight {
  /** Its ICAO address, lower case, which the world map finds it by; null when the answer's is not one. */
  hex: string | null;
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
    const hex = str(r.hex);
    return { hex: hex && readHex(hex), callsign: str(r.flight), registration: str(r.r), typeCode: str(r.t), latitude, longitude, altitudeFt, groundSpeedKt: num(r.gs) };
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

/** The aircraft in the air an upstream query lists, or null when it lists none (a 404 included); throws when no provider can answer. */
async function airborne(read: Read, query: Query): Promise<RemoteFlight | null> {
  let body: unknown;
  try {
    body = JSON.parse((await read(query)).body);
  } catch (error) {
    if (error instanceof UpstreamStatusError && error.status === 404) return null;
    throw error;
  }
  return parseCallsignResponse(body);
}

/**
 * Finds a typed flight: by the callsign it names, then, when no aircraft in the air sends that and the
 * value is a tail number, by the tail (a hyphenated tail, which no callsign can be, by the tail alone).
 * Throws when neither adsb.lol nor adsb.fi can answer (an outage must not read as "not airborne"); a
 * 404, or an answer listing nothing in the air, is "none". A failed route lookup only leaves the route out.
 */
export async function findFlight(input: string, read: Read = upstream.read, get: Fetcher = defaultFetcher): Promise<FlightLookup> {
  const callsign = lookupCallsign(input);
  const registration = lookupRegistration(input);
  if (!callsign && !registration) return { kind: "bad" };
  let flight = callsign ? await airborne(read, { kind: "callsign", callsign }) : null;
  const byCallsign = flight !== null;
  if (!flight && registration) flight = await airborne(read, { kind: "registration", registration });
  if (!flight) return { kind: "none" };
  // Found by its tail, the route is the one the callsign it sends flies: that came from the feed, so it is checked as typing is.
  const routeCallsign = byCallsign ? callsign : flight.callsign && lookupCallsign(flight.callsign);
  let route: FlightRoute | null = null;
  try {
    const routeEndpoint = routeCallsign ? routeUrl(routeCallsign) : null;
    const answer = routeEndpoint ? await get(routeEndpoint) : null;
    route = answer?.status === 200 ? parseRoute(answer.body) : null;
  } catch {
    // The route is a nicety; the flight is still found.
  }
  return { kind: "found", flight: { ...flight, route } };
}
