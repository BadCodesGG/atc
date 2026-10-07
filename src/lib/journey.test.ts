import { describe, expect, it } from "vitest";
import { airportByCode } from "./airports";
import { CRUISE_DISTANCE_M, fogReach, FOLLOW_DISTANCE_M, journeyAngles, journeyDistance, journeyEnd, journeyProgress, journeyShot, nauticalMiles } from "./journey";

const ATL = airportByCode("atl")!;
const CLT = airportByCode("clt")!;

describe("nauticalMiles", () => {
  it("is the great-circle distance: ATL to CLT is 197 NM", () => {
    // The great-circle distance between the two reference points on a 6,371 km sphere: 196.85 NM.
    expect(nauticalMiles(ATL, CLT)).toBeCloseTo(196.85, 1);
  });
});

describe("journeyEnd", () => {
  const route = (code: string) => ({ origin: { code: "ATL", city: "Atlanta", country: "US" }, destination: { code, city: "x", country: "US" } });

  it("ends at the destination's gate when it is one of the airports built in 3D", () => {
    expect(journeyEnd(route("CLT"))).toEqual({ kind: "gate", destination: CLT });
  });

  it("ends on the map, saying why, with no route or a destination not built", () => {
    expect(journeyEnd(null)).toEqual({ kind: "map", code: null, line: "No route is known for this flight, so the journey ends on the map." });
    expect(journeyEnd(route("GSP"))).toEqual({ kind: "map", code: "GSP", line: "GSP is not one of the 32 airports in 3D, so the journey ends on the map." });
  });
});

describe("journeyProgress", () => {
  const now = Date.UTC(2026, 9, 1, 14, 0);

  it("measures what is flown from the origin and what is left to the destination, and estimates the arrival from the ground speed", () => {
    // About halfway (the mean of the two ends' coordinates), at 420 kt: some 98 NM left is 14 minutes.
    const p = journeyProgress(ATL, CLT, { latitude: (ATL.latitude + CLT.latitude) / 2, longitude: (ATL.longitude + CLT.longitude) / 2, groundSpeedKt: 420, onGround: false }, now);
    expect(p.flownNm + p.toGoNm!).toBeCloseTo(196.85, 0);
    expect(Math.abs(p.flownNm - p.toGoNm!)).toBeLessThan(1);
    expect(p.share).toBeCloseTo(0.5, 2);
    expect((p.arrival! - now) / 60_000).toBeCloseTo(14, 0);
  });

  it("makes no estimate on the ground or without a ground speed, and nothing past the origin without a destination", () => {
    expect(journeyProgress(ATL, CLT, { latitude: ATL.latitude, longitude: ATL.longitude, groundSpeedKt: 18, onGround: true }, now).arrival).toBeNull();
    expect(journeyProgress(ATL, CLT, { latitude: 34, longitude: -83, groundSpeedKt: null, onGround: false }, now).arrival).toBeNull();
    const lost = journeyProgress(ATL, null, { latitude: 34, longitude: -83, groundSpeedKt: 400, onGround: false }, now);
    expect(lost).toMatchObject({ toGoNm: null, share: null, arrival: null });
    expect(lost.flownNm).toBeGreaterThan(50);
  });
});

describe("journeyDistance", () => {
  const far = { altitudeFt: ATL.elevationFt, onGround: true, toOriginM: 0, toDestinationM: 360_000 };

  it("stays close while the flight is on the ground", () => {
    expect(journeyDistance({ ...far, originElevationFt: ATL.elevationFt })).toBe(FOLLOW_DISTANCE_M);
  });

  it("pulls back as it climbs, doubling every 1,500 ft, out to the cruise view", () => {
    const at = (agl: number) => journeyDistance({ altitudeFt: ATL.elevationFt + agl, onGround: false, toOriginM: 5_000, toDestinationM: 360_000, originElevationFt: ATL.elevationFt });
    expect(at(1500)).toBeCloseTo(2 * FOLLOW_DISTANCE_M, 6);
    expect(at(4500)).toBeCloseTo(8 * FOLLOW_DISTANCE_M, 6);
    expect(at(35_000)).toBe(CRUISE_DISTANCE_M);
  });

  it("closes in with the distance to the destination on the way down, whatever the height", () => {
    expect(journeyDistance({ altitudeFt: 3000, onGround: false, toOriginM: 356_000, toDestinationM: 8_000, originElevationFt: ATL.elevationFt })).toBeCloseTo(12_000, 6);
    expect(journeyDistance({ altitudeFt: 900, onGround: false, toOriginM: 363_000, toDestinationM: 200, originElevationFt: ATL.elevationFt })).toBe(FOLLOW_DISTANCE_M);
  });

  it("turns from the climb's rule to the approach's without a jump, halfway at cruise", () => {
    const at = (toOriginM: number) => journeyDistance({ altitudeFt: 29_000, onGround: false, toOriginM, toDestinationM: 364_000 - toOriginM, originElevationFt: ATL.elevationFt });
    expect(at(181_999)).toBeCloseTo(at(182_001), -1);
  });

  it("holds the climb's rule all the way without a destination", () => {
    expect(journeyDistance({ altitudeFt: ATL.elevationFt + 3000, onGround: false, toOriginM: 900_000, toDestinationM: null, originElevationFt: ATL.elevationFt })).toBeCloseTo(4 * FOLLOW_DISTANCE_M, 6);
  });
});

describe("journeyAngles", () => {
  it("leaves the reader's view alone on the ground", () => {
    expect(journeyAngles(FOLLOW_DISTANCE_M, false, 90)).toEqual({ azimuthDeg: null, elevationDeg: null });
  });

  it("in the air, looks the way the flight goes, lower close in and steeper out at cruise", () => {
    expect(journeyAngles(12_000, true, 63)).toEqual({ azimuthDeg: 63, elevationDeg: 28 });
    expect(journeyAngles(CRUISE_DISTANCE_M, true, 63)).toEqual({ azimuthDeg: 63, elevationDeg: 50 });
    // Halfway in scale between 12 and 150 km: halfway between the two tilts.
    expect(journeyAngles(Math.sqrt(12_000 * 150_000), true, 63).elevationDeg).toBeCloseTo(39, 6);
  });
});

describe("journeyShot", () => {
  const base = { headingDeg: 63, toOriginM: 8_000, toDestinationM: 356_000, bearingToOriginDeg: 250, bearingToDestinationDeg: 61, originElevationFt: ATL.elevationFt, destinationElevationFt: CLT.elevationFt };

  it("on the ground follows the aircraft close, the reader's view kept", () => {
    expect(journeyShot({ ...base, altitudeFt: 0, onGround: true, toOriginM: 1_500 })).toEqual({ distance: FOLLOW_DISTANCE_M, aim: 0, field: "origin", azimuthDeg: null, elevationDeg: null });
  });

  it("climbing out, looks back at the airport behind the aircraft: aimed near halfway to it, low, and far enough back to hold both", () => {
    const s = journeyShot({ ...base, altitudeFt: ATL.elevationFt + 3000, onGround: false });
    expect(s.aim).toBeCloseTo(0.45, 6);
    expect(s.field).toBe("origin");
    // 1.6 times the 8 km to the airport, past the climb's own 5.6 km.
    expect(s.distance).toBeCloseTo(12_800, 6);
    expect(s).toMatchObject({ azimuthDeg: 250, elevationDeg: 20 });
  });

  it("away from both ends, aims at the aircraft and looks the way it flies", () => {
    const s = journeyShot({ ...base, altitudeFt: 20_000, onGround: false, toOriginM: 90_000, toDestinationM: 274_000 });
    expect(s).toMatchObject({ aim: 0, azimuthDeg: 63 });
  });

  it("on the way down, looks toward the destination with it in view ahead, and closes on the aircraft for the touchdown", () => {
    const approach = journeyShot({ ...base, altitudeFt: 3000, onGround: false, toOriginM: 354_000, toDestinationM: 10_000, bearingToDestinationDeg: 8 });
    expect(approach).toMatchObject({ field: "destination", azimuthDeg: 8, elevationDeg: 20 });
    expect(approach.aim).toBeCloseTo(0.45, 6);
    expect(approach.distance).toBeCloseTo(16_000, 6);
    // 600 ft above the field the aim is mostly back on the aircraft: 0.45 of the way at 1,500 ft and above, eased to none at the ground.
    const short = journeyShot({ ...base, altitudeFt: CLT.elevationFt + 600, onGround: false, toOriginM: 362_000, toDestinationM: 2_000, bearingToDestinationDeg: 4 });
    expect(short.aim).toBeCloseTo(0.45 * 0.352, 3);
    expect(short.distance).toBeCloseTo(3_000, 6);
  });
});

describe("fogReach", () => {
  // From 12 km back, 20 degrees up, looking north at a point 5 km north of the field.
  const view = { azimuthDeg: 0, elevationDeg: 20, target: [0, 5_000] as [number, number], height: 0, distance: 12_000 };

  it("pushes the haze out past the field the camera frames, so it reads instead of fading into the page", () => {
    // The camera stands 11,276 m south of the point and 4,104 m up; the field 5 km beyond it is 16,800 m away,
    // and the theme's haze starts at 1.05 camera distances: the field needs it 1.2 * 16,800 / (1.05 * 12,000) = 1.6 times out.
    expect(fogReach(view, [0, 10_000])).toBeCloseTo(1.6, 2);
  });

  it("leaves the haze alone when the field is nearer than where it starts", () => {
    expect(fogReach(view, [0, 0])).toBe(1);
  });
});

describe("journeyShot on a phone", () => {
  it("keeps the aircraft near the middle, where a phone has room between its controls and its card", () => {
    const base = { headingDeg: 63, toOriginM: 8_000, toDestinationM: 356_000, bearingToOriginDeg: 250, bearingToDestinationDeg: 61, originElevationFt: ATL.elevationFt, destinationElevationFt: CLT.elevationFt, altitudeFt: ATL.elevationFt + 3000, onGround: false };
    expect(journeyShot({ ...base, compact: true }).aim).toBeCloseTo(0.45 * 0.25, 6);
    expect(journeyShot(base).aim).toBeCloseTo(0.45, 6);
  });
});
