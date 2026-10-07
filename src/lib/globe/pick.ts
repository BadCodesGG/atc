/**
 * Which aircraft a click or tap on the map means: the nearest within reach of the point. A finger is far
 * less exact than a pointer, and the glyphs are small at region zoom, so a touch reaches a 44 px circle
 * round the aircraft (the least a target should be) and a pointer a smaller one.
 */

export const REACH_PX = { pointer: 12, touch: 22 } as const;

export interface ScreenPoint {
  id: string;
  x: number;
  y: number;
}

export function pickAircraft(points: readonly ScreenPoint[], at: { x: number; y: number }, reach: number): string | null {
  let best: string | null = null;
  let nearest = reach;
  for (const p of points) {
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (d <= nearest) {
      nearest = d;
      best = p.id;
    }
  }
  return best;
}
