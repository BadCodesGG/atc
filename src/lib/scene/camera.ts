import { type PerspectiveCamera, Vector3 } from "three";
import type { Point, Runway } from "../airport-map";

/** How far a runway may lie from the terminals and still be part of the framed field, metres. */
export const NEAR_RUNWAY_M = 1000;

/**
 * The closest a runway comes to the bounding box of `points` (the terminals), metres: 0 when it
 * crosses the box. Infinity for a runway without two known ends.
 */
export function runwayClearance(runway: Runway, points: readonly Point[]): number {
  if (runway.ends.length < 2 || points.length === 0) return Infinity;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const [a, b] = runway.ends;
  let best = Infinity;
  for (let i = 0; i <= 32; i++) {
    const x = a.x + ((b.x - a.x) * i) / 32;
    const y = a.y + ((b.y - a.y) * i) / 32;
    best = Math.min(best, Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1)));
  }
  return best;
}

/** How the model is looked at: compass bearing of the view, its angle below the horizon, and the lens. */
export interface ViewSpec {
  azimuthDeg: number;
  elevationDeg: number;
  /** Vertical field of view. */
  fovDeg: number;
}

const RAD = Math.PI / 180;

/** Points the camera at a map point, `height` metres up, from `distance` metres away along the view. */
export function placeCamera(camera: PerspectiveCamera, spec: ViewSpec, target: Point, distance: number, height = 0): void {
  const az = spec.azimuthDeg * RAD;
  const el = spec.elevationDeg * RAD;
  const back = distance * Math.cos(el);
  const px = target[0] - Math.sin(az) * back;
  const py = target[1] - Math.cos(az) * back;
  camera.fov = spec.fovDeg;
  camera.position.set(px, height + distance * Math.sin(el), -py);
  camera.up.set(0, 1, 0);
  camera.lookAt(target[0], height, -target[1]);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}

/** The centre of the points' bounding box: the point both fits look at. */
export function centreOf(points: readonly Point[]): Point {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/**
 * Places the camera so the ground points fill the frame (centred on their bounding box), then moves
 * in by `zoom`. Returns the distance used. The camera's aspect must already be set.
 */
export function fitView(camera: PerspectiveCamera, spec: ViewSpec, points: Point[], { zoom = 1 }: { zoom?: number } = {}): number {
  const target = centreOf(points);
  const v = new Vector3();
  const extent = (distance: number) => {
    placeCamera(camera, spec, target, distance);
    let e = 0;
    for (const [x, y] of points) {
      v.set(x, 0, -y).project(camera);
      // Behind the camera counts as out of frame.
      e = Math.max(e, v.z > 1 ? Infinity : Math.abs(v.x), Math.abs(v.y));
    }
    return e;
  };
  // The extent falls as the camera backs off; bisect for the distance where it reaches the frame edge.
  let lo = 1;
  let hi = 1;
  while (extent(hi) > 1) hi *= 2;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (extent(mid) > 1) lo = mid;
    else hi = mid;
  }
  const distance = hi / zoom;
  placeCamera(camera, spec, target, distance);
  return distance;
}

/** CSS pixels per metre on the ground at the point the camera looks at, for a frame `height` pixels tall. */
export function pixelsPerMetre(spec: ViewSpec, distance: number, height: number): number {
  return height / (2 * distance * Math.tan((spec.fovDeg * RAD) / 2));
}

/** A box on screen, CSS pixels from the frame's top left. */
export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The vertical view offset that draws a frame's centre in the middle of `band` instead: what a portrait
 * frame looks at then sits between its control rows and the flight card. However short the band (a phone
 * with the card open leaves 48 px), its middle is the one place not covered; a band with no height (the
 * chrome not laid out yet) centres in the frame.
 */
export function bandOffsetY(height: number, band: Area): number {
  return band.bottom > band.top ? height / 2 - (band.top + band.bottom) / 2 : 0;
}

/**
 * Places the camera so the ground points fill `area` of a `width` x `height` frame, and no more:
 * the nearest fit, then a view offset that centres the points' bounds in the area. The rest of the
 * frame (a side panel, the header) is left clear of them. Needs the camera's aspect set and no view
 * offset; returns the distance used.
 */
export function fitViewToArea(camera: PerspectiveCamera, spec: ViewSpec, points: Point[], area: Area, size: { width: number; height: number }): number {
  const target = centreOf(points);
  // The area in normalised device coordinates (x right, y up, both -1 to 1).
  const box = {
    x0: (area.left / size.width) * 2 - 1,
    x1: (area.right / size.width) * 2 - 1,
    y0: 1 - (area.bottom / size.height) * 2,
    y1: 1 - (area.top / size.height) * 2,
  };
  const v = new Vector3();
  const bounds = (distance: number) => {
    placeCamera(camera, spec, target, distance);
    const b = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, behind: false };
    for (const [x, y] of points) {
      v.set(x, 0, -y).project(camera);
      if (v.z > 1) b.behind = true;
      b.x0 = Math.min(b.x0, v.x);
      b.x1 = Math.max(b.x1, v.x);
      b.y0 = Math.min(b.y0, v.y);
      b.y1 = Math.max(b.y1, v.y);
    }
    return b;
  };
  // How much of the area the points need: above 1, they overflow it. It falls as the camera backs off.
  const need = (distance: number) => {
    const b = bounds(distance);
    return b.behind ? Infinity : Math.max((b.x1 - b.x0) / (box.x1 - box.x0), (b.y1 - b.y0) / (box.y1 - box.y0));
  };
  let lo = 1;
  let hi = 1;
  while (need(hi) > 1) hi *= 2;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (need(mid) > 1) lo = mid;
    else hi = mid;
  }
  const b = bounds(hi);
  // Sliding the frame's window by a pixel slides the picture the other way; a view offset is a constant
  // shift in device coordinates at every depth, so this centres the bounds exactly.
  const dx = (box.x0 + box.x1) / 2 - (b.x0 + b.x1) / 2;
  const dy = (box.y0 + box.y1) / 2 - (b.y0 + b.y1) / 2;
  camera.setViewOffset(size.width, size.height, (-dx * size.width) / 2, (dy * size.height) / 2, size.width, size.height);
  camera.updateMatrixWorld(true);
  return hi;
}
