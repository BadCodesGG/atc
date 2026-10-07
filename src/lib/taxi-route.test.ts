import { describe, expect, it } from "vitest";
import type { AirportMap, Point, Taxiway } from "./airport-map";
import { GroundPaths, TaxiRouter } from "./taxi-route";

const taxiway = (...line: Point[]): Taxiway => ({ ref: null, width: 20, kind: "taxiway", line });

function plan(taxiways: Taxiway[], extra: Partial<AirportMap> = {}): Pick<AirportMap, "taxiways" | "runways" | "aprons"> {
  return { taxiways, runways: [], aprons: [], ...extra };
}

/** Distance from p to the nearest of the taxiways' centrelines. */
function offLines(p: Point, taxiways: Taxiway[]): number {
  let best = Infinity;
  for (const { line } of taxiways) {
    for (let i = 1; i < line.length; i++) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const dx = bx - ax;
      const dy = by - ay;
      const u = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(p[0] - ax - u * dx, p[1] - ay - u * dy));
    }
  }
  return best;
}

const near = (points: Point[], target: Point, within = 1) => points.some((p) => Math.hypot(p[0] - target[0], p[1] - target[1]) <= within);

describe("TaxiRouter", () => {
  it("routes round a corner along the taxiways instead of across the grass", () => {
    const ways = [taxiway([0, 0], [1000, 0]), taxiway([1000, 0], [1000, 1000])];
    const path = new TaxiRouter(plan(ways)).route([100, 5], [995, 900])!;
    expect(near(path, [1000, 0])).toBe(true);
    for (const p of path) expect(offLines(p, ways)).toBeLessThan(1e-6);
  });

  it("joins a taxiway that ends beside another, where the mapped junction node was simplified away", () => {
    const ways = [taxiway([0, 0], [1000, 0]), taxiway([500, 6], [500, 800])];
    const path = new TaxiRouter(plan(ways)).route([100, 0], [500, 700])!;
    expect(path).not.toBeNull();
    expect(near(path, [500, 0])).toBe(true);
  });

  it("turns where two taxiways cross with no shared node, a runway's centreline included", () => {
    const runway = { ref: "18/36", width: 45, surface: null, centerline: [], ends: [{ ref: "18", x: 300, y: 500 }, { ref: "36", x: 300, y: -500 }] };
    const path = new TaxiRouter(plan([taxiway([0, 0], [1000, 0])], { runways: [runway] })).route([300, -400], [900, 0])!;
    expect(near(path, [300, 0])).toBe(true);
  });

  it("finds no route from a point off the network", () => {
    expect(new TaxiRouter(plan([taxiway([0, 0], [1000, 0])])).route([500, 200], [900, 0])).toBeNull();
  });

  it("finds no route when the only way round is far longer than the distance between the points", () => {
    const ways = [taxiway([0, 0], [1000, 0], [5000, 0], [5000, 100], [1000, 100], [0, 100])];
    expect(new TaxiRouter(plan(ways)).route([500, 0], [500, 100])).toBeNull();
  });
});

describe("GroundPaths", () => {
  it("follows the taxiways between two ground fixes when it can", () => {
    const ways = [taxiway([0, 0], [1000, 0]), taxiway([1000, 0], [1000, 1000])];
    const between = new GroundPaths(plan(ways)).between([100, 0], [1000, 900]);
    expect(near(between, [1000, 0])).toBe(true);
  });

  it("keeps a straight run between two fixes on pavement when there is no route, by putting each point back on it", () => {
    // Two parallel taxiways, 60 m apart and never joined: the straight line crosses the grass between them.
    const ways = [taxiway([0, 0], [1000, 0]), taxiway([0, 60], [1000, 60])];
    const between = new GroundPaths(plan(ways)).between([100, 0], [600, 60]);
    expect(between.length).toBeGreaterThan(5);
    for (const p of between) expect(offLines(p, ways)).toBeLessThanOrEqual(10 + 1e-6);
  });

  it("puts a fix that sits off the pavement back on it, and finds none for a fix far from any", () => {
    const paths = new GroundPaths(plan([taxiway([0, 0], [1000, 0])]));
    expect(paths.snap([500, 50])).toEqual([500, 10]);
    expect(paths.snap([500, 5])).toEqual([500, 5]);
    expect(paths.snap([500, 200])).toBeNull();
  });
});
