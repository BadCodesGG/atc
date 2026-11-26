/**
 * Local flat-earth frame around an airport: x metres east, y metres north of the reference point.
 * An azimuthal equidistant projection on the WGS84 mean radius: under a millimetre of error per
 * kilometre out to the 30 km the scene uses, and exactly invertible.
 */

/** The Earth's mean radius, metres: the sphere these conversions run on, and MapLibre's own `earthRadius`. */
export const EARTH_RADIUS_M = 6_371_008.8;
const R = EARTH_RADIUS_M;
const RAD = Math.PI / 180;

export interface Origin {
  latitude: number;
  longitude: number;
}

export function toLocal(origin: Origin, latitude: number, longitude: number): [number, number] {
  const p0 = origin.latitude * RAD;
  const p = latitude * RAD;
  const dl = (longitude - origin.longitude) * RAD;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  const c = Math.acos(Math.min(1, Math.max(-1, cosc)));
  const k = c < 1e-12 ? 1 : c / Math.sin(c);
  return [R * k * Math.cos(p) * Math.sin(dl), R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl))];
}

export function toGeo(origin: Origin, x: number, y: number): [number, number] {
  const rho = Math.hypot(x, y);
  if (rho < 1e-9) return [origin.latitude, origin.longitude];
  const c = rho / R;
  const p0 = origin.latitude * RAD;
  const lat = Math.asin(Math.cos(c) * Math.sin(p0) + (y * Math.sin(c) * Math.cos(p0)) / rho);
  const lon = origin.longitude * RAD + Math.atan2(x * Math.sin(c), rho * Math.cos(p0) * Math.cos(c) - y * Math.sin(p0) * Math.sin(c));
  return [lat / RAD, lon / RAD];
}

/** Metres in a foot, and metres a second in a knot. */
export const FEET = 0.3048;
export const KNOTS = 1852 / 3600;

/** A heading or bearing, degrees, brought into [0, 360). */
export const wrap360 = (degrees: number) => ((degrees % 360) + 360) % 360;
/** The signed turn from one heading to another, the short way round, degrees in [-180, 180). */
export const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;
