import type { FlightState } from "./aircraft-state";
import { airlineCode, airlineNameOf, familyName, typeFamily } from "./flight-names";
import type { TrafficEntry } from "./traffic-view";

/**
 * What the reader has narrowed the traffic to. The filters are the page's, not a scene's: they apply to
 * the diorama's aircraft, the movements list and the board, and to the map's aircraft, and they live in
 * the address (`?airline=DAL,UAL&state=taxiing`) so a reload or a shared link keeps them. Pure, so every
 * surface asks the same function. Within a field any choice passes (Delta or United); across fields every
 * set field must agree (Delta and taxiing).
 */

export type GroundState = "gate" | "taxiing" | "holding" | "departing" | "arriving";
export type AltitudeBand = "ground" | "low" | "mid" | "high";
export type SpeedBand = "slow" | "mid" | "fast" | "jet";

export const GROUND_STATES: { key: GroundState; label: string }[] = [
  { key: "gate", label: "At gate" },
  { key: "taxiing", label: "Taxiing" },
  { key: "holding", label: "Holding" },
  { key: "departing", label: "Departing" },
  { key: "arriving", label: "Arriving" },
];

export const ALTITUDE_BANDS: { key: AltitudeBand; label: string }[] = [
  { key: "ground", label: "On the ground" },
  { key: "low", label: "Under 5,000 ft" },
  { key: "mid", label: "5,000 to 25,000 ft" },
  { key: "high", label: "Over 25,000 ft" },
];

export const SPEED_BANDS: { key: SpeedBand; label: string }[] = [
  { key: "slow", label: "Under 40 kt" },
  { key: "mid", label: "40 to 200 kt" },
  { key: "fast", label: "200 to 400 kt" },
  { key: "jet", label: "Over 400 kt" },
];

/** Feet above sea level where one altitude band gives way to the next. */
const LOW_BELOW_FT = 5_000;
const MID_BELOW_FT = 25_000;
/** Knots where one speed band gives way to the next. */
const SLOW_BELOW_KT = 40;
const MID_BELOW_KT = 200;
const FAST_BELOW_KT = 400;

export interface Filters {
  /** ICAO airline prefixes ("DAL"), upper case. */
  airlines: string[];
  /** Type family keys ("B737"): see typeFamily. */
  types: string[];
  states: GroundState[];
  altitudes: AltitudeBand[];
  speeds: SpeedBand[];
  /** IATA codes of where the flight came from, and where it is going. */
  origins: string[];
  destinations: string[];
  military: boolean;
}

export const NO_FILTERS: Filters = { airlines: [], types: [], states: [], altitudes: [], speeds: [], origins: [], destinations: [], military: false };

/** The fields that hold a list of choices. */
export type ListField = Exclude<keyof Filters, "military">;

/** The address parameter each list field lives in. */
const PARAM: Record<ListField, string> = { airlines: "airline", types: "type", states: "state", altitudes: "alt", speeds: "speed", origins: "from", destinations: "to" };

/** The most choices one field carries: a shared link is read by people and by chat apps' previews. */
const MAX_CHOICES = 12;

const keysOf = (list: readonly { key: string }[]) => list.map((i) => i.key);
/** Fields with a fixed set of choices, in their own order; the rest are free codes, sorted. */
const FIXED: Partial<Record<ListField, string[]>> = { states: keysOf(GROUND_STATES), altitudes: keysOf(ALTITUDE_BANDS), speeds: keysOf(SPEED_BANDS) };
/** What a free code looks like. */
const CODE: Partial<Record<ListField, RegExp>> = { airlines: /^[A-Z]{3}$/, types: /^[A-Z0-9]{2,5}$/, origins: /^[A-Z0-9]{3,4}$/, destinations: /^[A-Z0-9]{3,4}$/ };

/** A list cleaned for its field: only valid choices, no repeats, in the field's order, no more than the limit. */
function tidy(field: ListField, values: readonly string[]): string[] {
  const fixed = FIXED[field];
  const code = CODE[field];
  const kept = [...new Set(values.map((v) => (fixed ? v.trim().toLowerCase() : v.trim().toUpperCase())))].filter((v) => (fixed ? fixed.includes(v) : (code?.test(v) ?? false)));
  const ordered = fixed ? fixed.filter((v) => kept.includes(v)) : kept.sort();
  return ordered.slice(0, MAX_CHOICES);
}

/** How many choices are made, for the button's badge. */
export function chosenCount(f: Filters): number {
  return f.airlines.length + f.types.length + f.states.length + f.altitudes.length + f.speeds.length + f.origins.length + f.destinations.length + (f.military ? 1 : 0);
}

export function filtersActive(f: Filters): boolean {
  return chosenCount(f) > 0;
}

/** What a filter reads of an aircraft. A field left out is unknown, and an unknown value passes no choice made on it. */
export interface Subject {
  callsign: string | null;
  typeCode?: string | null;
  military?: boolean;
  state?: GroundState | null;
  onGround?: boolean;
  altitudeFt?: number | null;
  speedKt?: number | null;
  origin?: string | null;
  destination?: string | null;
}

export function altitudeBandOf(s: Pick<Subject, "onGround" | "altitudeFt">): AltitudeBand | null {
  if (s.onGround) return "ground";
  if (s.altitudeFt === undefined || s.altitudeFt === null) return null;
  return s.altitudeFt < LOW_BELOW_FT ? "low" : s.altitudeFt < MID_BELOW_FT ? "mid" : "high";
}

export function speedBandOf(s: Pick<Subject, "speedKt">): SpeedBand | null {
  if (s.speedKt === undefined || s.speedKt === null) return null;
  return s.speedKt < SLOW_BELOW_KT ? "slow" : s.speedKt < MID_BELOW_KT ? "mid" : s.speedKt < FAST_BELOW_KT ? "fast" : "jet";
}

/** Whether an aircraft passes the filters: every field that is set must agree. */
export function matches(f: Filters, s: Subject): boolean {
  if (f.airlines.length) {
    const code = airlineCode(s.callsign);
    if (code === null || !f.airlines.includes(code)) return false;
  }
  if (f.types.length) {
    const family = typeFamily(s.typeCode ?? null);
    if (!family || !f.types.includes(family.key)) return false;
  }
  if (f.states.length && !(s.state && f.states.includes(s.state))) return false;
  if (f.altitudes.length) {
    const band = altitudeBandOf(s);
    if (band === null || !f.altitudes.includes(band)) return false;
  }
  if (f.speeds.length) {
    const band = speedBandOf(s);
    if (band === null || !f.speeds.includes(band)) return false;
  }
  if (f.origins.length && !(s.origin && f.origins.includes(s.origin))) return false;
  if (f.destinations.length && !(s.destination && f.destinations.includes(s.destination))) return false;
  if (f.military && s.military !== true) return false;
  return true;
}

/** The ground state the filter names an aircraft by, from what the card and the tag already say it is doing. */
export function groundStateOf(s: { state: FlightState; activity: string }): GroundState {
  if (s.state === "parked") return "gate";
  if (s.state === "taxiing") return s.activity === "Holding" ? "holding" : "taxiing";
  return s.state;
}

/**
 * What a diorama's aircraft looks like to the filters. The route is read only if asked for (it builds
 * the aircraft's card), so a frame with no origin or destination filter set does not.
 */
export function subjectOfEntry(e: Pick<TrafficEntry, "aircraft" | "situation" | "card">): Subject {
  const a = e.aircraft;
  return {
    callsign: a.callsign,
    typeCode: a.typeCode,
    military: a.military,
    state: groundStateOf(e.situation),
    onGround: a.onGround,
    altitudeFt: a.altitudeFt,
    speedKt: a.groundSpeedKt,
    get origin() {
      return e.card.route?.origin.code ?? null;
    },
    get destination() {
      return e.card.route?.destination.code ?? null;
    },
  };
}

/** A subject with every field read now, to keep: the board remembers an aircraft after it has left the feed. */
export function snapshotSubject(s: Subject): Subject {
  return { callsign: s.callsign, typeCode: s.typeCode, military: s.military, state: s.state, onGround: s.onGround, altitudeFt: s.altitudeFt, speedKt: s.speedKt, origin: s.origin, destination: s.destination };
}

/**
 * Notes what was last seen of each aircraft, `seen` keeping them in the order they were last seen, and
 * forgets the least recently seen beyond `max`. An aircraft already held is deleted before it is set
 * again: setting a key a Map already has keeps its old place, so the cap would drop whoever was first
 * seen, which may be an aircraft still on screen.
 */
export function rememberSeen(seen: Map<string, Subject>, entries: readonly { id: string; subject: Subject }[], max: number): void {
  for (const { id, subject } of entries) {
    seen.delete(id);
    seen.set(id, subject);
  }
  for (const id of seen.keys()) {
    if (seen.size <= max) break;
    seen.delete(id);
  }
}

/** The search parameters as the page gets them: a record of strings, as Next's `searchParams` or `Object.fromEntries(new URLSearchParams())`. */
type Params = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Reads the filters out of the address. Anything not valid is dropped; never throws on a hand-edited address. */
export function readFilters(params: Params): Filters {
  const list = (field: ListField) => tidy(field, (first(params[PARAM[field]]) ?? "").split(","));
  return {
    airlines: list("airlines"),
    types: list("types"),
    states: list("states") as GroundState[],
    altitudes: list("altitudes") as AltitudeBand[],
    speeds: list("speeds") as SpeedBand[],
    origins: list("origins"),
    destinations: list("destinations"),
    military: first(params.mil) === "1",
  };
}

/** The address with the filters written in, every other parameter and the hash kept; no filter is the absence of its parameter. */
export function withFilters(href: string, f: Filters): URL {
  const url = new URL(href);
  for (const field of Object.keys(PARAM) as ListField[]) {
    const values = tidy(field, f[field]);
    if (values.length) url.searchParams.set(PARAM[field], values.join(","));
    else url.searchParams.delete(PARAM[field]);
  }
  if (f.military) url.searchParams.set("mil", "1");
  else url.searchParams.delete("mil");
  return url;
}

/** The filters with one choice made, or unmade when it already was. */
export function toggleFilter(f: Filters, field: ListField, value: string): Filters {
  const current: string[] = f[field];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...f, [field]: tidy(field, next) };
}

export interface FilterOption {
  key: string;
  name: string;
  /** Aircraft of it in the traffic now. */
  count: number;
}

export interface FilterOptions {
  airlines: FilterOption[];
  types: FilterOption[];
  origins: FilterOption[];
  destinations: FilterOption[];
}

function tally(keys: Iterable<string | null | undefined>, chosen: readonly string[], name: (key: string) => string): FilterOption[] {
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const key of chosen) if (!counts.has(key)) counts.set(key, 0);
  return [...counts].map(([key, count]) => ({ key, name: name(key), count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * The choices to offer for the fields whose values come from the traffic: those in it, the busiest
 * first, then by name; and any already chosen (from the address) that are not in it now, so a choice
 * never disappears from the list it was made in.
 */
export function filterOptions(subjects: readonly Subject[], f: Filters): FilterOptions {
  const same = (key: string) => key;
  return {
    airlines: tally(subjects.map((s) => airlineCode(s.callsign)), f.airlines, (k) => airlineNameOf(k) ?? k),
    types: tally(subjects.map((s) => typeFamily(s.typeCode ?? null)?.key), f.types, familyName),
    origins: tally(subjects.map((s) => s.origin), f.origins, same),
    destinations: tally(subjects.map((s) => s.destination), f.destinations, same),
  };
}

export const NO_OPTIONS: FilterOptions = { airlines: [], types: [], origins: [], destinations: [] };

const labelOf = (list: readonly { key: string; label: string }[], key: string) => list.find((i) => i.key === key)?.label ?? key;

/** The filters in a line, "Delta, United · Taxiing · Military", for the panel's header and the button's title. */
export function describeFilters(f: Filters): string {
  return [
    f.airlines.map((c) => airlineNameOf(c) ?? c).join(", "),
    f.types.map(familyName).join(", "),
    f.states.map((s) => labelOf(GROUND_STATES, s)).join(", "),
    f.altitudes.map((a) => labelOf(ALTITUDE_BANDS, a)).join(", "),
    f.speeds.map((s) => labelOf(SPEED_BANDS, s)).join(", "),
    f.origins.length ? `from ${f.origins.join(", ")}` : "",
    f.destinations.length ? `to ${f.destinations.join(", ")}` : "",
    f.military ? "Military" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** How long a change of filter takes to fade an aircraft out or back in, ms. */
export const GHOST_MS = 350;

/**
 * How far each aircraft is faded out, 0 (shown) to 1 (filtered out), eased so a change of filter fades
 * rather than blinks. An aircraft first seen starts at its target. Call `track` for each aircraft in a
 * frame and `sweep` after it, which forgets the ones that were not there.
 */
export class Ghosts {
  private readonly levels = new Map<string, { level: number; seen: number }>();
  private pass = 0;

  /** Moves `id` toward faded out (`hidden`) or shown by `step` (a share of the whole fade) and returns where it is. */
  track(id: string, hidden: boolean, step: number): number {
    const target = hidden ? 1 : 0;
    const have = this.levels.get(id);
    const level = have ? have.level + Math.max(-step, Math.min(step, target - have.level)) : target;
    this.levels.set(id, { level, seen: this.pass });
    return level;
  }

  sweep(): void {
    for (const [id, { seen }] of this.levels) if (seen !== this.pass) this.levels.delete(id);
    this.pass++;
  }
}
