import { describe, expect, it } from "vitest";
import { toGeo, toLocal } from "./geo";

const ATL = { latitude: 33.6367, longitude: -84.4281 };

describe("geo", () => {
  it("puts one minute of latitude about a nautical mile north", () => {
    const [x, y] = toLocal(ATL, ATL.latitude + 1 / 60, ATL.longitude);
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(y).toBeCloseTo(1853, -1);
  });

  it("round-trips points across the field", () => {
    for (const [lat, lon] of [[33.65, -84.45], [33.62, -84.40], [33.8, -84.1]]) {
      const [x, y] = toLocal(ATL, lat, lon);
      const [la, lo] = toGeo(ATL, x, y);
      expect(la).toBeCloseTo(lat, 9);
      expect(lo).toBeCloseTo(lon, 9);
    }
  });
});
