import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixtureSource, liveSource } from "./feed-source";

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
    // The feed's server is 12 s ahead of this machine; a later answer does not move the clock again.
    source.heard(1012);
    source.heard(1500);
    vi.setSystemTime(new Date(1_002_000));
    expect(source.clock()).toBe(1014);
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
