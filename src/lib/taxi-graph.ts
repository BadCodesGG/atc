import type { AirportMap, Point } from "./airport-map";

/**
 * The airport's taxi network as a graph: every mapped taxiway, taxilane and runway centreline, cut
 * into edges wherever two of them meet. OSM joins ways at shared nodes, but the ground plan is
 * simplified and rounded, so a junction is found by geometry instead: where two lines cross, and
 * where one line ends within a few metres of another. Mapped holding positions become nodes too, so
 * a route can end at one. Pure: no three.js, no DOM.
 */

export interface TaxiNode {
  x: number;
  y: number;
  /** A mapped holding position sits here. */
  hold: boolean;
}

export interface TaxiEdge {
  a: number;
  b: number;
  length: number;
  /** From node a to node b. */
  line: Point[];
  kind: "taxiway" | "taxilane" | "runway";
  /** The taxiway's designator, "A" or "V3"; null for the many unnamed connectors and lanes. */
  ref: string | null;
  /** The runway's ref, "09L/27R", for a runway edge. */
  runway: string | null;
}

export interface TaxiGraph {
  nodes: TaxiNode[];
  edges: TaxiEdge[];
  /** Edge indices at each node. */
  links: number[][];
}

/** A point on the network: on `edge`, `along` metres from its node a. */
export interface Located {
  edge: number;
  along: number;
  x: number;
  y: number;
  /** How far the asked-for point was from the network. */
  distance: number;
}

/** Lines whose ends come within this many metres of each other, or of another line, are joined. */
export const SNAP = 3;
/** A holding position mapped this far beside its taxiway's centreline still marks it. */
const HOLD_SNAP = 40;
/**
 * Cost per metre of taxiing along a runway, against 1 on a taxiway. Aircraft cross runways (on the
 * taxiway's own edges, which meet the centreline at a node) but do not taxi down them: only a
 * backtrack where no taxiway runs beside the runway is worth this much. The line-up and the takeoff
 * roll are not taxi routes; the path predictor draws them itself.
 */
const RUNWAY_FACTOR = 20;
/**
 * Cost per metre on a lane between stands or an unnamed connector: aircraft keep to the named
 * taxiways and use the ramp's lanes to reach a stand, not as a short cut across the terminal.
 */
const LANE_FACTOR = 1.5;
/** What turning round costs an aircraft heading away from a route, in metres of taxiing. */
const U_TURN = 300;
const CELL = 64;

const RAD = Math.PI / 180;

interface Way {
  line: Point[];
  kind: TaxiEdge["kind"];
  ref: string | null;
  runway: string | null;
}

/** A place on a way where it is cut: segment index plus the share of the way along it. */
interface Cut {
  at: number;
  x: number;
  y: number;
  hold: boolean;
}

/** Point on segment ab nearest p: its share t along ab and the distance. */
function project(p: Point, a: Point, b: Point): { t: number; d: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return { t, d: Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) };
}

/** Where segments ab and cd cross: the shares along each, or null when they do not. */
function cross(a: Point, b: Point, c: Point, d: Point): [number, number] | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  const eps = 1e-9;
  return t >= -eps && t <= 1 + eps && u >= -eps && u <= 1 + eps ? [Math.min(1, Math.max(0, t)), Math.min(1, Math.max(0, u))] : null;
}

function wayLength(line: Point[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return s;
}

export function buildTaxiGraph(map: Pick<AirportMap, "taxiways" | "runways" | "holdingPositions">): TaxiGraph {
  const ways: Way[] = [
    ...map.taxiways.map((t): Way => ({ line: t.line, kind: t.kind, ref: t.ref, runway: null })),
    ...map.runways.map((r): Way => ({ line: r.ends.length >= 2 ? r.ends.map((e): Point => [e.x, e.y]) : r.centerline, kind: "runway", ref: null, runway: r.ref })),
  ].filter((w) => w.line.length >= 2);

  // Every segment in a grid, so each is only tested against its neighbours.
  const grid = new Map<string, Array<[number, number]>>();
  const cells = (a: Point, b: Point, pad: number, visit: (key: string) => void) => {
    const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / CELL);
    const x1 = Math.floor((Math.max(a[0], b[0]) + pad) / CELL);
    const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / CELL);
    const y1 = Math.floor((Math.max(a[1], b[1]) + pad) / CELL);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) visit(`${x},${y}`);
  };
  ways.forEach((w, i) => {
    for (let s = 1; s < w.line.length; s++) {
      cells(w.line[s - 1], w.line[s], SNAP, (key) => {
        const list = grid.get(key);
        if (list) list.push([i, s]);
        else grid.set(key, [[i, s]]);
      });
    }
  });

  const cuts: Cut[][] = ways.map((w) => [
    { at: 0, x: w.line[0][0], y: w.line[0][1], hold: false },
    { at: w.line.length - 1, x: w.line[w.line.length - 1][0], y: w.line[w.line.length - 1][1], hold: false },
  ]);
  const cutAt = (i: number, s: number, t: number, hold = false) => {
    const [a, b] = [ways[i].line[s - 1], ways[i].line[s]];
    cuts[i].push({ at: s - 1 + t, x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, hold });
  };

  // Crossings, and line ends that stop on (or just short of) another line.
  const done = new Set<string>();
  ways.forEach((w, i) => {
    for (let s = 1; s < w.line.length; s++) {
      const a = w.line[s - 1];
      const b = w.line[s];
      cells(a, b, SNAP, (key) => {
        for (const [j, k] of grid.get(key)!) {
          if (j <= i) continue;
          const pair = `${i}:${s}:${j}:${k}`;
          if (done.has(pair)) continue;
          done.add(pair);
          const c = ways[j].line[k - 1];
          const d = ways[j].line[k];
          const x = cross(a, b, c, d);
          if (x) {
            cutAt(i, s, x[0]);
            cutAt(j, k, x[1]);
          }
          // Ends of way i on segment k of way j, and the other way round.
          const ends = (line: Point[], seg: number): Point[] => [...(seg === 1 ? [line[0]] : []), ...(seg === line.length - 1 ? [line[line.length - 1]] : [])];
          for (const e of ends(w.line, s)) {
            const p = project(e, c, d);
            if (p.d <= SNAP) cutAt(j, k, p.t);
          }
          for (const e of ends(ways[j].line, k)) {
            const p = project(e, a, b);
            if (p.d <= SNAP) cutAt(i, s, p.t);
          }
        }
      });
    }
  });

  // Holding positions: on the nearest taxiway (never a runway: the hold is short of it).
  for (const h of map.holdingPositions) {
    const p: Point | null = h.point ?? (h.line ? [(h.line[0][0] + h.line[h.line.length - 1][0]) / 2, (h.line[0][1] + h.line[h.line.length - 1][1]) / 2] : null);
    if (!p) continue;
    let best: { i: number; s: number; t: number; d: number } | null = null;
    cells(p, p, HOLD_SNAP, (key) => {
      for (const [i, s] of grid.get(key) ?? []) {
        if (ways[i].kind === "runway") continue;
        const q = project(p, ways[i].line[s - 1], ways[i].line[s]);
        if (q.d <= HOLD_SNAP && (!best || q.d < best.d)) best = { i, s, t: q.t, d: q.d };
      }
    });
    const found = best as { i: number; s: number; t: number } | null;
    if (found) cutAt(found.i, found.s, found.t, true);
  }

  // Nodes: cut points within SNAP of each other are one node.
  const nodes: TaxiNode[] = [];
  const nodeGrid = new Map<string, number[]>();
  const nodeFor = (c: Cut): number => {
    const gx = Math.floor(c.x / CELL);
    const gy = Math.floor(c.y / CELL);
    let best = -1;
    let bestD = SNAP;
    for (let x = gx - 1; x <= gx + 1; x++) {
      for (let y = gy - 1; y <= gy + 1; y++) {
        for (const n of nodeGrid.get(`${x},${y}`) ?? []) {
          const d = Math.hypot(nodes[n].x - c.x, nodes[n].y - c.y);
          if (d <= bestD) {
            best = n;
            bestD = d;
          }
        }
      }
    }
    if (best >= 0) {
      nodes[best].hold ||= c.hold;
      return best;
    }
    nodes.push({ x: c.x, y: c.y, hold: c.hold });
    const key = `${gx},${gy}`;
    const list = nodeGrid.get(key);
    if (list) list.push(nodes.length - 1);
    else nodeGrid.set(key, [nodes.length - 1]);
    return nodes.length - 1;
  };

  // Ends and crossings first, so a hold a metre from a junction joins the junction rather than the other way round.
  const order = ways.map((_, i) => i);
  const ids = cuts.map(() => new Map<Cut, number>());
  for (const pass of [false, true]) for (const i of order) for (const c of cuts[i]) if (c.hold === pass) ids[i].set(c, nodeFor(c));

  const edges: TaxiEdge[] = [];
  const links: number[][] = [];
  ways.forEach((w, i) => {
    const sorted = [...cuts[i]].sort((p, q) => p.at - q.at);
    let prev = sorted[0];
    let prevNode = ids[i].get(prev)!;
    for (const c of sorted.slice(1)) {
      const node = ids[i].get(c)!;
      if (node === prevNode) continue;
      const line: Point[] = [[nodes[prevNode].x, nodes[prevNode].y]];
      for (let v = Math.floor(prev.at) + 1; v < c.at; v++) line.push(w.line[v]);
      line.push([nodes[node].x, nodes[node].y]);
      const length = wayLength(line);
      if (length > 0) edges.push({ a: prevNode, b: node, length, line, kind: w.kind, ref: w.ref, runway: w.runway });
      prev = c;
      prevNode = node;
    }
  });
  for (let n = 0; n < nodes.length; n++) links.push([]);
  edges.forEach((e, k) => {
    links[e.a].push(k);
    links[e.b].push(k);
  });
  return { nodes, edges, links };
}

export interface LocateOptions {
  /** Prefer edges running along this heading: a taxiing aircraft is on the taxiway it is following. */
  headingDeg?: number | null;
  /** Farthest the point may be from the network, metres. Default 150. */
  maxDistance?: number;
  /** Whether a runway edge may be the answer. Default false: on the ground off a runway, an aircraft is on a taxiway. */
  runways?: boolean;
}

/** The point on the network nearest (x, y), or null when none is within reach. */
export function locate(graph: TaxiGraph, x: number, y: number, { headingDeg = null, maxDistance = 150, runways = false }: LocateOptions): Located | null {
  let best: Located | null = null;
  let bestScore = Infinity;
  const hx = headingDeg === null ? 0 : Math.sin(headingDeg * RAD);
  const hy = headingDeg === null ? 0 : Math.cos(headingDeg * RAD);
  graph.edges.forEach((e, k) => {
    if (e.kind === "runway" && !runways) return;
    let along = 0;
    for (let s = 1; s < e.line.length; s++) {
      const a = e.line[s - 1];
      const b = e.line[s];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const p = project([x, y], a, b);
      if (p.d <= maxDistance) {
        // Across a junction the nearest edge can be a side branch: one running the aircraft's way wins unless it is much farther.
        const turn = headingDeg === null || len === 0 ? 0 : 1 - Math.abs(((b[0] - a[0]) * hx + (b[1] - a[1]) * hy) / len);
        const score = p.d + 25 * turn;
        if (score < bestScore) {
          bestScore = score;
          best = { edge: k, along: along + p.t * len, x: a[0] + (b[0] - a[0]) * p.t, y: a[1] + (b[1] - a[1]) * p.t, distance: p.d };
        }
      }
      along += len;
    }
  });
  return best;
}

/** The part of an edge's line between two distances along it, in the order asked for. */
export function slice(line: Point[], from: number, to: number): Point[] {
  const forward = from <= to;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out: Point[] = [];
  let along = 0;
  for (let s = 1; s < line.length; s++) {
    const a = line[s - 1];
    const b = line[s];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const at = (d: number): Point => {
      const t = len === 0 ? 0 : (d - along) / len;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    if (!out.length && lo <= along + len) out.push(at(Math.max(lo, along)));
    if (out.length && hi <= along + len) {
      out.push(at(hi));
      break;
    }
    if (out.length) out.push(b);
    along += len;
  }
  if (out.length === 1) out.push(out[0]);
  return forward ? out : out.reverse();
}

export interface PathOptions {
  /** The aircraft's heading at the start: setting off the other way costs a U-turn. */
  headingDeg?: number | null;
}

export interface Route {
  points: Point[];
  /** Metres. */
  length: number;
  /** Node indices passed, start to end. */
  nodes: number[];
  /** Edge indices travelled, start to end: for a start part way along an edge, that edge first. */
  edges: number[];
}

export interface Reach {
  /** Cost to reach a node: metres, with runway taxiing and U-turns weighted. Infinity when unreachable. */
  cost(node: number): number;
  path(node: number): Route | null;
}

/** Dijkstra from a point on the network (or a node) to every node. */
export function shortestPaths(graph: TaxiGraph, from: Located | number, { headingDeg = null }: PathOptions): Reach {
  const n = graph.nodes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const via = new Int32Array(n).fill(-1);
  const heap: Array<[number, number]> = [];
  const push = (c: number, node: number) => {
    heap.push([c, node]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const weight = (e: TaxiEdge) => e.length * factorOf(e);

  /** Where the start leads first: for a point on an edge, its two ends. */
  const start = typeof from === "number" ? null : from;
  if (start) {
    const e = graph.edges[start.edge];
    const factor = factorOf(e);
    // The edge's direction at the start, to tell which end is ahead.
    let ahead = 0;
    if (headingDeg !== null) {
      const [p, q] = tangentAt(e.line, start.along);
      ahead = Math.sin(headingDeg * RAD) * p + Math.cos(headingDeg * RAD) * q;
    }
    const toA = start.along * factor + (ahead > 0 ? U_TURN : 0);
    const toB = (e.length - start.along) * factor + (ahead < 0 ? U_TURN : 0);
    for (const [node, c] of [
      [e.a, toA],
      [e.b, toB],
    ] as const) {
      if (c < cost[node]) {
        cost[node] = c;
        via[node] = -2;
        push(c, node);
      }
    }
  } else if (typeof from === "number") {
    cost[from] = 0;
    push(0, from);
  }
  while (heap.length) {
    const [c, node] = pop();
    if (c > cost[node]) continue;
    for (const k of graph.links[node]) {
      const e = graph.edges[k];
      const other = e.a === node ? e.b : e.a;
      const next = c + weight(e);
      if (next < cost[other]) {
        cost[other] = next;
        via[other] = k;
        push(next, other);
      }
    }
  }

  return {
    cost: (node) => cost[node],
    path(node) {
      if (!Number.isFinite(cost[node])) return null;
      const chain: number[] = [];
      const nodesOut: number[] = [node];
      let at = node;
      while (via[at] >= 0) {
        const e = graph.edges[via[at]];
        chain.push(via[at]);
        at = e.a === at ? e.b : e.a;
        nodesOut.push(at);
      }
      nodesOut.reverse();
      chain.reverse();
      const points: Point[] = [];
      if (start) {
        const e = graph.edges[start.edge];
        points.push(...slice(e.line, start.along, at === e.a ? 0 : e.length));
      } else {
        points.push([graph.nodes[at].x, graph.nodes[at].y]);
      }
      let cur = at;
      for (const k of chain) {
        const e = graph.edges[k];
        const line = e.a === cur ? e.line : [...e.line].reverse();
        points.push(...line.slice(1));
        cur = e.a === cur ? e.b : e.a;
      }
      return { points: dedupe(points), length: lineLength(points), nodes: nodesOut, edges: start ? [start.edge, ...chain] : chain };
    },
  };
}

function factorOf(e: TaxiEdge): number {
  return e.kind === "runway" ? RUNWAY_FACTOR : e.kind === "taxilane" || e.ref === null ? LANE_FACTOR : 1;
}

function tangentAt(line: Point[], along: number): [number, number] {
  let d = 0;
  for (let s = 1; s < line.length; s++) {
    const len = Math.hypot(line[s][0] - line[s - 1][0], line[s][1] - line[s - 1][1]);
    if (along <= d + len || s === line.length - 1) return len === 0 ? [0, 0] : [(line[s][0] - line[s - 1][0]) / len, (line[s][1] - line[s - 1][1]) / len];
    d += len;
  }
  return [0, 0];
}

function dedupe(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || Math.hypot(p[0] - points[i - 1][0], p[1] - points[i - 1][1]) > 1e-6);
}

export function lineLength(line: Point[]): number {
  return wayLength(line);
}
