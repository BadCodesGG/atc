import { describe, expect, it } from "vitest";
import { readHex } from "./hex";
import { HexFeed, NOT_FOUND_MS } from "./hex-feed";
import { readViaLol } from "./__fixtures__/lol-read";
import { UpstreamStatusError } from "./upstream";

const BODY = JSON.stringify({
  now: 1_790_794_144_001,
  ac: [{ hex: "a1b2c3", flight: "DAL1234 ", t: "A321", lat: 34.4, lon: -83.1, alt_baro: 29000, gs: 452, track: 48.5, baro_rate: 0, seen_pos: 0.4 }],
});

/** A feed on a fake clock whose upstream answers `answer()` and records every URL it is asked. */
function harness(answer: (url: string) => Promise<string> = async () => BODY, options: { maxEntries?: number } = {}) {
  let clock = 0;
  const asked: string[] = [];
  const logs: string[] = [];
  const feed = new HexFeed(
    readViaLol((url) => {
      asked.push(url);
      return answer(url);
    }),
    { now: () => clock, log: (line) => logs.push(line), ...options },
  );
  return { feed, asked, logs, advance: (ms: number) => (clock += ms) };
}

describe("readHex", () => {
  it("takes six hex digits in either case, lower-cased", () => {
    expect(readHex("A1B2C3")).toBe("a1b2c3");
    expect(readHex("0f00ba")).toBe("0f00ba");
  });

  it("refuses anything else, TIS-B's ~ addresses included, before any URL is built", () => {
    for (const bad of ["", "a1b2c", "a1b2c3d", "g1b2c3", "~a1b2c", "../x", "a1b2c3/..", "a1 b2c", "%61%31"]) expect(readHex(bad), bad).toBeNull();
  });
});

describe("HexFeed", () => {
  it("asks adsb.lol for the one aircraft and reads it as the map's sky does", async () => {
    const { feed, asked } = harness();
    const answer = await feed.read("a1b2c3");
    expect(asked).toEqual(["https://api.adsb.lol/v2/hex/a1b2c3"]);
    expect(answer).toMatchObject({ stale: false, snapshot: { hex: "a1b2c3", time: 1_790_794_144.001, aircraft: { id: "a1b2c3", callsign: "DAL1234", altitudeFt: 29000, groundSpeedKt: 452, trackDeg: 48.5 } } });
  });

  it("answers a known hex that is not in the air now with no aircraft, not a failure", async () => {
    const { feed } = harness(async () => JSON.stringify({ now: 1_790_794_144_001, ac: [] }));
    expect((await feed.read("a1b2c3"))?.snapshot.aircraft).toBeNull();
  });

  it("does not ask again for a hex it has no position for until NOT_FOUND_MS has passed, so repeats of random hexes cost one read", async () => {
    const { feed, asked, advance } = harness(async () => JSON.stringify({ now: 1_790_794_144_001, ac: [] }));
    for (let i = 0; i < 5; i++) await feed.read("123456");
    advance(NOT_FOUND_MS - 1);
    await feed.read("123456");
    expect(asked).toHaveLength(1);
    advance(1);
    await feed.read("123456");
    expect(asked).toHaveLength(2);
  });

  it("still reads a flying aircraft's hex every four seconds", async () => {
    const { feed, asked, advance } = harness();
    await feed.read("a1b2c3");
    advance(4_000);
    await feed.read("a1b2c3");
    expect(asked).toHaveLength(2);
  });

  it("shares one upstream read per hex among everyone asking within four seconds", async () => {
    const { feed, asked, advance } = harness();
    await Promise.all([feed.read("a1b2c3"), feed.read("a1b2c3")]);
    advance(3_999);
    await feed.read("a1b2c3");
    expect(asked).toHaveLength(1);
    advance(1);
    await feed.read("a1b2c3");
    expect(asked).toHaveLength(2);
  });

  it("serves the last good answer marked stale with its age while adsb.lol fails, then nothing past 90 s", async () => {
    let fail = false;
    const { feed, advance } = harness(async () => {
      if (fail) throw new Error("adsb.lol: 503");
      return BODY;
    });
    const good = await feed.read("a1b2c3");
    fail = true;
    advance(30_000);
    expect(await feed.read("a1b2c3")).toMatchObject({ stale: true, ageS: 30, snapshot: good?.snapshot });
    advance(61_000);
    expect(await feed.read("a1b2c3")).toBeNull();
  });

  it("leaves adsb.lol alone for a while after a 429", async () => {
    let limited = true;
    const { feed, asked, logs, advance } = harness(async (url) => {
      if (limited) throw new UpstreamStatusError(429, null, url);
      return BODY;
    });
    expect(await feed.read("a1b2c3")).toBeNull();
    limited = false;
    advance(5_000);
    await feed.read("a1b2c3");
    expect(asked).toHaveLength(1);
    expect(logs).toEqual(["hex a1b2c3: upstream 429, backing off 10s"]);
    advance(5_000);
    expect((await feed.read("a1b2c3"))?.stale).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it("forgets the hex asked about longest ago once it holds as many as it keeps, as the hexes come from requests", async () => {
    const { feed, asked } = harness(undefined, { maxEntries: 2 });
    await feed.read("aaaaaa");
    await feed.read("bbbbbb");
    await feed.read("cccccc");
    // aaaaaa was forgotten, so it is read again although its answer is still within the four seconds.
    await feed.read("aaaaaa");
    await feed.read("cccccc");
    expect(asked.map((u) => u.slice(-6))).toEqual(["aaaaaa", "bbbbbb", "cccccc", "aaaaaa"]);
  });

  it("keeps a followed aircraft's snapshot through a flood of random hexes the upstream has no aircraft for, and serves it stale when its refresh fails", async () => {
    let down = false;
    const { feed, advance } = harness(
      async (url) => {
        if (down) throw new Error("adsb.lol: 503");
        return url.endsWith("a1b2c3") ? BODY : JSON.stringify({ now: 1_790_794_144_001, ac: [] });
      },
      { maxEntries: 3 },
    );
    await feed.read("a1b2c3");
    for (let n = 0; n < 40; n++) await feed.read(n.toString(16).padStart(6, "0"));
    down = true;
    advance(5_000);
    expect(await feed.read("a1b2c3")).toMatchObject({ stale: true, snapshot: { aircraft: { id: "a1b2c3" } } });
  });
});
