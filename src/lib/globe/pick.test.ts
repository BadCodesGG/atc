import { describe, expect, it } from "vitest";
import { pickAircraft, REACH_PX } from "./pick";

const sky = [
  { id: "near", x: 100, y: 100 },
  { id: "nearer", x: 104, y: 100 },
  { id: "far", x: 200, y: 200 },
];

describe("pickAircraft", () => {
  it("picks the nearest aircraft within reach", () => {
    expect(pickAircraft(sky, { x: 103, y: 100 }, REACH_PX.pointer)).toBe("nearer");
  });

  it("picks nothing from empty map", () => {
    expect(pickAircraft(sky, { x: 150, y: 150 }, REACH_PX.pointer)).toBeNull();
    expect(pickAircraft([], { x: 0, y: 0 }, REACH_PX.touch)).toBeNull();
  });

  it("reaches a touch 44 px across: a finger lands off a small glyph", () => {
    const tap = { x: 100 + 20, y: 100 };
    expect(pickAircraft([sky[0]], tap, REACH_PX.pointer)).toBeNull();
    expect(pickAircraft([sky[0]], tap, REACH_PX.touch)).toBe("near");
    expect(REACH_PX.touch * 2).toBeGreaterThanOrEqual(44);
  });
});
