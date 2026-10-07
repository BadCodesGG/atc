/**
 * Where a selected aircraft should stand on screen so the flight card does not cover it. The card is the
 * diorama's: a column at the right on wide screens, a sheet across the foot on phones and short windows.
 * The aircraft is moved the shortest way into the free area (the map less the card and the chrome round
 * its edges), or not at all if it is there already.
 */

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Half the selection ring, plus a little: the whole ring stays in the free area, not just its centre. */
const RING_PX = 22;
/** Air left between the ring and the card. */
const GAP_PX = 12;
/** The card is across the foot when it spans more than this share of the width. */
const STACKED_SHARE = 0.6;

/** The edges of the screen that the page's own controls hold (search and header above, the view buttons and time bar below, on the map). */
function insets(width: number, height: number, stacked: boolean): { top: number; bottom: number; left: number; right: number } {
  if (!stacked) return { top: 96, bottom: 100, left: 24, right: 0 };
  // A phone stacks the header, the search and the radar button; a tablet or a short window puts the radar button in the header's row.
  return { top: width < 640 ? 190 : height < 640 ? 128 : 190, bottom: 0, left: 16, right: 16 };
}

/** How far to move the point (screen pixels, x right and y down) to bring it into the free area; [0, 0] with no card, or when it is clear. */
export function shiftClearOfCard(point: { x: number; y: number }, screen: { width: number; height: number }, card: Rect | null): [number, number] {
  if (!card) return [0, 0];
  const stacked = card.right - card.left > screen.width * STACKED_SHARE;
  const edge = insets(screen.width, screen.height, stacked);
  const minX = edge.left + RING_PX;
  const minY = edge.top + RING_PX;
  const maxX = Math.max(minX, stacked ? screen.width - edge.right - RING_PX : card.left - GAP_PX - RING_PX);
  const maxY = Math.max(minY, stacked ? card.top - GAP_PX - RING_PX : screen.height - edge.bottom - RING_PX);
  const x = Math.min(maxX, Math.max(minX, point.x));
  const y = Math.min(maxY, Math.max(minY, point.y));
  return [x - point.x, y - point.y];
}
