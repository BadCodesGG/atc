import type { FlightState } from "../aircraft-state";

/**
 * The geometry of predicted paths: each path one continuous strip along its route (mitred at the
 * corners, so a see-through strip never doubles up on itself), with chevrons along it pointing the
 * way the aircraft will go. In the air the strip rises and falls with the flight: full strength over
 * the field, fading out with distance from it (an approach can start 20 km out, past the edge of the
 * model), and a climb-out also fades to nothing at its far end rather than stopping in mid-air.
 * Pure: positions in three's axes (x east, y up, z south), colours as RGBA per vertex.
 */

export interface RibbonPath {
  state: FlightState;
  /** The selected flight's path, drawn stronger than the rest. */
  emphasis: boolean;
  legs: { kind: "taxi" | "runway" | "air"; points: [number, number, number][] }[];
}

export interface PathRibbonOptions {
  /** Strip width, metres. */
  width: number;
  /** Height above the route the strip is drawn at, metres: above the ground's paint. */
  lift: number;
  /** Metres between chevrons. */
  markSpacing: number;
  /** Linear RGB of a state's colour. */
  colorOf: (state: FlightState) => [number, number, number];
  /** Air legs are at full strength within `near` metres of the field (the origin) and gone by `far`. */
  fade?: { near: number; far: number };
}

export interface RibbonMesh {
  positions: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

/** Opacity of the strip and of its chevrons: the selected path, and every other. */
const STRIP_ALPHA = { strong: 0.6, plain: 0.32 } as const;
const MARK_ALPHA = { strong: 0.95, plain: 0.6 } as const;
/** Opacity at the top of the curtain under a stretch in the air, and the height (metres) a stretch needs to have one. */
const CURTAIN_ALPHA = 0.22;
const CURTAIN_MIN = 1;
/** A chevron's length and span against the strip's width, and its arms' thickness. */
const MARK_LENGTH = 0.9;
const MARK_SPAN = 1.5;
const MARK_THICKNESS = 0.35;
/** Chevrons sit this far above the strip, metres. */
const MARK_LIFT = 0.3;
/** A mitre is never stretched past this many half-widths, so a hairpin cannot throw a spike. */
const MITRE_LIMIT = 2.5;

interface Vertex {
  x: number;
  y: number;
  h: number;
  /** 1 on the ground; in the air, less with distance from the field, and 0 at a climb-out's end. */
  fade: number;
}

/** One path's points in order, the shared point between two legs once, with each point's fade. */
function chain(path: RibbonPath, range?: PathRibbonOptions["fade"]): Vertex[] {
  const out: Vertex[] = [];
  for (const leg of path.legs) {
    // Only the selected flight's roll, rollout, climb-out or approach: every departure's at once is a
    // fan of long lines down the runways and across the field, which reads as taxiing along them and
    // buries the taxi routes the paths are there to show.
    if (leg.kind !== "taxi" && !path.emphasis) continue;
    let total = 0;
    for (let i = 1; i < leg.points.length; i++) total += Math.hypot(leg.points[i][0] - leg.points[i - 1][0], leg.points[i][1] - leg.points[i - 1][1]);
    // A leg that ends in the air (a climb-out) fades toward its end; one that comes down to the runway does not.
    const toEnd = leg.kind === "air" && total > 0 && (leg.points.at(-1)?.[2] ?? 0) > 0;
    let d = 0;
    leg.points.forEach(([x, y, h], i) => {
      if (i > 0) d += Math.hypot(x - leg.points[i - 1][0], y - leg.points[i - 1][1]);
      let fade = toEnd ? 1 - d / total : 1;
      if (leg.kind === "air" && range) fade = Math.min(fade, Math.min(1, Math.max(0, (range.far - Math.hypot(x, y)) / (range.far - range.near))));
      const last = out[out.length - 1];
      if (last && Math.hypot(last.x - x, last.y - y) < 0.5 && Math.abs(last.h - h) < 0.5) {
        last.fade = Math.min(last.fade, fade);
        return;
      }
      out.push({ x, y, h, fade });
    });
  }
  return out;
}

export function pathRibbons(paths: RibbonPath[], { width, lift, markSpacing, colorOf, fade }: PathRibbonOptions): RibbonMesh {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const vertex = (x: number, y: number, h: number, rgb: [number, number, number], a: number) => {
    positions.push(x, h, -y);
    colors.push(rgb[0], rgb[1], rgb[2], a);
    return positions.length / 3 - 1;
  };
  const half = width / 2;

  for (const path of paths) {
    const pts = chain(path, fade);
    if (pts.length < 2) continue;
    const rgb = colorOf(path.state);
    const strip = path.emphasis ? STRIP_ALPHA.strong : STRIP_ALPHA.plain;
    const mark = path.emphasis ? MARK_ALPHA.strong : MARK_ALPHA.plain;
    // Unit direction of each segment.
    const dirs = pts.slice(1).map((p, i) => {
      const len = Math.hypot(p.x - pts[i].x, p.y - pts[i].y) || 1;
      return [(p.x - pts[i].x) / len, (p.y - pts[i].y) / len];
    });

    // The strip: two vertices a point, offset along the mitre (the bisector of the two segments' normals).
    const first = positions.length / 3;
    pts.forEach((p, i) => {
      const a = dirs[Math.max(0, i - 1)];
      const b = dirs[Math.min(dirs.length - 1, i)];
      let nx = -(a[1] + b[1]);
      let ny = a[0] + b[0];
      const nlen = Math.hypot(nx, ny);
      if (nlen < 1e-6) {
        nx = -a[1];
        ny = a[0];
      } else {
        nx /= nlen;
        ny /= nlen;
      }
      // Stretch so the strip keeps its width along both segments: 1 / cos(half the turn).
      const cos = Math.max(1 / MITRE_LIMIT, nx * -b[1] + ny * b[0]);
      const k = half / cos;
      const h = p.h + lift;
      vertex(p.x + nx * k, p.y + ny * k, h, rgb, strip * p.fade);
      vertex(p.x - nx * k, p.y - ny * k, h, rgb, strip * p.fade);
    });
    for (let i = 1; i < pts.length; i++) {
      const l0 = first + 2 * (i - 1);
      indices.push(l0, l0 + 1, l0 + 3, l0, l0 + 3, l0 + 2);
    }

    // Under a stretch in the air, a curtain down to the ground, clearing toward its foot: seen from
    // above, a strip 150 m up reads as one on the ground without it.
    for (let i = 1; i < pts.length; i++) {
      const [a, b] = [pts[i - 1], pts[i]];
      if (a.h < CURTAIN_MIN && b.h < CURTAIN_MIN) continue;
      const topA = vertex(a.x, a.y, a.h + lift, rgb, CURTAIN_ALPHA * a.fade);
      const topB = vertex(b.x, b.y, b.h + lift, rgb, CURTAIN_ALPHA * b.fade);
      const footA = vertex(a.x, a.y, lift, rgb, 0);
      const footB = vertex(b.x, b.y, lift, rgb, 0);
      indices.push(topA, footA, footB, topA, footB, topB);
    }

    // Chevrons along it, pointing the way of travel.
    const total = dirs.reduce((s, _, i) => s + Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y), 0);
    const length = width * MARK_LENGTH;
    const span = (width * MARK_SPAN) / 2;
    const thick = width * MARK_THICKNESS;
    let seg = 0;
    let segStart = 0;
    for (let d = markSpacing / 2; d <= total - markSpacing / 3; d += markSpacing) {
      while (seg < dirs.length - 1 && segStart + Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].y - pts[seg].y) < d) {
        segStart += Math.hypot(pts[seg + 1].x - pts[seg].x, pts[seg + 1].y - pts[seg].y);
        seg++;
      }
      const a = pts[seg];
      const b = pts[seg + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const u = Math.min(1, (d - segStart) / segLen);
      const [tx, ty] = dirs[seg];
      const nx = -ty;
      const ny = tx;
      const cx = a.x + (b.x - a.x) * u;
      const cy = a.y + (b.y - a.y) * u;
      const h = a.h + (b.h - a.h) * u + lift + MARK_LIFT;
      const alpha = mark * (a.fade + (b.fade - a.fade) * u);
      const tipX = cx + (tx * length) / 2;
      const tipY = cy + (ty * length) / 2;
      const backX = cx - (tx * length) / 2;
      const backY = cy - (ty * length) / 2;
      const tipO = vertex(tipX, tipY, h, rgb, alpha);
      const tipI = vertex(tipX - tx * thick, tipY - ty * thick, h, rgb, alpha);
      const leftO = vertex(backX + nx * span, backY + ny * span, h, rgb, alpha);
      const leftI = vertex(backX + nx * span - tx * thick, backY + ny * span - ty * thick, h, rgb, alpha);
      const rightO = vertex(backX - nx * span, backY - ny * span, h, rgb, alpha);
      const rightI = vertex(backX - nx * span - tx * thick, backY - ny * span - ty * thick, h, rgb, alpha);
      indices.push(tipO, leftO, leftI, tipO, leftI, tipI, tipO, tipI, rightI, tipO, rightI, rightO);
    }
  }
  return { positions: new Float32Array(positions), colors: new Float32Array(colors), indices: new Uint32Array(indices) };
}
