import { describe, expect, it } from "vitest";
import { confine, ease, ORBIT_FOV, MAX_ELEVATION, MIN_ELEVATION, type OrbitBounds, type OrbitView, orbit, pan, turn, zoom } from "./orbit";

const home: OrbitView = { azimuthDeg: 30, elevationDeg: 40, target: [0, 0], height: 0, distance: 8000 };
const bounds: OrbitBounds = { minDistance: 250, maxDistance: 12_000, radius: 3000, home: [0, 0] };

describe("orbit and turn", () => {
  it("a sideways drag turns and an upright one tilts, within limits", () => {
    expect(orbit(home, -100, 0).azimuthDeg).toBeCloseTo(60);
    expect(orbit(home, 200, 0).azimuthDeg).toBeCloseTo(330);
    expect(orbit(home, 0, 10_000).elevationDeg).toBe(MAX_ELEVATION);
    expect(orbit(home, 0, -10_000).elevationDeg).toBe(MIN_ELEVATION);
  });

  it("turn wraps the bearing", () => {
    expect(turn(home, -45).azimuthDeg).toBe(345);
  });
});

describe("zoom and pan", () => {
  it("zoom stays within the distance limits", () => {
    expect(zoom(home, 0.001, bounds).distance).toBe(250);
    expect(zoom(home, 100, bounds).distance).toBe(12_000);
    expect(zoom(home, 0.5, bounds).distance).toBe(4000);
  });

  it("pan slides the target but never past the radius", () => {
    expect(pan(home, 100, -50, bounds).target).toEqual([100, -50]);
    expect(pan(home, 10_000, 0, bounds).target[0]).toBeCloseTo(3000);
    expect(confine([0, -5000], bounds)[1]).toBeCloseTo(-3000);
  });

  it("does not snap a target that Follow left beyond the radius back to it in one move", () => {
    const far: OrbitView = { ...home, target: [15_000, 0] };
    expect(pan(far, 5, 0, bounds).target[0]).toBeCloseTo(15_000);
    expect(pan(far, -5, 0, bounds).target[0]).toBeCloseTo(14_995);
  });
});

describe("ease", () => {
  it("turns the short way round", () => {
    expect(ease({ ...home, azimuthDeg: 350 }, { ...home, azimuthDeg: 10 }, 0.5).azimuthDeg).toBeCloseTo(0);
  });

  it("arrives at k = 1, and starts where it was at k = 0", () => {
    const goal: OrbitView = { ...home, target: [500, 200], distance: 1200 };
    expect(ease(home, goal, 1)).toEqual(goal);
    expect(ease(home, goal, 0)).toEqual(home);
  });

  it("eases the lens and the eye level too, a view without them counting as the orbit's", () => {
    const cockpit: OrbitView = { ...home, fovDeg: 56, eyeLevel: 1 };
    const half = ease(cockpit, home, 0.5);
    expect(half.fovDeg).toBeCloseTo((56 + ORBIT_FOV) / 2);
    expect(half.eyeLevel).toBeCloseTo(0.5);
    expect(ease(home, cockpit, 1).fovDeg).toBe(56);
  });

  it("eases a camera mode's haze and true-size share, leaving a plain orbit view without them", () => {
    const drone: OrbitView = { ...home, eyeLevel: 1, haze: 4000, trueSize: 1 };
    const half = ease(home, drone, 0.5);
    expect(half.trueSize).toBeCloseTo(0.5);
    expect(half.haze).toBe(4000);
    expect(ease(home, { ...home, distance: 100 }, 0.5)).not.toHaveProperty("haze");
    expect(ease(home, { ...home, distance: 100 }, 0.5)).not.toHaveProperty("trueSize");
  });
});
