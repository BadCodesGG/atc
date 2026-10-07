import { afterEach, describe, expect, it, vi } from "vitest";
import { airportByCode } from "./airports";
import fixture from "./__fixtures__/adsblol_atl.json";
import { readViaLol } from "./__fixtures__/lol-read";
import { fetchTraffic, parseTraffic, trafficQuery } from "./traffic";
import { providerUrl, Upstream, UpstreamStatusError } from "./upstream";

const ATL = airportByCode("atl")!;
const NOW = 1_790_794_144_001;

/** An upstream response with the given aircraft, each defaulting to a healthy airborne one near the field. */
function response(...ac: Record<string, unknown>[]) {
  return { now: NOW, ac: ac.map((a) => ({ hex: "abc123", lat: 33.64, lon: -84.43, alt_baro: 3000, gs: 200, seen_pos: 1, ...a })) };
}

describe("parseTraffic on a real adsb.lol response", () => {
  const snapshot = parseTraffic(fixture, ATL);
  const byId = new Map(snapshot.aircraft.map((a) => [a.id, a]));

  it("keeps every aircraft of the fixture and stamps the time in UTC seconds", () => {
    expect(snapshot.airport).toBe("atl");
    expect(snapshot.time).toBeCloseTo(1_790_794_144.001, 3);
    expect(snapshot.aircraft).toHaveLength(fixture.ac.length);
  });

  it("reads ground and airborne states", () => {
    expect(snapshot.aircraft.filter((a) => a.onGround)).toHaveLength(18);
    const taxiing = byId.get("acf69b")!;
    expect(taxiing).toMatchObject({ onGround: true, altitudeFt: 0, callsign: "EDV5051", registration: "N934XJ", typeCode: "CRJ9", category: "A3", trackDeg: 270 });
    expect(taxiing.groundSpeedKt).toBeCloseTo(18.5);
    expect(taxiing.positionAge).toBeCloseTo(41.85);
    const climbing = byId.get("ab313c")!;
    expect(climbing).toMatchObject({ onGround: false, altitudeFt: 2825, callsign: "DAL1099", source: "adsb_icao", squawk: "3523" });
    expect(climbing.trackDeg).toBeCloseTo(62.03);
    expect(climbing.verticalRateFpm).toBe(0);
  });

  it("does not call a fast aircraft below field elevation grounded", () => {
    // 925 ft barometric at 150 kt: under ATL's 1026 ft field elevation but plainly flying.
    expect(byId.get("a32368")).toMatchObject({ onGround: false, altitudeFt: 925 });
  });

  it("places aircraft in metres around the reference point", () => {
    const a = byId.get("ab313c")!;
    // 33.600474, -84.688797 is about 24 km west and 4 km south of the ARP.
    expect(a.x).toBeGreaterThan(-25_000);
    expect(a.x).toBeLessThan(-23_000);
    expect(a.y).toBeGreaterThan(-4_500);
    expect(a.y).toBeLessThan(-3_500);
    for (const b of snapshot.aircraft) expect(Math.hypot(b.x, b.y)).toBeLessThan(40_000);
  });
});

describe("parseTraffic field handling", () => {
  it("treats a missing optional field as null", () => {
    const [a] = parseTraffic(response({ flight: undefined, r: undefined, t: undefined, category: undefined, gs: undefined, track: undefined, baro_rate: undefined, squawk: undefined, type: undefined }), ATL).aircraft;
    expect(a).toMatchObject({ callsign: null, registration: null, typeCode: null, category: null, groundSpeedKt: null, trackDeg: null, verticalRateFpm: null, squawk: null, source: null });
  });

  it("trims callsigns and lower-cases the hex id", () => {
    const [a] = parseTraffic(response({ hex: "AB313C", flight: "DAL1099 ", r: " N820DX" }), ATL).aircraft;
    expect(a).toMatchObject({ id: "ab313c", callsign: "DAL1099", registration: "N820DX" });
  });

  it("prefers track, falls back to true_heading", () => {
    expect(parseTraffic(response({ track: 90, true_heading: 100 }), ATL).aircraft[0].trackDeg).toBe(90);
    expect(parseTraffic(response({ true_heading: 100 }), ATL).aircraft[0].trackDeg).toBe(100);
  });

  it("falls back to the geometric rate when there is no barometric one", () => {
    expect(parseTraffic(response({ geom_rate: -700 }), ATL).aircraft[0].verticalRateFpm).toBe(-700);
  });

  it("marks an aircraft on the ground by the flag, or by sitting at field elevation and crawling", () => {
    const [flag, slow, fast, high] = parseTraffic(
      response(
        { hex: "a00001", alt_baro: "ground", gs: 300 },
        { hex: "a00002", alt_baro: 1040, gs: 12 },
        { hex: "a00003", alt_baro: 1040, gs: 160 },
        { hex: "a00004", alt_baro: 1200, gs: 12 },
      ),
      ATL,
    ).aircraft;
    expect([flag.onGround, slow.onGround, fast.onGround, high.onGround]).toEqual([true, true, false, false]);
    expect([flag.altitudeFt, slow.altitudeFt, fast.altitudeFt, high.altitudeFt]).toEqual([0, 0, 1040, 1200]);
  });

  it("needs a known ground speed to infer the ground from altitude", () => {
    expect(parseTraffic(response({ alt_baro: 1030, gs: undefined }), ATL).aircraft[0].onGround).toBe(false);
  });

  it("uses the geometric altitude when the barometric one is missing, and drops an aircraft with neither", () => {
    const { aircraft } = parseTraffic(response({ hex: "a00001", alt_baro: undefined, alt_geom: 4100 }, { hex: "a00002", alt_baro: undefined }), ATL);
    expect(aircraft.map((a) => [a.id, a.altitudeFt])).toEqual([["a00001", 4100]]);
  });
});

describe("parseTraffic filtering", () => {
  it("drops entries without a usable position or id", () => {
    const { aircraft } = parseTraffic(
      response(
        { hex: "a00001" },
        { hex: "a00002", lat: undefined },
        { hex: "a00003", lon: "west" },
        { hex: "a00004", lat: Number.NaN },
        { hex: "", lat: 33.64 },
        { hex: undefined },
      ),
      ATL,
    );
    expect(aircraft.map((a) => a.id)).toEqual(["a00001"]);
  });

  it("drops positions older than a minute, keeps those at the limit", () => {
    const { aircraft } = parseTraffic(response({ hex: "a00001", seen_pos: 60 }, { hex: "a00002", seen_pos: 60.5 }), ATL);
    expect(aircraft.map((a) => a.id)).toEqual(["a00001"]);
  });

  it("reads the position age from seen when seen_pos is absent, and as fresh when both are", () => {
    const { aircraft } = parseTraffic(response({ hex: "a00001", seen_pos: undefined, seen: 80 }, { hex: "a00002", seen_pos: undefined, seen: 5 }, { hex: "a00003", seen_pos: undefined }), ATL);
    expect(aircraft.map((a) => [a.id, a.positionAge])).toEqual([["a00002", 5], ["a00003", 0]]);
  });

  it("drops aircraft more than 40 km from the field", () => {
    // 0.5 degrees of latitude is about 55 km; 0.3 is about 33 km.
    const { aircraft } = parseTraffic(response({ hex: "a00001", lat: 34.14 }, { hex: "a00002", lat: 33.94 }), ATL);
    expect(aircraft.map((a) => a.id)).toEqual(["a00002"]);
  });

  it("keeps the freshest report of a duplicated hex", () => {
    const { aircraft } = parseTraffic(response({ hex: "a00001", seen_pos: 9, alt_baro: 1000 }, { hex: "A00001", seen_pos: 2, alt_baro: 2000 }, { hex: "a00001", seen_pos: 5, alt_baro: 3000 }), ATL);
    expect(aircraft).toHaveLength(1);
    expect(aircraft[0]).toMatchObject({ id: "a00001", altitudeFt: 2000, positionAge: 2 });
  });

  it("accepts an empty sky", () => {
    expect(parseTraffic({ now: NOW, ac: [] }, ATL).aircraft).toEqual([]);
  });
});

describe("parseTraffic on malformed bodies", () => {
  it.each([
    ["null", null],
    ["a string", "nope"],
    ["an array", []],
    ["no aircraft list", { now: NOW }],
    ["a non-array aircraft list", { now: NOW, ac: {} }],
    ["no time", { ac: [] }],
    ["a non-numeric time", { now: "soon", ac: [] }],
  ])("throws on %s rather than reporting an empty sky", (_name, body) => {
    expect(() => parseTraffic(body, ATL)).toThrow(/traffic/i);
  });

  it("skips junk entries inside an otherwise valid list", () => {
    const body = { now: NOW, ac: [null, 7, "x", [], { hex: "a00001", lat: 33.64, lon: -84.43, alt_baro: 3000, seen_pos: 1 }] };
    expect(parseTraffic(body, ATL).aircraft.map((a) => a.id)).toEqual(["a00001"]);
  });
});

describe("trafficQuery", () => {
  it("asks for a point and radius in nautical miles", () => {
    expect(providerUrl("adsb.lol", trafficQuery(ATL))).toBe("https://api.adsb.lol/v2/point/33.6367/-84.4281/20");
    expect(providerUrl("adsb.lol", trafficQuery(ATL, 15))).toBe("https://api.adsb.lol/v2/point/33.6367/-84.4281/15");
  });

  it("refuses a radius that is not a sane number", () => {
    for (const r of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 400]) expect(() => trafficQuery(ATL, r)).toThrow(/radius/i);
  });
});

describe("fetchTraffic", () => {
  it("requests the airport's URL and parses the text it gets back", async () => {
    const urls: string[] = [];
    const snapshot = await fetchTraffic(
      ATL,
      readViaLol(async (url) => {
        urls.push(url);
        return JSON.stringify(fixture);
      }),
    );
    expect(urls).toEqual(["https://api.adsb.lol/v2/point/33.6367/-84.4281/20"]);
    expect(snapshot.airport).toBe("atl");
    expect(snapshot.aircraft).toHaveLength(fixture.ac.length);
  });

  it("rejects a body that is not JSON", async () => {
    await expect(fetchTraffic(ATL, readViaLol(async () => "<html>rate limited</html>"))).rejects.toThrow();
  });

  it("passes a fetcher failure through", async () => {
    await expect(
      fetchTraffic(
        ATL,
        readViaLol(async () => {
          throw new Error("adsb.lol: 429");
        }),
      ),
    ).rejects.toThrow("adsb.lol: 429");
  });
});

describe("fetchTraffic against a failing upstream", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("throws a 429 with the Retry-After to wait, so the caller can back off", async () => {
    vi.stubGlobal("fetch", async () => new Response("slow down", { status: 429, headers: { "Retry-After": "12" } }));
    const error = await fetchTraffic(ATL, new Upstream(undefined, { log: () => {} }).read).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UpstreamStatusError);
    expect(error).toMatchObject({ status: 429, retryAfter: "12" });
  });
});
