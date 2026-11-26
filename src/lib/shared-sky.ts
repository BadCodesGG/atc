import type { FeedSource } from "./feed-source";
import type { Origin } from "./geo";
import { DEAD_RECKON_MAX, type TrackedAircraft, Tracker } from "./tracker";
import type { TrafficSnapshot } from "./traffic";

/**
 * The page's one picture of the sky (docs/adr/0001-one-shared-tracker.md): one geographic Tracker that the
 * airport feed, the World map's region reads and the Journey's hex poll all add their fixes to, and that the
 * Diorama, the World map and the Journey all read, at one moment per frame on the feed's clock. So an
 * aircraft is where it is whichever view draws it, and switching views never moves it.
 */

/** How long each feed flies an aircraft on once it stops listing it, seconds. */
export const AIRPORT_RECKON = DEAD_RECKON_MAX;
/** The map reads a region every 10 s, and only while it is in view. */
export const REGION_RECKON = 30;
/** A followed flight is flown on through a gap in its reads for a minute: in the air it goes on as it was going. */
export const HEX_RECKON = 60;

/** Each poll's snapshots are a feed of their own in the shared tracker. */
export const airportFeed = (code: string) => `airport:${code}`;
export const REGION_FEED = "region";
export const hexFeed = (hex: string) => `hex:${hex}`;

/** One feed of a tracker as the view drawing it fills and reads it: its snapshots in, its aircraft out, in the view's metres. */
export interface TrafficFeed {
  add(snapshot: Pick<TrafficSnapshot, "time" | "aircraft">): void;
  at(time: number): TrackedAircraft[];
}

/**
 * When the frame being drawn began, ms: one stamp for every view drawing it, and for anything that reads
 * between two frames. Null outside a page, or in a hidden one, which draws nothing.
 */
export function frameStamp(): number | null {
  if (typeof document === "undefined" || document.visibilityState === "hidden") return null;
  const t = document.timeline?.currentTime;
  return typeof t === "number" ? t : null;
}

/** `read`, read once per frame (as `stamp` tells frames apart): every view drawing a frame is given the same answer. */
export function oncePerFrame(read: () => number, stamp: () => number | null = frameStamp): () => number {
  let at: number | null = null;
  let value = 0;
  return () => {
    const s = stamp();
    if (s === null) return read();
    if (s !== at) {
      at = s;
      value = read();
    }
    return value;
  };
}

export class SharedSky {
  readonly tracker = new Tracker({ geographic: true });
  /**
   * The moment the views draw, on the feed's clock: read once a frame, so every view drawing it reads the
   * tracker at the same moment, the poses agree to the last digit, and no view ever reads it at a moment
   * earlier than another just has (which would start each aircraft's smoothing over).
   */
  readonly time: () => number;

  constructor(
    private readonly source: FeedSource,
    stamp: () => number | null = frameStamp,
  ) {
    this.time = oncePerFrame(() => source.clock(), stamp);
  }

  /** The feed's clock as it stands, read afresh: what time() latches once a frame. Views draw at time(). */
  clock(): number {
    return this.source.clock();
  }

  /** A feed's answer was timed `time`: the feed's clock follows the answers it hears. */
  heard(time: number): void {
    this.source.heard(time);
  }

  /** An airport's feed as its Diorama fills and reads it: in the airport's metres, with only the aircraft that feed lists. */
  airport(code: string, origin: Origin): TrafficFeed {
    const feed = airportFeed(code);
    return {
      add: (snapshot) => this.tracker.add(snapshot, { feed, reckon: AIRPORT_RECKON }),
      at: (time) => this.tracker.at(time, { frame: origin, feeds: [feed] }),
    };
  }
}
