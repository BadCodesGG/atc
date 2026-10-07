import { describe, expect, it } from "vitest";
import { parseRoute, RouteBook, routeUrl } from "./routes";

const ATL = { code: "atl" as const, icao: "KATL" };

/** The shape adsbdb answers with, trimmed to the fields read. */
const answer = (origin: [string, string, string], destination: [string, string, string]) => ({
  response: {
    flightroute: {
      callsign: "DAL796",
      origin: { iata_code: origin[0], icao_code: origin[1], municipality: origin[2], country_iso_name: "US" },
      destination: { iata_code: destination[0], icao_code: destination[1], municipality: destination[2], country_iso_name: "US" },
    },
  },
});

describe("routeUrl", () => {
  it("builds the URL only from a plain callsign", () => {
    expect(routeUrl("DAL796")).toBe("https://api.adsbdb.com/v0/callsign/DAL796");
    for (const bad of ["", "dal796", "DAL 796", "../x", "DAL796?x=1", "ABCDEFGHI"]) expect(routeUrl(bad)).toBeNull();
  });
});

describe("parseRoute", () => {
  it("keeps a route with this airport at one end", () => {
    expect(parseRoute(answer(["ATL", "KATL", "Atlanta"], ["PHX", "KPHX", "Phoenix"]), ATL)).toEqual({
      origin: { code: "ATL", city: "Atlanta", country: "US" },
      destination: { code: "PHX", city: "Phoenix", country: "US" },
    });
  });

  it("drops a route that never touches this airport: a stale entry is worse than none", () => {
    expect(parseRoute(answer(["JAX", "KJAX", "Jacksonville"], ["LGA", "KLGA", "New York"]), ATL)).toBeNull();
  });

  it("keeps any route when no airport is given: a flight looked up from anywhere", () => {
    expect(parseRoute(answer(["JAX", "KJAX", "Jacksonville"], ["LGA", "KLGA", "New York"]))).toEqual({
      origin: { code: "JAX", city: "Jacksonville", country: "US" },
      destination: { code: "LGA", city: "New York", country: "US" },
    });
  });

  it("matches on the ICAO code where an end has no IATA code, and names that end by its IATA code", () => {
    const r = parseRoute(answer(["", "KATL", "Atlanta"], ["", "CYUL", "Montreal"]), ATL);
    expect(r?.origin.code).toBe("ATL");
    expect(r?.destination.code).toBe("CYUL");
  });

  it("keeps where each end is, when adsbdb gives it, so the map can draw the route", () => {
    const a = answer(["ATL", "KATL", "Atlanta"], ["PHX", "KPHX", "Phoenix"]);
    Object.assign(a.response.flightroute.origin, { latitude: 33.6367, longitude: -84.428101 });
    Object.assign(a.response.flightroute.destination, { latitude: 33.434299, longitude: "bad" });
    const r = parseRoute(a, ATL);
    expect(r?.origin).toEqual({ code: "ATL", city: "Atlanta", country: "US", latitude: 33.6367, longitude: -84.428101 });
    // Half a position is no position.
    expect(r?.destination).toEqual({ code: "PHX", city: "Phoenix", country: "US" });
  });

  it("returns null for anything malformed", () => {
    for (const bad of [null, "x", {}, { response: "unknown callsign" }, { response: { flightroute: { origin: {} } } }]) expect(parseRoute(bad, ATL)).toBeNull();
  });
});

describe("RouteBook", () => {
  const ok = { status: 200, body: answer(["ATL", "KATL", "Atlanta"], ["PHX", "KPHX", "Phoenix"]) };

  it("answers at once from what it knows and looks the rest up afterwards", async () => {
    const asked: string[] = [];
    const book = new RouteBook(ATL, async (url) => {
      asked.push(url);
      return ok;
    });
    const first = book.routesFor(["DAL796"]);
    expect(first.routes).toEqual({});
    await first.work;
    expect(book.routesFor(["DAL796"]).routes.DAL796.destination.code).toBe("PHX");
    expect(asked).toHaveLength(1);
  });

  it("does not ask twice while a lookup is in flight, nor for a callsign it cannot put in a URL", async () => {
    let calls = 0;
    const book = new RouteBook(ATL, async () => {
      calls++;
      return ok;
    });
    const a = book.routesFor(["DAL796", "n 26la"]);
    const b = book.routesFor(["DAL796"]);
    await Promise.all([a.work, b.work]);
    expect(calls).toBe(1);
  });

  it("remembers a miss for an hour", async () => {
    let t = 0;
    let calls = 0;
    const book = new RouteBook(
      ATL,
      async () => {
        calls++;
        return { status: 404, body: null };
      },
      () => t,
    );
    await book.routesFor(["N26LA"]).work;
    await book.routesFor(["N26LA"]).work;
    expect(calls).toBe(1);
    t += 3600_001;
    await book.routesFor(["N26LA"]).work;
    expect(calls).toBe(2);
  });

  it("backs off for a minute after a refusal, asking nothing in between", async () => {
    let t = 0;
    let calls = 0;
    const book = new RouteBook(
      ATL,
      async () => {
        calls++;
        return { status: 429, body: null };
      },
      () => t,
    );
    await book.routesFor(["DAL1"]).work;
    await book.routesFor(["DAL2"]).work;
    expect(calls).toBe(1);
    t += 60_001;
    await book.routesFor(["DAL2"]).work;
    expect(calls).toBe(2);
  });

  it("looks up a few callsigns per call, so a full board fills over several polls", async () => {
    let calls = 0;
    const book = new RouteBook(ATL, async () => {
      calls++;
      return ok;
    });
    await book.routesFor(Array.from({ length: 50 }, (_, i) => `DAL${i}`)).work;
    expect(calls).toBe(12);
  });
});
