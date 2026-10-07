import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadAirportMap } from "./airport-data";
import type { AirportMap, Taxiway } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import { FEET } from "./geo";
import { History } from "./history";
import { Pavement } from "./pavement";
import { readSequence } from "./sequence";
import { GroundPaths } from "./taxi-route";
import { type TrailHead, TrailFeed, type TrailPoint } from "./timelapse";
import type { Aircraft, TrafficSnapshot } from "./traffic";

function aircraft(id: string, x: number, y: number, extra: Partial<Aircraft> = {}): Aircraft {
  return {
    id,
    callsign: null,
    registration: null,
    typeCode: null,
    military: false,
    category: null,
    latitude: 0,
    longitude: 0,
    x,
    y,
    altitudeFt: 1000,
    onGround: false,
    groundSpeedKt: null,
    trackDeg: null,
    verticalRateFpm: null,
    positionAge: 0,
    source: "adsb_icao",
    squawk: null,
    ...extra,
  };
}

const snapshot = (time: number, ...list: Aircraft[]): TrafficSnapshot => ({ airport: "atl", time, aircraft: list });

function recorded(...list: TrafficSnapshot[]): History {
  const history = new History();
  for (const s of list) history.add(s);
  return history;
}

const ELEVATION = 1000;
const xs = (points: TrailPoint[]) => points.map((p) => p.x);

describe("TrailFeed", () => {
  const eastbound = () => recorded(...[0, 10, 20, 30, 40].map((t) => snapshot(t, aircraft("a", 100 * t, 0))));

  it("hands over each fix once, oldest first, as the picture passes it", () => {
    const feed = new TrailFeed(eastbound(), { elevationFt: ELEVATION });
    const first = feed.update(25, 20, []);
    // The window is 5..25: the fix at 0 is too old, 30 and 40 have not happened yet.
    expect(first.reset).toBe(true);
    expect(xs(first.added)).toEqual([1000, 2000]);
    expect(first.added.map((p) => p.t)).toEqual([10, 20]);
    const next = feed.update(31, 20, []);
    expect(next.reset).toBe(false);
    expect(xs(next.added)).toEqual([3000]);
    expect(feed.update(32, 20, []).added).toEqual([]);
  });

  it("starts again from the history when the picture goes back, jumps past the window, or the window changes", () => {
    const feed = new TrailFeed(eastbound(), { elevationFt: ELEVATION });
    feed.update(35, 40, []);
    const back = feed.update(12, 40, []);
    expect(back.reset).toBe(true);
    expect(xs(back.added)).toEqual([0, 1000]);
    expect(feed.update(40, 20, []).reset).toBe(true);
  });

  it("keeps one run per aircraft, and starts a new one after a long silence", () => {
    const history = recorded(
      snapshot(0, aircraft("a", 0, 0), aircraft("b", 0, 500)),
      snapshot(10, aircraft("a", 1000, 0), aircraft("b", 1000, 500)),
      snapshot(200, aircraft("a", 20_000, 0)),
      snapshot(210, aircraft("a", 21_000, 0)),
    );
    const { added } = new TrailFeed(history, { elevationFt: ELEVATION }).update(210, 300, []);
    const runs = new Map<number, number[]>();
    for (const p of added) runs.set(p.run, [...(runs.get(p.run) ?? []), p.x]);
    expect([...runs.values()]).toEqual([[0, 1000], [0, 1000], [20_000, 21_000]]);
  });

  it("colours the ground in taxi, a climb as a departure and a descent as an arrival", () => {
    const history = recorded(
      snapshot(0, aircraft("d", 0, 0, { onGround: true, altitudeFt: 0 }), aircraft("r", 0, 0, { altitudeFt: 3000, verticalRateFpm: -800 })),
      snapshot(10, aircraft("d", 500, 0, { altitudeFt: 1400, verticalRateFpm: 2000 }), aircraft("r", 0, 600, { altitudeFt: 2600 })),
      snapshot(20, aircraft("d", 1500, 0, { altitudeFt: 2400 }), aircraft("r", 0, 1200, { altitudeFt: 2200, verticalRateFpm: 0 })),
    );
    const { added } = new TrailFeed(history, { elevationFt: ELEVATION }).update(20, 60, []);
    const [d, r] = [...new Set(added.map((p) => p.run))].map((run) => added.filter((p) => p.run === run).map((p) => p.state));
    expect(d).toEqual(["taxiing", "departing", "departing"]);
    expect(r).toEqual(["arriving", "arriving", "arriving"]);
  });

  it("draws airborne fixes at their height above the field", () => {
    const history = recorded(snapshot(0, aircraft("a", 0, 0, { altitudeFt: 2000 })), snapshot(10, aircraft("a", 900, 0, { altitudeFt: 3000 })));
    const { added } = new TrailFeed(history, { elevationFt: ELEVATION }).update(10, 60, []);
    expect(added.map((p) => p.h)).toEqual([1000 * FEET, 2000 * FEET]);
  });

  it("hands over a fix repeated in snapshot after snapshot once", () => {
    const parked = (t: number) => aircraft("p", 40, 60, { onGround: true, altitudeFt: 0, positionAge: 20 + t });
    const { added } = new TrailFeed(recorded(...[0, 5, 10, 15].map((t) => snapshot(t, parked(t)))), { elevationFt: ELEVATION }).update(15, 60, []);
    expect(added).toHaveLength(1);
  });

  it("runs a taxi trail along the taxiways between fixes, its times spread along the way", () => {
    const ways: Taxiway[] = [
      { ref: "A", width: 20, kind: "taxiway", line: [[0, 0], [1000, 0]] },
      { ref: "B", width: 20, kind: "taxiway", line: [[1000, 0], [1000, 1000]] },
    ];
    const ground = new GroundPaths({ taxiways: ways, runways: [], aprons: [] });
    const taxi = (x: number, y: number) => aircraft("t", x, y, { onGround: true, altitudeFt: 0 });
    const history = recorded(snapshot(0, taxi(900, 0)), snapshot(20, taxi(1000, 100)));
    const { added } = new TrailFeed(history, { elevationFt: ELEVATION, ground }).update(20, 60, []);
    const corner = added.find((p) => Math.hypot(p.x - 1000, p.y) < 1);
    expect(corner).toBeDefined();
    // 100 m to the corner and 100 m beyond: the corner is passed halfway through.
    expect(corner!.t).toBeCloseTo(10);
    const times = added.map((p) => p.t);
    expect(times).toEqual([...times].sort((p, q) => p - q));
    expect(added.at(-1)).toMatchObject({ x: 1000, y: 100, t: 20 });
  });

  it("does not join a ground position that jumps farther than the aircraft could have moved", () => {
    // A parked A321 in the recording whose broadcast position wanders hundreds of metres every 15 s.
    const parked = (x: number) => aircraft("p", x, 0, { onGround: true, altitudeFt: 0, groundSpeedKt: 0 });
    const rolling = (x: number) => aircraft("r", x, 500, { onGround: true, altitudeFt: 0, groundSpeedKt: 120 });
    const history = recorded(snapshot(0, parked(0), rolling(0)), snapshot(15, parked(700), rolling(900)), snapshot(30, parked(660)));
    const { added } = new TrailFeed(history, { elevationFt: ELEVATION }).update(30, 60, []);
    const run = (id: number) => added.filter((p) => p.run === id).length;
    // Nor a smaller jump by an aircraft that says it is standing still.
    expect(added.filter((p) => p.y === 0).map((p) => run(p.run))).toEqual([1, 1, 1]);
    // A landing roll covers as much, and is one run.
    expect(added.filter((p) => p.y === 500).map((p) => run(p.run))).toEqual([2, 2]);
  });

  it("joins each aircraft's trail to where it is drawn now", () => {
    const head: TrailHead = { id: "a", x: 2600, y: 0, heightM: 30, state: "departing" };
    const { heads } = new TrailFeed(eastbound(), { elevationFt: ELEVATION }).update(26, 20, [head, { ...head, id: "nobody" }]);
    expect(heads).toHaveLength(1);
    expect(heads[0][0]).toMatchObject({ x: 2000, t: 20 });
    expect(heads[0].at(-1)).toMatchObject({ x: 2600, y: 0, h: 30, t: 26, state: "departing" });
  });

  it("runs a taxiing aircraft's head along the taxiways too", () => {
    const ways: Taxiway[] = [
      { ref: "A", width: 20, kind: "taxiway", line: [[0, 0], [1000, 0]] },
      { ref: "B", width: 20, kind: "taxiway", line: [[1000, 0], [1000, 1000]] },
    ];
    const ground = new GroundPaths({ taxiways: ways, runways: [], aprons: [] });
    const history = recorded(snapshot(0, aircraft("t", 900, 0, { onGround: true, altitudeFt: 0, groundSpeedKt: 15 })));
    const head: TrailHead = { id: "t", x: 1000, y: 100, heightM: 0, state: "taxiing" };
    const { heads } = new TrailFeed(history, { elevationFt: ELEVATION, ground }).update(20, 60, [head]);
    expect(heads[0].some((p) => Math.hypot(p.x - 1000, p.y) < 1)).toBe(true);
  });

  it("keeps the recorded sequence's taxi trails on ATL's pavement, between fixes as well as at them", async () => {
    const map = (await loadAirportMap("atl")) as AirportMap;
    const bytes = readFileSync(path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz"));
    const snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
    const feed = new TrailFeed(recorded(...snapshots), { elevationFt: DEFAULT_AIRPORT.elevationFt, ground: new GroundPaths(map) });
    const { added } = feed.update(snapshots.at(-1)!.time, 3600, []);
    const pavement = new Pavement(map);
    const off: number[] = [];
    for (let i = 1; i < added.length; i++) {
      const [a, b] = [added[i - 1], added[i]];
      if (a.run !== b.run || !a.onGround || !b.onGround) continue;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
      for (let k = 0; k <= n; k++) off.push(pavement.nearest(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, 1000)?.distance ?? 1000);
    }
    expect(off.length).toBeGreaterThan(500);
    // Taxiway centrelines are mapped a little off the paved strips in places; the grass between taxiways is 100 m and more.
    expect(off.filter((d) => d > 5).length / off.length).toBeLessThan(0.01);
    expect(Math.max(...off)).toBeLessThan(25);
  });

  it("starts again from the history once it has handed over more points than the trails can hold", () => {
    const feed = new TrailFeed(recorded(...Array.from({ length: 50 }, (_, i) => snapshot(10 * i, aircraft("a", 100 * i, 0)))), { elevationFt: ELEVATION, capacity: 10 });
    let resets = 0;
    let held = 0;
    for (let picture = 0; picture < 490; picture += 10) {
      const u = feed.update(picture, 60, []);
      if (u.reset) {
        resets++;
        held = 0;
      }
      held += u.added.length;
      expect(held).toBeLessThanOrEqual(10);
    }
    expect(resets).toBeGreaterThan(2);
  });
});
