import { describe, expect, it } from "vitest";
import { type OrbitBounds, type OrbitView, panAlong } from "./orbit";
import { viewKey } from "./view-keys";

const press = (key: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "altKey" | "metaKey", boolean>> = {}) =>
  viewKey({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods });

describe("viewKey", () => {
  it("arrows pan: up forward, down back, left and right sideways", () => {
    expect(press("ArrowUp")).toEqual({ kind: "pan", forward: 1, right: 0 });
    expect(press("ArrowDown")).toEqual({ kind: "pan", forward: -1, right: 0 });
    expect(press("ArrowLeft")).toEqual({ kind: "pan", forward: 0, right: -1 });
    expect(press("ArrowRight")).toEqual({ kind: "pan", forward: 0, right: 1 });
  });

  it("plus and minus zoom by the buttons' step, with or without shift", () => {
    expect(press("+")).toEqual({ kind: "zoom", factor: 0.7 });
    expect(press("=")).toEqual({ kind: "zoom", factor: 0.7 });
    expect(press("+", { shiftKey: true })).toEqual({ kind: "zoom", factor: 0.7 });
    expect(press("-")).toEqual({ kind: "zoom", factor: 1 / 0.7 });
    expect(press("_", { shiftKey: true })).toEqual({ kind: "zoom", factor: 1 / 0.7 });
  });

  it("Q and E, or shift with left and right, turn by the buttons' step; shift with up and down tilts", () => {
    expect(press("q")).toEqual({ kind: "turn", deg: -30, tilt: 0 });
    expect(press("E", { shiftKey: true })).toEqual({ kind: "turn", deg: 30, tilt: 0 });
    expect(press("ArrowLeft", { shiftKey: true })).toEqual({ kind: "turn", deg: -30, tilt: 0 });
    expect(press("ArrowRight", { shiftKey: true })).toEqual({ kind: "turn", deg: 30, tilt: 0 });
    expect(press("ArrowUp", { shiftKey: true })).toEqual({ kind: "turn", deg: 0, tilt: 10 });
    expect(press("ArrowDown", { shiftKey: true })).toEqual({ kind: "turn", deg: 0, tilt: -10 });
  });

  it("leaves other keys, and the browser's own shortcuts, alone", () => {
    expect(press("Tab")).toBeNull();
    expect(press("a")).toBeNull();
    expect(press("+", { ctrlKey: true })).toBeNull();
    expect(press("-", { metaKey: true })).toBeNull();
    expect(press("ArrowLeft", { altKey: true })).toBeNull();
  });
});

describe("panAlong", () => {
  const bounds: OrbitBounds = { minDistance: 250, maxDistance: 12_000, radius: 3000, home: [0, 0] };
  const north: OrbitView = { azimuthDeg: 0, elevationDeg: 40, target: [0, 0], height: 0, distance: 8000 };

  it("moves forward along the bearing the camera looks and right across it", () => {
    expect(panAlong(north, 100, 0, bounds).target).toEqual([0, 100]);
    const east = panAlong({ ...north, azimuthDeg: 90 }, 100, 50, bounds).target;
    expect(east[0]).toBeCloseTo(100);
    expect(east[1]).toBeCloseTo(-50);
  });

  it("stays within the bounds", () => {
    expect(panAlong(north, 10_000, 0, bounds).target[1]).toBeCloseTo(3000);
  });
});
