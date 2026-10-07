import type { Rect } from "./clear-of-card";

/**
 * Where a followed flight and the end of its approach stand on a phone. The journey's card sits across the
 * top of the map and its controls across the foot, which leaves a band between them; the camera keeps the
 * aircraft and the approach's threshold inside it, wherever the journey's own shot would put them. The
 * arithmetic only: the map projects the points and applies what this asks for.
 */

export type { Rect };

/** Air between the band and the card above it or the controls below it. */
const GAP_PX = 12;
/** And between it and the edges of the screen. */
const EDGE_PX = 16;
/** Half a mark (the aircraft's ring): the whole ring stays in the band, not just its centre. */
const MARK_PX = 22;
/** The band is never shallower than this, whatever the controls do. */
const MIN_DEPTH_PX = 120;

/** The strip between the card's foot (or the screen's top with no card) and the highest control below it. */
export function freeBand(screen: { width: number; height: number }, card: Rect | null, controls: readonly Rect[]): Rect {
  const top = card ? card.bottom + GAP_PX : EDGE_PX;
  const below = controls.filter((c) => c.top > top).map((c) => c.top - GAP_PX);
  const bottom = Math.max(top + MIN_DEPTH_PX, below.length ? Math.min(...below) : screen.height - EDGE_PX);
  return { left: EDGE_PX, right: screen.width - EDGE_PX, top, bottom };
}

/**
 * What brings `points` (screen pixels) into `band`: the scale to shrink them by about their middle, never
 * above 1, when they are farther apart than the band holds, and then how far to move them (right and down)
 * the shortest way in. Each point keeps room for its mark.
 */
export function frameShift(points: readonly { x: number; y: number }[], band: Rect): { scale: number; dx: number; dy: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const inner = { left: band.left + MARK_PX, right: band.right - MARK_PX, top: band.top + MARK_PX, bottom: band.bottom - MARK_PX };
  const [w, h] = [x1 - x0, y1 - y0];
  const scale = Math.min(1, w > 0 ? (inner.right - inner.left) / w : 1, h > 0 ? (inner.bottom - inner.top) / h : 1);
  // Scaled about their middle, they span this much; the middle then goes to the nearest place that holds all of that.
  const [cx, cy] = [(x0 + x1) / 2, (y0 + y1) / 2];
  const [hw, hh] = [(w * scale) / 2, (h * scale) / 2];
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return { scale, dx: clamp(cx, inner.left + hw, inner.right - hw) - cx, dy: clamp(cy, inner.top + hh, inner.bottom - hh) - cy };
}
