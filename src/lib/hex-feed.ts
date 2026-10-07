import { type HexSnapshot, parseHex } from "./hex";
import { type FeedAnswer, LastGoodFeed } from "./traffic-feed";
import { type Read, upstream } from "./upstream";

/**
 * One aircraft followed anywhere by its ICAO address, from adsb.lol (free, no key, ODbL) or adsb.fi:
 * `GET /v2/hex/{hex}`. Gate to gate follows a flight with this between the two airports' own feeds.
 * As the airports' and the map's feeds do, each hex is asked of adsb.lol at most once per four seconds
 * however many requests want it, the last good answer is served marked stale for up to 90 s while a
 * read fails, and a 429 backs off.
 */

/** Hexes held at once, the one asked about longest ago forgotten first: they come from requests. */
export const MAX_HEXES = 200;
/**
 * An address the upstream has no position for is not asked about again for this long (ms), instead of
 * the four seconds a flying aircraft's answer stands: any of the 16.7 million addresses can be asked
 * for, and a loop of repeats should cost the upstream one read, not one every four seconds. A followed
 * flight that drops out of coverage is picked up again within this.
 */
export const NOT_FOUND_MS = 20_000;

export class HexFeed {
  private readonly feed: LastGoodFeed<string, HexSnapshot>;

  constructor(
    read: Read = upstream.read,
    { now = Date.now, log, maxEntries = MAX_HEXES }: { now?: () => number; log?: (line: string) => void; maxEntries?: number } = {},
  ) {
    this.feed = new LastGoodFeed({
      // Only a validated hex is ever passed in (readHex), so the URL is built from six hex digits.
      fetchSnapshot: async (hex, options) => parseHex(JSON.parse((await read({ kind: "hex", hex }, options)).body), hex),
      keyOf: (hex) => hex,
      name: "hex",
      maxKeys: maxEntries,
      holdMs: (snapshot) => (snapshot.aircraft ? undefined : NOT_FOUND_MS),
      // Any of the 16.7 million addresses can be asked for, and nearly all have no position: only an aircraft is worth keeping.
      worth: (snapshot) => snapshot.aircraft !== null,
      now,
      log,
    });
  }

  /** The aircraft's answer: fresh, or the last good one marked stale; null when there is none recent enough. */
  read(hex: string): Promise<FeedAnswer<HexSnapshot> | null> {
    return this.feed.read(hex);
  }
}

/** The instance the API route shares. */
export const hexFeed = new HexFeed();
