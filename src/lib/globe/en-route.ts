import { FEET, KNOTS, toGeo, toLocal, turn, wrap360 } from "../geo";
import type { Lens } from "./camera";
import type { Rect } from "./journey-frame";

/**
 * The En-route view's cameras (CONTEXT.md): how the World map frames a followed flight in 3D. Pure: a pose
 * and a camera in, a placement of the map's camera out, so each camera is tested on its own and a later
 * camera is one more case here. The layer that draws the aircraft (en-route-layer.ts) and the map that
 * places its camera (globe-map.ts) only carry these out.
 */

/** Every camera the en-route view will have. Map is the flat World map; the rest are 3D. */
export type EnRouteCamera = "map" | "chase" | "cockpit" | "side" | "top";

/** The cameras the Journey card offers, in its order: Map first, as Following starts there. */
export const EN_ROUTE_OFFERED: readonly EnRouteCamera[] = ["map", "chase", "cockpit", "side", "top"];

/** A camera's key: its place in the Journey card's order, from 1. */
export const enRouteShortcut = (camera: EnRouteCamera): string => String(EN_ROUTE_OFFERED.indexOf(camera) + 1);

/**
 * The camera a key press picks: 1 to 5, in the Journey card's order (no other key of the page's uses a
 * digit), or null for any other key and for one held with Ctrl, Alt or Meta (the browser's own). The
 * digit is read from the key's place too (`code`), so the number row picks a camera on a layout where it
 * types something else unshifted (AZERTY's & é " ' ( ), and so does the number pad.
 */
export function enRouteKey(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "metaKey">): EnRouteCamera | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const digit = /^[1-9]$/.test(e.key) ? e.key : /^(?:Digit|Numpad)([1-9])$/.exec(e.code)?.[1];
  return digit ? (EN_ROUTE_OFFERED[Number(digit) - 1] ?? null) : null;
}

/** Whether a camera tilts the map into 3D, with terrain and the aircraft's model. */
export const is3D = (camera: EnRouteCamera): camera is Exclude<EnRouteCamera, "map"> => camera !== "map";

/**
 * The map's tilt limit on Map and under the Diorama, this app's own `maxPitch` map option (globe-map.ts): the
 * Diorama's cameras tilt no further, and the map follows them there.
 */
export const MAX_PITCH = 78;

/** The steepest climb or descent attitude drawn: past it the read is wrong, not the aircraft. */
const MAX_ATTITUDE_DEG = 20;

/**
 * The map's tilt limit while an En-route 3D camera is on (en-route-controller.ts raises the map's `maxPitch` to it
 * then, and puts MAX_PITCH back on Map): past level, so Side looks level at wing height and Cockpit looks along the
 * track pitched with the climb, up to the steepest attitude drawn. MapLibre allows up to 180.
 */
export const EN_ROUTE_MAX_PITCH = 90 + MAX_ATTITUDE_DEG;

/** Chase: behind the aircraft along its track and above it, looking down at it this many degrees, from this many of its lengths back. */
export const CHASE = { downDeg: 15, lengths: 6, minDistanceM: 120 } as const;

/** The followed aircraft as the en-route view draws it: where, how high above sea level, which way and how nose-up. */
export interface AircraftPose {
  latitude: number;
  longitude: number;
  altitudeM: number;
  trackDeg: number;
  /** The climb attitude: nose up (positive) or down, degrees. */
  pitchDeg: number;
}

/** A placement of the map's camera: the point it looks at (and that point's height), how far back it stands, which way it faces and its tilt from straight down. */
export interface EnRoutePlacement {
  center: { latitude: number; longitude: number };
  elevationM: number;
  distanceM: number;
  bearingDeg: number;
  pitchDeg: number;
}

/** A camera's ideal placement for a pose, and where its eye then is. */
export interface EnRouteShot extends EnRoutePlacement {
  eye: { latitude: number; longitude: number; altitudeM: number };
}

const RAD = Math.PI / 180;
/** Metres a second in a foot a minute. */
const FPM = FEET / 60;

/** What the pose is read from: a fix from the shared tracker (Journey.fix). */
export interface PoseFix {
  latitude: number;
  longitude: number;
  altitudeFt: number;
  onGround: boolean;
  groundSpeedKt: number | null;
  headingDeg: number;
  verticalRateFpm: number | null;
}

/**
 * The pose drawn for a fix: the feed's altitude (feet, barometric or geometric) in metres above sea level,
 * never below `groundM` (the terrain under it, 0 before any loads), on it on the ground; nose up by the
 * climb's angle (vertical rate over ground speed), level on the ground or with no rate.
 */
export function enRoutePose(fix: PoseFix, groundM: number): AircraftPose {
  const altitudeM = fix.onGround ? groundM : Math.max(groundM, fix.altitudeFt * FEET);
  let pitchDeg = 0;
  if (!fix.onGround && fix.verticalRateFpm !== null) {
    pitchDeg = Math.atan2(fix.verticalRateFpm * FPM, Math.max(0, fix.groundSpeedKt ?? 0) * KNOTS) / RAD;
    pitchDeg = Math.max(-MAX_ATTITUDE_DEG, Math.min(MAX_ATTITUDE_DEG, pitchDeg));
  }
  return { latitude: fix.latitude, longitude: fix.longitude, altitudeM, trackDeg: wrap360(fix.headingDeg), pitchDeg };
}

/** Side: abeam on the left at wing height, this many of the aircraft's lengths out (never nearer than the minimum), looking across at it. */
export const SIDE = { lengths: 5, minDistanceM: 150 } as const;
/** Top: straight above the aircraft, this many of its lengths up (never nearer than the minimum), looking down, track up. */
export const TOP = { lengths: 14, minDistanceM: 500 } as const;
/**
 * Cockpit: the eye is just ahead of the nose (the model's nose is half its length ahead of its origin,
 * scene/aircraft-model.ts) and a little up, at the flight deck's height, so the model never fills the view;
 * the map's centre is the point this far ahead along the look.
 */
export const COCKPIT = { aheadLengths: 0.55, upLengths: 0.08, lookM: 300 } as const;

/** A drag's look round the framing: degrees added to the camera's bearing and to its tilt. */
export interface Peek {
  bearingDeg: number;
  pitchDeg: number;
}

export const NO_PEEK: Peek = { bearingDeg: 0, pitchDeg: 0 };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clampPitch = (deg: number) => clamp(deg, 0, EN_ROUTE_MAX_PITCH);

/** Where a placement's eye is: back from the centre against the bearing, and up, by its distance and tilt. */
export function eyeOf(p: EnRoutePlacement): EnRouteShot["eye"] {
  const back = p.distanceM * Math.sin(p.pitchDeg * RAD);
  const up = p.distanceM * Math.cos(p.pitchDeg * RAD);
  const b = p.bearingDeg * RAD;
  const [latitude, longitude] = toGeo(p.center, -Math.sin(b) * back, -Math.cos(b) * back);
  return { latitude, longitude, altitudeM: p.elevationM + up };
}

/** The placement whose eye is `eye`, looking along `bearingDeg` tilted `pitchDeg` from straight down, centred `distanceM` along that look. */
function fromEye(eye: EnRouteShot["eye"], distanceM: number, bearingDeg: number, pitchDeg: number): EnRoutePlacement {
  const ahead = distanceM * Math.sin(pitchDeg * RAD);
  const down = distanceM * Math.cos(pitchDeg * RAD);
  const b = bearingDeg * RAD;
  const [latitude, longitude] = toGeo(eye, Math.sin(b) * ahead, Math.cos(b) * ahead);
  return { center: { latitude, longitude }, elevationM: eye.altitudeM - down, distanceM, bearingDeg: wrap360(bearingDeg), pitchDeg };
}

/**
 * A placement looked round by a drag's `peek`: Chase, Side and Top orbit the point they look at (the
 * aircraft), so the aircraft stays in the middle of the frame; Cockpit keeps its eye at the nose and turns
 * the look. The tilt stays between straight down and the En-route limit (EN_ROUTE_MAX_PITCH), past level.
 */
export function peekPlacement(placement: EnRoutePlacement, camera: Exclude<EnRouteCamera, "map">, peek: Peek): EnRoutePlacement {
  if (peek.bearingDeg === 0 && peek.pitchDeg === 0) return placement;
  const bearingDeg = wrap360(placement.bearingDeg + peek.bearingDeg);
  const pitchDeg = clampPitch(placement.pitchDeg + peek.pitchDeg);
  if (camera === "cockpit") return fromEye(eyeOf(placement), placement.distanceM, bearingDeg, pitchDeg);
  return { ...placement, bearingDeg, pitchDeg };
}

/**
 * The camera's placement for `pose`, for an aircraft drawn `lengthM` long, looked round by a drag's
 * `peek`. Cockpit looks along the track pitched with the attitude (`90 + attitude`: level flight at the
 * horizon, a climb above it, a descent below it), and Side stands at wing height looking level: both past the
 * flat map's MAX_PITCH, within EN_ROUTE_MAX_PITCH, which the map takes while a 3D camera is on.
 */
export function enRouteShot(pose: AircraftPose, camera: Exclude<EnRouteCamera, "map">, lengthM: number, peek: Peek = NO_PEEK): EnRouteShot {
  const at = { latitude: pose.latitude, longitude: pose.longitude };
  const track = wrap360(pose.trackDeg);
  let placement: EnRoutePlacement;
  if (camera === "cockpit") {
    const t = track * RAD;
    const ahead = COCKPIT.aheadLengths * lengthM;
    const [latitude, longitude] = toGeo(at, Math.sin(t) * ahead, Math.cos(t) * ahead);
    const eye = { latitude, longitude, altitudeM: pose.altitudeM + COCKPIT.upLengths * lengthM };
    placement = fromEye(eye, COCKPIT.lookM, track, clampPitch(90 + pose.pitchDeg));
  } else if (camera === "side") {
    placement = { center: at, elevationM: pose.altitudeM, distanceM: Math.max(SIDE.minDistanceM, SIDE.lengths * lengthM), bearingDeg: wrap360(track + 90), pitchDeg: 90 };
  } else if (camera === "top") {
    placement = { center: at, elevationM: pose.altitudeM, distanceM: Math.max(TOP.minDistanceM, TOP.lengths * lengthM), bearingDeg: track, pitchDeg: 0 };
  } else {
    placement = { center: at, elevationM: pose.altitudeM, distanceM: Math.max(CHASE.minDistanceM, CHASE.lengths * lengthM), bearingDeg: track, pitchDeg: 90 - CHASE.downDeg };
  }
  const placed = peekPlacement(placement, camera, peek);
  return { ...placed, eye: eyeOf(placed) };
}

/** MapLibre's near clipping plane for a map centre `distanceM` from the eye through a lens `fovDeg` tall: its height / 50 pixels, against the centre's height / 2 / tan(fov / 2). */
export const mapNearPlane = (distanceM: number, fovDeg: number): number => (distanceM * Math.tan((fovDeg * RAD) / 2)) / 25;

/** The least distance sightPlacement takes the map's centre out to, metres, where the look does not meet the ground first: nearer, the terrain's skirts are too short to close the gaps between its tiles. */
export const SIGHT_MIN_M = 2_000;

/**
 * The same camera with the map's centre moved out along its line of sight (the eye and the look kept, so the
 * picture is the same): as far as the eye is over the ground (`groundM`), at least SIGHT_MIN_M, or to the ground
 * if the look meets it first; never so far that MapLibre's near plane (mapNearPlane) passes half the distance to
 * the nearest thing drawn (`nearestM`: the aircraft's model, or the ground under the eye), and never nearer than
 * the camera's own centre.
 *
 * MapLibre sizes its tiles' detail and its terrain's skirts from where the centre is. With the centre at an
 * aircraft kilometres up, Top asked for a field of zoom 18 tiles (20 to 30 frames a second where the other cameras
 * drew 160) and the skirts between terrain tiles were metres long, so gaps opened along far ridges and the page
 * showed through them (from 300 to 600 m out, gaps; from 2 km, none). Taken farther than the eye's height, as to
 * where a slanting look meets the ground (Chase's 13 km at 11,000 ft) or the near plane's farthest (Cockpit's
 * 200 km), the map drew 55 to 85 frames a second; at the eye's height, 110 to 160.
 */
export function sightPlacement(shot: EnRouteShot, { groundM, nearestM, fovDeg }: { groundM: number; nearestM: number; fovDeg: number }): EnRouteShot {
  const above = shot.eye.altitudeM - groundM;
  if (!(above > 0)) return shot;
  const nearPlane = (nearestM / 2) * (25 / Math.tan((fovDeg * RAD) / 2));
  const farthest = Math.max(shot.distanceM, Math.min(Math.max(above, SIGHT_MIN_M), nearPlane));
  const down = Math.cos(shot.pitchDeg * RAD);
  // Below the horizon the look meets the ground this far from the eye; at or above it, never.
  const toGround = down > 1e-9 ? above / down : Infinity;
  const distanceM = Math.max(shot.distanceM, Math.min(toGround, farthest));
  if (distanceM === shot.distanceM) return shot;
  return { ...fromEye(shot.eye, distanceM, shot.bearingDeg, shot.pitchDeg), eye: shot.eye };
}

/**
 * The model's matrix in MapLibre's Mercator world (x east, y south, z up, 0 to 1 across the world),
 * column-major, for an aircraft model built nose toward -z, y up, wheels at 0 (scene/aircraft-model.ts):
 * at `origin` (the aircraft's Mercator coordinate, z its altitude), `metre` Mercator units to the metre,
 * turned to the track, nose raised by the pose's pitch, and scaled by `size` (drawn length over the
 * model's built length). Composed in doubles, so it holds at metre precision anywhere in the world.
 */
export function aircraftMatrix(origin: { x: number; y: number; z: number }, metre: number, pose: Pick<AircraftPose, "trackDeg" | "pitchDeg">, size: number): number[] {
  const h = -pose.trackDeg * RAD;
  const p = pose.pitchDeg * RAD;
  // Model axes after the pitch (about x) then the heading (about y), in the model's own frame (x right, y up, z aft).
  const ch = Math.cos(h);
  const sh = Math.sin(h);
  const cp = Math.cos(p);
  const sp = Math.sin(p);
  // R = Ry(h) * Rx(p), columns are where the model's x, y and z axes go.
  const r = [
    [ch, 0, -sh],
    [sh * sp, cp, ch * sp],
    [sh * cp, -sp, ch * cp],
  ];
  // The model's frame to Mercator's: x east stays, the model's z (aft, south at heading 0) is Mercator's y (south), its y (up) is Mercator's z.
  const toMercator = ([x, y, z]: number[]) => [x, z, y];
  const k = metre * size;
  const cols = r.map((c) => toMercator(c).map((v) => v * k));
  return [...cols[0], 0, ...cols[1], 0, ...cols[2], 0, origin.x, origin.y, origin.z, 1];
}

/** The map's padding, CSS pixels: MapLibre draws the point it looks at in the middle of what is left. */
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * On a phone or tablet the Journey card covers the top of the map: a 3D camera frames the aircraft in the
 * free band between the card's foot and the controls at the map's (journey-frame.ts freeBand), as the flat
 * shot does. Every 3D camera looks at the aircraft (Cockpit at a point ahead of it), and MapLibre draws the
 * point it looks at in the middle of its padded view: this is the padding that puts it in the band's middle.
 */
export function bandPadding(screen: { width: number; height: number }, band: Rect): Insets {
  return { top: Math.max(0, band.top), bottom: Math.max(0, screen.height - band.bottom), left: Math.max(0, band.left), right: Math.max(0, screen.width - band.right) };
}

/** Padding `from` eased toward `to` by `t` (0 to 1): the 3D camera's share, so at none of it the map has its own padding. */
export function blendPadding(from: Insets, to: Insets, t: number): Insets {
  const k = Math.max(0, Math.min(1, t));
  const mix = (a: number, b: number) => a + (b - a) * k;
  return { top: mix(from.top, to.top), bottom: mix(from.bottom, to.bottom), left: mix(from.left, to.left), right: mix(from.right, to.right) };
}

/** How much of the band the aircraft may fill, each way: air round it, so its wingtips and fin stay in the band. */
const BAND_FILL = 0.8;
/** How each camera that draws the model shows it, in its lengths: across the screen and up it (Chase sees the span and the fin over the wing, Side the length and the fin, Top the length up and the span across). */
const MODEL_EXTENT: Record<"chase" | "side" | "top", { across: number; up: number }> = {
  chase: { across: 1.05, up: 0.45 },
  side: { across: 1.05, up: 0.4 },
  top: { across: 1.05, up: 1.05 },
};

/**
 * The camera's distance for an aircraft drawn `lengthM` long, framed in `band` through `lens` (the map's
 * height and vertical field of view): its own shot's distance, or further back when the whole aircraft
 * would not fit the band at that. Cockpit draws no model, so its distance stands.
 */
export function fitDistance(distanceM: number, camera: Exclude<EnRouteCamera, "map">, lengthM: number, lens: Lens, band: Rect): number {
  if (camera === "cockpit") return distanceM;
  const extent = MODEL_EXTENT[camera];
  // Pixels a metre spans at a metre from the eye; at d metres, this over d.
  const focal = lens.height / (2 * Math.tan((lens.fovDeg * RAD) / 2));
  const width = Math.max(1, band.right - band.left);
  const height = Math.max(1, band.bottom - band.top);
  const needed = focal * lengthM * Math.max(extent.across / (BAND_FILL * width), extent.up / (BAND_FILL * height));
  return Math.max(distanceM, needed);
}

/** How quickly the camera settles on its shot, seconds (an exponential ease). */
export const EASE_S = 0.7;
/** The longest step one frame eases, seconds: a hidden tab's long gap is one short step, not a jump to the end. */
const MAX_STEP_S = 0.25;

/**
 * Eases the map's camera between placements: from where the camera was when a 3D camera was picked to
 * its shot, and on as the shot turns with the track. What it eases is the camera's offset from the shot
 * (the point looked at, its height), and the shot's distance, bearing and tilt, so the aircraft, which the
 * shot always looks at, never trails behind it.
 */
export class EnRouteRig {
  private state: { east: number; north: number; up: number; distanceM: number; bearingDeg: number; pitchDeg: number; at: number } | null = null;

  /** Starts easing from the camera `from` toward the shot `to`, at `now` (ms). */
  start(from: EnRoutePlacement, to: EnRoutePlacement, now: number): void {
    const [east, north] = toLocal(to.center, from.center.latitude, from.center.longitude);
    this.state = { east, north, up: from.elevationM - to.elevationM, distanceM: from.distanceM, bearingDeg: from.bearingDeg, pitchDeg: from.pitchDeg, at: now };
  }

  /** Forgets where the camera was: the next step takes its shot as it is. */
  reset(): void {
    this.state = null;
  }

  /** The camera for this frame at `now` (ms), eased toward `target`, never tilted past the En-route limit. */
  step(target: EnRoutePlacement, now: number): EnRoutePlacement {
    const s = this.state;
    if (!s) {
      this.state = { east: 0, north: 0, up: 0, distanceM: target.distanceM, bearingDeg: target.bearingDeg, pitchDeg: target.pitchDeg, at: now };
      const { center, elevationM, distanceM, bearingDeg, pitchDeg } = target;
      return { center, elevationM, distanceM, bearingDeg, pitchDeg: Math.min(EN_ROUTE_MAX_PITCH, pitchDeg) };
    }
    const dt = Math.max(0, Math.min(MAX_STEP_S, (now - s.at) / 1000));
    s.at = now;
    const keep = Math.exp(-dt / EASE_S);
    s.east *= keep;
    s.north *= keep;
    s.up *= keep;
    s.distanceM = target.distanceM * (s.distanceM / target.distanceM) ** keep;
    s.bearingDeg = wrap360(s.bearingDeg + turn(s.bearingDeg, target.bearingDeg) * (1 - keep));
    s.pitchDeg += (target.pitchDeg - s.pitchDeg) * (1 - keep);
    const [latitude, longitude] = toGeo(target.center, s.east, s.north);
    return { center: { latitude, longitude }, elevationM: target.elevationM + s.up, distanceM: s.distanceM, bearingDeg: s.bearingDeg, pitchDeg: Math.min(EN_ROUTE_MAX_PITCH, s.pitchDeg) };
  }
}

/** A drag's turn, degrees per CSS pixel: across the screen turns the bearing, up and down the tilt. */
export const PEEK_DEG_PER_PX = 0.3;
/** Below this a released peek is the framing again, degrees. */
const PEEK_DONE_DEG = 0.05;

/**
 * A drag's look round the en-route camera's framing (peekPlacement): held as dragged, at once, and eased
 * back to nothing once let go, as the rig eases (EASE_S), so the camera returns to its framing.
 */
export class EnRoutePeek {
  private offset: Peek = NO_PEEK;
  private held = false;
  private last: number | null = null;

  /** Whether a drag is on. */
  get dragging(): boolean {
    return this.held;
  }

  /**
   * The pointer moved `dxPx` right and `dyPx` down while dragging: the scene follows it, so a drag to the
   * right turns the camera left round the aircraft, and a drag up tilts it toward the horizon.
   */
  drag(dxPx: number, dyPx: number): void {
    this.held = true;
    this.last = null;
    const bearingDeg = clamp(this.offset.bearingDeg - dxPx * PEEK_DEG_PER_PX, -180, 180);
    const pitchDeg = clamp(this.offset.pitchDeg - dyPx * PEEK_DEG_PER_PX, -90, 90);
    this.offset = { bearingDeg, pitchDeg };
  }

  /** The drag is over, at `now` (ms): from here the peek eases back. */
  release(now: number): void {
    this.held = false;
    this.last = now;
  }

  /** Back to the framing at once (a camera switch). */
  reset(): void {
    this.offset = NO_PEEK;
    this.held = false;
    this.last = null;
  }

  /** The peek at `now` (ms): as dragged while held, else eased toward nothing since the last frame. */
  at(now: number): Peek {
    if (this.held || this.offset === NO_PEEK) return this.offset;
    const dt = this.last === null ? 0 : Math.max(0, Math.min(MAX_STEP_S, (now - this.last) / 1000));
    this.last = now;
    const keep = Math.exp(-dt / EASE_S);
    const bearingDeg = this.offset.bearingDeg * keep;
    const pitchDeg = this.offset.pitchDeg * keep;
    this.offset = Math.abs(bearingDeg) < PEEK_DONE_DEG && Math.abs(pitchDeg) < PEEK_DONE_DEG ? NO_PEEK : { bearingDeg, pitchDeg };
    return this.offset;
  }
}
