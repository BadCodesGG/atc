import { ShapeUtils, Vector2 } from "three";
import type { AirportMap, Point, Ring, Runway } from "../airport-map";
import { inPolygon } from "../pavement";

/**
 * Triangle meshes for the ground plan, as plain typed arrays so they can be built and checked without
 * a GPU. World axes follow three.js: x east, y up, z south (so a map point (x, y) lands at (x, h, -y)).
 * Every horizontal triangle is wound to face up.
 */

export interface MeshGroup {
  start: number;
  count: number;
}

export interface MeshData {
  positions: Float32Array;
  /** Present when the builder knows them; flat ground layers leave lighting to a shared up normal. */
  normals?: Float32Array;
  indices: Uint32Array;
  /** Index ranges, in the order the builder documents. */
  groups: MeshGroup[];
}

class Builder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  /** Adds a map point at height h and returns its index. */
  vertex(x: number, y: number, h: number, normal: [number, number, number] = [0, 1, 0]): number {
    this.positions.push(x, h, -y);
    this.normals.push(...normal);
    return this.vertexCount - 1;
  }

  /** A flat triangle from map points, turned to face up whichever way round it was given. */
  flat(a: Point, b: Point, c: Point, h: number): void {
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) < 1e-12) return;
    const [p, q] = cross > 0 ? [b, c] : [c, b];
    this.indices.push(this.vertex(a[0], a[1], h), this.vertex(p[0], p[1], h), this.vertex(q[0], q[1], h));
  }

  /** A flat quad from four map corners in counter-clockwise order. */
  quad(corners: [Point, Point, Point, Point], h: number): void {
    const [a, b, c, d] = corners.map((p) => this.vertex(p[0], p[1], h));
    this.indices.push(a, b, c, a, c, d);
  }

  build(groups: MeshGroup[] = [{ start: 0, count: this.indices.length }]): MeshData {
    return { positions: new Float32Array(this.positions), normals: new Float32Array(this.normals), indices: new Uint32Array(this.indices), groups };
  }
}

const DISC_SEGMENTS = 12;

function disc(out: Builder, centre: Point, radius: number, h: number): void {
  const c = out.vertex(centre[0], centre[1], h);
  const first = out.vertexCount;
  for (let i = 0; i < DISC_SEGMENTS; i++) {
    const a = (i / DISC_SEGMENTS) * Math.PI * 2;
    out.vertex(centre[0] + radius * Math.cos(a), centre[1] + radius * Math.sin(a), h);
  }
  for (let i = 0; i < DISC_SEGMENTS; i++) out.indices.push(c, first + i, first + ((i + 1) % DISC_SEGMENTS));
}

export interface RibbonOptions {
  height: number;
  /** Round adds a disc at every vertex, which rounds both the ends and the joints. */
  caps: "round" | "butt";
  /** Multiplies every line's width. */
  widthScale?: number;
}

/** Polylines laid flat as strips of their own width. */
export function ribbons(lines: { line: Point[]; width: number }[], { height, caps, widthScale = 1 }: RibbonOptions): MeshData {
  const out = new Builder();
  for (const { line, width } of lines) {
    const half = (width * widthScale) / 2;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(len > 0)) continue;
      // Left of the direction of travel.
      const nx = (-(b[1] - a[1]) / len) * half;
      const ny = ((b[0] - a[0]) / len) * half;
      out.quad(
        [
          [a[0] - nx, a[1] - ny],
          [b[0] - nx, b[1] - ny],
          [b[0] + nx, b[1] + ny],
          [a[0] + nx, a[1] + ny],
        ],
        height,
      );
    }
    if (caps === "round") for (const p of line) disc(out, p, half, height);
  }
  return out.build();
}

/** Twice the signed area: positive for a counter-clockwise ring. */
function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    s += x0 * y1 - x1 * y0;
  }
  return s;
}

function triangulate(out: Builder, rings: Ring[], h: number): void {
  const [outer, ...holes] = rings;
  if (!outer || outer.length < 3) return;
  const contour = outer.map(([x, y]) => new Vector2(x, y));
  const holeVecs = holes.filter((r) => r.length >= 3).map((r) => r.map(([x, y]) => new Vector2(x, y)));
  const all: Point[] = [...outer, ...holes.filter((r) => r.length >= 3).flat()];
  for (const [a, b, c] of ShapeUtils.triangulateShape(contour, holeVecs)) out.flat(all[a], all[b], all[c], h);
}

/** Polygons (outer ring first, then holes) laid flat at height h. */
export function fill(polygons: Ring[][], h: number): MeshData {
  const out = new Builder();
  for (const rings of polygons) triangulate(out, rings, h);
  return out.build();
}

/**
 * Footprints raised into blocks: groups[0] is the roofs, groups[1] the walls, each wall with its own
 * flat outward normal. No floors: they are never seen.
 */
export function extrude(footprints: { rings: Ring[]; height: number }[], heightScale: number): MeshData {
  const out = new Builder();
  for (const { rings, height } of footprints) triangulate(out, rings, height * heightScale);
  const roofCount = out.indices.length;
  for (const { rings, height } of footprints) {
    const top = height * heightScale;
    rings.forEach((ring, i) => {
      if (ring.length < 3) return;
      // Outer ring counter-clockwise, holes clockwise: then the building is always on the left of each edge.
      const ccw = signedArea(ring) > 0;
      const ordered = ccw === (i === 0) ? ring : [...ring].reverse();
      for (let k = 0; k < ordered.length; k++) {
        const a = ordered[k];
        const b = ordered[(k + 1) % ordered.length];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (!(len > 0)) continue;
        // Outward is to the right of the edge: map (dy, -dx), world (dy, 0, dx).
        const n: [number, number, number] = [dy / len, 0, dx / len];
        const a0 = out.vertex(a[0], a[1], 0, n);
        const b0 = out.vertex(b[0], b[1], 0, n);
        const b1 = out.vertex(b[0], b[1], top, n);
        const a1 = out.vertex(a[0], a[1], top, n);
        out.indices.push(a0, b0, b1, a0, b1, a1);
      }
    });
  }
  return out.build([
    { start: 0, count: roofCount },
    { start: roofCount, count: out.indices.length - roofCount },
  ]);
}

export interface MarkingOptions {
  height: number;
  /** Centreline dash and gap lengths and the line's width, metres. */
  dash: number;
  gap: number;
  lineWidth: number;
  /** Length of the threshold bars at each end, metres. */
  thresholdLength: number;
}

/** Painted runway markings: a dashed centreline and threshold bars at both ends. */
export function runwayMarkings(runways: Runway[], { height, dash, gap, lineWidth, thresholdLength }: MarkingOptions): MeshData {
  const out = new Builder();
  for (const runway of runways) {
    if (runway.ends.length < 2) continue;
    const [e0, e1] = runway.ends;
    const length = Math.hypot(e1.x - e0.x, e1.y - e0.y);
    if (!(length > 2 * thresholdLength)) continue;
    const ux = (e1.x - e0.x) / length;
    const uy = (e1.y - e0.y) / length;
    const at = (along: number, across: number): Point => [e0.x + ux * along - uy * across, e0.y + uy * along + ux * across];
    const rect = (a0: number, a1: number, c0: number, c1: number) => out.quad([at(a0, c0), at(a1, c0), at(a1, c1), at(a0, c1)], height);

    // Threshold bars: four each side of the centreline, set in from the edge.
    const inset = 6;
    const stripe = runway.width * 0.07;
    const pitch = runway.width * 0.1;
    for (const [start, end] of [
      [inset, inset + thresholdLength],
      [length - inset - thresholdLength, length - inset],
    ]) {
      for (let i = 0; i < 4; i++) {
        const offset = runway.width * 0.08 + (i + 0.5) * pitch;
        rect(start, end, offset - stripe / 2, offset + stripe / 2);
        rect(start, end, -offset - stripe / 2, -offset + stripe / 2);
      }
    }

    const from = inset + thresholdLength + gap;
    const to = length - inset - thresholdLength - gap;
    for (let a = from; a + dash <= to; a += dash + gap) rect(a, a + dash, -lineWidth / 2, lineWidth / 2);
  }
  return out.build();
}

export interface TaxiwayRun {
  /** The taxiway's designator, "A" or "V3"; null for the many connectors and lanes mapped without one. */
  ref: string | null;
  line: Point[];
  width: number;
  /**
   * Not one of the airfield's named routes: mapped as a taxilane or without a designator (the lanes
   * between stands and the unnamed connectors), or this stretch runs across an apron.
   */
  minor: boolean;
}

/**
 * Every taxiway, cut into runs that are wholly minor or wholly major, with every segment kept. A
 * segment is on an apron when its midpoint is.
 */
export function taxiwayRuns(map: Pick<AirportMap, "taxiways" | "aprons">): TaxiwayRun[] {
  const aprons = map.aprons.map((a) => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const [x, y] of a.rings[0] ?? []) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    return { rings: a.rings, minX, maxX, minY, maxY };
  });
  const onApron = (x: number, y: number) => aprons.some((a) => x >= a.minX && x <= a.maxX && y >= a.minY && y <= a.maxY && inPolygon(x, y, a.rings));

  const runs: TaxiwayRun[] = [];
  for (const t of map.taxiways) {
    if (t.kind === "taxilane" || t.ref === null) {
      runs.push({ ref: t.ref, line: t.line, width: t.width, minor: true });
      continue;
    }
    let current: TaxiwayRun | null = null;
    for (let i = 1; i < t.line.length; i++) {
      const [ax, ay] = t.line[i - 1];
      const [bx, by] = t.line[i];
      const minor = onApron((ax + bx) / 2, (ay + by) / 2);
      if (current && current.minor === minor) current.line.push(t.line[i]);
      else {
        current = { ref: t.ref, line: [t.line[i - 1], t.line[i]], width: t.width, minor };
        runs.push(current);
      }
    }
  }
  return runs;
}
