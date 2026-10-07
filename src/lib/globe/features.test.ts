import { describe, expect, it } from "vitest";
import { airportByCode } from "../airports";
import { airportFeatures, procedureFeatures } from "./features";

describe("airportFeatures", () => {
  it("puts each airport at its reference point, with its count once one is known", () => {
    const [atl, pit] = airportFeatures([airportByCode("atl")!, airportByCode("pit")!], { atl: { total: 20, ground: 9 } }).features;
    expect(atl).toEqual({ type: "Feature", geometry: { type: "Point", coordinates: [-84.4281, 33.6367] }, properties: { code: "atl", name: "Hartsfield-Jackson Atlanta International", count: 20 } });
    expect(pit.properties).toEqual({ code: "pit", name: "Pittsburgh International" });
  });
});

describe("procedureFeatures", () => {
  const atl = airportByCode("atl")!;
  const approach = { state: "arriving" as const, legs: [{ kind: "air" as const, points: [[-30000, 0, 1500], [0, 0, 15]] as [number, number, number][] }, { kind: "runway" as const, points: [[0, 0, 0], [2000, 0, 0]] as [number, number, number][] }] };

  it("draws only the air legs, in pieces, ending on the field", () => {
    const { features } = procedureFeatures(approach, atl, { near: 8000, far: 24000 });
    expect(features.length).toBeGreaterThan(10);
    // The last piece ends at the reference point (local 0, 0), not on down the runway.
    const end = features.at(-1)!.geometry.coordinates.at(-1)!;
    expect(end[0]).toBeCloseTo(atl.longitude, 6);
    expect(end[1]).toBeCloseTo(atl.latitude, 6);
    expect(features.every((f) => f.properties.state === "arriving")).toBe(true);
  });

  it("fades the line out with distance from the field: whole within near, gone past far", () => {
    const { features } = procedureFeatures(approach, atl, { near: 8000, far: 24000 });
    expect(features.at(-1)!.properties.fade).toBe(1);
    expect(Math.min(...features.map((f) => f.properties.fade))).toBeGreaterThan(0);
    // Nothing is drawn wholly past `far`: 24 km of the 30 are left.
    const westmost = Math.min(...features.flatMap((f) => f.geometry.coordinates.map((c) => c[0])));
    expect(westmost).toBeGreaterThan(atl.longitude - 25_000 / (111_320 * Math.cos((atl.latitude * Math.PI) / 180)));
  });

  it("draws nothing for a path with no air leg, or no path", () => {
    expect(procedureFeatures({ state: "taxiing", legs: [{ kind: "taxi", points: [[0, 0, 0], [100, 0, 0]] }] }, atl, { near: 1, far: 2 }).features).toEqual([]);
    expect(procedureFeatures(null, atl, { near: 1, far: 2 }).features).toEqual([]);
  });
});

describe("procedureFeatures ownership", () => {
  const atl = airportByCode("atl")!;
  const approach = { state: "arriving" as const, legs: [{ kind: "air" as const, points: [[-10000, 0, 500], [0, 0, 15]] as [number, number, number][] }] };

  it("marks every piece as the selected flight's only when asked, so the map can draw it as that flight's path", () => {
    const near = { near: 8000, far: 24000 };
    expect(procedureFeatures(approach, atl, near).features.every((f) => f.properties.own === false)).toBe(true);
    expect(procedureFeatures(approach, atl, near, true).features.every((f) => f.properties.own === true)).toBe(true);
  });
});
