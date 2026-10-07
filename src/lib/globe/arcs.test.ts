import { describe, expect, it } from "vitest";
import type { FlightRoute } from "../routes";
import { routeArcs } from "./arcs";

const at = (code: string, latitude?: number, longitude?: number) => ({ code, city: code, country: null, ...(latitude !== undefined ? { latitude, longitude } : {}) });
const ATL = at("ATL", 33.6367, -84.4281);
const SFO = at("SFO", 37.619, -122.375);
const LHR = at("LHR", 51.4706, -0.461941);

describe("routeArcs", () => {
  it("draws one great-circle arc per pair of airports, however many flights fly it and in either direction", () => {
    const routes: FlightRoute[] = [
      { origin: ATL, destination: SFO },
      { origin: SFO, destination: ATL },
      { origin: ATL, destination: LHR },
    ];
    const arcs = routeArcs(routes);
    expect(arcs.features.map((f) => f.properties)).toEqual([
      { pair: "ATL-SFO", flights: 2 },
      { pair: "ATL-LHR", flights: 1 },
    ]);
    const line = arcs.features[1].geometry.coordinates;
    expect(line[0]).toEqual([-84.4281, 33.6367]);
    expect(line.at(-1)![0]).toBeCloseTo(-0.461941, 6);
    expect(line.at(-1)![1]).toBeCloseTo(51.4706, 6);
    // The great circle from Atlanta to London bows north over Newfoundland, to about 54 degrees: above both ends.
    expect(Math.max(...line.map((p) => p[1]))).toBeGreaterThan(53.5);
  });

  it("leaves out a route with an end it cannot place", () => {
    expect(routeArcs([{ origin: ATL, destination: at("XYZ") }]).features).toEqual([]);
  });

  it("keeps an arc across the antimeridian continuous rather than wrapping it round the world", () => {
    const [arc] = routeArcs([{ origin: at("HNL", 21.3187, -157.922), destination: at("NRT", 35.7647, 140.386) }]).features;
    const lons = arc.geometry.coordinates.map((p) => p[0]);
    for (let i = 1; i < lons.length; i++) expect(Math.abs(lons[i] - lons[i - 1])).toBeLessThan(20);
  });
});
