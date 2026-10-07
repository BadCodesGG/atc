import { describe, expect, it } from "vitest";
import type { OrbitView } from "../scene/orbit";
import { airportByCode } from "../airports";
import { type Band, globeCapable, Guide, guide, landingAirport, reveal, revealMask } from "./handover";

const band: Band = { near: 20_000, far: 50_000 };
const home: OrbitView = { azimuthDeg: 30, elevationDeg: 40, target: [600, -200], height: 0, distance: 11_000 };
/** Where the reader's camera was as it came into the band: straight down, north up, a little off the field. */
const entry: OrbitView = { azimuthDeg: 0, elevationDeg: 90, target: [5_000, 3_000], height: 0, distance: 50_000 };

describe("reveal", () => {
  it("is nothing beyond the band, everything inside it, and rises in between", () => {
    expect(reveal(80_000, band)).toBe(0);
    expect(reveal(50_000, band)).toBe(0);
    expect(reveal(20_000, band)).toBe(1);
    expect(reveal(5_000, band)).toBe(1);
    // Halfway in scale (the geometric mean) is halfway revealed.
    expect(reveal(Math.sqrt(20_000 * 50_000), band)).toBeCloseTo(0.5);
    expect(reveal(40_000, band)).toBeGreaterThan(0);
    expect(reveal(40_000, band)).toBeLessThan(reveal(25_000, band));
  });
});

describe("revealMask", () => {
  it("shows the diorama in an ellipse round the airport, flattened by the tilt, the map still in view around it", () => {
    expect(revealMask({ x: 500, y: 400 }, 300, 0.5, 0)).toBe("radial-gradient(330px 165px at 500px 400px, #000 70%, transparent 100%)");
  });

  it("widens the ellipse past the frame as the diorama comes fully in", () => {
    const start = revealMask({ x: 500, y: 400 }, 300, 0.5, 0.7);
    const end = revealMask({ x: 500, y: 400 }, 300, 0.5, 1);
    const width = (mask: string) => Number(/gradient\(([\d.]+)px/.exec(mask)![1]);
    expect(width(start)).toBe(330);
    expect(width(end)).toBeGreaterThan(330 * 3);
  });
});

describe("Guide", () => {
  const at = (distance: number, azimuthDeg = 0): OrbitView => ({ ...entry, azimuthDeg, distance });

  it("turns from the camera it had as it came into the band, and keeps that camera while in it", () => {
    const g = new Guide();
    const first = g.step(at(52_000), at(40_000), home, band);
    expect(first).toEqual(guide(at(52_000), at(40_000), home, band));
    // A later step turns from the same entry camera, not from where the last step left it.
    expect(g.step(first, at(30_000), home, band)).toEqual(guide(at(52_000), at(30_000), home, band));
  });

  it("leaves the camera alone after the diorama hands it back, until it has left the band", () => {
    const g = new Guide();
    g.step(at(52_000), at(40_000), home, band);
    g.release();
    // The reader turned the diorama to 60 degrees before zooming out: the map keeps that.
    const out = at(25_000, 60);
    expect(g.step(at(21_000, 60), out, home, band)).toEqual(out);
    expect(g.step(out, at(45_000, 60), home, band)).toEqual(at(45_000, 60));
    // Out of the band and back in: guided again, from the camera it came back in with.
    expect(g.step(at(45_000, 60), at(55_000, 60), home, band)).toEqual(at(55_000, 60));
    expect(g.step(at(55_000, 60), at(40_000, 60), home, band)).toEqual(guide(at(55_000, 60), at(40_000, 60), home, band));
  });
});

describe("guide", () => {
  const at = (distance: number): OrbitView => ({ ...entry, distance });

  it("keeps the camera it came in with at the band's outer edge", () => {
    expect(guide(entry, at(50_000), home, band)).toEqual(at(50_000));
  });

  it("arrives on the framed view's bearing, tilt and target at the band's inner edge, at the distance asked for", () => {
    const v = guide(entry, at(20_000), home, band);
    expect(v.distance).toBe(20_000);
    expect(v.azimuthDeg).toBeCloseTo(30);
    expect(v.elevationDeg).toBeCloseTo(40);
    expect(v.target[0]).toBeCloseTo(600);
    expect(v.target[1]).toBeCloseTo(-200);
  });

  it("is part of the way there in between, the same however the zoom got there, and goes back the way it came", () => {
    const mid = guide(entry, at(30_000), home, band);
    expect(mid.elevationDeg).toBeLessThan(90);
    expect(mid.elevationDeg).toBeGreaterThan(40);
    // A wheel zoom, an eased button zoom or a zoom back out all land on the same view for the same distance.
    expect(guide(entry, { ...at(30_000), azimuthDeg: 12, elevationDeg: 70 }, home, band)).toEqual(mid);
  });

  it("leaves a camera beyond the band alone", () => {
    const next = { ...entry, azimuthDeg: 45, distance: 55_000 };
    expect(guide(entry, next, home, band)).toEqual(next);
  });

  it("leaves a zoom into somewhere else alone: only a view over the airport is drawn in", () => {
    const elsewhere: OrbitView = { ...entry, target: [80_000, 0], distance: 30_000 };
    expect(guide({ ...entry, target: [80_000, 0] }, elsewhere, home, band)).toEqual(elsewhere);
  });
});

describe("landingAirport", () => {
  const airports = [airportByCode("atl")!, airportByCode("dfw")!];

  it("is the built airport under the middle of the map once the camera is low enough to be landing", () => {
    expect(landingAirport({ lat: 32.9, lng: -97.05 }, 90_000, airports)?.code).toBe("dfw");
    expect(landingAirport({ lat: 33.62, lng: -84.45 }, 30_000, airports)?.code).toBe("atl");
  });

  it("is none from high up, or over open country", () => {
    expect(landingAirport({ lat: 32.9, lng: -97.05 }, 400_000, airports)).toBeNull();
    expect(landingAirport({ lat: 35, lng: -90 }, 30_000, airports)).toBeNull();
  });
});

describe("globeCapable", () => {
  it("keeps the globe off software renderers, which draw it without its lines", () => {
    expect(globeCapable("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe(false);
    expect(globeCapable("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(false);
    expect(globeCapable("ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(true);
    expect(globeCapable("Apple M2")).toBe(true);
  });

  it("keeps it off when the renderer cannot be named", () => {
    expect(globeCapable(null)).toBe(false);
  });
});
