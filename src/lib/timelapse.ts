import type { FlightState } from "./aircraft-state";
import type { Point } from "./airport-map";
import { FEET, KNOTS } from "./geo";
import type { History } from "./history";
import { MAX_POSITION_AGE } from "./traffic";

/**
 * The time-lapse's light trails: each aircraft's path over the last few minutes of the replay, from
 * the fixes the page received, so the airport's flow shows (departure banks, the runways in use, the
 * taxi routes between them). Each point is coloured by what the aircraft was doing there; the scene
 * fades it with age.
 *
 * The trails are handed over a little at a time: each fix once, as the picture passes it, so a frame
 * costs only what is new. Only a jump (a seek, a new window) or a full buffer starts them again.
 */

/** A fix more than this after the one before starts a new run: the aircraft was out of coverage between them. */
const TRAIL_GAP = 60;
/** Climbing or descending faster than this, feet a minute, says which way an airborne aircraft is going. */
const CLIMB_FPM = 250;
/** A fix less than this after the previous one is the same report seen again (as in the tracker). */
const MIN_FIX_GAP = 0.05;
/**
 * A ground move faster than twice the reported speed (GROUND_SLOW m/s at least) plus GROUND_MARGIN is
 * a bad position; so is one of more than STILL_JITTER metres by an aircraft reporting no speed either side.
 */
const GROUND_SLOW = 5;
const GROUND_MARGIN = 10;
const STILL_KT = 1;
const STILL_JITTER = 30;
/** Points the scene's trail buffer holds; past it the trails start again from the history. */
export const TRAIL_POINTS = 60_000;

export interface TrailPoint {
  /** The run it belongs to: one aircraft's trail, unbroken. Points of a run come in order. */
  run: number;
  /** Map metres, and metres above the field. */
  x: number;
  y: number;
  h: number;
  /** When the aircraft was here, UTC seconds: its age is the picture minus this. */
  t: number;
  state: FlightState;
  onGround: boolean;
}

/** Where an aircraft is drawn now, which its trail runs on to so it never stops short of the aircraft. */
export interface TrailHead {
  id: string;
  x: number;
  y: number;
  heightM: number;
  state: FlightState;
}

export interface TrailUpdate {
  /** Drop every trail drawn so far: `added` starts them again. */
  reset: boolean;
  added: TrailPoint[];
  /** From each run's newest point to its aircraft as drawn now (along the pavement on the ground); replaced every frame. */
  heads: TrailPoint[][];
  picture: number;
  window: number;
}

/** Ways between two ground fixes that stay on the pavement (see taxi-route.ts). */
export interface GroundWays {
  /** The point on the pavement; null when there is none near enough to be where the aircraft really is. */
  snap(p: Point): Point | null;
  between(a: Point, b: Point): Point[];
}

interface Run {
  run: number;
  last: TrailPoint;
  altitudeFt: number;
  groundSpeedKt: number | null;
}

/** What an aircraft was doing at a fix, where that can be told; null for level flight. */
function stateAt(onGround: boolean, altitudeFt: number, verticalRateFpm: number | null, previous: Run | undefined): FlightState | null {
  if (onGround) return "taxiing";
  if (verticalRateFpm !== null && Math.abs(verticalRateFpm) > CLIMB_FPM) return verticalRateFpm > 0 ? "departing" : "arriving";
  if (previous?.last.onGround) return "departing";
  if (previous && previous.altitudeFt !== altitudeFt) return altitudeFt > previous.altitudeFt ? "departing" : "arriving";
  return null;
}

/**
 * Whether a ground aircraft could have got from `a` to (x, y) by `t`: no faster than twice its reported
 * speed and a margin. A parked aircraft whose broadcast position wanders hundreds of metres (it
 * happens, with a poor position source) would otherwise draw spikes across the field.
 */
function plausible(previous: Run, x: number, y: number, t: number, groundSpeedKt: number | null): boolean {
  const a = previous.last;
  const d = Math.hypot(x - a.x, y - a.y);
  const still = Math.max(previous.groundSpeedKt ?? Infinity, groundSpeedKt ?? Infinity) <= STILL_KT;
  if (still) return d <= STILL_JITTER;
  return d / Math.max(t - a.t, 1e-3) <= 2 * Math.max(GROUND_SLOW, (groundSpeedKt ?? 0) * KNOTS) + GROUND_MARGIN;
}

export class TrailFeed {
  private readonly history: History;
  private readonly elevationFt: number;
  private readonly ground: GroundWays | null;
  private readonly capacity: number;
  private readonly runs = new Map<string, Run>();
  private picture = -Infinity;
  private window = 0;
  /** The newest snapshot read. */
  private read = -Infinity;
  private nextRun = 0;
  private handed = 0;

  constructor(history: History, { elevationFt, ground = null, capacity = TRAIL_POINTS }: { elevationFt: number; ground?: GroundWays | null; capacity?: number }) {
    this.history = history;
    this.elevationFt = elevationFt;
    this.ground = ground;
    this.capacity = capacity;
  }

  /** Makes the next update start again from the history (after the trails were hidden, say). */
  restart(): void {
    this.picture = -Infinity;
  }

  /** What is new in the `window` seconds up to `picture`, and each trail's head at the aircraft drawn now. */
  update(picture: number, window: number, heads: TrailHead[]): TrailUpdate {
    const reset = picture < this.picture || picture - this.picture > window || window !== this.window || this.handed >= this.capacity;
    const added: TrailPoint[] = [];
    if (reset) {
      this.runs.clear();
      this.handed = 0;
      this.read = picture - window - MAX_POSITION_AGE;
    }
    this.picture = picture;
    this.window = window;
    const from = picture - window;
    const { history } = this;
    for (let i = history.indexAfter(this.read); i < history.length && history.timeAt(i) <= picture; i++) {
      this.read = history.timeAt(i);
      for (let k = 0; k < history.count(i); k++) {
        const f = history.fix(i, k);
        if (f.t < from || f.t > picture) continue;
        this.take(f, added);
      }
    }
    // Forget aircraft whose newest point has aged out.
    for (const [id, run] of this.runs) if (run.last.t < from) this.runs.delete(id);
    this.handed += added.length;

    const out: TrailPoint[][] = [];
    for (const head of heads) {
      const run = this.runs.get(head.id);
      if (!run || picture - run.last.t > TRAIL_GAP || run.last.t >= picture) continue;
      const onGround = head.state === "taxiing" || head.state === "parked";
      // To the nearest 2 m, so a slow taxi reuses the way it was given a frame ago.
      const to: TrailPoint = { run: run.run, x: Math.round(head.x / 2) * 2, y: Math.round(head.y / 2) * 2, h: head.heightM, t: picture, state: head.state, onGround };
      out.push([run.last, ...this.between(run.last, to), to]);
    }
    return { reset, added, heads: out, picture, window };
  }

  /** The points along the pavement between two ground points of a run, timed by distance; none in the air. */
  private between(a: TrailPoint, b: TrailPoint): TrailPoint[] {
    if (!a.onGround || !b.onGround || !this.ground) return [];
    const way = this.ground.between([a.x, a.y], [b.x, b.y]);
    if (!way.length) return [];
    const legs = [[a.x, a.y], ...way, [b.x, b.y]] as Point[];
    let total = 0;
    for (let i = 1; i < legs.length; i++) total += Math.hypot(legs[i][0] - legs[i - 1][0], legs[i][1] - legs[i - 1][1]);
    const out: TrailPoint[] = [];
    let along = 0;
    for (let i = 1; i < legs.length - 1; i++) {
      along += Math.hypot(legs[i][0] - legs[i - 1][0], legs[i][1] - legs[i - 1][1]);
      out.push({ run: b.run, x: legs[i][0], y: legs[i][1], h: 0, t: a.t + (total > 0 ? (b.t - a.t) * (along / total) : 0), state: "taxiing", onGround: true });
    }
    return out;
  }

  private take(f: ReturnType<History["fix"]>, added: TrailPoint[]): void {
    const previous = this.runs.get(f.id);
    if (previous && !(f.t > previous.last.t + MIN_FIX_GAP)) return;
    const snapped = f.onGround && this.ground ? this.ground.snap([f.x, f.y]) : ([f.x, f.y] as Point);
    // A ground fix nowhere near the pavement is a bad position: leave it out.
    if (!snapped) return;
    const [x, y] = snapped;
    const continues = previous && f.t - previous.last.t <= TRAIL_GAP && (!f.onGround || !previous.last.onGround || plausible(previous, x, y, f.t, f.groundSpeedKt));
    const run = continues ? previous.run : this.nextRun++;
    // A level stretch keeps the state it had; a run that starts level is taken to be arriving or taxiing.
    const state = stateAt(f.onGround, f.altitudeFt, f.verticalRateFpm, continues ? previous : undefined) ?? (continues ? previous.last.state : "arriving");
    const point: TrailPoint = { run, x, y, h: f.onGround ? 0 : Math.max(0, f.altitudeFt - this.elevationFt) * FEET, t: f.t, state, onGround: f.onGround };

    // Between two ground fixes, the way along the pavement.
    if (continues) added.push(...this.between(previous.last, point));
    added.push(point);
    this.runs.set(f.id, { run, last: point, altitudeFt: f.altitudeFt, groundSpeedKt: f.groundSpeedKt });
  }
}
