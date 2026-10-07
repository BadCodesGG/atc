import { describe, expect, it } from "vitest";
import type { Runway } from "../airport-map";
import { extrude, fill, type MeshData, ribbons, runwayMarkings, taxiwayRuns } from "./ground";

/** Total area of a mesh's triangles, square metres, computed independently of the builders. */
function area(mesh: MeshData, first = 0, count = mesh.indices.length): number {
  const p = mesh.positions;
  let sum = 0;
  for (let i = first; i < first + count; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]].map((k) => [p[3 * k], p[3 * k + 1], p[3 * k + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    sum += Math.hypot(cross[0], cross[1], cross[2]) / 2;
  }
  return sum;
}

function bounds(mesh: MeshData) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min, max };
}

/** Every triangle faces up (+y): seen from above it is counter-clockwise, so it is not culled. */
function allFaceUp(mesh: MeshData): boolean {
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    const ux = p[3 * b] - p[3 * a];
    const uz = p[3 * b + 2] - p[3 * a + 2];
    const vx = p[3 * c] - p[3 * a];
    const vz = p[3 * c + 2] - p[3 * a + 2];
    // y component of u x v.
    if (uz * vx - ux * vz < -1e-9) return false;
  }
  return true;
}

describe("ribbons", () => {
  it("lays a straight line down as a strip of its width, east along x and north along -z, at the given height", () => {
    const mesh = ribbons([{ line: [[0, 0], [100, 0]], width: 10 }], { height: 0.5, caps: "butt" });
    expect(area(mesh)).toBeCloseTo(1000);
    expect(bounds(mesh)).toEqual({ min: [0, 0.5, -5], max: [100, 0.5, 5] });
    expect(allFaceUp(mesh)).toBe(true);
  });

  it("maps north to -z", () => {
    const mesh = ribbons([{ line: [[0, 0], [0, 50]], width: 2 }], { height: 0, caps: "butt" });
    expect(bounds(mesh).min[2]).toBeCloseTo(-50);
    expect(bounds(mesh).max[2]).toBeCloseTo(0);
  });

  it("rounds the ends and the joints when asked", () => {
    const mesh = ribbons([{ line: [[0, 0], [100, 0]], width: 10 }], { height: 0, caps: "round" });
    // Two half-discs at the ends make one disc of radius 5; the joint discs overlap the strip.
    expect(area(mesh)).toBeGreaterThan(1000 + Math.PI * 25 * 0.9);
    expect(bounds(mesh).min[0]).toBeCloseTo(-5, 0);
    expect(allFaceUp(mesh)).toBe(true);
  });
});

describe("fill", () => {
  it("triangulates a polygon with a hole, facing up", () => {
    const outer: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const hole: [number, number][] = [[40, 40], [40, 60], [60, 60], [60, 40]];
    const mesh = fill([[outer, hole]], 0.2);
    expect(area(mesh)).toBeCloseTo(10_000 - 400);
    expect(allFaceUp(mesh)).toBe(true);
  });

  it("does not care which way round the outer ring was drawn", () => {
    const cw: [number, number][] = [[0, 0], [0, 10], [10, 10], [10, 0]];
    const mesh = fill([[cw]], 0);
    expect(area(mesh)).toBeCloseTo(100);
    expect(allFaceUp(mesh)).toBe(true);
  });
});

describe("extrude", () => {
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];

  it("raises a footprint to its height times the scale, with a roof group and a wall group", () => {
    const mesh = extrude([{ rings: [square], height: 8 }], 2);
    expect(bounds(mesh).max[1]).toBeCloseTo(16);
    expect(bounds(mesh).min[1]).toBeCloseTo(0);
    const [roof, walls] = mesh.groups;
    expect(area(mesh, roof.start, roof.count)).toBeCloseTo(100);
    expect(area(mesh, walls.start, walls.count)).toBeCloseTo(4 * 10 * 16);
  });

  it("points every wall normal away from the building and every roof normal up", () => {
    const mesh = extrude([{ rings: [square], height: 8 }], 1);
    const n = mesh.normals!;
    const p = mesh.positions;
    for (let v = 0; v < p.length / 3; v++) {
      const [nx, ny, nz] = [n[3 * v], n[3 * v + 1], n[3 * v + 2]];
      if (ny > 0.5) continue;
      // Centre of the footprint is (5, -5) in world x/z.
      const out = (p[3 * v] - 5) * nx + (p[3 * v + 2] + 5) * nz;
      expect(out).toBeGreaterThan(0);
    }
  });

  it("leaves a courtyard open", () => {
    const outer: [number, number][] = [[0, 0], [30, 0], [30, 30], [0, 30]];
    const hole: [number, number][] = [[10, 10], [10, 20], [20, 20], [20, 10]];
    const mesh = extrude([{ rings: [outer, hole], height: 5 }], 1);
    const [roof, walls] = mesh.groups;
    expect(area(mesh, roof.start, roof.count)).toBeCloseTo(900 - 100);
    expect(area(mesh, walls.start, walls.count)).toBeCloseTo((120 + 40) * 5);
  });
});

describe("runwayMarkings", () => {
  const runway: Runway = {
    ref: "09/27",
    width: 45,
    surface: null,
    centerline: [[-1000, 0], [1000, 0]],
    ends: [
      { ref: "09", x: -1000, y: 0 },
      { ref: "27", x: 1000, y: 0 },
    ],
  };

  it("dashes the centreline and paints threshold bars, all inside the runway", () => {
    const mesh = runwayMarkings([runway], { height: 0.4, dash: 30, gap: 30, lineWidth: 4, thresholdLength: 50 });
    const { min, max } = bounds(mesh);
    expect(min[0]).toBeGreaterThanOrEqual(-1000);
    expect(max[0]).toBeLessThanOrEqual(1000);
    expect(Math.max(-min[2], max[2])).toBeLessThanOrEqual(45 / 2);
    expect(allFaceUp(mesh)).toBe(true);
    // Far less paint than tarmac, but some.
    expect(area(mesh)).toBeGreaterThan(0.02 * 2000 * 45);
    expect(area(mesh)).toBeLessThan(0.3 * 2000 * 45);
  });
});

describe("taxiwayRuns", () => {
  const apron = { rings: [[[0, 0], [400, 0], [400, 400], [0, 400]]] as [number, number][][] };

  it("keeps a taxiway off the aprons as one major run", () => {
    const runs = taxiwayRuns({ taxiways: [{ ref: "A", width: 23, kind: "taxiway", line: [[-500, -100], [-100, -100], [-100, 600]] }], aprons: [apron] });
    expect(runs).toEqual([{ ref: "A", line: [[-500, -100], [-100, -100], [-100, 600]], width: 23, minor: false }]);
  });

  it("marks every mapped taxilane minor", () => {
    const runs = taxiwayRuns({ taxiways: [{ ref: null, width: 15, kind: "taxilane", line: [[-500, -100], [-100, -100]] }], aprons: [] });
    expect(runs).toEqual([{ ref: null, line: [[-500, -100], [-100, -100]], width: 15, minor: true }]);
  });

  it("marks a taxiway mapped without a designator minor: the connectors and lanes the charts do not name", () => {
    const runs = taxiwayRuns({ taxiways: [{ ref: null, width: 23, kind: "taxiway", line: [[-500, -100], [-100, -100]] }], aprons: [] });
    expect(runs.map((r) => r.minor)).toEqual([true]);
  });

  it("splits a taxiway where it runs across an apron, without losing any of its geometry", () => {
    const line: [number, number][] = [[-200, 200], [100, 200], [300, 200], [600, 200]];
    const runs = taxiwayRuns({ taxiways: [{ ref: "B", width: 23, kind: "taxiway", line }], aprons: [apron] });
    expect(runs.map((r) => r.minor)).toEqual([false, true, false]);
    expect(runs.map((r) => r.line)).toEqual([
      [[-200, 200], [100, 200]],
      [[100, 200], [300, 200]],
      [[300, 200], [600, 200]],
    ]);
  });

  it("treats a hole in an apron as off it", () => {
    const holed = { rings: [...apron.rings, [[100, 100], [300, 100], [300, 300], [100, 300]]] as [number, number][][] };
    const runs = taxiwayRuns({ taxiways: [{ ref: "C", width: 23, kind: "taxiway", line: [[150, 200], [250, 200]] }], aprons: [holed] });
    expect(runs[0].minor).toBe(false);
  });
});
