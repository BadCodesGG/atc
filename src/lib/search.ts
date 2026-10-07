import { designator, type FlightState } from "./aircraft-state";
import { iataFlight } from "./airline-codes";
import type { AirportMap, Point } from "./airport-map";
import { AIRPORTS, type Airport } from "./airports";
import { airlineName, typeName } from "./flight-names";
import { type FlightAnswer, lookupCallsign } from "./flight-lookup";
import { toLocal } from "./geo";
import type { FlightRoute } from "./routes";
import { RADIUS_NM } from "./traffic";
import type { TrafficEntry } from "./traffic-view";

/**
 * What the header search finds, and in what order: the flights at the airport on screen, the gates and
 * runways there, the other airports, and (when nothing here matches) a flight anywhere. Pure: the page
 * hands over what is on screen and gets back ranked groups. Scores run 0 to 100 and are comparable
 * across groups, so the groups can be ordered by their best match.
 */

/** What a flight offers to be found by. */
export interface FlightDoc {
  id: string;
  callsign: string;
  registration: string | null;
  typeCode: string | null;
  state: FlightState;
  route: FlightRoute | null;
}

/** A gate, stand or runway. `points` are where to look (one for a gate, both ends for a runway), metres east and north. */
export interface PlaceDoc {
  kind: "gate" | "stand" | "runway";
  /** "E15", "9R/27L". */
  ref: string;
  label: string;
  points: Point[];
  /** What it can be found by, lower-case: a gate's ref, a runway's two ends and the pair. */
  names: string[];
}

export interface SearchData {
  /** The airport on screen. */
  here: Airport["code"];
  flights: FlightDoc[];
  places: PlaceDoc[];
}

export interface FlightHit {
  kind: "flight";
  score: number;
  id: string;
  callsign: string;
  /** The IATA flight number ("DL3104"), when the operator is known. */
  flightNumber: string | null;
  /** "Delta · Boeing 717-200 · SRQ → ATL". */
  detail: string;
  state: FlightState;
}

export interface PlaceHit {
  kind: "place";
  score: number;
  place: PlaceDoc;
}

export interface AirportHit {
  kind: "airport";
  score: number;
  code: Airport["code"];
  /** "PHX". */
  title: string;
  name: string;
  /** "Phoenix, Arizona". */
  where: string;
}

export type Hit = FlightHit | PlaceHit | AirportHit;

export interface SearchGroup {
  kind: "flights" | "places" | "airports";
  heading: string;
  hits: Hit[];
}

export interface SearchResults {
  groups: SearchGroup[];
  /** The callsign to ask the flight route about: the query looks like one and nothing here matched. */
  remote: string | null;
}

const LIMIT = { flights: 6, places: 6, airports: 4 };

/** The state each airport is in, abbreviation and name: the airport list does not carry one. */
const STATES: Record<string, [string, string]> = {
  atl: ["GA", "Georgia"],
  pit: ["PA", "Pennsylvania"],
  jfk: ["NY", "New York"],
  dfw: ["TX", "Texas"],
  ord: ["IL", "Illinois"],
  den: ["CO", "Colorado"],
  lax: ["CA", "California"],
  mco: ["FL", "Florida"],
  las: ["NV", "Nevada"],
  mia: ["FL", "Florida"],
  sfo: ["CA", "California"],
  clt: ["NC", "North Carolina"],
  sea: ["WA", "Washington"],
  phx: ["AZ", "Arizona"],
  ewr: ["NJ", "New Jersey"],
  iah: ["TX", "Texas"],
  bos: ["MA", "Massachusetts"],
  msp: ["MN", "Minnesota"],
  dtw: ["MI", "Michigan"],
  lga: ["NY", "New York"],
  fll: ["FL", "Florida"],
  phl: ["PA", "Pennsylvania"],
  iad: ["VA", "Virginia"],
  slc: ["UT", "Utah"],
  san: ["CA", "California"],
  bna: ["TN", "Tennessee"],
  bwi: ["MD", "Maryland"],
  tpa: ["FL", "Florida"],
  dca: ["VA", "Virginia"],
  aus: ["TX", "Texas"],
  hnl: ["HI", "Hawaii"],
  cle: ["OH", "Ohio"],
};

// ---------------------------------------------------------------- what is on screen

/** The searchable view of the aircraft in a frame. */
export function flightDocs(entries: readonly Pick<TrafficEntry, "aircraft" | "situation" | "card">[]): FlightDoc[] {
  return entries.map((e) => ({
    id: e.aircraft.id,
    callsign: e.aircraft.callsign ?? e.aircraft.id.toUpperCase(),
    registration: e.aircraft.registration ?? null,
    typeCode: e.aircraft.typeCode,
    state: e.situation.state,
    route: e.card.route,
  }));
}

/** Gates, stands and runways of an airport's ground plan; features the map does not name are left out. */
export function buildPlaces(map: Pick<AirportMap, "gates" | "stands" | "runways">): PlaceDoc[] {
  const places: PlaceDoc[] = [];
  const seen = new Set<string>();
  const add = (place: PlaceDoc) => {
    // A stand at a gate carries the gate's ref; the gate, listed first, is the one to find.
    const key = `${place.kind === "runway" ? "runway" : "ramp"} ${place.ref}`;
    if (seen.has(key)) return;
    seen.add(key);
    places.push(place);
  };
  for (const g of map.gates) if (g.ref) add({ kind: "gate", ref: g.ref, label: `Gate ${g.ref}`, points: [[g.x, g.y]], names: [g.ref.toLowerCase()] });
  for (const s of map.stands) if (s.ref) add({ kind: "stand", ref: s.ref, label: `Stand ${s.ref}`, points: [[s.x, s.y]], names: [s.ref.toLowerCase()] });
  for (const r of map.runways) {
    const points: Point[] = r.ends.length >= 2 ? r.ends.slice(0, 2).map((e): Point => [e.x, e.y]) : [r.centerline[0], r.centerline.at(-1)!].filter(Boolean);
    if (!r.ref || points.length < 2) continue;
    const ref = designator(r.ref);
    add({ kind: "runway", ref, label: `Runway ${ref}`, points, names: [...ref.split("/"), ref].map((n) => n.toLowerCase()) });
  }
  return places;
}

// ---------------------------------------------------------------- matching

/** Scores for a whole value equal to the query, one that starts with it, and one with a word that does. */
type Tier = [exact: number, prefix: number, word?: number];

function tiered(value: string | null | undefined, token: string, [exact, prefix, word = 0]: Tier): number {
  if (!value) return 0;
  if (value === token) return exact;
  if (value.startsWith(token)) return prefix || word;
  if (word && value.split(/[\s\-/(),]+/).some((w) => w.startsWith(token))) return word;
  return 0;
}

/** Best score over the tokens, every one of which must match something; or the whole query as one phrase. */
function overall(query: string, score: (token: string) => number): number {
  const tokens = query.split(" ").filter((t) => t !== "airline" && t !== "airlines");
  const parts = tokens.map(score);
  const together = parts.every((p) => p > 0) ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
  return Math.max(together, tokens.length > 1 ? score(tokens.join(" ")) : 0);
}

const clean = (q: string) => q.toLowerCase().replace(/\s+/g, " ").trim();

function flightHit(f: FlightDoc, query: string, here: Airport["code"]): FlightHit | null {
  const callsign = f.callsign.toLowerCase();
  const flightNumber = iataFlight(f.callsign);
  const number = flightNumber?.slice(2).toLowerCase() ?? callsign.match(/\d+$/)?.[0] ?? null;
  const airline = airlineName(f.callsign);
  const type = typeName(f.typeCode);
  const registration = f.registration?.toLowerCase() ?? null;
  const ends = f.route ? [f.route.origin, f.route.destination].filter((e) => e.code.toLowerCase() !== here) : [];
  const score = overall(query, (t) =>
    Math.max(
      tiered(callsign, t, [100, 80]),
      tiered(flightNumber?.toLowerCase(), t, [98, 78]),
      tiered(registration, t, [96, 76]),
      /^\d+$/.test(t) ? tiered(number, t, [74, 56]) : 0,
      tiered(airline?.toLowerCase(), t, [72, 62, 52]),
      tiered(f.typeCode?.toLowerCase(), t, [66, 56]),
      tiered(type?.toLowerCase(), t, [0, 0, 50]),
      ...ends.map((e) => Math.max(tiered(e.code.toLowerCase(), t, [64, 40]), tiered(e.city.toLowerCase(), t, [58, 54, 46]))),
    ),
  );
  if (!score) return null;
  const route = f.route ? `${f.route.origin.code} → ${f.route.destination.code}` : "";
  return {
    kind: "flight",
    score,
    id: f.id,
    callsign: f.callsign,
    flightNumber,
    detail: [airline, type, route].filter(Boolean).join(" · "),
    state: f.state,
  };
}

const PLACE_WORDS: Record<string, PlaceDoc["kind"]> = { gate: "gate", stand: "stand", runway: "runway", rwy: "runway" };

function placeHits(query: string, places: readonly PlaceDoc[]): PlaceHit[] {
  const words = query.split(" ");
  const kinds = new Set(words.flatMap((w) => (PLACE_WORDS[w] ? [PLACE_WORDS[w]] : [])));
  const rest = words.filter((w) => !PLACE_WORDS[w]).join("");
  if (!rest) return [];
  // A runway is said "9R" or written "09R".
  const runway = designator(rest.toUpperCase()).toLowerCase();
  const hits: PlaceHit[] = [];
  for (const place of places) {
    if (kinds.size && !kinds.has(place.kind)) continue;
    const q = place.kind === "runway" ? runway : rest;
    const score = Math.max(0, ...place.names.map((n) => tiered(n, q, [100, 85])));
    if (score) hits.push({ kind: "place", score, place });
  }
  const order = { gate: 0, stand: 1, runway: 2 };
  return hits.sort((a, b) => b.score - a.score || order[a.place.kind] - order[b.place.kind] || a.place.ref.localeCompare(b.place.ref, "en", { numeric: true }));
}

function airportHits(query: string, here: Airport["code"]): AirportHit[] {
  const hits: AirportHit[] = [];
  for (const a of AIRPORTS) {
    if (a.code === here) continue;
    const [abbr, state] = STATES[a.code] ?? ["", ""];
    const score = overall(query, (t) =>
      Math.max(
        tiered(a.code, t, [100, 80]),
        tiered(a.icao.toLowerCase(), t, [95, 70]),
        tiered(a.city.toLowerCase(), t, [90, 72, 60]),
        t === abbr.toLowerCase() ? 68 : 0,
        tiered(state.toLowerCase(), t, [66, 58]),
        tiered(a.name.toLowerCase(), t, [0, 55, 50]),
      ),
    );
    if (score) hits.push({ kind: "airport", score, code: a.code, title: a.code.toUpperCase(), name: a.name, where: state ? `${a.city}, ${state}` : a.city });
  }
  return hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** Whether the query could be a callsign or flight number worth asking the network about. */
function remoteCallsign(query: string): string | null {
  const compact = query.replace(/\s+/g, "");
  if (!/[a-z]/i.test(compact) || !/\d/.test(compact)) return null;
  return lookupCallsign(compact);
}

export function search(input: string, data: SearchData): SearchResults {
  const query = clean(input);
  if (!query) return { groups: [], remote: null };
  const flights = data.flights
    .flatMap((f) => flightHit(f, query, data.here) ?? [])
    .sort((a, b) => b.score - a.score || a.callsign.localeCompare(b.callsign, "en", { numeric: true }));
  const found: SearchGroup[] = [
    { kind: "flights", heading: "Flights", hits: flights.slice(0, LIMIT.flights) },
    { kind: "places", heading: "Gates and runways", hits: placeHits(query, data.places).slice(0, LIMIT.places) },
    { kind: "airports", heading: "Airports", hits: airportHits(query, data.here).slice(0, LIMIT.airports) },
  ];
  // Stable sort: on a tie the groups keep the order above.
  const groups = found.filter((g) => g.hits.length).sort((a, b) => b.hits[0].score - a.hits[0].score);
  return { groups, remote: groups.length ? null : remoteCallsign(query) };
}

// ---------------------------------------------------------------- a flight anywhere

const NM = 1852;

/** The listed airport nearest a position, and how far off, nautical miles. */
export function nearestAirport(latitude: number, longitude: number): { airport: Airport; nm: number } {
  let best = { airport: AIRPORTS[0], nm: Infinity };
  for (const airport of AIRPORTS) {
    const [x, y] = toLocal(airport, latitude, longitude);
    const nm = Math.hypot(x, y) / NM;
    if (nm < best.nm) best = { airport, nm };
  }
  return best;
}

export interface RemoteSummary {
  callsign: string | null;
  /** "Boeing 757-200 · N820DX". */
  aircraft: string;
  altitude: string;
  /** "SRQ → ATL", or empty. */
  route: string;
  /** Lower-case code of the listed airport it is nearest. */
  nearest: Airport["code"];
  /** "34 nm from PHX", or "over PHX" within a mile. */
  nearness: string;
  /** Whether it is within the scene's range of a listed airport other than `here`, so opening that airport can show it. */
  openable: boolean;
}

export function remoteSummary(flight: FlightAnswer, here: Airport["code"]): RemoteSummary {
  const { airport, nm } = nearestAirport(flight.latitude, flight.longitude);
  const code = airport.code.toUpperCase();
  return {
    callsign: flight.callsign,
    aircraft: [typeName(flight.typeCode), flight.registration].filter(Boolean).join(" · "),
    altitude: `${(Math.round(flight.altitudeFt / 100) * 100).toLocaleString("en-US")} ft`,
    route: flight.route ? `${flight.route.origin.code} → ${flight.route.destination.code}` : "",
    nearest: airport.code,
    nearness: nm < 1 ? `over ${code}` : `${Math.round(nm).toLocaleString("en-US")} nm from ${code}`,
    openable: nm <= RADIUS_NM && airport.code !== here,
  };
}
