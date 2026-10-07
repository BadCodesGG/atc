import { describe, expect, it } from "vitest";
import { localTimeAt, sunPosition } from "./sun";

const ATL = { latitude: 33.6367, longitude: -84.4281 };
const GREENWICH = { latitude: 51.4769, longitude: -0.0005 };

describe("sunPosition", () => {
  it("puts the sun due south and 53 degrees up at Atlanta's solar noon on 30 September", () => {
    // Solar noon there is 13:27 EDT: 84.43 degrees west, less the equation of time (+10 min).
    const sun = sunPosition(Date.UTC(2026, 8, 30, 17, 27), ATL.latitude, ATL.longitude);
    // 90 - 33.64 latitude - 2.9 declination.
    expect(sun.elevationDeg).toBeCloseTo(53.4, 0);
    expect(Math.abs(sun.azimuthDeg - 180)).toBeLessThan(1.5);
  });

  it("gives Greenwich's midsummer noon elevation, 90 - 51.48 + 23.44", () => {
    const sun = sunPosition(Date.UTC(2026, 5, 21, 12, 2), GREENWICH.latitude, GREENWICH.longitude);
    expect(sun.elevationDeg).toBeCloseTo(61.96, 0);
  });

  it("has the sun on the horizon a little south of east at an Atlanta sunrise (07:31 EDT, from solar noon less the half-day arc)", () => {
    const sun = sunPosition(Date.UTC(2026, 8, 30, 11, 31), ATL.latitude, ATL.longitude);
    expect(Math.abs(sun.elevationDeg)).toBeLessThan(1);
    expect(sun.azimuthDeg).toBeGreaterThan(91);
    expect(sun.azimuthDeg).toBeLessThan(96);
  });

  it("has the sun in the west in the evening and well below the horizon at midnight", () => {
    const evening = sunPosition(Date.UTC(2026, 8, 30, 22, 30), ATL.latitude, ATL.longitude);
    expect(evening.azimuthDeg).toBeGreaterThan(240);
    expect(evening.azimuthDeg).toBeLessThan(275);
    expect(evening.elevationDeg).toBeGreaterThan(5);
    expect(evening.elevationDeg).toBeLessThan(15);
    const midnight = sunPosition(Date.UTC(2026, 9, 1, 4, 0), ATL.latitude, ATL.longitude);
    expect(midnight.elevationDeg).toBeLessThan(-40);
  });
});

describe("localTimeAt", () => {
  it("reads a wall-clock time in the airport's zone on the same local day, daylight saving included", () => {
    // 14:49 EDT on 30 September; 08:30 that morning in New York is 12:30 UTC.
    const drawn = Date.UTC(2026, 8, 30, 18, 49);
    expect(localTimeAt(drawn, "08:30", "America/New_York")).toBe(Date.UTC(2026, 8, 30, 12, 30));
    // In January New York is on EST, five hours behind.
    expect(localTimeAt(Date.UTC(2026, 0, 15, 18, 0), "08:30", "America/New_York")).toBe(Date.UTC(2026, 0, 15, 13, 30));
  });

  it("keeps the local date when the drawn moment is already the next day in UTC", () => {
    // 22:00 EDT on 30 September is 02:00 UTC on 1 October.
    expect(localTimeAt(Date.UTC(2026, 9, 1, 2, 0), "18:30", "America/New_York")).toBe(Date.UTC(2026, 8, 30, 22, 30));
  });

  it("returns null for anything that is not a time of day", () => {
    expect(localTimeAt(0, "25:00", "America/New_York")).toBeNull();
    expect(localTimeAt(0, "noon", "America/New_York")).toBeNull();
  });
});
