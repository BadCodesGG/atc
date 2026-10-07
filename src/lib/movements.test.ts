import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import { activeMovements, movementsFoot } from "./movements";
import { Tracker } from "./tracker";
import { parseTraffic } from "./traffic";
import { fixtureTime, TrafficView } from "./traffic-view";

const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;
const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "__fixtures__/adsblol_atl.json"), "utf8"));

function fixtureFrame() {
  const snapshot = parseTraffic(raw, DEFAULT_AIRPORT);
  const tracker = new Tracker();
  tracker.add(snapshot);
  return new TrafficView(map, DEFAULT_AIRPORT).frame(tracker.at(fixtureTime(snapshot)));
}

describe("activeMovements on the ATL fixture", () => {
  it("lists the runway traffic first, lowest first, then the taxiing aircraft by callsign", () => {
    const { rows } = activeMovements(fixtureFrame().entries, null, 6);
    expect(rows.map((r) => r.callsign)).toEqual(["DAL3104", "RPA4349", "DAL524", "A40694", "ASH4036", "DAL1153"]);
  });

  it("counts every other moving aircraft in the footer, and the aircraft at gates", () => {
    const { rows, more, atGates } = activeMovements(fixtureFrame().entries, null, 5);
    // 23 moving in the fixture (TrafficView's counts), 3 parked at gates.
    expect(rows).toHaveLength(5);
    expect(more).toBe(18);
    expect(atGates).toBe(3);
  });

  it("words each row: type, a short phrase, a state tag with the runway, and speed", () => {
    const rows = new Map(activeMovements(fixtureFrame().entries, null, 30).rows.map((r) => [r.callsign, r]));
    expect(rows.get("DAL3104")).toMatchObject({ type: "A321", phrase: "Landing", tag: "ARR 9R", state: "arriving", speed: "150 kt" });
    expect(rows.get("RPA4349")).toMatchObject({ type: "E170", phrase: "Final 500 ft", tag: "ARR 8L" });
    expect(rows.get("DAL524")).toMatchObject({ phrase: "Climbing out 1,500 ft", tag: "DEP 9L", state: "departing" });
    expect(rows.get("DAL1099")).toMatchObject({ phrase: "Inbound 1,800 ft", tag: "ARR" });
    // Taxiing: the way it is heading, on an eight-point compass.
    expect(rows.get("EDV5051")).toMatchObject({ type: "CRJ9", phrase: "Westbound", tag: "TAXI", state: "taxiing", speed: "19 kt" });
    expect(rows.get("A40694")).toMatchObject({ phrase: "Northbound" });
    expect(rows.get("DAL1182")).toMatchObject({ phrase: "Southwest" });
    expect(rows.get("DAL753")).toMatchObject({ phrase: "Crossing 8R/26L", tag: "TAXI" });
  });
});

describe("activeMovements selection", () => {
  const entries = fixtureFrame().entries;
  const idOf = (callsign: string) => entries.find((e) => e.aircraft.callsign === callsign)!.aircraft.id;

  it("marks the selected aircraft's row, and only that one", () => {
    const { rows } = activeMovements(entries, idOf("RPA4349"), 5);
    expect(rows.filter((r) => r.selected).map((r) => r.callsign)).toEqual(["RPA4349"]);
  });

  it("keeps a selected aircraft beyond the cut in view, in the last row, without changing the total", () => {
    const { rows, more } = activeMovements(entries, idOf("UAL2806"), 5);
    expect(rows.map((r) => r.callsign)).toEqual(["DAL3104", "RPA4349", "DAL524", "A40694", "UAL2806"]);
    expect(rows[4].selected).toBe(true);
    expect(rows.length + more).toBe(23);
  });

  it("adds no row for a selected aircraft that is not moving", () => {
    const { rows } = activeMovements(entries, idOf("DAL294"), 5);
    expect(rows.map((r) => r.callsign)).toEqual(["DAL3104", "RPA4349", "DAL524", "A40694", "ASH4036"]);
    expect(rows.some((r) => r.selected)).toBe(false);
  });

  it("names no direction for an aircraft whose heading was never reported", () => {
    const e = entries.find((x) => x.aircraft.callsign === "EDV5051")!;
    const unknown = { ...e, aircraft: { ...e.aircraft, headingKnown: false } };
    expect(activeMovements([unknown], null, 5).rows[0].phrase).toBe("Taxiing");
  });
});

describe("movementsFoot", () => {
  it("says what is left over, leaving out a part that would read zero", () => {
    expect(movementsFoot({ more: 18, atGates: 3 })).toBe("+ 18 more moving · 3 at gates");
    expect(movementsFoot({ more: 4, atGates: 0 })).toBe("+ 4 more moving");
    expect(movementsFoot({ more: 0, atGates: 7 })).toBe("7 at gates");
    expect(movementsFoot({ more: 0, atGates: 0 })).toBeNull();
  });
});
