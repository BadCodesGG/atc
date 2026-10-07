import { describe, expect, it } from "vitest";
import { EMERGENCY_SQUAWKS, parseSquawk, readSquawk } from "./squawk";

describe("readSquawk", () => {
  it("takes the three emergency codes and nothing else", () => {
    expect(EMERGENCY_SQUAWKS).toEqual(["7700", "7600", "7500"]);
    for (const code of EMERGENCY_SQUAWKS) expect(readSquawk(code)).toBe(code);
  });

  it("refuses every other string before a URL is built from it", () => {
    for (const bad of ["", "1200", "7701", "7700/", "7700 ", "07700", "77000", "../7700", "7700?x=1", "7_00", "%37700", "７７００", "7700\n"]) expect(readSquawk(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("parseSquawk", () => {
  const BODY = {
    now: 1_790_856_776_000,
    ac: [
      { hex: "a1b2c3", flight: "UAL12  ", t: "B738", lat: 40.1, lon: -80.2, alt_baro: 31000, gs: 440, track: 90, squawk: "7700" },
      { hex: "nothex", lat: 1, lon: 2, alt_baro: 100 },
      { hex: "d4e5f6", lat: 33.6, lon: -84.4, alt_baro: "ground", gs: 3 },
    ],
  };

  it("reads the aircraft squawking, in the feed's seconds, under the code asked about", () => {
    const parsed = parseSquawk(BODY, "7700");
    expect(parsed.code).toBe("7700");
    expect(parsed.time).toBe(1_790_856_776);
    expect(parsed.aircraft.map((a) => a.id)).toEqual(["a1b2c3", "nothex", "d4e5f6"]);
    expect(parsed.aircraft[0]).toMatchObject({ callsign: "UAL12", latitude: 40.1, longitude: -80.2, altitudeFt: 31000 });
    expect(parsed.aircraft[2]).toMatchObject({ onGround: true });
  });

  it("is an empty list, not a failure, when nobody squawks the code", () => {
    expect(parseSquawk({ now: 1_790_856_776_000, ac: [] }, "7600").aircraft).toEqual([]);
  });

  it("throws on a body that is not adsb.lol's, so an outage never reads as a quiet sky", () => {
    expect(() => parseSquawk(null, "7700")).toThrow();
    expect(() => parseSquawk({ ac: [] }, "7700")).toThrow();
    expect(() => parseSquawk({ now: 1 }, "7700")).toThrow();
  });
});
