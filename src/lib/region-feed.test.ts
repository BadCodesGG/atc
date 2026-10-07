import { describe, expect, it } from "vitest";
import { airportByCode } from "./airports";
import { readViaLol } from "./__fixtures__/lol-read";
import { cellOf } from "./region";
import { COUNTS_KEEP_MS, MAX_CELLS_HELD, RegionFeed } from "./region-feed";
import { UpstreamBusyError } from "./upstream";

const CELL = { latitude: 32, longitude: -84 };
const OTHER = { latitude: 40, longitude: -80 };
const BODY = JSON.stringify({ now: 1_790_794_144_001, ac: [{ hex: "abc123", lat: 33.6, lon: -84.4, alt_baro: 3000, seen_pos: 1 }] });

function feed(answer: () => Promise<string> = async () => BODY) {
  let clock = 0;
  const asked: string[] = [];
  const f = new RegionFeed(
    readViaLol((url) => {
      asked.push(url);
      return answer();
    }),
    { ttlMs: 4_000, now: () => clock, log: () => {} },
  );
  return { f, asked, advance: (ms: number) => (clock += ms) };
}

describe("RegionFeed", () => {
  it("shares one upstream read per cell among everyone asking within the time to live", async () => {
    const { f, asked, advance } = feed();
    const [a, b] = await Promise.all([f.get(CELL), f.get(CELL)]);
    advance(3_999);
    await f.get(CELL);
    expect(asked).toHaveLength(1);
    expect(a?.aircraft).toHaveLength(1);
    expect(b).toBe(a);
  });

  it("reads again once the answer is older than the time to live, and reads each cell on its own", async () => {
    const { f, asked, advance } = feed();
    await f.get(CELL);
    await f.get(OTHER);
    advance(4_000);
    await f.get(CELL);
    expect(asked).toEqual(["https://api.adsb.lol/v2/point/32/-84/200", "https://api.adsb.lol/v2/point/40/-80/200", "https://api.adsb.lol/v2/point/32/-84/200"]);
  });

  it("answers null for a failed read and remembers the failure as long as a success, so an outage is not hammered", async () => {
    const { f, asked } = feed(async () => {
      throw new Error("adsb.lol: 503");
    });
    expect(await f.get(CELL)).toBeNull();
    expect(await f.get(CELL)).toBeNull();
    expect(asked).toHaveLength(1);
  });
});

describe("RegionFeed's memory", () => {
  it("holds at most MAX_CELLS_HELD cells, the one asked about longest ago forgotten first, whatever cells are asked for", async () => {
    expect(MAX_CELLS_HELD).toBe(300);
    const asked: string[] = [];
    const f = new RegionFeed(
      readViaLol(async (url) => {
        asked.push(url);
        return BODY;
      }),
      { maxKeys: 2, log: () => {} },
    );
    await f.get({ latitude: 0, longitude: 0 });
    await f.get({ latitude: 0, longitude: 4 });
    await f.get({ latitude: 0, longitude: 8 });
    // The first cell was forgotten, so it is read again within the time to live; the third was not.
    await f.get({ latitude: 0, longitude: 0 });
    await f.get({ latitude: 0, longitude: 8 });
    expect(asked).toHaveLength(4);
  });
});

describe("RegionFeed under a flood of cells", () => {
  it("keeps the cells with aircraft in them through a flood of empty ones, and serves them stale when their refresh fails", async () => {
    let down = false;
    let clock = 0;
    const f = new RegionFeed(
      readViaLol(async (url) => {
        if (down) throw new Error("adsb.lol: 503");
        return url.includes("/32/-84/") ? BODY : JSON.stringify({ now: 1_790_794_144_001, ac: [] });
      }),
      { maxKeys: 3, now: () => clock, log: () => {} },
    );
    await f.get(CELL);
    for (let lon = -180; lon < -140; lon += 4) await f.get({ latitude: 0, longitude: lon });
    down = true;
    clock += 5_000;
    expect(await f.read(CELL)).toMatchObject({ stale: true });
  });
});

describe("RegionFeed when adsb.lol fails", () => {
  it("serves the cell's last good answer marked stale with its age, then nothing once it is past 90 s", async () => {
    let fail = false;
    const { f, advance } = feed(async () => {
      if (fail) throw new Error("adsb.lol: 503");
      return BODY;
    });
    const good = await f.read(CELL);
    expect(good?.stale).toBe(false);
    fail = true;
    advance(25_000);
    const late = await f.read(CELL);
    expect(late).toMatchObject({ stale: true, ageS: 25 });
    expect(late?.snapshot).toBe(good?.snapshot);
    advance(66_000);
    expect(await f.read(CELL)).toBeNull();
  });
});

describe("RegionFeed.counts", () => {
  const atl = { code: "atl", icao: "KATL", name: "Atlanta", city: "Atlanta", latitude: 33.6367, longitude: -84.4281, elevationFt: 1026, timeZone: "America/New_York", country: "US", state: "GA" } as const;
  const pit = { code: "pit", icao: "KPIT", name: "Pittsburgh", city: "Pittsburgh", latitude: 40.4915, longitude: -80.2329, elevationFt: 1203, timeZone: "America/New_York", country: "US", state: "PA" } as const;

  it("counts each airport from its own cell's read, once per cell, and leaves out an airport whose cell failed", async () => {
    const asked: string[] = [];
    const f = new RegionFeed(
      readViaLol(async (url) => {
        asked.push(url);
        if (url.includes("/40/")) throw new Error("adsb.lol: 503");
        return BODY;
      }),
    );
    const counts = await f.counts([atl, { ...atl, code: "jfk" }, pit]);
    expect(counts).toEqual({ atl: { total: 1, ground: 0 }, jfk: { total: 1, ground: 0 } });
    expect(asked).toEqual(["https://api.adsb.lol/v2/point/32/-84/200", "https://api.adsb.lol/v2/point/40/-80/200"]);
  });

  it("throws the server's busy error when the cap on upstream requests leaves it with no count at all, and keeps what it has otherwise", async () => {
    let busy = false;
    const f = new RegionFeed(
      readViaLol(async () => {
        if (busy) throw new UpstreamBusyError(1);
        return BODY;
      }),
      { log: () => {} },
    );
    busy = true;
    await expect(f.counts([atl])).rejects.toBeInstanceOf(UpstreamBusyError);
    busy = false;
    await f.counts([atl]);
    busy = true;
    expect(await f.counts([atl, pit])).toEqual({ atl: { total: 1, ground: 0 } });
  });

  describe("under a request budget", () => {
    // Airports in distinct cells, in the order the feed meets them.
    const codes = ["atl", "pit", "jfk", "lax", "ord", "sea"];
    const many = codes.map((c) => airportByCode(c)!);
    const cells = new Set(many.map((a) => JSON.stringify(cellOf(a))));

    function budgeted() {
      let clock = 0;
      let inFlight = 0;
      let peak = 0;
      const asked: string[] = [];
      const f = new RegionFeed(
        readViaLol(async (url) => {
          asked.push(url);
          peak = Math.max(peak, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight--;
          return BODY;
        }),
        { ttlMs: 4_000, now: () => clock, log: () => {} },
      );
      return { f, asked, peak: () => peak, advance: (ms: number) => (clock += ms) };
    }

    it("reads at most two cells it does not already hold, one after another, however many airports ask", async () => {
      expect(cells.size).toBe(many.length);
      const { f, asked, peak } = budgeted();
      const counts = await f.counts(many);
      expect(asked).toHaveLength(2);
      expect(peak()).toBe(1);
      expect(Object.keys(counts)).toHaveLength(2);
    });

    it("fills in the rest on later requests without reading the same cells again first", async () => {
      const { f, asked, advance } = budgeted();
      await f.counts(many);
      advance(60_000);
      await f.counts(many);
      advance(60_000);
      const counts = await f.counts(many);
      expect(new Set(asked).size).toBe(6);
      expect(Object.keys(counts).sort()).toEqual([...codes].sort());
    });

    it("counts a cell the feed already holds without spending the budget", async () => {
      const { f, asked } = budgeted();
      for (const a of many) await f.get(cellOf(a));
      asked.length = 0;
      const counts = await f.counts(many);
      expect(asked).toHaveLength(0);
      expect(Object.keys(counts)).toHaveLength(6);
    });

    it("keeps a count only COUNTS_KEEP_MS after its read, then leaves the airport out", async () => {
      let down = false;
      let clock = 0;
      const f = new RegionFeed(
        readViaLol(async () => {
          if (down) throw new Error("adsb.lol: 503");
          return BODY;
        }),
        { ttlMs: 4_000, now: () => clock, log: () => {} },
      );
      const [atl] = many;
      expect(Object.keys(await f.counts([atl]))).toEqual(["atl"]);
      down = true;
      clock += COUNTS_KEEP_MS;
      expect(Object.keys(await f.counts([atl]))).toEqual(["atl"]);
      clock += 1;
      expect(await f.counts([atl])).toEqual({});
    });
  });
});
