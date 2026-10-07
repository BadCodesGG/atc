import { describe, expect, it } from "vitest";
import type { Wind } from "./metar";
import { aheadOf, alongLine, arrivalRunway, departureRunway, journeyLines } from "./journey-procedure";
import type { LocalDeparture } from "./procedure-path";
import { procedures, RUNWAYS } from "./__fixtures__/synthetic-field";

const wind = (directionDeg: number | null, speedKt: number): Wind => ({ directionDeg, speedKt, gustKt: null, variable: directionDeg === null, range: null });

describe("arrivalRunway", () => {
  it("lands into the reported wind: a wind from the west is runway 27", () => {
    expect(arrivalRunway({ runways: RUNWAYS, wind: wind(270, 12), bearingDeg: 90 })).toBe("27");
  });

  it("takes the end with the most headwind when the wind is off the runway", () => {
    // From 200 degrees: 18 has a 20 degree headwind angle, 27 a 70 degree one.
    expect(arrivalRunway({ runways: RUNWAYS, wind: wind(200, 12), bearingDeg: 90 })).toBe("18");
  });

  it("falls back to the end best aligned with the inbound bearing with no report", () => {
    // Heading 100 degrees toward the field: 09 (heading 090) is 10 degrees off, 18 (180) is 80.
    expect(arrivalRunway({ runways: RUNWAYS, wind: null, bearingDeg: 100 })).toBe("9");
    expect(arrivalRunway({ runways: RUNWAYS, wind: null, bearingDeg: 355 })).toBe("36");
  });

  it("does not let a calm, variable or light wind decide", () => {
    expect(arrivalRunway({ runways: RUNWAYS, wind: wind(270, 3), bearingDeg: 100 })).toBe("9");
    expect(arrivalRunway({ runways: RUNWAYS, wind: wind(null, 8), bearingDeg: 100 })).toBe("9");
    expect(arrivalRunway({ runways: RUNWAYS, wind: wind(270, 0), bearingDeg: 100 })).toBe("9");
  });

  it("holds the runway it had while the inbound bearing still lines up with it within 60 degrees", () => {
    // 50 degrees: 09 is 40 off, 36 is 50 off; it was on 36.
    expect(arrivalRunway({ runways: RUNWAYS, wind: null, bearingDeg: 50, held: "36" })).toBe("36");
    expect(arrivalRunway({ runways: RUNWAYS, wind: null, bearingDeg: 50 })).toBe("9");
    // 100 degrees: 36 is 100 off, so it lets go.
    expect(arrivalRunway({ runways: RUNWAYS, wind: null, bearingDeg: 100, held: "36" })).toBe("9");
  });

  it("has none when the map has no runway", () => {
    expect(arrivalRunway({ runways: [], wind: wind(270, 12), bearingDeg: 90 })).toBeNull();
  });
});

describe("departureRunway", () => {
  const departures: Record<string, LocalDeparture[]> = { "9": [{ ident: "ZOOM2", legs: [] }], "27": [{ ident: "ZOOM3", legs: [] }], "18": [] };
  const sids = procedures([], departures);

  it("is the end whose centreline the aircraft lifted off from, heading along it", () => {
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: 400, y: 12, headingDeg: 92 } })).toBe("9");
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: -400, y: -9, headingDeg: 268 } })).toBe("27");
  });

  it("is none for an aircraft first seen far down the line, which is not a take-off", () => {
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: 30_000, y: 4, headingDeg: 90 } })).toBeNull();
  });

  it("is none when the track does not follow a runway, or the aircraft was off its centreline", () => {
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: 400, y: 12, headingDeg: 140 } })).toBeNull();
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: 400, y: 4000, headingDeg: 92 } })).toBeNull();
  });

  it("is none for a runway with no SIDs, and for one the aircraft has not passed the start of", () => {
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: 12, y: 300, headingDeg: 180 } })).toBeNull();
    expect(departureRunway({ runways: RUNWAYS, procedures: sids, liftOff: { x: -3000, y: 5, headingDeg: 90 } })).toBeNull();
  });
});

describe("aheadOf", () => {
  const line: [number, number, number][] = [
    [0, 0, 100],
    [10_000, 0, 200],
    [20_000, 0, 300],
  ];

  it("starts at the next point ahead of an aircraft abeam the line", () => {
    expect(aheadOf(line, 5000, 800, "from-start")).toBe(1);
    expect(aheadOf(line, 15_000, -800, "drop")).toBe(2);
  });

  it("is all of the line before its start", () => {
    expect(aheadOf(line, -2000, 0, "drop")).toBe(0);
  });

  it("is none once the aircraft is past the end", () => {
    expect(aheadOf(line, 21_000, 0, "drop")).toBe(3);
    expect(aheadOf(line, 21_000, 0, "from-start")).toBe(3);
  });

  it("treats an aircraft far off the line as not on it: joining at the start, or dropped", () => {
    expect(aheadOf(line, 5000, 40_000, "from-start")).toBe(0);
    expect(aheadOf(line, 5000, 40_000, "drop")).toBe(3);
    // Far out beyond the end is not "past the end" of an approach it has yet to join.
    expect(aheadOf(line, 90_000, 0, "from-start")).toBe(0);
  });
});

describe("alongLine", () => {
  const line: [number, number, number][] = [
    [0, 0, 100],
    [10_000, 0, 200],
    [20_000, 0, 300],
  ];

  it("is true for an aircraft abeam the line within a couple of kilometres, either side", () => {
    expect(alongLine(line, 5000, 800)).toBe(true);
    expect(alongLine(line, 15_000, -1800)).toBe(true);
  });

  it("is false for an aircraft farther off it, before its start by more than that, or past its end by more", () => {
    expect(alongLine(line, 5000, 2600)).toBe(false);
    expect(alongLine(line, -5000, 0)).toBe(false);
    expect(alongLine(line, 26_000, 0)).toBe(false);
  });
});

describe("journeyLines", () => {
  const aircraft: [number, number] = [-82, 34];
  const destination: [number, number] = [-80.9, 35.2];
  const fix = (lon: number, lat: number): [number, number] => [lon, lat];

  it("is the straight estimate to the field as before when nothing is published", () => {
    expect(journeyLines(aircraft, destination, [], [])).toEqual({ left: [aircraft, destination], climbOut: [], approach: [] });
  });

  it("estimates to the approach's first point and then follows the approach to the threshold", () => {
    const approach = [fix(-81.4, 35.1), fix(-81.1, 35.18), fix(-80.95, 35.21)];
    const lines = journeyLines(aircraft, destination, [], approach);
    expect(lines.left[0]).toEqual(aircraft);
    expect(lines.left.at(-1)).toEqual(approach[0]);
    expect(lines.left.length).toBeGreaterThan(2);
    expect(lines.approach).toEqual(approach);
    expect(lines.climbOut).toEqual([]);
  });

  it("runs the climb-out from the aircraft, and estimates on from where it ends", () => {
    const sid = [fix(-82, 34.2), fix(-82.1, 34.5)];
    const approach = [fix(-81.4, 35.1), fix(-80.95, 35.21)];
    const lines = journeyLines(aircraft, destination, sid, approach);
    expect(lines.climbOut).toEqual([aircraft, ...sid]);
    expect(lines.left[0]).toEqual(sid[1]);
    expect(lines.left.at(-1)).toEqual(approach[0]);
  });

  it("estimates from the climb-out's end straight to the field when the destination has no approach", () => {
    const sid = [fix(-82, 34.2)];
    expect(journeyLines(aircraft, destination, sid, [])).toEqual({ left: [sid[0], destination], climbOut: [aircraft, ...sid], approach: [] });
  });

  it("runs the approach on from the aircraft, with no estimate beside it, when the aircraft is on the approach, however far off its next point is", () => {
    // Its next point is 7 km ahead, past the 3 km under which an estimate is not drawn: it still joins at the aircraft rather than estimating a line beside the approach.
    const approach = [fix(-80.95, 35.21)];
    const lines = journeyLines(fix(-80.9, 35.15), destination, [], approach, true);
    expect(lines.left).toEqual([]);
    expect(lines.approach).toEqual([fix(-80.9, 35.15), ...approach]);
    expect(lines.climbOut).toEqual([]);
  });

  it("still estimates up to the approach when the aircraft is not on it", () => {
    const approach = [fix(-80.95, 35.21)];
    const lines = journeyLines(fix(-80.9, 35.15), destination, [], approach, false);
    expect(lines.left[0]).toEqual(fix(-80.9, 35.15));
    expect(lines.left.at(-1)).toEqual(approach[0]);
    expect(lines.approach).toEqual(approach);
  });

  it("joins the approach at the aircraft itself, with no estimate, once it is on it", () => {
    const approach = [fix(-81.001, 35.1), fix(-80.95, 35.21)];
    const lines = journeyLines(fix(-81, 35.1), destination, [], approach);
    expect(lines.left).toEqual([]);
    expect(lines.approach).toEqual([fix(-81, 35.1), ...approach]);
  });
});
