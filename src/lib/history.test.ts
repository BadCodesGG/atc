import { describe, expect, it } from "vitest";
import { History, HISTORY_BYTES, HISTORY_SECONDS } from "./history";
import type { Aircraft, TrafficSnapshot } from "./traffic";

function aircraft(id: string, x: number, y: number, extra: Partial<Aircraft> = {}): Aircraft {
  return {
    id,
    callsign: null,
    registration: null,
    typeCode: null,
    military: false,
    category: null,
    latitude: 33.5,
    longitude: -84.5,
    x,
    y,
    altitudeFt: 3000,
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

describe("History", () => {
  it("gives back every snapshot it was given, field for field", () => {
    const history = new History();
    const full = aircraft("ab313c", 1250.5, -830.25, {
      callsign: "DAL1099",
      registration: "N820DX",
      typeCode: "B752",
      military: true,
      category: "A4",
      altitudeFt: 2825,
      groundSpeedKt: 236.5,
      trackDeg: 62,
      verticalRateFpm: -512,
      positionAge: 0.5,
      squawk: "3523",
    });
    const parked = aircraft("a1b2c3", 10, 20, { onGround: true, altitudeFt: 0, source: null });
    history.add(snapshot(100, full, parked));
    history.add(snapshot(105, parked));
    expect(history.length).toBe(2);
    const first = history.snapshot(0);
    expect(first.time).toBe(100);
    expect(first.airport).toBe("atl");
    expect(first.aircraft[0]).toEqual({ ...full, latitude: expect.closeTo(33.5, 5), longitude: expect.closeTo(-84.5, 5) });
    expect(first.aircraft[1]).toMatchObject({ id: "a1b2c3", onGround: true, groundSpeedKt: null, trackDeg: null, verticalRateFpm: null, source: null, callsign: null });
    expect(history.snapshot(1).aircraft.map((a) => a.id)).toEqual(["a1b2c3"]);
  });

  it("ignores a snapshot that is not newer than the newest one", () => {
    const history = new History();
    history.add(snapshot(105, aircraft("a", 0, 0)));
    history.add(snapshot(100, aircraft("a", 1, 0)));
    history.add(snapshot(105, aircraft("a", 2, 0)));
    expect(history.length).toBe(1);
    expect(history.snapshot(0).aircraft[0].x).toBe(0);
  });

  it("knows the span it covers and finds the snapshots around a moment", () => {
    const history = new History();
    expect(history.start).toBeNull();
    expect(history.end).toBeNull();
    for (let t = 100; t <= 150; t += 5) history.add(snapshot(t, aircraft("a", t, 0)));
    expect(history.start).toBe(100);
    expect(history.end).toBe(150);
    expect(history.timeAt(2)).toBe(110);
    // The first snapshot after a moment.
    expect(history.indexAfter(99)).toBe(0);
    expect(history.indexAfter(110)).toBe(3);
    expect(history.indexAfter(112)).toBe(3);
    expect(history.indexAfter(150)).toBe(11);
  });

  it("drops the oldest snapshots once it covers more than three hours", () => {
    const history = new History();
    const step = 60;
    for (let t = 0; t <= HISTORY_SECONDS + 10 * step; t += step) history.add(snapshot(t, aircraft("a", t, 0)));
    expect(history.end! - history.start!).toBeLessThanOrEqual(HISTORY_SECONDS);
    expect(history.end).toBe(HISTORY_SECONDS + 10 * step);
    expect(history.start).toBe(10 * step);
  });

  it("drops the oldest snapshots once it holds more than its byte budget", () => {
    const history = new History({ maxBytes: 10_000 });
    const crowd = Array.from({ length: 20 }, (_, i) => aircraft(`a${i}`, i, i));
    for (let t = 0; t < 100; t++) history.add(snapshot(t, ...crowd));
    expect(history.bytes).toBeLessThanOrEqual(10_000);
    expect(history.end).toBe(99);
    expect(history.length).toBeGreaterThan(1);
    expect(history.length).toBeLessThan(100);
  });

  it("stays inside its budget for three hours of a busy airport polled every five seconds", () => {
    // 150 aircraft in every answer is busier than ATL's peak inside 20 NM.
    const history = new History();
    const crowd = Array.from({ length: 150 }, (_, i) => aircraft(`a${i}`, i, i, { callsign: `DAL${i}`, typeCode: "B739", category: "A3", squawk: "1200" }));
    const polls = HISTORY_SECONDS / 5;
    for (let i = 0; i <= polls; i++) history.add(snapshot(5 * i, ...crowd));
    expect(history.length).toBe(polls + 1);
    expect(history.bytes).toBeLessThanOrEqual(HISTORY_BYTES);
  });
});
