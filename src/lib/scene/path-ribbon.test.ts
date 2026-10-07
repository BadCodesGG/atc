import { describe, expect, it } from "vitest";
import { pathRibbons, type RibbonPath } from "./path-ribbon";

const opts = { width: 10, lift: 2, markSpacing: 1e6, colorOf: () => [1, 0.5, 0] as [number, number, number] };
const taxi = (points: [number, number, number][], emphasis = false): RibbonPath => ({ state: "taxiing", emphasis, legs: [{ kind: "taxi", points }] });

/** Vertex i as [x, height, z] (three's axes: z is minus north). */
const vertex = (m: ReturnType<typeof pathRibbons>, i: number) => [m.positions[3 * i], m.positions[3 * i + 1], m.positions[3 * i + 2]];
const alpha = (m: ReturnType<typeof pathRibbons>, i: number) => m.colors[4 * i + 3];

describe("pathRibbons", () => {
  it("lays a straight taxi route as one strip its width across, lifted off the ground", () => {
    const m = pathRibbons(
      [
        taxi([
          [0, 0, 0],
          [100, 0, 0],
        ]),
      ],
      opts,
    );
    expect(m.positions.length / 3).toBe(4);
    expect(m.indices.length).toBe(6);
    const zs = [0, 1, 2, 3].map((i) => vertex(m, i)[2]).sort((a, b) => a - b);
    expect(zs).toEqual([-5, -5, 5, 5]);
    expect([0, 1, 2, 3].every((i) => vertex(m, i)[1] === 2)).toBe(true);
    expect([...m.colors.slice(0, 3)]).toEqual([1, 0.5, 0]);
  });

  it("keeps its width round a corner instead of pinching it", () => {
    const m = pathRibbons(
      [
        taxi([
          [0, 0, 0],
          [100, 0, 0],
          [100, 100, 0],
        ]),
      ],
      opts,
    );
    // The corner's two vertices sit on the bisector, half the width times root two out.
    const corner = [2, 3].map((i) => vertex(m, i));
    for (const [x, , z] of corner) expect(Math.hypot(x - 100, z - 0)).toBeCloseTo(5 * Math.SQRT2, 5);
  });

  it("marks the direction of travel with chevrons whose points lead", () => {
    const m = pathRibbons(
      [
        taxi([
          [0, 0, 0],
          [100, 0, 0],
        ]),
      ],
      { ...opts, markSpacing: 40 },
    );
    // The strip's four vertices, then six per chevron: at 20 m and 60 m along (100 m is past the last).
    const marks = (m.positions.length / 3 - 4) / 6;
    expect(marks).toBe(2);
    const first = [4, 5, 6, 7, 8, 9].map((i) => vertex(m, i));
    const tip = Math.max(...first.map((v) => v[0]));
    const back = Math.min(...first.map((v) => v[0]));
    // The tip is the one vertex on the centreline at the front.
    expect(first.find((v) => v[0] === tip)![2]).toBeCloseTo(0);
    expect(tip).toBeGreaterThan(back);
    // Above the strip, and brighter than it.
    expect(first[0][1]).toBeGreaterThan(2);
    expect(alpha(m, 4)).toBeGreaterThan(alpha(m, 0));
  });

  it("fades a climb-out away to nothing at its far end, rising with it", () => {
    const m = pathRibbons(
      [
        {
          state: "departing",
          emphasis: true,
          legs: [
            {
              kind: "runway",
              points: [
                [0, 0, 0],
                [1000, 0, 0],
              ],
            },
            {
              kind: "air",
              points: [
                [1000, 0, 0],
                [7000, 0, 360],
              ],
            },
          ],
        },
      ],
      opts,
    );
    // Three points along the strip (the shared one once), two vertices each, and a curtain under the climb.
    expect(m.positions.length / 3).toBe(6 + 4);
    expect(alpha(m, 0)).toBeGreaterThan(0);
    expect(alpha(m, 4)).toBe(0);
    expect(vertex(m, 4)[1]).toBe(362);
  });

  it("draws an approach at full strength over the field, fading out with distance from it, and never fades it at touchdown", () => {
    const m = pathRibbons(
      [
        {
          state: "arriving",
          emphasis: true,
          legs: [
            {
              kind: "air",
              points: [
                [20000, 0, 1000],
                [5000, 0, 250],
                [500, 0, 0],
              ],
            },
          ],
        },
      ],
      { ...opts, fade: { near: 4000, far: 12000 } },
    );
    const strip = alpha(m, 4);
    expect(strip).toBeGreaterThan(0);
    expect(alpha(m, 0)).toBe(0);
    // 5 km out is an eighth of the way from 4 km to 12 km.
    expect(alpha(m, 2) / strip).toBeCloseTo(0.875, 5);
  });

  it("fades a long climb-out with distance from the field as well as toward its end", () => {
    const m = pathRibbons(
      [
        {
          state: "departing",
          emphasis: true,
          legs: [
            {
              kind: "air",
              points: [
                [0, 0, 0],
                [8000, 0, 480],
                [16000, 0, 960],
              ],
            },
          ],
        },
      ],
      { ...opts, fade: { near: 4000, far: 12000 } },
    );
    // Halfway along, so half its strength by its length; but 8 km out takes it to half as well.
    expect(alpha(m, 2) / alpha(m, 0)).toBeCloseTo(0.5, 5);
    expect(alpha(m, 4)).toBe(0);
  });

  it("hangs a see-through curtain from a leg in the air to the ground, so its height reads from above", () => {
    const m = pathRibbons(
      [
        {
          state: "arriving",
          emphasis: true,
          legs: [
            {
              kind: "air",
              points: [
                [2000, 0, 100],
                [0, 0, 0],
              ],
            },
          ],
        },
      ],
      opts,
    );
    // The strip's four vertices, then the curtain's: its top along the strip's centre, its foot on the ground.
    const curtain = [4, 5, 6, 7].map((i) => ({ v: vertex(m, i), a: alpha(m, i) }));
    expect(curtain.map((c) => c.v[1]).sort((a, b) => a - b)).toEqual([2, 2, 2, 102]);
    const top = curtain.find((c) => c.v[1] === 102)!;
    expect(top.a).toBeGreaterThan(0);
    expect(top.a).toBeLessThan(alpha(m, 0));
    expect(curtain.filter((c) => c.v[1] === 2 && c.v[0] === 2000)[0].a).toBe(0);
  });

  it("draws only the taxi route of every flight but the selected one: no roll, rollout, climb-out or approach", () => {
    const departure = (emphasis: boolean): RibbonPath => ({
      state: "taxiing",
      emphasis,
      legs: [
        {
          kind: "taxi",
          points: [
            [0, 0, 0],
            [100, 0, 0],
          ],
        },
        {
          kind: "runway",
          points: [
            [100, 0, 0],
            [100, 100, 0],
          ],
        },
        {
          kind: "air",
          points: [
            [100, 100, 0],
            [100, 6100, 360],
          ],
        },
      ],
    });
    expect(pathRibbons([departure(false)], opts).positions.length / 3).toBe(4);
    // Four points, two vertices each, and the curtain under the climb-out's one stretch.
    expect(pathRibbons([departure(true)], opts).positions.length / 3).toBe(8 + 4);
  });

  it("draws the selected flight's path stronger than the rest", () => {
    const line: [number, number, number][] = [
      [0, 0, 0],
      [100, 0, 0],
    ];
    const plain = pathRibbons([taxi(line)], opts);
    const strong = pathRibbons([taxi(line, true)], opts);
    expect(alpha(strong, 0)).toBeGreaterThan(alpha(plain, 0));
  });
});
