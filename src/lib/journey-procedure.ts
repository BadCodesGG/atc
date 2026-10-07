import { designator } from "./aircraft-state";
import type { Runway } from "./airport-map";
import type { Wind } from "./metar";
import { greatCircle } from "./globe/arcs";
import { toLocal } from "./geo";
import type { LinePoint, LocalProcedures } from "./procedure-path";
import { favouredRunwayEnds } from "./runway-wind";

/**
 * The published procedures in the gate-to-gate journey, as arithmetic: which runway a flight is likely
 * landing on or took off from, how much of its approach or climb-out is still ahead of it, and the
 * lines the map draws from them. Nothing here loads or reads a clock; journey-ends.ts does that.
 */

/** A wind under this, knots, does not decide which way an airport operates (runway-wind.ts): the inbound bearing does. */
const LIGHT_WIND_KT = 5;
/** An arrival keeps the runway it had while the inbound bearing is within this of it, degrees: the pick does not flip with every turn. */
const HOLD_DEG = 60;

/** A take-off is on a runway when it heads within this of it, degrees, and left the ground within this of its centreline, metres. */
const LIFT_OFF_HEADING_DEG = 30;
const LIFT_OFF_ACROSS_M = 1500;
/** And past the runway end's start by no more than this, metres: a runway's length and the climb after it. */
const LIFT_OFF_ALONG_M = 8000;
/** An aircraft farther than this, metres, from a published line is not on it. */
const OFF_LINE_M = 15_000;
/** An aircraft within this, metres, of a published line is on it: established on the approach, not converging on it. */
const ON_LINE_M = 2000;
/** An estimate shorter than this, metres, is where the aircraft already is: nothing to draw. */
const MIN_ESTIMATE_M = 3000;
/** Metres a great circle is cut into one segment per. */
const SEGMENT_M = 40_000;

const RAD = Math.PI / 180;
const angleBetween = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Each runway end the map has, with the heading an aircraft on it flies (from the geometry) and where it starts. */
function runwayEnds(runways: readonly Runway[]): { end: string; headingDeg: number; x: number; y: number }[] {
  const out: { end: string; headingDeg: number; x: number; y: number }[] = [];
  for (const runway of runways) {
    if (runway.ends.length !== 2) continue;
    for (const [from, to] of [runway.ends, [...runway.ends].reverse()]) {
      out.push({ end: designator(from.ref), headingDeg: ((Math.atan2(to.x - from.x, to.y - from.y) / RAD) + 360) % 360, x: from.x, y: from.y });
    }
  }
  return out;
}

/**
 * The runway end (its designator, "8L") an arrival is likely landing on: the one the reported wind
 * favours most, and failing a wind that decides, the one best aligned with the inbound bearing (degrees
 * true, from the aircraft toward the field), keeping `held` while that still lines up. Whether the
 * airport publishes an approach to it is for the caller to find: a runway without one is not swapped for
 * another that has. Null when the map has no runway.
 */
export function arrivalRunway({ runways, wind, bearingDeg, held = null }: { runways: readonly Runway[]; wind: Wind | null; bearingDeg: number; held?: string | null }): string | null {
  const ends = runwayEnds(runways);
  if (wind && wind.speedKt >= LIGHT_WIND_KT) {
    const into = favouredRunwayEnds(runways, wind)[0];
    if (into) return designator(into.end);
  }
  const keep = held && ends.find((e) => e.end === held);
  if (keep && angleBetween(keep.headingDeg, bearingDeg) <= HOLD_DEG) return held;
  let best: string | null = null;
  let bestOff = Infinity;
  for (const e of ends) {
    const off = angleBetween(e.headingDeg, bearingDeg);
    if (off < bestOff) {
      best = e.end;
      bestOff = off;
    }
  }
  return best;
}

/**
 * The runway end an aircraft took off from, among those with SIDs: the one it lifted off nearest the
 * centreline of, heading along it and past its start (by a runway's length and the climb after it, at most). `liftOff` is in the airport's metres. Null when it
 * followed none (it was already off the runway when first seen, or the runway has no SIDs).
 */
export function departureRunway({ runways, procedures, liftOff }: { runways: readonly Runway[]; procedures: Pick<LocalProcedures, "departures">; liftOff: { x: number; y: number; headingDeg: number } }): string | null {
  let best: string | null = null;
  let bestAcross = LIFT_OFF_ACROSS_M;
  for (const e of runwayEnds(runways)) {
    if (!procedures.departures[e.end]?.length || angleBetween(e.headingDeg, liftOff.headingDeg) > LIFT_OFF_HEADING_DEG) continue;
    const ux = Math.sin(e.headingDeg * RAD);
    const uy = Math.cos(e.headingDeg * RAD);
    const along = (liftOff.x - e.x) * ux + (liftOff.y - e.y) * uy;
    const across = Math.abs(-(liftOff.x - e.x) * uy + (liftOff.y - e.y) * ux);
    if (along > 0 && along < LIFT_OFF_ALONG_M && across < bestAcross) {
      best = e.end;
      bestAcross = across;
    }
  }
  return best;
}

/**
 * Where a published line's part still ahead of an aircraft at (x, y) begins: the index of the next point
 * after the one it is abeam, `line.length` when it is at or past the end. An aircraft farther than
 * OFF_LINE_M from the line is not on it: it joins at the start (`from-start`, an approach it has yet to
 * reach) or the line is dropped (`drop`, a climb-out it is not flying).
 */
export function aheadOf(line: readonly LinePoint[], x: number, y: number, far: "from-start" | "drop"): number {
  const { at, u: bestU, d: bestD } = nearestOn(line, x, y);
  if (bestD > OFF_LINE_M) return far === "drop" ? line.length : 0;
  if (at === line.length - 2 && bestU === 1) return line.length;
  return at === 0 && bestU === 0 ? 0 : at + 1;
}

/** Whether an aircraft at (x, y) is on the line: within ON_LINE_M of it (so a line it is still converging on is not). */
export function alongLine(line: readonly LinePoint[], x: number, y: number): boolean {
  return nearestOn(line, x, y).d <= ON_LINE_M;
}

/** The segment (by its first point), the share along it and the distance, metres, of the line's nearest point to (x, y). */
function nearestOn(line: readonly LinePoint[], x: number, y: number): { at: number; u: number; d: number } {
  let at = 0;
  let bestD = Infinity;
  let bestU = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i];
    const [bx, by] = line[i + 1];
    const len2 = (bx - ax) ** 2 + (by - ay) ** 2 || 1;
    const u = Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2));
    const d = Math.hypot(ax + (bx - ax) * u - x, ay + (by - ay) * u - y);
    if (d < bestD) {
      bestD = d;
      at = i;
      bestU = u;
    }
  }
  return { at, u: bestU, d: bestD };
}

type Coord = [number, number];

const metres = (a: Coord, b: Coord) => Math.hypot(...toLocal({ latitude: a[1], longitude: a[0] }, b[1], b[0]));

/**
 * What the map draws ahead of the aircraft, as [longitude, latitude] lines: the climb-out it is still on
 * (published, from the aircraft), the estimate from where that ends (or from the aircraft) to the first
 * point of the approach ahead (a great circle, dashed), and the approach to the threshold (published).
 * With neither published it is the straight estimate to the field, as the journey has always drawn it.
 * An aircraft already `onApproach` has no estimate beside the line: the approach runs on from the aircraft itself, as it does when
 * the next point is near, wherever that point is (an estimate to it would run next to the published line, and end at a point of its own).
 */
export function journeyLines(aircraft: Coord, destination: Coord, climbOut: readonly Coord[], approach: readonly Coord[], onApproach = false): { left: Coord[]; climbOut: Coord[]; approach: Coord[] } {
  const from = climbOut.at(-1) ?? aircraft;
  const to = approach[0] ?? destination;
  const out = climbOut.length ? [aircraft, ...climbOut] : [];
  if (!climbOut.length && !approach.length) return { left: [aircraft, destination], climbOut: [], approach: [] };
  if (!approach.length) return { left: [from, destination], climbOut: out, approach: [] };
  if (onApproach && !climbOut.length) return { left: [], climbOut: out, approach: [aircraft, ...approach] };
  const d = metres(from, to);
  if (d < MIN_ESTIMATE_M) return { left: [], climbOut: out, approach: [from, ...approach] };
  return { left: greatCircle(from, to, Math.min(96, Math.max(2, Math.ceil(d / SEGMENT_M)))), climbOut: out, approach: [...approach] };
}
