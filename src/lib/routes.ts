import type { Airport } from "./airports";

/**
 * Where a flight is going and where it came from, by callsign, from adsbdb.com (free, no key):
 * `GET /v0/callsign/{callsign}`. The route is the one the callsign is filed under, which can be a
 * season or a schedule change out of date, so a route is kept only when the airport being watched is
 * one of its two ends: an aircraft on ATL's ground filed as JAX to LGA is a stale entry, and no route
 * is better than a wrong one.
 */

export const ROUTE_BASE = "https://api.adsbdb.com/v0/callsign";

/** One end of a route. */
export interface RouteEnd {
  /** IATA code, "PHX", or the ICAO code where the airport has none. */
  code: string;
  /** "Phoenix", or the airport's name where the city is not given. */
  city: string;
  /** ISO country code, "US", or null when not given. */
  country: string | null;
  /** Where the airport is, when adsbdb says: for drawing the route on the map. */
  latitude?: number;
  longitude?: number;
}

export interface FlightRoute {
  origin: RouteEnd;
  destination: RouteEnd;
}

/** Callsigns as ADS-B sends them: letters and digits, at most eight. Nothing else reaches the URL. */
const CALLSIGN = /^[A-Z0-9]{2,8}$/;

export function routeUrl(callsign: string): string | null {
  return CALLSIGN.test(callsign) ? `${ROUTE_BASE}/${callsign}` : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function end(raw: unknown): (RouteEnd & { icao: string | null }) | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const iata = str(r.iata_code);
  const icao = str(r.icao_code);
  const code = iata ?? icao;
  const city = str(r.municipality) ?? str(r.name);
  if (!code || !city) return null;
  const lat = r.latitude;
  const lon = r.longitude;
  const placed = typeof lat === "number" && typeof lon === "number" && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { latitude: lat, longitude: lon } : {};
  return { code, city, country: str(r.country_iso_name), icao, ...placed };
}

/**
 * The route in an adsbdb answer, or null when there is none, it is malformed, or neither end is
 * `airport`. With no `airport` (a flight looked up from anywhere) any route is kept.
 */
export function parseRoute(json: unknown, airport?: Pick<Airport, "code" | "icao">): FlightRoute | null {
  if (typeof json !== "object" || json === null) return null;
  const response = (json as Record<string, unknown>).response;
  if (typeof response !== "object" || response === null) return null;
  const route = (response as Record<string, unknown>).flightroute;
  if (typeof route !== "object" || route === null) return null;
  const r = route as Record<string, unknown>;
  const origin = end(r.origin);
  const destination = end(r.destination);
  if (!origin || !destination) return null;
  const here = (e: { code: string; icao: string | null }) => !!airport && (e.code.toLowerCase() === airport.code || e.icao === airport.icao);
  if (airport && !here(origin) && !here(destination)) return null;
  // The end that is this airport is named by its IATA code even where adsbdb gave only the ICAO one,
  // so the page can tell which way the flight goes by comparing codes.
  const bare = (e: RouteEnd & { icao: string | null }): RouteEnd => ({
    code: airport && here(e) ? airport.code.toUpperCase() : e.code,
    city: e.city,
    country: e.country,
    ...(e.latitude !== undefined && e.longitude !== undefined ? { latitude: e.latitude, longitude: e.longitude } : {}),
  });
  return { origin: bare(origin), destination: bare(destination) };
}

/** A found route is good for a day's flying; a callsign with none is asked about again after an hour. */
const HIT_MS = 6 * 3600_000;
const MISS_MS = 3600_000;
/** After an outage or a refusal, adsbdb is left alone this long. */
const BACKOFF_MS = 60_000;
/** Lookups started per call to `routesFor`, and at once. The board fills over a few polls rather than in a burst. */
const PER_CALL = 12;
const CONCURRENCY = 4;
/** Callsigns remembered per airport; the oldest are forgotten first. */
const MAX_ENTRIES = 4000;

type Fetcher = (url: string) => Promise<{ status: number; body: unknown }>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(6_000),
    cache: "no-store",
    headers: { "User-Agent": "atc (live airport visualisation)", Accept: "application/json" },
  });
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

/**
 * The routes known for one airport's callsigns, and the lookups for the rest. `routesFor` answers
 * at once from what is known and hands back the work that fills in the rest, so a traffic response
 * never waits on adsbdb.
 */
export class RouteBook {
  private readonly known = new Map<string, { route: FlightRoute | null; until: number }>();
  private readonly pending = new Set<string>();
  private pausedUntil = 0;

  private readonly airport: Pick<Airport, "code" | "icao">;
  private readonly get: Fetcher;
  private readonly now: () => number;

  constructor(airport: Pick<Airport, "code" | "icao">, get: Fetcher = defaultFetcher, now: () => number = Date.now) {
    this.airport = airport;
    this.get = get;
    this.now = now;
  }

  /** The routes known for `callsigns`, and a promise that looks up a few of the missing ones. */
  routesFor(callsigns: Iterable<string>): { routes: Record<string, FlightRoute>; work: Promise<void> } {
    const routes: Record<string, FlightRoute> = {};
    const missing: string[] = [];
    const t = this.now();
    for (const callsign of callsigns) {
      const entry = this.known.get(callsign);
      if (entry && entry.until > t) {
        if (entry.route) routes[callsign] = entry.route;
      } else if (!this.pending.has(callsign) && routeUrl(callsign)) {
        missing.push(callsign);
      }
    }
    if (t < this.pausedUntil) return { routes, work: Promise.resolve() };
    return { routes, work: this.lookUp(missing.slice(0, PER_CALL)) };
  }

  private async lookUp(callsigns: string[]): Promise<void> {
    for (const c of callsigns) this.pending.add(c);
    const queue = [...callsigns];
    const worker = async () => {
      for (let c = queue.shift(); c !== undefined; c = queue.shift()) {
        try {
          if (this.now() < this.pausedUntil) continue;
          const { status, body } = await this.get(routeUrl(c)!);
          if (status === 200) this.remember(c, parseRoute(body, this.airport));
          else if (status === 404) this.remember(c, null);
          else this.pausedUntil = this.now() + BACKOFF_MS;
        } catch {
          this.pausedUntil = this.now() + BACKOFF_MS;
        } finally {
          this.pending.delete(c);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, callsigns.length) }, worker));
  }

  private remember(callsign: string, route: FlightRoute | null) {
    this.known.delete(callsign);
    this.known.set(callsign, { route, until: this.now() + (route ? HIT_MS : MISS_MS) });
    if (this.known.size > MAX_ENTRIES) this.known.delete(this.known.keys().next().value!);
  }
}
