/**
 * How current the live feed is, for the LIVE dot in the time bar. The server marks an answer `stale`
 * with its age when the upstream failed and it served its last good snapshot, and answers 502 when it
 * has nothing recent enough to serve; the poll loops record both here. A store of its own so the poll
 * loops, which outlive any one scene, and the dot do not have to share React state through the page.
 *
 * Two channels: the airport's feed, which the diorama polls, and the world map's region reads. The dot
 * shows whichever the reader is looking at.
 */

/** The last good data is current up to this age, seconds. */
export const FRESH_MAX_S = 15;
/** Past this age, seconds, the data is too old to call live; the server stops serving it then too. */
export const OFFLINE_AFTER_S = 90;

export type FeedChannel = "airport" | "map";

export interface FeedStatus {
  /** Whole seconds since the last good data was read upstream; null before the first answer. */
  ageS: number | null;
  /** The server answered 502: the upstream is failing and it has nothing recent to serve. */
  failed: boolean;
}

export type LiveState = "fresh" | "stale" | "offline" | "replay";

/** The dot's state and the label beside it. Replay wins; then a 502, then the age. */
export function liveDot({ ageS, failed }: FeedStatus, replaying: boolean): { state: LiveState; label: string } {
  if (replaying) return { state: "replay", label: "LIVE" };
  if (failed || (ageS !== null && ageS > OFFLINE_AFTER_S)) return { state: "offline", label: "Offline" };
  if (ageS !== null && ageS > FRESH_MAX_S) return { state: "stale", label: `LIVE · ${ageS} s` };
  return { state: "fresh", label: "LIVE" };
}

/** What the counts and lists have to go on: a first answer still to come, no feed to hear one from, or traffic read. */
export type TrafficReadout = "loading" | "offline" | "ready";

/**
 * Whether the counts and lists mean what they say. With aircraft tracked they do, whatever the dot says
 * (a fixture can read offline with its recording on show). With none, they do only once the feed has
 * answered and is not dark: before that a zero is not a count but a gap (the first answer is still on its
 * way, or there is nothing to read from), and the page says so rather than "0 tracked".
 */
export function trafficReadout({ heard, tracked }: { heard: boolean; tracked: number }, status: FeedStatus): TrafficReadout {
  if (tracked > 0) return "ready";
  if (liveDot(status, false).state === "offline") return "offline";
  return heard ? "ready" : "loading";
}

/** One read in a round (the map reads a few region cells at once): what came back, or the failing status (null when the request itself failed). */
export type Read = { ok: true; stale?: boolean; ageS?: number } | { ok: false; status: number | null };

/**
 * A round of reads as the one thing to record: the freshest of the answers that came back, as the feed
 * is live while any part of it is (one rate-limited cell among several aging past 90 s between reads
 * would otherwise turn the whole map red); with none back, the failure, a 502 if any read had one. Null
 * when nothing was read.
 */
export function summariseReads(reads: readonly Read[]): { answer: { stale: boolean; ageS: number } } | { failure: number | null } | null {
  if (!reads.length) return null;
  let answer: { stale: boolean; ageS: number } | null = null;
  for (const read of reads) {
    if (!read.ok) continue;
    const ageS = read.stale && typeof read.ageS === "number" ? read.ageS : 0;
    if (!answer || ageS < answer.ageS) answer = { stale: ageS > 0, ageS };
  }
  if (answer) return { answer };
  const statuses = reads.map((r) => (r.ok ? null : r.status));
  return { failure: statuses.includes(502) ? 502 : (statuses.find((s) => s !== null) ?? null) };
}

/**
 * How a fixture's feed starts: held current, as a frozen moment is, unless the address asks for
 * `&feed=stale` or `&feed=offline`, so the checks can see those states without a failing upstream.
 */
export function fixtureFeed(flag: string | null): { hold?: boolean; ageS?: number; failed?: boolean } {
  return flag === "stale" ? { ageS: 25 } : flag === "offline" ? { failed: true } : { hold: true };
}

interface Feed {
  /** When the feed started, ms: with no answer yet the age counts from here, so a dead connection goes Offline. */
  since: number;
  /** When the last good data was read upstream, ms on this page's clock. */
  goodAt: number | null;
  failed: boolean;
  /** Always current unless a read fails with nothing to serve: a frozen fixture, or the map zoomed out past its aircraft. */
  hold: boolean;
}

const feeds: Record<FeedChannel, Feed> = {
  airport: { since: 0, goodAt: null, failed: false, hold: true },
  map: { since: 0, goodAt: null, failed: false, hold: true },
};
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * Starts a channel over, for a new airport, a fixture, or the map's change of zoom. `hold` keeps it
 * current; `ageS` and `failed` start it stale or offline, so the checks can see those states without a
 * failing upstream.
 */
export function startFeed(nowMs: number, { hold = false, ageS, failed = false }: { hold?: boolean; ageS?: number; failed?: boolean } = {}, channel: FeedChannel = "airport"): void {
  feeds[channel] = { since: nowMs, goodAt: ageS === undefined ? null : nowMs - ageS * 1000, failed, hold };
  notify();
}

/** Records an answer the server gave 200 to: fresh, or its last good snapshot marked `stale` with its `ageS`. */
export function recordFeedAnswer(answer: { stale?: unknown; ageS?: unknown }, nowMs: number, channel: FeedChannel = "airport"): void {
  const ageS = answer.stale === true && typeof answer.ageS === "number" && Number.isFinite(answer.ageS) ? Math.max(0, answer.ageS) : 0;
  feeds[channel] = { ...feeds[channel], goodAt: nowMs - ageS * 1000, failed: false };
  notify();
}

/**
 * Records a poll that brought nothing: its HTTP status, or null when the request itself failed. Only a
 * 502, the server saying it has nothing to serve, is Offline at once; anything else lets the data age.
 */
export function recordFeedFailure(status: number | null, channel: FeedChannel = "airport"): void {
  if (status !== 502) return;
  feeds[channel] = { ...feeds[channel], failed: true };
  notify();
}

export function feedStatus(nowMs: number, channel: FeedChannel = "airport"): FeedStatus {
  const feed = feeds[channel];
  if (feed.hold) return { ageS: 0, failed: feed.failed };
  const ageS = Math.max(0, Math.floor((nowMs - (feed.goodAt ?? feed.since)) / 1000));
  // Before the first answer there is no data to give an age for until it would count as late.
  return { ageS: feed.goodAt === null && ageS <= FRESH_MAX_S ? null : ageS, failed: feed.failed };
}

/** Told on every recorded answer or failure. */
export function subscribeFeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const current: Record<FeedChannel, FeedStatus> = { airport: { ageS: null, failed: false }, map: { ageS: null, failed: false } };
let ticker = 0;

/** The channel's status now, the same object until it changes, for `useSyncExternalStore`. */
export function currentFeedStatus(channel: FeedChannel): FeedStatus {
  const next = feedStatus(Date.now(), channel);
  if (next.ageS !== current[channel].ageS || next.failed !== current[channel].failed) current[channel] = next;
  return current[channel];
}

/** As `subscribeFeed`, and once a second besides, so the age shown keeps counting between polls. */
export function watchFeed(listener: () => void): () => void {
  const off = subscribeFeed(listener);
  if (listeners.size === 1) ticker = window.setInterval(notify, 1000);
  return () => {
    off();
    if (listeners.size === 0) window.clearInterval(ticker);
  };
}
