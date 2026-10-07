import { describe, expect, it } from "vitest";
import regionFixture from "./__fixtures__/adsblol_region_atl.json";
import { airportByCode } from "./airports";
import { readViaLol } from "./__fixtures__/lol-read";
import { cellOf, cellsCovering, countsNear, fetchRegion, parseRegion, readCell, REGION_RADIUS_NM, regionPath, regionQuery } from "./region";
import { providerUrl } from "./upstream";

const ATL = airportByCode("atl")!;
const NOW = 1_790_794_144_001;
const ATL_CELL = { latitude: 32, longitude: -84 };

function response(...ac: Record<string, unknown>[]) {
  return { now: NOW, ac: ac.map((a) => ({ hex: "abc123", lat: 33.64, lon: -84.43, alt_baro: 35000, gs: 450, track: 90, seen_pos: 1, ...a })) };
}

const query = (q: string) => readCell(new URLSearchParams(q));

describe("readCell", () => {
  it("snaps a position to its grid cell, so nearby callers share one", () => {
    expect(query("lat=33.6367&lon=-84.4281")).toEqual(ATL_CELL);
    expect(query("lat=33.9&lon=-85.7")).toEqual(ATL_CELL);
    expect(query("lat=-33.9&lon=151.2")).toEqual({ latitude: -32, longitude: 152 });
  });

  it("calls the antimeridian one cell, not two", () => {
    expect(query("lat=0&lon=179.5")).toEqual({ latitude: 0, longitude: -180 });
    expect(query("lat=0&lon=-180")).toEqual({ latitude: 0, longitude: -180 });
  });

  it("refuses anything that is not a plain decimal number in range", () => {
    for (const q of [
      "",
      "lat=33.6",
      "lon=-84.4",
      "lat=&lon=-84.4",
      "lat= &lon=-84.4",
      "lat=0x10&lon=1",
      "lat=1e2&lon=1",
      "lat=Infinity&lon=1",
      "lat=NaN&lon=1",
      "lat=90.5&lon=1",
      "lat=-91&lon=1",
      "lat=10&lon=180.01",
      "lat=10&lon=-200",
      "lat=10&lon=12abc",
      "lat=1.2.3&lon=4",
    ]) {
      expect(query(q), q).toBeNull();
    }
  });

  it("accepts the edges of the range", () => {
    expect(query("lat=90&lon=180")).toEqual({ latitude: 88, longitude: -180 });
    expect(query("lat=-90&lon=-180")).toEqual({ latitude: -88, longitude: -180 });
  });
});

describe("regionPath", () => {
  it("is the one address of a cell, which readCell reads back to the same cell", () => {
    expect(regionPath(ATL_CELL)).toBe("/api/region?lat=32&lon=-84");
    expect(regionPath({ latitude: 0, longitude: 0 })).toBe("/api/region?lat=0&lon=0");
    for (const cell of cellsCovering({ west: -180, south: -90, east: 179, north: 90 })) {
      expect(readCell(new URL(`http://x${regionPath(cell)}`).searchParams)).toEqual(cell);
    }
  });
});

describe("regionQuery", () => {
  it("asks for the cell's centre at the fixed radius", () => {
    expect(providerUrl("adsb.lol", regionQuery(ATL_CELL))).toBe(`https://api.adsb.lol/v2/point/32/-84/${REGION_RADIUS_NM}`);
  });

  it("covers every point of its cell, and a 20 NM airport circle at the cell's corner", () => {
    // The cell's half-diagonal at the equator plus 20 NM, in nautical miles.
    const halfDiagonalNm = Math.hypot(2, 2) * 60;
    expect(halfDiagonalNm + 20).toBeLessThan(REGION_RADIUS_NM);
  });
});

describe("parseRegion", () => {
  it("keeps what the map draws, across the whole radius", () => {
    const snapshot = parseRegion(response({ hex: "AB313C", flight: "DAL1099 ", t: "B752", lat: 35.9, lon: -80.1 }), ATL_CELL);
    expect(snapshot.cell).toEqual(ATL_CELL);
    expect(snapshot.time).toBeCloseTo(1_790_794_144.001, 3);
    expect(snapshot.aircraft).toEqual([
      { id: "ab313c", callsign: "DAL1099", typeCode: "B752", military: false, latitude: 35.9, longitude: -80.1, altitudeFt: 35000, onGround: false, groundSpeedKt: 450, trackDeg: 90, verticalRateFpm: null, positionAgeS: 1 },
    ]);
  });

  it("carries the aircraft database's military flag (the first bit of dbFlags, whatever else is set)", () => {
    const [mil, ladd, both, none] = parseRegion(response({ hex: "a1", dbFlags: 1 }, { hex: "a2", dbFlags: 8 }, { hex: "a3", dbFlags: 9 }, { hex: "a4" }), ATL_CELL).aircraft;
    expect([mil.military, ladd.military, both.military, none.military]).toEqual([true, false, true, false]);
  });

  it("reads the ground flag, and keeps an aircraft with no altitude as unknown", () => {
    const [ground, unknown] = parseRegion(response({ hex: "a1", alt_baro: "ground", gs: 12 }, { hex: "a2", alt_baro: undefined }), ATL_CELL).aircraft;
    expect(ground).toMatchObject({ onGround: true, altitudeFt: 0 });
    expect(unknown).toMatchObject({ onGround: false, altitudeFt: null });
  });

  it("drops stale and unplaceable positions, and keeps the freshest of a repeated hex", () => {
    const { aircraft } = parseRegion(
      response({ hex: "a1", seen_pos: 120 }, { hex: "a2", lat: undefined }, { hex: "a3", lat: 34, seen_pos: 9 }, { hex: "a3", lat: 35, seen_pos: 2 }),
      ATL_CELL,
    );
    expect(aircraft.map((a) => [a.id, a.latitude])).toEqual([["a3", 35]]);
  });

  it("carries how old each position is, so the map can place a fix received seconds ago back in time", () => {
    const [fresh, noPos, unknown] = parseRegion(response({ hex: "a1", seen_pos: 0.4 }, { hex: "a2", seen_pos: undefined, seen: 7 }, { hex: "a3", seen_pos: undefined }), ATL_CELL).aircraft;
    expect([fresh.positionAgeS, noPos.positionAgeS, unknown.positionAgeS]).toEqual([0.4, 7, 0]);
  });

  it("throws on a body that is not an adsb.lol response, so an outage never reads as an empty sky", () => {
    expect(() => parseRegion({ error: "rate limited" }, ATL_CELL)).toThrow();
    expect(() => parseRegion(null, ATL_CELL)).toThrow();
  });
});

describe("parseRegion on a real adsb.lol response", () => {
  it("reads the recorded region around Atlanta", () => {
    const snapshot = parseRegion(regionFixture, ATL_CELL);
    expect([snapshot.aircraft.length, snapshot.aircraft.filter((a) => a.onGround).length]).toEqual([153, 9]);
    expect(countsNear([ATL], snapshot.aircraft)).toEqual({ atl: { total: 20, ground: 9 } });
  });
});

describe("fetchRegion", () => {
  it("asks for the cell's URL and parses the answer", async () => {
    const asked: string[] = [];
    const snapshot = await fetchRegion(
      ATL_CELL,
      readViaLol(async (url) => {
        asked.push(url);
        return JSON.stringify(response({}));
      }),
    );
    expect(asked).toEqual([providerUrl("adsb.lol", regionQuery(ATL_CELL))]);
    expect(snapshot.aircraft).toHaveLength(1);
  });
});

describe("cellsCovering", () => {
  it("lists the cells whose ground a view shows", () => {
    expect(cellsCovering({ west: -86, south: 31, east: -81, north: 34.5 })).toEqual([
      { latitude: 32, longitude: -84 },
      { latitude: 32, longitude: -80 },
      { latitude: 36, longitude: -84 },
      { latitude: 36, longitude: -80 },
    ]);
  });

  it("wraps across the antimeridian", () => {
    const cells = cellsCovering({ west: 177, south: -1, east: 181, north: 1 });
    expect(cells).toEqual([
      { latitude: 0, longitude: 176 },
      { latitude: 0, longitude: -180 },
    ]);
  });
});

describe("cellOf and countsNear", () => {
  it("finds an airport's cell", () => {
    expect(cellOf(ATL)).toEqual(ATL_CELL);
  });

  it("counts the aircraft within 20 NM of each airport, and how many are on the ground", () => {
    const atl = ATL;
    const near = { latitude: atl.latitude + 0.2, longitude: atl.longitude, onGround: false };
    const onField = { latitude: atl.latitude, longitude: atl.longitude + 0.01, onGround: true };
    // 0.4 degrees of latitude is 24 NM: outside.
    const far = { latitude: atl.latitude - 0.4, longitude: atl.longitude, onGround: false };
    expect(countsNear([atl], [near, onField, far])).toEqual({ atl: { total: 2, ground: 1 } });
  });
});
