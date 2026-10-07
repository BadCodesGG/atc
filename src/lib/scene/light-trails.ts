import type { FlightState } from "../aircraft-state";
import type { TrailPoint } from "../timelapse";

/**
 * The time-lapse's light trails as triangle strips, built a point at a time: two vertices a point,
 * both on the centreline, each with the way out to its side. The shader moves them out by the
 * half-width (so the trails keep their width in pixels at any zoom) and fades them by age (so nothing
 * is rewritten as they grow old). Appending a point rewrites only the point before it, whose corner
 * can only be mitred once the next point shows the turn. Kept apart from the scene to be tested
 * without WebGL.
 */

/** A sharp turn's mitre is held to this many half-widths, so a hairpin does not throw a spike. */
const MITRE_LIMIT = 3;

export interface StripStyle {
  /** Lowest height drawn, metres, so ground trails sit on the pavement rather than in it. */
  floor: number;
  /** Linear RGB a state. */
  colors: Record<FlightState, [number, number, number]>;
  /** Multiplies the colour; past 1 the bloom picks it up. */
  intensity: number;
}

interface RunEnd {
  /** First of the last point's two vertices. */
  vertex: number;
  last: TrailPoint;
  before: TrailPoint | null;
}

/** Unit left-hand normal of the segment a to b on the map; none for a segment of no length. */
function normal(a: TrailPoint, b: TrailPoint): [number, number] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  return d > 1e-6 ? [-dy / d, dx / d] : [0, 0];
}

/** The side vector at `p`, between the segments from `a` and to `b` (either may be missing). */
function side(a: TrailPoint | null, p: TrailPoint, b: TrailPoint | null): [number, number] {
  const n1 = a ? normal(a, p) : null;
  const n2 = b ? normal(p, b) : null;
  if (!n1 || (n1[0] === 0 && n1[1] === 0)) return n2 ?? [0, 0];
  if (!n2 || (n2[0] === 0 && n2[1] === 0)) return n1;
  const mx = n1[0] + n2[0];
  const my = n1[1] + n2[1];
  const m = Math.hypot(mx, my);
  if (m < 1e-6) return n1;
  // Longer at a corner, so each leg keeps its width: one over the cosine of half the turn.
  const scale = Math.min(MITRE_LIMIT, 1 / ((mx / m) * n1[0] + (my / m) * n1[1]));
  return [(mx / m) * scale, (my / m) * scale];
}

export class TrailStrips {
  /** Centreline, scene axes. */
  readonly positions: Float32Array;
  /** Way out to the vertex's side, map axes; the shader scales it by the half-width. */
  readonly sides: Float32Array;
  readonly colors: Float32Array;
  /** Seconds after the epoch the aircraft was here. */
  readonly times: Float32Array;
  readonly index: Uint32Array;
  vertices = 0;
  indices = 0;
  /** UTC seconds the times count from. */
  epoch = 0;
  full = false;
  private readonly runs = new Map<number, RunEnd>();
  private dirtyFrom = Infinity;
  private uploadedIndices = 0;

  constructor(readonly maxVertices: number) {
    this.positions = new Float32Array(maxVertices * 3);
    this.sides = new Float32Array(maxVertices * 2);
    this.colors = new Float32Array(maxVertices * 3);
    this.times = new Float32Array(maxVertices);
    // A segment joins two points (four vertices) with two triangles: six indices, three a vertex at most.
    this.index = new Uint32Array(maxVertices * 3);
  }

  clear(epoch: number): void {
    this.epoch = epoch;
    this.vertices = 0;
    this.indices = 0;
    this.full = false;
    this.runs.clear();
    this.dirtyFrom = 0;
    this.uploadedIndices = 0;
  }

  append(points: TrailPoint[], style: StripStyle): void {
    for (const p of points) {
      if (this.vertices + 2 > this.maxVertices) {
        this.full = true;
        return;
      }
      const end = this.runs.get(p.run);
      const v = this.vertices;
      if (end) {
        // The point before now knows which way the run goes on: its corner is mitred.
        this.setSide(end.vertex, side(end.before, end.last, p));
        this.dirtyFrom = Math.min(this.dirtyFrom, end.vertex);
        this.index.set([end.vertex, end.vertex + 1, v + 1, end.vertex, v + 1, v], this.indices);
        this.indices += 6;
      }
      const h = Math.max(style.floor, p.h);
      this.positions.set([p.x, h, -p.y, p.x, h, -p.y], 3 * v);
      this.setSide(v, side(end?.last ?? null, p, null));
      const [r, g, b] = style.colors[p.state];
      const k = style.intensity;
      this.colors.set([r * k, g * k, b * k, r * k, g * k, b * k], 3 * v);
      const t = p.t - this.epoch;
      this.times[v] = this.times[v + 1] = t;
      this.runs.set(p.run, { vertex: v, last: p, before: end?.last ?? null });
      this.dirtyFrom = Math.min(this.dirtyFrom, v);
      this.vertices += 2;
    }
  }

  /** The vertices and indices written since the last call, for uploading just those. */
  takeChanges(): { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number } {
    const vertexStart = Math.min(this.dirtyFrom, this.vertices);
    const out = { vertexStart, vertexCount: this.vertices - vertexStart, indexStart: this.uploadedIndices, indexCount: this.indices - this.uploadedIndices };
    this.dirtyFrom = Infinity;
    this.uploadedIndices = this.indices;
    return out;
  }

  private setSide(v: number, [nx, ny]: [number, number]): void {
    this.sides.set([nx, ny, -nx, -ny], 2 * v);
  }
}
