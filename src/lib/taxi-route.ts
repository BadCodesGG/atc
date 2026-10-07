import type { AirportMap, Point } from "./airport-map";
import { Pavement } from "./pavement";

/**
 * Ways between two ground fixes that stay on the pavement, for the time-lapse's taxi trails: fixes are
 * seconds apart, and a straight line between two of them cuts across the grass and through buildings
 * wherever the aircraft turned. Along the taxiway network when both fixes are on it, else a straight
 * line with each point put back on the pavement.
 */

/** Vertices closer than this are one node: the same mapped junction, written twice. */
const MERGE = 2;
/** A line that ends this close to another joins it, where the shared junction node was simplified away. */
const JOIN = 15;
/** A fix farther than this from every taxiway centreline is not on the network (an apron, a remote stand). */
const REACH = 60;
/** A route longer than this many times the straight distance, plus DETOUR_SLACK, is not the way the aircraft went. */
const DETOUR = 3;
const DETOUR_SLACK = 300;
/** Spacing, metres, of the points a straight run is cut into before each is put on the pavement. */
const STEP = 20;
/** A ground fix farther than this from any pavement is a bad position (TrafficView's own reach). */
const SNAP_REACH = 150;
/** Ways remembered before the memory is cleared: three hours of a busy airport's taxiing is about this many. */
const WAYS_KEPT = 50_000;
const CELL = 100;

interface Edge {
  a: number;
  b: number;
  length: number;
}

/** Nearest point on segment a-b to p, and how far along it (0 to 1). */
function project(p: Point, a: Point, b: Point): { q: Point; u: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  const q: Point = [a[0] + u * dx, a[1] + u * dy];
  return { q, u, d: Math.hypot(p[0] - q[0], p[1] - q[1]) };
}

/** Where segments a-b and c-d cross, strictly inside both; null when they do not. */
function crossing(a: Point, b: Point, c: Point, d: Point): { u: number; v: number } | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const u = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const v = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return u > 1e-6 && u < 1 - 1e-6 && v > 1e-6 && v < 1 - 1e-6 ? { u, v } : null;
}

/** Binary min-heap of node indices by cost. */
class Heap {
  private readonly items: [number, number][] = [];
  get size(): number {
    return this.items.length;
  }
  push(node: number, cost: number): void {
    const h = this.items;
    h.push([cost, node]);
    for (let i = h.length - 1; i > 0; ) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const h = this.items;
    const top = h[0];
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && h[l][0] < h[m][0]) m = l;
        if (r < h.length && h[r][0] < h[m][0]) m = r;
        if (m === i) break;
        [h[m], h[i]] = [h[i], h[m]];
        i = m;
      }
    }
    return top;
  }
}

/** The taxiways and runway centrelines as a graph, and shortest routes along it. */
export class TaxiRouter {
  private readonly nodes: Point[] = [];
  private readonly adjacent: { to: number; length: number }[][] = [];
  private readonly edges: Edge[] = [];
  private readonly nodeGrid = new Map<string, number[]>();
  private readonly edgeGrid = new Map<string, number[]>();

  constructor(map: Pick<AirportMap, "taxiways" | "runways">) {
    const lines: Point[][] = map.taxiways.map((t) => t.line).filter((l) => l.length >= 2);
    for (const r of map.runways) if (r.ends.length >= 2) lines.push([[r.ends[0].x, r.ends[0].y], [r.ends[1].x, r.ends[1].y]]);

    // Every segment, with the points along it (0 to 1) where it must be split: its ends, where another
    // segment crosses it, and where another line ends beside it.
    const segments: { a: Point; b: Point; cuts: { u: number; p: Point }[] }[] = [];
    for (const line of lines) for (let i = 1; i < line.length; i++) segments.push({ a: line[i - 1], b: line[i], cuts: [] });
    const near = new Map<string, number[]>();
    segments.forEach((s, i) => {
      for (const key of this.cells(s.a, s.b, JOIN)) {
        const cell = near.get(key);
        if (cell) cell.push(i);
        else near.set(key, [i]);
      }
    });
    const candidates = (a: Point, b: Point, pad: number) => {
      const out = new Set<number>();
      for (const key of this.cells(a, b, pad)) for (const i of near.get(key) ?? []) out.add(i);
      return out;
    };
    /** Line ends joined to a point on another segment: [line end, point]. */
    const joins: [Point, Point][] = [];
    segments.forEach((s, i) => {
      for (const j of candidates(s.a, s.b, 0)) {
        if (j <= i) continue;
        const t = segments[j];
        const x = crossing(s.a, s.b, t.a, t.b);
        if (!x) continue;
        const p: Point = [s.a[0] + x.u * (s.b[0] - s.a[0]), s.a[1] + x.u * (s.b[1] - s.a[1])];
        s.cuts.push({ u: x.u, p });
        t.cuts.push({ u: x.v, p });
      }
    });
    for (const line of lines) {
      for (const end of [line[0], line[line.length - 1]]) {
        let best: { j: number; u: number; q: Point; d: number } | null = null;
        for (const j of candidates(end, end, JOIN)) {
          const t = segments[j];
          if (t.a === end || t.b === end) continue;
          const { q, u, d } = project(end, t.a, t.b);
          // Joined at a vertex already, or not near: nothing to add.
          const atVertex = Math.hypot(q[0] - t.a[0], q[1] - t.a[1]) <= MERGE || Math.hypot(q[0] - t.b[0], q[1] - t.b[1]) <= MERGE;
          if (!atVertex && d <= JOIN && (!best || d < best.d)) best = { j, u, q, d };
        }
        if (best && best.u > 0 && best.u < 1) {
          segments[best.j].cuts.push({ u: best.u, p: best.q });
          joins.push([end, best.q]);
        }
      }
    }

    for (const s of segments) {
      const points = [s.a, ...s.cuts.sort((p, q) => p.u - q.u).map((c) => c.p), s.b];
      for (let i = 1; i < points.length; i++) this.link(this.node(points[i - 1]), this.node(points[i]));
    }
    for (const [end, q] of joins) this.link(this.node(end), this.node(q));
  }

  /**
   * The way along the network from a to b: the point on it nearest a, the junctions between, and the
   * point nearest b. Null when either is off the network, or the only route is a long way round.
   */
  route(a: Point, b: Point): Point[] | null {
    const from = this.nearestEdge(a);
    const to = this.nearestEdge(b);
    if (!from || !to) return null;
    const limit = DETOUR * Math.hypot(b[0] - a[0], b[1] - a[1]) + DETOUR_SLACK;
    if (from.edge === to.edge) return [from.q, to.q];

    const { nodes } = this;
    const dist = new Map<number, number>();
    const back = new Map<number, number>();
    const heap = new Heap();
    const start = (n: number) => {
      const d = Math.hypot(nodes[n][0] - from.q[0], nodes[n][1] - from.q[1]);
      if (d < (dist.get(n) ?? Infinity)) {
        dist.set(n, d);
        back.set(n, -1);
        heap.push(n, d);
      }
    };
    start(from.edge.a);
    start(from.edge.b);
    const ends = new Set([to.edge.a, to.edge.b]);
    let settled = 0;
    while (heap.size && settled < ends.size) {
      const [cost, n] = heap.pop();
      if (cost > (dist.get(n) ?? Infinity) || cost > limit) {
        if (cost > limit) break;
        continue;
      }
      if (ends.has(n)) settled++;
      for (const { to: m, length } of this.adjacent[n]) {
        const d = cost + length;
        if (d < (dist.get(m) ?? Infinity)) {
          dist.set(m, d);
          back.set(m, n);
          heap.push(m, d);
        }
      }
    }
    let best = -1;
    let bestCost = Infinity;
    for (const n of ends) {
      const d = (dist.get(n) ?? Infinity) + Math.hypot(nodes[n][0] - to.q[0], nodes[n][1] - to.q[1]);
      if (d < bestCost) {
        best = n;
        bestCost = d;
      }
    }
    if (best < 0 || bestCost > limit) return null;
    const path: Point[] = [to.q];
    for (let n = best; n >= 0; n = back.get(n)!) path.push(nodes[n]);
    path.push(from.q);
    return path.reverse();
  }

  private nearestEdge(p: Point): { edge: Edge; q: Point } | null {
    let best: { edge: Edge; q: Point; d: number } | null = null;
    for (const key of this.cells(p, p, REACH)) {
      for (const e of this.edgeGrid.get(key) ?? []) {
        const edge = this.edges[e];
        const { q, d } = project(p, this.nodes[edge.a], this.nodes[edge.b]);
        if (d <= REACH && (!best || d < best.d)) best = { edge, q, d };
      }
    }
    return best;
  }

  private node(p: Point): number {
    const cx = Math.round(p[0] / MERGE);
    const cy = Math.round(p[1] / MERGE);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const n of this.nodeGrid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(this.nodes[n][0] - p[0], this.nodes[n][1] - p[1]) <= MERGE) return n;
        }
      }
    }
    const n = this.nodes.push(p) - 1;
    this.adjacent.push([]);
    const key = `${cx},${cy}`;
    const cell = this.nodeGrid.get(key);
    if (cell) cell.push(n);
    else this.nodeGrid.set(key, [n]);
    return n;
  }

  private link(a: number, b: number): void {
    if (a === b) return;
    const length = Math.hypot(this.nodes[b][0] - this.nodes[a][0], this.nodes[b][1] - this.nodes[a][1]);
    this.adjacent[a].push({ to: b, length });
    this.adjacent[b].push({ to: a, length });
    const e = this.edges.push({ a, b, length }) - 1;
    for (const key of this.cells(this.nodes[a], this.nodes[b], 0)) {
      const cell = this.edgeGrid.get(key);
      if (cell) cell.push(e);
      else this.edgeGrid.set(key, [e]);
    }
  }

  /** Grid cells a segment's box, padded, covers. */
  private *cells(a: Point, b: Point, pad: number): Generator<string> {
    for (let cx = Math.floor((Math.min(a[0], b[0]) - pad) / CELL); cx <= Math.floor((Math.max(a[0], b[0]) + pad) / CELL); cx++) {
      for (let cy = Math.floor((Math.min(a[1], b[1]) - pad) / CELL); cy <= Math.floor((Math.max(a[1], b[1]) + pad) / CELL); cy++) yield `${cx},${cy}`;
    }
  }
}

/** Paths between ground fixes: routed along the taxiways where possible, else straight and kept on the pavement. */
export class GroundPaths {
  private readonly router: TaxiRouter;
  private readonly pavement: Pavement;
  private readonly ways = new Map<string, Point[]>();

  constructor(map: Pick<AirportMap, "taxiways" | "runways" | "aprons">) {
    this.router = new TaxiRouter(map);
    this.pavement = new Pavement(map);
  }

  /**
   * A ground fix put on the nearest pavement; null when there is none within SNAP_REACH, where the fix
   * is more likely a bad position than pavement the map lacks.
   */
  snap(p: Point): Point | null {
    const paved = this.pavement.nearest(p[0], p[1], SNAP_REACH);
    return paved ? [paved.x, paved.y] : null;
  }

  /**
   * The points to draw between two ground fixes (both already on the pavement), not including them.
   * Remembered, so trails laid down again after a seek do not route every stretch again.
   */
  between(a: Point, b: Point): Point[] {
    const key = `${a[0]},${a[1]},${b[0]},${b[1]}`;
    let way = this.ways.get(key);
    if (!way) {
      if (this.ways.size >= WAYS_KEPT) this.ways.clear();
      this.ways.set(key, (way = this.find(a, b)));
    }
    return way;
  }

  private find(a: Point, b: Point): Point[] {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length <= STEP) return [];
    const routed = this.router.route(a, b);
    if (routed) return routed;
    const n = Math.ceil(length / STEP);
    const out: Point[] = [];
    for (let i = 1; i < n; i++) {
      const p: Point = [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n];
      const paved = this.pavement.nearest(p[0], p[1], length);
      out.push(paved ? [paved.x, paved.y] : p);
    }
    return out;
  }
}
