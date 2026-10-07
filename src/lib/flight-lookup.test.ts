import { describe, expect, it, vi } from "vitest";
import { readViaLol } from "./__fixtures__/lol-read";
import { findFlight, lookupCallsign, parseCallsignResponse } from "./flight-lookup";
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

describe("parseCallsignResponse", () => {
  const ac = { hex: "a1b2c3", flight: "DAL3104 ", r: "N820DX", t: "B752", lat: 33.5, lon: -84.4, alt_baro: 12000, gs: 310.4 };

  it("reads the first aircraft with a position", () => {
    expect(parseCallsignResponse({ ac: [{ hex: "x", flight: "DAL3104" }, ac] })).toEqual({
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
