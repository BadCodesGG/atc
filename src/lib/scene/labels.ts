import { designator } from "../aircraft-state";
import type { AirportMap } from "../airport-map";

/** A piece of text pinned to the model: map metres east/north and model height. */
export interface SceneLabel {
  kind: "concourse" | "runway";
  text: string;
  x: number;
  y: number;
  h: number;
}

/** How far beyond a concourse's north tip, and a runway's threshold, its label sits. */
const CONCOURSE_GAP = 60;
const RUNWAY_GAP = 150;

/**
 * The concourse letters and runway designators the model is annotated with. A concourse mapped in
 * several pieces is labelled once, at its largest piece.
 */
export function sceneLabels(map: Pick<AirportMap, "runways" | "terminals">, heightScale: number): SceneLabel[] {
  const concourses = new Map<string, { size: number; label: SceneLabel }>();
  for (const t of map.terminals) {
    const letter = t.name?.match(/^Concourse ([A-Z])$/)?.[1];
    const outer = t.rings[0];
    if (!letter || !outer?.length) continue;
    let tip = outer[0];
    let minY = Infinity;
    for (const p of outer) {
      if (p[1] > tip[1]) tip = p;
      minY = Math.min(minY, p[1]);
    }
    const size = tip[1] - minY;
    const seen = concourses.get(letter);
    if (seen && seen.size >= size) continue;
    // Centre the letter over the tip's width: the mean x of the points within 20 m of the top.
    const top = outer.filter((p) => tip[1] - p[1] < 20);
    const x = top.reduce((s, p) => s + p[0], 0) / top.length;
    concourses.set(letter, { size, label: { kind: "concourse", text: letter, x, y: tip[1] + CONCOURSE_GAP, h: t.height * heightScale } });
  }
  const labels: SceneLabel[] = [...concourses.values()].map((c) => c.label).sort((a, b) => a.text.localeCompare(b.text));
  for (const r of map.runways) {
    if (r.ends.length < 2) continue;
    const [a, b] = r.ends;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(len > 0)) continue;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    labels.push({ kind: "runway", text: designator(a.ref), x: a.x - ux * RUNWAY_GAP, y: a.y - uy * RUNWAY_GAP, h: 0 });
    labels.push({ kind: "runway", text: designator(b.ref), x: b.x + ux * RUNWAY_GAP, y: b.y + uy * RUNWAY_GAP, h: 0 });
  }
  return labels;
}

/** A box on screen, CSS pixels. */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** How far the tag sits from its aircraft, and where along its edge the leader line meets it. */
const TAG_DX = 38;
const TAG_DY = 62;
const LEADER_INSET = 6;
/** Clear space kept around a label the tag must not cover. */
const LABEL_PAD = 4;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the selected flight's tag goes: up and right of the aircraft by default, else whichever of the
 * other three diagonals keeps it on screen and off the labels (the concourse letters stay readable).
 * `previous` is the side used last frame; it is kept while it stays clear, so the tag does not flicker
 * between sides as the aircraft moves. Sides: 0 up-right, 1 up-left, 2 down-right, 3 down-left.
 */
export function placeTag(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  obstacles: Rect[],
  bounds: Rect,
  previous = 0,
): { side: number; box: Rect; leader: { x: number; y: number } } {
  const candidate = (side: number) => {
    const right = side % 2 === 0;
    const up = side < 2;
    const left = right ? anchor.x + TAG_DX : anchor.x - TAG_DX - size.width;
    const top = up ? anchor.y - TAG_DY - size.height : anchor.y + TAG_DY;
    const box = { left, top, right: left + size.width, bottom: top + size.height };
    const leader = { x: right ? box.left + LEADER_INSET : box.right - LEADER_INSET, y: up ? box.bottom : box.top };
    const offscreen = box.left < bounds.left || box.right > bounds.right || box.top < bounds.top || box.bottom > bounds.bottom;
    let covered = 0;
    for (const o of obstacles) covered += overlap(box, { left: o.left - LABEL_PAD, top: o.top - LABEL_PAD, right: o.right + LABEL_PAD, bottom: o.bottom + LABEL_PAD });
    return { side, box, leader, cost: (offscreen ? 1e9 : 0) + covered };
  };
  const order = [previous, ...[0, 1, 2, 3].filter((s) => s !== previous)];
  let best = candidate(order[0]);
  for (const side of order.slice(1)) {
    if (best.cost === 0) break;
    const c = candidate(side);
    if (c.cost < best.cost) best = c;
  }
  return { side: best.side, box: best.box, leader: best.leader };
}
