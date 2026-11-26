import { KNOTS, toGeo } from "./geo";
import { History } from "./history";
import { type GroundWays, type TrailHead, TrailFeed, type TrailUpdate } from "./timelapse";
import { CORRECTION_SNAP, DEAD_RECKON_MAX, FADE_IN, FADE_OUT, MAX_FRAME_GAP, PLAYBACK_DELAY, STEP_FLOOR, STEP_SECONDS, STOPPED_KT, type TrackedAircraft, Tracker } from "./tracker";
import type { TrafficFeed } from "./shared-sky";
import type { TrafficSnapshot } from "./traffic";

/**
 * Replay since the page opened. Times here are picture times: the moment an aircraft is drawn at, in
 * the feed's UTC seconds. Live, the picture runs PLAYBACK_DELAY behind the live clock; in a replay it
 * runs wherever the scrubber and the speed put it, between the start of the history and that live
 * picture, and catching up with it is going back to live.
 */

export type ReplayRate = 1 | 10 | 30;
/** At this speed and above, aircraft leave light trails, so the airport's flow shows. */
export const TIMELAPSE_RATE = 30;
/** Seconds of the reader's time a light trail lasts: ten minutes of the airport at 30x. */
export const TRAIL_WALL_SECONDS = 20;

/**
 * How far ahead of the picture a replay reads the history. The live tracker can only use snapshots that
 * have arrived; a replay knows what came next, so it runs well behind its own clock and nearly always
 * has a fix on both sides of the moment, even from a feed polled every 15 s.
 */
const REPLAY_DELAY = 30;
/**
 * Snapshots before the picture a seek feeds in: enough that an aircraft which was already there is
 * not faded in again, and one that had just gone is still fading out.
 */
const LOOKBACK = DEAD_RECKON_MAX + FADE_OUT + FADE_IN + 10;

/**
 * The tracker over the history: answers for any moment in it. Played forward it feeds snapshots as a
 * live page would have received them; asked for a moment behind the last one, or far ahead of it, it
 * starts a fresh tracker a little before that moment.
 */
export class Replayer {
  private tracker: Tracker | null = null;
  /** The live-equivalent clock last asked for, and the newest snapshot fed in. */
  private clock = -Infinity;
  private fed = -Infinity;

  constructor(private readonly history: History) {}

  at(picture: number): TrackedAircraft[] {
    const clock = picture + REPLAY_DELAY;
    if (!this.tracker || clock < this.clock || clock - this.clock > LOOKBACK) {
      this.tracker = new Tracker({ playbackDelay: REPLAY_DELAY });
      this.fed = picture - LOOKBACK;
    }
    const { history, tracker } = this;
    for (let i = history.indexAfter(this.fed); i < history.length && history.timeAt(i) <= clock; i++) {
      tracker.add(history.snapshot(i));
      this.fed = history.timeAt(i);
    }
    this.clock = clock;
    return tracker.at(clock);
  }
}

/** The span a replay can show: from when the first aircraft are in, to the live picture. */
export interface ReplayRange {
  start: number;
  live: number;
}

/** Where a replay is: live, or a picture time anchored to a moment on the reader's clock (seconds) and a speed. */
export class ReplayClock {
  private anchor: { picture: number; wall: number } | null = null;
  private speed: ReplayRate = 1;

  get live(): boolean {
    return this.anchor === null;
  }

  get rate(): ReplayRate {
    return this.speed;
  }

  /** The picture at `wall`, given the live one; catching up with live goes back to it. */
  picture(live: number, wall: number): number {
    if (!this.anchor) return live;
    const p = this.anchor.picture + this.speed * (wall - this.anchor.wall);
    if (p < live) return p;
    this.goLive();
    return live;
  }

  /** Plays at `rate`: from where the replay is, or from the start of the history when live. */
  play(rate: ReplayRate, range: ReplayRange, wall: number): void {
    const from = this.anchor ? this.picture(range.live, wall) : range.start;
    this.speed = rate;
    this.anchor = { picture: from, wall };
  }

  /** Goes to a moment and plays on from it at the current speed (real time when it was live). Its end is live. */
  seek(picture: number, range: ReplayRange, wall: number): void {
    if (picture >= range.live - 1) {
      this.goLive();
      return;
    }
    this.anchor = { picture: Math.max(range.start, picture), wall };
  }

  goLive(): void {
    this.anchor = null;
    this.speed = 1;
  }
}

/**
 * The seam where a replay catches up with live. The Replayer and the live tracker are apart on purpose
 * (docs/adr/0001-one-shared-tracker.md), so where they draw an aircraft at that moment can differ by tens
 * of metres. Across the switch each aircraft is eased from where the replay last drew it to where live has
 * it, under the Tracker's own rules for a frame (src/lib/tracker.ts): a step no longer than STEP_SECONDS of
 * its speed (never under STEP_FLOOR), not back along its heading unless it is at rest (it holds there and
 * live catches up with it), a gap over CORRECTION_SNAP taken at once, and frames over MAX_FRAME_GAP apart
 * not one motion. An aircraft is let go once it is drawn where live has it.
 */
export class Seam {
  /** Where each aircraft still being eased was last drawn, and when (the reader's clock, seconds). */
  private drawn = new Map<string, { x: number; y: number }>();
  private wall = 0;

  /** The replay's last frame, drawn at `wall`: what the next live frames ease from. */
  start(last: readonly TrackedAircraft[], wall: number): void {
    this.drawn = new Map(last.map((a) => [a.id, { x: a.x, y: a.y }]));
    this.wall = wall;
  }

  /** Nothing to ease: the picture jumped (LIVE pressed, a seek, a replay started). */
  clear(): void {
    this.drawn.clear();
  }

  /** Live's aircraft at `wall`, each still being eased drawn a step on from where it was. */
  ease(list: TrackedAircraft[], wall: number): TrackedAircraft[] {
    if (this.drawn.size === 0) return list;
    const gap = wall - this.wall;
    this.wall = wall;
    if (gap > MAX_FRAME_GAP) {
      this.drawn.clear();
      return list;
    }
    const next = new Map<string, { x: number; y: number }>();
    const out = list.map((a) => {
      const was = this.drawn.get(a.id);
      if (!was) return a;
      let [sx, sy] = [a.x - was.x, a.y - was.y];
      if (Math.hypot(sx, sy) > CORRECTION_SNAP) return a;
      const speedKt = a.groundSpeedKt ?? 0;
      if (a.headingKnown && speedKt >= STOPPED_KT) {
        // Not back along its heading: that part of the step is held, and live comes on to meet it.
        const h = (a.headingDeg * Math.PI) / 180;
        const [hx, hy] = [Math.sin(h), Math.cos(h)];
        const along = sx * hx + sy * hy;
        if (along < 0) [sx, sy] = [sx - along * hx, sy - along * hy];
      }
      const step = Math.hypot(sx, sy);
      const bound = Math.max(speedKt * KNOTS * STEP_SECONDS, STEP_FLOOR);
      if (step > bound) [sx, sy] = [(sx / step) * bound, (sy / step) * bound];
      const [x, y] = [was.x + sx, was.y + sy];
      // There: drawn where live has it from now on.
      if (Math.hypot(a.x - x, a.y - y) < 1e-6) return a;
      next.set(a.id, { x, y });
      if (a.latitude === undefined || a.longitude === undefined) return { ...a, x, y };
      const [latitude, longitude] = toGeo({ latitude: a.latitude, longitude: a.longitude }, x - a.x, y - a.y);
      return { ...a, x, y, latitude, longitude };
    });
    this.drawn = next;
    return out;
  }
}

/** What the time bar shows. */
export interface ReplayStatus {
  live: boolean;
  rate: ReplayRate;
  picture: number;
  /** The span the scrubber covers; start equals end before the first snapshot. */
  start: number;
  end: number;
}

/**
 * The page's replay: keeps every snapshot, and each frame says which aircraft to draw and at what
 * moment, from the live tracker or from the history.
 */
export class Replay {
  readonly history: History;
  private readonly clock = new ReplayClock();
  private readonly replayer: Replayer;
  private readonly feed: TrailFeed;
  /** The picture last drawn in a replay. */
  private drawn: number | null = null;
  /** Counts the picture's jumps (a seek, a replay started, back to live); `views` compares it with the one it last saw. */
  private jumps = 0;
  private seen = { jumps: 0, live: true };
  private trailing = false;
  /** Eases the aircraft across a replay's catching up with live; the replay's last frame is what it eases from. */
  private readonly seam = new Seam();
  private lastReplay: TrackedAircraft[] = [];

  constructor(
    /** The live picture: the airport's feed of the page's tracker, in the airport's metres. */
    private readonly live: Pick<TrafficFeed, "at">,
    {
      elevationFt,
      ground = null,
      history = new History(),
    }: {
      /** The field's elevation, feet: light trails are drawn at height above it. */
      elevationFt: number;
      /** Keeps taxi trails on the pavement; without it they run straight between fixes. */
      ground?: GroundWays | null;
      history?: History;
    },
  ) {
    this.history = history;
    this.replayer = new Replayer(history);
    this.feed = new TrailFeed(history, { elevationFt, ground });
  }

  /** Whether the picture is live rather than a moment from the history. */
  get isLive(): boolean {
    return this.clock.live;
  }

  /** Keeps a snapshot; the live tracker is fed separately, as it always was. */
  add(snapshot: TrafficSnapshot): void {
    this.history.add(snapshot);
  }

  private range(liveClock: number): ReplayRange {
    const live = liveClock - PLAYBACK_DELAY;
    const first = this.history.start;
    return { start: first === null ? live : Math.min(live, first + FADE_IN), live };
  }

  /** The aircraft to draw at this frame, and the moment they are of. `wall` is the reader's clock in seconds. */
  frame(liveClock: number, wall: number): { aircraft: TrackedAircraft[]; picture: number } {
    const replaying = !this.clock.live;
    const picture = this.clock.picture(liveClock - PLAYBACK_DELAY, wall);
    if (this.clock.live) {
      // The replay caught up with live this frame (LIVE pressed goes live before the frame, and is a jump).
      if (replaying) this.seam.start(this.lastReplay, wall);
      this.drawn = null;
      this.lastReplay = [];
      return { picture, aircraft: this.seam.ease(this.live.at(liveClock), wall) };
    }
    this.drawn = picture;
    this.lastReplay = this.replayer.at(picture);
    return { picture, aircraft: this.lastReplay };
  }

  /** Where the replay is, as of the last frame. */
  status(liveClock: number): ReplayStatus {
    const { start, live } = this.range(liveClock);
    const picture = this.clock.live ? live : (this.drawn ?? start);
    return { live: this.clock.live, rate: this.clock.rate, picture, start, end: live };
  }

  play(rate: ReplayRate, liveClock: number, wall: number): void {
    if (rate === 1 && this.clock.live) return;
    if (this.clock.live) this.jumps++;
    this.seam.clear();
    this.clock.play(rate, this.range(liveClock), wall);
  }

  seek(picture: number, liveClock: number, wall: number): void {
    this.jumps++;
    this.seam.clear();
    this.clock.seek(picture, this.range(liveClock), wall);
  }

  goLive(): void {
    this.jumps++;
    this.seam.clear();
    this.clock.goLive();
  }

  /**
   * Which of two views of the traffic draws this frame: the live one, or the replay's. Each remembers
   * things about every aircraft (its last state settles takeoff against landing), so neither is shown
   * the other's frames, and the one about to draw forgets what it knew whenever the picture has jumped.
   */
  views<V extends { forget(): void }>(live: V, replay: V): V {
    const isLive = this.clock.live;
    if (this.seen.jumps !== this.jumps || this.seen.live !== isLive) (isLive ? live : replay).forget();
    this.seen = { jumps: this.jumps, live: isLive };
    return isLive ? live : replay;
  }

  /**
   * What is new in the time-lapse's light trails (30x and up), with each trail's head at its aircraft
   * as drawn; null when there are none to draw.
   */
  trails(picture: number, heads: TrailHead[]): TrailUpdate | null {
    if (this.clock.live || this.clock.rate < TIMELAPSE_RATE) {
      if (this.trailing) this.feed.restart();
      this.trailing = false;
      return null;
    }
    this.trailing = true;
    return this.feed.update(picture, this.clock.rate * TRAIL_WALL_SECONDS, heads);
  }
}
