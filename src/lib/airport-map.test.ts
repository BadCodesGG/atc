import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AIRPORTS } from "./airports";
import {
  buildAirportMap,
  DEFAULTS,
  parseLength,
  project,
  signedArea,
  simplifyLine,
  simplifyRing,
  splitRunwayRef,
  type AirportMap,
  type BuildOptions,
  type OsmElement,
  type OsmMember,
  type OverpassJson,
  type Point,
  type Ring,
} from "./airport-map";
import { toGeo, toLocal } from "./geo";
import sample from "./__fixtures__/osm_atl_sample.json";

const ATL = AIRPORTS[0];
const ORIGIN = { latitude: ATL.latitude, longitude: ATL.longitude };

// Synthetic Overpass elements are laid out in local metres and converted back to lat/lon, so the
// expected output can be written in metres too. Equal inputs give equal lat/lon, which is what
// lets ways share end nodes exactly as they do in OSM.
const geom = (pts: Point[]) => pts.map(([x, y]) => {
  const [lat, lon] = toGeo(ORIGIN, x, y);
  return { lat, lon };
});
const way = (id: number, tags: Record<string, string>, pts: Point[]): OsmElement => ({ type: "way", id, tags, geometry: geom(pts) });
const node = (id: number, tags: Record<string, string>, p: Point): OsmElement => ({ type: "node", id, tags, lat: geom([p])[0].lat, lon: geom([p])[0].lon });
const member = (role: string, pts: Point[]): OsmMember => ({ type: "way", ref: 1, role, geometry: geom(pts) });
const build = (elements: OsmElement[], options: BuildOptions = {}) => buildAirportMap({ elements } satisfies OverpassJson, ATL, options);

const square = (x: number, y: number, size: number): Ring => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

describe("projection", () => {
  it("agrees with geo.ts", () => {
    for (const [lat, lon] of [[33.6367, -84.4281], [33.65, -84.45], [33.62, -84.40], [33.68, -84.36]]) {
      const [ax, ay] = project(ORIGIN, lat, lon);
      const [bx, by] = toLocal(ORIGIN, lat, lon);
      expect(ax).toBeCloseTo(bx, 9);
      expect(ay).toBeCloseTo(by, 9);
    }
  });

  it("puts converted points where toLocal puts the source vertices", () => {
    const lat = 33.6401;
    const lon = -84.4202;
    const out = build([{ type: "node", id: 1, lat, lon, tags: { aeroway: "windsock" } }]);
    const [x, y] = toLocal(ORIGIN, lat, lon);
    expect(out.windsocks).toEqual([[Math.round(x * 10) / 10, Math.round(y * 10) / 10]]);
  });
});

describe("the ATL sample", () => {
  const out = buildAirportMap(sample as unknown as OverpassJson, ATL, { generated: "2026-01-01" });
  const allRings = [...out.aprons, ...out.terminals, ...out.buildings].flatMap((f) => f.rings.map((ring, i) => ({ ring, outer: i === 0 })));

  it("finds the features a concourse has", () => {
    expect(out.code).toBe("atl");
    expect(out.source).toBe("OpenStreetMap contributors (ODbL)");
    expect(out.generated).toBe("2026-01-01");
    // Concourse B and its surroundings: 95 gates, 95 stand nodes plus 96 stand ways, no runways.
    expect(out.terminals).toHaveLength(3);
    expect(out.aprons).toHaveLength(4);
    expect(out.taxiways).toHaveLength(25);
    expect(out.buildings).toHaveLength(1);
    expect(out.gates).toHaveLength(95);
    expect(out.stands).toHaveLength(191);
    expect(out.runways).toHaveLength(0);
    expect(out.stands.filter((s) => s.headingDeg !== null)).toHaveLength(96);
    expect(out.terminals.some((t) => t.name === "Concourse B")).toBe(true);
  });

  it("winds outer rings counter-clockwise and holes clockwise, never repeating the first point", () => {
    expect(allRings.length).toBeGreaterThan(0);
    for (const { ring, outer } of allRings) {
      expect(ring.length).toBeGreaterThanOrEqual(3);
      expect(ring[0]).not.toEqual(ring[ring.length - 1]);
      expect(outer ? signedArea(ring) > 0 : signedArea(ring) < 0).toBe(true);
    }
  });

  it("rounds every coordinate to 0.1 m", () => {
    const pts = [...out.gates.flatMap((g) => [g.x, g.y]), ...out.taxiways.flatMap((t) => t.line.flat()), ...allRings.flatMap((r) => r.ring.flat())];
    for (const v of pts) expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-6);
  });

  it("puts gate refs and taxiway widths in the output", () => {
    expect(out.gates.every((g) => g.ref !== null)).toBe(true);
    expect(out.taxiways.every((t) => t.width > 0)).toBe(true);
  });
});

describe("multipolygons", () => {
  it("assembles an outer ring from two ways and puts the inner ring in as a hole", () => {
    const outer = square(0, 0, 100);
    const hole = square(40, 40, 20);
    const relation: OsmElement = {
      type: "relation",
      id: 9,
      tags: { type: "multipolygon", aeroway: "apron" },
      members: [
        // Two halves of the outer ring, the second one drawn backwards, the hole clockwise.
        member("outer", [outer[0], outer[1], outer[2]]),
        member("outer", [outer[0], outer[3], outer[2]]),
        member("inner", [hole[0], hole[3], hole[2], hole[1], hole[0]]),
      ],
    };
    const out = build([relation]);
    expect(out.aprons).toHaveLength(1);
    const [outerRing, holeRing, ...rest] = out.aprons[0].rings;
    expect(rest).toHaveLength(0);
    expect(signedArea(outerRing)).toBeCloseTo(10_000, 0);
    expect(signedArea(holeRing)).toBeCloseTo(-400, 0);
  });

  it("gives each outer its own polygon and sends a hole to the outer that contains it", () => {
    const a = square(0, 0, 100);
    const b = square(500, 0, 100);
    const hole = square(540, 40, 20);
    const closed = (r: Ring) => [...r, r[0]];
    const out = build([
      {
        type: "relation",
        id: 9,
        tags: { type: "multipolygon", aeroway: "terminal", name: "Split" },
        members: [member("outer", closed(a)), member("outer", closed(b)), member("inner", closed(hole))],
      },
    ]);
    expect(out.terminals.map((t) => t.rings.length).sort()).toEqual([1, 2]);
    expect(out.terminals.every((t) => t.name === "Split")).toBe(true);
  });

  it("drops a ring that never closes", () => {
    const out = build([{ type: "relation", id: 9, tags: { type: "multipolygon", aeroway: "apron" }, members: [member("outer", [[0, 0], [100, 0], [100, 100]])] }]);
    expect(out.aprons).toHaveLength(0);
  });

  it("reverses a clockwise closed way into counter-clockwise", () => {
    const cw = [[0, 0], [0, 50], [50, 50], [50, 0], [0, 0]] as Ring;
    const out = build([way(1, { aeroway: "apron" }, cw)]);
    expect(signedArea(out.aprons[0].rings[0])).toBeCloseTo(2500, 0);
  });
});

describe("runways", () => {
  const eastWest: Point[] = [[-1500, 10], [0, 10], [1500, 10]];

  it("names the western end 08L and the eastern end 26R, whichever way the way is drawn", () => {
    for (const pts of [eastWest, [...eastWest].reverse()]) {
      const [rwy] = build([way(1, { aeroway: "runway", ref: "8L/26R" }, pts)]).runways;
      expect(rwy.ref).toBe("08L/26R");
      expect(rwy.ends).toEqual([
        { ref: "08L", x: -1500, y: 10 },
        { ref: "26R", x: 1500, y: 10 },
      ]);
      expect(rwy.centerline[0]).toEqual([-1500, 10]);
    }
  });

  it("tolerates magnetic variation when picking the ends", () => {
    // Drawn along true bearing 92 degrees for runway 08/26 (magnetic 080): 08 is still the western end.
    const rad = (92 * Math.PI) / 180;
    const [rwy] = build([way(1, { aeroway: "runway", ref: "08/26" }, [[0, 0], [2000 * Math.sin(rad), 2000 * Math.cos(rad)]])]).runways;
    expect(rwy.ends[0].ref).toBe("08");
    expect(rwy.ends[0].x).toBe(0);
  });

  it("orients a north-south runway by its number", () => {
    const [rwy] = build([way(1, { aeroway: "runway", ref: "18/36" }, [[0, 1000], [0, -1000]])]).runways;
    expect(rwy.ends[0]).toEqual({ ref: "18", x: 0, y: 1000 });
    expect(rwy.ends[1]).toEqual({ ref: "36", x: 0, y: -1000 });
  });

  it("joins runway ways that share an end node", () => {
    const out = build([
      way(1, { aeroway: "runway", ref: "09L/27R", surface: "asphalt" }, [[0, 0], [1000, 0]]),
      way(2, { aeroway: "runway", ref: "09L/27R" }, [[2000, 0], [1000, 0]]),
    ]);
    expect(out.runways).toHaveLength(1);
    expect(out.runways[0].ends.map((e) => [e.ref, e.x])).toEqual([["09L", 0], ["27R", 2000]]);
  });

  it("joins runway ways whose end nodes are a few decimetres apart", () => {
    const out = build([
      way(1, { aeroway: "runway", ref: "15R/33L" }, [[0, 0], [1000, 0]]),
      way(2, { aeroway: "runway", ref: "15R/33L" }, [[1000.4, 0.3], [2000, 0]]),
    ]);
    expect(out.runways).toHaveLength(1);
    expect(out.runways[0].centerline[0][0]).toBe(0);
    expect(out.runways[0].centerline[out.runways[0].centerline.length - 1][0]).toBe(2000);
  });

  it("treats the designators in either order as one runway", () => {
    const out = build([
      way(1, { aeroway: "runway", ref: "06R/24L" }, [[0, 0], [1000, 0]]),
      way(2, { aeroway: "runway", ref: "24L/06R" }, [[1000, 0], [2000, 0]]),
    ]);
    expect(out.runways).toHaveLength(1);
    expect(out.runways[0].ref).toBe("06R/24L");
  });

  it("attaches a way with no ref to the runway it touches", () => {
    const out = build([
      way(1, { aeroway: "runway" }, [[0, 0], [100, 0]]),
      way(2, { aeroway: "runway", ref: "09/27" }, [[100, 0], [2000, 0]]),
    ]);
    expect(out.runways).toHaveLength(1);
    expect(out.runways[0].ends.map((e) => e.x)).toEqual([0, 2000]);
  });

  it("ignores a short displaced threshold mapped as a runway way", () => {
    const out = build([
      way(1, { aeroway: "runway", ref: "18/36" }, [[0, 1000], [0, -1000]]),
      way(2, { aeroway: "runway", ref: "18L/36R", runway: "displaced_threshold" }, [[0, 1000], [0, 940]]),
    ]);
    expect(out.runways.map((r) => r.ref)).toEqual(["18/36"]);
  });

  it("keeps a long runway that the mapper tagged as a displaced threshold", () => {
    const out = build([way(1, { aeroway: "runway", ref: "08L/26R", runway: "displaced_threshold" }, [[-2000, 0], [2000, 0]])]);
    expect(out.runways.map((r) => r.ref)).toEqual(["08L/26R"]);
  });

  it("drops a runway that lies outside the aerodrome boundary", () => {
    const boundary = [...square(-3000, -500, 6000), square(-3000, -500, 6000)[0]];
    const out = build([
      way(1, { aeroway: "aerodrome", icao: ATL.icao }, boundary),
      way(2, { aeroway: "runway", ref: "09/27" }, [[-1500, 0], [1500, 0]]),
      way(3, { aeroway: "runway", ref: "11/29" }, [[5000, 4000], [7000, 3000]]),
    ]);
    expect(out.runways.map((r) => r.ref)).toEqual(["09/27"]);
  });

  it("drops taxiways and aprons that belong to a neighbouring field", () => {
    const boundary = [...square(-3000, -500, 6000), square(-3000, -500, 6000)[0]];
    const out = build([
      way(1, { aeroway: "aerodrome", icao: ATL.icao }, boundary),
      way(2, { aeroway: "taxiway", ref: "A" }, [[-200, 100], [200, 100]]),
      way(3, { aeroway: "taxiway", ref: "N1" }, [[-300, -4500], [300, -4500]]),
      way(4, { aeroway: "apron" }, [...square(100, 100, 50), square(100, 100, 50)[0]]),
      way(5, { aeroway: "apron" }, [...square(100, -5000, 50), square(100, -5000, 50)[0]]),
    ]);
    expect(out.taxiways.map((t) => t.ref)).toEqual(["A"]);
    expect(out.aprons).toHaveLength(1);
  });

  it("keeps a runway with an odd ref but gives it no ends", () => {
    const [rwy] = build([way(1, { aeroway: "runway", ref: "H1" }, eastWest)]).runways;
    expect(rwy.ref).toBe("H1");
    expect(rwy.ends).toEqual([]);
  });

  it("splits designators", () => {
    expect(splitRunwayRef("8L/26R")).toEqual(["08L", "26R"]);
    expect(splitRunwayRef("10/28")).toEqual(["10", "28"]);
    expect(splitRunwayRef("H1")).toBeNull();
    expect(splitRunwayRef(undefined)).toBeNull();
  });
});

describe("defaults", () => {
  it("gives untagged widths by kind and, for runways, by length", () => {
    const out = build([
      way(1, { aeroway: "runway", ref: "09/27" }, [[0, 0], [2999, 0]]),
      way(2, { aeroway: "runway", ref: "10/28" }, [[0, 500], [3000, 500]]),
      way(3, { aeroway: "runway", ref: "18/36", width: "150 ft" }, [[0, 900], [0, -900]]),
      way(4, { aeroway: "taxiway", ref: "A" }, [[0, 0], [100, 0]]),
      way(5, { aeroway: "taxilane" }, [[0, 0], [100, 50]]),
      way(6, { aeroway: "taxiway", ref: "B", width: "30" }, [[0, 0], [100, 80]]),
    ]);
    const byRef = Object.fromEntries(out.runways.map((r) => [r.ref, r.width]));
    expect(byRef["09/27"]).toBe(DEFAULTS.runwayWidth);
    expect(byRef["10/28"]).toBe(DEFAULTS.longRunwayWidth);
    expect(byRef["18/36"]).toBe(45.7);
    expect(out.taxiways.map((t) => [t.kind, t.ref, t.width])).toEqual([
      ["taxiway", "A", 23],
      ["taxilane", null, 15],
      ["taxiway", "B", 30],
    ]);
  });

  it("gives building and terminal heights, preferring height, then levels, then the default", () => {
    const sq = (x: number) => [...square(x, 0, 30), square(x, 0, 30)[0]] as Ring;
    const out = build([
      way(1, { building: "yes" }, sq(0)),
      way(2, { building: "yes", "building:levels": "3" }, sq(100)),
      way(3, { building: "yes", "building:levels": "3", height: "30 m" }, sq(200)),
      way(4, { aeroway: "terminal", building: "yes" }, sq(300)),
      way(5, { aeroway: "terminal", name: "Tall", "building:levels": "5" }, sq(400)),
      way(6, { aeroway: "hangar" }, sq(500)),
    ]);
    expect(out.buildings.map((b) => b.height)).toEqual([8, 12, 30, 8]);
    expect(out.terminals.map((t) => [t.name, t.height])).toEqual([[null, 18], ["Tall", 20]]);
  });

  it("drops buildings below the minimum footprint but never terminals", () => {
    const sq = (size: number, x: number) => [...square(x, 0, size), square(x, 0, size)[0]] as Ring;
    const els = [way(1, { building: "yes" }, sq(4, 0)), way(2, { building: "yes" }, sq(10, 100)), way(3, { aeroway: "terminal" }, sq(4, 200))];
    expect(build(els).buildings).toHaveLength(2);
    const out = build(els, { minBuildingArea: 30 });
    expect(out.buildings).toHaveLength(1);
    expect(out.terminals).toHaveLength(1);
  });

  it("reads lengths with units", () => {
    expect(parseLength("45")).toBe(45);
    expect(parseLength("150 ft")).toBeCloseTo(45.72);
    expect(parseLength("12,5 m")).toBe(12.5);
    expect(parseLength("wide")).toBeNull();
    expect(parseLength(undefined)).toBeNull();
  });
});

describe("simplification", () => {
  it("drops collinear points and keeps a real corner", () => {
    const line: Point[] = [[0, 0], [10, 0.1], [20, -0.1], [30, 0], [30, 20]];
    expect(simplifyLine(line, 0.4)).toEqual([[0, 0], [30, 0], [30, 20]]);
  });

  it("keeps a bump bigger than the tolerance", () => {
    expect(simplifyLine([[0, 0], [10, 1], [20, 0]], 0.4)).toHaveLength(3);
  });

  it("collapses the midpoints of a square's sides", () => {
    const ring: Ring = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10], [5, 10], [0, 10], [0, 5]];
    expect(simplifyRing(ring, 0.4)).toHaveLength(4);
  });

  it("applies to converted ways", () => {
    const out = build([way(1, { aeroway: "taxiway", ref: "A" }, [[0, 0], [25, 0.05], [50, 0], [50, 40]])]);
    expect(out.taxiways[0].line).toEqual([[0, 0], [50, 0], [50, 40]]);
  });
});

describe("points and labels", () => {
  it("reads a stand's heading from its way, with the aircraft stopping at the last node", () => {
    const out = build([
      way(1, { aeroway: "parking_position", ref: "E7" }, [[0, 0], [0, 30]]),
      way(2, { aeroway: "parking_position", ref: "E8" }, [[0, 0], [30, 0]]),
      node(3, { aeroway: "parking_position", ref: "99", direction: "270" }, [5, 5]),
      node(4, { aeroway: "parking_position" }, [9, 9]),
    ]);
    expect(out.stands).toEqual([
      { ref: "E7", x: 0, y: 30, headingDeg: 0 },
      { ref: "E8", x: 30, y: 0, headingDeg: 90 },
      { ref: "99", x: 5, y: 5, headingDeg: 270 },
      { ref: null, x: 9, y: 9, headingDeg: null },
    ]);
  });

  it("collects gates, holding positions, windsocks and towers", () => {
    const out = build([
      node(1, { aeroway: "gate", ref: "B12" }, [10, 20]),
      node(2, { aeroway: "holding_position", ref: "A" }, [30, 40]),
      way(3, { aeroway: "holding_position" }, [[0, 0], [0, 20]]),
      node(4, { aeroway: "windsock" }, [50, 60]),
      way(5, { aeroway: "tower", height: "121" }, [...square(100, 100, 10), square(100, 100, 10)[0]]),
      node(6, { man_made: "tower", "tower:type": "observation" }, [7, 7]),
      node(7, { man_made: "tower", "tower:type": "lighting", aeroway: "navigationaid", navigationaid: "als" }, [8, 8]),
    ]);
    expect(out.gates).toEqual([{ ref: "B12", x: 10, y: 20 }]);
    expect(out.holdingPositions).toEqual([{ ref: "A", point: [30, 40] }, { ref: null, line: [[0, 0], [0, 20]] }]);
    expect(out.windsocks).toEqual([[50, 60]]);
    expect(out.towers).toEqual([{ x: 105, y: 105, height: 121 }, { x: 7, y: 7, height: DEFAULTS.towerHeight }]);
    expect(out.navaids).toEqual([{ kind: "als", ref: null, x: 8, y: 8 }]);
  });

  it("picks the aerodrome whose ICAO matches for the boundary", () => {
    const big = [...square(-5000, -5000, 10000), square(-5000, -5000, 10000)[0]];
    const small = [...square(-100, -100, 200), square(-100, -100, 200)[0]];
    const out = build([way(1, { aeroway: "aerodrome", icao: "KXXX" }, big), way(2, { aeroway: "aerodrome", icao: ATL.icao }, small)]);
    expect(signedArea(out.boundary[0])).toBeCloseTo(40_000, 0);
  });
});

describe("the generated airport files", () => {
  const dir = path.join(import.meta.dirname, "..", "data", "airports");
  const expectedRunways: Record<string, string[]> = {
    atl: ["08L/26R", "08R/26L", "09L/27R", "09R/27L", "10/28"],
    pit: ["10C/28C", "10L/28R", "10R/28L", "14/32"],
    jfk: ["04L/22R", "04R/22L", "13L/31R", "13R/31L"],
  };

  for (const airport of AIRPORTS) {
    it(`${airport.code} has its runways, taxiways, aprons and terminals, sane winding and fits the size budget`, () => {
      const file = path.join(dir, `${airport.code}.json`);
      expect(fs.statSync(file).size).toBeLessThan(1.5 * 1024 * 1024);
      const map = JSON.parse(fs.readFileSync(file, "utf8")) as AirportMap;
      expect(map.code).toBe(airport.code);
      expect(map.origin).toEqual({ latitude: airport.latitude, longitude: airport.longitude });
      const known = expectedRunways[airport.code];
      if (known) expect(map.runways.map((r) => r.ref).sort()).toEqual(known);
      else expect(map.runways.length).toBeGreaterThan(0);
      // Every runway has a designator pair at each end and no ref appears twice (a runway split in pieces would).
      expect(new Set(map.runways.map((r) => r.ref)).size).toBe(map.runways.length);
      for (const r of map.runways) {
        expect(r.ends).toHaveLength(2);
        expect(Math.hypot(r.ends[1].x - r.ends[0].x, r.ends[1].y - r.ends[0].y)).toBeGreaterThan(known ? 1500 : 500);
      }
      for (const layer of [map.taxiways, map.aprons, map.terminals]) expect(layer.length).toBeGreaterThan(0);
      for (const f of [...map.aprons, ...map.terminals, ...map.buildings]) {
        f.rings.forEach((ring, i) => expect(i === 0 ? signedArea(ring) > 0 : signedArea(ring) < 0).toBe(true));
      }
      expect(signedArea(map.boundary[0])).toBeGreaterThan(1_000_000);
      expect(map.gates.length).toBeGreaterThan(0);
      if (known) expect(map.towers.length).toBeGreaterThan(0);
    });
  }
});
