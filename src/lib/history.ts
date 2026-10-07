import type { Aircraft, TrafficSnapshot } from "./traffic";

/**
 * Every snapshot the page has received since it opened, so it can be replayed. Nothing is stored on a
 * server (the app keeps no storage), so this is the whole of replay's memory, and it is bounded: three
 * hours at most, and never more than HISTORY_BYTES, the oldest snapshot dropped first.
 *
 * Each snapshot is kept as columns, not objects: nine 32-bit floats, seven interned string indices and
 * a flags byte per aircraft, 65 bytes a report. ATL at its busiest lists about 150 aircraft inside
 * 20 NM; polled every 5 s that is 720 snapshots and about 7 MB an hour, 21 MB for the full three.
 * A float32 holds a position to a few millimetres at 40 km, well inside what ADS-B reports.
 */

/** The longest stretch kept, seconds. */
export const HISTORY_SECONDS = 3 * 60 * 60;
/** The most memory the snapshots may take, bytes; past it the oldest go, however recent. */
export const HISTORY_BYTES = 32 * 1024 * 1024;

/** Float columns, in this order. Null is stored as NaN. */
const F_LAT = 0;
const F_LON = 1;
const F_X = 2;
const F_Y = 3;
const F_ALT = 4;
const F_GS = 5;
const F_TRACK = 6;
const F_VRATE = 7;
const F_AGE = 8;
const FLOATS = 9;
/** String columns, as indices into the interned table; 0 is null. */
const S_ID = 0;
const S_CALLSIGN = 1;
const S_REGISTRATION = 2;
const S_TYPE = 3;
const S_CATEGORY = 4;
const S_SOURCE = 5;
const S_SQUAWK = 6;
const STRINGS = 7;
const GROUND = 1;
const MILITARY = 2;
/** Bytes a report takes, and a snapshot's own fixed cost (its arrays and their headers). */
const REPORT_BYTES = FLOATS * 4 + STRINGS * 4 + 1;
const SNAPSHOT_BYTES = 256;

interface Packed {
  time: number;
  airport: TrafficSnapshot["airport"];
  floats: Float32Array;
  strings: Uint32Array;
  flags: Uint8Array;
}

const orNaN = (v: number | null) => (v === null ? NaN : v);
const orNull = (v: number) => (Number.isNaN(v) ? null : v);

export class History {
  private readonly maxSeconds: number;
  private readonly maxBytes: number;
  private readonly packed: Packed[] = [];
  /** Interned strings; index 0 stands for null. Ids, callsigns and squawks over three hours run to a few thousand. */
  private readonly table: (string | null)[] = [null];
  private readonly index = new Map<string, number>();
  private held = 0;

  constructor({ maxSeconds = HISTORY_SECONDS, maxBytes = HISTORY_BYTES }: { maxSeconds?: number; maxBytes?: number } = {}) {
    this.maxSeconds = maxSeconds;
    this.maxBytes = maxBytes;
  }

  /** Snapshots held. */
  get length(): number {
    return this.packed.length;
  }

  /** Bytes the held snapshots take, near enough (the string table is small and not counted). */
  get bytes(): number {
    return this.held;
  }

  /** Time of the oldest and newest snapshot held, UTC seconds; null while empty. */
  get start(): number | null {
    return this.packed[0]?.time ?? null;
  }

  get end(): number | null {
    return this.packed.at(-1)?.time ?? null;
  }

  timeAt(i: number): number {
    return this.packed[i].time;
  }

  /** Index of the first snapshot later than `time` (the length when there is none). */
  indexAfter(time: number): number {
    let lo = 0;
    let hi = this.packed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.packed[mid].time <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Keeps a snapshot; one that is not newer than the newest held is ignored, as the tracker does. */
  add(snapshot: TrafficSnapshot): void {
    const end = this.end;
    if (end !== null && !(snapshot.time > end)) return;
    const n = snapshot.aircraft.length;
    const floats = new Float32Array(n * FLOATS);
    const strings = new Uint32Array(n * STRINGS);
    const flags = new Uint8Array(n);
    snapshot.aircraft.forEach((a, i) => {
      floats.set([a.latitude, a.longitude, a.x, a.y, a.altitudeFt, orNaN(a.groundSpeedKt), orNaN(a.trackDeg), orNaN(a.verticalRateFpm), a.positionAge], i * FLOATS);
      strings.set([a.id, a.callsign, a.registration, a.typeCode, a.category, a.source, a.squawk].map((s) => this.intern(s)), i * STRINGS);
      flags[i] = (a.onGround ? GROUND : 0) | (a.military ? MILITARY : 0);
    });
    this.packed.push({ time: snapshot.time, airport: snapshot.airport, floats, strings, flags });
    this.held += SNAPSHOT_BYTES + n * REPORT_BYTES;
    while (this.packed.length > 1 && (snapshot.time - this.packed[0].time > this.maxSeconds || this.held > this.maxBytes)) {
      this.held -= SNAPSHOT_BYTES + this.packed.shift()!.flags.length * REPORT_BYTES;
    }
  }

  /** Reports in snapshot `i`. */
  count(i: number): number {
    return this.packed[i].flags.length;
  }

  /**
   * One report's position, straight from the columns, without building the whole report: where it was,
   * when the fix was taken, and how it was moving.
   */
  fix(i: number, k: number): { id: string; t: number; x: number; y: number; altitudeFt: number; onGround: boolean; verticalRateFpm: number | null; groundSpeedKt: number | null } {
    const p = this.packed[i];
    const f = k * FLOATS;
    return {
      id: this.table[p.strings[k * STRINGS + S_ID]]!,
      t: p.time - p.floats[f + F_AGE],
      x: p.floats[f + F_X],
      y: p.floats[f + F_Y],
      altitudeFt: p.floats[f + F_ALT],
      onGround: (p.flags[k] & GROUND) !== 0,
      verticalRateFpm: orNull(p.floats[f + F_VRATE]),
      groundSpeedKt: orNull(p.floats[f + F_GS]),
    };
  }

  /** Snapshot `i` as the feed sent it (numbers to float32 precision). */
  snapshot(i: number): TrafficSnapshot {
    const { time, airport, floats, strings, flags } = this.packed[i];
    const str = (k: number, column: number) => this.table[strings[k * STRINGS + column]];
    const aircraft: Aircraft[] = [];
    for (let k = 0; k < flags.length; k++) {
      const f = k * FLOATS;
      aircraft.push({
        id: str(k, S_ID)!,
        callsign: str(k, S_CALLSIGN),
        registration: str(k, S_REGISTRATION),
        typeCode: str(k, S_TYPE),
        military: (flags[k] & MILITARY) !== 0,
        category: str(k, S_CATEGORY),
        latitude: floats[f + F_LAT],
        longitude: floats[f + F_LON],
        x: floats[f + F_X],
        y: floats[f + F_Y],
        altitudeFt: floats[f + F_ALT],
        onGround: (flags[k] & GROUND) !== 0,
        groundSpeedKt: orNull(floats[f + F_GS]),
        trackDeg: orNull(floats[f + F_TRACK]),
        verticalRateFpm: orNull(floats[f + F_VRATE]),
        positionAge: floats[f + F_AGE],
        source: str(k, S_SOURCE),
        squawk: str(k, S_SQUAWK),
      });
    }
    return { airport, time, aircraft };
  }

  private intern(s: string | null): number {
    if (s === null) return 0;
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.table.push(s) - 1;
      this.index.set(s, i);
    }
    return i;
  }
}
