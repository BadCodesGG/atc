/**
 * Local flat-earth frame around an airport: x metres east, y metres north of the reference point.
 * An azimuthal equidistant projection on the WGS84 mean radius: under a millimetre of error per
 * kilometre out to the 30 km the scene uses, and exactly invertible.
 */

const R = 6_371_008.8;
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

export const FEET = 0.3048;
export const KNOTS = 1852 / 3600;
