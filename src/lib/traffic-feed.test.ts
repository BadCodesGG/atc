import { describe, expect, it } from "vitest";
import { airportByCode } from "./airports";
import { LastGoodFeed, MEMO_MS, STALE_MAX_S, TrafficFeed } from "./traffic-feed";
import type { TrafficSnapshot } from "./traffic";
import { BACKOFF_MIN_MS, UpstreamBusyError, UpstreamStatusError } from "./upstream";

const ATL = airportByCode("atl")!;
const START = Date.parse("2026-10-01T12:00:00Z");

function snapshot(time: number): TrafficSnapshot {
  return { airport: "atl", time, aircraft: [] };
}

/** A feed on a fake clock whose upstream plays back `script` one entry per call and counts the calls. */
function harness(script: (TrafficSnapshot | Error)[]) {
  let t = START;
  let calls = 0;
  const logs: string[] = [];
  const feed = new TrafficFeed({
    now: () => t,
    log: (line) => logs.push(line),
    fetchSnapshot: async () => {
      const next = script[Math.min(calls++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { feed, logs, calls: () => calls, advance: (ms: number) => (t += ms) };
}

const rateLimited = (retryAfter: string | null = null) => new UpstreamStatusError(429, retryAfter, "https://example.test");

describe("a failing upstream", () => {
  it("serves the last good snapshot, marked stale with its age, while it is at most 90 s old", async () => {
    const { feed, advance } = harness([snapshot(1), new Error("boom")]);
    expect(await feed.read(ATL)).toMatchObject({ stale: false });
    advance(MEMO_MS + 26_000);
    const answer = await feed.read(ATL);
    expect(answer).toMatchObject({ stale: true, ageS: 30, snapshot: { time: 1 } });
    advance((STALE_MAX_S - 30) * 1000 - 1000);
    expect(await feed.read(ATL)).toMatchObject({ stale: true, ageS: 89 });
  });

  it("answers nothing once the last good snapshot is older than 90 s", async () => {
    const { feed, advance } = harness([snapshot(1), new Error("boom")]);
    await feed.read(ATL);
    advance(STALE_MAX_S * 1000 + MEMO_MS);
    expect(await feed.read(ATL)).toBeNull();
  });

  it("answers nothing when there never was a good snapshot", async () => {
    const { feed } = harness([new Error("boom")]);
    expect(await feed.read(ATL)).toBeNull();
  });

  it("treats a 5xx like any other failure and logs one line without a stack", async () => {
    const { feed, advance, logs } = harness([snapshot(1), new UpstreamStatusError(503, null, "https://example.test")]);
    await feed.read(ATL);
    advance(MEMO_MS);
    expect(await feed.read(ATL)).toMatchObject({ stale: true });
    expect(logs).toEqual(["traffic atl: upstream: 503 for https://example.test"]);
  });

  it("shares one upstream read between concurrent requests", async () => {
    const { feed, calls } = harness([snapshot(1)]);
    await Promise.all([feed.read(ATL), feed.read(ATL), feed.read(ATL)]);
    expect(calls()).toBe(1);
  });
});

describe("back-off after a 429", () => {
  it("does not call the upstream at all while it lasts, and serves the stale snapshot", async () => {
    const { feed, advance, calls, logs } = harness([snapshot(1), rateLimited()]);
    await feed.read(ATL);
    advance(MEMO_MS);
    await feed.read(ATL);
    expect(calls()).toBe(2);
    for (let i = 0; i < 4; i++) {
      advance(2_000);
      expect(await feed.read(ATL)).toMatchObject({ stale: true, snapshot: { time: 1 } });
    }
    expect(calls()).toBe(2);
    expect(logs).toEqual([`traffic atl: upstream 429, backing off ${BACKOFF_MIN_MS / 1000}s`]);
  });

  it("answers nothing during the back-off when there is no snapshot to serve", async () => {
    const { feed, advance, calls } = harness([rateLimited()]);
    expect(await feed.read(ATL)).toBeNull();
    advance(5_000);
    expect(await feed.read(ATL)).toBeNull();
    expect(calls()).toBe(1);
  });

  it("calls the upstream again once the back-off is over", async () => {
    const { feed, advance, calls } = harness([snapshot(1), rateLimited(), snapshot(2)]);
    await feed.read(ATL);
    advance(MEMO_MS);
    await feed.read(ATL);
    advance(BACKOFF_MIN_MS);
    expect(await feed.read(ATL)).toMatchObject({ stale: false, snapshot: { time: 2 } });
    expect(calls()).toBe(3);
  });

  it("doubles the wait on repeats up to 60 s and starts over after a success", async () => {
    const { feed, advance, logs } = harness([rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited(), rateLimited(), snapshot(1), rateLimited()]);
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      await feed.read(ATL);
      const wait = Number(/backing off (\d+)s/.exec(logs[i])![1]);
      waits.push(wait);
      advance(wait * 1000);
    }
    expect(waits).toEqual([10, 20, 40, 60, 60, 60]);
    expect(await feed.read(ATL)).toMatchObject({ stale: false });
    advance(MEMO_MS);
    await feed.read(ATL);
    expect(logs.at(-1)).toBe("traffic atl: upstream 429, backing off 10s");
  });

  it("backs off on adsb.lol's 420 just as on a 429, honouring its Retry-After", async () => {
    const tooMany = new UpstreamStatusError(420, "25", "https://example.test");
    const { feed, advance, calls, logs } = harness([snapshot(1), tooMany, snapshot(2)]);
    await feed.read(ATL);
    advance(MEMO_MS);
    expect(await feed.read(ATL)).toMatchObject({ stale: true, snapshot: { time: 1 } });
    advance(24_000);
    await feed.read(ATL);
    expect(calls()).toBe(2);
    advance(1_000);
    expect(await feed.read(ATL)).toMatchObject({ stale: false, snapshot: { time: 2 } });
    expect(logs).toEqual(["traffic atl: upstream 420, backing off 25s"]);
  });

  it("honours Retry-After instead of the default", async () => {
    const { feed, advance, calls } = harness([snapshot(1), rateLimited("25"), snapshot(2)]);
    await feed.read(ATL);
    advance(MEMO_MS);
    await feed.read(ATL);
    advance(24_000);
    await feed.read(ATL);
    expect(calls()).toBe(2);
    advance(1_000);
    await feed.read(ATL);
    expect(calls()).toBe(3);
  });
});

/** A feed of numbers keyed by themselves, on a fake clock, for what the airports' feed has no need of. */
function numbers(options: { maxKeys?: number; holdMs?: (n: number) => number | undefined; worth?: (n: number) => boolean } = {}, answer: (n: number) => number = (n) => n) {
  let t = START;
  const asked: number[] = [];
  /** What each read said of its key: whether it already had a good snapshot. */
  const knownAsked: boolean[] = [];
  const fail = { error: null as Error | null };
  const feed = new LastGoodFeed<number, number>({
    fetchSnapshot: async (n, { known }) => {
      asked.push(n);
      knownAsked.push(known);
      if (fail.error) throw fail.error;
      return answer(n);
    },
    keyOf: String,
    name: "test",
    now: () => t,
    log: () => {},
    ...options,
  });
  return { feed, asked, knownAsked, fail, advance: (ms: number) => (t += ms) };
}

describe("when the server's cap on upstream requests is spent", () => {
  it("throws for a key with nothing recent to serve, and does not remember it, so the next ask tries again", async () => {
    const { feed, asked, fail } = numbers();
    fail.error = new UpstreamBusyError(1);
    await expect(feed.read(1)).rejects.toBeInstanceOf(UpstreamBusyError);
    await expect(feed.read(1)).rejects.toBeInstanceOf(UpstreamBusyError);
    expect(asked).toEqual([1, 1]);
    fail.error = null;
    expect(await feed.read(1)).toMatchObject({ stale: false, snapshot: 1 });
  });

  it("serves the key's last good answer marked stale instead, and puts no back-off on the key", async () => {
    const { feed, asked, fail, advance } = numbers();
    await feed.read(1);
    advance(MEMO_MS);
    fail.error = new UpstreamBusyError(1);
    expect(await feed.read(1)).toMatchObject({ stale: true, snapshot: 1 });
    fail.error = null;
    expect(await feed.read(1)).toMatchObject({ stale: false });
    expect(asked).toEqual([1, 1, 1]);
  });
});

describe("how long an answer stands", () => {
  it("is memoMs, unless holdMs says otherwise of the snapshot", async () => {
    const { feed, asked, advance } = numbers({ holdMs: (n) => (n === 0 ? 20_000 : undefined) });
    await feed.read(0);
    await feed.read(5);
    advance(MEMO_MS);
    await feed.read(0);
    await feed.read(5);
    expect(asked).toEqual([0, 5, 5]);
    advance(20_000 - MEMO_MS);
    await feed.read(0);
    expect(asked).toEqual([0, 5, 5, 0]);
  });
});

describe("forgetting keys", () => {
  it("drops a key whose last good snapshot is too old to serve, so a loop over many keys does not grow it without end", async () => {
    const { feed, advance } = numbers();
    for (let n = 0; n < 50; n++) await feed.read(n);
    expect(feed.size).toBe(50);
    advance(STALE_MAX_S * 1000 - 1);
    await feed.read(100);
    expect(feed.size).toBe(51);
    advance(1_002);
    await feed.read(101);
    expect(feed.size).toBe(2);
  });

  it("keeps a key that is backing off, so its back-off is not forgotten with it", async () => {
    const { feed, fail, advance, asked } = numbers();
    await feed.read(1);
    advance((STALE_MAX_S - 5) * 1000);
    fail.error = new UpstreamStatusError(429, "60", "https://example.test");
    await feed.read(1);
    fail.error = null;
    advance(10_000);
    // Its last good answer is now past the stale limit, but the 60 s back-off has not run out.
    await feed.read(2);
    expect(feed.size).toBe(2);
    await feed.read(1);
    expect(asked.filter((n) => n === 1)).toHaveLength(2);
  });

  it("keeps the key being asked about even when its own last good snapshot is the one that is too old", async () => {
    const { feed, advance, asked } = numbers();
    await feed.read(1);
    advance(STALE_MAX_S * 1000 + 5_000);
    expect(await feed.read(1)).toMatchObject({ stale: false });
    await feed.read(1);
    expect(asked).toEqual([1, 1]);
  });
});

describe("which keys the server's cap on upstream requests treats as known", () => {
  it("passes a key with nothing good yet as new, and one with a good snapshot as known, so only the second may spend the cap's reserve", async () => {
    const { feed, knownAsked, fail, advance } = numbers();
    await feed.read(1);
    advance(MEMO_MS);
    await feed.read(1);
    // A refresh that failed leaves the good snapshot, so the key stays known.
    fail.error = new Error("adsb.lol: 503");
    advance(MEMO_MS);
    await feed.read(1);
    advance(MEMO_MS);
    await feed.read(1);
    expect(knownAsked).toEqual([false, true, true, true]);
  });

  it("does not call a key known once its good snapshot is too old to serve", async () => {
    const { feed, knownAsked, advance } = numbers();
    await feed.read(1);
    advance(STALE_MAX_S * 1000 + 1);
    await feed.read(1);
    expect(knownAsked).toEqual([false, false]);
  });

  it("does not call a key known when its snapshot says nothing worth keeping", async () => {
    const { feed, knownAsked, advance } = numbers({ worth: (n) => n > 0 }, () => 0);
    await feed.read(1);
    advance(MEMO_MS);
    await feed.read(1);
    expect(knownAsked).toEqual([false, false]);
  });
});

describe("what is forgotten first when it holds more keys than it keeps", () => {
  const fetchFails = new Error("adsb.lol: 503");

  it("forgets keys that never got an answer before keys that did, so a flood of fresh keys that fail cannot push the hot ones out", async () => {
    const { feed, fail, asked, advance } = numbers({ maxKeys: 3 });
    for (const hot of [1, 2, 3]) await feed.read(hot);
    fail.error = fetchFails;
    for (let n = 100; n < 160; n++) await feed.read(n);
    expect(feed.size).toBe(3);
    // Every hot key is still held, so each is served stale (not read again) when its refresh fails.
    advance(MEMO_MS);
    for (const hot of [1, 2, 3]) expect(await feed.read(hot)).toMatchObject({ stale: true, snapshot: hot });
    expect(asked.filter((n) => n < 100)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it("does the same for fresh keys the cap refused (busy), which are never remembered", async () => {
    const { feed, fail, advance } = numbers({ maxKeys: 3 });
    for (const hot of [1, 2, 3]) await feed.read(hot);
    fail.error = new UpstreamBusyError(1);
    for (let n = 100; n < 160; n++) await expect(feed.read(n)).rejects.toBeInstanceOf(UpstreamBusyError);
    advance(MEMO_MS);
    for (const hot of [1, 2, 3]) expect(await feed.read(hot)).toMatchObject({ stale: true, snapshot: hot });
  });

  it("forgets a key whose snapshot says nothing worth keeping before one that does, though it was asked about later", async () => {
    const { feed, asked } = numbers({ maxKeys: 2, worth: (n) => n > 0 });
    await feed.read(1);
    await feed.read(0);
    await feed.read(2);
    await feed.read(1);
    await feed.read(2);
    expect(asked).toEqual([1, 0, 2]);
  });

  it("forgets the one asked about longest ago when every key holds something worth keeping", async () => {
    const { feed, asked } = numbers({ maxKeys: 2 });
    await feed.read(1);
    await feed.read(2);
    await feed.read(3);
    await feed.read(2);
    await feed.read(3);
    await feed.read(1);
    expect(asked).toEqual([1, 2, 3, 1]);
  });

  it("lets a new key in once it has an answer worth keeping, in place of the hot key asked about longest ago", async () => {
    const { feed, asked, advance } = numbers({ maxKeys: 2 });
    await feed.read(1);
    await feed.read(2);
    // 3 had nothing when it came in, so it was the one to go; its answer then earns it the place.
    await feed.read(3);
    advance(1_000);
    await feed.read(3);
    await feed.read(2);
    expect(asked).toEqual([1, 2, 3]);
    await feed.read(1);
    expect(asked).toEqual([1, 2, 3, 1]);
  });
});
