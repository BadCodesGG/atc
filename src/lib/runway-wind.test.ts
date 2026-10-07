import { describe, expect, it } from "vitest";
import atl from "@/data/airports/atl.json";
import type { AirportMap, Runway } from "./airport-map";
import { favouredRunwayEnds } from "./runway-wind";
import type { Wind } from "./metar";

const wind = (directionDeg: number | null, speedKt: number): Wind => ({ directionDeg, speedKt, gustKt: null, variable: directionDeg === null && speedKt > 0, range: null });

/** A north-south runway 3 km long: 36 is the south end (you take off from it heading north), 18 the north. */
const NORTH_SOUTH: Runway = { ref: "18/36", width: 45, surface: null, centerline: [], ends: [{ ref: "36", x: 0, y: 0 }, { ref: "18", x: 0, y: 3000 }] };

describe("favouredRunwayEnds", () => {
  it("favours the end that takes off into the wind, with its headwind and crosswind", () => {
    expect(favouredRunwayEnds([NORTH_SOUTH], wind(360, 10))).toEqual([{ runway: "18/36", end: "36", headingDeg: 0, headwindKt: 10, crosswindKt: 0 }]);
    const [south] = favouredRunwayEnds([NORTH_SOUTH], wind(150, 20));
    expect(south).toMatchObject({ end: "18", headingDeg: 180 });
    // 30 degrees off the nose: cos 30 and sin 30 of 20 knots.
    expect(south.headwindKt).toBeCloseTo(17.3, 1);
    expect(south.crosswindKt).toBeCloseTo(10, 1);
  });

  it("favours nothing in a calm or a variable wind, or straight across the runway", () => {
    expect(favouredRunwayEnds([NORTH_SOUTH], wind(null, 0))).toEqual([]);
    expect(favouredRunwayEnds([NORTH_SOUTH], wind(null, 4))).toEqual([]);
    expect(favouredRunwayEnds([NORTH_SOUTH], wind(90, 12))).toEqual([]);
  });

  it("turns ATL's five parallel runways west in a west wind and east in an east wind", () => {
    const runways = (atl as unknown as AirportMap).runways;
    expect(favouredRunwayEnds(runways, wind(270, 12)).map((e) => e.end).sort()).toEqual(["26L", "26R", "27L", "27R", "28"]);
    expect(favouredRunwayEnds(runways, wind(100, 3)).map((e) => e.end).sort()).toEqual(["08L", "08R", "09L", "09R", "10"]);
  });

  it("skips a runway whose two ends are not both mapped", () => {
    expect(favouredRunwayEnds([{ ...NORTH_SOUTH, ends: [NORTH_SOUTH.ends[0]] }], wind(360, 10))).toEqual([]);
  });
});
