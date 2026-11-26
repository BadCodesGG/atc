import { toGeo, toLocal } from "../geo";

/**
 * The En-route view's cameras (CONTEXT.md): how the World map frames a followed flight in 3D. Pure: a pose
 * and a camera in, a placement of the map's camera out, so each camera is tested on its own and a later
 * camera is one more case here. The layer that draws the aircraft (en-route-layer.ts) and the map that
 * places its camera (globe-map.ts) only carry these out.
 */

/** Every camera the en-route view will have. Map is the flat World map; the rest are 3D. */
export type EnRouteCamera = "map" | "chase" | "cockpit" | "side" | "top";

/** The cameras the Journey card offers now, in its order: Map first, as Following starts there. */
export const EN_ROUTE_OFFERED: readonly EnRouteCamera[] = ["map", "chase"];

/** Whether a camera tilts the map into 3D, with terrain and the aircraft's model. */
export const is3D = (camera: EnRouteCamera): camera is Exclude<EnRouteCamera, "map"> => camera !== "map";

/** The map's tilt limit (globe-map.ts, `maxPitch`): no shot asks for more. */
export const MAX_PITCH = 78;

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
const FEET = 0.3048;
const FPM = 0.00508;
const KT = 0.514444;
/** The steepest climb or descent attitude drawn: past it the read is wrong, not the aircraft. */
const MAX_ATTITUDE_DEG = 20;

const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;
/** The signed turn from `from` to `to`, the short way round, -180 to 180. */
const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

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
    pitchDeg = Math.atan2(fix.verticalRateFpm * FPM, Math.max(0, fix.groundSpeedKt ?? 0) * KT) / RAD;
    pitchDeg = Math.max(-MAX_ATTITUDE_DEG, Math.min(MAX_ATTITUDE_DEG, pitchDeg));
  }
  return { latitude: fix.latitude, longitude: fix.longitude, altitudeM, trackDeg: wrap360(fix.headingDeg), pitchDeg };
}

/** The camera's placement for `pose`, for an aircraft drawn `lengthM` long. */
export function enRouteShot(pose: AircraftPose, camera: Exclude<EnRouteCamera, "map">, lengthM: number): EnRouteShot {
  // Only Chase is built; the others are later tickets and frame as Chase until then.
  void camera;
  const distanceM = Math.max(CHASE.minDistanceM, CHASE.lengths * lengthM);
  const pitchDeg = Math.min(MAX_PITCH, 90 - CHASE.downDeg);
  const back = distanceM * Math.sin(pitchDeg * RAD);
  const up = distanceM * Math.cos(pitchDeg * RAD);
  const t = pose.trackDeg * RAD;
  const [latitude, longitude] = toGeo(pose, -Math.sin(t) * back, -Math.cos(t) * back);
  return {
    center: { latitude: pose.latitude, longitude: pose.longitude },
    elevationM: pose.altitudeM,
    distanceM,
    bearingDeg: wrap360(pose.trackDeg),
    pitchDeg,
    eye: { latitude, longitude, altitudeM: pose.altitudeM + up },
  };
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

  /** The camera for this frame at `now` (ms), eased toward `target`, never tilted past the map's limit. */
  step(target: EnRoutePlacement, now: number): EnRoutePlacement {
    const s = this.state;
    if (!s) {
      this.state = { east: 0, north: 0, up: 0, distanceM: target.distanceM, bearingDeg: target.bearingDeg, pitchDeg: target.pitchDeg, at: now };
      const { center, elevationM, distanceM, bearingDeg, pitchDeg } = target;
      return { center, elevationM, distanceM, bearingDeg, pitchDeg: Math.min(MAX_PITCH, pitchDeg) };
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
    return { center: { latitude, longitude }, elevationM: target.elevationM + s.up, distanceM: s.distanceM, bearingDeg: s.bearingDeg, pitchDeg: Math.min(MAX_PITCH, s.pitchDeg) };
  }
}
