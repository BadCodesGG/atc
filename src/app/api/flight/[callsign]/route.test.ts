import { afterEach, describe, expect, it, vi } from "vitest";
import { findFlight } from "@/lib/flight-lookup";
import { UpstreamBusyError } from "@/lib/upstream";
import { GET } from "./route";

vi.mock("@/lib/flight-lookup", async (original) => {
  const actual = await original<typeof import("@/lib/flight-lookup")>();
  return { ...actual, findFlight: vi.fn(actual.findFlight) };
});

/** The request for `callsign` as the path spells it, which is all the route sees of what was typed (Next decodes the path segment it hands over as a param). */
const call = (callsign: string, query = "") => GET(new Request(`http://localhost/api/flight/${callsign}${query}`), { params: Promise.resolve({ callsign: decodeURIComponent(callsign) }) } as Parameters<typeof GET>[1]);

afterEach(() => {
  vi.unstubAllGlobals();
});

const swa77 = () =>
  vi.fn(async (url: string) =>
    url.includes("adsb.lol")
      ? Response.json({ ac: [{ flight: "SWA77  ", lat: 33.5, lon: -112, alt_baro: 31000, gs: 440, t: "B38M" }] })
      : Response.json({ response: { flightroute: { origin: { iata_code: "PHX", municipality: "Phoenix" }, destination: { iata_code: "DEN", municipality: "Denver" } } } }),
  );

describe("GET /api/flight/[callsign]", () => {
  it("answers 400 for a bad value and never reaches fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["..%2Fsecrets", "a", "DAL3104/../x", "DAL3104?x=1", "toolongcallsign", "DAL 31", "%E2%80%94"]) {
      const res = await call(bad);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("Cache-Control"), bad).toBe("no-store");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates before it remembers anything: a flood of bad values neither reaches the lookup nor pushes a real flight out of the memo", async () => {
    const fetchMock = swa77();
    vi.stubGlobal("fetch", fetchMock);
    expect((await call("UAL2468")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.mocked(findFlight).mockClear();
    for (let i = 0; i < 300; i++) expect((await call(`bad-${i}`)).status).toBe(400);
    // Far longer than a callsign can be, and no work spent on it.
    expect((await call("x".repeat(100_000))).status).toBe(400);
    expect(findFlight).not.toHaveBeenCalled();
    expect((await call("UAL2468")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers 404 when nothing is airborne, asking adsb.lol for the mapped callsign", async () => {
    const fetchMock = vi.fn(async () => Response.json({ ac: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("NOFLY1");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The miss is held, so a repeat of it does not reach adsb.lol.
    expect((await call("NOFLY1")).status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["https://api.adsb.lol/v2/callsign/NOFLY1", expect.anything()]);
  });

  it("answers the flight with its route, and holds the answer for repeat questions", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes("adsb.lol")
        ? Response.json({ ac: [{ flight: "SWA77  ", lat: 33.5, lon: -112, alt_baro: 31000, gs: 440, t: "B38M" }] })
        : Response.json({ response: { flightroute: { origin: { iata_code: "PHX", municipality: "Phoenix" }, destination: { iata_code: "DEN", municipality: "Denver" } } } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("SWA77");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=15, stale-while-revalidate=30");
    expect(await res.json()).toMatchObject({ callsign: "SWA77", altitudeFt: 31000, route: { origin: { code: "PHX" }, destination: { code: "DEN" } } });
    await call("SWA77");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe("one address per flight", () => {
    it("redirects every other spelling of a callsign to the callsign itself, permanently, without a lookup", async () => {
      const fetchMock = swa77();
      vi.stubGlobal("fetch", fetchMock);
      vi.mocked(findFlight).mockClear();
      for (const typed of ["swa77", "Swa77", "wn77", "WN77", "%57N77"]) {
        const res = await call(typed);
        expect(res.status, typed).toBe(308);
        expect(res.headers.get("Location"), typed).toBe("/api/flight/SWA77");
        expect(res.headers.get("Cache-Control"), typed).toBe("public, max-age=3600, s-maxage=86400");
      }
      const res = await call("dl3104");
      expect([res.status, res.headers.get("Location")]).toEqual([308, "/api/flight/DAL3104"]);
      expect(findFlight).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("redirects a callsign carrying a query to the bare one, so the query cannot be a way past the cache", async () => {
      vi.stubGlobal("fetch", swa77());
      const res = await call("SWA77", "?x=1");
      expect([res.status, res.headers.get("Location")]).toEqual([308, "/api/flight/SWA77"]);
    });

    it("answers a callsign at its own address without a redirect, and every address it redirects to is its own", async () => {
      vi.stubGlobal("fetch", swa77());
      for (const canonical of ["SWA77", "DAL3104", "N123AB", "UAL2468", "AB12"]) {
        const redirect = await call(canonical);
        expect(redirect.status, canonical).not.toBe(308);
      }
    });
  });

  it("answers 503 with a Retry-After when the server's cap on upstream requests is spent, and does not remember it", async () => {
    vi.stubGlobal("fetch", swa77());
    vi.mocked(findFlight).mockRejectedValueOnce(new UpstreamBusyError(3));
    const res = await call("SWA88");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await call("SWA88")).status).toBe(200);
  });

  it("answers 502 when adsb.lol fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 503 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await call("BROKEN1")).status).toBe(502);
  });
});
