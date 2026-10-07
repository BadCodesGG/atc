import { type FeedAnswer, LastGoodFeed } from "./traffic-feed";
import { EMERGENCY_SQUAWKS, type EmergencySquawk, parseSquawk, type SquawkSnapshot } from "./squawk";
import { type Read, upstream } from "./upstream";

/**
 * The emergency squawks, read from adsb.lol (or adsb.fi when it refuses) once per code per four seconds however many requests want
 * them. As the airports', the map's and the hexes' feeds do, the last good answer is served marked stale
 * for up to 90 s while a read fails, and a 429 backs off.
 */
export class SquawkFeed {
  private readonly feed: LastGoodFeed<EmergencySquawk, SquawkSnapshot>;

  constructor(read: Read = upstream.read, { now = Date.now, log }: { now?: () => number; log?: (line: string) => void } = {}) {
    this.feed = new LastGoodFeed({
      // Only one of the three codes is ever passed in (readSquawk), so the URL is built from four digits.
      fetchSnapshot: async (code, options) => parseSquawk(JSON.parse((await read({ kind: "squawk", code }, options)).body), code),
      keyOf: (code) => code,
      name: "squawk",
      maxKeys: EMERGENCY_SQUAWKS.length,
      now,
      log,
    });
  }

  /** The code's answer: fresh, or the last good one marked stale; null when there is none recent enough. */
  read(code: EmergencySquawk): Promise<FeedAnswer<SquawkSnapshot> | null> {
    return this.feed.read(code);
  }
}

/** The instance the API route shares. */
export const squawkFeed = new SquawkFeed();
