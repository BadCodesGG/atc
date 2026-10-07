import { describe, expect, it } from "vitest";
import type { Runway, Terminal } from "../airport-map";
import { placeTag, type Rect, sceneLabels } from "./labels";

const runway: Runway = {
  ref: "09R/27L",
  width: 45,
  surface: null,
  centerline: [[-1000, 0], [1000, 0]],
  ends: [
    { ref: "09R", x: -1000, y: 0 },
    { ref: "27L", x: 1000, y: 0 },
  ],
};

const concourse = (name: string, x: number, north: number): Terminal => ({
  name,
  height: 18,
  rings: [[[x, 100], [x + 40, 100], [x + 40, north], [x, north]]],
});

describe("sceneLabels", () => {
  it("names each concourse by its letter once, just north of its northern tip, at roof height", () => {
    const labels = sceneLabels({ runways: [], terminals: [concourse("Concourse B", 0, 700), concourse("Concourse B", 0, 300), concourse("South Terminal", 500, 400)] }, 2);
    expect(labels).toEqual([{ kind: "concourse", text: "B", x: 20, y: 760, h: 36 }]);
  });

  it("puts each runway designator, as spoken, beyond its own threshold", () => {
    const labels = sceneLabels({ runways: [runway], terminals: [] }, 1);
    expect(labels).toEqual([
      { kind: "runway", text: "9R", x: -1150, y: 0, h: 0 },
      { kind: "runway", text: "27L", x: 1150, y: 0, h: 0 },
    ]);
  });
});

describe("placeTag", () => {
  const size = { width: 100, height: 30 };
  const bounds: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };
  const anchor = { x: 500, y: 400 };
  const overlaps = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  it("puts the tag up and to the right of the aircraft when nothing is in the way", () => {
    const p = placeTag(anchor, size, [], bounds);
    expect(p.box).toEqual({ left: 538, top: 308, right: 638, bottom: 338 });
    // The leader meets the tag's corner nearest the aircraft.
    expect(p.leader).toEqual({ x: 544, y: 338 });
  });

  it("moves the tag to another side rather than cover a concourse letter", () => {
    const letter: Rect = { left: 560, top: 300, right: 575, bottom: 318 };
    const p = placeTag(anchor, size, [letter], bounds);
    expect(overlaps(p.box, letter)).toBe(false);
    expect(p.box.right).toBeLessThanOrEqual(anchor.x);
  });

  it("keeps the side it had while that side stays clear, so it does not flicker", () => {
    const first = placeTag(anchor, size, [{ left: 560, top: 300, right: 575, bottom: 318 }], bounds);
    const again = placeTag(anchor, size, [], bounds, first.side);
    expect(again.side).toBe(first.side);
  });

  it("stays on screen", () => {
    const p = placeTag({ x: 950, y: 50 }, size, [], bounds);
    expect(p.box.right).toBeLessThanOrEqual(1000);
    expect(p.box.top).toBeGreaterThanOrEqual(0);
  });

  it("takes the side it overlaps least when every side is blocked", () => {
    const everywhere: Rect = { left: 0, top: 0, right: 1000, bottom: 800 };
    const corner: Rect = { left: 538, top: 308, right: 560, bottom: 320 };
    const p = placeTag(anchor, size, [everywhere, corner], bounds);
    expect(p.side).not.toBe(0);
  });
});
