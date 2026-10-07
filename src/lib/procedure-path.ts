import type { Point } from "./airport-map";
import type { Airport } from "./airports";
import type { AirportProcedures, ProcedureLeg } from "./cifp";
import { FEET, type Origin, toGeo, toLocal } from "./geo";

/**
 * The published procedures (cifp.ts, shipped as src/data/procedures/<code>.json) as lines in the
 * scene's frame: an approach's final from its intermediate fix to the threshold, and a SID's climb
 * from where the aircraft lifts off. Pure.
 *
 * How each leg type is drawn, since several have no fixed shape:
 * - IF, TF, CF, DF: straight to the fix.
 * - RF: the arc about its published centre, exactly; straight to the fix when the centre is missing.
 * - VA, CA, FA (to an altitude): along the course until the climb reaches the altitude, at the
 *   gradient the caller gives.
 * - VI, CI (to intercept): along the course until it meets the next leg's course to its fix; when it
 *   never does within 30 km, the next leg goes direct from where the line is.
 * - VM, FM (to a manual termination: radar vectors): three nautical miles along the course, and the
 *   line ends there, since nothing past it is published.
 * - FC: along the course for its distance.
 * - VD, CD (to a DME distance): along the course until the recommended navaid is that far away (the
 *   first time, when it is ahead); VR, CR (to a radial): along the course until it crosses the radial.
 *   One that never gets there within 30 km is skipped.
 * - Everything else is skipped and named: holds (HA, HF, HM), procedure turns (PI) and DME arcs (AF),
 *   which belong to the approach transitions and missed approaches this does not draw, and anything
 *   unknown.
 */

/** Metres east, north, and above the field. */
export type LinePoint = [number, number, number];

export interface LocalLeg {
  type: string;
  at?: Point;
  centre?: Point;
  /** The navaid a VD, CD, VR or CR leg is measured from, and the radial (degrees true) a VR or CR ends on. */
  navaid?: Point;
  radialDeg?: number;
  role?: "FAF" | "MAP";
  courseDeg?: number;
  distanceM?: number;
  turn?: "L" | "R";
  /** Metres above the field. */
  altitudeM?: { kind: "at" | "atOrAbove" | "atOrBelow" | "between"; m: number; lowerM?: number };
  verticalAngleDeg?: number;
}

export interface LocalApproach {
  ident: string;
  name: string;
  legs: LocalLeg[];
  /** Where the final crosses the threshold, metres above the field. */
  threshold: { x: number; y: number; heightM: number };
}

export interface LocalDeparture {
  ident: string;
  legs: LocalLeg[];
}

/** One airport's procedure file as shipped. */
export type ProcedureFile = AirportProcedures & { source: "FAA CIFP"; cycle: string; effective: string };

export interface LocalProcedures {
  cycle: string;
  effective: string;
  origin: Origin;
  approaches: Record<string, LocalApproach | undefined>;
  departures: Record<string, LocalDeparture[] | undefined>;
}

export interface ProcedureLine {
  points: LinePoint[];
  /** Leg types left out, in order. */
  skipped: string[];
  /** The line ends where radar vectors take over. */
  vectors: boolean;
}

const NM = 1852;
/** A heading to a manual termination is drawn this far, metres. */
const VECTOR_STUB = 3 * NM;
/** Farthest a heading leg is followed looking for its altitude or intercept, and longest climb drawn, metres. */
const LEG_REACH = 30_000;
const CLIMB_REACH = 40_000;
/** An arc is drawn in steps of at most this many degrees. */
const ARC_STEP = 5;
/** The angle a final without a published one is drawn at, degrees. */
const DEFAULT_ANGLE = 3;
const RAD = Math.PI / 180;

export function localProcedures(file: ProcedureFile, airport: Pick<Airport, "latitude" | "longitude" | "elevationFt">): LocalProcedures {
  const xy = (f: { lat: number; lon: number }): Point => toLocal(airport, f.lat, f.lon);
  const above = (ft: number) => (ft - airport.elevationFt) * FEET;
  const leg = (l: ProcedureLeg): LocalLeg => {
    const out: LocalLeg = { type: l.type };
    if (l.fix) out.at = xy(l.fix);
    if (l.centre) out.centre = xy(l.centre);
    if (l.navaid) out.navaid = xy(l.navaid);
    if (l.radialDeg !== undefined) out.radialDeg = l.radialDeg;
    if (l.role) out.role = l.role;
    if (l.courseDeg !== undefined) out.courseDeg = l.courseDeg;
    if (l.distanceNm !== undefined) out.distanceM = l.distanceNm * NM;
    if (l.turn) out.turn = l.turn;
    if (l.altitude) out.altitudeM = { kind: l.altitude.kind, m: above(l.altitude.ft), ...(l.altitude.lowerFt !== undefined ? { lowerM: above(l.altitude.lowerFt) } : {}) };
    if (l.verticalAngleDeg !== undefined) out.verticalAngleDeg = l.verticalAngleDeg;
    return out;
  };
  const approaches: LocalProcedures["approaches"] = {};
  for (const [runway, a] of Object.entries(file.approaches)) {
    const [x, y] = xy(a.threshold);
    approaches[runway] = { ident: a.ident, name: a.name, legs: a.legs.map(leg), threshold: { x, y, heightM: above(a.threshold.elevationFt + a.threshold.crossingHeightFt) } };
  }
  const departures: LocalProcedures["departures"] = {};
  for (const [runway, list] of Object.entries(file.departures)) departures[runway] = list.map((d) => ({ ident: d.ident, legs: d.legs.map(leg) }));
  return { cycle: file.cycle, effective: file.effective, origin: { latitude: airport.latitude, longitude: airport.longitude }, approaches, departures };
}

const direction = (courseDeg: number): Point => [Math.sin(courseDeg * RAD), Math.cos(courseDeg * RAD)];

/** The arc from `from` to `to` about `centre`, turning left (anticlockwise seen from above) or right; the points after `from`. */
function arc(from: Point, to: Point, centre: Point, turn: "L" | "R"): Point[] {
  const r = (Math.hypot(from[0] - centre[0], from[1] - centre[1]) + Math.hypot(to[0] - centre[0], to[1] - centre[1])) / 2;
  const a0 = Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  let sweep = Math.atan2(to[1] - centre[1], to[0] - centre[0]) - a0;
  // Left is anticlockwise in east-north axes: a positive sweep.
  if (turn === "L") while (sweep <= 0) sweep += 2 * Math.PI;
  else while (sweep >= 0) sweep -= 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (ARC_STEP * RAD)));
  const out: Point[] = [];
  for (let i = 1; i < n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)]);
  }
  out.push(to);
  return out;
}

/**
 * How far along the ray from `p` in unit direction `d` it first meets the ray from `q` in direction
 * `e` (ahead on both), within LEG_REACH; null when it never does.
 */
function crossing(p: Point, d: Point, q: Point, e: Point): number | null {
  // p + s·d = q + u·e, solved for s and u by Cramer's rule.
  const det = -d[0] * e[1] + e[0] * d[1];
  if (Math.abs(det) < 1e-9) return null;
  const rx = q[0] - p[0];
  const ry = q[1] - p[1];
  const s = (-rx * e[1] + e[0] * ry) / det;
  const u = (d[0] * ry - d[1] * rx) / det;
  return s > 1 && s <= LEG_REACH && u >= 0 ? s : null;
}

/** How far along the ray from `p` in unit direction `d` it is first `r` from `c`, within LEG_REACH; null when never. */
function toDistance(p: Point, d: Point, c: Point, r: number): number | null {
  // |p + s·d - c|² = r²: s² + 2s(d·m) + |m|² - r² = 0, with m = p - c.
  const mx = p[0] - c[0];
  const my = p[1] - c[1];
  const b = d[0] * mx + d[1] * my;
  const disc = b * b - (mx * mx + my * my - r * r);
  if (disc < 0) return null;
  const root = Math.sqrt(disc);
  const s = [-b - root, -b + root].find((x) => x > 1);
  return s !== undefined && s <= LEG_REACH ? s : null;
}

/**
 * An approach's final as a line: its fixes in order (arcs sampled), ending on the threshold. Heights:
 * from the final approach fix in, the published vertical angle down to the threshold crossing height
 * (or, without one, a straight descent from the fix's altitude); outside it, the same angle extended,
 * but never below a fix's published floor nor above its ceiling.
 */
export function approachLine(a: LocalApproach): ProcedureLine {
  const pts: { p: Point; leg: LocalLeg | null }[] = [];
  const skipped: string[] = [];
  for (const leg of a.legs) {
    const last = pts.at(-1)?.p;
    if (leg.at && (leg.type === "IF" || leg.type === "TF" || leg.type === "CF" || leg.type === "DF")) pts.push({ p: leg.at, leg });
    else if (leg.at && leg.type === "RF") {
      const way = last && leg.centre && leg.turn ? arc(last, leg.at, leg.centre, leg.turn) : [leg.at];
      way.forEach((p, i) => pts.push({ p, leg: i === way.length - 1 ? leg : null }));
    } else skipped.push(leg.type);
  }
  const t = a.threshold;
  const end = pts.at(-1)?.p;
  if (!end || Math.hypot(end[0] - t.x, end[1] - t.y) > 1) pts.push({ p: [t.x, t.y], leg: null });
  // Distance to go along the line from each point to the threshold.
  const toGo = new Array<number>(pts.length).fill(0);
  for (let i = pts.length - 2; i >= 0; i--) toGo[i] = toGo[i + 1] + Math.hypot(pts[i + 1].p[0] - pts[i].p[0], pts[i + 1].p[1] - pts[i].p[1]);
  const faf = pts.findIndex((q) => q.leg?.role === "FAF");
  const angle = a.legs.find((l) => l.verticalAngleDeg)?.verticalAngleDeg;
  const fafAlt = faf >= 0 ? pts[faf].leg?.altitudeM?.m : undefined;
  const slope = angle ? Math.tan(angle * RAD) : fafAlt !== undefined && toGo[faf] > 0 ? (fafAlt - t.heightM) / toGo[faf] : Math.tan(DEFAULT_ANGLE * RAD);
  const points = pts.map(({ p, leg }, i): LinePoint => {
    let h = t.heightM + toGo[i] * slope;
    const alt = leg?.altitudeM;
    if (alt && (faf < 0 || i < faf)) {
      if (alt.kind === "at") h = alt.m;
      else if (alt.kind === "atOrAbove") h = Math.max(h, alt.m);
      else if (alt.kind === "atOrBelow") h = Math.min(h, alt.m);
      else h = Math.min(alt.m, Math.max(alt.lowerM ?? -Infinity, h));
    }
    return [p[0], p[1], i === pts.length - 1 ? t.heightM : h];
  });
  return { points, skipped, vectors: false };
}

/**
 * A SID's legs as a line from `start` (where the aircraft lifts off, or is), climbing at `gradient`
 * (metres up a metre along), held to each fix's published ceiling and lifted to its floor.
 */
export function climbOutLine(legs: readonly LocalLeg[], start: LinePoint, gradient: number): ProcedureLine {
  const points: LinePoint[] = [start];
  const skipped: string[] = [];
  let vectors = false;
  let travelled = 0;
  const go = (p: Point, alt?: LocalLeg["altitudeM"], level?: number) => {
    const last = points[points.length - 1];
    const d = Math.hypot(p[0] - last[0], p[1] - last[1]);
    if (d < 1) return;
    travelled += d;
    let h = level ?? last[2] + d * gradient;
    if (alt) {
      if (alt.kind === "atOrAbove") h = Math.max(h, alt.m);
      else if (alt.kind === "at") h = alt.m;
      else if (alt.kind === "atOrBelow") h = Math.min(h, alt.m);
      else h = Math.min(alt.m, Math.max(alt.lowerM ?? -Infinity, h));
    }
    points.push([p[0], p[1], h]);
  };
  for (let i = 0; i < legs.length && !vectors && travelled < CLIMB_REACH; i++) {
    const leg = legs[i];
    const last = points[points.length - 1];
    const t = leg.type;
    if (leg.at && (t === "IF" || t === "TF" || t === "CF" || t === "DF")) go(leg.at, leg.altitudeM);
    else if (leg.at && t === "RF") {
      const way = leg.centre && leg.turn ? arc([last[0], last[1]], leg.at, leg.centre, leg.turn) : [leg.at];
      way.forEach((p, k) => go(p, k === way.length - 1 ? leg.altitudeM : undefined));
    } else if (leg.courseDeg !== undefined && (t === "VA" || t === "CA" || t === "FA") && leg.altitudeM) {
      const [dx, dy] = direction(leg.courseDeg);
      const d = Math.min(LEG_REACH, (leg.altitudeM.m - last[2]) / gradient);
      if (d >= 1) go([last[0] + dx * d, last[1] + dy * d], undefined, Math.max(last[2], leg.altitudeM.m));
    } else if (leg.courseDeg !== undefined && (t === "VI" || t === "CI")) {
      const next = legs[i + 1];
      if (next?.at && next.courseDeg !== undefined) {
        const [dx, dy] = direction(leg.courseDeg);
        const [ex, ey] = direction(next.courseDeg);
        // last + s·d = next.at + u·e, solved for s by Cramer's rule.
        const det = -dx * ey + ex * dy;
        if (Math.abs(det) > 1e-9) {
          const rx = next.at[0] - last[0];
          const ry = next.at[1] - last[1];
          const s = (-rx * ey + ex * ry) / det;
          if (s > 1 && s <= LEG_REACH) go([last[0] + dx * s, last[1] + dy * s]);
        }
      }
    } else if (leg.courseDeg !== undefined && (t === "VM" || t === "FM")) {
      const [dx, dy] = direction(leg.courseDeg);
      go([last[0] + dx * VECTOR_STUB, last[1] + dy * VECTOR_STUB]);
      vectors = true;
    } else if (leg.courseDeg !== undefined && leg.navaid && (t === "VD" || t === "CD") && leg.distanceM) {
      const s = toDistance([last[0], last[1]], direction(leg.courseDeg), leg.navaid, leg.distanceM);
      if (s === null) skipped.push(t);
      else {
        const [dx, dy] = direction(leg.courseDeg);
        go([last[0] + dx * s, last[1] + dy * s]);
      }
    } else if (leg.courseDeg !== undefined && leg.navaid && leg.radialDeg !== undefined && (t === "VR" || t === "CR")) {
      const s = crossing([last[0], last[1]], direction(leg.courseDeg), leg.navaid, direction(leg.radialDeg));
      if (s === null) skipped.push(t);
      else {
        const [dx, dy] = direction(leg.courseDeg);
        go([last[0] + dx * s, last[1] + dy * s]);
      }
    } else if (leg.courseDeg !== undefined && t === "FC" && leg.distanceM) {
      const [dx, dy] = direction(leg.courseDeg);
      go([last[0] + dx * leg.distanceM, last[1] + dy * leg.distanceM]);
    } else skipped.push(t);
  }
  return { points, skipped, vectors };
}

/** A SID is the likely one when it leaves within this of the destination's bearing, degrees. */
const SID_MATCH_DEG = 45;
/** A destination nearer than this, metres, is no guide to the SID. */
const SID_MIN_TRIP = 50_000;

/**
 * The SID off `runway` that leaves nearest the destination's bearing from the airport, when one is
 * within SID_MATCH_DEG; null when none is, the destination is next door, or the runway has no SIDs.
 * Where a SID leaves is its last fix; a vector SID has none and is never the likely one.
 */
export function likelySid(procedures: LocalProcedures, runway: string, destination: { latitude: number; longitude: number }): LocalDeparture | null {
  const sids = procedures.departures[runway];
  if (!sids?.length) return null;
  const [dx, dy] = toLocal(procedures.origin, destination.latitude, destination.longitude);
  if (Math.hypot(dx, dy) < SID_MIN_TRIP) return null;
  const want = Math.atan2(dx, dy) / RAD;
  let best: LocalDeparture | null = null;
  let bestOff = SID_MATCH_DEG;
  for (const sid of sids) {
    const exit = sid.legs.findLast((l) => l.at)?.at;
    if (!exit) continue;
    const off = Math.abs(((Math.atan2(exit[0], exit[1]) / RAD - want + 540) % 360) - 180);
    if (off < bestOff) {
      best = sid;
      bestOff = off;
    }
  }
  return best;
}

/** One published procedure as a line to draw anywhere: the scene's frame, and longitude, latitude and metres above the field. */
export interface ProcedurePath {
  kind: "approach" | "climb-out";
  /** "ILS RWY 8L", or a SID's identifier. */
  name: string;
  cycle: string;
  /** The SID was chosen by the destination rather than named. */
  likely: boolean;
  points: LinePoint[];
  geo: LinePoint[];
}

/**
 * The seam for callers other than the diorama's predictor (the gate-to-gate journey): a runway's
 * published approach, or its climb-out from `from` (where the aircraft lifts off) on the SID named, or
 * failing a name the one leaving toward `destination`. Null when there is nothing published to draw:
 * an unknown runway, or no SID named or likely. Pure; load `procedures` with loadProcedures.
 */
export function procedurePath(
  procedures: LocalProcedures,
  runway: string,
  kind: "approach" | "climb-out",
  options: { from?: LinePoint; sid?: string; destination?: { latitude: number; longitude: number } | null; gradient?: number } = {},
): ProcedurePath | null {
  const geo = (points: LinePoint[]) =>
    points.map(([x, y, h]): LinePoint => {
      const [lat, lon] = toGeo(procedures.origin, x, y);
      return [lon, lat, h];
    });
  if (kind === "approach") {
    const approach = procedures.approaches[runway];
    if (!approach) return null;
    const { points } = approachLine(approach);
    return { kind, name: approach.name, cycle: procedures.cycle, likely: false, points, geo: geo(points) };
  }
  if (!options.from) return null;
  const named = options.sid ? procedures.departures[runway]?.find((d) => d.ident === options.sid) : undefined;
  const sid = named ?? (options.destination ? likelySid(procedures, runway, options.destination) : null);
  if (!sid) return null;
  const { points } = climbOutLine(sid.legs, options.from, options.gradient ?? DEFAULT_GRADIENT);
  return { kind, name: sid.ident, cycle: procedures.cycle, likely: !named, points, geo: geo(points) };
}

/** The climb drawn when the caller gives none: 6%, as the predictor draws a departure's. */
const DEFAULT_GRADIENT = 0.06;
