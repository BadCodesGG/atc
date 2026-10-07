import { describe, expect, it } from "vitest";
import atl from "./__fixtures__/metar_atl.json";
import cle from "./__fixtures__/metar_cle.json";
import { AIRPORTS } from "./airports";
import { describeWeather, describeWind, fetchMetar, formatVisibility, metarUrl, parseMetar, parseMetarResponse } from "./metar";

/** The reference moment the synthetic reports are read against: 1 October 2026, 12:00 UTC. */
const NOW = Date.UTC(2026, 9, 1, 12, 0);

describe("parseMetarResponse", () => {
  it("reads a real KATL report from aviationweather.gov (recorded 2026-10-01 03:13 UTC)", () => {
    const m = parseMetarResponse(atl, "KATL");
    expect(m.station).toBe("KATL");
    expect(m.raw).toBe("METAR KATL 010252Z 10003KT 10SM FEW250 23/14 A3011 RMK AO2 SLP186 T02330144 51011");
    expect(m.timeMs).toBe(Date.UTC(2026, 9, 1, 2, 52));
    expect(m.wind).toEqual({ directionDeg: 100, speedKt: 3, gustKt: null, variable: false, range: null });
    expect(m.visibilityM).toBeCloseTo(16_093, -1);
    expect(m.ceilingFt).toBeNull();
    expect(m.cover).toBe("few");
    expect(m.precipitation).toBeNull();
    expect(m).toMatchObject({ fog: false, mist: false, haze: false, thunder: false, temperatureC: 23, dewpointC: 14 });
  });

  it("reads a real KCLE report in light rain under an overcast, and ignores the remarks", () => {
    const m = parseMetarResponse(cle, "KCLE");
    expect(m.precipitation).toEqual({ kind: "rain", intensity: "light" });
    expect(m.ceilingFt).toBe(10_000);
    expect(m.cover).toBe("overcast");
    expect(m.weather).toEqual(["-RA"]);
    expect(m.wind).toMatchObject({ directionDeg: 170, speedKt: 6 });
  });

  it("refuses an empty answer, another station's report, or something that is not a report", () => {
    expect(() => parseMetarResponse([], "KATL")).toThrow();
    expect(() => parseMetarResponse(cle, "KATL")).toThrow();
    expect(() => parseMetarResponse({ error: "x" }, "KATL")).toThrow();
    expect(() => parseMetarResponse([{ icaoId: "KATL" }], "KATL")).toThrow();
  });
});

describe("parseMetar", () => {
  it("reads dense fog: quarter-mile visibility and a 200 ft vertical visibility as the ceiling", () => {
    const m = parseMetar("KATL 011153Z 00000KT 1/4SM FG VV002 14/14 A3001", NOW);
    expect(m.wind).toEqual({ directionDeg: null, speedKt: 0, gustKt: null, variable: false, range: null });
    expect(m.visibilityM).toBeCloseTo(402, 0);
    expect(m.fog).toBe(true);
    expect(m.ceilingFt).toBe(200);
    expect(m.cover).toBe("obscured");
  });

  it("reads a thunderstorm with heavy rain and mist, the lowest broken layer as the ceiling", () => {
    const m = parseMetar("SPECI KATL 012147Z 27015G28KT 240V300 1 1/2SM +TSRA BR SCT008 BKN015CB OVC030 22/21 A2990 RMK AO2 TSB40", NOW);
    expect(m.wind).toEqual({ directionDeg: 270, speedKt: 15, gustKt: 28, variable: false, range: [240, 300] });
    expect(m.visibilityM).toBeCloseTo(2414, 0);
    expect(m.precipitation).toEqual({ kind: "rain", intensity: "heavy" });
    expect(m.thunder).toBe(true);
    expect(m.mist).toBe(true);
    expect(m.ceilingFt).toBe(1500);
    expect(m.cover).toBe("overcast");
  });

  it("reads light snow with a light variable wind and freezing temperatures", () => {
    const m = parseMetar("KPIT 011151Z VRB03KT 3/4SM -SN BR OVC007 M02/M04 A2985", NOW);
    expect(m.wind).toEqual({ directionDeg: null, speedKt: 3, gustKt: null, variable: true, range: null });
    expect(m.precipitation).toEqual({ kind: "snow", intensity: "light" });
    expect(m.temperatureC).toBe(-2);
    expect(m.dewpointC).toBe(-4);
  });

  it("reads drizzle as light rain, haze, and P6SM and M1/4SM visibilities", () => {
    expect(parseMetar("KJFK 011151Z 05008KT P6SM DZ HZ BKN020 18/16 A3002", NOW)).toMatchObject({ precipitation: { kind: "rain", intensity: "light" }, haze: true, visibilityM: 9656 });
    expect(parseMetar("KJFK 011151Z 05008KT M1/4SM FZFG VV001 M01/M01 A3002", NOW)).toMatchObject({ fog: true, visibilityM: 201 });
  });

  it("ignores weather only in the vicinity: a shower nearby is not rain at the field", () => {
    const m = parseMetar("KATL 011153Z 18005KT 10SM VCSH VCTS SCT050 25/18 A3001", NOW);
    expect(m.precipitation).toBeNull();
    expect(m.thunder).toBe(false);
    expect(m.weather).toEqual(["VCSH", "VCTS"]);
  });

  it("reads an international report: metres, CAVOK, and a wind in metres per second", () => {
    const egll = parseMetar("EGLL 011150Z 24012KT 9999 FEW030 15/09 Q1012 NOSIG", NOW);
    expect(egll.visibilityM).toBe(10_000);
    expect(egll.ceilingFt).toBeNull();
    const cavok = parseMetar("LFPG 011200Z 05006MPS CAVOK 18/08 Q1020", NOW);
    expect(cavok.visibilityM).toBe(10_000);
    expect(cavok.cover).toBe("clear");
    expect(cavok.wind?.speedKt).toBe(12);
    expect(parseMetar("EDDF 011150Z 22005KT 0350 FG VV001 08/08 Q1018", NOW).visibilityM).toBe(350);
  });

  it("dates a report from the day before the reference moment into the right month", () => {
    // A report from the 30th read on the 1st of the next month.
    expect(parseMetar("KATL 302352Z 10003KT 10SM CLR 20/12 A3011", NOW).timeMs).toBe(Date.UTC(2026, 8, 30, 23, 52));
  });
});

describe("describing a report", () => {
  it("words the wind as the readout shows it", () => {
    expect(describeWind({ directionDeg: 100, speedKt: 3, gustKt: null, variable: false, range: null })).toBe("100° 3 kt");
    expect(describeWind({ directionDeg: 270, speedKt: 15, gustKt: 28, variable: false, range: [240, 300] })).toBe("270° 15 kt, gusts 28");
    expect(describeWind({ directionDeg: 5, speedKt: 9, gustKt: null, variable: false, range: null })).toBe("005° 9 kt");
    expect(describeWind({ directionDeg: null, speedKt: 3, gustKt: null, variable: true, range: null })).toBe("Variable 3 kt");
    expect(describeWind({ directionDeg: null, speedKt: 0, gustKt: null, variable: false, range: null })).toBe("Calm");
  });

  it("words it shorter for a phone: no gusts, VRB for variable", () => {
    expect(describeWind({ directionDeg: 270, speedKt: 15, gustKt: 28, variable: false, range: [240, 300] }, { short: true })).toBe("270° 15 kt");
    expect(describeWind({ directionDeg: null, speedKt: 3, gustKt: 12, variable: true, range: null }, { short: true })).toBe("VRB 3 kt");
    expect(describeWind({ directionDeg: null, speedKt: 0, gustKt: null, variable: false, range: null }, { short: true })).toBe("Calm");
  });

  it("gives visibility in statute miles, as US reports do", () => {
    expect(formatVisibility(16_093)).toBe("10 SM");
    expect(formatVisibility(9656)).toBe("6 SM");
    expect(formatVisibility(2414)).toBe("1 1/2 SM");
    expect(formatVisibility(402)).toBe("1/4 SM");
    expect(formatVisibility(201)).toBe("< 1/4 SM");
  });

  it("names the weather that matters to the picture, most important first", () => {
    const storm = parseMetar("KATL 012147Z 27015G28KT 1 1/2SM +TSRA BR BKN015 22/21 A2990", NOW);
    expect(describeWeather(storm)).toBe("Thunderstorm, heavy rain");
    expect(describeWeather(parseMetar("KATL 011153Z 00000KT 1/4SM FG VV002 14/14 A3001", NOW))).toBe("Fog");
    expect(describeWeather(parseMetar("KPIT 011151Z VRB03KT 3/4SM -SN BR OVC007 M02/M04 A2985", NOW))).toBe("Light snow, mist");
    expect(describeWeather(parseMetarResponse(atl, "KATL"))).toBeNull();
  });
});

describe("fetchMetar", () => {
  it("asks aviationweather.gov for the airport's ICAO code only", async () => {
    const asked: string[] = [];
    const m = await fetchMetar(AIRPORTS[0], async (url) => {
      asked.push(url);
      return atl;
    });
    expect(asked).toEqual([metarUrl("KATL")]);
    expect(asked[0]).toBe("https://aviationweather.gov/api/data/metar?ids=KATL&format=json");
    expect(m.station).toBe("KATL");
  });
});
