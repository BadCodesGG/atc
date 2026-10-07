import { describe, expect, it } from "vitest";
import { MODEL_LENGTH } from "../aircraft-class";
import { JET_LIGHTS, jetGeometry, MODELS, modelGeometry, modelLights } from "./aircraft-model";

describe("jetGeometry", () => {
  it("is airliner-sized, nose north (-z), standing on the ground", () => {
    const g = jetGeometry();
    g.computeBoundingBox();
    const { min, max } = g.boundingBox!;
    expect(max.z - min.z).toBeGreaterThan(40);
    expect(max.z - min.z).toBeLessThan(48);
    expect(max.x - min.x).toBeCloseTo(36, 0);
    expect(min.y).toBeGreaterThanOrEqual(0);
    // The fin is at the back: the tallest point is aft of the middle.
    const p = g.getAttribute("position");
    let top = 0;
    for (let i = 1; i < p.count; i++) if (p.getY(i) > p.getY(top)) top = i;
    expect(p.getZ(top)).toBeGreaterThan(0);
  });
});

describe("jetGeometry paint", () => {
  const g = jetGeometry();
  const p = g.getAttribute("position");
  const paint = g.getAttribute("paint");
  const at = (match: (x: number, y: number, z: number) => boolean) => {
    const values = new Set<number>();
    for (let i = 0; i < p.count; i++) if (match(p.getX(i), p.getY(i), p.getZ(i))) values.add(paint.getX(i));
    return [...values];
  };

  it("has a paint value for every vertex, painted or bare", () => {
    expect(paint.count).toBe(p.count);
    expect(new Set(Array.from({ length: paint.count }, (_, i) => paint.getX(i)))).toEqual(new Set([0, 1]));
  });

  it("leaves the fuselage bare and paints the fin, wings and engines", () => {
    // The crown of the fuselage where it meets the nose.
    expect(at((x, y, z) => Math.abs(x) < 0.5 && z < -15 && z > -17 && y > 5)).toEqual([0]);
    // The tip of the fin, and a wingtip.
    expect(at((x, y) => y > 8.5 && Math.abs(x) < 1)).toEqual([1]);
    expect(at((x) => Math.abs(x) > 17.9)).toEqual([1]);
  });
});

describe("JET_LIGHTS", () => {
  const g = jetGeometry();
  g.computeBoundingBox();
  const { min, max } = g.boundingBox!;
  const light = (kind: string) => JET_LIGHTS.filter((l) => l.kind === kind);

  it("puts red on the left wingtip and green on the right, seen from the cockpit facing north", () => {
    // Facing -z, the pilot's left is -x.
    const [port] = light("port");
    const [starboard] = light("starboard");
    expect(port.x).toBeCloseTo(min.x, 0);
    expect(starboard.x).toBeCloseTo(max.x, 0);
  });

  it("puts the white tail light at the very back and the beacon on top of the fuselage", () => {
    const [tail] = light("tail");
    expect(tail.z).toBeCloseTo(max.z, 0);
    const [beacon] = light("beacon");
    expect(beacon.x).toBe(0);
    expect(beacon.y).toBeGreaterThan(5);
  });

  it("has a strobe on each wingtip", () => {
    expect(light("strobe").map((l) => Math.sign(l.x)).sort()).toEqual([-1, 1]);
  });
});

describe("close-range models", () => {
  /**
   * The narrowbody's fuselage (radius 2.3 m) where the nose meets it, about 15.8 m ahead of the middle:
   * the most any vertex's normal there turns away from straight out from the fuselage's axis, degrees,
   * looking along the fuselage. Smooth shading points them straight out; flat facets do not.
   */
  const facetTurn = (g: ReturnType<typeof modelGeometry>) => {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const ring = [...Array(p.count).keys()].filter((i) => p.getZ(i) > -16.2 && p.getZ(i) < -15.5 && Math.abs(n.getZ(i)) < 0.9 && p.getY(i) > 2);
    const axis = Math.max(...ring.map((i) => p.getY(i))) - 2.3;
    let worst = 0;
    for (const i of ring) {
      const [rx, ry] = [p.getX(i), p.getY(i) - axis];
      if (Math.abs(Math.hypot(rx, ry) - 2.3) > 0.05 || ry < 0.5) continue;
      const turn = Math.abs(Math.atan2(rx * n.getY(i) - ry * n.getX(i), rx * n.getX(i) + ry * n.getY(i)));
      worst = Math.max(worst, (turn * 180) / Math.PI);
    }
    return worst;
  };

  it("rounds the fuselage, shaded smooth, where the far model is flat-faceted", () => {
    expect(facetTurn(modelGeometry("narrow", "near"))).toBeLessThan(2);
    expect(facetTurn(modelGeometry("narrow"))).toBeGreaterThan(10);
  });

  for (const model of MODELS) {
    it(`${model}: the close-range model has the far one's size and paint, with more detail`, () => {
      const far = modelGeometry(model);
      const near = modelGeometry(model, "near");
      far.computeBoundingBox();
      near.computeBoundingBox();
      for (const axis of ["x", "y", "z"] as const) {
        expect(Math.abs(near.boundingBox!.min[axis] - far.boundingBox!.min[axis])).toBeLessThan(0.3);
        expect(Math.abs(near.boundingBox!.max[axis] - far.boundingBox!.max[axis])).toBeLessThan(0.3);
      }
      expect(near.getAttribute("position").count).toBeGreaterThan(far.getAttribute("position").count);
      const paint = near.getAttribute("paint");
      expect(paint.count).toBe(near.getAttribute("position").count);
      expect(new Set(Array.from({ length: paint.count }, (_, i) => paint.getX(i)))).toEqual(new Set([0, 1]));
      far.dispose();
      near.dispose();
    });
  }
});

describe("every model", () => {
  for (const model of MODELS) {
    it(`${model}: its nominal length, nose north, on the ground, lights on it, every vertex painted or bare`, () => {
      const g = modelGeometry(model);
      g.computeBoundingBox();
      const { min, max } = g.boundingBox!;
      expect(max.z - min.z).toBeGreaterThan(MODEL_LENGTH[model] * 0.85);
      expect(max.z - min.z).toBeLessThan(MODEL_LENGTH[model] * 1.15);
      expect(min.y).toBeGreaterThanOrEqual(-1e-6);
      // More of it is ahead of the wing's middle than behind: the nose points to -z.
      const lights = modelLights(model);
      expect(lights.find((l) => l.kind === "port")!.x).toBeLessThan(0);
      expect(lights.find((l) => l.kind === "starboard")!.x).toBeGreaterThan(0);
      for (const l of lights) {
        expect(l.x).toBeGreaterThanOrEqual(min.x - 0.5);
        expect(l.x).toBeLessThanOrEqual(max.x + 0.5);
        expect(l.z).toBeGreaterThanOrEqual(min.z - 0.5);
        expect(l.z).toBeLessThanOrEqual(max.z + 0.5);
      }
      const paint = g.getAttribute("paint");
      expect(paint.count).toBe(g.getAttribute("position").count);
      g.dispose();
    });
  }
});
