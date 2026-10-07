import type { Point } from "../airport-map";

/**
 * Where the reader has moved the camera to: the framed view (home) turned, tilted, zoomed and slid
 * along the ground. Pure arithmetic on a plain value, so the scene, the gestures and a theme switch
 * can hand it around without any of them owning it.
 */
export interface OrbitView {
  /** Compass bearing the camera looks along. */
  azimuthDeg: number;
  /** Angle below the horizon. */
  elevationDeg: number;
  /** The ground point looked at, metres east and north. */
  target: Point;
  /** Height of the point looked at, scene metres: above 0 only while following an aircraft in the air. */
  height: number;
  /** Metres from the camera to the target. */
  distance: number;
  /** Vertical field of view; absent, the framed view's. A camera mode (cameras.ts) sets it. */
  fovDeg?: number;
  /**
   * 0 (absent) for the orbit, 1 for a close camera mode (cameras.ts): how far it has gone over to the
   * close-up look, with the theme's haze in metres, no tilt-shift and buildings at true height.
   */
  eyeLevel?: number;
  /**
   * Where a close camera mode's haze ends, metres, when it needs it nearer than the theme's: low over
   * the field, with the horizon in frame. Absent, the theme's.
   */
  haze?: number;
  /**
   * 0 (absent) to 1: how far every aircraft is drawn at true size, whatever its distance, so a frame
   * reaching from a close aircraft to far ones keeps them in proportion.
   */
  trueSize?: number;
}

/** How far the view may go from home. */
export interface OrbitBounds {
  /** Closest and farthest the camera may be, metres. */
  minDistance: number;
  maxDistance: number;
  /** How far the target may slide from home's, metres. */
  radius: number;
  home: Point;
}

/** The orbit's lens: vertical field of view, degrees. */
export const ORBIT_FOV = 22;
export const MIN_ELEVATION = 12;
export const MAX_ELEVATION = 88;
/** Degrees turned per CSS pixel dragged. */
export const DEG_PER_PX = 0.3;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Turns the view by a drag of dx, dy CSS pixels: across spins it, up and down tilts it. */
export function orbit(view: OrbitView, dxPx: number, dyPx: number): OrbitView {
  return { ...view, azimuthDeg: wrap(view.azimuthDeg - dxPx * DEG_PER_PX), elevationDeg: clamp(view.elevationDeg + dyPx * DEG_PER_PX, MIN_ELEVATION, MAX_ELEVATION) };
}

/** Turns and tilts by whole degrees, for the buttons and the keyboard. */
export function turn(view: OrbitView, dAzimuth: number, dElevation = 0): OrbitView {
  return { ...view, azimuthDeg: wrap(view.azimuthDeg + dAzimuth), elevationDeg: clamp(view.elevationDeg + dElevation, MIN_ELEVATION, MAX_ELEVATION) };
}

/** Moves in (factor below 1) or out, within the bounds. */
export function zoom(view: OrbitView, factor: number, bounds: OrbitBounds): OrbitView {
  return { ...view, distance: clamp(view.distance * factor, bounds.minDistance, bounds.maxDistance) };
}

/**
 * Slides the target by a ground offset, metres, kept within the bounds. A target already beyond them
 * (Follow took it there) may come back in or keep its distance, but never goes farther: it is not
 * pulled back to the edge in one jump.
 */
export function pan(view: OrbitView, dx: number, dy: number, bounds: OrbitBounds): OrbitView {
  const out = Math.hypot(view.target[0] - bounds.home[0], view.target[1] - bounds.home[1]);
  return { ...view, target: confine([view.target[0] + dx, view.target[1] + dy], bounds, Math.max(bounds.radius, out)) };
}

/** Slides the target `forward` metres along the bearing the camera looks and `right` metres across it, for the keyboard. */
export function panAlong(view: OrbitView, forward: number, right: number, bounds: OrbitBounds): OrbitView {
  const az = (view.azimuthDeg * Math.PI) / 180;
  return pan(view, Math.sin(az) * forward + Math.cos(az) * right, Math.cos(az) * forward - Math.sin(az) * right, bounds);
}

export function confine(p: Point, bounds: OrbitBounds, radius = bounds.radius): Point {
  const ox = p[0] - bounds.home[0];
  const oy = p[1] - bounds.home[1];
  const d = Math.hypot(ox, oy);
  if (d <= radius) return p;
  const k = radius / d;
  return [bounds.home[0] + ox * k, bounds.home[1] + oy * k];
}

/**
 * A step of the way from `view` toward `goal`, `k` between 0 (stay) and 1 (arrive). The bearing turns
 * the short way round.
 */
export function ease(view: OrbitView, goal: OrbitView, k: number): OrbitView {
  const lerp = (a: number, b: number) => a + (b - a) * k;
  const turnBy = ((goal.azimuthDeg - view.azimuthDeg + 540) % 360) - 180;
  const eased: OrbitView = {
    azimuthDeg: wrap(view.azimuthDeg + turnBy * k),
    elevationDeg: lerp(view.elevationDeg, goal.elevationDeg),
    target: [lerp(view.target[0], goal.target[0]), lerp(view.target[1], goal.target[1])],
    height: lerp(view.height, goal.height),
    distance: lerp(view.distance, goal.distance),
  };
  // A camera mode's lens and eye level; a plain orbit view has neither, and keeps it that way.
  if (view.fovDeg !== undefined || goal.fovDeg !== undefined) eased.fovDeg = lerp(view.fovDeg ?? ORBIT_FOV, goal.fovDeg ?? ORBIT_FOV);
  if (view.eyeLevel !== undefined || goal.eyeLevel !== undefined) eased.eyeLevel = lerp(view.eyeLevel ?? 0, goal.eyeLevel ?? 0);
  if (view.trueSize !== undefined || goal.trueSize !== undefined) eased.trueSize = lerp(view.trueSize ?? 0, goal.trueSize ?? 0);
  // The haze only shows in proportion to the eye level, so a view without one borrows the other's.
  const haze = view.haze ?? goal.haze;
  if (haze !== undefined) eased.haze = lerp(view.haze ?? haze, goal.haze ?? haze);
  return eased;
}
