/**
 * What the page has seen of each aircraft's track since the map came up: a short, bounded list of its
 * positions. adsb.lol has no track-history API, so this is all the track there is, and the map draws it
 * as the observed line. Bounded three ways: points per aircraft, how far back, and how many aircraft;
 * the oldest go first. The selected aircraft is pinned, so a busy sky never takes its track.
 */

export type Coord = [number, number];

export interface HistoryLimits {
  /** Points kept for one aircraft. */
  maxPoints: number;
  /** Seconds kept behind the newest point. */
  maxAgeS: number;
  /** Aircraft kept; the one heard longest ago goes first. */
  maxAircraft: number;
  /** A position closer than this to the last kept one, metres, adds nothing (a parked aircraft). */
  minStepM: number;
}

export const HISTORY_LIMITS: HistoryLimits = { maxPoints: 600, maxAgeS: 1800, maxAircraft: 400, minStepM: 150 };

interface Track {
  /** Seconds of each point, oldest first, beside its position. */
  t: number[];
  points: Coord[];
}

const RAD = Math.PI / 180;
/** Metres between two points, close enough for a step size (equirectangular). */
function metresBetween(a: Coord, b: Coord): number {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * RAD);
  return 6_371_000 * RAD * Math.hypot(dx, b[1] - a[1]);
}

export class TrackHistory {
  private readonly tracks = new Map<string, Track>();
  private pinned: string | null = null;

  constructor(private readonly limits: HistoryLimits = HISTORY_LIMITS) {}

  get size(): number {
    return this.tracks.size;
  }

  /** The aircraft whose track is never dropped to make room (the selected one), or null. */
  pin(id: string | null): void {
    this.pinned = id;
  }

  /** Notes where `id` is at time `t` (seconds, on any clock that only runs forward). Longitudes are kept unwrapped, so a track over the antimeridian stays one line. */
  record(id: string, t: number, lng: number, lat: number): void {
    let track = this.tracks.get(id);
    if (!track) {
      track = { t: [], points: [] };
      // Re-inserted last whenever it is heard, so the Map's first key is always the one heard longest ago.
      this.tracks.set(id, track);
    }
    const last = track.points.at(-1);
    const unwrapped: Coord = [last ? lng + 360 * Math.round((last[0] - lng) / 360) : lng, lat];
    if (last && (t <= track.t.at(-1)! || metresBetween(last, unwrapped) < this.limits.minStepM)) return;
    track.t.push(t);
    track.points.push(unwrapped);
    // Heard now: moved to the back of the order.
    this.tracks.delete(id);
    this.tracks.set(id, track);
    const { maxAgeS, maxPoints } = this.limits;
    let drop = 0;
    while (drop < track.t.length - 1 && (track.t.length - drop > maxPoints || t - track.t[drop] > maxAgeS)) drop++;
    if (drop) {
      track.t.splice(0, drop);
      track.points.splice(0, drop);
    }
    this.trim();
  }

  /** The track of `id`, oldest first; empty when none has been seen. */
  track(id: string): Coord[] {
    return this.tracks.get(id)?.points.slice() ?? [];
  }

  /** Forgets every aircraft not heard for more than the age limit before `now` (seconds). */
  sweep(now: number): void {
    for (const [id, track] of this.tracks) {
      if (id !== this.pinned && now - track.t[track.t.length - 1] > this.limits.maxAgeS) this.tracks.delete(id);
    }
  }

  private trim(): void {
    for (const id of this.tracks.keys()) {
      if (this.tracks.size <= this.limits.maxAircraft) return;
      if (id !== this.pinned) this.tracks.delete(id);
    }
  }
}
