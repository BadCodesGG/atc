import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureSource, liveSource } from "./feed-source";
import { PLAYBACK_DELAY } from "./tracker";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("fixtureSource", () => {
  it("answers an API path with what the fixture says at its own time, and 404 for anything it does not hold", async () => {
    let t = 1000;
    const source = fixtureSource((path, at) => (path === "/api/hex/abcdef" ? { hex: "abcdef", time: at } : null), () => t);
    t = 1042;
    const res = await source.get("/api/hex/abcdef");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hex: "abcdef", time: 1042 });
    expect((await source.get("/api/status")).status).toBe(404);
  });

  it("polls every so many seconds of its own clock, however fast that clock runs", () => {
    let t = 0;
    const source = fixtureSource(() => null, () => t);
    const calls: number[] = [];
    const stop = source.every(5, () => calls.push(t));
    // The clock runs at 40 times the wall's: 5 feed seconds every 125 ms.
    for (let i = 0; i < 40; i++) {
      t += 40 * 0.025;
      vi.advanceTimersByTime(25);
    }
    expect(calls.length).toBeGreaterThanOrEqual(7);
    expect(calls.length).toBeLessThanOrEqual(9);
    for (let i = 1; i < calls.length; i++) expect(calls[i] - calls[i - 1]).toBeGreaterThanOrEqual(5);
    stop();
    t += 100;
    vi.advanceTimersByTime(1000);
    expect(calls.length).toBeLessThanOrEqual(9);
  });
});

describe("the feed's clock", () => {
  it("live, runs on the wall's clock set by the first answer's timestamp, the same for every reader of the page", () => {
    vi.setSystemTime(new Date(1_000_000));
    const source = liveSource();
    expect(source.clock()).toBe(1000);
    // The feed's server is 12 s ahead of this machine.
    source.heard(1012);
    vi.setSystemTime(new Date(1_002_000));
    expect(source.clock()).toBe(1014);
  });

  /** Reads every 5 s for `seconds`, the upstream clock at `upstream(wall)`, some answers served `age(i)` seconds old; the clock sampled every 50 ms. */
  function session(upstream: (wall: number) => number, seconds: number, age: (i: number) => number = () => 0) {
    vi.setSystemTime(new Date(1_000_000));
    const source = liveSource();
    const samples: { wall: number; clock: number }[] = [];
    let read = 0;
    for (let ms = 0; ms <= seconds * 1000; ms += 50) {
      vi.setSystemTime(new Date(1_000_000 + ms));
      const wall = 1000 + ms / 1000;
      if (ms % 5000 === 0) source.heard(upstream(wall) - age(read++));
      samples.push({ wall, clock: source.clock() });
    }
    return samples;
  }

  /**
   * The clock only ever runs forward, at close to the wall's pace: re-syncing it never jumps the picture.
   * In its first 8 s nothing is drawn yet (the picture plays 8 s behind), and it takes each answer outright.
   */
  function expectSmooth(all: { wall: number; clock: number }[]) {
    const samples = all.filter((s) => s.wall >= 1000 + PLAYBACK_DELAY);
    for (let i = 1; i < samples.length; i++) {
      const rate = (samples[i].clock - samples[i - 1].clock) / (samples[i].wall - samples[i - 1].wall);
      expect(rate).toBeGreaterThan(0.85);
      expect(rate).toBeLessThan(1.15);
    }
  }

  it("live, follows an upstream clock that drifts ahead of this machine's, re-synced on every read", () => {
    // 2 ms a second ahead and gaining: 7 s over the hour.
    const upstream = (wall: number) => wall + 12 + 0.002 * (wall - 1000);
    const samples = session(upstream, 3600);
    expectSmooth(samples);
    const end = samples.at(-1)!;
    expect(Math.abs(end.clock - upstream(end.wall))).toBeLessThan(0.5);
  });

  it("live, takes a fresh answer straight away when the first one was served old, before anything is drawn", () => {
    const upstream = (wall: number) => wall + 12;
    // The first answer comes out of a cache 30 s old; the next, 5 s on, is fresh.
    const samples = session(upstream, 60, (i) => (i === 0 ? 30 : 0));
    const settled = samples.find((s) => s.wall >= 1006)!;
    expect(settled.clock).toBeCloseTo(upstream(settled.wall), 6);
    expectSmooth(samples);
  });

  it("live, follows an upstream clock that drifts behind, and is not dragged back by an answer served old", () => {
    const upstream = (wall: number) => wall + 12 - 0.002 * (wall - 1000);
    // Now and then an answer comes out of a cache, up to 4 s old; once, one is a minute old.
    const samples = session(upstream, 3600, (i) => (i === 300 ? 60 : i % 7 === 3 ? 4 : 0));
    expectSmooth(samples);
    const end = samples.at(-1)!;
    expect(Math.abs(end.clock - upstream(end.wall))).toBeLessThan(0.5);
    // Around the minute-old answer the clock stays with upstream.
    const around = samples.find((s) => s.wall >= 1000 + 300 * 5 + 10)!;
    expect(Math.abs(around.clock - upstream(around.wall))).toBeLessThan(0.5);
  });

  it("with a fixture, is the fixture's own clock, which its answers are stamped with", () => {
    let t = 50;
    const source = fixtureSource(() => null, () => t);
    source.heard(10);
    t = 60;
    expect(source.clock()).toBe(60);
  });
});

describe("coming back into view", () => {
  it("live, polls at once when the page is shown again, not a full interval later", () => {
    const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("document", page);
    const calls: number[] = [];
    const stop = liveSource().every(5, () => calls.push(Date.now()));
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(0);
    page.visibilityState = "visible";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(1);
    stop();
    page.dispatchEvent(new Event("visibilitychange"));
    expect(calls).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});
