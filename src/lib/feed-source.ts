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
  /** Seconds on the feed's own clock (its answers' timestamps): `now()` set by the answers heard. Never runs backward. */
  clock(): number;
  /** An answer's timestamp, UTC seconds: the first one sets the clock; every later one re-syncs it, smoothly. */
  heard(time: number): void;
  /** An API route's answer. */
  get(path: string): Promise<Response>;
  /** Calls `fn` every `seconds` of this source's clock, until the returned stop is called. */
  every(seconds: number, fn: () => void): () => void;
}

/**
 * Seconds of answers the feed clock's offset is estimated over. An answer can only be older than the
 * moment it is heard (a cache, the network), never newer, so the freshest one in the window is the best
 * estimate; the window is short enough to follow an upstream clock drifting the other way.
 */
const SYNC_WINDOW_S = 60;
/** The fastest the feed clock is pulled onto a new estimate, seconds per second: the picture plays at most 10% fast or slow while it is. */
const SYNC_SLEW = 0.1;

/**
 * Seconds after the first answer in which the clock takes each new estimate outright: the picture plays
 * 8 s behind the feed, so nothing is drawn yet, and a first answer served old is not slewed off for minutes.
 */
const SYNC_SETTLE_S = 8;

/** The network, on the wall's clock, offset to the feed's own: set by the first answer and re-synced by every one after. */
export function liveSource(): FeedSource {
  const now = () => Date.now() / 1000;
  /** Offsets (answer time minus the wall's) of the answers heard within the window, and when each was heard. */
  let answers: { at: number; offset: number }[] = [];
  /** When the first answer was heard; the offset in use; and when that was last moved toward the estimate. */
  let first: number | null = null;
  let offset = 0;
  let moved = 0;
  /** Moves the offset in use toward the freshest answer in the window, as far as the time since it last moved allows. */
  const resync = (wall: number) => {
    answers = answers.filter((a) => wall - a.at < SYNC_WINDOW_S);
    if (first === null || answers.length === 0) return;
    const estimate = Math.max(...answers.map((a) => a.offset));
    const most = wall - first < SYNC_SETTLE_S ? Infinity : SYNC_SLEW * Math.max(0, wall - moved);
    offset += Math.max(-most, Math.min(most, estimate - offset));
    moved = wall;
  };
  return {
    now,
    clock: () => {
      const wall = now();
      resync(wall);
      return wall + offset;
    },
    heard: (time) => {
      const wall = now();
      resync(wall);
      answers.push({ at: wall, offset: time - wall });
      first ??= wall;
      resync(wall);
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
