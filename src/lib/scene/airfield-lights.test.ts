import { describe, expect, it } from "vitest";
import type { AirportMap, Runway } from "../airport-map";
import { airfieldLights, type AirfieldLight } from "./airfield-lights";

/** Runway 09/27, 2000 m long and 45 m wide, along the x axis from the origin. */
const runway: Runway = {
  ref: "09/27",
  width: 45,
  surface: "asphalt",
  centerline: [
    [0, 0],
    [2000, 0],
  ],
  ends: [
    { ref: "09", x: 0, y: 0 },
    { ref: "27", x: 2000, y: 0 },
  ],
};

function plan(extra: Partial<AirportMap> = {}): Pick<AirportMap, "runways" | "taxiways" | "aprons" | "navaids"> {
  return { runways: [runway], taxiways: [], aprons: [], navaids: [], ...extra };
}

const of = (lights: AirfieldLight[], kind: AirfieldLight["kind"]) => lights.filter((l) => l.kind === kind);

describe("airfieldLights on a runway", () => {
  const lights = airfieldLights(plan());

  it("lines both edges end to end, 60 m apart at most, just outside the pavement", () => {
    const edge = [...of(lights, "runwayEdge"), ...of(lights, "runwayCaution")];
    for (const side of [1, -1]) {
      const row = edge.filter((l) => Math.sign(l.y) === side).sort((a, b) => a.x - b.x);
      expect(row[0].x).toBeCloseTo(0);
      expect(row.at(-1)!.x).toBeCloseTo(2000);
      for (let i = 1; i < row.length; i++) expect(row[i].x - row[i - 1].x).toBeLessThanOrEqual(60 + 1e-9);
      for (const l of row) expect(Math.abs(l.y)).toBeCloseTo(22.5 + 1.5);
    }
  });

  it("turns the edge lights amber for the last 600 m before each end", () => {
    const caution = of(lights, "runwayCaution");
    expect(caution.length).toBeGreaterThan(0);
    for (const l of caution) expect(l.x < 600 || l.x > 1400).toBe(true);
    for (const l of of(lights, "runwayEdge")) expect(l.x >= 600 && l.x <= 1400).toBe(true);
  });

  it("runs white centreline lights between the thresholds, 30 m apart", () => {
    const centre = of(lights, "runwayCentre").sort((a, b) => a.x - b.x);
    expect(centre.every((l) => l.y === 0)).toBe(true);
    expect(centre.length).toBeGreaterThanOrEqual(2000 / 30 - 2);
    for (let i = 1; i < centre.length; i++) expect(centre[i].x - centre[i - 1].x).toBeCloseTo(30);
  });

  it("puts a green threshold bar across each end and a red end bar well inside it, so the two read as separate bars", () => {
    for (const endX of [0, 2000]) {
      const green = of(lights, "threshold").filter((l) => Math.abs(l.x - endX) < 1);
      expect(green.length).toBeGreaterThanOrEqual(6);
      expect(Math.max(...green.map((l) => Math.abs(l.y)))).toBeCloseTo(22.5);
      const red = of(lights, "runwayEnd").filter((l) => Math.abs(l.x - endX) < 40);
      expect(red.length).toBeGreaterThanOrEqual(6);
      // Inboard of the threshold, on the runway, and at least 15 m from the green bar.
      for (const l of red) expect(l.x > 0 && l.x < 2000).toBe(true);
      for (const l of red) expect(Math.abs(l.x - endX)).toBeGreaterThanOrEqual(15);
    }
  });
});

describe("airfieldLights on taxiways", () => {
  it("runs green centreline lights along a main named taxiway, 60 m apart", () => {
    const lights = airfieldLights(plan({ taxiways: [{ ref: "A", width: 23, kind: "taxiway", line: [[0, 300], [0, 900]] }] }));
    const green = of(lights, "taxiwayCentre").sort((a, b) => a.y - b.y);
    expect(green[0]).toMatchObject({ x: 0, y: 300 });
    expect(green.at(-1)).toMatchObject({ x: 0, y: 900 });
    expect(green).toHaveLength(11);
  });

  it("leaves the numbered connectors and the named lanes unlit, lighting only the lettered routes", () => {
    const lights = airfieldLights(
      plan({
        taxiways: [
          { ref: "B3", width: 23, kind: "taxiway", line: [[100, 300], [100, 900]] },
          { ref: "6N", width: 23, kind: "taxiway", line: [[200, 300], [200, 900]] },
          { ref: "East", width: 23, kind: "taxiway", line: [[300, 300], [300, 900]] },
          { ref: "SG", width: 23, kind: "taxiway", line: [[400, 300], [400, 900]] },
        ],
      }),
    );
    const xs = new Set(of(lights, "taxiwayCentre").map((l) => l.x));
    expect([...xs]).toEqual([400]);
  });

  it("leaves minor taxilanes and the stretch of a taxiway on the runway unlit", () => {
    const lights = airfieldLights(
      plan({
        taxiways: [
          { ref: null, width: 15, kind: "taxilane", line: [[500, 300], [500, 900]] },
          // Crosses the runway: nothing on the pavement between its edges.
          { ref: "B", width: 23, kind: "taxiway", line: [[1000, -200], [1000, 200]] },
        ],
      }),
    );
    const green = of(lights, "taxiwayCentre");
    expect(green.some((l) => l.x === 500)).toBe(false);
    expect(green.filter((l) => l.x === 1000).length).toBeGreaterThanOrEqual(4);
    expect(green.some((l) => Math.abs(l.y) < 22.5)).toBe(false);
  });
});

describe("airfieldLights from the navaids", () => {
  it("leaves out mapped approach lights within 60 m of a runway end, where they would merge with its bars", () => {
    const lights = airfieldLights(plan({ navaids: [{ kind: "als", ref: null, x: -20, y: 0 }, { kind: "als", ref: null, x: 2050, y: 10 }, { kind: "als", ref: null, x: -90, y: 0 }] }));
    expect(of(lights, "approach")).toEqual([{ kind: "approach", x: -90, y: 0 }]);
  });

  it("draws one approach light per mapped approach light", () => {
    const lights = airfieldLights(plan({ navaids: [{ kind: "als", ref: null, x: -300, y: 0 }, { kind: "als", ref: null, x: -330, y: 5 }] }));
    expect(of(lights, "approach")).toEqual([
      { kind: "approach", x: -300, y: 0 },
      { kind: "approach", x: -330, y: 5 },
    ]);
  });

  it("draws a PAPI as four lights across the runway's direction, two red and two white", () => {
    const lights = airfieldLights(plan({ navaids: [{ kind: "papi", ref: null, x: 400, y: -60 }] }));
    const papi = [...of(lights, "papiRed"), ...of(lights, "papiWhite")];
    expect(papi).toHaveLength(4);
    expect(of(lights, "papiRed")).toHaveLength(2);
    // A row running across the runway (along y), at the navaid's x.
    for (const l of papi) expect(l.x).toBeCloseTo(400);
    expect(new Set(papi.map((l) => Math.round(l.y))).size).toBe(4);
  });
});
