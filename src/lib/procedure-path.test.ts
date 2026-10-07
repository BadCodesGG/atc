import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { AIRPORTS } from "./airports";
import { parseCifp } from "./cifp";
import { approachLine, climbOutLine, type LocalLeg, localProcedures, type ProcedureFile, procedurePath } from "./procedure-path";

const atl = AIRPORTS.find((a) => a.code === "atl")!;
const parsed = parseCifp(readFileSync(path.join(import.meta.dirname, "__fixtures__/cifp_sample.txt"), "utf8"), ["KATL"]);
const file: ProcedureFile = { source: "FAA CIFP", cycle: parsed.cycle, effective: parsed.effective, ...parsed.airports.KATL! };
const local = localProcedures(file, atl);
const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;

const FT = 0.3048;
const TAN3 = 0.0524078;

/** A straight-in final from the west to a threshold at the origin, 15 m crossing height. */
const threshold = { x: 0, y: 0, heightM: 15.24 };
const final = (legs: LocalLeg[], to = threshold) => approachLine({ ident: "I09", name: "ILS RWY 9", legs, threshold: to });

describe("localProcedures", () => {
  it("puts ATL's 9R threshold where the map has the runway's end, within 30 m", () => {
    const end = map.runways.flatMap((r) => r.ends).find((e) => e.ref === "09R")!;
    const t = local.approaches["9R"]!.threshold;
    expect(Math.hypot(t.x - end.x, t.y - end.y)).toBeLessThan(30);
  });

  it("gives the threshold its crossing height above the field: 55 ft at 9R, whose threshold is at field elevation", () => {
    expect(local.approaches["9R"]!.threshold.heightM).toBeCloseTo(55 * FT, 2);
  });

  it("keeps the cycle to cite", () => {
    expect(local.cycle).toBe("2610");
  });
});

describe("approachLine", () => {
  it("descends to the threshold on the published angle from the final approach fix", () => {
    const line = final([
      { type: "IF", at: [-5000, 0], role: "FAF", altitudeM: { kind: "atOrAbove", m: 200 } },
      { type: "CF", at: [0, 0], role: "MAP", verticalAngleDeg: 3 },
    ]);
    expect(line.points[0][2]).toBeCloseTo(15.24 + 5000 * TAN3, 1);
    expect(line.points.at(-1)).toEqual([0, 0, 15.24]);
  });

  it("holds a fix outside the final approach fix at its published floor when the extended angle would take it lower", () => {
    const line = final([
      { type: "IF", at: [-10000, 0], altitudeM: { kind: "atOrAbove", m: 609.6 } },
      { type: "CF", at: [-5000, 0], role: "FAF" },
      { type: "CF", at: [0, 0], role: "MAP", verticalAngleDeg: 3 },
    ]);
    expect(line.points[0][2]).toBeCloseTo(609.6, 1);
  });

  it("without a published angle, descends straight from the final approach fix's altitude to the threshold", () => {
    const line = final([
      { type: "IF", at: [-4000, 0], role: "FAF", altitudeM: { kind: "atOrAbove", m: 400 } },
      { type: "TF", at: [-2000, 0] },
      { type: "TF", at: [0, 0], role: "MAP" },
    ]);
    expect(line.points[1][2]).toBeCloseTo((400 + 15.24) / 2, 1);
  });

  it("draws an RF leg as its arc about the published centre", () => {
    const line = final([
      { type: "IF", at: [0, -1000] },
      { type: "RF", at: [1000, 0], centre: [0, 0], turn: "L" },
    ], { x: 1000, y: 0, heightM: 15.24 });
    expect(line.points.length).toBeGreaterThan(4);
    for (const [x, y] of line.points) expect(Math.hypot(x, y)).toBeCloseTo(1000, 0);
    // Turning left from south of the centre to east of it goes by the south-east, not the long way round.
    expect(line.points.every(([x, y]) => x >= -1 && y <= 1)).toBe(true);
  });

  it("skips what it cannot draw, and says so", () => {
    const line = final([
      { type: "IF", at: [-6000, 0] },
      { type: "PI", at: [-6000, 0] },
      { type: "CF", at: [0, 0], role: "MAP", verticalAngleDeg: 3 },
    ]);
    expect(line.points.map(([x]) => x)).toEqual([-6000, 0]);
    expect(line.skipped).toEqual(["PI"]);
  });

  it("draws ATL's ILS 9R from GGUYY to the runway, heading 090 true, 2700 ft above sea level at BURNY or close to it", () => {
    const line = approachLine(local.approaches["9R"]!);
    expect(line.skipped).toEqual([]);
    const [a, b] = [line.points.at(-2)!, line.points.at(-1)!];
    expect((Math.atan2(b[0] - a[0], b[1] - a[1]) * 180) / Math.PI).toBeCloseTo(90, 0);
    // BURNY is the third point: the glide path puts it within 100 ft of its published 2700 ft.
    expect(Math.abs(line.points[2][2] / FT + atl.elevationFt - 2700)).toBeLessThan(100);
  });
});

describe("climbOutLine", () => {
  it("flies a heading-to-altitude leg until the climb reaches the altitude, then direct to the next fix", () => {
    const line = climbOutLine(
      [
        { type: "VA", courseDeg: 90, altitudeM: { kind: "atOrAbove", m: 150 } },
        { type: "DF", at: [5000, 5000] },
      ],
      [0, 0, 0],
      0.06,
    );
    expect(line.points[1][0]).toBeCloseTo(2500, 0);
    expect(line.points[1][1]).toBeCloseTo(0, 6);
    expect(line.points[2].slice(0, 2)).toEqual([5000, 5000]);
  });

  it("follows a heading to intercept until it meets the next leg's course to its fix", () => {
    const line = climbOutLine(
      [
        { type: "VI", courseDeg: 90 },
        { type: "CF", at: [6000, 3000], courseDeg: 45 },
      ],
      [0, 0, 0],
      0.06,
    );
    // The 045 course into (6000, 3000) crosses the 090 heading from the origin at (3000, 0).
    expect(line.points[1][0]).toBeCloseTo(3000, 0);
    expect(line.points[1][1]).toBeCloseTo(0, 6);
    expect(line.points[2].slice(0, 2)).toEqual([6000, 3000]);
  });

  it("ends a heading to a manual termination (radar vectors) after a stub of three nautical miles", () => {
    const line = climbOutLine([{ type: "VM", courseDeg: 0 }], [0, 0, 0], 0.06);
    expect(line.points).toHaveLength(2);
    expect(line.points[1][1]).toBeCloseTo(3 * 1852, 0);
    expect(line.vectors).toBe(true);
  });

  it("follows a heading to a DME distance until the navaid is that far away", () => {
    // Out from a navaid 1 km behind: 3 km from it is 2 km along.
    const away = climbOutLine([{ type: "VD", courseDeg: 90, navaid: [-1000, 0], distanceM: 3000 }], [0, 0, 0], 0.06);
    expect(away.points[1][0]).toBeCloseTo(2000, 6);
    // Toward a navaid 5 km ahead: 1852 m from it comes first, at 3148 m along.
    const toward = climbOutLine([{ type: "VD", courseDeg: 90, navaid: [5000, 0], distanceM: 1852 }], [0, 0, 0], 0.06);
    expect(toward.points[1][0]).toBeCloseTo(3148, 6);
    expect(toward.skipped).toEqual([]);
  });

  it("follows a heading to a radial until it crosses that radial, and skips one it never reaches", () => {
    // The 360 radial of a navaid at (5000, -3000) is the line x = 5000 north of it.
    const crosses = climbOutLine([{ type: "VR", courseDeg: 90, navaid: [5000, -3000], radialDeg: 0 }], [0, 0, 0], 0.06);
    expect(crosses.points[1][0]).toBeCloseTo(5000, 6);
    expect(crosses.points[1][1]).toBeCloseTo(0, 6);
    // Its 180 radial runs south, away from the heading's path.
    const never = climbOutLine([{ type: "VR", courseDeg: 90, navaid: [5000, -3000], radialDeg: 180 }], [0, 0, 0], 0.06);
    expect(never.points).toHaveLength(1);
    expect(never.skipped).toEqual(["VR"]);
  });

  it("draws LAX's GMN7 off 24L: the heading to SMO's 169 radial, then vectors", () => {
    const lax = AIRPORTS.find((a) => a.code === "lax")!;
    const p = parseCifp(readFileSync(path.join(import.meta.dirname, "__fixtures__/cifp_sample.txt"), "utf8"), ["KLAX"]);
    const procs = localProcedures({ source: "FAA CIFP", cycle: p.cycle, effective: p.effective, ...p.airports.KLAX! }, lax);
    const gmn = procs.departures["24L"]!.find((d) => d.ident === "GMN7")!;
    const line = climbOutLine(gmn.legs, [-2000, -300, 0], 0.06);
    expect(line.skipped).toEqual([]);
    expect(line.vectors).toBe(true);
    // West off the coast: the radial, 169 true from Santa Monica, is crossed west of the field.
    expect(line.points[1][0]).toBeLessThan(-2000);
  });

  it("climbs at the gradient, levelling at an at-or-below altitude", () => {
    const line = climbOutLine(
      [
        { type: "DF", at: [0, 5000], altitudeM: { kind: "atOrBelow", m: 100 } },
        { type: "TF", at: [0, 10000] },
      ],
      [0, 0, 0],
      0.06,
    );
    expect(line.points[1][2]).toBeCloseTo(100, 6);
    expect(line.points[2][2]).toBeCloseTo(100 + 5000 * 0.06, 6);
  });
});

describe("procedurePath: the seam for other callers (the gate-to-gate journey)", () => {
  const procedures = localProcedures(JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/procedures/atl.json"), "utf8")) as ProcedureFile, atl);
  const SFO = { latitude: 37.619, longitude: -122.375 };

  it("gives a runway's approach as a line in the scene's frame and in longitude, latitude and height, with what to cite", () => {
    const p = procedurePath(procedures, "8L", "approach")!;
    expect(p).toMatchObject({ kind: "approach", name: "ILS RWY 8L", cycle: "2610" });
    expect(p.geo).toHaveLength(p.points.length);
    // The last point is the 8L threshold: N33 38 58.32, W084 26 20.49.
    const [lon, lat] = p.geo.at(-1)!;
    expect(lat).toBeCloseTo(33 + 38 / 60 + 58.32 / 3600, 5);
    expect(lon).toBeCloseTo(-(84 + 26 / 60 + 20.49 / 3600), 5);
  });

  it("gives a runway's likely climb-out toward a destination from where the aircraft lifts off, or the SID asked for", () => {
    const likely = procedurePath(procedures, "8R", "climb-out", { from: [0, 1245, 0], destination: SFO })!;
    expect(likely).toMatchObject({ kind: "climb-out", name: "CUTTN2", likely: true });
    expect(likely.points[0]).toEqual([0, 1245, 0]);
    expect(procedurePath(procedures, "8R", "climb-out", { from: [0, 1245, 0], sid: "BANNG3" })).toMatchObject({ name: "BANNG3", likely: false });
  });

  it("gives nothing it cannot honestly draw: an unknown runway, or a climb-out with no SID chosen", () => {
    expect(procedurePath(procedures, "99", "approach")).toBeNull();
    expect(procedurePath(procedures, "8R", "climb-out", { from: [0, 1245, 0] })).toBeNull();
  });
});
