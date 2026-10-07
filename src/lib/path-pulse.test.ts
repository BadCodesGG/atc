import { readFileSync } from "node:fs";
import path from "node:path";
import { describe as group, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import { citeProcedure, describe, type OpsEntry, PathPulse } from "./path-pulse";
import { localProcedures, type ProcedureFile } from "./procedure-path";
import { Tracker } from "./tracker";
import { parseTraffic } from "./traffic";
import { fixtureTime, TrafficView } from "./traffic-view";

const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;
const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "__fixtures__/adsblol_atl.json"), "utf8"));
const routes = JSON.parse(readFileSync(path.join(import.meta.dirname, "__fixtures__/routes_atl.json"), "utf8"));

const format = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);

function fixture() {
  const snapshot = parseTraffic(raw, DEFAULT_AIRPORT);
  const tracker = new Tracker();
  tracker.add(snapshot);
  const view = new TrafficView(map, DEFAULT_AIRPORT);
  view.addRoutes(routes);
  const time = fixtureTime(snapshot);
  return { entries: view.frame(tracker.at(time)).entries, time };
}

/** An aircraft stopped on the ground at (x, y), heading east. */
function stopped(id: string, x: number, y: number): OpsEntry {
  return {
    aircraft: { id, callsign: id.toUpperCase(), x, y, headingDeg: 90, headingKnown: true, onGround: true, groundSpeedKt: 0 },
    situation: { state: "taxiing", activity: "Holding", runway: null, aglFt: 0, moving: false },
    card: { direction: "outbound" },
  };
}

group("PathPulse on the frozen ATL fixture", () => {
  it("names the runways the fixture shows in use, and the one its north-side departures are likely making for", () => {
    const { entries, time } = fixture();
    const ops = new PathPulse(map, { since: time, format });
    ops.update(entries, time);
    const runways = ops.view(time).runways;
    expect(runways.map((r) => [r.runway, r.role])).toEqual([
      ["8L", "Arrivals"],
      ["8R", "Departures, likely"],
      ["9L", "Departures"],
      ["9R", "Arrivals"],
    ]);
    expect(runways.find((r) => r.runway === "8R")!.taxiingOut).toBeGreaterThan(0);
  });

  it("draws a path for the moving aircraft and none for the parked", () => {
    const { entries, time } = fixture();
    const ops = new PathPulse(map, { since: time, format });
    const paths = ops.update(entries, time);
    expect(paths.length).toBeGreaterThanOrEqual(8);
    const parked = new Set(entries.filter((e) => e.situation.state === "parked").map((e) => e.aircraft.id));
    expect(paths.some((p) => parked.has(p.id))).toBe(false);
    // DAL3104, landing on 9R, has its rollout and route in.
    expect(paths.find((p) => entries.find((e) => e.aircraft.id === p.id)?.card.callsign === "DAL3104")?.runway).toBe("9R");
  });

  it("with the published procedures, cites the approach of an arrival on final, and works one out only for the selected flight", () => {
    const { entries, time } = fixture();
    const procedures = localProcedures(JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/procedures/atl.json"), "utf8")) as ProcedureFile, DEFAULT_AIRPORT);
    const ops = new PathPulse(map, { since: time, format, procedures });
    const id = (callsign: string) => entries.find((e) => e.card.callsign === callsign)!.aircraft.id;
    ops.update(entries, time);
    expect(ops.procedureOf(id("RPA4349"))).toEqual({ kind: "approach", name: "ILS RWY 8L", cycle: "2610", likely: false });
    // DAL1488 is descending north-west of the field, not yet lined up: no path until it is the selected flight.
    expect(ops.procedureOf(id("DAL1488"))).toBeNull();
    ops.update(entries, time, id("DAL1488"));
    expect(ops.procedureOf(id("DAL1488"))).toEqual({ kind: "approach", name: "ILS RWY 8L", cycle: "2610", likely: true });
    expect(ops.pathOf(id("DAL1488"))?.runway).toBe("8L");
    expect(ops.pathOf("nobody")).toBeNull();
  });

  it("returns the same paths, unrebuilt, while nothing has moved", () => {
    const { entries, time } = fixture();
    const ops = new PathPulse(map, { since: time, format });
    const first = ops.update(entries, time);
    expect(ops.update(entries, time)).toBe(first);
  });

  it("boards every flight as first seen, and counts no movements it has not watched happen", () => {
    const { entries, time } = fixture();
    const ops = new PathPulse(map, { since: time, format });
    ops.update(entries, time);
    const v = ops.view(time);
    expect(v.board).toHaveLength(entries.length);
    expect(v.board.every((f) => f.events.length === 1 && f.events[0].kind === "seen")).toBe(true);
    expect(v.board.find((f) => f.callsign === "DAL2973")!.events[0].text).toBe("First seen at gate A33");
    expect(v).toMatchObject({ arrivals: 0, departures: 0, taxiOut: null, taxiIn: null, since: format(time) });
  });
});

group("PathPulse: hold queues", () => {
  it("counts aircraft stopped at a departure runway's holding points", () => {
    const { entries, time } = fixture();
    const ops = new PathPulse(map, { since: time, format });
    // Two waiting at the 9L hold beside its threshold, one well clear of it.
    ops.update([...entries, stopped("q1", -1817, -132), stopped("q2", -1817, -60), stopped("q3", -900, -60)], time);
    expect(ops.view(time).runways.find((r) => r.runway === "9L")!.holding).toBe(2);
  });
});

group("PathPulse: an aircraft that reports no heading and no route", () => {
  const eastFlow = () => ({ arrivals: ["8L", "9R"], departures: ["9L"] });
  /** Taxiing at (x, y) with no heading ever reported. */
  const unheaded = (x: number, y: number): OpsEntry => ({
    aircraft: { id: "u", callsign: "U1", x, y, headingDeg: 0, headingKnown: false, onGround: true, groundSpeedKt: 15 },
    situation: { state: "taxiing", activity: "Taxiing", runway: null, aglFt: 0, moving: true },
    card: { direction: null },
  });

  it("gets no path from a single sighting", () => {
    const ops = new PathPulse(map, { since: 0, format, fallback: eastFlow });
    expect(ops.update([unheaded(-1250, -99)], 100)).toEqual([]);
  });

  it("is given the way it has been moving over the ground, and a path to match", () => {
    const ops = new PathPulse(map, { since: 0, format, fallback: eastFlow });
    ops.update([unheaded(-1250, -99)], 100);
    ops.update([unheaded(-1290, -99)], 105);
    const [p] = ops.update([unheaded(-1330, -99)], 110);
    expect(p).toMatchObject({ id: "u", kind: "departure", runway: "9L" });
  });

  it("is taken the other way when it has been moving the other way", () => {
    const ops = new PathPulse(map, { since: 0, format, fallback: eastFlow });
    ops.update([unheaded(-1410, -99)], 100);
    ops.update([unheaded(-1370, -99)], 105);
    const [p] = ops.update([unheaded(-1330, -99)], 110);
    expect(p).toMatchObject({ id: "u", kind: "arrival" });
  });
});

group("describe", () => {
  it("words each kind of event as the board prints it", () => {
    expect(describe({ kind: "pushback", at: 0, place: { kind: "gate", ref: "A12" } })).toBe("Pushed back from gate A12");
    expect(describe({ kind: "takeoff", at: 0, runway: "9L" })).toBe("Took off, runway 9L");
    expect(describe({ kind: "landing", at: 0, runway: "8L" })).toBe("Landed, runway 8L");
    expect(describe({ kind: "in", at: 0, place: { kind: "stand", ref: "301" } })).toBe("In at stand 301");
    expect(describe({ kind: "seen", at: 0, activity: "Final approach", runway: "8L" })).toBe("First seen: Final approach, runway 8L");
  });
});

group("citeProcedure", () => {
  it("cites a procedure as the flight card prints it, saying when it is a guess", () => {
    expect(citeProcedure({ kind: "approach", name: "ILS RWY 8L", cycle: "2610", likely: false })).toBe("Approach: ILS RWY 8L, from FAA CIFP cycle 2610");
    expect(citeProcedure({ kind: "approach", name: "ILS RWY 8L", cycle: "2610", likely: true })).toBe("Likely approach: ILS RWY 8L, from FAA CIFP cycle 2610");
    expect(citeProcedure({ kind: "climb-out", name: "CUTTN2", cycle: "2610", likely: true })).toBe("Likely climb-out: CUTTN2 departure, from FAA CIFP cycle 2610");
    expect(citeProcedure({ kind: "no-sid", name: "", cycle: "2610", likely: false })).toBe("Climb-out: extended centreline, as FAA CIFP cycle 2610 has no SID for this airport");
  });
});
