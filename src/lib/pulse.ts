import type { Place, Situation } from "./aircraft-state";

/**
 * The airport's pulse, measured rather than scheduled, from what the page has seen since it opened:
 * the runways in use, the arrivals and departures this hour, how long taxiing out and in is taking,
 * and an observed board of what each flight actually did and when. Pure: fed one moment at a time
 * (feed-clock seconds, never decreasing) and read back whenever the page wants.
 *
 * Everything here comes from state changes over time. A single moment, such as the frozen fixture,
 * gives the runways in use (an aircraft on final names its runway) and each flight's state when first
 * seen, and nothing else: no pushback, takeoff or landing has been watched happening.
 */

export interface PulseAircraft {
  id: string;
  callsign: string | null;
  x: number;
  y: number;
  onGround: boolean;
  situation: Situation;
}

export type BoardEventKind = "seen" | "pushback" | "takeoff" | "landing" | "in";

export interface BoardEvent {
  kind: BoardEventKind;
  /** Feed-clock seconds. */
  at: number;
  runway?: string;
  place?: Place;
  /** For "seen": what it was doing then, "Final approach". */
  activity?: string;
}

export interface BoardFlight {
  id: string;
  callsign: string;
  /** Oldest first. */
  events: BoardEvent[];
}

export interface RunwayUse {
  /** "9L". */
  runway: string;
  /** Flights seen landing on it, or departing from it, within the window. */
  arrivals: number;
  departures: number;
  /** Seen in use, or the fallback's say (the wind) because nothing has been seen yet. */
  source: "observed" | "fallback";
}

/**
 * Where the runways in use come from when no aircraft has shown them yet: the seam for a wind-based
 * guess (runways most nearly into the wind), which another part of the app supplies.
 */
export type RunwayFallback = () => { arrivals: string[]; departures: string[] } | null;

export interface TaxiTime {
  /** Median of the flights measured, whole minutes. */
  minutes: number;
  flights: number;
}

export interface PulseNow {
  /** When the page started watching. */
  since: number;
  arrivalsThisHour: number;
  departuresThisHour: number;
  /** Pushback to takeoff, and landing to gate, over the last hour; null until one has been watched whole. */
  taxiOut: TaxiTime | null;
  taxiIn: TaxiTime | null;
}

/** A runway counts as in use while a movement on it is this recent, seconds. */
const USE_WINDOW = 1800;
const HOUR = 3600;
/** Moving this far, metres, from where it was parked is a pushback; less is creeping on the stand. */
const PUSHBACK_DISTANCE = 40;
/** Parked this long, seconds, at a gate is arrived there; less is a pause on the way. */
const IN_CONFIRM = 60;
/** Higher than this, feet above the field, an aircraft that was on the ground has taken off. */
const AIRBORNE_FT = 50;

const ARRIVAL_ACTIVITIES = new Set(["Final approach", "Landing", "Landing rollout"]);
const DEPARTURE_ACTIVITIES = new Set(["Lined up", "Takeoff roll", "Climbing out"]);

interface Memory {
  callsign: string;
  events: BoardEvent[];
  /** Seen on the ground, or in the air, at some point. */
  wasOnGround: boolean;
  wasAirborne: boolean;
  /** The runway its last runway activity named, for a takeoff or landing read a moment after it. */
  lastRunway: string | null;
  /** Where it was last parked, from when, and whether it has since moved off. */
  parked: { place: Place | undefined; x: number; y: number; since: number } | null;
  leftAt: number | null;
  /** Arrived from the air (or first seen arriving), so stopping at a gate ends its taxi in. */
  inbound: boolean;
  /** The runway it is landing on or departing from, as best seen so far. */
  use: Partial<Record<"arrivals" | "departures", Evidence>>;
}

/**
 * One flight's say on a runway in use. Read on the ground it is sure; read in the air, the lower the
 * better, since on a long final or a climb-out turning away the nearest centreline can be the
 * parallel's.
 */
interface Evidence {
  runway: string;
  /** Last seen in that role. */
  at: number;
  aglFt: number;
  sure: boolean;
}

export class Pulse {
  private readonly flights = new Map<string, Memory>();

  constructor(readonly since: number) {}

  observe(time: number, list: PulseAircraft[]): void {
    for (const a of list) {
      const s = a.situation;
      let m = this.flights.get(a.id);
      if (!m) {
        m = {
          callsign: a.callsign ?? a.id.toUpperCase(),
          events: [{ kind: "seen", at: time, activity: s.activity, ...(s.runway ? { runway: s.runway } : {}), ...(s.place ? { place: s.place } : {}) }],
          wasOnGround: false,
          wasAirborne: false,
          lastRunway: null,
          parked: null,
          leftAt: null,
          inbound: s.state === "arriving",
          use: {},
        };
        this.flights.set(a.id, m);
      }
      if (a.callsign) m.callsign = a.callsign;
      this.useOf(m, a, time);

      const runwayActivity = s.runway && (ARRIVAL_ACTIVITIES.has(s.activity) || DEPARTURE_ACTIVITIES.has(s.activity));
      if (a.onGround) {
        if (m.wasAirborne && !m.events.some((e) => e.kind === "landing")) {
          const runway = s.runway ?? m.lastRunway;
          m.events.push({ kind: "landing", at: time, ...(runway ? { runway } : {}) });
          if (runway) m.use.arrivals = { runway, at: time, aglFt: 0, sure: true };
          m.inbound = true;
        }
      } else if (s.aglFt >= AIRBORNE_FT && s.state === "departing" && m.wasOnGround && !m.events.some((e) => e.kind === "takeoff")) {
        const runway = m.use.departures?.sure ? m.use.departures.runway : (s.runway ?? m.lastRunway);
        m.events.push({ kind: "takeoff", at: time, ...(runway ? { runway } : {}) });
        if (runway) m.use.departures = { runway, at: time, aglFt: 0, sure: true };
      }
      if (runwayActivity) m.lastRunway = s.runway;
      if (a.onGround) m.wasOnGround = true;
      else m.wasAirborne = true;

      this.parking(m, a, time);
    }
  }

  /** Pushback off a stand, and arrival at one. */
  private parking(m: Memory, a: PulseAircraft, time: number): void {
    const s = a.situation;
    if (s.state === "parked") {
      // Back where it was after creeping on the stand: the same stop, from when it first stopped.
      if (!m.parked || Math.hypot(m.parked.x - a.x, m.parked.y - a.y) >= PUSHBACK_DISTANCE) m.parked = { place: s.place, x: a.x, y: a.y, since: time };
      m.leftAt = null;
      const p = m.parked!;
      if (m.inbound && p.place && time - p.since >= IN_CONFIRM && !m.events.some((e) => e.kind === "in")) {
        m.events.push({ kind: "in", at: p.since, place: p.place });
      }
      return;
    }
    if (!m.parked || !a.onGround) return;
    m.leftAt ??= time;
    if (Math.hypot(m.parked.x - a.x, m.parked.y - a.y) >= PUSHBACK_DISTANCE) {
      // An arrival that only paused by a gate has not pushed back from it.
      const settled = !m.inbound || m.events.some((e) => e.kind === "in");
      if (settled && !m.events.some((e) => e.kind === "pushback")) {
        m.events.push({ kind: "pushback", at: m.leftAt, ...(m.parked.place ? { place: m.parked.place } : {}) });
        m.inbound = false;
      }
      m.parked = null;
      m.leftAt = null;
    }
  }

  private useOf(m: Memory, a: PulseAircraft, time: number): void {
    const s = a.situation;
    if (!s.runway) return;
    const role = s.state === "arriving" && ARRIVAL_ACTIVITIES.has(s.activity) ? "arrivals" : s.state === "departing" && DEPARTURE_ACTIVITIES.has(s.activity) ? "departures" : null;
    if (!role) return;
    // Just off the ground and not yet climbing, a departure reads as landing; stopped on the runway
    // after landing, an arrival reads as lined up. Neither is what it looks like.
    if (role === "arrivals" && m.wasOnGround) return;
    if (role === "departures" && m.wasAirborne && a.onGround) return;
    const had = m.use[role];
    const sure = a.onGround;
    if (!had || (sure && !had.sure) || (sure === had.sure && (sure || s.aglFt <= had.aglFt))) m.use[role] = { runway: s.runway, at: time, aglFt: s.aglFt, sure };
    else had.at = time;
  }

  /** The runways in use, by designator: seen in the last half hour, else the fallback's, else none. */
  runwaysInUse(time: number, fallback?: RunwayFallback): RunwayUse[] {
    const counts = new Map<string, { arrivals: number; departures: number }>();
    for (const m of this.flights.values()) {
      for (const role of ["arrivals", "departures"] as const) {
        const e = m.use[role];
        if (!e || time - e.at > USE_WINDOW) continue;
        const c = counts.get(e.runway) ?? { arrivals: 0, departures: 0 };
        c[role]++;
        counts.set(e.runway, c);
      }
    }
    const out: RunwayUse[] = [...counts].map(([runway, c]) => ({ runway, ...c, source: "observed" as const }));
    if (!out.length) {
      const guess = fallback?.();
      if (guess) {
        for (const runway of new Set([...guess.arrivals, ...guess.departures])) {
          out.push({ runway, arrivals: guess.arrivals.includes(runway) ? 1 : 0, departures: guess.departures.includes(runway) ? 1 : 0, source: "fallback" });
        }
      }
    }
    return out.sort((p, q) => p.runway.localeCompare(q.runway, "en", { numeric: true }));
  }

  now(time: number): PulseNow {
    let arrivals = 0;
    let departures = 0;
    const out: number[] = [];
    const inn: number[] = [];
    for (const m of this.flights.values()) {
      const find = (kind: BoardEventKind) => m.events.find((e) => e.kind === kind);
      const takeoff = find("takeoff");
      const landing = find("landing");
      const push = find("pushback");
      const gate = find("in");
      if (takeoff && time - takeoff.at <= HOUR) departures++;
      if (landing && time - landing.at <= HOUR) arrivals++;
      if (takeoff && push && time - takeoff.at <= HOUR) out.push(takeoff.at - push.at);
      if (landing && gate && time - gate.at <= HOUR) inn.push(gate.at - landing.at);
    }
    return { since: this.since, arrivalsThisHour: arrivals, departuresThisHour: departures, taxiOut: median(out), taxiIn: median(inn) };
  }

  /** Every flight seen, the one with the latest news first. */
  board(): BoardFlight[] {
    return [...this.flights]
      .map(([id, m]) => ({ id, callsign: m.callsign, events: m.events.slice() }))
      .sort((p, q) => q.events.at(-1)!.at - p.events.at(-1)!.at || p.callsign.localeCompare(q.callsign));
  }
}

function median(seconds: number[]): TaxiTime | null {
  if (!seconds.length) return null;
  const s = [...seconds].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const v = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  return { minutes: Math.round(v / 60), flights: s.length };
}
