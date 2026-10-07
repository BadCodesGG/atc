import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { airportByCode } from "./airports";
import { toLocal } from "./geo";
import type { HexSnapshot } from "./hex";
import { journeyAnswer, journeyPlan, paceAt, readSilences, recordJourney, rounded, sampleAt, sampleDistance, WarpClock, withRoute } from "./journey-fixture";
import type { TrafficSnapshot } from "./traffic";

const load = (code: string) => JSON.parse(readFileSync(path.join(import.meta.dirname, `../data/airports/${code}.json`), "utf8")) as AirportMap;
const ATL = airportByCode("atl")!;
const CLT = airportByCode("clt")!;
const atlMap = load("atl");
const cltMap = load("clt");
const rec = recordJourney(journeyPlan({ airport: ATL, map: atlMap }, { airport: CLT, map: cltMap }));
const { samples } = rec;
const near = (a: { x: number; y: number } | [number, number], b: [number, number]) => Math.hypot(("x" in a ? a.x : a[0]) - b[0], ("x" in a ? a.y : a[1]) - b[1]);
const local = (airport: typeof ATL, s: { latitude: number; longitude: number }) => toLocal(airport, s.latitude, s.longitude);
const gate = (map: AirportMap, ref: string) => map.gates.find((g) => g.ref === ref)!;

describe("rounded", () => {
  it("turns a right angle into an arc of the radius asked, tangent to both legs", () => {
    const arc = rounded([[0, 0], [0, 1000], [1000, 1000]], 100);
    expect(arc[0]).toEqual([0, 0]);
    expect(arc.at(-1)).toEqual([1000, 1000]);
    // The arc starts 100 m before the corner and ends 100 m after it, and every point on it is 100 m from its centre.
    expect(near(arc[1], [0, 900])).toBeLessThan(1e-6);
    expect(near(arc.at(-2)!, [100, 1000])).toBeLessThan(1e-6);
    for (const p of arc.slice(1, -1)) expect(near(p, [100, 900])).toBeCloseTo(100, 6);
  });
});

describe("recordJourney", () => {
  it("records one second at a time, gate to gate, in under an hour and a half", () => {
    for (let i = 1; i < samples.length; i++) expect(samples[i].t - samples[i - 1].t).toBeCloseTo(1, 6);
    const minutes = (samples.at(-1)!.t - samples[0].t) / 60;
    expect(minutes).toBeGreaterThan(40);
    expect(minutes).toBeLessThan(90);
  });

  it("starts parked at Atlanta's gate A34 and ends parked at Charlotte's A26", () => {
    expect(near(local(ATL, samples[0]), [gate(atlMap, "A34").x, gate(atlMap, "A34").y])).toBeLessThan(1);
    expect(samples[0]).toMatchObject({ onGround: true, groundSpeedKt: 0, altitudeFt: ATL.elevationFt });
    const last = samples.at(-1)!;
    expect(near(local(CLT, last), [gate(cltMap, "A26").x, gate(cltMap, "A26").y])).toBeLessThan(1);
    expect(last).toMatchObject({ onGround: true, groundSpeedKt: 0, altitudeFt: CLT.elevationFt });
  });

  it("pushes back, nose to the gate, before it taxis", () => {
    const pushed = samples.filter((s) => s.pushback && s.groundSpeedKt > 0.5);
    expect(pushed.length).toBeGreaterThan(10);
    expect(Math.max(...pushed.map((s) => s.groundSpeedKt))).toBeLessThan(4);
  });

  it("lifts off from 8R, flies at taxi, climb and cruise speeds a jet does, and lands on 1L", () => {
    const airborne = samples.filter((s) => !s.onGround);
    const first = samples.indexOf(airborne[0]);
    const lastUp = samples.indexOf(airborne.at(-1)!);
    // Lift-off along 8R (y = 1122 m in Atlanta's map), touchdown on 1L's centreline, from (-2017, -1488) to (-2209, 1256).
    expect(Math.abs(local(ATL, samples[first])[1] - 1122)).toBeLessThan(5);
    const [x, y] = local(CLT, samples[lastUp + 1]);
    const u = ((x + 2017) * -192 + (y + 1488) * 2744) / (192 ** 2 + 2744 ** 2);
    expect(Math.hypot(x - (-2017 - 192 * u), y - (-1488 + 2744 * u))).toBeLessThan(5);
    expect(u).toBeGreaterThan(0);
    expect(u).toBeLessThan(0.3);
    expect(Math.max(...airborne.map((s) => s.altitudeFt))).toBe(29_000);
    expect(Math.max(...airborne.map((s) => s.groundSpeedKt))).toBeCloseTo(440, 0);
    const taxiing = samples.filter((s) => s.onGround && (s.t < samples[first].t - 40 || s.t > samples[lastUp].t + 60));
    expect(Math.max(...taxiing.map((s) => s.groundSpeedKt))).toBeLessThan(19);
    // A sane vertical rate throughout: never more than a jet climbs or descends.
    expect(Math.max(...airborne.map((s) => Math.abs(s.verticalRateFpm)))).toBeLessThan(3200);
  });

  it("never moves more than a jet can in a second, so nothing in it jumps", () => {
    for (let i = 1; i < samples.length; i++) {
      const [x0, y0] = local(ATL, samples[i - 1]);
      const [x1, y1] = local(ATL, samples[i]);
      expect(Math.hypot(x1 - x0, y1 - y0)).toBeLessThan(240);
    }
  });
});

describe("readSilences", () => {
  it("reads windows in seconds into the recording, a negative one back from its end, and an open one as for ever", () => {
    expect(readSilences("100:160", 1000, 5000)).toEqual([{ from: 1100, to: 1160 }]);
    expect(readSilences("-30:", 1000, 5000)).toEqual([{ from: 4970, to: Infinity }]);
    expect(readSilences("10:20, -60:-40", 1000, 5000)).toEqual([{ from: 1010, to: 1020 }, { from: 4940, to: 4960 }]);
  });

  it("leaves out what is not a window, and has none without the parameter", () => {
    expect(readSilences(null, 0, 10)).toEqual([]);
    expect(readSilences("soon,5", 0, 10)).toEqual([]);
  });
});

describe("journeyAnswer", () => {
  const at = (i: number) => samples[i].t;
  const airborne = samples.findIndex((s) => !s.onGround);

  it("answers Atlanta's traffic with the flight and its route while it is within 40 km, through the traffic parser", () => {
    const answer = journeyAnswer(rec, "/api/traffic/atl", at(0)) as TrafficSnapshot;
    expect(answer.aircraft).toHaveLength(1);
    expect(answer.aircraft[0]).toMatchObject({ id: "a4c2e7", callsign: "DAL1947", onGround: true, altitudeFt: 0 });
    expect(answer.routes?.DAL1947).toMatchObject({ origin: { code: "ATL" }, destination: { code: "CLT" } });
    const away = samples.findIndex((s, i) => i > airborne && Math.hypot(...local(ATL, s)) > 41_000);
    expect((journeyAnswer(rec, "/api/traffic/atl", at(away)) as TrafficSnapshot).aircraft).toHaveLength(0);
  });

  it("answers the one aircraft by hex anywhere on the way", () => {
    const mid = samples.findIndex((s) => s.altitudeFt === 29_000);
    const answer = journeyAnswer(rec, "/api/hex/a4c2e7", at(mid)) as HexSnapshot;
    expect(answer.aircraft).toMatchObject({ id: "a4c2e7", callsign: "DAL1947", altitudeFt: 29_000 });
    expect((journeyAnswer(rec, "/api/hex/abcdef", at(mid)) as HexSnapshot).aircraft).toBeNull();
  });

  it("can answer as if no route were known, or as if bound for an airport not built, the track unchanged", () => {
    const none = withRoute(rec, "none");
    expect((journeyAnswer(none, "/api/traffic/atl", at(0)) as TrafficSnapshot).routes).toEqual({});
    expect(journeyAnswer(none, "/api/flight/DAL1947", at(airborne))).toMatchObject({ route: null });
    const unbuilt = withRoute(rec, "unbuilt");
    expect(journeyAnswer(unbuilt, "/api/flight/DAL1947", at(airborne))).toMatchObject({ route: { origin: { code: "ATL" }, destination: { code: "GSP" } } });
    expect(unbuilt.samples).toBe(rec.samples);
  });

  it("answers the flight lookup with the route, and nothing for other paths", () => {
    expect(journeyAnswer(rec, "/api/flight/DAL1947", at(airborne))).toMatchObject({ callsign: "DAL1947", route: { destination: { code: "CLT" } } });
    expect(journeyAnswer(rec, "/api/traffic/pit", at(0))).toBeNull();
    expect(journeyAnswer(rec, "/api/status", at(0))).toBeNull();
  });

  it("can fall silent as a transponder does: the last position goes on being listed, a little older each second, until the feeds drop it past a minute", () => {
    const from = samples[100].t;
    const silent = [{ from, to: Infinity }];
    const aircraft = (path: string, t: number) => {
      const answer = journeyAnswer(rec, path, t, {}, silent) as TrafficSnapshot | HexSnapshot;
      return "aircraft" in answer && !Array.isArray(answer.aircraft) ? (answer as HexSnapshot).aircraft : (answer as TrafficSnapshot).aircraft[0] ?? null;
    };
    // Before: current. Just after: the same position, listed 10 s old (the parsers keep it up to a minute). Past it: gone from both feeds.
    expect(aircraft("/api/traffic/atl", from - 5)).toMatchObject({ positionAge: 0 });
    const held = aircraft("/api/traffic/atl", from + 10);
    expect(held).toMatchObject({ positionAge: 10, latitude: expect.closeTo(samples[100].latitude, 5) });
    expect(aircraft("/api/hex/a4c2e7", from + 10)).toMatchObject({ positionAgeS: 10, latitude: expect.closeTo(samples[100].latitude, 5) });
    expect(aircraft("/api/traffic/atl", from + 61)).toBeNull();
    expect(aircraft("/api/hex/a4c2e7", from + 61)).toBeNull();
  });

  it("falls silent only for the window given, and comes back where the flight has got to", () => {
    const silent = [{ from: samples[100].t, to: samples[160].t }];
    const back = journeyAnswer(rec, "/api/traffic/atl", samples[170].t, {}, silent) as TrafficSnapshot;
    expect(back.aircraft[0]).toMatchObject({ positionAge: 0, latitude: expect.closeTo(samples[170].latitude, 5) });
  });

  it("reads between recorded seconds", () => {
    const s = sampleAt(rec, at(airborne + 100) + 0.5);
    expect(s.altitudeFt).toBeGreaterThan(samples[airborne + 100].altitudeFt);
    expect(s.altitudeFt).toBeLessThan(samples[airborne + 101].altitudeFt);
  });
});

describe("WarpClock", () => {
  it("plays the whole journey in about two minutes", () => {
    const clock = new WarpClock(rec);
    expect(clock.duration).toBeGreaterThan(90);
    expect(clock.duration).toBeLessThan(160);
    expect(clock.at(0)).toBe(samples[0].t);
    expect(clock.at(clock.duration)).toBeCloseTo(samples.at(-1)!.t, 2);
  });

  it("runs slowest through the hands between the diorama and the map, and fastest at cruise", () => {
    expect(paceAt(20_000)).toBeCloseTo(8, 6);
    expect(paceAt(400_000)).toBe(120);
    expect(paceAt(1_400)).toBe(15);
    const clock = new WarpClock(rec);
    const cruise = samples.findIndex((s) => sampleDistance(rec, s) >= 400_000);
    const w = (t: number) => {
      let lo = 0;
      let hi = 1000;
      for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (clock.at(mid) < t) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    expect(1 / (w(samples[cruise + 1].t) - w(samples[cruise].t))).toBeCloseTo(120, 0);
  });

  it("starts part way in, and plays slower when asked", () => {
    expect(new WarpClock(rec, { from: 600 }).at(0)).toBeCloseTo(samples[600].t, 2);
    expect(new WarpClock(rec, { speed: 0.5 }).duration).toBeCloseTo(2 * new WarpClock(rec).duration, 6);
  });

  it("is steady: never runs backwards", () => {
    const clock = new WarpClock(rec);
    let prev = -Infinity;
    for (let w = 0; w < clock.duration + 5; w += 0.05) {
      const t = clock.at(w);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
