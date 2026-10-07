import type { Place, Situation } from "./aircraft-state";
import type { AirportMap } from "./airport-map";
import type { Wind } from "./metar";
import { type PathProcedure, PathPredictor, type PredictedPath } from "./predicted-path";
import type { LocalProcedures } from "./procedure-path";
import { type BoardEvent, Pulse, type RunwayFallback, type RunwayUse, type TaxiTime } from "./pulse";
import type { FlightRoute } from "./routes";
import type { TrackedAircraft } from "./tracker";

/**
 * Ties the pulse and the path predictions to the traffic: takes in each moment the page draws, keeps
 * every aircraft's predicted path current (worked out again only when it has moved on or something
 * changed), and turns the pulse into the words and figures the panels print.
 */

/** What this reads of each aircraft: a TrafficEntry has all of it. */
export interface OpsEntry {
  aircraft: Pick<TrackedAircraft, "id" | "callsign" | "x" | "y" | "headingDeg" | "headingKnown" | "onGround" | "groundSpeedKt">;
  situation: Situation;
  card: { direction: "outbound" | "inbound" | null; route?: FlightRoute | null };
}

export interface OpsRunway {
  /** "9L". */
  runway: string;
  /** "Arrivals", "Departures", "Arrivals and departures", or "Departures, likely" for a runway no aircraft has been seen using yet. */
  role: string;
  /** Aircraft stopped at its holding points or lined up on it. */
  holding: number;
  /** Departures whose predicted path ends at it. */
  taxiingOut: number;
}

export interface OpsBoardRow {
  id: string;
  callsign: string;
  /** Newest first. */
  events: { kind: BoardEvent["kind"]; time: string; text: string }[];
}

export interface OpsView {
  /** When the page started watching, "14:02". */
  since: string;
  runways: OpsRunway[];
  arrivals: number;
  departures: number;
  /** "12 min", or null until one has been watched from end to end. */
  taxiOut: string | null;
  taxiIn: string | null;
  board: OpsBoardRow[];
}

/** A path is worked out again when its aircraft has moved this far, metres, or this long has passed, seconds. */
const REPLAN_DISTANCE = 25;
const REPLAN_SECONDS = 10;
/** Stopped within this of a runway's holding point, metres, and slower than this, knots, is waiting at it. */
const QUEUE_RADIUS = 120;
const QUEUE_KT = 5;
/** An aircraft's track over the ground is read from its positions over this many seconds, once it has moved this many metres. */
const TRACK_WINDOW = 30;
const TRACK_MIN = 20;

interface Plan {
  x: number;
  y: number;
  at: number;
  key: string;
  path: PredictedPath | null;
}

export class PathPulse {
  readonly predictor: PathPredictor;
  private readonly pulse: Pulse;
  private readonly plans = new Map<string, Plan>();
  private paths: PredictedPath[] = [];
  private entries: OpsEntry[] = [];
  private useKey = "";
  /** The reported wind, for the selected arrival's runway when no arrival has been seen (setWind). */
  private wind: Wind | null = null;
  /** Each aircraft's recent positions, oldest first, for its track over the ground. */
  private readonly trails = new Map<string, { t: number; x: number; y: number }[]>();

  constructor(
    map: Pick<AirportMap, "taxiways" | "runways" | "holdingPositions" | "gates">,
    private readonly options: { since: number; format: (seconds: number) => string; fallback?: RunwayFallback; procedures?: LocalProcedures | null },
  ) {
    this.predictor = new PathPredictor(map, options.procedures ?? null);
    this.pulse = new Pulse(options.since);
  }

  /**
   * Takes in the aircraft at playback moment `time` (feed-clock seconds) and returns every predicted
   * path: the same array as last time when none has changed, so the scene can skip rebuilding it.
   * The `selected` flight's runway is worked out when it is not yet lined up with one.
   */
  update(entries: OpsEntry[], time: number, selected: string | null = null): PredictedPath[] {
    this.observe(entries, time);
    return this.plan(entries, time, selected);
  }

  /** The METAR's wind; a change replans the paths that depend on it. */
  setWind(wind: Wind | null): void {
    this.wind = wind;
  }

  /** An aircraft's predicted path as last planned; null when it has none. */
  pathOf(id: string): PredictedPath | null {
    return this.plans.get(id)?.path ?? null;
  }

  /** The published procedure an aircraft's predicted path follows, to cite; null when none. */
  procedureOf(id: string): PathProcedure | null {
    return this.plans.get(id)?.path?.procedure ?? null;
  }

  /** The same, as the flight card cites it (citeProcedure). */
  citationOf(id: string): string | null {
    const p = this.procedureOf(id);
    return p && citeProcedure(p);
  }

  /** Takes in one moment for the pulse, the board and each aircraft's track over the ground, without planning paths. */
  observe(entries: OpsEntry[], time: number): void {
    this.entries = entries;
    this.pulse.observe(
      time,
      entries.map((e) => ({ id: e.aircraft.id, callsign: e.aircraft.callsign, x: e.aircraft.x, y: e.aircraft.y, onGround: e.aircraft.onGround, situation: e.situation })),
    );
    const seen = new Set<string>();
    for (const { aircraft: a } of entries) {
      seen.add(a.id);
      const trail = this.trails.get(a.id) ?? [];
      if (!trail.length || time > trail[trail.length - 1].t) trail.push({ t: time, x: a.x, y: a.y });
      while (trail.length > 2 && trail[1].t <= time - TRACK_WINDOW) trail.shift();
      this.trails.set(a.id, trail);
    }
    for (const id of this.trails.keys()) if (!seen.has(id)) this.trails.delete(id);
  }

  /**
   * The way an aircraft has been moving over the ground in the last half minute, degrees, or null
   * when it has not moved far enough to tell.
   */
  private track(id: string): number | null {
    const trail = this.trails.get(id);
    if (!trail || trail.length < 2) return null;
    const a = trail[0];
    const b = trail[trail.length - 1];
    if (Math.hypot(b.x - a.x, b.y - a.y) < TRACK_MIN) return null;
    return ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
  }

  private plan(entries: OpsEntry[], time: number, selected: string | null): PredictedPath[] {
    const use = this.use(time);
    const wind = this.wind && [this.wind.directionDeg, this.wind.speedKt];
    const useKey = JSON.stringify([use.map((u) => [u.runway, u.arrivals > 0, u.departures > 0]), wind]);
    const replanAll = useKey !== this.useKey;
    this.useKey = useKey;
    let changed = false;
    const seen = new Set<string>();
    for (const e of entries) {
      const a = e.aircraft;
      seen.add(a.id);
      const destination = e.card.route?.destination;
      const key = `${e.situation.state}|${e.situation.activity}|${e.situation.runway}|${a.id === selected}|${destination?.code ?? ""}`;
      const plan = this.plans.get(a.id);
      if (!replanAll && plan && plan.key === key && Math.hypot(plan.x - a.x, plan.y - a.y) < REPLAN_DISTANCE && time - plan.at < REPLAN_SECONDS) continue;
      // No heading ever reported: the way it has been moving over the ground stands in for one.
      const track = a.headingKnown ? null : this.track(a.id);
      const motion = track === null ? a : { ...a, headingDeg: track, headingKnown: true };
      const where = destination?.latitude !== undefined && destination.longitude !== undefined ? { latitude: destination.latitude, longitude: destination.longitude } : null;
      const path = this.predictor.predict({ ...motion, situation: e.situation, direction: e.card.direction, destination: where }, use, { inferRunway: a.id === selected, wind: this.wind });
      this.plans.set(a.id, { x: a.x, y: a.y, at: time, key, path });
      // A path moved on by a few metres is not worth a new mesh unless it was or is now empty.
      if (!plan || !!plan.path !== !!path || plan.path?.runway !== path?.runway || plan.key !== key || replanAll || Math.hypot(plan.x - a.x, plan.y - a.y) >= REPLAN_DISTANCE) changed = true;
    }
    for (const id of this.plans.keys()) {
      if (!seen.has(id)) {
        this.plans.delete(id);
        changed = true;
      }
    }
    if (changed) this.paths = [...this.plans.values()].flatMap((p) => p.path ?? []);
    return this.paths;
  }

  private use(time: number): RunwayUse[] {
    return this.pulse.runwaysInUse(time, this.options.fallback);
  }

  /** What the pulse and board panels print, at playback moment `time`. */
  view(time: number): OpsView {
    const { format } = this.options;
    const use = this.use(time);
    const now = this.pulse.now(time);
    const runways: OpsRunway[] = use.map((u) => ({
      runway: u.runway,
      role: u.arrivals && u.departures ? "Arrivals and departures" : u.arrivals ? "Arrivals" : "Departures",
      holding: 0,
      taxiingOut: 0,
    }));
    for (const p of this.paths) {
      if (p.kind !== "departure" || !p.runway || p.state !== "taxiing") continue;
      let row = runways.find((r) => r.runway === p.runway);
      if (!row) {
        row = { runway: p.runway, role: "Departures, likely", holding: 0, taxiingOut: 0 };
        runways.push(row);
      }
      row.taxiingOut++;
    }
    for (const row of runways) {
      const end = this.predictor.ends.get(row.runway);
      if (!end || !/Departures/.test(row.role)) continue;
      const holds = end.departureTargets.map((t) => this.predictor.graph.nodes[t.node]);
      row.holding = this.entries.filter((e) => {
        const a = e.aircraft;
        if (e.situation.activity === "Lined up" && e.situation.runway === row.runway) return true;
        return a.onGround && e.situation.state === "taxiing" && (a.groundSpeedKt ?? 0) < QUEUE_KT && holds.some((h) => Math.hypot(h.x - a.x, h.y - a.y) <= QUEUE_RADIUS);
      }).length;
    }
    runways.sort((p, q) => p.runway.localeCompare(q.runway, "en", { numeric: true }));
    return {
      since: format(now.since),
      runways,
      arrivals: now.arrivalsThisHour,
      departures: now.departuresThisHour,
      taxiOut: minutes(now.taxiOut),
      taxiIn: minutes(now.taxiIn),
      board: this.pulse.board().map((f) => ({
        id: f.id,
        callsign: f.callsign,
        events: f.events
          .slice()
          .reverse()
          .map((e) => ({ kind: e.kind, time: format(e.at), text: describe(e) })),
      })),
    };
  }
}

function minutes(t: TaxiTime | null): string | null {
  return t ? `${t.minutes} min` : null;
}

function placeWords(p: Place | undefined): string {
  return p ? `${p.kind} ${p.ref}` : "the ramp";
}

/** One event as the board prints it. */
export function describe(e: BoardEvent): string {
  switch (e.kind) {
    case "pushback":
      return `Pushed back from ${placeWords(e.place)}`;
    case "takeoff":
      return e.runway ? `Took off, runway ${e.runway}` : "Took off";
    case "landing":
      return e.runway ? `Landed, runway ${e.runway}` : "Landed";
    case "in":
      return `In at ${placeWords(e.place)}`;
    case "seen":
      if (e.place) return `First seen at ${placeWords(e.place)}`;
      return `First seen: ${e.activity ?? "on the move"}${e.runway ? `, runway ${e.runway}` : ""}`;
  }
}

/** A predicted path's published procedure as the flight card cites it, "Approach: ILS RWY 8L, from FAA CIFP cycle 2610". */
export function citeProcedure(p: PathProcedure): string {
  if (p.kind === "no-sid") return `Climb-out: extended centreline, as FAA CIFP cycle ${p.cycle} has no SID for this airport`;
  const what = p.kind === "approach" ? `approach: ${p.name}` : `climb-out: ${p.name} departure`;
  const line = p.likely ? `Likely ${what}` : what;
  return `${line[0].toUpperCase()}${line.slice(1)}, from FAA CIFP cycle ${p.cycle}`;
}
