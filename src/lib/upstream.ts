/**
 * Where the live aircraft are read from: adsb.lol first, adsb.fi when adsb.lol cannot answer. Both are
 * free, need no key, and answer in the same readsb format (`ac`, `now`, ...), so a caller asks for a
 * point or a hex and gets back the body of whichever provider answered. adsb.lol rations the shared
 * addresses serverless hosting sends from, which is why there is a second one at all.
 *
 * adsb.fi asks for no more than one request per second, for personal use, with a link to its home page
 * (the page's credit line carries it). Each provider here has its own back-off, shared by every key a
 * server instance reads, so a provider that has just refused is not asked again by the next airport.
 */

/** The statuses that mean "too many requests": 429, and the 420 adsb.lol answers with when it is tired of one address. */
export const RATE_LIMITED = new Set([420, 429]);
/** The first back-off after a 429 with no usable Retry-After; each repeat doubles it up to the cap. */
export const BACKOFF_MIN_MS = 10_000;
/** The longest back-off, whatever Retry-After asks for. */
export const BACKOFF_MAX_MS = 60_000;
/** A provider that failed some other way (a 5xx, a timeout, no network) is left alone this long. */
export const FAILURE_BACKOFF_MS = 5_000;
/** adsb.fi's limit is one request per second; a hair over, so a clock that drifts cannot cross it. */
export const ADSB_FI_GAP_MS = 1_100;
/**
 * The longest a read waits for its turn on a provider that is only spacing its requests (adsb.fi's
 * gap), milliseconds. A map view asks for about eight cells at once; while adsb.lol is limiting, one
 * read goes through adsb.fi at once and the others queue a gap apart behind it, five in all within this.
 * Longer than that a queued read gives up (a 429) rather than hold a serverless request open.
 */
export const MAX_GAP_WAIT_MS = 5_000;

/**
 * The most upstream requests one server instance sends in a burst, and the rate it earns them back at:
 * a token bucket over every read that actually leaves for a provider. Callers choose what to ask for (a
 * hex out of 16.7 million, a callsign, a cell of the world), so without a cap a loop of fresh keys could
 * hold both providers at their limits (adsb.fi allows one request a second) and lock every real user out.
 * Sized well above normal use: an airport on screen is about eight region cells and one traffic read per
 * ten seconds, the counts add a few cold cells per minute, and the feeds hold each key for four seconds
 * however many people ask, so a handful of airports watched at once stays under a fifth of the rate.
 * It is per instance (serverless runs several), so the platform's firewall is still the global limit.
 */
export const COLD_READ_BURST = 30;
export const COLD_READS_PER_S = 15;
/**
 * The part of the burst only a key that already has a good snapshot may spend: a third of it, so ten
 * requests. The cap is shared by every key and a caller chooses the keys, so one client sending fresh
 * valid ones (random hexes, random cells, random callsigns) at the sustained rate would otherwise keep the
 * bucket empty for everyone, and the hot keys could no longer refresh the snapshots that are the only thing
 * they can be served stale from. A new key may spend only while this much is left afterwards; a refresh of
 * a key already held may spend to zero. The flood is held to what the bucket earns above the reserve, and
 * the airports in use keep refreshing: ten is more than the eight cells a map view refreshes at once.
 */
const reserveOf = (burst: number) => Math.floor(burst / 3);
export const COLD_READ_RESERVE = reserveOf(COLD_READ_BURST);

/** The provider-side refusals that are not about this query (a blocked egress address, a missing key, a region block): the next provider may still answer. */
const REFUSED = new Set([401, 403, 407, 408, 451]);

/** The API's own limit on the search radius, nautical miles. */
const MAX_RADIUS_NM = 250;

/**
 * A Retry-After header (whole seconds or an HTTP date) as milliseconds from `nowMs`, capped at the
 * longest back-off. Null when it is absent, unreadable or not in the future.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - nowMs;
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, BACKOFF_MAX_MS) : null;
}

/** The upstream answered with a failing status; `retryAfter` is its Retry-After header, unparsed. */
export class UpstreamStatusError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
    url: string,
  ) {
    super(`upstream: ${status} for ${url}`);
    this.name = "UpstreamStatusError";
  }
}

/** The instance has sent as many requests as it is allowed to for now; nothing was asked of any provider. `retryAfter` is whole seconds. */
export class UpstreamBusyError extends UpstreamStatusError {
  constructor(retryAfterS: number) {
    super(503, String(retryAfterS), "(cold-read cap)");
    this.name = "UpstreamBusyError";
  }
}

export type Fetcher = (url: string) => Promise<string>;

export const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
    headers: { "User-Agent": "atc (live airport visualisation)", Accept: "application/json" },
  });
  if (!res.ok) throw new UpstreamStatusError(res.status, res.headers.get("Retry-After"), url);
  return res.text();
};

export type SourceName = "adsb.lol" | "adsb.fi";

/** What a caller wants: the aircraft within a radius of a point, or one by its ICAO address, or those sending a callsign or squawking a code. */
export type Query = { kind: "point"; latitude: number; longitude: number; radiusNm: number } | { kind: "hex"; hex: string } | { kind: "callsign"; callsign: string } | { kind: "squawk"; code: string };

/** A point query; throws on a radius the upstream would refuse. */
export function pointQuery(latitude: number, longitude: number, radiusNm: number): Query {
  if (!Number.isFinite(radiusNm) || radiusNm <= 0 || radiusNm > MAX_RADIUS_NM) throw new Error(`upstream: bad radius ${radiusNm}`);
  return { kind: "point", latitude, longitude, radiusNm };
}

export interface UpstreamAnswer {
  body: string;
  source: SourceName;
}

/** What a caller says of a read besides the query. */
export interface ReadOptions {
  /**
   * True when the key already has a good snapshot that this refreshes, which may spend the cap's reserve
   * (COLD_READ_RESERVE); false, or left out, for a key with nothing yet, which may not.
   */
  known?: boolean;
}

export type Read = (query: Query, options?: ReadOptions) => Promise<UpstreamAnswer>;

interface Provider {
  name: SourceName;
  url: (query: Query) => string;
  /** Least time between two of this provider's requests from one instance. */
  gapMs: number;
}

/** The path after the host, the same on both: the two speak the same v2 API for these. */
const lookupPath = (q: Exclude<Query, { kind: "point" }>) => (q.kind === "hex" ? `v2/hex/${q.hex}` : q.kind === "callsign" ? `v2/callsign/${q.callsign}` : `v2/sqk/${q.code}`);

/** In the order they are tried. A hex, callsign or squawk reaches a URL only after readHex, lookupCallsign or readSquawk has checked it. */
const PROVIDERS: readonly Provider[] = [
  {
    name: "adsb.lol",
    url: (q) => (q.kind === "point" ? `https://api.adsb.lol/v2/point/${q.latitude}/${q.longitude}/${q.radiusNm}` : `https://api.adsb.lol/${lookupPath(q)}`),
    gapMs: 0,
  },
  {
    name: "adsb.fi",
    url: (q) => (q.kind === "point" ? `https://opendata.adsb.fi/api/v3/lat/${q.latitude}/lon/${q.longitude}/dist/${q.radiusNm}` : `https://opendata.adsb.fi/api/${lookupPath(q)}`),
    gapMs: ADSB_FI_GAP_MS,
  },
];

/** The URL a provider is asked for a query. */
export function providerUrl(name: SourceName, query: Query): string {
  return PROVIDERS.find((p) => p.name === name)!.url(query);
}

interface ProviderState {
  /** No request before this time because of the gap since the last one. */
  skipUntil: number;
  /** No request before this time because it refused or failed. */
  backoffUntil: number;
  /** The last rate-limit back-off length, so a repeat can double it; 0 after a success. */
  limitedMs: number;
}

interface UpstreamOptions {
  /** Milliseconds, as `Date.now`. */
  now?: () => number;
  log?: (line: string) => void;
  /** The cold-read cap (COLD_READ_BURST, COLD_READS_PER_S). */
  burst?: number;
  perSecond?: number;
  /** The part of `burst` kept for refreshing keys that already have a snapshot (COLD_READ_RESERVE, a third). */
  reserve?: number;
  /** The longest a read waits for a provider's gap (MAX_GAP_WAIT_MS); 0 never waits. */
  maxGapWaitMs?: number;
  /** Waits this many milliseconds; as `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One server instance's reads: the providers in order, each with its own back-off. */
export class Upstream {
  private readonly states = new Map<SourceName, ProviderState>(PROVIDERS.map((p) => [p.name, { skipUntil: 0, backoffUntil: 0, limitedMs: 0 }]));
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly burst: number;
  private readonly perSecond: number;
  private readonly reserve: number;
  private readonly maxGapWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Requests still allowed now, and when that was worked out. */
  private tokens: number;
  private refilledAt: number;
  private refusedLoggedAt = -Infinity;

  constructor(
    private readonly get: Fetcher = defaultFetcher,
    { now = Date.now, log = console.warn, burst = COLD_READ_BURST, perSecond = COLD_READS_PER_S, reserve = reserveOf(burst), maxGapWaitMs = MAX_GAP_WAIT_MS, sleep = defaultSleep }: UpstreamOptions = {},
  ) {
    this.now = now;
    this.log = log;
    this.burst = burst;
    this.perSecond = perSecond;
    this.reserve = reserve;
    this.maxGapWaitMs = maxGapWaitMs;
    this.sleep = sleep;
    this.tokens = burst;
    this.refilledAt = now();
  }

  /**
   * Spends one request from the cap; false, having spent nothing, when it is spent. A key with no
   * snapshot yet (`known` false) is refused while spending would leave less than the reserve.
   */
  private spend(known: boolean): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.refilledAt) / 1000) * this.perSecond);
    this.refilledAt = now;
    if (this.tokens < this.needed(known)) return false;
    this.tokens -= 1;
    return true;
  }

  /** What the bucket must hold for a read to spend from it: one request, and the reserve besides for a key with no snapshot. */
  private needed(known: boolean): number {
    return 1 + (known ? 0 : this.reserve);
  }

  /**
   * The first provider that answers. A refusal (420, 429), a 5xx, a timeout or no network moves on to
   * the next provider; so does a refusal that is not about the query (a 403 for a blocked egress address,
   * 401, 451). Any other 4xx, a 404 for an unknown hex above all, is that provider's real answer and is
   * thrown as it is. A provider whose only obstacle is its gap is waited for, up to MAX_GAP_WAIT_MS:
   * concurrent reads reserve their turns in arrival order, one gap apart, so they are sent one at a time
   * rather than refused (a refusal is for a provider that is backed off, or a queue longer than the
   * bound). When the instance's cap on requests is spent (COLD_READS_PER_S), or is down to its reserve
   * for a key with no snapshot yet (COLD_READ_RESERVE), nothing is asked and an UpstreamBusyError is
   * thrown at once, before any slot is reserved or any wait taken (a read that waited its turn for a
   * request the cap then refused would have held the slot for nothing). When none can answer, a 429 is
   * thrown with the Retry-After of the soonest provider to be free again, which is what the feeds already back off on.
   */
  read: Read = async (query, { known = false } = {}) => {
    for (const provider of PROVIDERS) {
      const state = this.states.get(provider.name)!;
      let start = this.now();
      if (start < state.backoffUntil) continue;
      // The turn this read takes: now, or after the reads already queued for the provider's gap.
      const turn = Math.max(start, state.skipUntil);
      if (turn - start > this.maxGapWaitMs) continue;
      // Taken before the slot and the wait: a read the cap would refuse must not sleep first, and its slot would push the reads behind it past the bound.
      if (!this.spend(known)) {
        if (start - this.refusedLoggedAt >= 10_000) {
          this.refusedLoggedAt = start;
          this.log(`upstream: more than ${this.burst} requests at once or ${this.perSecond} a second, refusing the rest`);
        }
        throw new UpstreamBusyError(Math.max(1, Math.ceil((this.needed(known) - this.tokens) / this.perSecond)));
      }
      // Reserved before any wait or request, so reads that overlap cannot both slip under the gap.
      const reservedFrom = state.skipUntil;
      state.skipUntil = turn + provider.gapMs;
      if (turn > start) {
        await this.sleep(turn - start);
        start = this.now();
        // A read ahead of this one may have been refused while it waited: the provider is backed off, and nothing is sent.
        // The request is given back, and the slot too unless a later read has queued behind it.
        if (start < state.backoffUntil) {
          this.tokens = Math.min(this.burst, this.tokens + 1);
          if (state.skipUntil === turn + provider.gapMs) state.skipUntil = reservedFrom;
          continue;
        }
      }
      const url = provider.url(query);
      try {
        const body = await this.get(url);
        state.limitedMs = 0;
        return { body, source: provider.name };
      } catch (error) {
        if (error instanceof UpstreamStatusError && !RATE_LIMITED.has(error.status) && !REFUSED.has(error.status) && error.status < 500) throw error;
        this.fail(provider, state, error, start);
      }
    }
    const next = Math.min(...[...this.states.values()].map((s) => Math.max(s.backoffUntil, s.skipUntil)));
    throw new UpstreamStatusError(429, String(Math.max(1, Math.ceil((next - this.now()) / 1000))), providerUrl("adsb.lol", query));
  };

  private fail(provider: Provider, state: ProviderState, error: unknown, start: number): void {
    // A read that overlapped this one has already backed the provider off; it counts once.
    if (state.backoffUntil > start) return;
    const limited = error instanceof UpstreamStatusError && RATE_LIMITED.has(error.status);
    const asked = limited ? parseRetryAfter(error.retryAfter, start) : null;
    const ms = asked ?? (limited ? (state.limitedMs ? Math.min(state.limitedMs * 2, BACKOFF_MAX_MS) : BACKOFF_MIN_MS) : FAILURE_BACKOFF_MS);
    if (limited) state.limitedMs = ms;
    state.backoffUntil = this.now() + ms;
    this.log(`upstream ${provider.name}: ${error instanceof UpstreamStatusError ? error.status : error instanceof Error ? error.message : String(error)}, backing off ${Math.round(ms / 1000)}s`);
  }
}

/** The instance every feed of the server shares, so a provider's back-off holds for all of them. */
export const upstream = new Upstream();
