import { type LayerSpecification, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { describe, expect, it } from "vitest";
import { THEMES, type ThemeKey } from "../scene/theme";
import { arcOpacities, buildingHeight, enRouteHaze, enRouteSky, flatSky, HAZE_SHELLS, hazeShells, hazeStrength, HILLSHADE, HILLSHADE_UNDER, hillshadeLayer, horizonM, IMAGERY_NEAR_ZOOM, imageryTileZoom, journeyIconSize, mapBackground, mapStyle, PALETTES, radarLayer, radarSource, RELIEF_CRUISE_ZOOM, RELIEF_LOW_ZOOM, reliefStrength, ripple, SELECTED_SCALE, SELECTION_DIM, TERRAIN, TERRAIN_SOURCE, terrainSource } from "./map-style";

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

describe("the en-route view's terrain", () => {
  it("is not in the style unless a 3D camera asks for it: the flat map never loads it", () => {
    for (const key of ["light", "dark", "satellite"] as ThemeKey[]) {
      const style = mapStyle(key);
      expect(Object.values(style.sources).some((s) => s.type === "raster-dem")).toBe(false);
      expect(style.terrain).toBeUndefined();
    }
  });

  it("is AWS Terrain Tiles, Terrarium encoded, no key, 256 px tiles to zoom 15, credited with a link to the data's own attribution", () => {
    const source = terrainSource();
    expect(source).toMatchObject({ type: "raster-dem", tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"], encoding: "terrarium", tileSize: 256, maxzoom: 15 });
    expect(source.attribution).toContain("https://github.com/tilezen/joerd/blob/master/docs/attribution.md");
    expect(source.attribution).toMatch(/Terrain Tiles/);
  });

  it("goes into the style with the terrain on it when asked (so a theme switch keeps it), and the style is valid", () => {
    const style = mapStyle("dark", { terrain: true });
    expect(style.sources[TERRAIN_SOURCE]).toEqual(terrainSource());
    expect(style.terrain).toEqual(TERRAIN);
    expect(validateStyleMin(style)).toEqual([]);
  });

  it.each(KEYS)("in %s, the flat map keeps its own sky (the page colour all round) and has no hillshade", (key) => {
    const style = mapStyle(key);
    const page = THEMES[key].background;
    expect(style.sky).toEqual({ "sky-color": page, "horizon-color": page, "fog-color": page, "sky-horizon-blend": 0.5, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.6, "atmosphere-blend": 0 });
    expect(style.sky).toEqual(flatSky(key));
    expect(style.layers.some((l) => l.type === "hillshade")).toBe(false);
  });

  it.each(KEYS)("in %s, a 3D camera's style shades the terrain's relief, under the water, roads and everything else drawn, from the same Terrarium source", (key) => {
    const style = mapStyle(key, { terrain: true });
    const shaded = style.layers.filter((l) => l.type === "hillshade");
    expect(shaded).toEqual([hillshadeLayer(key)]);
    expect(shaded[0]).toMatchObject({ id: HILLSHADE, source: TERRAIN_SOURCE });
    // Right under the layer the controller adds it under, so the style and a 3D camera turned on agree.
    expect(style.layers.findIndex((l) => l.id === HILLSHADE)).toBe(style.layers.findIndex((l) => l.id === HILLSHADE_UNDER) - 1);
    // Nothing else changes: the same layers as the flat map, the hillshade and the background's colour aside.
    const flatBackground = (l: LayerSpecification) => (l.id === "background" ? { ...l, paint: { "background-color": mapBackground(key) } } : l);
    expect(style.layers.filter((l) => l.id !== HILLSHADE).map(flatBackground)).toEqual(mapStyle(key).layers);
    expect(validateStyleMin(style)).toEqual([]);
  });

  it.each(KEYS)("in %s, a 3D camera's sky is the Diorama's own air (its zenith over its horizon), so there is a horizon and the sky is not the ground", (key) => {
    const sky = mapStyle(key, { terrain: true }).sky!;
    const air = THEMES[key].eyeLevel;
    expect(sky).toEqual(enRouteSky(key));
    expect(sky["sky-color"]).toBe(air.zenith);
    expect(sky["horizon-color"]).toBe(air.horizon);
    // The haze the far ground fades into is the horizon's own colour, so ground, haze and sky meet without a line.
    expect(sky["fog-color"]).toBe(air.horizon);
    expect(enRouteHaze(key)).toBe(air.horizon);
    // The sky reads apart from the ground under it (the map's background) and from the horizon.
    const ground = paint(key, "background", "background-color");
    expect(sky["sky-color"]).not.toBe(ground);
    expect(sky["sky-color"]).not.toBe(sky["horizon-color"]);
  });

  it.each(KEYS)("in %s, a 3D camera's sky grades from the horizon's haze to the zenith over most of the sky, not in a thin line over a flat fill", (key) => {
    expect(enRouteSky(key)["sky-horizon-blend"]).toBeGreaterThanOrEqual(0.8);
    expect(enRouteSky(key)["sky-horizon-blend"]).toBeLessThanOrEqual(1);
  });

  it.each(KEYS)("in %s, a 3D camera's background is the sky's haze, so the ground past the farthest tile drawn reads as the horizon's haze, not bare land", (key) => {
    const background = (style: ReturnType<typeof mapStyle>) => (style.layers.find((l) => l.id === "background") as { paint: Record<string, unknown> }).paint["background-color"];
    expect(mapBackground(key, true)).toBe(enRouteSky(key)["fog-color"]);
    expect(mapBackground(key, true)).toBe(enRouteHaze(key));
    expect(background(mapStyle(key, { terrain: true }))).toBe(mapBackground(key, true));
    // The flat map keeps its own: the land's colour, or under the imagery the page's.
    expect(background(mapStyle(key))).toBe(mapBackground(key));
    expect(mapBackground(key)).toBe(key === "satellite" ? THEMES[key].background : THEMES[key].surfaces.ground);
  });

  it("shades the relief subtly by day and more strongly by night, in colours named for each theme", () => {
    for (const zoom of [RELIEF_CRUISE_ZOOM, RELIEF_LOW_ZOOM]) expect(reliefStrength("dark", zoom)).toBeGreaterThan(reliefStrength("light", zoom));
    for (const key of KEYS) {
      const p = (hillshadeLayer(key) as { paint: Record<string, unknown> }).paint;
      expect(p["hillshade-shadow-color"]).toBe(PALETTES[key].reliefShadow);
      expect(p["hillshade-highlight-color"]).toBe(PALETTES[key].reliefLight);
      expect(p["hillshade-exaggeration"]).toEqual(["interpolate", ["linear"], ["zoom"], RELIEF_CRUISE_ZOOM, reliefStrength(key, RELIEF_CRUISE_ZOOM), RELIEF_LOW_ZOOM, reliefStrength(key, RELIEF_LOW_ZOOM)]);
    }
  });

  it("shades as before at 11,000 ft and harder from cruise heights, where the map's zoom is lower and its terrain smoother; Satellite as it is", () => {
    // The en-route map's zoom is the eye's height over the ground's (sightPlacement): about 15.2 to 15.6 at 11,000 ft, 13.3 to 13.7 at FL400.
    for (const key of ["light", "dark"] as const) {
      expect(reliefStrength(key, 15.2), key).toBe(PALETTES[key].reliefStrength);
      expect(reliefStrength(key, 20), key).toBe(PALETTES[key].reliefStrength);
      expect(reliefStrength(key, 13.6), key).toBeGreaterThan(PALETTES[key].reliefStrength + 0.15);
      expect(reliefStrength(key, 12), key).toBe(PALETTES[key].reliefCruiseStrength);
      expect(PALETTES[key].reliefCruiseStrength, key).toBeLessThanOrEqual(1);
      expect(reliefStrength(key, 14)).toBeGreaterThan(reliefStrength(key, 14.5));
    }
    for (const zoom of [10, 13.6, 15.4, 18]) expect(reliefStrength("satellite", zoom)).toBe(PALETTES.satellite.reliefStrength);
  });
});

describe("hazeStrength", () => {
  it("is the haze in full on a look near level (Cockpit, Side) and none at Chase's 75 degrees or steeper (Chase and Top as they were)", () => {
    expect(hazeStrength(90)).toBe(1);
    expect(hazeStrength(110)).toBe(1);
    expect(hazeStrength(85)).toBe(1);
    expect(hazeStrength(75)).toBe(0);
    expect(hazeStrength(0)).toBe(0);
    expect(hazeStrength(80)).toBeGreaterThan(0);
    expect(hazeStrength(80)).toBeLessThan(1);
  });
});

describe("hazeShells", () => {
  const FL110 = 11_000 * 0.3048;
  const FL370 = 37_000 * 0.3048;
  const horizon = (aboveM: number) => Math.sqrt(2 * 6_371_000 * aboveM + aboveM * aboveM);
  const opacity = (shells: { opacity: number }[]) => shells.at(-1)!.opacity;
  /** The flat themes' haze (their floor in the eye's heights, PALETTES' hazeFloorHeights). */
  const flat = (aboveM: number, farM?: number) => hazeShells(aboveM, PALETTES.dark.hazeFloorHeights, farM);

  it("draws nothing for an eye at or under the ground", () => {
    expect(flat(0)).toEqual([]);
    expect(flat(-50)).toEqual([]);
    expect(flat(Number.NaN)).toEqual([]);
  });

  it("builds the haze in HAZE_SHELLS shells, ever farther out, to full haze at the horizon", () => {
    const shells = flat(FL110);
    expect(shells).toHaveLength(HAZE_SHELLS);
    for (let i = 1; i < shells.length; i++) expect(shells[i].distanceM).toBeGreaterThan(shells[i - 1].distanceM);
    for (const s of shells) {
      expect(s.opacity).toBeGreaterThan(0);
      expect(s.opacity).toBeLessThanOrEqual(1);
    }
    expect(shells.at(-1)!.distanceM).toBeCloseTo(horizon(FL110), -2);
    expect(opacity(shells)).toBe(1);
  });

  it("thickens in equal steps, so no shell's edge on the ground stands out from the others", () => {
    const shells = flat(FL110);
    shells.forEach((s, i) => expect(s.opacity).toBeCloseTo((i + 1) / shells.length, 9));
    expect(1 / HAZE_SHELLS).toBeLessThanOrEqual(0.05);
  });

  it("leaves the near ground clear: at 11,000 ft it starts past Chase's 13 km and the Cockpit's nearer relief", () => {
    expect(flat(FL110)[0].distanceM).toBeGreaterThan(13_000);
    // Quickly at first, as air does: half the haze well inside half the way to the horizon.
    const shells = flat(FL110);
    expect(shells[shells.length / 2 - 1].distanceM).toBeLessThan(horizon(FL110) / 2);
  });

  it("starts as far below the horizon from cruise heights as at 11,000 ft, so the ground under the look reads from FL400 too", () => {
    // At 11,000 ft (3 km over the ground) it starts 4.8 heights out or more, as it did: under a look 11 degrees down, clear.
    // So it is as it was for an eye up to 11,600 ft over the ground (Chase's stands a little over the aircraft).
    const fl110 = 11_000 * 0.3048 - 300;
    for (const above of [11_000 * 0.3048, 11_000 * 0.3048 - 300, 11_000 * 0.3048 - 1_500, 11_600 * 0.3048]) {
      const start = 0.08 * horizon(above);
      expect(flat(above)[0].distanceM, `${above} m over the ground`).toBeCloseTo(start + (horizon(above) - start) * (1 / HAZE_SHELLS) ** (1 / 0.7), 6);
    }
    for (const feet of [25_000, 40_000, 47_000, 51_000]) {
      const above = feet * 0.3048 - 300;
      const start = flat(above)[0].distanceM;
      // The look's angle below level where the haze starts: no shallower than at 11,000 ft.
      expect(Math.atan2(above, start), `${feet} ft`).toBeGreaterThanOrEqual(Math.atan2(fl110, flat(fl110)[0].distanceM) - 0.01);
      expect(flat(above).at(-1)!.distanceM).toBeCloseTo(horizon(above), 6);
    }
  });

  it("floors the start in Light and Dark only: Satellite's haze is as it was at every height", () => {
    expect(PALETTES.light.hazeFloorHeights).toBeGreaterThan(0);
    expect(PALETTES.dark.hazeFloorHeights).toBe(PALETTES.light.hazeFloorHeights);
    expect(PALETTES.satellite.hazeFloorHeights).toBe(0);
    for (const feet of [11_000, 40_000, 47_000]) {
      const above = feet * 0.3048 - 300;
      const start = 0.08 * horizon(above);
      expect(hazeShells(above, PALETTES.satellite.hazeFloorHeights)[0].distanceM).toBeCloseTo(start + (horizon(above) - start) * (1 / HAZE_SHELLS) ** (1 / 0.7), 6);
    }
  });

  it("reaches farther from higher up, with the horizon", () => {
    expect(flat(FL370).at(-1)!.distanceM).toBeGreaterThan(flat(FL110).at(-1)!.distanceM * 1.5);
    expect(flat(FL370)[0].distanceM).toBeGreaterThan(flat(FL110)[0].distanceM);
  });

  it("ends inside the map's far plane, where the ground drawn ends, when that comes before the horizon", () => {
    const far = 40_000;
    const shells = flat(FL110, far);
    expect(shells.at(-1)!.distanceM).toBeLessThan(far);
    expect(shells.at(-1)!.distanceM).toBeGreaterThan(far * 0.9);
    expect(opacity(shells)).toBe(1);
  });
});

describe("horizonM", () => {
  it("is the distance to the horizon over a round Earth, where the haze is full", () => {
    expect(horizonM(11_000 * 0.3048)).toBeCloseTo(206_700, -3);
    expect(horizonM(37_000 * 0.3048)).toBeCloseTo(379_100, -3);
    expect(hazeShells(11_000 * 0.3048, PALETTES.dark.hazeFloorHeights).at(-1)!.distanceM).toBeCloseTo(horizonM(11_000 * 0.3048), 6);
    expect(horizonM(0)).toBe(0);
    expect(horizonM(Number.NaN)).toBe(0);
  });
});

describe("imageryTileZoom", () => {
  // MapLibre's distances are in Mercator units (the world is 1 across); at the equator one is 40,075 km of ground.
  const reach = { metres: 200_000, metresPerUnit: 40_075_016 };
  const km = (k: number) => (k * 1000) / reach.metresPerUnit;
  const base = (z: number) => () => z;

  it("keeps the imagery at its own large-scale product (zoom 9 or more) out to the reach, where the haze is full", () => {
    expect(IMAGERY_NEAR_ZOOM).toBe(9);
    // The olive small-scale product MapLibre would take 40 km out, and 190 km out, is the large-scale one.
    expect(imageryTileZoom(base(8), reach)(15, km(40), km(3), km(4), 37)).toBe(9);
    expect(imageryTileZoom(base(6), reach)(15, km(190), km(3), km(4), 37)).toBe(9);
  });

  it("leaves past the reach, nearer tiles already finer, and a map zoomed out past zoom 9 as MapLibre has them", () => {
    expect(imageryTileZoom(base(6), reach)(15, km(210), km(3), km(4), 37)).toBe(6);
    expect(imageryTileZoom(base(13), reach)(15, km(5), km(3), km(4), 37)).toBe(13);
    expect(imageryTileZoom(base(7), reach)(8, km(5), km(3), km(4), 37)).toBe(7);
  });

  it("reads the reach as it is now, so the camera can move it every frame", () => {
    const moving = { ...reach };
    const zoom = imageryTileZoom(base(6), moving);
    expect(zoom(15, km(150), km(3), km(4), 37)).toBe(9);
    moving.metres = 100_000;
    expect(zoom(15, km(150), km(3), km(4), 37)).toBe(6);
  });
});
