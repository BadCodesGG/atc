/**
 * Where the page's feeds come from: the API routes over the network, or a fixture that answers the same
 * paths with the same shapes on a clock of its own (`?fixture=journey`, played compressed). The code that
 * polls, parses and tracks is the same either way; only this stands between it and the network.
 *
 * It also keeps the feed's clock, one for the whole page: every tracker plays its aircraft back on it,
 * so an aircraft read by two feeds (an airport's, and the hex a journey follows) is drawn at the same
 * moment by both, and the two pictures agree where they hand over.
 */
export interface FeedSource {
  /** Seconds on the clock the answers are timed against: the wall's, or the fixture's own. */
  now(): number;
  /** Seconds on the feed's own clock (its answers' timestamps): `now()` set by the first answer heard. */
  clock(): number;
  /** An answer's timestamp, UTC seconds: the first one sets the clock; later ones do not move it. */
  heard(time: number): void;
  /** An API route's answer. */
  get(path: string): Promise<Response>;
  /** Calls `fn` every `seconds` of this source's clock, until the returned stop is called. */
  every(seconds: number, fn: () => void): () => void;
}

/** The network, on the wall's clock. */
export function liveSource(): FeedSource {
  let offset: number | null = null;
  const now = () => Date.now() / 1000;
  return {
    now,
    clock: () => now() + (offset ?? 0),
    heard: (time) => {
      offset ??= time - now();
    },
    get: (path) => fetch(path, { cache: "no-store" }),
    every: (seconds, fn) => {
      const timer = setInterval(fn, seconds * 1000);
      // A hidden tab's timers are throttled to a minute or more: back in view, read at once, so the feed
      // shows its true state for at most one poll.
      const shown = () => {
        if (document.visibilityState === "visible") fn();
      };
      document.addEventListener("visibilitychange", shown);
      return () => {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", shown);
      };
    },
  };
}

/** How often a fixture's clock is looked at for a poll that has come due, ms. */
const TICK_MS = 25;

/**
 * A source answering from `answer(path, time)` on the clock `now`; a path it does not hold answers 404.
 * Its answers are stamped with its own clock, so that is the feed's clock as it stands.
 */
export function fixtureSource(answer: (path: string, time: number) => unknown | null, now: () => number): FeedSource {
  return {
    now,
    clock: now,
    heard: () => {},
    get: async (path) => {
      const body = answer(path, now());
      return body === null ? new Response(null, { status: 404 }) : Response.json(body);
    },
    every: (seconds, fn) => {
      let last = now();
      const timer = setInterval(() => {
        const t = now();
        if (t - last < seconds) return;
        last = t;
        fn();
      }, TICK_MS);
      return () => clearInterval(timer);
    },
  };
}
