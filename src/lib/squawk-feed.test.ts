import { describe, expect, it } from "vitest";
import { SquawkFeed } from "./squawk-feed";
import { readViaLol } from "./__fixtures__/lol-read";
import { UpstreamStatusError } from "./upstream";

const BODY = JSON.stringify({ now: 1_790_856_776_000, ac: [{ hex: "a1b2c3", flight: "UAL12", lat: 40.1, lon: -80.2, alt_baro: 31000, gs: 440, track: 90 }] });

/** A feed on a fake clock whose upstream answers `answer()` and records every URL it is asked. */
function harness(answer: (url: string) => Promise<string> = async () => BODY) {
  let clock = 0;
  const asked: string[] = [];
  const logs: string[] = [];
  const feed = new SquawkFeed(
    readViaLol((url) => {
      asked.push(url);
      return answer(url);
    }),
    { now: () => clock, log: (line) => logs.push(line) },
  );
  return { feed, asked, logs, advance: (ms: number) => (clock += ms) };
}

describe("SquawkFeed", () => {
  it("asks adsb.lol for the code and reads who squawks it", async () => {
    const { feed, asked } = harness();
    const answer = await feed.read("7700");
    expect(asked).toEqual(["https://api.adsb.lol/v2/sqk/7700"]);
    expect(answer).toMatchObject({ stale: false, snapshot: { code: "7700", time: 1_790_856_776, aircraft: [{ id: "a1b2c3", callsign: "UAL12" }] } });
  });

  it("shares one upstream read per code among everyone asking within four seconds, and reads the codes apart", async () => {
    const { feed, asked, advance } = harness();
    await Promise.all([feed.read("7700"), feed.read("7700"), feed.read("7600")]);
    advance(3_999);
    await feed.read("7700");
    expect(asked).toEqual(["https://api.adsb.lol/v2/sqk/7700", "https://api.adsb.lol/v2/sqk/7600"]);
    advance(1);
    await feed.read("7700");
    expect(asked).toHaveLength(3);
  });

  it("serves the last good answer marked stale with its age while adsb.lol fails, then nothing past 90 s", async () => {
    let fail = false;
    const { feed, advance } = harness(async () => {
      if (fail) throw new Error("adsb.lol: 503");
      return BODY;
    });
    const good = await feed.read("7700");
    fail = true;
    advance(30_000);
    expect(await feed.read("7700")).toMatchObject({ stale: true, ageS: 30, snapshot: good?.snapshot });
    advance(61_000);
    expect(await feed.read("7700")).toBeNull();
  });

  it("does not take a body that is not adsb.lol's for a quiet sky", async () => {
    const { feed } = harness(async () => JSON.stringify({ msg: "rate limited" }));
    expect(await feed.read("7700")).toBeNull();
  });

  it("leaves adsb.lol alone for a while after a 429", async () => {
    let limited = true;
    const { feed, asked, logs, advance } = harness(async (url) => {
      if (limited) throw new UpstreamStatusError(429, null, url);
      return BODY;
    });
    expect(await feed.read("7500")).toBeNull();
    limited = false;
    advance(5_000);
    await feed.read("7500");
    expect(asked).toHaveLength(1);
    expect(logs).toEqual(["squawk 7500: upstream 429, backing off 10s"]);
    advance(5_000);
    expect((await feed.read("7500"))?.stale).toBe(false);
    expect(asked).toHaveLength(2);
  });
});
