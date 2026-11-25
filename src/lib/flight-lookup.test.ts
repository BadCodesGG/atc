import { describe, expect, it, vi } from "vitest";
import { readViaLol } from "./__fixtures__/lol-read";
import { findFlight, flightKey, lookupCallsign, lookupRegistration, parseCallsignResponse } from "./flight-lookup";
import { Upstream, UpstreamStatusError } from "./upstream";

describe("lookupCallsign", () => {
  it("upper-cases and maps a flight number to its callsign", () => {
    expect(lookupCallsign("dal3104")).toBe("DAL3104");
    expect(lookupCallsign("DL3104")).toBe("DAL3104");
    expect(lookupCallsign(" n820dx ")).toBe("N820DX");
  });

  it.each(["", "A", "TOOLONGCALL", "DAL 31/04", "../etc", "DAL3104?x=1", "DAL3104#", "DAL-3104", "ÉÉ12", "DAL3104%2F"])("rejects %j", (bad) => {
    expect(lookupCallsign(bad)).toBeNull();
  });
});

describe("lookupRegistration", () => {
  it.each([
    ["n3596w", "N3596W"],
    [" N820DX ", "N820DX"],
    ["N1", "N1"],
    ["g-zbkj", "G-ZBKJ"],
    ["EI-NSG", "EI-NSG"],
    ["9h-abc", "9H-ABC"],
    ["B-1234", "B-1234"],
    ["ja8089", "JA8089"],
    ["HL7611", "HL7611"],
  ])("reads %j as the tail %j", (typed, tail) => {
    expect(lookupRegistration(typed)).toBe(tail);
  });

  it.each(["", "N", "N0123", "N123456", "DAL3104", "SWA77", "BAD-17", "G-", "-ABC", "G--ABC", "G-ABCDEF", "G-AB/C", "../etc", "G-AB?x=1", "G-AB#", "G-AB%2F", "ÉÉ-12", "G AB"])("rejects %j", (bad) => {
    expect(lookupRegistration(bad)).toBeNull();
  });
});

describe("flightKey", () => {
  it("is the callsign a value names, else the tail it names, else null", () => {
    expect(flightKey("dl3104")).toBe("DAL3104");
    expect(flightKey("n3596w")).toBe("N3596W");
    expect(flightKey("g-zbkj")).toBe("G-ZBKJ");
    expect(flightKey("bad-17")).toBeNull();
    expect(flightKey("../x")).toBeNull();
  });
});

describe("parseCallsignResponse", () => {
  const ac = { hex: "a1b2c3", flight: "DAL3104 ", r: "N820DX", t: "B752", lat: 33.5, lon: -84.4, alt_baro: 12000, gs: 310.4 };

  it("reads the first aircraft with a position", () => {
    expect(parseCallsignResponse({ ac: [{ hex: "x", flight: "DAL3104" }, ac] })).toEqual({
      hex: "a1b2c3",
      callsign: "DAL3104",
      registration: "N820DX",
      typeCode: "B752",
      latitude: 33.5,
      longitude: -84.4,
      altitudeFt: 12000,
      groundSpeedKt: 310.4,
    });
  });

  it("is null when nothing is airborne: no aircraft, no position, or on the ground", () => {
    expect(parseCallsignResponse({ ac: [] })).toBeNull();
    expect(parseCallsignResponse({ ac: [{ flight: "DAL1", lat: 1 }] })).toBeNull();
    expect(parseCallsignResponse({ ac: [{ ...ac, alt_baro: "ground" }] })).toBeNull();
    expect(parseCallsignResponse({})).toBeNull();
    expect(parseCallsignResponse(null)).toBeNull();
  });

  it("keeps only a hex that is one", () => {
    expect(parseCallsignResponse({ ac: [{ ...ac, hex: "A1B2C3" }] })?.hex).toBe("a1b2c3");
    expect(parseCallsignResponse({ ac: [{ ...ac, hex: "~a1b2c3" }] })?.hex).toBeNull();
    expect(parseCallsignResponse({ ac: [{ ...ac, hex: "../x" }] })?.hex).toBeNull();
  });

  it("falls back to the geometric altitude and tolerates missing fields", () => {
    expect(parseCallsignResponse({ ac: [{ lat: 1, lon: 2, alt_geom: 5000 }] })).toMatchObject({ callsign: null, altitudeFt: 5000, groundSpeedKt: null, typeCode: null });
    expect(parseCallsignResponse({ ac: [{ lat: 1, lon: 2 }] })).toBeNull();
  });
});

describe("findFlight", () => {
  const ac = { flight: "DAL3104", r: "N820DX", t: "B752", lat: 33.5, lon: -84.4, alt_baro: 12000, gs: 310 };
  const route = { response: { flightroute: { origin: { iata_code: "SRQ", municipality: "Sarasota" }, destination: { iata_code: "ATL", municipality: "Atlanta" } } } };

  const lolReturns = (...answers: (unknown | Error)[]) =>
    readViaLol(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return JSON.stringify(next);
    });
  const noRoute = vi.fn(async () => ({ status: 404, body: null }));

  it("never calls the network for a value that is not a callsign", async () => {
    const read = vi.fn();
    const get = vi.fn();
    for (const bad of ["../x", "DAL3104?a=b", "a", "DAL 31/04", "https://evil.example/x"]) expect(await findFlight(bad, read, get)).toEqual({ kind: "bad" });
    expect(read).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("asks adsb.lol for the mapped callsign, then adsbdb for the route", async () => {
    const urls: string[] = [];
    const read = readViaLol(async (url) => {
      urls.push(url);
      return JSON.stringify({ ac: [ac] });
    });
    const get = vi.fn(async (url: string) => {
      urls.push(url);
      return { status: 200, body: route };
    });
    const found = await findFlight("dl3104", read, get);
    expect(urls).toEqual(["https://api.adsb.lol/v2/callsign/DAL3104", "https://api.adsbdb.com/v0/callsign/DAL3104"]);
    expect(found).toMatchObject({ kind: "found", flight: { callsign: "DAL3104", altitudeFt: 12000, route: { origin: { code: "SRQ" }, destination: { code: "ATL" } } } });
  });

  describe("by tail number", () => {
    const pa32 = { hex: "a4097b", flight: "N3596W  ", r: "N3596W", t: "PA32", lat: 35.92, lon: -81.82, alt_baro: 7575, gs: 136 };
    const airliner = { hex: "a1b2c3", flight: "DAL3104 ", r: "N820DX", t: "B752", lat: 33.5, lon: -84.4, alt_baro: 12000, gs: 310 };
    const asking = (answers: Record<string, unknown>) => {
      const urls: string[] = [];
      const read = readViaLol(async (url) => {
        urls.push(url);
        const answer = Object.entries(answers).find(([path]) => url.endsWith(path))?.[1] ?? { ac: [] };
        if (answer instanceof Error) throw answer;
        return JSON.stringify(answer);
      });
      return { read, urls };
    };

    it("finds a GA aircraft by its callsign, which is its tail, without asking for the tail", async () => {
      const { read, urls } = asking({ "/v2/callsign/N3596W": { ac: [pa32] } });
      expect(await findFlight("n3596w", read, noRoute)).toMatchObject({ kind: "found", flight: { hex: "a4097b", registration: "N3596W", latitude: 35.92 } });
      expect(urls).toEqual(["https://api.adsb.lol/v2/callsign/N3596W"]);
    });

    it("falls back to the tail when no aircraft sends it as a callsign, and looks the route up by the callsign it does send", async () => {
      const { read, urls } = asking({ "/v2/reg/N820DX": { ac: [airliner] } });
      const get = vi.fn(async (url: string) => {
        urls.push(url);
        return { status: 404, body: null };
      });
      expect(await findFlight("n820dx", read, get)).toMatchObject({ kind: "found", flight: { callsign: "DAL3104", registration: "N820DX" } });
      expect(urls).toEqual(["https://api.adsb.lol/v2/callsign/N820DX", "https://api.adsb.lol/v2/reg/N820DX", "https://api.adsbdb.com/v0/callsign/DAL3104"]);
    });

    it("falls back to the tail when the callsign is a 404", async () => {
      const { read } = asking({ "/v2/callsign/N820DX": new UpstreamStatusError(404, null, "https://example.test"), "/v2/reg/N820DX": { ac: [airliner] } });
      expect(await findFlight("N820DX", read, noRoute)).toMatchObject({ kind: "found", flight: { registration: "N820DX" } });
    });

    it("asks for a hyphenated tail as a tail only: no callsign carries a hyphen", async () => {
      const { read, urls } = asking({ "/v2/reg/G-ZBKJ": { ac: [{ ...airliner, flight: "BAW117 ", r: "G-ZBKJ" }] } });
      expect(await findFlight("g-zbkj", read, noRoute)).toMatchObject({ kind: "found", flight: { callsign: "BAW117", registration: "G-ZBKJ" } });
      expect(urls[0]).toBe("https://api.adsb.lol/v2/reg/G-ZBKJ");
      expect(urls).toHaveLength(1);
    });

    it("does not spend a second read on a miss that cannot be a tail", async () => {
      const { read, urls } = asking({});
      expect(await findFlight("SWA77", read, noRoute)).toEqual({ kind: "none" });
      expect(urls).toEqual(["https://api.adsb.lol/v2/callsign/SWA77"]);
    });

    it("is none when neither the callsign nor the tail is airborne", async () => {
      const { read, urls } = asking({});
      expect(await findFlight("N3596W", read, noRoute)).toEqual({ kind: "none" });
      expect(urls).toEqual(["https://api.adsb.lol/v2/callsign/N3596W", "https://api.adsb.lol/v2/reg/N3596W"]);
    });

    it("throws when the tail lookup fails, so an outage never reads as not airborne", async () => {
      const { read } = asking({ "/v2/reg/N3596W": new UpstreamStatusError(503, null, "https://example.test") });
      await expect(findFlight("N3596W", read, noRoute)).rejects.toThrow();
    });

    it("never builds a route URL from a broadcast callsign that is not one", async () => {
      const { read } = asking({ "/v2/reg/N820DX": { ac: [{ ...airliner, flight: "../../x" }] } });
      const get = vi.fn(async () => ({ status: 404, body: null }));
      expect(await findFlight("N820DX", read, get)).toMatchObject({ kind: "found", flight: { route: null } });
      expect(get).not.toHaveBeenCalled();
    });
  });

  it("still finds the flight when the route lookup fails", async () => {
    const get = vi.fn(async () => {
      throw new Error("down");
    });
    expect(await findFlight("DAL3104", lolReturns({ ac: [ac] }), get)).toMatchObject({ kind: "found", flight: { route: null } });
  });

  it("is none when nothing is airborne or adsb.lol says 404, and throws when it fails", async () => {
    expect(await findFlight("DAL3104", lolReturns({ ac: [] }), noRoute)).toEqual({ kind: "none" });
    expect(await findFlight("DAL3104", lolReturns(new UpstreamStatusError(404, null, "https://example.test")), noRoute)).toEqual({ kind: "none" });
    await expect(findFlight("DAL3104", lolReturns(new UpstreamStatusError(403, null, "https://example.test")), noRoute)).rejects.toThrow();
    await expect(findFlight("DAL3104", lolReturns(new TypeError("fetch failed")), noRoute)).rejects.toThrow();
  });

  describe("on the provider chain", () => {
    /** adsb.lol answers `lol`, adsb.fi `fi`; each is an answer body or an error, and every provider asked is recorded. */
    function chain(lol: unknown, fi: unknown) {
      const asked: string[] = [];
      const upstream = new Upstream(
        async (url) => {
          asked.push(url);
          const answer = url.includes("adsb.lol") ? lol : fi;
          if (answer instanceof Error) throw answer;
          return JSON.stringify(answer);
        },
        { log: () => {} },
      );
      return { read: upstream.read, asked };
    }

    it.each([429, 420, 503])("asks adsb.fi's callsign endpoint when adsb.lol answers %i", async (code) => {
      const { read, asked } = chain(new UpstreamStatusError(code, null, "https://example.test"), { ac: [ac] });
      expect(await findFlight("DAL3104", read, noRoute)).toMatchObject({ kind: "found", flight: { callsign: "DAL3104", altitudeFt: 12000 } });
      expect(asked).toEqual(["https://api.adsb.lol/v2/callsign/DAL3104", "https://opendata.adsb.fi/api/v2/callsign/DAL3104"]);
    });

    it("does not ask adsb.fi when adsb.lol says 404 or lists nothing in the air: those are answers", async () => {
      const notFound = chain(new UpstreamStatusError(404, null, "https://example.test"), { ac: [ac] });
      expect(await findFlight("DAL3104", notFound.read, noRoute)).toEqual({ kind: "none" });
      expect(notFound.asked).toHaveLength(1);
      const empty = chain({ ac: [] }, { ac: [ac] });
      expect(await findFlight("DAL3104", empty.read, noRoute)).toEqual({ kind: "none" });
      expect(empty.asked).toHaveLength(1);
    });

    it("throws when neither can answer, so an outage never reads as not airborne", async () => {
      const { read } = chain(new UpstreamStatusError(429, null, "https://example.test"), new UpstreamStatusError(503, null, "https://example.test"));
      await expect(findFlight("DAL3104", read, noRoute)).rejects.toMatchObject({ status: 429 });
    });
  });
});
