import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { THEMES, type ThemeKey } from "../scene/theme";
import { arcOpacities, buildingHeight, journeyIconSize, mapStyle, PALETTES, radarLayer, radarSource, ripple, SELECTED_SCALE, SELECTION_DIM } from "./map-style";

const KEYS = Object.keys(THEMES) as ThemeKey[];
const paint = (key: ThemeKey, id: string, prop: string) => {
  const layer = mapStyle(key).layers.find((l) => l.id === id) as { paint?: Record<string, unknown> } | undefined;
  return layer?.paint?.[prop];
};

describe("mapStyle", () => {
  it.each(KEYS)("is a valid MapLibre style in %s", (key) => {
    expect(validateStyleMin(mapStyle(key))).toEqual([]);
  });

  it.each(KEYS)("lays the land and the runways in the diorama's own colours in %s, so the diorama fades in over them without a seam", (key) => {
    const theme = THEMES[key];
    expect(paint(key, "background", "background-color")).toBe(key === "satellite" ? theme.background : theme.surfaces.ground);
    expect(paint(key, "aeroway-runway", "fill-color")).toBe(theme.surfaces.runway);
    expect(paint(key, "aeroway-apron", "fill-color")).toBe(theme.surfaces.apron);
    expect(mapStyle(key).sky?.["horizon-color"]).toBe(theme.background);
  });

  it("changes only how things look between themes, never what is drawn", () => {
    const shape = (key: ThemeKey) => mapStyle(key).layers.filter((l) => l.id !== "imagery").map((l) => ({ id: l.id, type: l.type, filter: "filter" in l ? l.filter : null, source: "source" in l ? l.source : null }));
    expect(shape("dark")).toEqual(shape("light"));
    expect(shape("satellite")).toEqual(shape("light"));
  });

  it("credits the map data, and in satellite the imagery", () => {
    const light = mapStyle("light");
    expect(light.sources.openfreemap).toMatchObject({ type: "vector", url: "https://tiles.openfreemap.org/planet" });
    expect(light.sources.imagery).toBeUndefined();
    const imagery = mapStyle("satellite").sources.imagery as { type: string; tiles: string[]; attribution: string };
    expect(imagery.type).toBe("raster");
    expect(imagery.tiles[0]).toMatch(/^https:\/\/basemap\.nationalmap\.gov\//);
    expect(imagery.attribution).toMatch(/USGS/);
  });

  it("is flat Web Mercator by region zoom, which the camera conversion assumes, and a globe at world zoom only when asked", () => {
    for (const key of KEYS) expect(mapStyle(key).projection).toEqual({ type: "mercator" });
    const globe = mapStyle("dark", { globe: true }).projection?.type as unknown[];
    expect(globe.slice(-2)).toEqual([6, "mercator"]);
    expect(validateStyleMin(mapStyle("dark", { globe: true }))).toEqual([]);
  });

  it("starts the app's own layers empty, for the map to fill", () => {
    for (const id of ["airports", "aircraft"]) expect(mapStyle("light").sources[id]).toMatchObject({ type: "geojson", data: { type: "FeatureCollection", features: [] } });
  });
});

describe("the live layers", () => {
  it.each(KEYS)("colours aircraft by what they are doing, in the legend's own colours in %s", (key) => {
    const color = paint(key, "aircraft", "icon-color") as unknown[];
    expect(color).toEqual(expect.arrayContaining(["arriving", THEMES[key].aircraft.arriving, "departing", THEMES[key].aircraft.departing, "ground", THEMES[key].aircraft.parked]));
  });

  it("beats a ripple out from each airport that fades as it grows", () => {
    expect(ripple(0).opacity).toBeGreaterThan(ripple(0.5).opacity);
    expect(ripple(1).opacity).toBe(0);
    expect(ripple(1).radius).toEqual(["*", expect.anything(), 2.8]);
  });

  it("fades the ripple with the map as the diorama covers it, never past what MapLibre accepts", () => {
    expect(ripple(0, 0.5).opacity).toBeCloseTo(0.275, 6);
    expect(ripple(0, 0).opacity).toBe(0);
    // Before the page has said how much of the map shows (the map's -1 for "not yet"), the map is all there is.
    expect(ripple(0, 2).opacity).toBe(0.55);
  });

  it("raises the city's buildings with the diorama's, at the diorama's height scale", () => {
    expect(buildingHeight(0)).toEqual(["*", ["coalesce", ["get", "render_height"], 8], 0]);
    expect(buildingHeight(1)).toEqual(["*", ["coalesce", ["get", "render_height"], 8], 2.4]);
  });
});

describe("the followed flight", () => {
  it.each(KEYS)("is drawn over the rest of the traffic in %s: the way flown solid, the way left dashed, the aircraft in the airports' marker colour", (key) => {
    const ids = mapStyle(key).layers.map((l) => l.id);
    expect(ids.indexOf("journey-flown")).toBeGreaterThan(ids.indexOf("aircraft"));
    expect(ids.indexOf("journey-aircraft")).toBeGreaterThan(ids.indexOf("journey-flown"));
    expect(paint(key, "journey-left", "line-dasharray")).toBeDefined();
    expect(paint(key, "journey-flown", "line-dasharray")).toBeUndefined();
    expect(paint(key, "journey-aircraft", "icon-color")).toBe(PALETTES[key].dot);
    expect(mapStyle(key).sources.journey).toMatchObject({ type: "geojson", data: { type: "FeatureCollection", features: [] } });
  });
});

describe("the followed flight's published procedures", () => {
  it.each(KEYS)("are drawn in %s solid, in the diorama's arriving colour for an approach and departing for a climb-out, under the aircraft and over the dashed estimate", (key) => {
    const ids = mapStyle(key).layers.map((l) => l.id);
    expect(ids.indexOf("journey-procedure")).toBeGreaterThan(ids.indexOf("journey-left"));
    expect(ids.indexOf("journey-procedure")).toBeGreaterThan(ids.indexOf("journey-procedure-casing"));
    expect(ids.indexOf("journey-aircraft")).toBeGreaterThan(ids.indexOf("journey-procedure"));
    expect(paint(key, "journey-procedure", "line-dasharray")).toBeUndefined();
    expect(paint(key, "journey-procedure", "line-color")).toEqual(["match", ["get", "part"], "approach", THEMES[key].aircraft.arriving, THEMES[key].aircraft.departing]);
  });
});

describe("the selected flight", () => {
  it.each(KEYS)("is drawn over the traffic and the followed flight's lanes in %s: the track solid, the way back faint, the way on dashed, a ring round the aircraft", (key) => {
    const ids = mapStyle(key).layers.map((l) => l.id);
    for (const id of ["selected-casing", "selected-from", "selected-ahead", "selected-observed", "selected-ring", "selected-aircraft"]) expect(ids.indexOf(id)).toBeGreaterThan(ids.indexOf("aircraft"));
    expect(ids.indexOf("selected-observed")).toBeGreaterThan(ids.indexOf("selected-casing"));
    expect(ids.indexOf("selected-aircraft")).toBeGreaterThan(ids.indexOf("selected-observed"));
    expect(paint(key, "selected-ahead", "line-dasharray")).toBeDefined();
    expect(paint(key, "selected-observed", "line-dasharray")).toBeUndefined();
    expect(paint(key, "selected-from", "line-dasharray")).toBeUndefined();
    expect(paint(key, "selected-from", "line-opacity")).toBeLessThan(0.5);
    expect(paint(key, "selected-observed", "line-color")).toBe(PALETTES[key].selected);
    expect(paint(key, "selected-aircraft", "icon-color")).toBe(PALETTES[key].selected);
    expect(mapStyle(key).sources.selected).toMatchObject({ type: "geojson", data: { type: "FeatureCollection", features: [] } });
  });

  it.each(KEYS)("draws the aircraft at 1.5 times the traffic's size, filled in the selection colour, in %s", (key) => {
    const size = (id: string) => (mapStyle(key).layers.find((l) => l.id === id) as { layout: Record<string, unknown> }).layout["icon-size"] as unknown[];
    expect(SELECTED_SCALE).toBe(1.5);
    // The same table at every zoom, each row 1.5 times the traffic's.
    const rows = (s: unknown[]) => [s[4], s[6], s[8]].map((r) => (r as unknown[])[1]);
    expect(rows(size("selected-aircraft"))).toEqual(rows(size("aircraft")).map((k) => (k as number) * 1.5));
    expect(paint(key, "selected-aircraft", "icon-halo-color")).toBe(PALETTES[key].selected);
  });

  it.each(KEYS)("draws the diorama's approach or climb-out as the selected path when it is the selected flight's, and as before otherwise, in %s", (key) => {
    const layers = mapStyle(key).layers as { id: string; filter?: unknown; paint?: Record<string, unknown> }[];
    const ids = layers.map((l) => l.id);
    expect(layers.find((l) => l.id === "procedure")!.filter).toEqual(["!=", ["get", "own"], true]);
    expect(layers.find((l) => l.id === "procedure-selected")!.filter).toEqual(["==", ["get", "own"], true]);
    expect(paint(key, "procedure-selected", "line-color")).toBe(PALETTES[key].selected);
    expect(ids.indexOf("procedure-selected-casing")).toBeLessThan(ids.indexOf("procedure-selected"));
    expect(ids.indexOf("procedure-selected")).toBeGreaterThan(ids.indexOf("aircraft"));
  });

  it.each(KEYS)("rings the aircraft under the pointer faintly, and fades a lost one in %s", (key) => {
    expect(mapStyle(key).sources.hover).toMatchObject({ type: "geojson" });
    expect(paint(key, "hover-ring", "circle-stroke-opacity")).toBeLessThan(0.8);
    expect(JSON.stringify(paint(key, "selected-ring", "circle-stroke-opacity"))).toContain("lost");
    expect(JSON.stringify(paint(key, "selected-aircraft", "icon-opacity"))).toContain("lost");
  });

  it("is a colour no route arc or kind of traffic uses, in every theme", () => {
    for (const key of KEYS) {
      const taken = [PALETTES[key].arc, PALETTES[key].cruise, PALETTES[key].dot, ...Object.values(THEMES[key].aircraft)].map((c) => c.toLowerCase());
      expect(taken).not.toContain(PALETTES[key].selected.toLowerCase());
    }
  });

  it("stands the route arcs back while a flight is selected, and leaves them as they were with none", () => {
    for (const key of KEYS) {
      const base = arcOpacities(key);
      const dim = arcOpacities(key, SELECTION_DIM.arcs);
      expect(base).toEqual({ glow: PALETTES[key].arcGlow, line: PALETTES[key].arcOpacity * 0.6, flow: PALETTES[key].arcOpacity });
      expect(dim.flow).toBeCloseTo(base.flow * SELECTION_DIM.arcs, 9);
      expect(paint(key, "arcs-flow", "line-opacity")).toBe(base.flow);
    }
  });
});

describe("the followed flight's icon size", () => {
  it("is the same table the map's layer interpolates, so a beacon drawn over the diorama matches the map's", () => {
    expect(journeyIconSize(5)).toBe(0.85);
    expect(journeyIconSize(11.5)).toBeCloseTo(1.325, 6);
    expect(journeyIconSize(20)).toBe(1.5);
    expect(journeyIconSize(2)).toBe(0.85);
    const layer = mapStyle("light").layers.find((l) => l.id === "journey-aircraft") as { layout: Record<string, unknown> };
    expect(layer.layout["icon-size"]).toEqual(["interpolate", ["linear"], ["zoom"], 5, 0.85, 10, 1.15, 13, 1.5]);
  });
});

describe("the weather radar layer", () => {
  const TILES = "https://tilecache.rainviewer.com/v2/radar/20ca960629a8/256/{z}/{x}/{y}/2/1_0.png";

  it.each(KEYS)("is absent until asked for, and is the same valid style with it in %s", (key) => {
    expect(mapStyle(key).layers.some((l) => l.id === "radar")).toBe(false);
    expect(mapStyle(key).sources.radar).toBeUndefined();
    const style = mapStyle(key, { radar: TILES });
    expect(style.sources.radar).toEqual(radarSource(TILES));
    expect(validateStyleMin(style)).toEqual([]);
  });

  it.each(KEYS)("lies over the land and borders but under the names, routes and aircraft in %s", (key) => {
    const ids = mapStyle(key, { radar: TILES }).layers.map((l) => l.id);
    expect(ids.indexOf("radar")).toBeGreaterThan(ids.indexOf("boundary-country"));
    expect(ids.indexOf("radar")).toBeLessThan(ids.indexOf("places-country"));
    expect(ids.indexOf("radar")).toBeLessThan(ids.indexOf("arcs"));
    expect(ids.indexOf("radar")).toBeLessThan(ids.indexOf("aircraft"));
  });

  it("is RainViewer's tiles to zoom 7 with their credit, stretched beyond", () => {
    expect(radarSource(TILES)).toMatchObject({ type: "raster", tiles: [TILES], tileSize: 256, maxzoom: 7 });
    expect((radarSource(TILES) as { attribution: string }).attribution).toMatch(/rainviewer\.com.*RainViewer/);
  });

  it("is see-through enough to read the map under it, more so over the satellite imagery", () => {
    const opacity = (key: ThemeKey) => (radarLayer(key).paint as { "raster-opacity": number })["raster-opacity"];
    for (const key of KEYS) {
      expect(opacity(key)).toBeGreaterThan(0.3);
      expect(opacity(key)).toBeLessThan(1);
    }
    expect(opacity("satellite")).toBeLessThan(opacity("dark"));
  });
});

describe("the selected flight's approach or climb-out", () => {
  it.each(KEYS)("is drawn in %s under the aircraft, in the diorama's state colours, as faint as each piece says", (key) => {
    const ids = mapStyle(key).layers.map((l) => l.id);
    expect(ids.indexOf("procedure")).toBeGreaterThan(-1);
    expect(ids.indexOf("procedure")).toBeLessThan(ids.indexOf("aircraft"));
    expect(paint(key, "procedure", "line-opacity")).toEqual(["get", "fade"]);
    const color = JSON.stringify(paint(key, "procedure", "line-color"));
    for (const state of ["arriving", "departing", "taxiing"] as const) expect(color).toContain(THEMES[key].aircraft[state]);
    expect(mapStyle(key).sources.procedure).toMatchObject({ type: "geojson", data: { type: "FeatureCollection", features: [] } });
  });
});

describe("the shores of lakes and seas", () => {
  it.each(KEYS)("are the water fill's own outline in %s, never a line layer over the water polygons", (key) => {
    const layers = mapStyle(key).layers;
    // A lake's outline is one ring of thousands of points; a line bucket asks for ten vertices a point and passes the 65,535 a segment holds ("Max vertices per segment is 65535").
    expect(layers.filter((l) => l.type === "line" && "source-layer" in l && l["source-layer"] === "water")).toEqual([]);
    expect(paint(key, "water", "fill-outline-color")).toBe(PALETTES[key].shore);
  });

  it("still draws on the aerial view, where the fill is clear rather than faded out (fill-opacity would take the outline with it)", () => {
    expect(paint("satellite", "water", "fill-opacity")).toBeUndefined();
    expect(paint("satellite", "water", "fill-color")).toBe("rgba(0,0,0,0)");
  });
});
