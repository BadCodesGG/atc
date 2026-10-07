import type { Airport } from "./airports";
import { OFFLINE_AFTER_S } from "./feed-health";
import { fetchTraffic, type TrafficSnapshot } from "./traffic";
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, parseRetryAfter, RATE_LIMITED, type ReadOptions, UpstreamBusyError, UpstreamStatusError } from "./upstream";

/**
 * The server's read of the live feed, one per process. adsb.lol answers about one poll in three with
 * HTTP 429 when several clients poll (upstream.ts falls back to adsb.fi first, and only throws a 429
 * when neither can answer), so a failed read is not a failed answer: the last good snapshot
 * of each airport (or, for the world map, each region cell) is kept and served, marked stale, for as
 * long as it still says something useful. A 429 (or the 420 adsb.lol sends once a client is over its
 * limit) also starts a back-off during which the upstream is not called at all.
 */

/** A snapshot older than this (seconds) is no longer served in place of a fresh one: the page calls it Offline then. */
export const STALE_MAX_S = OFFLINE_AFTER_S;
/** One upstream read per airport per this long, however many requests arrive. */
export const MEMO_MS = 4_000;

export interface FeedAnswer<T = TrafficSnapshot> {
  snapshot: T;
  /** True when the upstream failed and this is the last good snapshot. */
  stale: boolean;
  /** Whole seconds since the snapshot was read from the upstream; set when stale. */
  ageS?: number;
}

interface FeedOptions {
  /** Milliseconds, as `Date.now`. */
  now?: () => number;
  log?: (line: string) => void;
}

interface Source<Q, T> extends FeedOptions {
  /** One read; `options` is for the upstream's cap on requests (known: this key already has a good snapshot), and goes on to its read. */
  fetchSnapshot: (query: Q, options: Required<ReadOptions>) => Promise<T>;
  /** One feed per key: an airport's code, a cell's corner. */
  keyOf: (query: Q) => string;
  /** What the log lines call it: "traffic atl: ...". */
  name: string;
  /** One upstream read per key per this long, however many requests arrive (MEMO_MS). */
  memoMs?: number;
  /** Keys held at most, for keys that come from requests: a key with nothing worth keeping is forgotten first, then the one asked about longest ago. */
  maxKeys?: number;
  /** Whether this snapshot says something worth keeping through a flood of other keys (an aircraft with a position, a cell with aircraft in it); true for any where not given. */
  worth?: (snapshot: T) => boolean;
  /** How long this snapshot answers the key without another read, ms, where that is not memoMs: a short-lived answer is refreshed, a "not found" kept longer. */
  holdMs?: (snapshot: T) => number | undefined;
}

interface KeyFeed<T> {
  /** `worth`: whether it says something worth keeping (see Source). */
  good: { snapshot: T; at: number; worth: boolean } | null;
  /** The promise is stored, so requests arriving while the upstream is still answering share that one read. */
  memo: { at: number; read: Promise<T | null> } | null;
  /** How long the last read stands in for another: memoMs, or what `holdMs` says of the snapshot it got. */
  holdMs: number;
  /** No upstream call before this time. */
  backoffUntil: number;
  /** The last back-off length, so a repeat can double it; 0 after a success. */
  backoffMs: number;
}

/**
 * A fresh read, else the last good one while it is recent enough, else null; for any upstream keyed by `keyOf`.
 * When the server's cap on upstream requests is spent (UpstreamBusyError) a key with nothing recent enough to
 * serve gets that error thrown, for the route to answer 503 with; it is not remembered, so the next ask tries again.
 */
export class LastGoodFeed<Q, T> {
  private readonly feeds = new Map<string, KeyFeed<T>>();
  private readonly fetchSnapshot: Source<Q, T>["fetchSnapshot"];
  private readonly keyOf: (query: Q) => string;
  private readonly name: string;
  private readonly memoMs: number;
  private readonly maxKeys: number;
  private readonly holdMs: ((snapshot: T) => number | undefined) | undefined;
  private readonly worth: (snapshot: T) => boolean;
  private lastSweep = -Infinity;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor({ fetchSnapshot, keyOf, name, memoMs = MEMO_MS, maxKeys = Infinity, holdMs, worth = () => true, now = Date.now, log = console.warn }: Source<Q, T>) {
    this.maxKeys = maxKeys;
    this.holdMs = holdMs;
    this.worth = worth;
    this.fetchSnapshot = fetchSnapshot;
    this.keyOf = keyOf;
    this.name = name;
    this.memoMs = memoMs;
    this.now = now;
    this.log = log;
  }

  /** A fresh snapshot, else the last good one if it is recent enough, else null. */
  async read(query: Q): Promise<FeedAnswer<T> | null> {
    const key = this.keyOf(query);
    const feed = this.feedFor(key);
    const now = this.now();
    if (now >= feed.backoffUntil) {
      if (!feed.memo || now - feed.memo.at >= feed.holdMs) feed.memo = { at: now, read: this.fetchOnce(query, key, feed) };
      const read = feed.memo.read;
      try {
        const fresh = await read;
        if (fresh) return { snapshot: fresh, stale: false };
      } catch (error) {
        if (!(error instanceof UpstreamBusyError)) throw error;
        if (feed.memo?.read === read) feed.memo = null;
        const held = this.stale(feed);
        if (held) return held;
        throw error;
      }
    }
    return this.stale(feed);
  }

  private feedFor(key: string): KeyFeed<T> {
    this.sweep();
    let feed = this.feeds.get(key);
    // Asked about again, a key moves to the back of the queue to be forgotten.
    if (feed) this.feeds.delete(key);
    else feed = { good: null, memo: null, holdMs: this.memoMs, backoffUntil: 0, backoffMs: 0 };
    this.feeds.set(key, feed);
    this.trim();
    return feed;
  }

  /**
   * Whether the key has something worth keeping: a good snapshot, still young enough to serve, that says
   * something (`worth`). It is what a refresh may spend the upstream's reserve for, and what a flood of other
   * keys may not push out.
   */
  private keepable(feed: KeyFeed<T>): boolean {
    return feed.good !== null && feed.good.worth && this.stale(feed) !== null;
  }

  /**
   * Holds at most maxKeys. The key to forget is the one asked about longest ago that has nothing worth
   * keeping (it never got an answer, or only an empty one, or its snapshot is too old to serve), and only
   * when every key has something is it the one asked about longest ago. Keys come from requests, so a
   * caller sending fresh ones that fail, are refused or find nothing would otherwise push out, one by one,
   * the hot keys' last good snapshots, the only thing they could be served stale from. A new key counts as
   * having nothing until it is answered, so it is forgotten at once while the table is full of hot ones;
   * fetchOnce lets it back in when its answer is worth keeping.
   */
  private trim(): void {
    if (this.feeds.size <= this.maxKeys) return;
    for (const [key, feed] of this.feeds) {
      if (!this.keepable(feed)) {
        this.feeds.delete(key);
        return;
      }
    }
    this.feeds.delete(this.feeds.keys().next().value!);
  }

  /**
   * Forgets the keys whose last good snapshot is too old to be served and whose back-off is over: they
   * answer exactly as a key never asked about does, so only memory is saved. At most once a second.
   */
  private sweep(): void {
    const now = this.now();
    if (now - this.lastSweep < 1_000) return;
    this.lastSweep = now;
    for (const [key, feed] of this.feeds) if (feed.good && now - feed.good.at > STALE_MAX_S * 1000 && now >= feed.backoffUntil) this.feeds.delete(key);
  }

  /** Keys held now. */
  get size(): number {
    return this.feeds.size;
  }

  /** The last good snapshot if it is recent enough, marked stale as it is not read now; never calls the upstream. */
  peek(query: Q): FeedAnswer<T> | null {
    const feed = this.feeds.get(this.keyOf(query));
    return feed ? this.stale(feed) : null;
  }

  private stale(feed: KeyFeed<T>): FeedAnswer<T> | null {
    if (!feed.good) return null;
    const ageMs = this.now() - feed.good.at;
    if (ageMs > STALE_MAX_S * 1000) return null;
    return { snapshot: feed.good.snapshot, stale: true, ageS: Math.round(ageMs / 1000) };
  }

  private async fetchOnce(query: Q, key: string, feed: KeyFeed<T>): Promise<T | null> {
    try {
      const snapshot = await this.fetchSnapshot(query, { known: this.keepable(feed) });
      feed.good = { snapshot, at: this.now(), worth: this.worth(snapshot) };
      // A key forgotten while it waited, with an answer worth keeping now, takes the place of the key asked about longest ago.
      if (feed.good.worth && !this.feeds.has(key)) {
        this.feeds.set(key, feed);
        this.trim();
      }
      feed.holdMs = this.holdMs?.(snapshot) ?? this.memoMs;
      feed.backoffMs = 0;
      feed.backoffUntil = 0;
      return snapshot;
    } catch (error) {
      feed.holdMs = this.memoMs;
      if (error instanceof UpstreamBusyError) throw error;
      if (error instanceof UpstreamStatusError && RATE_LIMITED.has(error.status)) {
        const now = this.now();
        const asked = parseRetryAfter(error.retryAfter, now);
        feed.backoffMs = asked ?? (feed.backoffMs ? Math.min(feed.backoffMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS);
        feed.backoffUntil = now + feed.backoffMs;
        this.log(`${this.name} ${key}: upstream ${error.status}, backing off ${Math.round(feed.backoffMs / 1000)}s`);
      } else {
        this.log(`${this.name} ${key}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
  }
}

/** The live aircraft round each airport. */
export class TrafficFeed extends LastGoodFeed<Airport, TrafficSnapshot> {
  constructor({ fetchSnapshot = (airport: Airport, options: Required<ReadOptions>) => fetchTraffic(airport, undefined, options), ...options }: FeedOptions & { fetchSnapshot?: (airport: Airport, options: Required<ReadOptions>) => Promise<TrafficSnapshot> } = {}) {
    super({ fetchSnapshot, keyOf: (airport) => airport.code, name: "traffic", ...options });
  }
}

export const trafficFeed = new TrafficFeed();
