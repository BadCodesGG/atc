import { describe, expect, it } from "vitest";
import type { FlightState } from "../aircraft-state";
import type { TrailPoint } from "../timelapse";
import { TrailStrips } from "./light-trails";

const COLORS: Record<FlightState, [number, number, number]> = { arriving: [0, 0, 1], departing: [1, 0, 0], taxiing: [1, 0.5, 0], parked: [0.5, 0.5, 0.5] };
const style = { floor: 2, colors: COLORS, intensity: 1 };

const point = (run: number, x: number, y: number, t: number, extra: Partial<TrailPoint> = {}): TrailPoint => ({ run, x, y, h: 0, t, state: "taxiing", onGround: true, ...extra });
const vec = (a: Float32Array, size: number, v: number) => [...a.slice(size * v, size * v + size)];

describe("TrailStrips", () => {
  it("lays a run down as two vertices a point on its centreline, sides apart, in the scene's axes", () => {
    const strips = new TrailStrips(100);
    strips.clear(1000);
    strips.append([point(0, 0, 0, 1000), point(0, 100, 0, 1010), point(0, 200, 0, 1020, { h: 50, state: "departing" })], style);
    expect(strips.vertices).toBe(6);
    expect(strips.indices).toBe(12);
    // Map (x, y) is the scene's (x, -z); heights never sink below the floor; both sides start on the centreline.
    expect(vec(strips.positions, 3, 0)).toEqual([0, 2, -0]);
    expect(vec(strips.positions, 3, 5)).toEqual([200, 50, -0]);
    // Each side's way out from the centreline, on the map: left then right of the direction of travel.
    expect(vec(strips.sides, 2, 0)).toEqual([-0, 1]);
    expect(vec(strips.sides, 2, 1)).toEqual([0, -1]);
    expect([...strips.index.slice(0, 12)]).toEqual([0, 1, 3, 0, 3, 2, 2, 3, 5, 2, 5, 4]);
    // Times from the epoch, so a float holds them to the millisecond; colours by state.
    expect([...strips.times.slice(0, 6)]).toEqual([0, 0, 10, 10, 20, 20]);
    expect(vec(strips.colors, 3, 4)).toEqual([1, 0, 0]);
  });

  it("takes each run's new points as they come, mitring the corner it turns at", () => {
    const strips = new TrailStrips(100);
    strips.clear(0);
    strips.append([point(0, 0, 0, 0), point(7, 0, 500, 0), point(0, 100, 0, 10)], style);
    strips.append([point(0, 100, 100, 20)], style);
    // The corner at (100, 0), written when the run went straight, is turned to the mitre once the next point shows the turn.
    const [nx, ny] = vec(strips.sides, 2, 4);
    expect(nx).toBeCloseTo(-1);
    expect(ny).toBeCloseTo(1);
    expect(strips.indices).toBe(12);
  });

  it("reports only what changed since the last upload", () => {
    const strips = new TrailStrips(100);
    strips.clear(0);
    strips.append([point(0, 0, 0, 0), point(0, 100, 0, 10)], style);
    expect(strips.takeChanges()).toEqual({ vertexStart: 0, vertexCount: 4, indexStart: 0, indexCount: 6 });
    expect(strips.takeChanges()).toEqual({ vertexStart: 4, vertexCount: 0, indexStart: 6, indexCount: 0 });
    strips.append([point(0, 200, 0, 20)], style);
    // The point before is rewritten (its mitre) as well as the new one added.
    expect(strips.takeChanges()).toEqual({ vertexStart: 2, vertexCount: 4, indexStart: 6, indexCount: 6 });
  });

  it("stops at its size rather than writing past it", () => {
    const strips = new TrailStrips(5);
    strips.clear(0);
    strips.append([point(0, 0, 0, 0), point(0, 100, 0, 10), point(0, 200, 0, 20)], style);
    expect(strips.vertices).toBe(4);
    expect(strips.full).toBe(true);
  });

  it("starts empty again on clear", () => {
    const strips = new TrailStrips(100);
    strips.clear(0);
    strips.append([point(0, 0, 0, 0), point(0, 100, 0, 10)], style);
    strips.clear(50);
    strips.append([point(0, 300, 0, 60), point(0, 400, 0, 70)], style);
    expect(strips.vertices).toBe(4);
    expect([...strips.times.slice(0, 4)]).toEqual([10, 10, 20, 20]);
  });
});
