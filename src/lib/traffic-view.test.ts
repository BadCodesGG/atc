import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import { Tracker } from "./tracker";
import { parseTraffic } from "./traffic";
import { fixtureTime, TrafficView } from "./traffic-view";

const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;
const raw = JSON.parse(readFileSync(path.join(import.meta.dirname, "__fixtures__/adsblol_atl.json"), "utf8"));

function fixtureFrame() {
  const snapshot = parseTraffic(raw, DEFAULT_AIRPORT);
  const tracker = new Tracker();
  tracker.add(snapshot);
  const view = new TrafficView(map, DEFAULT_AIRPORT);
  return { snapshot, frame: view.frame(tracker.at(fixtureTime(snapshot))) };
}

describe("fixtureTime", () => {
  it("shows every aircraft in the snapshot, fully faded in", () => {
    const { snapshot, frame } = fixtureFrame();
    expect(frame.entries).toHaveLength(snapshot.aircraft.length);
    expect(frame.entries.every((e) => e.aircraft.fade === 1)).toBe(true);
  });
});

describe("TrafficView on the ATL fixture", () => {
  it("counts the snapshot the same way every time", () => {
    const a = fixtureFrame().frame.counts;
    const b = fixtureFrame().frame.counts;
    expect(a).toEqual(b);
    expect(a).toEqual({ tracked: 29, onGround: 18, moving: 23 });
  });

  it("opens on the A321 crossing the 9R threshold, landing", () => {
    const { frame } = fixtureFrame();
    expect(frame.featured?.card).toMatchObject({
      callsign: "DAL3104",
      operator: "Delta · Airbus A321",
      state: "arriving",
      headline: "Landing, runway 9R",
      tag: "Landing · 150 kt",
      speed: "150 kt",
      heading: "090°",
    });
  });

  it("dead-reckons a ground aircraft along its reported heading and colours it taxiing", () => {
    const { frame, snapshot } = fixtureFrame();
    const e = frame.entries.find((x) => x.aircraft.callsign === "DAL2825")!;
    const reported = snapshot.aircraft.find((x) => x.callsign === "DAL2825")!;
    // 14.2 kt due west for the 1.358 s fix age plus the 2 s past the snapshot.
    expect(e.scene.x).toBeCloseTo(reported.x - 14.2 * (1852 / 3600) * 3.358, 1);
    expect(e.scene.y).toBeCloseTo(reported.y, 1);
    expect(e.scene).toMatchObject({ state: "taxiing", headingDeg: 270 });
  });

  it("gives the landing aircraft's height above the field, never below it, in ft AGL", () => {
    // DAL3104 reports 870 ft barometric over a 1026 ft field: below the field, so it reads 0.
    const { frame } = fixtureFrame();
    expect(frame.featured?.card.altitude).toBe("0 ft AGL");
  });

  it("gives an aircraft in the air its height above the field, to the nearest 10 ft", () => {
    const { frame } = fixtureFrame();
    // 1550 ft reported, field 1026 ft, 832 ft/min descent over 2.955 s: 483 ft.
    expect(frame.entries.find((x) => x.aircraft.callsign === "RPA4349")!.card.altitude).toBe("480 ft AGL");
  });

  it("says Ground for an aircraft on the ground", () => {
    const { frame } = fixtureFrame();
    expect(frame.entries.find((x) => x.aircraft.callsign === "DAL2825")!.card.altitude).toBe("Ground");
  });

  it("keeps every ground aircraft within a few seconds' taxi of its last fix", () => {
    const { frame, snapshot } = fixtureFrame();
    for (const e of frame.entries.filter((x) => x.aircraft.onGround)) {
      const fix = snapshot.aircraft.find((a) => a.id === e.aircraft.id)!;
      // EDV5051's fix was 42 s old at 18.5 kt: carried on for all of it, it sat 417 m away.
      expect(Math.hypot(e.scene.x - fix.x, e.scene.y - fix.y)).toBeLessThan(80);
    }
  });

  it("puts an aircraft in the air at its height above the field, in metres", () => {
    const { frame } = fixtureFrame();
    const e = frame.entries.find((x) => x.aircraft.callsign === "RPA4349")!;
    // 1550 ft reported, field 1026 ft, 832 ft/min descent over the 2.955 s of extrapolation.
    expect(e.scene.heightM).toBeCloseTo((1550 - 832 * (2.955 / 60) - 1026) * 0.3048, 0);
  });
});

describe("TrafficView with a ground aircraft that never sent a heading", () => {
  it("lines it up with the taxiway under it and draws it without a trail", () => {
    const view = new TrafficView(map, DEFAULT_AIRPORT);
    const taxiway = map.taxiways.find((t) => t.line.length >= 2 && Math.hypot(t.line[1][0] - t.line[0][0], t.line[1][1] - t.line[0][1]) > 100)!;
    const [[ax, ay], [bx, by]] = taxiway.line;
    const bearing = ((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360;
    const [x, y] = [(ax + bx) / 2, (ay + by) / 2];
    const { entries } = view.frame([
      { id: "a", x, y, altitudeFt: 0, headingDeg: 0, headingKnown: false, groundSpeedKt: 12, onGround: true, verticalRateFpm: null, callsign: null, typeCode: null, military: false, category: null, fade: 1 },
    ]);
    expect(entries[0].scene.headingDeg).toBeCloseTo(bearing, 0);
    expect(entries[0].scene.speedMps).toBe(0);
    expect(entries[0].card.heading).toBe("—");
  });
});

describe("TrafficView keeps ground aircraft on the pavement", () => {
  /** One 20 m taxiway running north, and nothing else. */
  const plan = {
    ...map,
    runways: [],
    aprons: [],
    gates: [],
    stands: [],
    taxiways: [{ ref: "A", width: 20, kind: "taxiway" as const, line: [[0, 0], [0, 2000]] as [number, number][] }],
  };
  const at = (x: number, y: number, onGround: boolean) =>
    new TrafficView(plan, DEFAULT_AIRPORT).frame([
      { id: "a", x, y, altitudeFt: onGround ? 0 : 3000, headingDeg: 0, headingKnown: true, groundSpeedKt: 15, onGround, verticalRateFpm: null, callsign: null, typeCode: null, military: false, category: null, fade: 1 },
    ]).entries[0];

  it("moves a ground aircraft beside the taxiway onto its edge", () => {
    const e = at(60, 1000, true);
    expect(e.scene.x).toBeCloseTo(10);
    expect(e.scene.y).toBeCloseTo(1000);
  });

  it("eases across when the nearest pavement changes, instead of jumping between taxiways", () => {
    // Two taxiways 100 m apart; an aircraft between them, closer to the west one, then to the east one.
    const two = { ...plan, taxiways: [...plan.taxiways, { ref: "B", width: 20, kind: "taxiway" as const, line: [[100, 0], [100, 2000]] as [number, number][] }] };
    const view = new TrafficView(two, DEFAULT_AIRPORT);
    const xAt = (x: number) =>
      view.frame([{ id: "a", x, y: 1000, altitudeFt: 0, headingDeg: 0, headingKnown: true, groundSpeedKt: 15, onGround: true, verticalRateFpm: null, callsign: null, typeCode: null, military: false, category: null, fade: 1 }])
        .entries[0].scene.x;
    expect(xAt(49)).toBeCloseTo(10);
    // The east taxiway's edge is 80 m away from the west one's: no frame covers that in one go.
    expect(xAt(51) - 10).toBeLessThan(20);
    let x = 0;
    for (let i = 0; i < 120; i++) x = xAt(51);
    expect(x).toBeCloseTo(90, 1);
  });

  it("leaves one on the taxiway, one in the air, and one far from any mapped pavement alone", () => {
    expect(at(5, 1000, true).scene).toMatchObject({ x: 5, y: 1000 });
    expect(at(60, 1000, false).scene).toMatchObject({ x: 60, y: 1000 });
    expect(at(3000, 1000, true).scene).toMatchObject({ x: 3000, y: 1000 });
  });
});

describe("TrafficView route, direction and gate", () => {
  const e15 = map.gates.find((g) => g.ref === "E15")!;
  const at = (x: number, y: number, speed: number, callsign = "DAL1") =>
    ({ id: "a", x, y, altitudeFt: 0, headingDeg: 0, headingKnown: true, groundSpeedKt: speed, onGround: true, verticalRateFpm: null, callsign, typeCode: null, military: false, category: null, fade: 1 }) as const;
  const end = (code: string) => ({ code, city: code, country: "US" });

  it("shows the gate a parked aircraft is at, and the one a departure left once it moves", () => {
    const view = new TrafficView(map, DEFAULT_AIRPORT);
    view.addRoutes({ DAL1: { origin: end("ATL"), destination: end("PHX") } });
    const parked = view.frame([at(e15.x, e15.y, 0)]).entries[0].card;
    expect(parked.gate).toEqual({ kind: "gate", ref: "E15", left: false });
    expect(parked.direction).toBe("outbound");
    const moving = view.frame([at(e15.x + 400, e15.y, 12)]).entries[0].card;
    expect(moving.gate).toEqual({ kind: "gate", ref: "E15", left: true });
  });

  it("does not say an arrival left a gate it only paused beside on the way in", () => {
    const view = new TrafficView(map, DEFAULT_AIRPORT);
    view.addRoutes({ DAL1: { origin: end("PHX"), destination: end("ATL") } });
    view.frame([at(e15.x, e15.y, 0)]);
    const moving = view.frame([at(e15.x + 400, e15.y, 12)]).entries[0].card;
    expect(moving.direction).toBe("inbound");
    expect(moving.gate).toBeNull();
  });

  it("without a route, says a flight left a gate only if it was parked there when first seen", () => {
    const parkedFirst = new TrafficView(map, DEFAULT_AIRPORT);
    parkedFirst.frame([at(e15.x, e15.y, 0, "N1")]);
    expect(parkedFirst.frame([at(e15.x + 400, e15.y, 12, "N1")]).entries[0].card.gate).toEqual({ kind: "gate", ref: "E15", left: true });

    const taxiedIn = new TrafficView(map, DEFAULT_AIRPORT);
    taxiedIn.frame([at(e15.x + 400, e15.y, 12, "N1")]);
    taxiedIn.frame([at(e15.x, e15.y, 0, "N1")]);
    expect(taxiedIn.frame([at(e15.x + 400, e15.y, 12, "N1")]).entries[0].card.gate).toBeNull();
  });

  it("keeps a route it was sent once, and knows nothing of a callsign it was never sent", () => {
    const view = new TrafficView(map, DEFAULT_AIRPORT);
    view.addRoutes({ DAL1: { origin: end("ATL"), destination: end("PHX") } });
    view.addRoutes(undefined);
    expect(view.frame([at(0, 0, 12)]).entries[0].card.route?.destination.code).toBe("PHX");
    expect(view.frame([at(0, 0, 12, "DAL2")]).entries[0].card.route).toBeNull();
  });
});
