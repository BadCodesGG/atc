import { describe, expect, it } from "vitest";
import type { FlightRoute } from "../routes";
import { isEstimated, selectedPath, selectionFeatures } from "./selected-path";

const end = (code: string, latitude?: number, longitude?: number) => ({ code, city: code, country: null, ...(latitude !== undefined ? { latitude, longitude } : {}) });
const ATL = end("ATL", 33.6367, -84.4281);
const ORD = end("ORD", 41.9742, -87.9073);
const route: FlightRoute = { origin: ATL, destination: ORD };

describe("selectedPath", () => {
  it("draws the track seen up to the aircraft, with a great circle behind it from the origin and one ahead to the destination", () => {
    const track: [number, number][] = [[-85, 36], [-86, 37.5]];
    const path = selectedPath(track, [-86.5, 38.5], route);
    expect(path.observed).toEqual([...track, [-86.5, 38.5]]);
    expect(path.from[0]).toEqual([-84.4281, 33.6367]);
    expect(path.from.at(-1)).toEqual([-85, 36]);
    expect(path.ahead[0]).toEqual([-86.5, 38.5]);
    expect(path.ahead.at(-1)![0]).toBeCloseTo(-87.9073, 6);
    expect(path.ahead.at(-1)![1]).toBeCloseTo(41.9742, 6);
    expect(isEstimated(path)).toBe(true);
  });

  it("is only the observed track with no route", () => {
    const path = selectedPath([[-85, 36]], [-86, 37], null);
    expect(path).toEqual({ from: [], observed: [[-85, 36], [-86, 37]], ahead: [] });
    expect(isEstimated(path)).toBe(false);
  });

  it("leaves out an end the route cannot place, and the estimate that would only be the airport itself", () => {
    expect(selectedPath([[-85, 36]], [-86, 37], { origin: end("XYZ"), destination: end("QQQ") })).toMatchObject({ from: [], ahead: [] });
    // Taking off from Atlanta: the track begins at the field, so there is nothing between.
    const climbing = selectedPath([[-84.43, 33.64]], [-84.5, 33.7], route);
    expect(climbing.from).toEqual([]);
    expect(climbing.ahead.length).toBeGreaterThan(1);
  });

  it("does not repeat the aircraft when the track already ends on it", () => {
    expect(selectedPath([[-85, 36], [-86, 37]], [-86, 37], null).observed).toHaveLength(2);
  });

  it("is a single point and the whole way estimated before the page has seen the aircraft move", () => {
    const path = selectedPath([], [-86, 37], route);
    expect(path.observed).toEqual([[-86, 37]]);
    expect(path.from.at(-1)).toEqual([-86, 37]);
  });
});

describe("selectionFeatures", () => {
  it("makes a line of each part with something to draw, and the aircraft a point turned to its heading", () => {
    const path = selectedPath([[-85, 36]], [-86, 37], route);
    const { features } = selectionFeatures(path, [-86, 37], 321, 30_000);
    expect(features.map((f) => f.properties.part)).toEqual(["from", "observed", "ahead", "aircraft"]);
    expect(features.at(-1)).toMatchObject({ geometry: { type: "Point", coordinates: [-86, 37] }, properties: { track: 321, altitude: 30_000, lost: false } });
    expect(selectionFeatures(selectedPath([], [-86, 37], null), [-86, 37], 0, 0).features.map((f) => f.properties.part)).toEqual(["aircraft"]);
    const [lost] = selectionFeatures(selectedPath([], [-86, 37], null), [-86, 37], 0, 12_000, true).features;
    expect(lost.properties).toMatchObject({ lost: true, altitude: 12_000 });

  });
});
