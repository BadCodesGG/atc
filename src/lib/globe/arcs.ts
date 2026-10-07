import type { FlightRoute } from "../routes";

/**
 * The network at country scale: each route flown from a built airport as a great-circle arc between
 * its two ends. A pair of airports is one arc however many flights fly it, either way, weighted by
 * how many do.
 */

const RAD = Math.PI / 180;

interface Arc {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { pair: string; flights: number };
}

/** Points along the great circle from a to b ([lon, lat] degrees), longitudes unwrapped so the line never jumps across the map. */
export function greatCircle(a: [number, number], b: [number, number], segments: number): [number, number][] {
  const toVec = ([lon, lat]: [number, number]) => [Math.cos(lat * RAD) * Math.cos(lon * RAD), Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD)];
  const p = toVec(a);
  const q = toVec(b);
  const omega = Math.acos(Math.min(1, Math.max(-1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  const out: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    if (omega < 1e-9) {
      out.push(a);
      continue;
    }
    const k0 = Math.sin((1 - t) * omega) / Math.sin(omega);
    const k1 = Math.sin(t * omega) / Math.sin(omega);
    const v = [k0 * p[0] + k1 * q[0], k0 * p[1] + k1 * q[1], k0 * p[2] + k1 * q[2]];
    let lon = Math.atan2(v[1], v[0]) / RAD;
    const lat = Math.atan2(v[2], Math.hypot(v[0], v[1])) / RAD;
    const prev = out.at(-1);
    if (prev) lon += 360 * Math.round((prev[0] - lon) / 360);
    out.push([lon, lat]);
  }
  // The ends exactly as given (the unwrapped far end may sit a turn of the world away, which MapLibre draws the same).
  out[0] = a;
  out[segments] = [b[0] + 360 * Math.round((out[segments][0] - b[0]) / 360), b[1]];
  return out;
}

export function routeArcs(routes: Iterable<FlightRoute>, segments = 48): { type: "FeatureCollection"; features: Arc[] } {
  const arcs = new Map<string, Arc>();
  for (const { origin, destination } of routes) {
    if (origin.latitude === undefined || origin.longitude === undefined || destination.latitude === undefined || destination.longitude === undefined) continue;
    if (origin.code === destination.code) continue;
    const pair = [origin.code, destination.code].sort().join("-");
    const arc = arcs.get(pair);
    if (arc) {
      arc.properties.flights++;
      continue;
    }
    arcs.set(pair, {
      type: "Feature",
      geometry: { type: "LineString", coordinates: greatCircle([origin.longitude, origin.latitude], [destination.longitude, destination.latitude], segments) },
      properties: { pair, flights: 1 },
    });
  }
  return { type: "FeatureCollection", features: [...arcs.values()] };
}
