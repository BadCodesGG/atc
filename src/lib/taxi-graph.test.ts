import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap, Point, Taxiway } from "./airport-map";
import { buildTaxiGraph, locate, shortestPaths, type TaxiGraph } from "./taxi-graph";

const atl = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;

const way = (line: Point[], ref: string | null = null): Taxiway => ({ ref, width: 23, kind: "taxiway", line });
const plan = (taxiways: Taxiway[], extra: Partial<Pick<AirportMap, "runways" | "holdingPositions">> = {}) => ({ taxiways, runways: [], holdingPositions: [], ...extra });

/** Total edge length of the largest connected piece, over the total. */
function connectedShare(g: TaxiGraph): number {
  const seen = new Int32Array(g.nodes.length).fill(-1);
  const size: number[] = [];
  for (let s = 0; s < g.nodes.length; s++) {
    if (seen[s] >= 0) continue;
    const id = size.length;
    size.push(0);
    const stack = [s];
    seen[s] = id;
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of g.links[n]) {
        const edge = g.edges[e];
        size[id] += edge.length / 2;
        const o = edge.a === n ? edge.b : edge.a;
        if (seen[o] < 0) {
          seen[o] = id;
          stack.push(o);
        }
      }
    }
  }
  const total = size.reduce((a, b) => a + b, 0);
  return Math.max(...size) / total;
}

describe("buildTaxiGraph", () => {
  it("puts a node where two taxiways cross, and splits both there", () => {
    const g = buildTaxiGraph(
      plan([
        way([
          [0, 0],
          [100, 0],
        ]),
        way([
          [50, -50],
          [50, 50],
        ]),
      ]),
    );
    expect(g.nodes).toHaveLength(5);
    expect(g.edges).toHaveLength(4);
    expect(g.nodes.some((n) => n.x === 50 && n.y === 0)).toBe(true);
  });

  it("joins a taxiway that stops just short of another, within the snapping tolerance", () => {
    const g = buildTaxiGraph(
      plan([
        way([
          [0, 0],
          [100, 0],
        ]),
        way([
          [40, 1.5],
          [40, 80],
        ]),
      ]),
    );
    expect(g.edges).toHaveLength(3);
    const junction = g.nodes.findIndex((n) => Math.abs(n.x - 40) < 0.01 && Math.abs(n.y) < 2);
    expect(g.links[junction]).toHaveLength(3);
  });

  it("leaves parallel taxiways a taxiway's width apart unjoined", () => {
    const g = buildTaxiGraph(
      plan([
        way([
          [0, 0],
          [100, 0],
        ]),
        way([
          [0, 30],
          [100, 30],
        ]),
      ]),
    );
    expect(g.edges).toHaveLength(2);
    expect(g.nodes).toHaveLength(4);
  });

  it("makes each mapped holding position a node on its taxiway", () => {
    const g = buildTaxiGraph(
      plan(
        [
          way([
            [0, 0],
            [100, 0],
          ]),
        ],
        { holdingPositions: [{ ref: null, point: [60, 4] }] },
      ),
    );
    expect(g.nodes.filter((n) => n.hold)).toEqual([{ x: 60, y: 0, hold: true }]);
    expect(g.edges.map((e) => e.length).sort((a, b) => a - b)).toEqual([40, 60]);
  });

  it("joins nearly all of ATL's taxiways, taxilanes and runways into one network", () => {
    const g = buildTaxiGraph(atl);
    expect(g.edges.length).toBeGreaterThan(1000);
    expect(connectedShare(g)).toBeGreaterThan(0.95);
    // The 9L departure hold, 90 m north of the threshold.
    expect(g.nodes.some((n) => n.hold && Math.hypot(n.x + 1825, n.y + 132) < 15)).toBe(true);
  });
});

describe("shortestPaths", () => {
  // A square block: from the bottom-left corner the top-right is 200 m either way, the middle cross street makes it 160.
  const block = () =>
    buildTaxiGraph(
      plan([
        way([
          [0, 0],
          [100, 0],
          [100, 100],
        ]),
        way([
          [0, 0],
          [0, 100],
          [100, 100],
        ]),
        way([
          [0, 0],
          [60, 60],
          [100, 100],
        ]),
      ]),
    );

  it("finds the shortest route by length", () => {
    const g = block();
    const from = locate(g, 0, 0, {})!;
    const to = g.nodes.findIndex((n) => n.x === 100 && n.y === 100);
    const route = shortestPaths(g, from, {}).path(to)!;
    expect(route.length).toBeCloseTo(Math.hypot(100, 100), 5);
    expect(route.points[0]).toEqual([0, 0]);
    expect(route.points.at(-1)).toEqual([100, 100]);
  });

  it("starts from a point part way along an edge, going whichever way is shorter", () => {
    const g = buildTaxiGraph(
      plan([
        way([
          [0, 0],
          [100, 0],
        ]),
      ]),
    );
    const from = locate(g, 30, 5, {})!;
    expect(from.distance).toBeCloseTo(5);
    const end = g.nodes.findIndex((n) => n.x === 0);
    const route = shortestPaths(g, from, {}).path(end)!;
    expect(route.length).toBeCloseTo(30);
    expect(route.points).toEqual([
      [30, 0],
      [0, 0],
    ]);
  });

  it("charges a U-turn to an aircraft heading the other way", () => {
    const g = buildTaxiGraph(
      plan([
        way([
          [0, 0],
          [100, 0],
        ]),
      ]),
    );
    // Heading east at x = 30: the west end is nearer, but behind it.
    const from = locate(g, 30, 0, { headingDeg: 90 })!;
    const reach = shortestPaths(g, from, { headingDeg: 90 });
    const west = g.nodes.findIndex((n) => n.x === 0);
    const east = g.nodes.findIndex((n) => n.x === 100);
    expect(reach.cost(west)).toBeGreaterThan(reach.cost(east));
  });

  it("keeps off the runways where a taxiway goes round", () => {
    const g = buildTaxiGraph(
      plan(
        [
          way([
            [0, 0],
            [0, 100],
            [400, 100],
            [400, 0],
          ]),
        ],
        { runways: [{ ref: "09/27", width: 45, surface: null, centerline: [], ends: [{ ref: "09", x: 0, y: 0 }, { ref: "27", x: 400, y: 0 }] }] },
      ),
    );
    const from = locate(g, 0, 0, {})!;
    const east = g.nodes.findIndex((n) => n.x === 400 && n.y === 0);
    expect(shortestPaths(g, from, {}).path(east)!.length).toBeCloseTo(600);
  });

  const runway0927 = { ref: "09/27", width: 45, surface: null, centerline: [], ends: [{ ref: "09", x: 0, y: 0 }, { ref: "27", x: 400, y: 0 }] };

  it("takes a long way round on the taxiways rather than taxi down a runway", () => {
    const g = buildTaxiGraph(
      plan(
        [
          way(
            [
              [0, 0],
              [0, 1000],
              [400, 1000],
              [400, 0],
            ],
            "A",
          ),
        ],
        { runways: [runway0927] },
      ),
    );
    const east = g.nodes.findIndex((n) => n.x === 400 && n.y === 0);
    const route = shortestPaths(g, locate(g, 0, 0, {})!, {}).path(east)!;
    expect(route.length).toBeCloseTo(2400);
    expect(route.edges.every((e) => g.edges[e].kind !== "runway")).toBe(true);
  });

  it("backtracks along a runway where no taxiway runs beside it", () => {
    const g = buildTaxiGraph(
      plan(
        [
          way([
            [0, -200],
            [0, 0],
          ]),
        ],
        { runways: [runway0927] },
      ),
    );
    const east = g.nodes.findIndex((n) => n.x === 400 && n.y === 0);
    const route = shortestPaths(g, locate(g, 0, -200, {})!, {}).path(east)!;
    expect(route.length).toBeCloseTo(600);
    expect(route.edges.some((e) => g.edges[e].kind === "runway")).toBe(true);
  });

  it("keeps to a named taxiway rather than cut a little shorter along an unnamed lane", () => {
    const g = buildTaxiGraph(
      plan([
        way(
          [
            [0, 0],
            [50, 48],
            [100, 0],
          ],
          "A",
        ),
        way([
          [0, 0],
          [100, 0],
        ]),
      ]),
    );
    const from = locate(g, 0, 0, {})!;
    const east = g.nodes.findIndex((n) => n.x === 100);
    expect(shortestPaths(g, from, {}).path(east)!.points).toContainEqual([50, 48]);
  });

  it("routes across ATL from Concourse D's ramp to the 9L departure hold along the taxiways", () => {
    const g = buildTaxiGraph(atl);
    const from = locate(g, -185, -7, { headingDeg: 270 })!;
    expect(from.distance).toBeLessThan(30);
    const hold = g.nodes.findIndex((n) => n.hold && Math.hypot(n.x + 1825, n.y + 132) < 15);
    const route = shortestPaths(g, from, { headingDeg: 270 }).path(hold)!;
    const straight = Math.hypot(-1825 + 185, -132 + 7);
    expect(route.length).toBeGreaterThan(straight);
    expect(route.length).toBeLessThan(straight * 1.6);
    // Every point of it is on mapped pavement: a taxiway or runway line passes within a few metres.
    const lines = [...atl.taxiways.map((t) => t.line), ...atl.runways.map((r) => r.ends.map((e): Point => [e.x, e.y]))];
    const near = (p: Point) =>
      lines.some((l) =>
        l.some((a, i) => {
          if (i === 0) return false;
          const b = l[i - 1];
          const dx = b[0] - a[0];
          const dy = b[1] - a[1];
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
          return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < 5;
        }),
      );
    expect(route.points.every(near)).toBe(true);
  });
});
