import { OFFLINE_AFTER_S } from "./feed-health";
import { KNOTS } from "./geo";
import type { TrafficSnapshot } from "./traffic";

/**
 * Turns the snapshots a client polls every few seconds into positions that move smoothly every
 * frame. Playback runs a fixed delay behind the live clock, so there is almost always a sample on
 * each side of the moment being drawn and an aircraft glides between real fixes instead of
 * snapping to each new one. Only when the feed stalls does it fall back on dead reckoning, and when
 * the report that ends a stall disagrees with where dead reckoning had got to, the difference is
 * blended away over a second or two rather than shown as a jump.
 */

/** Seconds the picture runs behind the live clock. Covers the 4 s cache plus a poll interval of jitter. */
export const PLAYBACK_DELAY = 8;
/** Longest an aircraft is extrapolated past its last sighting before it starts to fade out. */
export const DEAD_RECKON_MAX = 15;
/**
 * Longest a ground aircraft is carried on past its fix. Taxiways turn and aircraft stop: a ground fix
 * is often 30 s old or more, and carried on for all of it a taxiing aircraft ends up hundreds of
 * metres off the pavement. When the next fix arrives the difference is blended away.
 */
export const GROUND_DEAD_RECKON_MAX = 5;
/**
 * Time constant, seconds, of the decay that blends a correction away (95% gone in three of these):
 * the shortest for a small correction, longer for a large one so it is never caught up faster than
 * CORRECTION_SPEED, up to the longest.
 */
export const CORRECTION_DECAY = 0.6;
const CORRECTION_DECAY_MAX = 2;
const CORRECTION_SPEED = 100;
/** A correction farther than this, metres, is not the same track carrying on: the aircraft jumps to it. */
export const CORRECTION_SNAP = 1_500;
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

/**
 * The displacement between where an aircraft was drawn and where the samples now put it, at the
 * moment a new report changed its path. It decays to nothing from then on.
 */
interface Correction {
  at: number;
  /** Decay time constant, seconds. */
  decay: number;
  x: number;
  y: number;
  altitudeFt: number;
  headingDeg: number;
}

interface Track {
  samples: Sample[];
  correction: Correction | null;
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

/** Where a sample has got to `elapsed` seconds later, flying straight on at the same speed and climb rate. */
function project(s: Sample, elapsed: number): Pick<Pose, "x" | "y" | "altitudeFt"> {
  const [vx, vy] = velocity(s);
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
  /** The playback moment last drawn, so a new report can be blended from what is on screen. */
  private drawn: number | null = null;

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
        track = { samples: [], correction: null, start: 0, lastSeen: snapshot.time, callsign: null, registration: null, typeCode: null, military: false, category: null };
        this.tracks.set(a.id, track);
      }
      // Where it is on screen now, before this report changes its path (a new fix, or a longer listing).
      const drawn = this.drawn;
      const before = drawn !== null && track.samples.length > 0 && drawn >= Math.max(track.start, track.samples[0].t) ? this.pose(track, drawn) : null;
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
      if (before) this.correct(track, before, drawn!);
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
    this.drawn = t;
    const out: TrackedAircraft[] = [];
    for (const [id, track] of this.tracks) {
      const fade = Math.min(1, (t - track.start) / FADE_IN, 1 - (t - (track.lastSeen + this.reckonFor(track))) / FADE_OUT);
      if (!(fade > 0)) continue;
      out.push({ id, callsign: track.callsign, registration: track.registration, typeCode: track.typeCode, military: track.military, category: track.category, fade, ...this.pose(track, t) });
    }
    return out;
  }

  /** Where the track is drawn at playback moment t: its path through the samples, plus what is left of any correction. */
  private pose(track: Track, t: number): Pose {
    const p = this.state(track, t);
    const c = track.correction;
    if (!c) return p;
    const k = Math.exp(-Math.max(0, t - c.at) / c.decay);
    if (k < 1e-3) {
      track.correction = null;
      return p;
    }
    return {
      ...p,
      x: p.x + c.x * k,
      y: p.y + c.y * k,
      altitudeFt: Math.max(0, p.altitudeFt + c.altitudeFt * k),
      headingDeg: wrap360(p.headingDeg + c.headingDeg * k),
    };
  }

  /**
   * A new fix has just changed the track's path. Keep the aircraft where it was drawn by carrying the
   * difference as a correction that then decays; a difference too big to be the same track is dropped
   * and the aircraft jumps.
   */
  private correct(track: Track, before: Pose, t: number): void {
    track.correction = null;
    const after = this.state(track, t);
    const dx = before.x - after.x;
    const dy = before.y - after.y;
    const error = Math.hypot(dx, dy);
    const dAlt = before.altitudeFt - after.altitudeFt;
    const dHeading = turn(after.headingDeg, before.headingDeg);
    // Nothing moved; or too far to be the same track carrying on.
    if ((error < 1e-6 && Math.abs(dAlt) < 1e-6 && Math.abs(dHeading) < 1e-6) || error > CORRECTION_SNAP) return;
    const decay = Math.min(CORRECTION_DECAY_MAX, Math.max(CORRECTION_DECAY, error / CORRECTION_SPEED));
    track.correction = { at: t, decay, x: dx, y: dy, altitudeFt: dAlt, headingDeg: dHeading };
  }

  private state(track: Track, t: number): Pose {
    const { samples } = track;
    const last = samples[samples.length - 1];
    if (t >= last.t) {
      // Past the newest fix: carry on from it. An aircraft still being listed with an old fix is
      // extrapolated from that fix to its last listing, and 15 s beyond.
      const elapsed = Math.min(t - last.t, track.lastSeen - last.t + this.reckon, last.onGround ? GROUND_DEAD_RECKON_MAX : Infinity);
      return { ...pose(last), ...project(last, elapsed) };
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
