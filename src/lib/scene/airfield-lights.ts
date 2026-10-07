import type { AirportMap, Point, Runway } from "../airport-map";
import { taxiwayRuns } from "./ground";

/**
 * The airfield's lights, placed from the mapped geometry: runway edge, centreline, threshold and end
 * lights from each runway's ends and width, taxiway centreline lights along the taxiways, and the
 * approach lights and PAPIs that are mapped as navaids. Map metres; the scene decides how they look.
 */

export type AirfieldLightKind =
  | "runwayEdge"
  | "runwayCaution"
  | "runwayCentre"
  | "threshold"
  | "runwayEnd"
  | "taxiwayCentre"
  | "approach"
  | "papiRed"
  | "papiWhite";

export interface AirfieldLight {
  kind: AirfieldLightKind;
  x: number;
  y: number;
}

/** Longest gap between runway edge lights, and between centreline lights, metres. */
const EDGE_SPACING = 60;
const CENTRE_SPACING = 30;
/** Edge lights stand this far outside the paved edge. */
const EDGE_OFFSET = 1.5;
/** The edge lights within this of a runway end are amber. */
const CAUTION_ZONE = 600;
/**
 * Gap between the lights of a threshold or end bar, and how far inboard the red end bar sits: far
 * enough that the green and red bars stay two bars on screen instead of summing to one white blob.
 */
const BAR_SPACING = 7.5;
const END_BAR_INSET = 20;
/** Centreline lights only on the lettered routes, and sparsely: the field reads as its runways first. */
const TAXIWAY_SPACING = 60;
const MAIN_TAXIWAY = /^[A-Z]{1,2}$/;
/** Mapped approach lights this near a runway end are left out; they would merge with its bars. */
const APPROACH_CLEARANCE = 60;
/** Taxiway lights this close to a runway's edge belong to the runway's lighting, not the taxiway's. */
const RUNWAY_CLEARANCE = 3;
/** The four boxes of a PAPI, metres apart. */
const PAPI_SPACING = 9;

interface Frame {
  x0: number;
  y0: number;
  ux: number;
  uy: number;
  length: number;
  width: number;
}

function frameOf(r: Runway): Frame | null {
  if (r.ends.length < 2) return null;
  const [a, b] = r.ends;
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 0)) return null;
  return { x0: a.x, y0: a.y, ux: (b.x - a.x) / length, uy: (b.y - a.y) / length, length, width: r.width };
}

/** Along the runway from its first end, and to the left of its centreline. */
function local(f: Frame, x: number, y: number): { along: number; across: number } {
  const dx = x - f.x0;
  const dy = y - f.y0;
  return { along: dx * f.ux + dy * f.uy, across: -dx * f.uy + dy * f.ux };
}

function onRunway(frames: Frame[], x: number, y: number): boolean {
  return frames.some((f) => {
    const { along, across } = local(f, x, y);
    return along >= 0 && along <= f.length && Math.abs(across) <= f.width / 2 + RUNWAY_CLEARANCE;
  });
}

/** Points every `spacing` metres along a polyline, both ends included. */
function along(line: Point[], spacing: number): Point[] {
  const out: Point[] = [];
  // Distance into the current segment of the next point.
  let d = 0;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (!(len > 0)) continue;
    for (; d < len; d += spacing) out.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
    d -= len;
  }
  const last = line.at(-1);
  if (last) out.push(last);
  return out;
}

function runwayLights(f: Frame, out: AirfieldLight[]): void {
  const at = (a: number, c: number): [number, number] => [f.x0 + f.ux * a - f.uy * c, f.y0 + f.uy * a + f.ux * c];
  const half = f.width / 2;

  const n = Math.ceil(f.length / EDGE_SPACING);
  for (let i = 0; i <= n; i++) {
    const a = (f.length * i) / n;
    const kind = a < CAUTION_ZONE || a > f.length - CAUTION_ZONE ? "runwayCaution" : "runwayEdge";
    for (const side of [1, -1]) {
      const [x, y] = at(a, side * (half + EDGE_OFFSET));
      out.push({ kind, x, y });
    }
  }

  for (let a = CENTRE_SPACING; a <= f.length - CENTRE_SPACING + 1e-6; a += CENTRE_SPACING) {
    const [x, y] = at(a, 0);
    out.push({ kind: "runwayCentre", x, y });
  }

  const bars = Math.round(f.width / BAR_SPACING);
  for (const [end, inward] of [
    [0, 1],
    [f.length, -1],
  ]) {
    for (let i = 0; i <= bars; i++) {
      const c = -half + (f.width * i) / bars;
      const [gx, gy] = at(end, c);
      out.push({ kind: "threshold", x: gx, y: gy });
      const [rx, ry] = at(end + inward * END_BAR_INSET, c);
      out.push({ kind: "runwayEnd", x: rx, y: ry });
    }
  }
}

export function airfieldLights(map: Pick<AirportMap, "runways" | "taxiways" | "aprons" | "navaids">): AirfieldLight[] {
  const out: AirfieldLight[] = [];
  const frames = map.runways.map(frameOf).filter((f): f is Frame => f !== null);
  for (const f of frames) runwayLights(f, out);

  // Taxiway centreline lights on the main routes, the ones lettered A, B, SG: the numbered connectors,
  // the named lanes and the lanes between stands are unlit.
  for (const run of taxiwayRuns(map)) {
    if (run.minor || !MAIN_TAXIWAY.test(run.ref ?? "")) continue;
    for (const [x, y] of along(run.line, TAXIWAY_SPACING)) if (!onRunway(frames, x, y)) out.push({ kind: "taxiwayCentre", x, y });
  }

  const ends = map.runways.flatMap((r) => r.ends);
  for (const n of map.navaids) {
    if (n.kind === "als" && ends.every((e) => Math.hypot(e.x - n.x, e.y - n.y) > APPROACH_CLEARANCE)) out.push({ kind: "approach", x: n.x, y: n.y });
    if (n.kind !== "papi" || !frames.length) continue;
    // Four boxes in a row at right angles to the nearest runway, the two nearer it red.
    let best = frames[0];
    let bestD = Infinity;
    for (const f of frames) {
      const d = Math.abs(local(f, n.x, n.y).across);
      if (d < bestD) {
        best = f;
        bestD = d;
      }
    }
    const side = Math.sign(local(best, n.x, n.y).across) || 1;
    // Unit vector away from the runway.
    const ox = -best.uy * side;
    const oy = best.ux * side;
    for (let i = 0; i < 4; i++) {
      const d = (i - 1.5) * PAPI_SPACING;
      out.push({ kind: i < 2 ? "papiRed" : "papiWhite", x: n.x + ox * d, y: n.y + oy * d });
    }
  }
  return out;
}
