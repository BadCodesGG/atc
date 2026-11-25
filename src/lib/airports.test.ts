import { describe, expect, it } from "vitest";
import { loadAirportMap } from "./airport-data";
import { AIRPORTS, airportByCode, zoneAbbreviation } from "./airports";
import { loadProcedures } from "./procedure-data";

describe("zoneAbbreviation", () => {
  it("names the airport's zone as it reads at that moment, daylight time included", () => {
    expect(zoneAbbreviation(Date.UTC(2026, 6, 1, 12), "America/New_York")).toBe("EDT");
    expect(zoneAbbreviation(Date.UTC(2026, 0, 15, 12), "America/New_York")).toBe("EST");
    // Arizona keeps standard time all year.
    expect(zoneAbbreviation(Date.UTC(2026, 6, 1, 12), "America/Phoenix")).toBe("MST");
    expect(zoneAbbreviation(Date.UTC(2026, 6, 1, 12), "Pacific/Honolulu")).toBe("HST");
  });
});

describe("the airport list", () => {
  it("lists each airport once, by a code no other airport had before", () => {
    const codes = AIRPORTS.flatMap((a) => [a.code, ...(a.formerly ? [a.formerly.code] : [])]);
    const icaos = AIRPORTS.flatMap((a) => [a.icao, ...(a.formerly ? [a.formerly.icao] : [])]);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(icaos).size).toBe(icaos.length);
  });

  it("finds an airport by its code, or by the code it had before a rename", () => {
    expect(airportByCode("djt")?.icao).toBe("KDJT");
    // Palm Beach International became President Donald J. Trump International; adsbdb still names it PBI.
    expect(airportByCode("pbi")?.code).toBe("djt");
    expect(airportByCode("xyz")).toBeUndefined();
  });

  it("has a ground plan and a procedures file for every airport", async () => {
    for (const airport of AIRPORTS) {
      expect((await loadAirportMap(airport.code)).code, airport.code).toBe(airport.code);
      expect((await loadProcedures(airport)).cycle, airport.code).toMatch(/^\d{4}$/);
    }
  });
});
