import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Situation } from "./aircraft-state";
import type { AirportMap } from "./airport-map";
import { AIRPORTS } from "./airports";
import { PathPredictor, type PathAircraft } from "./predicted-path";
import { localProcedures, type ProcedureFile } from "./procedure-path";
import type { RunwayUse } from "./pulse";

const atl = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;
const predictor = new PathPredictor(atl);

/** East flow, as in the fixture: landing 8L and 9R, departing 9L. */
const EAST: RunwayUse[] = [
  { runway: "8L", arrivals: 1, departures: 0, source: "observed" },
  { runway: "9L", arrivals: 0, departures: 1, source: "observed" },
  { runway: "9R", arrivals: 2, departures: 0, source: "observed" },
];

function plane(x: number, y: number, headingDeg: number, s: Partial<Situation> = {}, rest: Partial<PathAircraft> = {}): PathAircraft {
  return {
    id: "a",
    x,
    y,
    headingDeg,
    headingKnown: true,
    onGround: (s.aglFt ?? 0) === 0,
    groundSpeedKt: 15,
    direction: null,
    situation: { state: "taxiing", activity: "Taxiing", runway: null, aglFt: 0, moving: true, ...s },
    ...rest,
  };
}

const near = (p: readonly number[], x: number, y: number, within: number) => Math.hypot(p[0] - x, p[1] - y) <= within;

describe("PathPredictor: departures", () => {
  it("taxis a departure from Concourse D's ramp to the 9L hold, down 9L and out along its centreline", () => {
    const p = predictor.predict(plane(-185, -7, 270, {}, { direction: "outbound" }), EAST)!;
    expect(p.runway).toBe("9L");
    expect(p.legs.map((l) => l.kind)).toEqual(["taxi", "runway", "air"]);
    const [taxi, runway, air] = p.legs;
    expect(taxi.points[0][0]).toBeCloseTo(-185, -1);
    // The taxi route ends at a holding point beside the 09L threshold (-1840, -221).
    expect(near(taxi.points.at(-1)!, -1840, -221, 400)).toBe(true);
    // The roll runs east along the centreline (y = -221) and the climb carries on past the far end, rising.
    expect(runway.points.every((q) => Math.abs(q[1] + 221) < 5 && q[2] === 0)).toBe(true);
    expect(runway.points.at(-1)![0]).toBeGreaterThan(runway.points[0][0]);
    expect(air.points.at(-1)![0]).toBeGreaterThan(1929);
    expect(air.points.at(-1)![2]).toBeGreaterThan(150);
  });

  it("sends a north-side departure to the nearer runway of the same flow, though nobody has used it yet", () => {
    const p = predictor.predict(plane(-770, 970, 270, {}, { direction: "outbound" }), EAST)!;
    expect(p.runway).toBe("8R");
    expect(near(p.legs[0].points.at(-1)!, -950, 1122, 400)).toBe(true);
  });

  it("never sends a departure to a runway used only for arrivals", () => {
    const p = predictor.predict(plane(-1206, 1300, 0, {}, { direction: "outbound" }), EAST)!;
    expect(p.runway).not.toBe("8L");
  });

  it("predicts nothing for a departure while no runway is known to be in use", () => {
    expect(predictor.predict(plane(-185, -7, 270, {}, { direction: "outbound" }), [])).toBeNull();
  });

  it("draws a climbing departure's climb-out ahead of it", () => {
    const p = predictor.predict(plane(5430, -225, 91, { state: "departing", activity: "Climbing out", runway: "9L", aglFt: 2563 }), EAST)!;
    expect(p.legs.map((l) => l.kind)).toEqual(["air"]);
    expect(p.legs[0].points[0][0]).toBeCloseTo(5430, -1);
    expect(p.legs[0].points.at(-1)![0]).toBeGreaterThan(5430);
  });
});

/** Taxi-leg segments that run along a runway's centreline (both ends on it), rather than across it. */
function alongRunways(points: [number, number, number][]): number {
  const onCentreline = (p: [number, number, number], r: (typeof atl.runways)[number]) => {
    const [a, b] = r.ends;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const along = (p[0] - a.x) * ux + (p[1] - a.y) * uy;
    const across = -(p[0] - a.x) * uy + (p[1] - a.y) * ux;
    return along >= -5 && along <= len + 5 && Math.abs(across) < 5;
  };
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    if (Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) < 1) continue;
    if (atl.runways.some((r) => r.ends.length === 2 && onCentreline(points[i - 1], r) && onCentreline(points[i], r))) n++;
  }
  return n;
}

describe("PathPredictor: taxi routes keep off the runways", () => {
  // The ramp south of Concourse A, and departures on 9L or on 8R.
  const fromRampA = (use: RunwayUse[]) => predictor.predict(plane(-1025, 30, 180, {}, { direction: "outbound" }), use)!;

  it("reaches the 9L hold from the ramp south of Concourse A on taxiways only", () => {
    const p = fromRampA([{ runway: "9L", arrivals: 0, departures: 1, source: "observed" }]);
    expect(p.runway).toBe("9L");
    expect(alongRunways(p.legs[0].points)).toBe(0);
  });

  it("reaches the 8R hold from the ramp south of Concourse A on taxiways only", () => {
    const p = fromRampA([
      { runway: "8R", arrivals: 0, departures: 1, source: "observed" },
      ...["8L", "9L", "9R", "10"].map((runway) => ({ runway, arrivals: 1, departures: 0, source: "observed" as const })),
    ]);
    expect(p.runway).toBe("8R");
    expect(alongRunways(p.legs[0].points)).toBe(0);
  });

  it("keeps every fixture-shaped departure in east flow off the runways until it lines up", () => {
    for (const [x, y, h] of [
      [652, -335, 82],
      [-261, -98, 270],
      [-1321, -99, 270],
      [-770, 970, 270],
      [431, 709, 3],
    ]) {
      const p = predictor.predict(plane(x, y, h, {}, { direction: "outbound" }), EAST);
      if (p) expect(alongRunways(p.legs[0].points), `from ${x}, ${y}`).toBe(0);
    }
  });
});

describe("PathPredictor: arrivals", () => {
  it("lands an arrival on 9R, turns it off toward the terminals and taxis it to the ramp", () => {
    const p = predictor.predict(plane(-1411, -544, 90, { state: "arriving", activity: "Landing", runway: "9R", aglFt: 300 }), EAST)!;
    expect(p.runway).toBe("9R");
    expect(p.legs.map((l) => l.kind)).toEqual(["air", "runway", "taxi"]);
    const [, rollout, taxi] = p.legs;
    const exit = rollout.points.at(-1)!;
    // A rollout long enough to slow down, and off before the far end (27L at x = 897).
    expect(exit[0] + 1839).toBeGreaterThan(1300);
    expect(exit[0]).toBeLessThan(897);
    // Off to the north, the terminal side, and ending among the gates.
    expect(taxi.points[1][1]).toBeGreaterThan(-543);
    const end = taxi.points.at(-1)!;
    expect(atl.gates.some((g) => near(end, g.x, g.y, 200))).toBe(true);
  });

  it("takes an arrival taxiing in to the nearest ramp ahead of it", () => {
    const p = predictor.predict(plane(-49, 878, 270, {}, { direction: "inbound" }), EAST)!;
    expect(p.legs.map((l) => l.kind)).toEqual(["taxi"]);
    expect(atl.gates.some((g) => near(p.legs[0].points.at(-1)!, g.x, g.y, 200))).toBe(true);
  });
});

describe("PathPredictor: what it leaves alone", () => {
  it("predicts nothing for a parked aircraft", () => {
    expect(predictor.predict(plane(-73, 620, 270, { state: "parked", activity: "At gate D29", moving: false }), EAST)).toBeNull();
  });

  it("predicts nothing for an aircraft of unknown heading whose way it cannot tell", () => {
    expect(predictor.predict(plane(-49, 878, 0, {}, { headingKnown: false }), EAST)).toBeNull();
  });
});

describe("PathPredictor: which way a taxiing aircraft is going, when nothing says", () => {
  it("takes one heading away from the gates for a departure", () => {
    const p = predictor.predict(plane(-1321, -99, 270), EAST)!;
    expect(p.kind).toBe("departure");
    expect(p.runway).toBe("9L");
  });

  it("takes one heading in among the gates for an arrival", () => {
    const p = predictor.predict(plane(-1321, -99, 90), EAST)!;
    expect(p.kind).toBe("arrival");
    expect(p.runway).toBeNull();
  });
});

describe("PathPredictor: with the published procedures (FAA CIFP)", () => {
  const procedures = localProcedures(JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/procedures/atl.json"), "utf8")) as ProcedureFile, AIRPORTS[0]);
  const cifp = new PathPredictor(atl, procedures);
  const end08L = atl.runways.flatMap((r) => r.ends).find((e) => e.ref === "08L")!;
  const SFO = { latitude: 37.619, longitude: -122.375 };
  const descending = (q: [number, number, number][]) => q.every((p, i) => i === 0 || p[2] <= q[i - 1][2] + 1e-9);

  it("brings an arrival on final down the ILS to 8L, over the threshold at its crossing height, and cites it", () => {
    // RPA4349 in the fixture: 3.8 km out on the 8L centreline, 524 ft above the field.
    const p = cifp.predict(plane(-4847, 1429, 90, { state: "arriving", activity: "Final approach", runway: "8L", aglFt: 524 }), EAST)!;
    expect(p.legs.map((l) => l.kind)).toEqual(["air", "runway", "taxi"]);
    const air = p.legs[0].points;
    expect(air[0]).toEqual([-4847, 1429, 524 * 0.3048]);
    // The 8L threshold, 50 ft up with the threshold 11 ft below the field: 39 ft above it.
    const over = air.find((q) => near(q, end08L.x, end08L.y, 30))!;
    expect(over[2]).toBeCloseTo(39 * 0.3048, 0);
    expect(air.at(-1)![2]).toBe(0);
    expect(p.procedure).toEqual({ kind: "approach", name: "ILS RWY 8L", cycle: "2610", likely: false });
  });

  it("joins an arrival farther out to the approach at its next fix, never climbing on the way down", () => {
    // Low for the distance: the published fixes ahead are higher than it is, and it is not drawn climbing to them.
    const p = cifp.predict(plane(-20000, 1429, 90, { state: "arriving", activity: "Final approach", runway: "8L", aglFt: 1200 }), EAST)!;
    const air = p.legs[0].points;
    expect(air.length).toBeGreaterThan(3);
    expect(descending(air)).toBe(true);
  });

  it("works out the runway of a selected arrival not yet lined up, from where it is and the arrivals in use", () => {
    // DAL1488 in the fixture: north-west of the field, descending through 2200 ft above it.
    const a = plane(-15443, 2497, 115, { state: "arriving", activity: "Descending", aglFt: 2174 });
    expect(cifp.predict(a, EAST)).toBeNull();
    const p = cifp.predict(a, EAST, { inferRunway: true })!;
    expect(p.runway).toBe("8L");
    expect(p.procedure?.likely).toBe(true);
  });

  it("matches an arrival to a final only when its track converges on it", () => {
    const at = (x: number, y: number, headingDeg: number) => cifp.predict(plane(x, y, headingDeg, { state: "arriving", activity: "Descending", aglFt: 2174 }), EAST, { inferRunway: true });
    // DAL1488's position heading away from the field: no runway.
    expect(at(-15443, 2497, 300)).toBeNull();
    // On the 8L centreline, or drifting toward it, but flying away from the field: no runway.
    expect(at(-15000, 1500, 270)).toBeNull();
    expect(at(-15443, 2497, 225)).toBeNull();
    // Closing on the field but drifting north, away from every final in use: no runway either.
    expect(at(-15000, 4000, 80)).toBeNull();
    // Closing on the 8L final from north of it: 8L.
    expect(at(-15000, 4000, 120)?.runway).toBe("8L");
    // With no heading or track to go by, no guess.
    expect(cifp.predict(plane(-15443, 2497, 115, { state: "arriving", activity: "Descending", aglFt: 2174 }, { headingKnown: false }), EAST, { inferRunway: true })).toBeNull();
  });

  it("cites the file's silence at an airport with no SID in it, and keeps the extended centreline", () => {
    const none = new PathPredictor(atl, { ...procedures, departures: {} });
    const p = none.predict(plane(-770, 970, 270, {}, { direction: "outbound", destination: SFO }), EAST)!;
    expect(p.legs.at(-1)!.points).toHaveLength(2);
    expect(p.procedure).toEqual({ kind: "no-sid", name: "", cycle: "2610", likely: false });
  });

  it("with nothing seen in use, takes the flow from the wind: a westerly lands an arrival east of the field on 26R", () => {
    const wind = { directionDeg: 270, speedKt: 12, gustKt: null, variable: false, range: null };
    const p = cifp.predict(plane(15000, 1500, 270, { state: "arriving", activity: "Descending", aglFt: 3000 }), [], { inferRunway: true, wind })!;
    expect(p.runway).toBe("26R");
  });

  it("sends a departure for San Francisco off 8R on the SID that leaves toward it, and says it is the likely one", () => {
    const p = cifp.predict(plane(-770, 970, 270, {}, { direction: "outbound", destination: SFO }), EAST)!;
    expect(p.runway).toBe("8R");
    const air = p.legs.at(-1)!.points;
    // SFO is 286 degrees from ATL; CUTTN2 leaves by CUTTN, 286 degrees and 74 km out. Off 8R it turns back west.
    expect(p.procedure).toEqual({ kind: "climb-out", name: "CUTTN2", cycle: "2610", likely: true });
    expect(air.at(-1)![0]).toBeLessThan(air[0][0] - 5000);
    expect(air.every((q, i) => i === 0 || q[2] >= air[i - 1][2])).toBe(true);
  });

  it("without a destination, or with one that is this airport, keeps a departure on the extended centreline and cites nothing", () => {
    for (const destination of [null, { latitude: 33.6367, longitude: -84.4281 }]) {
      const p = cifp.predict(plane(-770, 970, 270, {}, { direction: "outbound", destination }), EAST)!;
      expect(p.legs.at(-1)!.points).toHaveLength(2);
      expect(p.procedure ?? null).toBeNull();
    }
  });

  it("joins a departure already climbing out on to its SID ahead of it", () => {
    const p = cifp.predict(plane(3000, 1240, 85, { state: "departing", activity: "Climbing out", runway: "8R", aglFt: 900 }, { onGround: false, destination: SFO }), EAST)!;
    const air = p.legs[0].points;
    expect(air[0]).toEqual([3000, 1240, 900 * 0.3048]);
    expect(p.procedure?.name).toBe("CUTTN2");
    expect(air.at(-1)![0]).toBeLessThan(-5000);
    expect(air.every((q, i) => i === 0 || q[2] >= air[i - 1][2])).toBe(true);
  });
});
