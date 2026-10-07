import type { AirportMap, Point, Ring } from "./airport-map";

/**
 * The paved surface of an airfield, for keeping ground aircraft on it: the aprons as polygons, and
 * the taxiways and runways as strips of their mapped width. Answers one question, where the nearest
 * paved point is, through a grid so it stays cheap for every ground aircraft every frame.
 */

/** Even-odd test: inside the ring. */
function inRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** On a polygon given as its outer ring and holes. */
export function inPolygon(x: number, y: number, rings: Ring[]): boolean {
  return rings.length > 0 && inRing(x, y, rings[0]) && !rings.slice(1).some((hole) => inRing(x, y, hole));
}

/** A strip of pavement: a centreline segment and half its width. */
interface Strip {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  half: number;
}

interface Polygon {
  rings: Point[][];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const CELL = 200;
/** How far, by default, nearest() looks for pavement. */
const SEARCH = 300;
/**
 * A ground aircraft off the mapped pavement is put back on its edge, fully up to PAVEMENT_SNAP metres
 * off and less and less beyond, until at PAVEMENT_REACH it is taken to be on pavement the map does not
 * have (a remote ramp, a hangar) and left where it is.
 */
const PAVEMENT_SNAP = 100;
const PAVEMENT_REACH = 150;

function nearestOnSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const u = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return [ax + u * dx, ay + u * dy];
}

export class Pavement {
  private readonly grid = new Map<string, Strip[]>();
  private readonly polygons: Polygon[];

  constructor(map: Pick<AirportMap, "aprons" | "taxiways" | "runways">) {
    this.polygons = map.aprons
      .filter((a) => a.rings[0]?.length >= 3)
      .map((a) => {
        const xs = a.rings[0].map((p) => p[0]);
        const ys = a.rings[0].map((p) => p[1]);
        return { rings: a.rings, minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      });
    const add = (line: Point[], width: number) => {
      for (let i = 1; i < line.length; i++) {
        const strip = { ax: line[i - 1][0], ay: line[i - 1][1], bx: line[i][0], by: line[i][1], half: width / 2 };
        const pad = strip.half;
        for (let cx = Math.floor((Math.min(strip.ax, strip.bx) - pad) / CELL); cx <= Math.floor((Math.max(strip.ax, strip.bx) + pad) / CELL); cx++) {
          for (let cy = Math.floor((Math.min(strip.ay, strip.by) - pad) / CELL); cy <= Math.floor((Math.max(strip.ay, strip.by) + pad) / CELL); cy++) {
            const key = `${cx},${cy}`;
            const cell = this.grid.get(key);
            if (cell) cell.push(strip);
            else this.grid.set(key, [strip]);
          }
        }
      }
    };
    for (const t of map.taxiways) add(t.line, t.width);
    for (const r of map.runways) if (r.ends.length >= 2) add([[r.ends[0].x, r.ends[0].y], [r.ends[1].x, r.ends[1].y]], r.width);
  }

  /**
   * The nearest paved point to (x, y) and how far it is: the point itself, at distance 0, when it is
   * on pavement already. Null when there is no pavement within `search` metres.
   */
  nearest(x: number, y: number, search = SEARCH): { x: number; y: number; distance: number } | null {
    for (const p of this.polygons) if (x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY && inPolygon(x, y, p.rings)) return { x, y, distance: 0 };

    let best: { x: number; y: number; distance: number } | null = null;
    const offer = (px: number, py: number, distance: number) => {
      if (distance <= search && (!best || distance < best.distance)) best = { x: px, y: py, distance };
    };
    const seen = new Set<Strip>();
    for (let cx = Math.floor((x - search) / CELL); cx <= Math.floor((x + search) / CELL); cx++) {
      for (let cy = Math.floor((y - search) / CELL); cy <= Math.floor((y + search) / CELL); cy++) {
        for (const s of this.grid.get(`${cx},${cy}`) ?? []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const [qx, qy] = nearestOnSegment(x, y, s.ax, s.ay, s.bx, s.by);
          const d = Math.hypot(x - qx, y - qy);
          if (d <= s.half) return { x, y, distance: 0 };
          // On the strip's edge, straight back toward the centreline.
          offer(qx + ((x - qx) * s.half) / d, qy + ((y - qy) * s.half) / d, d - s.half);
        }
      }
    }
    for (const p of this.polygons) {
      if (x < p.minX - search || x > p.maxX + search || y < p.minY - search || y > p.maxY + search) continue;
      for (const ring of p.rings) {
        for (let i = 0; i < ring.length; i++) {
          const [ax, ay] = ring[i];
          const [bx, by] = ring[(i + 1) % ring.length];
          const [qx, qy] = nearestOnSegment(x, y, ax, ay, bx, by);
          offer(qx, qy, Math.hypot(x - qx, y - qy));
        }
      }
    }
    return best;
  }

  /** How far to move a ground point, east and north, to put it on the pavement (see PAVEMENT_SNAP). */
  offset(x: number, y: number): Point {
    const paved = this.nearest(x, y, PAVEMENT_REACH);
    if (!paved || paved.distance <= 0) return [0, 0];
    const k = Math.min(1, (PAVEMENT_REACH - paved.distance) / (PAVEMENT_REACH - PAVEMENT_SNAP));
    return k > 0 ? [(paved.x - x) * k, (paved.y - y) * k] : [0, 0];
  }
}
