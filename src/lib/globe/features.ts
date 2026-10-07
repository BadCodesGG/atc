import type { FlightState } from "../aircraft-state";
import type { Airport } from "../airports";
import { type Origin, toGeo } from "../geo";
import type { AirportCount } from "../region";

/** What the map's airport and aircraft layers draw, as GeoJSON. Only the properties the style reads. */

interface PointFeature<P> {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: P;
}

interface Collection<P> {
  type: "FeatureCollection";
  features: PointFeature<P>[];
}

export function airportFeatures(airports: readonly Airport[], counts: Partial<Record<Airport["code"], AirportCount>>): Collection<{ code: string; name: string; count?: number }> {
  return {
    type: "FeatureCollection",
    features: airports.map((a) => {
      const count = counts[a.code]?.total;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [a.longitude, a.latitude] },
        properties: count === undefined ? { code: a.code, name: a.name } : { code: a.code, name: a.name, count },
      };
    }),
  };
}

/** One piece of a predicted path's air legs on the map: its state's colour, and its opacity by distance from the field. */
export interface ProcedurePiece {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { state: FlightState; fade: number; own: boolean };
}

/** The air legs are cut into pieces this long, metres, each faded by its own distance from the field. */
const PIECE = 1000;

/**
 * The selected flight's approach or climb-out (its predicted path's air legs, in the scene's frame
 * round `origin`) as map lines: pieces about a kilometre long, each as strong as its middle is near the
 * field, whole within `near` metres and gone by `far`, so the line fades out as the diorama's does.
 * `own` marks it as the flight selected on the map's, which the map draws as it draws that flight's path.
 */
export function procedureFeatures(
  path: { state: FlightState; legs: { kind: string; points: [number, number, number][] }[] } | null,
  origin: Origin,
  { near, far }: { near: number; far: number },
  own = false,
): { type: "FeatureCollection"; features: ProcedurePiece[] } {
  const features: ProcedurePiece[] = [];
  for (const leg of path?.legs ?? []) {
    if (leg.kind !== "air") continue;
    for (let i = 1; i < leg.points.length; i++) {
      const [ax, ay] = leg.points[i - 1];
      const [bx, by] = leg.points[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / PIECE));
      for (let k = 0; k < n; k++) {
        const at = (u: number): [number, number] => [ax + (bx - ax) * u, ay + (by - ay) * u];
        const [mx, my] = at((k + 0.5) / n);
        const fade = Math.round(Math.min(1, Math.max(0, (far - Math.hypot(mx, my)) / (far - near))) * 100) / 100;
        if (fade <= 0) continue;
        const coordinates = [at(k / n), at((k + 1) / n)].map(([x, y]): [number, number] => {
          const [lat, lon] = toGeo(origin, x, y);
          return [lon, lat];
        });
        features.push({ type: "Feature", geometry: { type: "LineString", coordinates }, properties: { state: path!.state, fade, own } });
      }
    }
  }
  return { type: "FeatureCollection", features };
}
