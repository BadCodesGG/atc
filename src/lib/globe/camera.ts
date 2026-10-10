import { type Origin, toGeo, toLocal } from "../geo";
import type { OrbitView } from "../scene/orbit";

/**
 * The map's camera and the diorama's are one camera described two ways: MapLibre's centre, zoom,
 * bearing and pitch, and the scene's orbit in an airport's local metres. These convert between them,
 * so either can lead and the other draws the same view.
 */

/** MapLibre's camera, as `map.getCenter()`, `getZoom()`, `getBearing()` and `getPitch()` report it. */
export interface MapCamera {
  lng: number;
  lat: number;
  zoom: number;
  bearing: number;
  pitch: number;
}

/** The frame both cameras draw into: its height in CSS pixels and the vertical field of view. */
export interface Lens {
  height: number;
  fovDeg: number;
}

/** MapLibre's tiles are 512 px, and its world is Web Mercator on the WGS84 equatorial radius. */
const TILE = 512;
const CIRCUMFERENCE = 2 * Math.PI * 6_378_137;
const RAD = Math.PI / 180;

const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;
const wrap180 = (deg: number) => wrap360(deg + 180) - 180;

/** How far the camera stands from the point it looks at, in screen pixels. Both renderers place it here. */
function cameraToCentrePx({ height, fovDeg }: Lens): number {
  return height / 2 / Math.tan((fovDeg * RAD) / 2);
}

/** Ground metres per screen pixel at the map's centre. */
function metresPerPixel(zoom: number, lat: number): number {
  return (CIRCUMFERENCE * Math.cos(lat * RAD)) / (TILE * 2 ** zoom);
}

export function mapToOrbit(cam: MapCamera, origin: Origin, lens: Lens): OrbitView {
  return {
    azimuthDeg: wrap360(cam.bearing),
    elevationDeg: 90 - cam.pitch,
    target: toLocal(origin, cam.lat, cam.lng),
    height: 0,
    distance: cameraToCentrePx(lens) * metresPerPixel(cam.zoom, cam.lat),
  };
}

export function orbitToMap(view: OrbitView, origin: Origin, lens: Lens): MapCamera {
  const [lat, lng] = toGeo(origin, view.target[0], view.target[1]);
  const zoom = Math.log2((cameraToCentrePx(lens) * CIRCUMFERENCE * Math.cos(lat * RAD)) / (TILE * view.distance));
  return { lng, lat, zoom, bearing: wrap180(view.azimuthDeg), pitch: 90 - view.elevationDeg };
}

/**
 * MapLibre's padding that puts the map's centre on `anchor` (CSS pixels): where the diorama's off-axis
 * view draws the point it looks at. Both shift the vanishing point the same way, so they then agree.
 */
export function paddingFor(anchor: { x: number; y: number }, width: number, height: number) {
  return {
    left: Math.max(0, 2 * anchor.x - width),
    right: Math.max(0, width - 2 * anchor.x),
    top: Math.max(0, 2 * anchor.y - height),
    bottom: Math.max(0, height - 2 * anchor.y),
  };
}

/** The map's centre is kept within this many degrees of the equator: past it the world view is all pole. */
const MAX_CENTRE_LAT = 75;

/**
 * The farthest out the world map goes: the globe's outline never shrinks below the frame's short side,
 * the flat map's square world never below its long side (smaller, it repeats across a wide frame, or
 * leaves bands of nothing above and below a tall one), and the centre stays off the poles. MapLibre draws the globe
 * worldSize / 2pi / cos(lat) pixels in radius, seen in perspective from the lens's distance, so the
 * radius whose outline spans the short side comes from the angle that side subtends. A camera already
 * inside comes back unchanged.
 */
export function worldFloor(cam: MapCamera, frame: { width: number; height: number; fovDeg: number }, globe: boolean): MapCamera {
  // A frame with no size (a hidden tab, a collapsed container) has no floor to keep: leave the camera be.
  if (!(frame.width > 0 && frame.height > 0)) return cam;
  const lat = Math.max(-MAX_CENTRE_LAT, Math.min(MAX_CENTRE_LAT, cam.lat));
  const short = Math.min(frame.width, frame.height);
  let across = Math.max(frame.width, frame.height);
  if (globe) {
    const d = cameraToCentrePx(frame);
    const sin = Math.sin(Math.atan(short / 2 / d));
    const radius = (d * sin) / (1 - sin);
    across = 2 * Math.PI * radius * Math.cos(lat * RAD);
  }
  const floor = Math.log2(across / TILE);
  if (lat === cam.lat && cam.zoom >= floor) return cam;
  return { ...cam, lat, zoom: Math.max(cam.zoom, floor) };
}

/**
 * The same camera looking at the ground: the target moved down the line of sight from `height` to the
 * ground, and the distance grown by as much. The map can only look at the ground, so a diorama view of
 * an aircraft in the air goes to the map through this, and both then draw the same picture.
 */
export function groundView(view: OrbitView): OrbitView {
  if (!view.height) return view;
  const el = view.elevationDeg * RAD;
  const az = view.azimuthDeg * RAD;
  const ahead = view.height / Math.tan(el);
  return { ...view, target: [view.target[0] + Math.sin(az) * ahead, view.target[1] + Math.cos(az) * ahead], height: 0, distance: view.distance + view.height / Math.sin(el) };
}

/** The inverse of groundView: the same camera looking at the point `height` up its line of sight. */
export function liftView(view: OrbitView, height: number): OrbitView {
  const g = groundView(view);
  const el = g.elevationDeg * RAD;
  const az = g.azimuthDeg * RAD;
  const back = height / Math.tan(el);
  return { ...g, target: [g.target[0] - Math.sin(az) * back, g.target[1] - Math.cos(az) * back], height, distance: g.distance - height / Math.sin(el) };
}

/** Whether every part of a map camera is a finite number: nothing else is ever handed to the map or the address. */
export function finiteCamera(cam: MapCamera): boolean {
  return [cam.lng, cam.lat, cam.zoom, cam.bearing, cam.pitch].every(Number.isFinite);
}

const MAP_HASH = /(^#|&)map=([^&]*)/;

/** The camera the address's `#map=zoom/lat/lng[/bearing/pitch]` names, or null when it names none or any part is not a finite number. */
export function mapHashCamera(hash: string): MapCamera | null {
  const m = MAP_HASH.exec(hash);
  if (!m) return null;
  const parts = m[2].split("/");
  if (parts.length < 3 || parts.length > 5 || parts.some((p) => !/^-?\d+(\.\d+)?$/.test(p))) return null;
  const [zoom, lat, lng, bearing = 0, pitch = 0] = parts.map(Number);
  const cam = { zoom, lat, lng, bearing, pitch };
  return finiteCamera(cam) ? cam : null;
}

/** The address's hash without a `#map=` that names no finite camera (a hidden tab once wrote NaN there); anything else kept. */
export function withoutBadMapHash(hash: string): string {
  if (!MAP_HASH.test(hash) || mapHashCamera(hash)) return hash;
  const rest = hash.replace(/^#/, "").split("&").filter((p) => !p.startsWith("map="));
  return rest.length ? `#${rest.join("&")}` : "";
}

/**
 * Where a point `heightM` up at `point` appears on the ground from `view`'s camera: where the camera's
 * line of sight through it meets the ground. The map, which draws only on the ground, draws a point in
 * the air there, so it sits where the diorama draws it, wherever it is in the frame.
 */
export function seenOnGround(view: OrbitView, point: readonly [number, number], heightM: number): [number, number] {
  if (heightM <= 0) return [point[0], point[1]];
  const az = view.azimuthDeg * RAD;
  const el = view.elevationDeg * RAD;
  const back = view.distance * Math.cos(el);
  const camera = [view.target[0] - Math.sin(az) * back, view.target[1] - Math.cos(az) * back, view.height + view.distance * Math.sin(el)];
  // Below the camera only; a point level with it or above has no ground under its line of sight.
  const k = camera[2] > heightM ? camera[2] / (camera[2] - heightM) : 1;
  return [camera[0] + (point[0] - camera[0]) * k, camera[1] + (point[1] - camera[1]) * k];
}
