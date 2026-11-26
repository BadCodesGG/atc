import { OFFLINE_AFTER_S } from "./feed-health";
import { KNOTS } from "./geo";
import type { TrafficSnapshot } from "./traffic";

/**
 * Turns the snapshots a client polls every few seconds into positions that move smoothly every
 * frame. Playback runs a fixed delay behind the live clock, so there is almost always a sample on
 * each side of the moment being drawn and an aircraft glides between real fixes instead of
 * snapping to each new one. Only when the feed stalls does it fall back on dead reckoning, and when
 * the report that ends a stall disagrees with where dead reckoning had got to, the drawn aircraft
 * chases its new path over a second or two rather than jumping to it.
 *
 * The motion rules, frame to frame, for each drawn aircraft:
 * - it never moves backward along its track: not against the way its path is going, not back on its
 *   move in the frame before and, in the air, not against the track it is drawn on; unless it was at
 *   rest (a pushback ends and the aircraft sets off forward). A correction that would pull it back
 *   holds it instead, and its path catches up with it;
 * - it never steps more than about a second of its own speed in one frame;
 * - an error over CORRECTION_SNAP is not the same track carrying on, and it jumps there.
 */

/** Seconds the picture runs behind the live clock. Covers the 4 s cache plus a poll interval of jitter. */
export const PLAYBACK_DELAY = 8;
/** Longest an aircraft is extrapolated past its last sighting before it starts to fade out. */
export const DEAD_RECKON_MAX = 15;
/**
 * Longest a ground aircraft is carried on past its fix: long enough to cross the playback delay with a
 * read or two missed (reads come every 5 s), so a taxiing aircraft keeps rolling instead of stalling and
 * then catching up. Not for the whole age of an old fix: taxiways turn and aircraft stop, and an old
 * ground fix carried on for 30 s or more would put a taxiing aircraft far off the pavement.
 */
export const GROUND_DEAD_RECKON_MAX = 12;
/**
 * Time constant, seconds, of the chase that takes a drawn aircraft onto a corrected path (95% there in
 * three of these): the shortest for a small correction, longer for a large one so it is never caught
 * up faster than CORRECTION_SPEED, up to the longest.
 */
export const CORRECTION_DECAY = 0.6;
const CORRECTION_DECAY_MAX = 2;
const CORRECTION_SPEED = 100;
/** A correction farther than this, metres, is not the same track carrying on: the aircraft jumps to it. */
export const CORRECTION_SNAP = 1_500;
/** The longest a drawn aircraft steps in one frame, as seconds of its own speed. */
export const STEP_SECONDS = 1;
/** The longest step allowed whatever the speed, metres: a correction to an aircraft at rest still settles. */
export const STEP_FLOOR = 5;
/** A move shorter than this, metres, says nothing about which way an aircraft is going. */
const MIN_MOVE = 1e-3;
/** Floating-point error, metres, in a move taken apart into directions and put back. */
const ROUNDING = 1e-12;
/**
 * Frames further apart than this, seconds, are not one motion (a hidden tab, a seek, a coarse replay):
 * the aircraft is drawn on its path, with nothing carried over from the frame before.
 */
const MAX_FRAME_GAP = 1;
/** A ground course over fixes closer than this, metres, is noise, not a direction. */
const MIN_COURSE = 3;
export const FADE_IN = 2;
/** Slower than this on the ground is standing still. */
const STOPPED_KT = 1;
export const FADE_OUT = 3;
/** Seconds of samples kept behind the playback moment, so a slightly late query still has its bracket. */
const HISTORY = 10;
const MAX_SAMPLES = 32;
/** A fix less than this after the previous one is the same report seen again. */
const MIN_SAMPLE_GAP = 0.05;

export interface TrackedAircraft {
  id: string;
  /** Metres east and north of the airport reference point. */
  x: number;
  y: number;
  /** Feet above mean sea level; 0 on the ground. */
  altitudeFt: number;
  /** Degrees clockwise from true north, in [0, 360). */
  headingDeg: number;
  /** False while no report has carried a track or heading: headingDeg is then a placeholder 0. */
  headingKnown: boolean;
  groundSpeedKt: number | null;
  onGround: boolean;
  verticalRateFpm: number | null;
  callsign: string | null;
  /** The tail number, when the feed carries one (the search reads it). */
  registration?: string | null;
  typeCode: string | null;
  military: boolean;
  category: string | null;
  /** 0 to 1: rises over 2 s for a new aircraft, falls over 3 s for one that has gone. */
  fade: number;
}

interface Sample {
  /** When the fix was taken, UTC seconds (snapshot time minus position age). */
  t: number;
  x: number;
  y: number;
  altitudeFt: number;
  headingDeg: number;
  headingKnown: boolean;
  groundSpeedKt: number | null;
  onGround: boolean;
  verticalRateFpm: number | null;
}

/** Metres [east, north]. */
type Vector = [number, number];
/** A unit Vector: a way to go. */
type Direction = [number, number];

/** Where an aircraft was last drawn, and which way it was going: what the next frame's move is held to. */
interface Drawn {
  /** The playback moment it was drawn at. */
  t: number;
  pose: Pose;
  /** The way its path was last going (kept while the path stands still); null when unknown or at rest. */
  travel: Direction | null;
  /** The way it moved in the frame before; null when it did not move. */
  last: Direction | null;
}

/** The direction of a move, or null for one too short to say. */
function unit([x, y]: Vector): Direction | null {
  const length = Math.hypot(x, y);
  return length > MIN_MOVE ? [x / length, y / length] : null;
}

/**
 * A move with whatever part of it runs against any of `ways` taken out, so it never goes back along one
 * of them. Ways more than a right angle apart leave no move forward at all: then it stands still.
 */
function holdForward(move: Vector, ways: (Direction | null)[]): Vector {
  let [x, y] = move;
  const held = ways.filter((u) => u !== null);
  for (const [ux, uy] of held) {
    const along = x * ux + y * uy;
    if (along < 0) {
      x -= along * ux;
      y -= along * uy;
    }
  }
  return held.some(([ux, uy]) => x * ux + y * uy < -ROUNDING) ? [0, 0] : [x, y];
}

/** A move cut down to `most` metres, in the same direction. */
function clampLength(move: Vector, most: number): Vector {
  const length = Math.hypot(...move);
  return length > most ? [(move[0] * most) / length, (move[1] * most) / length] : move;
}

interface Track {
  samples: Sample[];
  drawn: Drawn | null;
  /** Render time at which the aircraft becomes visible and starts fading in. */
  start: number;
  /** Time of the newest snapshot that listed it. */
  lastSeen: number;
  callsign: string | null;
  registration: string | null;
  typeCode: string | null;
  military: boolean;
  category: string | null;
}

const RAD = Math.PI / 180;
const wrap360 = (degrees: number) => ((degrees % 360) + 360) % 360;
/** Signed turn from one heading to another, the short way round, in [-180, 180). */
const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const lerpOrNearest = (a: number | null, b: number | null, u: number) => (a !== null && b !== null ? lerp(a, b, u) : u < 0.5 ? (a ?? b) : (b ?? a));

/** What a sample and an interpolated moment share: everything in TrackedAircraft that motion decides. */
type Pose = Omit<Sample, "t">;

function pose(s: Sample): Pose {
  return { x: s.x, y: s.y, altitudeFt: s.altitudeFt, headingDeg: s.headingDeg, headingKnown: s.headingKnown, groundSpeedKt: s.groundSpeedKt, onGround: s.onGround, verticalRateFpm: s.verticalRateFpm };
}

/** Metres per second along the sample's heading, as [east, north]; none when the direction is unknown. */
function velocity(s: Sample): [number, number] {
  if (!s.headingKnown) return [0, 0];
  const v = (s.groundSpeedKt ?? 0) * KNOTS;
  const h = s.headingDeg * RAD;
  return [v * Math.sin(h), v * Math.cos(h)];
}

/**
 * Where a sample has got to `elapsed` seconds later, flying straight on at the same speed and climb rate.
 * On the ground the reported direction can be the nose's, not the way the aircraft is going: one that
 * came to this fix tail first (`previous` lies ahead of its nose, as in a pushback) carries on tail first.
 */
function project(s: Sample, elapsed: number, previous?: Sample): Pick<Pose, "x" | "y" | "altitudeFt"> {
  let [vx, vy] = velocity(s);
  if (s.onGround && previous) {
    const cx = s.x - previous.x;
    const cy = s.y - previous.y;
    if (Math.hypot(cx, cy) > MIN_COURSE && cx * vx + cy * vy < 0) [vx, vy] = [-vx, -vy];
  }
  const climb = s.onGround ? 0 : ((s.verticalRateFpm ?? 0) / 60) * elapsed;
  return { x: s.x + vx * elapsed, y: s.y + vy * elapsed, altitudeFt: Math.max(0, s.altitudeFt + climb) };
}

/** Hermite tangent (metres over the whole segment), held to twice the chord so bad speeds cannot loop the path. */
function tangent(s: Sample, dt: number, chord: number): [number, number] {
  const [vx, vy] = velocity(s);
  const length = Math.hypot(vx, vy) * dt;
  const k = length > 2 * chord ? (2 * chord) / length : 1;
  return [vx * dt * k, vy * dt * k];
}

function between(a: Sample, b: Sample, t: number): Pose {
  const dt = b.t - a.t;
  const u = (t - a.t) / dt;
  let x = lerp(a.x, b.x, u);
  let y = lerp(a.y, b.y, u);
  // Velocity-aware curve when both ends are flying with a known speed; a plain line otherwise (on the
  // ground the broadcast heading need not be the direction of travel, e.g. in a pushback).
  if (!a.onGround && !b.onGround && a.groundSpeedKt !== null && b.groundSpeedKt !== null) {
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const [ax, ay] = tangent(a, dt, chord);
    const [bx, by] = tangent(b, dt, chord);
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    x = h00 * a.x + h10 * ax + h01 * b.x + h11 * bx;
    y = h00 * a.y + h10 * ay + h01 * b.y + h11 * by;
  }
  const nearest = u < 0.5 ? a : b;
  return {
    x,
    y,
    altitudeFt: lerp(a.altitudeFt, b.altitudeFt, u),
    headingDeg: wrap360(a.headingDeg + turn(a.headingDeg, b.headingDeg) * u),
    headingKnown: nearest.headingKnown,
    groundSpeedKt: lerpOrNearest(a.groundSpeedKt, b.groundSpeedKt, u),
    onGround: nearest.onGround,
    verticalRateFpm: lerpOrNearest(a.verticalRateFpm, b.verticalRateFpm, u),
  };
}

export class Tracker {
  private readonly delay: number;
  private readonly reckon: number;
  private readonly tracks = new Map<string, Track>();
  private newest = -Infinity;

  /**
   * `deadReckonMax`: how long an aircraft is flown on past its last sighting before it fades (default
   * DEAD_RECKON_MAX). The world map, drawing a recorded moment, flies it on without limit.
   */
  constructor({ playbackDelay = PLAYBACK_DELAY, deadReckonMax = DEAD_RECKON_MAX }: { playbackDelay?: number; deadReckonMax?: number } = {}) {
    this.delay = playbackDelay;
    this.reckon = deadReckonMax;
  }

  /** Aircraft currently tracked, including ones still fading out. */
  get size(): number {
    return this.tracks.size;
  }

  /** Samples held across all aircraft. */
  get sampleCount(): number {
    let n = 0;
    for (const track of this.tracks.values()) n += track.samples.length;
    return n;
  }

  /** Feed snapshots in arrival order; one that is not newer than the newest already seen is ignored. */
  add(snapshot: Pick<TrafficSnapshot, "time" | "aircraft">): void {
    if (!(snapshot.time > this.newest)) return;
    this.newest = snapshot.time;
    for (const a of snapshot.aircraft) {
      let track = this.tracks.get(a.id);
      if (!track) {
        track = { samples: [], drawn: null, start: 0, lastSeen: snapshot.time, callsign: null, registration: null, typeCode: null, military: false, category: null };
        this.tracks.set(a.id, track);
      }
      track.lastSeen = snapshot.time;
      track.callsign = a.callsign ?? track.callsign;
      track.registration = a.registration ?? track.registration;
      track.typeCode = a.typeCode ?? track.typeCode;
      track.military ||= a.military;
      track.category = a.category ?? track.category;

      // Time each fix by when it was taken. The same old fix turns up in snapshot after snapshot for
      // a transponder that rarely reports; it is one sample, not many.
      const t = snapshot.time - a.positionAge;
      const last = track.samples.at(-1);
      if (!last || t > last.t + MIN_SAMPLE_GAP) {
        track.samples.push({
          t,
          x: a.x,
          y: a.y,
          altitudeFt: a.altitudeFt,
          headingDeg: a.trackDeg !== null ? wrap360(a.trackDeg) : (last?.headingDeg ?? 0),
          headingKnown: a.trackDeg !== null || (last?.headingKnown ?? false),
          groundSpeedKt: a.groundSpeedKt,
          onGround: a.onGround,
          verticalRateFpm: a.verticalRateFpm,
        });
        if (!last) track.start = Math.max(t, snapshot.time - this.delay);
      }
    }
    this.prune();
  }

  /**
   * Every visible aircraft at `time`, the live clock in the snapshots' own UTC seconds: the picture
   * is of `time - playbackDelay`. Call with non-decreasing times; samples behind the playback moment
   * are discarded as snapshots arrive.
   */
  at(time: number): TrackedAircraft[] {
    const t = time - this.delay;
    const out: TrackedAircraft[] = [];
    for (const [id, track] of this.tracks) {
      const fade = Math.min(1, (t - track.start) / FADE_IN, 1 - (t - (track.lastSeen + this.reckonFor(track))) / FADE_OUT);
      if (!(fade > 0)) {
        track.drawn = null;
        continue;
      }
      out.push({ id, callsign: track.callsign, registration: track.registration, typeCode: track.typeCode, military: track.military, category: track.category, fade, ...this.draw(track, t) });
    }
    return out;
  }

  /**
   * Where the track is drawn at playback moment t: on from where it was drawn the frame before by as far
   * as its path moved, plus a share of whatever separates it from its path (a new report having moved
   * the path since), held to the motion rules.
   */
  private draw(track: Track, t: number): Pose {
    const target = this.state(track, t);
    const previous = track.drawn;
    if (!previous || t - previous.t > MAX_FRAME_GAP || t < previous.t) {
      track.drawn = { t, pose: target, travel: null, last: null };
      return target;
    }
    if (t === previous.t) return previous.pose;
    const dt = t - previous.t;
    const from = previous.pose;
    // How the path itself moved over the frame, as it stands now.
    const pathThen = this.state(track, previous.t);
    const pathStep: Vector = [target.x - pathThen.x, target.y - pathThen.y];
    const pathClimb = target.altitudeFt - pathThen.altitudeFt;
    const pathTurn = turn(pathThen.headingDeg, target.headingDeg);
    // What still separates the drawn aircraft from its path once carried on with it.
    const errX = target.x - (from.x + pathStep[0]);
    const errY = target.y - (from.y + pathStep[1]);
    const error = Math.hypot(errX, errY);
    if (error > CORRECTION_SNAP) {
      track.drawn = { t, pose: target, travel: null, last: null };
      return target;
    }
    const chase = 1 - Math.exp(-dt / Math.min(CORRECTION_DECAY_MAX, Math.max(CORRECTION_DECAY, error / CORRECTION_SPEED)));
    let step: Vector = [pathStep[0] + errX * chase, pathStep[1] + errY * chase];

    const atRest = from.groundSpeedKt !== null && from.groundSpeedKt < STOPPED_KT;
    const travel = unit(pathStep) ?? (atRest ? null : previous.travel);
    if (!atRest) {
      // In the air the reported track is the way over the ground, so it is a way forward too.
      const flown: Direction | null = !from.onGround && from.headingKnown ? [Math.sin(from.headingDeg * RAD), Math.cos(from.headingDeg * RAD)] : null;
      step = holdForward(step, [travel, previous.last, flown]);
    }
    // Never more than about a second of its own speed in a frame: the reported one, else its path's.
    const speed = from.groundSpeedKt !== null ? from.groundSpeedKt * KNOTS : Math.hypot(...pathStep) / dt;
    step = clampLength(step, Math.max(speed * STEP_SECONDS, STEP_FLOOR));

    const altitudeFt = Math.max(0, from.altitudeFt + pathClimb + (target.altitudeFt - from.altitudeFt - pathClimb) * chase);
    const heading = from.headingDeg + pathTurn;
    const pose: Pose = { ...target, x: from.x + step[0], y: from.y + step[1], altitudeFt, headingDeg: wrap360(heading + turn(heading, target.headingDeg) * chase) };
    // A frame it stood still in leaves it free to set off any way its path goes next (a hairpin turn
    // between two ground fixes): what it may not do is turn straight back on a move it just made.
    track.drawn = { t, pose, travel, last: unit(step) };
    return pose;
  }

  private state(track: Track, t: number): Pose {
    const { samples } = track;
    const last = samples[samples.length - 1];
    if (t >= last.t) {
      // Past the newest fix: carry on from it. An aircraft still being listed with an old fix is
      // extrapolated from that fix to its last listing, and 15 s beyond.
      const elapsed = Math.min(t - last.t, track.lastSeen - last.t + this.reckon, last.onGround ? GROUND_DEAD_RECKON_MAX : Infinity);
      return { ...pose(last), ...project(last, elapsed, samples.at(-2)) };
    }
    // Before the oldest fix still held: pruning can leave one fix ahead of a moment drawn a little
    // behind the feed. Hold at that fix.
    if (t <= samples[0].t) return pose(samples[0]);
    let i = samples.length - 2;
    while (i > 0 && samples[i].t > t) i--;
    const a = samples[i];
    return t <= a.t ? pose(a) : between(a, samples[i + 1], t);
  }

  /**
   * How long a track is drawn on past its last listing: the flying-on limit, but an aircraft standing
   * on the ground at its last fix is no guess, so it stays as long as the server still serves that answer
   * (adsb.lol can answer 429 for minutes, and a held or parked aircraft would otherwise blink out).
   */
  private reckonFor(track: Track): number {
    const last = track.samples.at(-1);
    return last && last.onGround && (last.groundSpeedKt ?? 0) < STOPPED_KT ? Math.max(this.reckon, OFFLINE_AFTER_S) : this.reckon;
  }

  private prune(): void {
    const playback = this.newest - this.delay;
    for (const [id, track] of this.tracks) {
      if (track.lastSeen + this.reckonFor(track) + FADE_OUT < playback) {
        this.tracks.delete(id);
        continue;
      }
      const { samples } = track;
      let drop = Math.max(0, samples.length - MAX_SAMPLES);
      while (samples.length - drop > 1 && samples[drop + 1].t <= playback - HISTORY) drop++;
      if (drop) samples.splice(0, drop);
    }
  }
}
