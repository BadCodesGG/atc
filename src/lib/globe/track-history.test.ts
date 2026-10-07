import { describe, expect, it } from "vitest";
import { TrackHistory } from "./track-history";

const limits = { maxPoints: 5, maxAgeS: 100, maxAircraft: 3, minStepM: 150 };
/** A step of about 1 km east at the equator, per index. */
const lng = (i: number) => i * 0.01;

describe("TrackHistory", () => {
  it("keeps the positions seen, oldest first", () => {
    const h = new TrackHistory(limits);
    h.record("a", 0, lng(0), 0);
    h.record("a", 10, lng(1), 0);
    expect(h.track("a")).toEqual([[0, 0], [0.01, 0]]);
    expect(h.track("zz")).toEqual([]);
  });

  it("ignores a repeat and a position that has not moved", () => {
    const h = new TrackHistory(limits);
    h.record("a", 0, 0, 0);
    h.record("a", 0, lng(1), 0);
    h.record("a", 5, 0.0001, 0);
    expect(h.track("a")).toHaveLength(1);
  });

  it("drops the oldest points past the limit on points and on age", () => {
    const h = new TrackHistory(limits);
    for (let i = 0; i < 8; i++) h.record("a", i * 10, lng(i), 0);
    // Eight points at 10 s: the age limit keeps 11 of them, the point limit 5.
    expect(h.track("a").map((p) => p[0])).toEqual([3, 4, 5, 6, 7].map(lng));
    h.record("a", 500, lng(9), 0);
    expect(h.track("a")).toEqual([[lng(9), 0]]);
  });

  it("holds at most maxAircraft, dropping the one heard longest ago", () => {
    const h = new TrackHistory(limits);
    ["a", "b", "c"].forEach((id, i) => h.record(id, i, 0, 0));
    h.record("a", 10, lng(1), 0);
    h.record("d", 11, 0, 0);
    expect(h.size).toBe(3);
    expect(h.track("b")).toEqual([]);
    expect(h.track("a")).toHaveLength(2);
  });

  it("never drops the pinned aircraft to make room", () => {
    const h = new TrackHistory(limits);
    h.pin("a");
    ["a", "b", "c", "d", "e"].forEach((id, i) => h.record(id, i, 0, 0));
    expect(h.size).toBe(3);
    expect(h.track("a")).toHaveLength(1);
    expect(h.track("b")).toEqual([]);
  });

  it("sweeps aircraft not heard for longer than the age limit", () => {
    const h = new TrackHistory(limits);
    h.record("a", 0, 0, 0);
    h.record("b", 90, 0, 0);
    h.sweep(150);
    expect(h.track("a")).toEqual([]);
    expect(h.track("b")).toHaveLength(1);
  });

  it("keeps a track across the antimeridian one continuous line", () => {
    const h = new TrackHistory(limits);
    h.record("a", 0, 179.95, 10);
    h.record("a", 10, -179.95, 10);
    const [first, second] = h.track("a");
    expect(Math.abs(second[0] - first[0])).toBeLessThan(1);
  });
});
