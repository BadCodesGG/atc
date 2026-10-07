import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import routes from "./__fixtures__/routes_atl.json";
import raw from "./__fixtures__/adsblol_atl.json";
import { buildPlaces, flightDocs, nearestAirport, remoteSummary, search, type SearchData } from "./search";
import { Tracker } from "./tracker";
import { parseTraffic } from "./traffic";
import { fixtureTime, TrafficView } from "./traffic-view";

const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;

function fixtureData(): SearchData {
  const snapshot = parseTraffic(raw, DEFAULT_AIRPORT);
  const tracker = new Tracker();
  tracker.add(snapshot);
  const view = new TrafficView(map, DEFAULT_AIRPORT);
  view.addRoutes(routes as never);
  const { entries } = view.frame(tracker.at(fixtureTime(snapshot)));
  return { here: "atl", flights: flightDocs(entries), places: buildPlaces(map) };
}

const data = fixtureData();
const run = (q: string) => search(q, data);
const flightsOf = (q: string) => run(q).groups.find((g) => g.kind === "flights")?.hits ?? [];
const callsigns = (q: string) => flightsOf(q).map((h) => (h.kind === "flight" ? h.callsign : ""));

describe("flights", () => {
  it("finds a flight by callsign, by IATA flight number, and by registration", () => {
    expect(callsigns("DAL3104")).toEqual(["DAL3104"]);
    expect(callsigns("dl3104")).toEqual(["DAL3104"]);
    expect(callsigns("DL 3104")).toEqual(["DAL3104"]);
    expect(callsigns("N744WG")[0]).toBe("N744WG");
    expect(callsigns("n820dx")).toEqual(["DAL1099"]);
  });

  it("ranks an exact callsign above a longer one that merely starts with it", () => {
    const doc = (callsign: string) => ({ id: callsign, callsign, registration: null, typeCode: null, state: "taxiing" as const, route: null });
    const list = search("dal31", { here: "atl", places: [], flights: [doc("DAL3104"), doc("DAL31"), doc("DAL312")] });
    expect(list.groups[0].hits.map((h) => (h.kind === "flight" ? h.callsign : ""))).toEqual(["DAL31", "DAL312", "DAL3104"]);
  });

  it("ranks callsign matches above airline-name matches", () => {
    const hits = flightsOf("delta");
    expect(hits.length).toBeGreaterThan(5);
    expect(callsigns("delta").every((c) => c.startsWith("DAL"))).toBe(true);
  });

  it("finds flights by airline name, type code, type name, and number alone", () => {
    expect(callsigns("virgin")).toEqual(["VIR103M"]);
    expect(callsigns("b764")).toEqual(["DAL193"]);
    expect(callsigns("boeing 757")).toContain("DAL1099");
    expect(callsigns("3104")).toContain("DAL3104");
    expect(callsigns("delta 3104")).toEqual(["DAL3104"]);
  });

  it("finds flights by the far end of the route, by code or city, but not by this airport", () => {
    expect(callsigns("SRQ")).toEqual(["DAL3104"]);
    expect(callsigns("sarasota")).toEqual(["DAL3104"]);
    expect(callsigns("venice")).toEqual(["DAL193"]);
    expect(callsigns("atlanta")).toEqual([]);
  });

  it("carries what a row prints", () => {
    const [hit] = flightsOf("DAL3104");
    expect(hit).toMatchObject({ kind: "flight", callsign: "DAL3104", flightNumber: "DL3104", state: expect.any(String) });
    expect(hit.kind === "flight" && hit.detail).toBe("Delta · Airbus A321 · SRQ → ATL");
  });
});

describe("places", () => {
  const placesOf = (q: string) => run(q).groups.find((g) => g.kind === "places")?.hits.map((h) => (h.kind === "place" ? `${h.place.kind} ${h.place.ref}` : "")) ?? [];

  it("finds a gate by its ref, exact first, then the refs it starts", () => {
    const list = placesOf("E1");
    expect(list[0]).toBe("gate E1");
    expect(list.every((p) => p.split(" ")[1].startsWith("E1"))).toBe(true);
    expect(placesOf("e15")).toEqual(["gate E15", "stand E15A"]);
    expect(placesOf("gate e 15")).toEqual(["gate E15"]);
    expect(placesOf("stand e15")).toEqual(["stand E15A"]);
  });

  it("finds a runway by either end's designator, with or without the leading zero", () => {
    expect(placesOf("9R")).toEqual(["runway 9R/27L"]);
    expect(placesOf("09r")).toEqual(["runway 9R/27L"]);
    expect(placesOf("27L")).toEqual(["runway 9R/27L"]);
    expect(placesOf("runway 10")).toEqual(["runway 10/28"]);
  });

  it("gives a runway both its ends to highlight", () => {
    const hit = run("9R").groups.find((g) => g.kind === "places")?.hits[0];
    expect(hit?.kind === "place" && hit.place.points).toHaveLength(2);
  });

  it("does not list a gate for a stand-only query", () => {
    expect(placesOf("stand e15").every((p) => p.startsWith("stand"))).toBe(true);
  });
});

describe("airports", () => {
  const airportsOf = (q: string) => run(q).groups.find((g) => g.kind === "airports")?.hits.map((h) => (h.kind === "airport" ? h.code : "")) ?? [];

  it("finds an airport by code, city, state or name", () => {
    expect(airportsOf("phx")).toEqual(["phx"]);
    expect(airportsOf("phoenix")[0]).toBe("phx");
    expect(airportsOf("arizona")).toEqual(["phx"]);
    expect(airportsOf("sky harbor")).toEqual(["phx"]);
    expect(airportsOf("KJFK")).toEqual(["jfk"]);
    expect(airportsOf("TX")).toEqual(expect.arrayContaining(["dfw", "iah", "aus"]));
  });

  it("ranks the code above the city", () => {
    expect(airportsOf("sea")[0]).toBe("sea");
  });

  it("leaves out the airport on screen", () => {
    expect(airportsOf("atlanta")).toEqual([]);
    expect(airportsOf("georgia")).toEqual([]);
  });

  it("describes the airport", () => {
    const hit = run("phx").groups.find((g) => g.kind === "airports")?.hits[0];
    expect(hit).toMatchObject({ kind: "airport", title: "PHX", where: "Phoenix, Arizona" });
  });
});

describe("groups", () => {
  it("orders the groups by their best match", () => {
    expect(run("E15").groups.map((g) => g.kind)[0]).toBe("places");
    expect(run("DAL3104").groups.map((g) => g.kind)[0]).toBe("flights");
    expect(run("phoenix").groups.map((g) => g.kind)[0]).toBe("airports");
  });

  it("is empty for nothing", () => {
    expect(run("").groups).toEqual([]);
    expect(run("   ").groups).toEqual([]);
    expect(run("zzzzqq").groups).toEqual([]);
  });
});

describe("remote", () => {
  it("asks about a callsign or flight number nothing here matches", () => {
    expect(run("AAL100").remote).toBe("AAL100");
    expect(run("aa100").remote).toBe("AAL100");
    expect(run("aa 100").remote).toBe("AAL100");
    expect(run("N123AB").remote).toBe("N123AB");
  });

  it("does not ask when something here matches", () => {
    expect(run("DL3104").remote).toBeNull();
    expect(run("E15").remote).toBeNull();
    expect(run("PHX").remote).toBeNull();
  });

  it("does not ask for text that cannot be a callsign", () => {
    expect(run("zzzzqq").remote).toBeNull();
    expect(run("12").remote).toBeNull();
    expect(run("a").remote).toBeNull();
    expect(run("../etc/passwd1").remote).toBeNull();
    expect(run("waytoolong1234").remote).toBeNull();
  });
});

describe("nearestAirport and remoteSummary", () => {
  it("names the nearest listed airport and the distance in nautical miles", () => {
    const near = nearestAirport(33.4373, -112.0078);
    expect(near.airport.code).toBe("phx");
    expect(near.nm).toBeLessThan(1);
    expect(nearestAirport(40.7, -74.2).airport.code).toBe("ewr");
  });

  it("offers to open an airport only for a flight within the scene's range of it", () => {
    const base = { callsign: "AAL100", registration: null, typeCode: "A321", altitudeFt: 4200, groundSpeedKt: 190, route: null };
    const close = remoteSummary({ ...base, latitude: 33.4, longitude: -112.2 }, "atl");
    expect(close).toMatchObject({ nearest: "phx", openable: true, altitude: "4,200 ft" });
    const far = remoteSummary({ ...base, latitude: 37.0, longitude: -100.0, altitudeFt: 35_000 }, "atl");
    expect(far.openable).toBe(false);
    expect(far.altitude).toBe("35,000 ft");
  });
});
