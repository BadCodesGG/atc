import { describe, expect, it } from "vitest";
import { Pavement } from "./pavement";

/** A 400 m square apron at the origin, a 20 m wide taxiway running north from it, and a runway to the south. */
const plan = {
  aprons: [
    {
      rings: [
        [
          [0, 0],
          [400, 0],
          [400, 400],
          [0, 400],
        ],
      ] as [number, number][][],
    },
  ],
  taxiways: [
    {
      ref: "A",
      width: 20,
      kind: "taxiway" as const,
      line: [
        [200, 400],
        [200, 1400],
      ] as [number, number][],
    },
  ],
  runways: [
    {
      ref: "09/27",
      width: 45,
      surface: null,
      centerline: [] as [number, number][],
      ends: [
        { ref: "09", x: -1000, y: -500 },
        { ref: "27", x: 2000, y: -500 },
      ],
    },
  ],
};

describe("Pavement.nearest", () => {
  const pavement = new Pavement(plan);

  it("leaves a point on an apron, a taxiway or a runway where it is", () => {
    expect(pavement.nearest(100, 100)).toEqual({ x: 100, y: 100, distance: 0 });
    expect(pavement.nearest(208, 900)).toEqual({ x: 208, y: 900, distance: 0 });
    expect(pavement.nearest(1500, -480)).toEqual({ x: 1500, y: -480, distance: 0 });
  });

  it("moves a point beside a taxiway onto its edge", () => {
    const p = pavement.nearest(260, 900)!;
    expect(p.x).toBeCloseTo(210);
    expect(p.y).toBeCloseTo(900);
    expect(p.distance).toBeCloseTo(50);
  });

  it("moves a point off an apron onto its nearest edge", () => {
    const p = pavement.nearest(500, 100)!;
    expect(p).toMatchObject({ x: 400, y: 100 });
    expect(p.distance).toBeCloseTo(100);
  });

  it("moves a point beside a runway onto the runway's edge", () => {
    const p = pavement.nearest(0, -600)!;
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(-522.5);
  });
});

describe("Pavement.offset", () => {
  const pavement = new Pavement(plan);

  it("is nothing for a point on pavement", () => {
    expect(pavement.offset(200, 900)).toEqual([0, 0]);
  });

  it("puts a point up to 100 m off all the way back on the edge", () => {
    const [dx, dy] = pavement.offset(260, 900);
    expect(dx).toBeCloseTo(-50);
    expect(dy).toBeCloseTo(0);
  });

  it("moves a point between 100 and 150 m off less and less, and one farther off not at all", () => {
    const [dx] = pavement.offset(335, 900);
    expect(dx).toBeCloseTo(-125 * 0.5);
    expect(pavement.offset(370, 900)).toEqual([0, 0]);
  });
});
