import { describe, expect, it } from "vitest";
import type { JourneyStatus } from "./journey-follow";
import { journeyView } from "./journey-view";

const cruise: JourneyStatus = {
  stage: "map",
  hex: "a4c2e7",
  callsign: "DAL1947",
  from: "ATL",
  to: "CLT",
  // 14:51 in Charlotte (EDT, UTC-4) on 30 September.
  progress: { flownNm: 112.4, toGoNm: 84.6, share: 0.5706, arrival: Date.UTC(2026, 8, 30, 18, 51, 20) },
  timeZone: "America/New_York",
  endLine: null,
  procedures: [],
  estimated: false,
  arrival: null,
  fix: { latitude: 34.6, longitude: -82.4, altitudeFt: 29_000, onGround: false, groundSpeedKt: 439.6, headingDeg: 63, verticalRateFpm: 0, callsign: "DAL1947", typeCode: "A321" },
};

describe("journeyView", () => {
  it("reads the journey as the panel prints it: the way flown and left, the arrival estimated in the destination's time", () => {
    expect(journeyView(cruise)).toEqual({
      callsign: "DAL1947",
      operator: "Delta · Airbus A321",
      from: "ATL",
      to: "CLT",
      share: 0.5706,
      flown: "112 NM",
      toGo: "85 NM",
      arrival: "14:51",
      phase: "Cruising",
      speed: "440 kt",
      altitude: "FL290",
      endLine: null,
      procedures: [],
      estimated: false,
    });
  });

  it("says when the map draws a dashed estimate of the way left", () => {
    expect(journeyView({ ...cruise, estimated: true })!.estimated).toBe(true);
  });

  it("carries the procedures drawn on the map, and a journey whose route names no origin shows none", () => {
    const view = journeyView({ ...cruise, from: null, procedures: ["Likely approach: ILS RWY 1L, from FAA CIFP cycle 2610"] })!;
    expect(view.procedures).toEqual(["Likely approach: ILS RWY 1L, from FAA CIFP cycle 2610"]);
    expect(view.from).toBeNull();
  });

  it("names the phase from what the aircraft is doing, and the height in feet below the flight levels", () => {
    const at = (altitudeFt: number, verticalRateFpm: number, onGround = false, groundSpeedKt = 250) => journeyView({ ...cruise, fix: { ...cruise.fix!, altitudeFt, verticalRateFpm, onGround, groundSpeedKt } })!;
    expect(at(12_340, 2_400)).toMatchObject({ phase: "Climbing", altitude: "12,300 ft" });
    expect(at(6_000, -1_200)).toMatchObject({ phase: "Descending", altitude: "6,000 ft" });
    expect(at(0, 0, true, 16)).toMatchObject({ phase: "Taxiing", altitude: "Ground" });
    expect(at(0, 0, true, 0)).toMatchObject({ phase: "At gate" });
  });

  it("says where it will end when that is not a gate, and estimates nothing it cannot", () => {
    const lost = journeyView({ ...cruise, to: null, timeZone: null, endLine: "No route is known for this flight, so the journey ends on the map.", progress: { flownNm: 40, toGoNm: null, share: null, arrival: null } })!;
    expect(lost).toMatchObject({ to: null, share: null, toGo: null, arrival: null, endLine: "No route is known for this flight, so the journey ends on the map." });
  });

  it("says where the journey ended, at the gate it was read parked at or the one it went quiet by, and shows the flight at the gate either way", () => {
    const taxiing = { ...cruise.fix!, altitudeFt: 0, onGround: true, verticalRateFpm: 0 };
    const arrived = (arrival: JourneyStatus["arrival"], groundSpeedKt: number) => journeyView({ ...cruise, stage: "arrived", arrival, to: "CLT", fix: { ...taxiing, groundSpeedKt } })!;
    expect(arrived({ place: { kind: "gate", ref: "B12" }, quiet: false }, 0)).toMatchObject({ phase: "At gate", endLine: "Arrived at gate B12." });
    expect(arrived({ place: { kind: "stand", ref: "7" }, quiet: false }, 0).endLine).toBe("Arrived at stand 7.");
    expect(arrived({ place: null, quiet: false }, 0)).toMatchObject({ phase: "Arrived", endLine: "Arrived." });
    expect(arrived({ place: { kind: "stand", ref: "7" }, quiet: false }, 0).phase).toBe("At stand");
    expect(arrived({ place: { kind: "gate", ref: "B12" }, quiet: true }, 0)).toMatchObject({ phase: "At gate", endLine: "Arrived at gate B12. Its transponder went quiet there." });
    expect(arrived({ place: null, quiet: true }, 0)).toMatchObject({ phase: "Arrived", endLine: "Arrived. Its transponder went quiet on the ground." });
    // Still said at the gate when the last speed heard was a taxi's.
    expect(arrived({ place: { kind: "gate", ref: "B12" }, quiet: true }, 4).phase).toBe("At gate");
    // Arrived is the whole way: no distance left to the airport's reference point, no estimate, a full bar.
    expect(arrived({ place: { kind: "gate", ref: "B12" }, quiet: true }, 0)).toMatchObject({ toGo: null, arrival: null, share: 1, flown: "112 NM" });
  });

  it("drops the distance left and the estimate once the flight is down at its destination, before it has arrived", () => {
    const rolling = { ...cruise.fix!, altitudeFt: 0, onGround: true, verticalRateFpm: 0, groundSpeedKt: 13 };
    expect(journeyView({ ...cruise, stage: "destination", fix: rolling })).toMatchObject({ phase: "Taxiing", toGo: null, arrival: null, share: 1 });
    // Still in the air on final, it keeps them.
    expect(journeyView({ ...cruise, stage: "destination" })).toMatchObject({ toGo: "85 NM", share: 0.5706 });
  });

  it("has nothing to show before the aircraft is first read", () => {
    expect(journeyView({ ...cruise, fix: null, progress: null })).toBeNull();
  });
});
