import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { Point } from "../airport-map";
import atl from "../../data/airports/atl.json";
import type { AirportMap } from "../airport-map";
import { type Area, bandOffsetY, fitView, fitViewToArea, NEAR_RUNWAY_M, pixelsPerMetre, runwayClearance, type ViewSpec } from "./camera";

const spec: ViewSpec = { azimuthDeg: 28, elevationDeg: 38, fovDeg: 24 };
const square: Point[] = [
  [-2000, -2000],
  [2000, -2000],
  [2000, 2000],
  [-2000, 2000],
];

function ndc(camera: PerspectiveCamera, [x, y]: Point) {
  return new Vector3(x, 0, -y).project(camera);
}

describe("fitView", () => {
  it("frames every point, touching the edge of the frame with at least one", () => {
    const camera = new PerspectiveCamera(spec.fovDeg, 16 / 10, 1, 100_000);
    fitView(camera, spec, square);
    const all = square.map((p) => ndc(camera, p));
    const extent = Math.max(...all.map((v) => Math.max(Math.abs(v.x), Math.abs(v.y))));
    expect(extent).toBeLessThanOrEqual(1.0001);
    expect(extent).toBeGreaterThan(0.98);
  });

  it("looks from the south-west toward the north-east at the given elevation", () => {
    const camera = new PerspectiveCamera(spec.fovDeg, 16 / 10, 1, 100_000);
    fitView(camera, spec, square);
    const dir = camera.getWorldDirection(new Vector3());
    // World x is east, -z north.
    expect(Math.atan2(dir.x, -dir.z) * (180 / Math.PI)).toBeCloseTo(28, 3);
    expect(Math.asin(-dir.y) * (180 / Math.PI)).toBeCloseTo(38, 3);
  });

  it("backs further off to fit the same ground into a portrait frame", () => {
    const wide = new PerspectiveCamera(spec.fovDeg, 16 / 10, 1, 100_000);
    const tall = new PerspectiveCamera(spec.fovDeg, 390 / 844, 1, 100_000);
    expect(fitView(tall, spec, square)).toBeGreaterThan(fitView(wide, spec, square));
  });

  it("zooms in past the fit when asked, cropping the points", () => {
    const camera = new PerspectiveCamera(spec.fovDeg, 16 / 10, 1, 100_000);
    const fitted = fitView(camera, spec, square);
    expect(fitView(camera, spec, square, { zoom: 1.5 })).toBeCloseTo(fitted / 1.5, 0);
  });
});

describe("fitViewToArea", () => {
  const size = { width: 1440, height: 900 };
  // The frame less a 332 px column down the right and a band top and bottom, as the wide layout leaves it.
  const area: Area = { left: 28, top: 84, right: 1440 - 332 - 28, bottom: 900 - 84 };
  const frame = () => new PerspectiveCamera(spec.fovDeg, size.width / size.height, 1, 100_000);
  const pixels = (camera: PerspectiveCamera, p: Point) => {
    const v = ndc(camera, p);
    return { x: ((v.x + 1) / 2) * size.width, y: ((1 - v.y) / 2) * size.height };
  };

  it("keeps every point inside the area and touches its edge, centred on it", () => {
    const camera = frame();
    fitViewToArea(camera, spec, square, area, size);
    const all = square.map((p) => pixels(camera, p));
    const xs = all.map((p) => p.x);
    const ys = all.map((p) => p.y);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(area.left - 0.5);
    expect(Math.max(...xs)).toBeLessThanOrEqual(area.right + 0.5);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(area.top - 0.5);
    expect(Math.max(...ys)).toBeLessThanOrEqual(area.bottom + 0.5);
    // One axis is tight; both are centred.
    const tight = Math.max((Math.max(...xs) - Math.min(...xs)) / (area.right - area.left), (Math.max(...ys) - Math.min(...ys)) / (area.bottom - area.top));
    expect(tight).toBeGreaterThan(0.99);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo((area.left + area.right) / 2, 0);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo((area.top + area.bottom) / 2, 0);
  });

  it("looks the same way as fitView: only the framing differs", () => {
    const camera = frame();
    fitViewToArea(camera, spec, square, area, size);
    const dir = camera.getWorldDirection(new Vector3());
    expect(Math.atan2(dir.x, -dir.z) * (180 / Math.PI)).toBeCloseTo(28, 3);
    expect(Math.asin(-dir.y) * (180 / Math.PI)).toBeCloseTo(38, 3);
  });

  it("backs off when the area is narrower", () => {
    const wide = fitViewToArea(frame(), spec, square, area, size);
    const narrow = fitViewToArea(frame(), spec, square, { ...area, right: 700 }, size);
    expect(narrow).toBeGreaterThan(wide);
  });
});

describe("pixelsPerMetre", () => {
  it("is the on-screen size of a metre across the view at the point looked at", () => {
    const aspect = 16 / 10;
    const height = 900;
    const camera = new PerspectiveCamera(spec.fovDeg, aspect, 1, 100_000);
    const distance = fitView(camera, spec, square);
    // 100 m to the camera's right along the ground, from the point at the centre of the frame.
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const across = new Vector3(0, 0, 0).addScaledVector(right, 100).project(camera);
    expect(pixelsPerMetre(spec, distance, height)).toBeCloseTo((across.x * height * aspect) / 2 / 100, 1);
  });
});

describe("runwayClearance", () => {
  const map = atl as unknown as AirportMap;
  const terminals = map.terminals.filter((t) => /concourse|terminal/i.test(t.name ?? "")).flatMap((t) => t.rings[0]);

  it("keeps ATL's four parallel runways in the framed field and leaves 10/28 out", () => {
    const near = map.runways.filter((r) => runwayClearance(r, terminals) <= NEAR_RUNWAY_M).map((r) => r.ref);
    expect(near.sort()).toEqual(["08L/26R", "08R/26L", "09L/27R", "09R/27L"]);
  });

  it("is 0 for a runway that crosses the box and Infinity without two ends", () => {
    const box: Point[] = [[0, 0], [100, 100]];
    expect(runwayClearance({ ref: "x", width: 45, surface: null, centerline: [], ends: [{ ref: "a", x: -50, y: 50 }, { ref: "b", x: 150, y: 50 }] }, box)).toBe(0);
    expect(runwayClearance({ ref: "x", width: 45, surface: null, centerline: [], ends: [{ ref: "a", x: 0, y: 300 }] }, box)).toBe(Infinity);
    expect(runwayClearance({ ref: "x", width: 45, surface: null, centerline: [], ends: [{ ref: "a", x: 0, y: 300 }, { ref: "b", x: 100, y: 300 }] }, box)).toBeCloseTo(200, 6);
  });
});

describe("bandOffsetY", () => {
  const band = (top: number, bottom: number): Area => ({ left: 0, top, right: 375, bottom });

  it("draws the frame's centre in the middle of the band", () => {
    // 375x667 with the card folded: tabs at 296, card at 416, so the middle is 356 and the picture moves down 22.5 px.
    expect(bandOffsetY(667, band(296, 416))).toBe(-22.5);
  });

  it("centres in a short band too, the one place a phone with the card open leaves uncovered", () => {
    expect(bandOffsetY(667, band(292, 340))).toBe(17.5);
  });

  it("centres in the frame while the chrome has no height yet", () => {
    expect(bandOffsetY(667, band(0, 0))).toBe(0);
    expect(bandOffsetY(667, band(300, 280))).toBe(0);
  });
});
