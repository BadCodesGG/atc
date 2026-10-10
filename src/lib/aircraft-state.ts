import type { AirportMap, Runway } from "./airport-map";
import { KNOTS } from "./geo";
import type { TrackedAircraft } from "./tracker";

/**
 * What an aircraft is doing, from one moment of its track and the airport's ground plan: the four
 * states the legend colours, and the words the selected-flight card and tag show. Pure and
 * deterministic, so the same snapshot always reads the same way.
 */

export type FlightState = "arriving" | "departing" | "taxiing" | "parked";

export type Motion = Pick<TrackedAircraft, "x" | "y" | "altitudeFt" | "headingDeg" | "headingKnown" | "groundSpeedKt" | "onGround" | "verticalRateFpm"> &
  Partial<Pick<TrackedAircraft, "category" | "typeCode">>;

export type AirsideContext = Pick<AirportMap, "runways" | "gates" | "stands"> & { elevationFt: number };

export interface Situation {
  state: FlightState;
  /** Short phrase, e.g. "Takeoff roll", "At gate E15", "Final approach". */
  activity: string;
  /** Designator the aircraft is using, e.g. "9R", or null when no runway is involved. */
  runway: string | null;
  /** Feet above field elevation; 0 on the ground. */
  aglFt: number;
  moving: boolean;
  /** The gate or stand a parked aircraft is at, when the map names it. */
  place?: Place;
  /** A ground vehicle broadcasting a transponder (a tug, a fire truck): never a flight, never featured. */
  vehicle?: true;
}

export interface Place {
  kind: "gate" | "stand";
  ref: string;
}

/** Slower than this counts as standing still. */
const MOVING_KT = 3;
/** Faster than this on a runway is a takeoff or a landing, not a taxi. */
const RUNWAY_ROLL_KT = 30;
/** Past a runway's edge by this much still counts as on it (position noise, wide aircraft). */
const RUNWAY_MARGIN = 15;
const GATE_RADIUS = 80;
const STAND_RADIUS = 60;
/** Takeoff acceleration and landing deceleration, m/s², for telling a takeoff roll from a rollout. */
const ROLL_ACCEL = 2;
/** Where and how fast a landing aircraft typically touches down: metres past the threshold, m/s. */
const TOUCHDOWN_DISTANCE = 400;
const TOUCHDOWN_SPEED = 70;
/** A heading within this of the runway's direction is lined up with it. */
const ALIGNED_DEG = 25;
/** Final approach: how far out, how far off the extended centreline, and how high it is recognised. */
const FINAL_RANGE = 15_000;
const FINAL_OFFSET = 450;
const FINAL_MAX_AGL = 4_000;
/** Vertical rate beyond which an aircraft is climbing or descending rather than level, ft/min. */
const VERTICAL_FPM = 300;

const RAD = Math.PI / 180;

/** "09R" as a pilot says it: "9R". "09R/27L" becomes "9R/27L". */
export function designator(ref: string): string {
  return ref
    .split("/")
    .map((part) => part.replace(/^0+(?=\d)/, ""))
    .join("/");
}

interface RunwayFrame {
  runway: Runway;
  /** Unit vector from ends[0] to ends[1]. */
  ux: number;
  uy: number;
  length: number;
}

function frame(runway: Runway): RunwayFrame | null {
  if (runway.ends.length < 2) return null;
  const [a, b] = runway.ends;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 0)) return null;
  return { runway, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length, length };
}

/** Along-track distance from ends[0] and signed offset to the left of the centreline, metres. */
function local(f: RunwayFrame, x: number, y: number): { along: number; across: number } {
  const [a] = f.runway.ends;
  const dx = x - a.x;
  const dy = y - a.y;
  return { along: dx * f.ux + dy * f.uy, across: -dx * f.uy + dy * f.ux };
}

/** Cosine of the angle between a compass heading and the runway's ends[0] to ends[1] direction. */
function alignment(f: RunwayFrame, headingDeg: number): number {
  const h = headingDeg * RAD;
  return Math.sin(h) * f.ux + Math.cos(h) * f.uy;
}

function onRunway(runways: Runway[], x: number, y: number): RunwayFrame | null {
  for (const runway of runways) {
    const f = frame(runway);
    if (!f) continue;
    const { along, across } = local(f, x, y);
    if (along >= -RUNWAY_MARGIN && along <= f.length + RUNWAY_MARGIN && Math.abs(across) <= runway.width / 2 + RUNWAY_MARGIN) return f;
  }
  return null;
}

/**
 * Which way along the runway the aircraft is going: the end it started from (its designator is the
 * one in use) and the distance it has come from that end.
 */
function direction(f: RunwayFrame, m: Motion): { from: string; travelled: number } {
  const { along } = local(f, m.x, m.y);
  const [a, b] = f.runway.ends;
  return alignment(f, m.headingDeg) >= 0 ? { from: a.ref, travelled: along } : { from: b.ref, travelled: f.length - along };
}

function nearest<T extends { x: number; y: number }>(items: T[], x: number, y: number, radius: number): T | null {
  let best: T | null = null;
  let bestD = radius;
  for (const item of items) {
    const d = Math.hypot(item.x - x, item.y - y);
    if (d <= bestD) {
      best = item;
      bestD = d;
    }
  }
  return best;
}

function assessGround(m: Motion, ctx: AirsideContext, speedKt: number, previous: FlightState | undefined): Omit<Situation, "aglFt" | "moving"> {
  const moving = speedKt >= MOVING_KT;
  const f = onRunway(ctx.runways, m.x, m.y);
  if (f) {
    const aligned = Math.abs(alignment(f, m.headingDeg)) >= Math.cos(ALIGNED_DEG * RAD);
    const { from, travelled } = direction(f, m);
    const runway = designator(from);
    if (!moving && aligned) return { state: "departing", activity: "Lined up", runway };
    if (speedKt >= RUNWAY_ROLL_KT && aligned) {
      if (previous === "arriving" || previous === "departing") {
        return previous === "arriving" ? { state: "arriving", activity: "Landing rollout", runway } : { state: "departing", activity: "Takeoff roll", runway };
      }
      // Which curve is the aircraft nearer: a takeoff accelerating from the threshold, or a landing slowing from touchdown?
      const v2 = (speedKt * KNOTS) ** 2;
      const takeoff = 2 * ROLL_ACCEL * Math.max(0, travelled);
      const landing = Math.max(0, TOUCHDOWN_SPEED ** 2 - 2 * ROLL_ACCEL * Math.max(0, travelled - TOUCHDOWN_DISTANCE));
      return Math.abs(v2 - takeoff) <= Math.abs(v2 - landing)
        ? { state: "departing", activity: "Takeoff roll", runway }
        : { state: "arriving", activity: "Landing rollout", runway };
    }
    if (!aligned) return { state: "taxiing", activity: `Crossing runway ${designator(f.runway.ref ?? `${f.runway.ends[0].ref}/${f.runway.ends[1].ref}`)}`, runway: null };
    return { state: "taxiing", activity: "Taxiing", runway };
  }
  if (moving) return { state: "taxiing", activity: "Taxiing", runway: null };
  const gate = nearest(ctx.gates, m.x, m.y, GATE_RADIUS);
  if (gate) return gate.ref ? { state: "parked", activity: `At gate ${gate.ref}`, runway: null, place: { kind: "gate", ref: gate.ref } } : { state: "parked", activity: "At gate", runway: null };
  const stand = nearest(ctx.stands, m.x, m.y, STAND_RADIUS);
  if (stand) return stand.ref ? { state: "parked", activity: "Parked", runway: null, place: { kind: "stand", ref: stand.ref } } : { state: "parked", activity: "Parked", runway: null };
  return { state: "taxiing", activity: "Holding", runway: null };
}

/**
 * The ADS-B emitter categories for surface vehicles (emergency, service) and fixed obstacles, and the
 * type designators the aircraft databases give vehicles; any of these on the feed is not an aircraft.
 */
const VEHICLE_CATEGORIES = new Set(["C1", "C2", "C3"]);
const VEHICLE_TYPES = new Set(["SERV", "GRND", "EMER", "TWR"]);

/** Whether a transponder on the feed is a ground vehicle or obstacle rather than an aircraft. */
export function isVehicle({ category, typeCode }: Partial<Pick<TrackedAircraft, "category" | "typeCode">>): boolean {
  return (!!category && VEHICLE_CATEGORIES.has(category.toUpperCase())) || (!!typeCode && VEHICLE_TYPES.has(typeCode.toUpperCase()));
}

/**
 * A vehicle reads as what it is, with the runway it is on, since that is what a watcher wants to know of
 * one: never "Lined up" or "Takeoff roll" for a van that stopped on the centreline.
 */
function assessVehicle(m: Motion, ctx: AirsideContext, moving: boolean): Situation {
  const kind = m.category?.toUpperCase() === "C1" || m.typeCode?.toUpperCase() === "EMER" ? "Emergency vehicle" : "Ground vehicle";
  const f = onRunway(ctx.runways, m.x, m.y);
  const activity = f ? `${kind} on runway ${designator(f.runway.ref ?? `${f.runway.ends[0].ref}/${f.runway.ends[1].ref}`)}` : kind;
  return { state: moving ? "taxiing" : "parked", activity, runway: null, aglFt: 0, moving, vehicle: true };
}

/**
 * Read one aircraft's situation. `previous` is the state it was given a moment ago, when known: it
 * settles the one case a single moment cannot, a fast aircraft on a runway that could be taking off
 * or have just landed.
 */
export function assess(m: Motion, ctx: AirsideContext, previous?: FlightState): Situation {
  const speedKt = m.groundSpeedKt ?? 0;
  const moving = speedKt >= MOVING_KT;
  if (isVehicle(m)) return assessVehicle(m, ctx, moving);
  if (m.onGround) return { ...assessGround(m, ctx, speedKt, previous), aglFt: 0, moving };
  const aglFt = Math.max(0, m.altitudeFt - ctx.elevationFt);
  return { ...assessAir(m, ctx, aglFt), aglFt, moving };
}

function assessAir(m: Motion, ctx: AirsideContext, aglFt: number): Omit<Situation, "aglFt" | "moving"> {
  const vr = m.verticalRateFpm ?? 0;
  const climbing = vr > VERTICAL_FPM;
  if (m.headingKnown && aglFt <= FINAL_MAX_AGL) {
    // Of the runways the aircraft is lined up with, the one nearest its extended centreline.
    let best: Omit<Situation, "aglFt" | "moving"> | null = null;
    let bestOffset = FINAL_OFFSET;
    for (const runway of ctx.runways) {
      const f = frame(runway);
      if (!f) continue;
      const { along, across } = local(f, m.x, m.y);
      if (Math.abs(across) > bestOffset) continue;
      const cos = alignment(f, m.headingDeg);
      if (Math.abs(cos) < Math.cos(ALIGNED_DEG * RAD)) continue;
      // Measure from the threshold the aircraft is flying toward or away from, in its direction of travel.
      const forward = cos > 0;
      const from = forward ? runway.ends[0].ref : runway.ends[1].ref;
      const d = forward ? along : f.length - along;
      const rwy = designator(from);
      let found: Omit<Situation, "aglFt" | "moving"> | null = null;
      if (d < 0 && d >= -FINAL_RANGE && !climbing) found = { state: "arriving", activity: "Final approach", runway: rwy };
      else if (d >= 0 && d <= f.length && !climbing) found = { state: "arriving", activity: "Landing", runway: rwy };
      else if (d >= 0 && d <= f.length + FINAL_RANGE && climbing) found = { state: "departing", activity: "Climbing out", runway: rwy };
      if (found) {
        best = found;
        bestOffset = Math.abs(across);
      }
    }
    if (best) return best;
  }
  if (climbing) return { state: "departing", activity: "Climbing", runway: null };
  if (vr < -VERTICAL_FPM) return { state: "arriving", activity: "Descending", runway: null };
  // Level: closing on the field or leaving it.
  const h = m.headingDeg * RAD;
  const closing = -(Math.sin(h) * m.x + Math.cos(h) * m.y) > 0;
  return closing ? { state: "arriving", activity: "Inbound", runway: null } : { state: "departing", activity: "Outbound", runway: null };
}

export interface TrafficCounts {
  tracked: number;
  onGround: number;
  moving: number;
}

export function countTraffic(list: { onGround: boolean; situation: Situation }[]): TrafficCounts {
  let onGround = 0;
  let moving = 0;
  for (const a of list) {
    if (a.onGround) onGround++;
    if (a.situation.moving) moving++;
  }
  return { tracked: list.length, onGround, moving };
}

/** Lower is more worth showing: using a runway, then on final or climbing out, then taxiing, then the rest, vehicles last. */
export function interest(s: Situation): number {
  if (s.vehicle) return 5;
  if (s.state === "parked") return 4;
  if (s.state === "taxiing") return s.moving ? 2 : 3;
  if (s.runway === null) return 3;
  return s.aglFt < 500 ? 0 : 1;
}

/** The aircraft the view opens on: the most interesting one, and of those the nearest the reference point. Never a vehicle. */
export function pickFeatured<T extends { x: number; y: number; situation: Situation }>(list: T[]): T | null {
  let best: T | null = null;
  let bestKey = Infinity;
  for (const a of list) {
    if (a.situation.vehicle) continue;
    const key = interest(a.situation) * 1e9 + Math.hypot(a.x, a.y);
    if (key < bestKey) {
      best = a;
      bestKey = key;
    }
  }
  return best;
}

/**
 * A heading for an aircraft on the ground that has never broadcast one: its stand's, when it is on a
 * stand that has one, else along the nearest taxiway or runway (which of the two ways is a guess).
 */
export function groundHeading(plan: Pick<AirportMap, "runways" | "taxiways" | "stands">, x: number, y: number): number {
  const stand = nearest(
    plan.stands.filter((s) => s.headingDeg !== null),
    x,
    y,
    STAND_RADIUS,
  );
  if (stand?.headingDeg != null) return stand.headingDeg;
  let best = Infinity;
  let heading = 0;
  const visit = (line: [number, number][]) => {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (!(len2 > 0)) continue;
      const u = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
      const d = Math.hypot(ax + u * dx - x, ay + u * dy - y);
      if (d < best) {
        best = d;
        heading = ((Math.atan2(dx, dy) / RAD) % 360 + 360) % 360;
      }
    }
  };
  for (const t of plan.taxiways) visit(t.line);
  for (const r of plan.runways) visit(r.centerline);
  return heading;
}
