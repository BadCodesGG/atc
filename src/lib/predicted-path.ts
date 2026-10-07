import { designator, type FlightState, type Situation } from "./aircraft-state";
import type { AirportMap, Point } from "./airport-map";
import { FEET, KNOTS } from "./geo";
import type { Wind } from "./metar";
import { approachLine, climbOutLine, likelySid, type LinePoint, type LocalDeparture, type LocalProcedures } from "./procedure-path";
import type { RunwayUse } from "./pulse";
import { buildTaxiGraph, locate, type Reach, shortestPaths, type TaxiGraph } from "./taxi-graph";

/**
 * Where each moving aircraft is likely to go next. A departure taxiing: the shortest route along the
 * taxi network to a holding point of its likely runway, then the roll and the climb-out along the
 * extended centreline. An arrival: down to the runway, the first exit it can slow down for on the
 * terminals' side, and the shortest route from there to the ramp. In the air, the published
 * procedures (the FAA's CIFP, procedure-path.ts) where the airport has them: an arrival down its
 * runway's final approach, a departure out on the SID that leaves toward its destination. Without
 * them, or without a destination to choose a SID by, the extended centreline, said honestly. Pure.
 */

/** Metres east, north, and above the field. */
export type PathPoint = [number, number, number];

export interface PathLeg {
  kind: "taxi" | "runway" | "air";
  points: PathPoint[];
}

export interface PredictedPath {
  id: string;
  state: FlightState;
  kind: "departure" | "arrival";
  /** The runway it departs from or lands on, "9L". */
  runway: string | null;
  legs: PathLeg[];
  /** The published procedure the air leg follows, to cite; absent when it is the extended centreline. */
  procedure?: PathProcedure;
}

export interface PathProcedure {
  /** "no-sid": the airport has no SID in the file, so the climb-out is the extended centreline, and the card says why. */
  kind: "approach" | "climb-out" | "no-sid";
  /** "ILS RWY 8L", or a SID's identifier, "CUTTN2"; empty for "no-sid". */
  name: string;
  /** The CIFP cycle it comes from, "2610". */
  cycle: string;
  /** A guess: the runway was worked out rather than seen, or the SID chosen by the destination. */
  likely: boolean;
}

export interface PredictOptions {
  /** Work out the runway of an arrival not lined up with one yet (the selected flight's only: it is a guess). */
  inferRunway?: boolean;
  /** The reported wind: which way the airport is landing when no arrival has been seen. */
  wind?: Wind | null;
}

export interface PathAircraft {
  id: string;
  x: number;
  y: number;
  headingDeg: number;
  headingKnown: boolean;
  onGround: boolean;
  groundSpeedKt: number | null;
  situation: Situation;
  /** Leaving or arriving, when the route or the history says (FlightCard's direction). */
  direction: "outbound" | "inbound" | null;
  /** Where a departure is going, when its route is known: which SID it likely flies. */
  destination?: { latitude: number; longitude: number } | null;
}

/** A holding point for a departure: this far before or past the threshold, metres, and this far to the side. */
const HOLD_BEFORE = 200;
const HOLD_PAST = 400;
const HOLD_SIDE: [number, number] = [25, 250];
/** Longest way from a holding point on to its runway, metres. */
const LINE_UP_MAX = 300;
/** Farther than this from the taxi network, metres, an aircraft is somewhere the map does not have. */
const OFF_NETWORK = 150;
/** Within this of a gate, metres, a node is on the ramp: where an arrival's predicted route ends. */
const RAMP_RADIUS = 150;
/** Closer than this to the ramp already, metres, an arrival has nothing left worth drawing. */
const ARRIVED = 60;
/** A landing touches down this far past the threshold at this speed (m/s), and slows at this rate (m/s²) to exit speed. */
const TOUCHDOWN_ALONG = 400;
const TOUCHDOWN_SPEED = 65;
const ROLLOUT_DECEL = 1.6;
const EXIT_SPEED = 15;
/** A takeoff's roll from where it lines up, metres, at most this share of the runway. */
const TAKEOFF_ROLL = 1500;
const TAKEOFF_ROLL_SHARE = 0.75;
/** The climb-out drawn: this long, metres, at this gradient. */
const CLIMB_LENGTH = 6000;
const CLIMB_GRADIENT = 0.06;
/** How much of a route, metres, says which way it sets off. */
const SETTING_OFF = 30;
/** A runway end within this of the flow's direction, degrees, is in the same flow. */
const SAME_FLOW_DEG = 30;
/** An arrival is drawn down the published approach from this far before the threshold, metres; closer in, straight to touchdown. */
const APPROACH_MIN = 300;
/** A runway is worked out for an arrival up to this far before its threshold (metres) and this high (feet above the field). */
const INFER_RANGE = 60_000;
const INFER_MAX_AGL = 10_000;
/** Within this of a final's extended centreline (metres), an arrival closing on the threshold converges on it whichever way it drifts. */
const ON_FINAL = 1000;

const RAD = Math.PI / 180;

interface RunwayEnd {
  designator: string;
  /** Threshold, and unit vector down the runway from it. */
  x: number;
  y: number;
  ux: number;
  uy: number;
  length: number;
  /**
   * Where a departure makes for: the holding points near the threshold (or failing those, the taxiway
   * joins with the runway there), each with its way on to the runway and where that joins it.
   */
  departureTargets: { node: number; lineUp: Point[]; cost: number; entryAlong: number }[];
  /** Nodes where a taxiway leaves the runway, by distance from this threshold; `terminal` when it leaves toward the terminals. */
  exits: { node: number; along: number; terminal: boolean }[];
  /** Every node on the runway's centreline, for lining up. */
  runwayNodes: Set<number>;
}

export class PathPredictor {
  readonly graph: TaxiGraph;
  readonly ends = new Map<string, RunwayEnd>();
  private readonly ramp: Set<number>;

  constructor(
    map: Pick<AirportMap, "taxiways" | "runways" | "holdingPositions" | "gates">,
    private readonly procedures: LocalProcedures | null = null,
  ) {
    const graph = buildTaxiGraph(map);
    this.graph = graph;
    const nearGate = (x: number, y: number, r: number) => map.gates.some((g) => Math.hypot(g.x - x, g.y - y) <= r);
    // The terminals' side of each runway: where the gates are.
    const centre = map.gates.length ? [map.gates.reduce((s, g) => s + g.x, 0) / map.gates.length, map.gates.reduce((s, g) => s + g.y, 0) / map.gates.length] : [0, 0];
    const onRunway = new Set<number>();
    for (const e of graph.edges) if (e.kind === "runway") onRunway.add(e.a).add(e.b);
    this.ramp = new Set(graph.nodes.flatMap((n, i) => (!onRunway.has(i) && nearGate(n.x, n.y, RAMP_RADIUS) ? [i] : [])));

    for (const r of map.runways) {
      if (r.ends.length < 2 || !r.ref) continue;
      const nodes = new Set<number>();
      for (const e of graph.edges) if (e.kind === "runway" && e.runway === r.ref) nodes.add(e.a).add(e.b);
      for (const [from, to] of [
        [r.ends[0], r.ends[1]],
        [r.ends[1], r.ends[0]],
      ]) {
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        if (!(length > 0)) continue;
        const ux = (to.x - from.x) / length;
        const uy = (to.y - from.y) / length;
        const frame = (x: number, y: number) => ({ along: (x - from.x) * ux + (y - from.y) * uy, across: -(x - from.x) * uy + (y - from.y) * ux });
        const terminalSide = Math.sign(frame(centre[0], centre[1]).across);
        const holds = graph.nodes.flatMap((n, i) => {
          if (!n.hold) return [];
          const { along, across } = frame(n.x, n.y);
          return along >= -HOLD_BEFORE && along <= HOLD_PAST && Math.abs(across) >= HOLD_SIDE[0] && Math.abs(across) <= HOLD_SIDE[1] ? [i] : [];
        });
        const exits: RunwayEnd["exits"] = [];
        for (const i of nodes) {
          const off = graph.links[i].map((k) => graph.edges[k]).filter((e) => e.kind !== "runway");
          if (!off.length) continue;
          // Which side the taxiway leaves to: a little way along it from the runway.
          const terminal = off.some((e) => {
            const p = e.a === i ? e.line[Math.min(1, e.line.length - 1)] : e.line[Math.max(0, e.line.length - 2)];
            return Math.sign(frame(p[0], p[1]).across) === terminalSide;
          });
          exits.push({ node: i, along: frame(graph.nodes[i].x, graph.nodes[i].y).along, terminal });
        }
        exits.sort((p, q) => p.along - q.along);
        const entries = exits.filter((e) => e.along >= -50 && e.along <= HOLD_PAST).map((e) => ({ node: e.node, lineUp: [], cost: 0, entryAlong: e.along }));
        // Each holding point's way on to this runway: the nearest join with it. A hold farther than that from it is another runway's.
        const lineUps = holds.flatMap((node) => {
          const reach = shortestPaths(graph, node, {});
          let entry = -1;
          for (const n of nodes) if (reach.cost(n) < (entry < 0 ? Infinity : reach.cost(entry))) entry = n;
          if (entry < 0 || reach.cost(entry) > LINE_UP_MAX) return [];
          const route = reach.path(entry)!;
          return [{ node, lineUp: route.points.slice(1), cost: route.length, entryAlong: frame(graph.nodes[entry].x, graph.nodes[entry].y).along }];
        });
        this.ends.set(designator(from.ref), {
          designator: designator(from.ref),
          x: from.x,
          y: from.y,
          ux,
          uy,
          length,
          departureTargets: lineUps.length ? lineUps : entries,
          exits,
          runwayNodes: nodes,
        });
      }
    }
  }

  /** The likely path of one aircraft, given the runways in use; null when there is nothing honest to draw. */
  predict(a: PathAircraft, use: RunwayUse[], options: PredictOptions = {}): PredictedPath | null {
    const s = a.situation;
    if (s.state === "parked") return null;
    const end = s.runway ? this.ends.get(s.runway) : undefined;
    const base = { id: a.id, state: s.state };
    if (end && s.state === "arriving" && (s.activity === "Final approach" || s.activity === "Landing" || s.activity === "Landing rollout")) {
      return this.arrival(base, a, end, false);
    }
    if (!s.runway && options.inferRunway && s.state === "arriving" && !a.onGround && s.aglFt <= INFER_MAX_AGL) {
      const inferred = this.arrivalEnd(a, use, options.wind ?? null);
      return inferred && this.arrival(base, a, inferred, true);
    }
    if (end && s.state === "departing" && (s.activity === "Lined up" || s.activity === "Takeoff roll")) {
      return { ...base, kind: "departure", runway: end.designator, ...this.takeoff(end, along(end, a.x, a.y), a.destination) };
    }
    if (end && s.state === "departing" && s.activity === "Climbing out") {
      const h = s.aglFt * FEET;
      const sid = this.likelySid(end, a.destination);
      if (sid) {
        const line = climbOutLine(sid.legs, this.liftoff(end, 0), CLIMB_GRADIENT).points;
        // From the aircraft on, never lower than it would be climbing on from where it is.
        let d = 0;
        let last: LinePoint = [a.x, a.y, h];
        const ahead = joinAhead(line, a.x, a.y).map((p): LinePoint => {
          d += Math.hypot(p[0] - last[0], p[1] - last[1]);
          last = p;
          return [p[0], p[1], Math.max(p[2], h + d * CLIMB_GRADIENT)];
        });
        return { ...base, kind: "departure", runway: end.designator, legs: [{ kind: "air", points: [[a.x, a.y, h], ...ahead] }], procedure: this.cite("climb-out", sid.ident, true) };
      }
      const straight: PredictedPath = { ...base, kind: "departure", runway: end.designator, legs: [{ kind: "air", points: [[a.x, a.y, h], [a.x + end.ux * CLIMB_LENGTH, a.y + end.uy * CLIMB_LENGTH, h + CLIMB_LENGTH * CLIMB_GRADIENT]] }] };
      return this.noSids() ? { ...straight, procedure: this.cite("no-sid", "", false) } : straight;
    }
    if (!a.onGround || s.state !== "taxiing") return null;
    const headingDeg = a.headingKnown ? a.headingDeg : null;
    const start = locate(this.graph, a.x, a.y, { headingDeg, maxDistance: OFF_NETWORK });
    if (!start) return null;
    const reach = shortestPaths(this.graph, start, { headingDeg });
    let direction = a.direction;
    if (!direction && headingDeg !== null) {
      // Nothing says which way it is going, so its nose does: of the shortest ways to the runway and
      // to the ramp, the one that sets off behind it is not where it is going.
      const free = shortestPaths(this.graph, start, {});
      const hold = this.bestHold(free, use);
      const ramp = this.bestRamp(free);
      const behind = (node: number | undefined) => node !== undefined && setsOffBehind(free.path(node)?.points ?? [], headingDeg);
      const holdBehind = behind(hold?.target.node);
      const rampBehind = behind(ramp?.node);
      direction = holdBehind && !rampBehind ? "inbound" : rampBehind && !holdBehind ? "outbound" : null;
    }
    if (!direction) return null;
    const lead: PathPoint[] = Math.hypot(start.x - a.x, start.y - a.y) > 2 ? [[a.x, a.y, 0]] : [];
    if (direction === "inbound") {
      const taxi = this.toRamp(reach);
      return taxi && { ...base, kind: "arrival", runway: null, legs: [{ kind: "taxi", points: [...lead, ...taxi] }] };
    }
    return this.departure(base, reach, lead, use, a.destination);
  }

  /**
   * The holding point a departure makes for: the cheapest to reach, counting each metre it sits down
   * the runway from the threshold twice, since departures want the full length and an intersection
   * departure is the exception.
   */
  private bestHold(reach: Reach, use: RunwayUse[]): { end: RunwayEnd; target: RunwayEnd["departureTargets"][number]; cost: number } | null {
    let best: { end: RunwayEnd; target: RunwayEnd["departureTargets"][number]; cost: number } | null = null;
    for (const end of this.departureEnds(use)) {
      for (const target of end.departureTargets) {
        const cost = reach.cost(target.node) + target.cost + 2 * Math.max(0, target.entryAlong);
        if (cost < (best?.cost ?? Infinity)) best = { end, target, cost };
      }
    }
    return best;
  }

  private bestRamp(reach: Reach): { node: number; cost: number } | null {
    let best: { node: number; cost: number } | null = null;
    for (const node of this.ramp) {
      const cost = reach.cost(node);
      if (cost < (best?.cost ?? Infinity)) best = { node, cost };
    }
    return best;
  }

  /** The runway ends a departure may use: those seen taking departures, and the same flow's ends not seen in use at all. */
  departureEnds(use: RunwayUse[]): RunwayEnd[] {
    const seen = new Set(use.map((u) => u.runway));
    const flow = use.flatMap((u) => this.ends.get(u.runway) ?? []);
    const out = use.filter((u) => u.departures > 0).flatMap((u) => this.ends.get(u.runway) ?? []);
    for (const e of this.ends.values()) {
      if (seen.has(e.designator) || out.includes(e)) continue;
      // Neither end of its runway seen: a runway landing aircraft one way is not departing them the other.
      const reverse = [...this.ends.values()].find((o) => o !== e && o.runwayNodes === e.runwayNodes);
      if (reverse && seen.has(reverse.designator)) continue;
      if (flow.some((f) => f.ux * e.ux + f.uy * e.uy >= Math.cos(SAME_FLOW_DEG * RAD))) out.push(e);
    }
    return out;
  }

  /**
   * The runway end an arrival not yet lined up with one is likely making for: of the ends arrivals are
   * using (failing any seen, those the wind favours; failing a wind, any), the one whose extended
   * centreline it is nearest, among those it is still short of and its track converges on: closing on
   * the threshold, and either within ON_FINAL of the centreline or heading toward it. Without a heading
   * or a track to go by, none.
   */
  private arrivalEnd(a: PathAircraft, use: RunwayUse[], wind: Wind | null): RunwayEnd | null {
    if (!a.headingKnown) return null;
    const tx = Math.sin(a.headingDeg * RAD);
    const ty = Math.cos(a.headingDeg * RAD);
    const all = [...this.ends.values()];
    let candidates = use.filter((u) => u.arrivals > 0).flatMap((u) => this.ends.get(u.runway) ?? []);
    if (!candidates.length && wind && wind.directionDeg !== null && wind.speedKt > 0) {
      // Into the wind: an end whose direction has the wind coming from ahead.
      const from = [Math.sin(wind.directionDeg * RAD), Math.cos(wind.directionDeg * RAD)];
      candidates = all.filter((e) => e.ux * from[0] + e.uy * from[1] > 0);
    }
    if (!candidates.length) candidates = all;
    let best: RunwayEnd | null = null;
    let bestAcross = Infinity;
    for (const e of candidates) {
      const d = along(e, a.x, a.y);
      if (d > -APPROACH_MIN || d < -INFER_RANGE) continue;
      const side = -(a.x - e.x) * e.uy + (a.y - e.y) * e.ux;
      const across = Math.abs(side);
      // Closing on the threshold, and not drifting off the centreline (the track's sideways part toward it).
      const closing = tx * (e.x - a.x) + ty * (e.y - a.y) > 0;
      const drift = -tx * e.uy + ty * e.ux;
      if (!closing || (across > ON_FINAL && Math.sign(drift) === Math.sign(side))) continue;
      if (across < bestAcross) {
        best = e;
        bestAcross = across;
      }
    }
    return best;
  }

  /** The SID off this runway that leaves nearest the destination's bearing, when one is near enough to call it likely. */
  private likelySid(end: RunwayEnd, destination: PathAircraft["destination"]): LocalDeparture | null {
    return this.procedures && destination ? likelySid(this.procedures, end.designator, destination) : null;
  }

  /** The airport's procedure file has no SID for any runway (ORD and PHL in cycle 2610). */
  private noSids(): boolean {
    return !!this.procedures && !Object.values(this.procedures.departures).some((list) => list?.length);
  }

  private cite(kind: PathProcedure["kind"], name: string, likely: boolean): PathProcedure {
    return { kind, name, cycle: this.procedures?.cycle ?? "", likely };
  }

  private departure(base: Pick<PredictedPath, "id" | "state">, reach: Reach, lead: PathPoint[], use: RunwayUse[], destination?: PathAircraft["destination"]): PredictedPath | null {
    const best = this.bestHold(reach, use);
    if (!best || !Number.isFinite(best.cost)) return null;
    const { end, target } = best;
    const toHold = reach.path(target.node)!;
    const taxi = [...lead, ...[...toHold.points, ...target.lineUp].map(([x, y]): PathPoint => [x, y, 0])];
    const last = taxi[taxi.length - 1];
    const { legs, procedure } = this.takeoff(end, along(end, last[0], last[1]), destination);
    return { ...base, kind: "departure", runway: end.designator, legs: [{ kind: "taxi", points: taxi }, ...legs], ...(procedure ? { procedure } : {}) };
  }

  /** Where a takeoff from `from` metres down the runway leaves the ground. */
  private liftoff(end: RunwayEnd, from: number): PathPoint {
    const start = Math.max(0, from);
    const lift = Math.max(start + 200, Math.min(start + TAKEOFF_ROLL, end.length * TAKEOFF_ROLL_SHARE));
    return [end.x + end.ux * lift, end.y + end.uy * lift, 0];
  }

  /** The roll from `from` metres down the runway, and the climb-out beyond: the likely SID's, or the extended centreline. */
  private takeoff(end: RunwayEnd, from: number, destination?: PathAircraft["destination"]): { legs: PathLeg[]; procedure?: PathProcedure } {
    const start = Math.max(0, from);
    const lift = this.liftoff(end, from);
    const roll: PathLeg = { kind: "runway", points: [[end.x + end.ux * start, end.y + end.uy * start, 0], lift] };
    const sid = this.likelySid(end, destination);
    if (sid) return { legs: [roll, { kind: "air", points: climbOutLine(sid.legs, lift, CLIMB_GRADIENT).points }], procedure: this.cite("climb-out", sid.ident, true) };
    const legs: PathLeg[] = [roll, { kind: "air", points: [lift, [lift[0] + end.ux * CLIMB_LENGTH, lift[1] + end.uy * CLIMB_LENGTH, CLIMB_LENGTH * CLIMB_GRADIENT]] }];
    return this.noSids() ? { legs, procedure: this.cite("no-sid", "", false) } : { legs };
  }

  /**
   * Down to the runway, along it and off to the ramp. In the air: down the runway's published final
   * approach from the next fix ahead of the aircraft (never climbing on the way), over the threshold
   * and on to touchdown; without one, straight to touchdown.
   */
  private arrival(base: Pick<PredictedPath, "id" | "state">, a: PathAircraft, end: RunwayEnd, inferred: boolean): PredictedPath | null {
    const pos = along(end, a.x, a.y);
    const legs: PathLeg[] = [];
    let touchdown = pos;
    let speed = (a.groundSpeedKt ?? 0) * KNOTS;
    let procedure: PathProcedure | undefined;
    if (!a.onGround) {
      touchdown = Math.max(TOUCHDOWN_ALONG, pos + 300);
      speed = TOUCHDOWN_SPEED;
      const h = a.situation.aglFt * FEET;
      const approach = pos < -APPROACH_MIN ? this.procedures?.approaches[end.designator] : undefined;
      const points: PathPoint[] = [[a.x, a.y, h]];
      if (approach) {
        for (const p of joinAhead(approachLine(approach).points, a.x, a.y)) points.push([p[0], p[1], Math.min(p[2], points[points.length - 1][2])]);
        procedure = this.cite("approach", approach.name, inferred);
      }
      points.push([end.x + end.ux * touchdown, end.y + end.uy * touchdown, 0]);
      legs.push({ kind: "air", points });
    }
    const stop = touchdown + Math.max(0, speed ** 2 - EXIT_SPEED ** 2) / (2 * ROLLOUT_DECEL);
    const ahead = end.exits.filter((e) => e.along > touchdown + 50);
    const exit = ahead.find((e) => e.along >= stop && e.terminal) ?? ahead.find((e) => e.along >= stop) ?? ahead.at(-1);
    const path = (): PredictedPath | null => (legs.length ? { ...base, kind: "arrival", runway: end.designator, legs, ...(procedure ? { procedure } : {}) } : null);
    if (!exit) return path();
    const node = this.graph.nodes[exit.node];
    legs.push({ kind: "runway", points: [[end.x + end.ux * touchdown, end.y + end.uy * touchdown, 0], [node.x, node.y, 0]] });
    const taxi = this.toRamp(shortestPaths(this.graph, exit.node, {}));
    if (taxi) legs.push({ kind: "taxi", points: taxi });
    return path();
  }

  /** The shortest route on to the ramp, or null when there is none or the aircraft is already there. */
  private toRamp(reach: Reach): PathPoint[] | null {
    const best = this.bestRamp(reach);
    if (!best || !Number.isFinite(best.cost) || best.cost < ARRIVED) return null;
    return reach.path(best.node)!.points.map(([x, y]): PathPoint => [x, y, 0]);
  }
}

/**
 * The points of a line ahead of an aircraft at (x, y): those after the point on the line nearest it.
 * An aircraft off the line joins it at the next fix ahead of where it is abeam; one before the
 * line's start joins it there.
 */
function joinAhead(line: LinePoint[], x: number, y: number): LinePoint[] {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    const u = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
    const d = Math.hypot(ax + (bx - ax) * u - x, ay + (by - ay) * u - y);
    if (d < bestD) {
      bestD = d;
      // Abeam the line's very start: all of it is still ahead.
      best = i === 0 && u === 0 ? -1 : i;
    }
  }
  return line.slice(best + 1);
}

/** Whether a route's first stretch runs against a heading. */
function setsOffBehind(points: Point[], headingDeg: number): boolean {
  const [x0, y0] = points[0] ?? [0, 0];
  const p = points.find(([x, y]) => Math.hypot(x - x0, y - y0) >= SETTING_OFF);
  if (!p) return false;
  return (p[0] - x0) * Math.sin(headingDeg * RAD) + (p[1] - y0) * Math.cos(headingDeg * RAD) < 0;
}

function along(end: RunwayEnd, x: number, y: number): number {
  return (x - end.x) * end.ux + (y - end.y) * end.uy;
}
