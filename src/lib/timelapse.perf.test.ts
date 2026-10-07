import { describe, expect, it } from "vitest";
import { loadAirportMap } from "./airport-data";
import { DEFAULT_AIRPORT } from "./airports";
import { History } from "./history";
import { TrailStrips } from "./scene/light-trails";
import { GroundPaths } from "./taxi-route";
import { type TrailHead, TrailFeed, TRAIL_POINTS } from "./timelapse";
import type { Aircraft } from "./traffic";

/**
 * What a time-lapse frame costs the main thread at a busy hour: 150 aircraft (50 taxiing along ATL's
 * taxiways, 100 flying), polled every 5 s, played at 30x (half a second of picture a frame).
 */
describe("time-lapse frame cost", () => {
  it("hands a frame's new trail points to the strips in a few milliseconds with 150 aircraft", async () => {
    const map = await loadAirportMap("atl");
    const ground = new GroundPaths(map);
    const lines = map.taxiways.filter((t) => t.line.length >= 4).slice(0, 50).map((t) => t.line);
    const base: Omit<Aircraft, "id" | "x" | "y" | "altitudeFt" | "onGround" | "groundSpeedKt" | "trackDeg" | "verticalRateFpm"> = {
      callsign: null,
      registration: null,
      typeCode: "B739",
      military: false,
      category: "A3",
      latitude: 0,
      longitude: 0,
      positionAge: 0.5,
      source: "adsb_icao",
      squawk: null,
    };
    /** Where taxiing aircraft i is at time t: along its taxiway at 8 m/s, back and forth. */
    const taxiing = (i: number, t: number): Aircraft => {
      const line = lines[i];
      const lengths = line.slice(1).map((p, k) => Math.hypot(p[0] - line[k][0], p[1] - line[k][1]));
      const total = lengths.reduce((a, b) => a + b, 0);
      let s = (8 * t) % (2 * total);
      if (s > total) s = 2 * total - s;
      let k = 0;
      while (k < lengths.length - 1 && s > lengths[k]) s -= lengths[k++];
      const u = lengths[k] > 0 ? s / lengths[k] : 0;
      const x = line[k][0] + (line[k + 1][0] - line[k][0]) * u;
      const y = line[k][1] + (line[k + 1][1] - line[k][1]) * u;
      return { ...base, id: `g${i}`, x, y, altitudeFt: 0, onGround: true, groundSpeedKt: 15.5, trackDeg: null, verticalRateFpm: null };
    };
    /** Flying aircraft i: a straight line across the area, climbing or descending, round again every 10 minutes. */
    const flying = (i: number, t: number): Aircraft => {
      const angle = (i * 2.399) % (2 * Math.PI);
      const s = ((t + i * 37) % 600) * 80 - 24_000;
      const climbing = i % 2 === 0;
      return {
        ...base,
        id: `a${i}`,
        x: Math.cos(angle) * s,
        y: Math.sin(angle) * s,
        altitudeFt: DEFAULT_AIRPORT.elevationFt + Math.abs(s) * 0.15,
        onGround: false,
        groundSpeedKt: 155,
        trackDeg: (90 - (angle * 180) / Math.PI + 360) % 360,
        verticalRateFpm: climbing ? 1500 : -900,
      };
    };
    const history = new History();
    for (let t = 0; t <= 1800; t += 5) {
      history.add({ airport: "atl", time: t, aircraft: [...lines.map((_, i) => taxiing(i, t)), ...Array.from({ length: 100 }, (_, i) => flying(i, t))] });
    }

    const feed = new TrailFeed(history, { elevationFt: DEFAULT_AIRPORT.elevationFt, ground });
    const strips = new TrailStrips(2 * TRAIL_POINTS);
    const headStrips = new TrailStrips(16 * 512);
    const style = { floor: 2.3, colors: { arriving: [0, 0, 1], departing: [1, 0, 0], taxiing: [1, 0.5, 0], parked: [0.5, 0.5, 0.5] } as const, intensity: 1 } as Parameters<TrailStrips["append"]>[1];
    const frame = (picture: number) => {
      const heads: TrailHead[] = [...lines.map((_, i) => taxiing(i, picture)), ...Array.from({ length: 100 }, (_, i) => flying(i, picture))].map((a) => ({
        id: a.id,
        x: a.x,
        y: a.y,
        heightM: 0,
        state: a.onGround ? "taxiing" : "arriving",
      }));
      const start = performance.now();
      const update = feed.update(picture, 600, heads);
      if (update.reset) strips.clear(picture);
      strips.append(update.added, style);
      strips.takeChanges();
      headStrips.clear(strips.epoch);
      headStrips.append(update.heads.flatMap((head, i) => head.map((p) => ({ ...p, run: i }))), style);
      headStrips.takeChanges();
      return { ms: performance.now() - start, reset: update.reset };
    };

    const first = frame(700);
    const times: number[] = [];
    const resets: number[] = [];
    for (let picture = 700.5; picture < 1300; picture += 0.5) {
      const { ms, reset } = frame(picture);
      if (!reset) times.push(ms);
      else resets.push(ms);
    }
    times.sort((a, b) => a - b);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`time-lapse frame, 150 aircraft: mean ${mean.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${times.at(-1)!.toFixed(3)} ms over ${times.length} frames; a full rebuild ${first.ms.toFixed(1)} ms cold, then ${resets.map((r) => r.toFixed(1)).join(", ") || "none"} ms`);
    // A frame at 60 fps has 16.7 ms for everything; the trails are to take a small share of it.
    expect(mean).toBeLessThan(4);
  });
});
