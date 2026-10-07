import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { airportByCode } from "./airports";
import { fetchTraffic } from "./traffic";
import { TrafficFeed } from "./traffic-feed";
import {
  ADSB_FI_GAP_MS,
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  COLD_READ_BURST,
  COLD_READ_RESERVE,
  COLD_READS_PER_S,
  FAILURE_BACKOFF_MS,
  MAX_GAP_WAIT_MS,
  parseRetryAfter,
  providerUrl,
  type Query,
  type SourceName,
  Upstream,
  UpstreamBusyError,
  UpstreamStatusError,
} from "./upstream";

const ATL = airportByCode("atl")!;
const POINT: Query = { kind: "point", latitude: 33.6367, longitude: -84.4281, radiusNm: 20 };
const BODY = JSON.stringify({ now: 1_790_794_144_001, ac: [{ hex: "abc123", lat: 33.64, lon: -84.43, alt_baro: 3000, gs: 200, seen_pos: 1 }] });
const status = (code: number, retryAfter: string | null = null) => new UpstreamStatusError(code, retryAfter, "https://example.test");

type Behaviour = () => string;

const failing =
  (error: Error): Behaviour =>
  () => {
    throw error;
  };

/**
 * An upstream on a fake clock whose two providers each answer by their own script, recording every provider asked.
 * It never waits for a gap (maxGapWaitMs 0), so a read inside adsb.fi's gap is refused at once.
 */
function harness(lol: Behaviour = () => BODY, fi: Behaviour = () => BODY) {
  let clock = 0;
  const asked: SourceName[] = [];
  const logs: string[] = [];
  const behaviours = { "adsb.lol": lol, "adsb.fi": fi };
  const upstream = new Upstream(
    async (url) => {
      const name = url.includes("adsb.lol") ? "adsb.lol" : "adsb.fi";
      asked.push(name);
      return behaviours[name]();
    },
    { now: () => clock, log: (line) => logs.push(line), maxGapWaitMs: 0 },
  );
  return {
    upstream,
    asked,
    logs,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
    set: (name: SourceName, behaviour: Behaviour) => (behaviours[name] = behaviour),
  };
}

/** A read whose outcome does not matter here, only which providers it asked. */
const poke = (upstream: Upstream) => upstream.read(POINT).catch(() => {});

describe("providerUrl", () => {
  it("asks adsb.lol and adsb.fi in their own forms for a point and for a hex", () => {
    expect(providerUrl("adsb.lol", POINT)).toBe("https://api.adsb.lol/v2/point/33.6367/-84.4281/20");
    expect(providerUrl("adsb.fi", POINT)).toBe("https://opendata.adsb.fi/api/v3/lat/33.6367/lon/-84.4281/dist/20");
    expect(providerUrl("adsb.lol", { kind: "hex", hex: "a1b2c3" })).toBe("https://api.adsb.lol/v2/hex/a1b2c3");
    expect(providerUrl("adsb.fi", { kind: "hex", hex: "a1b2c3" })).toBe("https://opendata.adsb.fi/api/v2/hex/a1b2c3");
    expect(providerUrl("adsb.lol", { kind: "callsign", callsign: "DAL3104" })).toBe("https://api.adsb.lol/v2/callsign/DAL3104");
    expect(providerUrl("adsb.fi", { kind: "callsign", callsign: "DAL3104" })).toBe("https://opendata.adsb.fi/api/v2/callsign/DAL3104");
    expect(providerUrl("adsb.lol", { kind: "squawk", code: "7700" })).toBe("https://api.adsb.lol/v2/sqk/7700");
    expect(providerUrl("adsb.fi", { kind: "squawk", code: "7700" })).toBe("https://opendata.adsb.fi/api/v2/sqk/7700");
  });
});

describe("Upstream", () => {
  it("answers from adsb.lol and does not touch adsb.fi while adsb.lol answers", async () => {
    const { upstream, asked } = harness();
    expect(await upstream.read(POINT)).toEqual({ body: BODY, source: "adsb.lol" });
    expect(asked).toEqual(["adsb.lol"]);
  });

  describe("falls through to adsb.fi", () => {
    const failures: [string, Error][] = [
      ["a 429", status(429)],
      ["a 420", status(420)],
      ["a 500", status(500)],
      ["a 503", status(503)],
      ["a network error", new TypeError("fetch failed")],
      ["a timeout", new DOMException("The operation timed out", "TimeoutError")],
      // A refusal of this instance rather than of the query, such as an egress block: adsb.fi may still answer.
      ["a 403", status(403)],
      ["a 401", status(401)],
      ["a 451", status(451)],
    ];

    it.each(failures)("on %s", async (_, error) => {
      const { upstream, asked } = harness(failing(error));
      expect(await upstream.read(POINT)).toEqual({ body: BODY, source: "adsb.fi" });
      expect(asked).toEqual(["adsb.lol", "adsb.fi"]);
    });
  });

  it("does not fall through on another 4xx: a 404 is adsb.lol's real answer", async () => {
    const { upstream, asked } = harness(failing(status(404)));
    await expect(upstream.read({ kind: "hex", hex: "a1b2c3" })).rejects.toMatchObject({ status: 404 });
    expect(asked).toEqual(["adsb.lol"]);
  });

  it("still throws adsb.fi's 404 for an unknown hex after adsb.lol refused with a 403: a not-found is an answer", async () => {
    const { upstream, asked } = harness(failing(status(403)), failing(status(404)));
    await expect(upstream.read({ kind: "hex", hex: "a1b2c3" })).rejects.toMatchObject({ status: 404 });
    expect(asked).toEqual(["adsb.lol", "adsb.fi"]);
  });

  it("throws adsb.fi's own real answer as it is when adsb.lol could not answer", async () => {
    const { upstream } = harness(failing(status(503)), failing(status(404)));
    await expect(upstream.read(POINT)).rejects.toMatchObject({ status: 404 });
  });

  describe("the cold-read cap", () => {
    const hex = (n: number): Query => ({ kind: "hex", hex: n.toString(16).padStart(6, "0") });
    const KNOWN = { known: true };
    const UNKNOWN = { known: false };

    it("lets a burst through, then refuses at once with a 503 and a Retry-After, without asking any provider", async () => {
      const { upstream, asked, logs } = harness();
      for (let i = 0; i < COLD_READ_BURST; i++) await upstream.read(hex(i), KNOWN);
      expect(asked).toHaveLength(COLD_READ_BURST);
      const refused = await upstream.read(hex(COLD_READ_BURST), KNOWN).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(UpstreamBusyError);
      expect(refused).toMatchObject({ status: 503, retryAfter: "1" });
      expect(asked).toHaveLength(COLD_READ_BURST);
      // Refused reads are not logged one by one.
      await upstream.read(hex(1), KNOWN).catch(() => {});
      expect(logs.filter((l) => /refusing the rest/.test(l))).toHaveLength(1);
    });

    it("earns requests back at the sustained rate, and no more than the burst", async () => {
      const { upstream, asked, advance } = harness();
      for (let i = 0; i < COLD_READ_BURST; i++) await upstream.read(hex(i), KNOWN);
      advance(1000);
      for (let i = 0; i < COLD_READS_PER_S; i++) await upstream.read(hex(i), KNOWN);
      await expect(upstream.read(hex(99), KNOWN)).rejects.toBeInstanceOf(UpstreamBusyError);
      expect(asked).toHaveLength(COLD_READ_BURST + COLD_READS_PER_S);
      advance(60_000);
      for (let i = 0; i < COLD_READ_BURST; i++) await upstream.read(hex(i), KNOWN);
      await expect(upstream.read(hex(99), KNOWN)).rejects.toBeInstanceOf(UpstreamBusyError);
    });

    it("keeps a reserve of the burst for keys that already have a good snapshot: a loop of new keys cannot spend it", async () => {
      const { upstream, asked } = harness();
      const newcomers = COLD_READ_BURST - COLD_READ_RESERVE;
      for (let i = 0; i < newcomers; i++) await upstream.read(hex(i), UNKNOWN);
      expect(asked).toHaveLength(newcomers);
      // The bucket is down to the reserve: another new key is refused at once, nothing asked.
      await expect(upstream.read(hex(500), UNKNOWN)).rejects.toBeInstanceOf(UpstreamBusyError);
      expect(asked).toHaveLength(newcomers);
      // A key that already has a snapshot still refreshes, the whole reserve of it.
      for (let i = 0; i < COLD_READ_RESERVE; i++) await upstream.read(hex(i), KNOWN);
      expect(asked).toHaveLength(COLD_READ_BURST);
      await expect(upstream.read(hex(501), KNOWN)).rejects.toBeInstanceOf(UpstreamBusyError);
    });

    it("treats a read that says nothing about its key as a new one", async () => {
      const { upstream } = harness();
      for (let i = 0; i < COLD_READ_BURST - COLD_READ_RESERVE; i++) await upstream.read(hex(i));
      await expect(upstream.read(hex(500))).rejects.toBeInstanceOf(UpstreamBusyError);
    });

    it("tells a new key to come back when the bucket has earned back past the reserve, not just one request", async () => {
      const { upstream, advance } = harness();
      for (let i = 0; i < COLD_READ_BURST - COLD_READ_RESERVE; i++) await upstream.read(hex(i), UNKNOWN);
      // 10 tokens left (the reserve); a new key needs 11, a second's worth of earning away at 15 a second.
      await expect(upstream.read(hex(500), UNKNOWN)).rejects.toMatchObject({ status: 503, retryAfter: "1" });
      advance(1000);
      expect((await upstream.read(hex(500), UNKNOWN)).source).toBe("adsb.lol");
    });

    it("is not spent by a read that no provider could be asked for", async () => {
      const { upstream, advance } = harness(failing(status(429, "60")), failing(status(429, "60")));
      await poke(upstream);
      advance(ADSB_FI_GAP_MS);
      // Both are backing off: these answer 429 with no request and no token.
      for (let i = 0; i < COLD_READ_BURST * 2; i++) await expect(upstream.read(hex(i))).rejects.toMatchObject({ status: 429 });
    });
  });

  describe("a provider that refused is skipped until its back-off passes", () => {
    it("goes straight to adsb.fi while adsb.lol's Retry-After runs, then tries adsb.lol first again", async () => {
      const { upstream, asked, advance, set } = harness(failing(status(429, "30")));
      await upstream.read(POINT);
      asked.length = 0;
      advance(ADSB_FI_GAP_MS);
      expect((await upstream.read(POINT)).source).toBe("adsb.fi");
      expect(asked).toEqual(["adsb.fi"]);
      set("adsb.lol", () => BODY);
      asked.length = 0;
      advance(30_000);
      expect((await upstream.read(POINT)).source).toBe("adsb.lol");
      expect(asked).toEqual(["adsb.lol"]);
    });

    it("backs off 10 s after a 429 with no Retry-After and doubles it on each repeat, up to the cap", async () => {
      const { upstream, advance, asked } = harness(failing(status(429)));
      const lolCalls = () => asked.filter((n) => n === "adsb.lol").length;
      await poke(upstream);
      advance(BACKOFF_MIN_MS - 1);
      await poke(upstream);
      expect(lolCalls()).toBe(1);
      advance(1);
      await poke(upstream);
      expect(lolCalls()).toBe(2);
      advance(2 * BACKOFF_MIN_MS - 1);
      await poke(upstream);
      expect(lolCalls()).toBe(2);
      advance(1);
      await poke(upstream);
      expect(lolCalls()).toBe(3);
      // Once past the cap every repeat waits the cap and no longer.
      for (let i = 0; i < 6; i++) {
        advance(BACKOFF_MAX_MS);
        await poke(upstream);
      }
      expect(lolCalls()).toBe(9);
      advance(BACKOFF_MAX_MS - 1);
      await poke(upstream);
      expect(lolCalls()).toBe(9);
    });

    it("starts the doubling again after a success", async () => {
      const { upstream, advance, set, asked } = harness(failing(status(429)));
      await poke(upstream);
      advance(BACKOFF_MIN_MS);
      await poke(upstream);
      advance(2 * BACKOFF_MIN_MS);
      set("adsb.lol", () => BODY);
      await poke(upstream);
      set("adsb.lol", failing(status(429)));
      advance(1);
      await poke(upstream);
      asked.length = 0;
      advance(BACKOFF_MIN_MS);
      await poke(upstream);
      expect(asked[0]).toBe("adsb.lol");
    });

    it("leaves a provider that failed some other way alone for a few seconds", async () => {
      const { upstream, advance, asked } = harness(failing(status(503)));
      await poke(upstream);
      asked.length = 0;
      advance(FAILURE_BACKOFF_MS - 1);
      await poke(upstream);
      expect(asked).not.toContain("adsb.lol");
      advance(1);
      await poke(upstream);
      expect(asked).toContain("adsb.lol");
    });

    it("counts reads that fail together as one refusal", async () => {
      const { upstream, advance, asked } = harness(failing(status(429)));
      await Promise.allSettled([upstream.read(POINT), upstream.read(POINT), upstream.read(POINT)]);
      asked.length = 0;
      advance(BACKOFF_MIN_MS);
      await upstream.read(POINT);
      expect(asked[0]).toBe("adsb.lol");
    });
  });

  describe("adsb.fi is asked at most once a second", () => {
    it("skips adsb.fi inside the gap and asks it again once the gap has passed", async () => {
      const { upstream, asked, advance } = harness(failing(status(429, "60")));
      await upstream.read(POINT);
      asked.length = 0;
      await expect(upstream.read(POINT)).rejects.toMatchObject({ status: 429 });
      advance(ADSB_FI_GAP_MS - 1);
      await expect(upstream.read(POINT)).rejects.toMatchObject({ status: 429 });
      expect(asked).toEqual([]);
      advance(1);
      expect((await upstream.read(POINT)).source).toBe("adsb.fi");
      expect(asked).toEqual(["adsb.fi"]);
    });

    it("lets one of several reads that arrive together through", async () => {
      const { upstream, asked, advance } = harness(failing(status(429, "60")));
      await upstream.read(POINT);
      asked.length = 0;
      advance(ADSB_FI_GAP_MS);
      const results = await Promise.allSettled([upstream.read(POINT), upstream.read(POINT), upstream.read(POINT)]);
      expect(asked).toEqual(["adsb.fi"]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    });

    it("does not hold adsb.lol to the gap", async () => {
      const { upstream, asked } = harness();
      await Promise.all([upstream.read(POINT), upstream.read(POINT), upstream.read(POINT)]);
      expect(asked).toEqual(["adsb.lol", "adsb.lol", "adsb.lol"]);
    });
  });

  describe("a read waits for adsb.fi's gap rather than being refused", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** An upstream on the fake timers' clock, adsb.lol backed off for a minute and adsb.fi's gap passed; each provider asked is recorded with when. */
    async function backedOff(fi: (nth: number) => string = () => BODY, options: { burst?: number; perSecond?: number; reserve?: number } = {}) {
      const asked: { name: SourceName; at: number }[] = [];
      let setUp = false;
      const upstream = new Upstream(
        async (url) => {
          const name = url.includes("adsb.lol") ? "adsb.lol" : "adsb.fi";
          asked.push({ name, at: Date.now() });
          if (name === "adsb.lol") throw status(429, "60");
          return setUp ? fi(asked.filter((a) => a.name === "adsb.fi").length - 1) : BODY;
        },
        { log: () => {}, ...options },
      );
      await upstream.read(POINT);
      asked.length = 0;
      setUp = true;
      await vi.advanceTimersByTimeAsync(ADSB_FI_GAP_MS);
      return { upstream, asked, fiAt: () => asked.filter((a) => a.name === "adsb.fi").map((a) => a.at) };
    }

    it("sends five reads that arrive together through adsb.fi, one gap apart", async () => {
      const { upstream, fiAt } = await backedOff();
      const reads = Array.from({ length: 5 }, () => upstream.read(POINT));
      await vi.advanceTimersByTimeAsync(5 * ADSB_FI_GAP_MS);
      const answers = await Promise.all(reads);
      expect(answers.map((a) => a.source)).toEqual(Array(5).fill("adsb.fi"));
      const at = fiAt();
      expect(at).toHaveLength(5);
      for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(ADSB_FI_GAP_MS);
    });

    it("refuses the reads queued beyond the longest wait, and never asks for them", async () => {
      const { upstream, fiAt } = await backedOff();
      const reads = Array.from({ length: 8 }, () => upstream.read(POINT).then((a) => a.source, (e: unknown) => e));
      await vi.advanceTimersByTimeAsync(MAX_GAP_WAIT_MS + ADSB_FI_GAP_MS);
      const results = await Promise.all(reads);
      const turns = Math.floor(MAX_GAP_WAIT_MS / ADSB_FI_GAP_MS) + 1;
      expect(results.slice(0, turns)).toEqual(Array(turns).fill("adsb.fi"));
      for (const refused of results.slice(turns)) expect(refused).toMatchObject({ status: 429 });
      expect(fiAt()).toHaveLength(turns);
    });

    it("sends nothing for a queued read when the read ahead of it was refused: adsb.fi is backed off by then", async () => {
      const { upstream, fiAt } = await backedOff(() => {
        throw status(429);
      });
      const reads = Array.from({ length: 3 }, () => upstream.read(POINT).then((a) => a.source, (e: unknown) => e));
      await vi.advanceTimersByTimeAsync(3 * ADSB_FI_GAP_MS);
      for (const result of await Promise.all(reads)) expect(result).toMatchObject({ status: 429 });
      expect(fiAt()).toHaveLength(1);
    });

    it("spends the cold-read cap on each request sent, not on each read that queued", async () => {
      // The setup took two of five, the first queued read one, leaving two: exactly what the last read needs (adsb.lol, then adsb.fi).
      // Had the other two queued reads each taken one for its wait, the last would find the cap spent.
      const { upstream } = await backedOff((nth) => {
        if (nth === 0) throw status(429);
        return BODY;
      }, { burst: 5, perSecond: 0.001, reserve: 0 });
      const reads = Array.from({ length: 3 }, () => upstream.read(POINT).catch((e: unknown) => e));
      await vi.advanceTimersByTimeAsync(3 * ADSB_FI_GAP_MS);
      await Promise.all(reads);
      await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS + 1);
      await expect(upstream.read(POINT)).resolves.toMatchObject({ body: BODY });
    });
  });

  describe("the cap is taken before adsb.fi's slot, so a read that cannot be sent neither waits nor holds a slot", () => {
    const KNOWN = { known: true };

    /**
     * An upstream on a clock the test moves. A wait does not end until the test says (`wake`), which moves the clock to the end of it,
     * and adsb.fi's answer is `fi`, called with the request's number. adsb.lol is backed off for a minute by the first read; the cap
     * is `burst` requests, earned back at `perSecond`.
     */
    async function queue(burst: number, fi: (nth: number) => Promise<string> = async () => BODY, perSecond = 1) {
      let clock = 0;
      let setUp = false;
      let fiCalls = 0;
      const slept: number[] = [];
      const waiting: (() => void)[] = [];
      const upstream = new Upstream(
        async (url) => {
          if (url.includes("adsb.lol")) {
            if (!setUp) throw status(429, "60");
            return BODY;
          }
          return setUp ? fi(fiCalls++) : BODY;
        },
        {
          now: () => clock,
          log: () => {},
          burst,
          perSecond,
          reserve: 0,
          sleep: (ms) =>
            new Promise<void>((resolve) => {
              slept.push(ms);
              waiting.push(() => {
                clock += ms;
                resolve();
              });
            }),
        },
      );
      await upstream.read(POINT, KNOWN);
      setUp = true;
      clock += ADSB_FI_GAP_MS;
      return {
        upstream,
        slept,
        advance: (ms: number) => (clock += ms),
        wake: async () => {
          waiting.shift()!();
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
      };
    }

    it("fails busy at once when the cap is empty, without sleeping for the gap and without moving the slot the next read takes", async () => {
      // The first read spent both tokens at time 0; 1.1 s on, 1.1 are earned back: one read goes through, the next finds the cap empty.
      const { upstream, slept, advance, wake } = await queue(2);
      expect((await upstream.read(POINT, KNOWN)).source).toBe("adsb.fi");
      await expect(upstream.read(POINT, KNOWN)).rejects.toBeInstanceOf(UpstreamBusyError);
      expect(slept).toEqual([]);
      // A second on, the cap has a request again; the slot is the first read's, a gap after it, not a second one behind a read that sent nothing.
      advance(1_000);
      const third = upstream.read(POINT, KNOWN);
      await wake();
      expect((await third).source).toBe("adsb.fi");
      expect(slept).toEqual([ADSB_FI_GAP_MS - 1_000]);
    });

    it("gives the request and the slot back when adsb.fi has backed off by the time a queued read wakes", async () => {
      let refuse!: () => void;
      const { upstream, slept, advance, wake } = await queue(4, async (nth) => {
        if (nth > 0) return BODY;
        return new Promise((_, reject) => (refuse = () => reject(status(429, "2"))));
      }, 0.001);
      // Four requests, no earning: the setup took two, the first read one, and the second took one for its wait.
      // The first is sent at 1.1 s and is pending; the second takes the slot after it (2.2 s) and waits for it.
      const first = upstream.read(POINT, KNOWN).catch((e: unknown) => e);
      const second = upstream.read(POINT, KNOWN).catch((e: unknown) => e);
      expect(slept).toEqual([ADSB_FI_GAP_MS]);
      // adsb.fi refuses the first (backed off until 3.1 s) while the second still waits: it wakes into the backoff and sends nothing.
      refuse();
      await first;
      await wake();
      expect(await second).toMatchObject({ status: 429 });
      // 3.1 s: adsb.fi is free, and the second's slot (3.3 s) was given back, so this read is on time.
      advance(3_100 - 2 * ADSB_FI_GAP_MS);
      // The third takes the request the second gave back: without it the cap would be spent.
      expect((await upstream.read(POINT, KNOWN)).source).toBe("adsb.fi");
      expect(slept).toEqual([ADSB_FI_GAP_MS]);
    });
  });

  describe("when neither provider can answer", () => {
    it("throws a 429 carrying the seconds until the soonest provider is free", async () => {
      const { upstream } = harness(failing(status(429, "30")), failing(status(429, "12")));
      const error = await upstream.read(POINT).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpstreamStatusError);
      expect(error).toMatchObject({ status: 429, retryAfter: "12" });
    });

    it("throws a 429 for outright failures too", async () => {
      const { upstream } = harness(failing(new TypeError("fetch failed")), failing(status(500)));
      expect(await upstream.read(POINT).catch((e: unknown) => e)).toMatchObject({ status: 429, retryAfter: String(FAILURE_BACKOFF_MS / 1000) });
    });

    it("is what the feeds back off on, so the last good snapshot is served stale", async () => {
      const { upstream, now, advance, set } = harness(() => JSON.stringify({ now: 1_790_794_144_001, ac: [] }));
      const logs: string[] = [];
      const feed = new TrafficFeed({ now, log: (line) => logs.push(line), fetchSnapshot: (airport) => fetchTraffic(airport, upstream.read) });
      expect(await feed.read(ATL)).toMatchObject({ stale: false });
      set("adsb.lol", failing(status(429, "30")));
      set("adsb.fi", failing(status(429, "30")));
      advance(10_000);
      expect(await feed.read(ATL)).toMatchObject({ stale: true, ageS: 10 });
      expect(logs).toEqual(["traffic atl: upstream 429, backing off 30s"]);
    });
  });

  it("logs which provider refused and for how long", async () => {
    const { upstream, logs } = harness(failing(status(420)));
    await upstream.read(POINT);
    expect(logs).toEqual(["upstream adsb.lol: 420, backing off 10s"]);
  });
});

describe("parseRetryAfter", () => {
  const now = 1_790_794_144_000;

  it("reads whole seconds", () => {
    expect(parseRetryAfter("7", now)).toBe(7_000);
    expect(parseRetryAfter(" 30 ", now)).toBe(30_000);
  });

  it("reads an HTTP date relative to now", () => {
    expect(parseRetryAfter(new Date(now + 15_000).toUTCString(), now)).toBe(15_000);
  });

  it("caps what the upstream asks for at 60 s", () => {
    expect(parseRetryAfter("3600", now)).toBe(BACKOFF_MAX_MS);
    expect(parseRetryAfter(new Date(now + 3_600_000).toUTCString(), now)).toBe(BACKOFF_MAX_MS);
  });

  it("is null for nothing usable: absent, zero, a past date or junk", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("", now)).toBeNull();
    expect(parseRetryAfter("0", now)).toBeNull();
    expect(parseRetryAfter(new Date(now - 5_000).toUTCString(), now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});
