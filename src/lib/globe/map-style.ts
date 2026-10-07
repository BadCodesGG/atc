import type { DataDrivenPropertyValueSpecification, ExpressionSpecification, FilterSpecification, LayerSpecification, SourceSpecification, StyleSpecification } from "@maplibre/maplibre-gl-style-spec";
import { RADAR_CREDIT, RADAR_MAX_ZOOM } from "../radar";
import { MODEL, THEMES, type ThemeKey } from "../scene/theme";
import { BEACON_RADIUS_PX } from "./aircraft-glyph";

/**
 * The world map's style in each theme. The map is drawn as the diorama is, in the same colours: the
 * land is the diorama's ground and the airports' pavement is its pavement, so when the diorama fades in
 * over the map only the airport itself appears to change. As with the scene, a theme changes colours
 * and nothing else: every theme draws the same layers from the same data (satellite adds the imagery
 * under them).
 *
 * Vector tiles from OpenFreeMap (OpenMapTiles schema, OpenStreetMap data; free, no key, attribution
 * required). The satellite theme lays USGS National Map imagery under them (public domain, US only).
 */

const OPENFREEMAP = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const USGS_IMAGERY = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}";
const REGULAR = ["Noto Sans Regular"];
const BOLD = ["Noto Sans Bold"];

/** The colours the map needs beyond the scene's own: from the page's tokens in globals.css. */
export interface MapPalette {
  water: string;
  /** The coastline and lake shores. */
  shore: string;
  boundary: string;
  stateLine: string;
  road: string;
  majorRoad: string;
  label: string;
  halo: string;
  /** Warm points where the cities are, by night only (transparent otherwise). */
  cityLight: string;
  cityLightOpacity: number;
  /** An aircraft passing over, neither arriving nor departing at a built airport. */
  cruise: string;
  /** The route arcs, and how strongly they show and glow. */
  arc: string;
  arcOpacity: number;
  arcGlow: number;
  /** The selected aircraft and its path: a colour nothing else on the map uses, so it reads over the arcs and the traffic. */
  selected: string;
  /** The airport marker: the dot and its ripple, and the chip that names it. */
  dot: string;
  chip: string;
  chipRing: string;
  chipText: string;
  chipCount: string;
}

export const PALETTES: Record<ThemeKey, MapPalette> = {
  // The diorama's paper, warmed: a stone-grey sea, sand-coloured roads and borders.
  light: {
    water: "#dcdfdc",
    shore: "#c9ccc6",
    boundary: "#cfc6b5",
    stateLine: "#ddd6c8",
    road: "#ebe5d8",
    majorRoad: "#e2dac8",
    label: "#7a7468",
    halo: "#f4f3ef",
    cityLight: "#f4f3ef",
    cityLightOpacity: 0,
    cruise: "#6b6e75",
    arc: "#3b3e45",
    arcOpacity: 0.32,
    arcGlow: 0,
    selected: "#6d28d9",
    dot: "#1d1f24",
    chip: "#ffffff",
    chipRing: "#e6e3dc",
    chipText: "#1d1f24",
    chipCount: "#5d6068",
  },
  // Night ops: the land the diorama's black, a deep navy sea, faint shores and borders, the cities lit.
  dark: {
    water: "#0a1730",
    shore: "#1a3150",
    boundary: "#1d3150",
    stateLine: "#132339",
    road: "#0d1726",
    majorRoad: "#132136",
    label: "#5f7390",
    halo: "#060a10",
    cityLight: "#ffb347",
    cityLightOpacity: 0.28,
    cruise: "#9fb3cc",
    arc: "#5cb8ff",
    arcOpacity: 0.55,
    arcGlow: 0.35,
    selected: "#ffe14a",
    dot: "#6ff0a6",
    chip: "#0a121d",
    chipRing: "#1e2d45",
    chipText: "#f2f6fb",
    chipCount: "#6ff0a6",
  },
  satellite: {
    water: "#2c4a63",
    shore: "rgba(255,255,255,0.25)",
    boundary: "rgba(255,255,255,0.55)",
    stateLine: "rgba(255,255,255,0.35)",
    road: "rgba(255,255,255,0.18)",
    majorRoad: "rgba(255,255,255,0.32)",
    label: "#ffffff",
    halo: "rgba(0,0,0,0.55)",
    cityLight: "#ffffff",
    cityLightOpacity: 0,
    cruise: "#ffffff",
    arc: "#ffffff",
    arcOpacity: 0.6,
    arcGlow: 0.15,
    selected: "#ffe14a",
    dot: "#ffffff",
    chip: "#ffffff",
    chipRing: "rgba(0,0,0,0.12)",
    chipText: "#16181c",
    chipCount: "#4a4e55",
  },
};

/** The followed flight's icon size by zoom ([zoom, size] rows): the map's layer and the diorama's beacon draw it from the same table. */
const JOURNEY_ICON: [number, number][] = [
  [5, 0.85],
  [10, 1.15],
  [13, 1.5],
];

/** The followed flight's icon size at `zoom`, as the map's layer interpolates it: linear between the rows, held past either end. */
export function journeyIconSize(zoom: number): number {
  if (zoom <= JOURNEY_ICON[0][0]) return JOURNEY_ICON[0][1];
  for (let i = 1; i < JOURNEY_ICON.length; i++) {
    const [z1, s1] = JOURNEY_ICON[i];
    if (zoom <= z1) {
      const [z0, s0] = JOURNEY_ICON[i - 1];
      return s0 + ((s1 - s0) * (zoom - z0)) / (z1 - z0);
    }
  }
  return JOURNEY_ICON.at(-1)![1];
}

/** The airport marker's dot grows with its traffic: radius in CSS pixels by the square root of its count. */
export const DOT_RADIUS: ExpressionSpecification = ["interpolate", ["linear"], ["sqrt", ["coalesce", ["get", "count"], 0]], 0, 3, 4, 5.5, 10, 10];

/** The ripple round each airport at `phase` (0 to 1 of a beat): it grows out from the dot and fades, and fades with `mapShown`, the share of the map in view (0 to 1, held there). */
export function ripple(phase: number, mapShown = 1): { radius: ExpressionSpecification; opacity: number } {
  return { radius: ["*", DOT_RADIUS, 1 + 1.8 * phase], opacity: 0.55 * (1 - phase) ** 1.5 * Math.max(0, Math.min(1, mapShown)) };
}

/** Steps of a dash marching along a line: set in turn they read as traffic flowing along the route. */
export const FLOW_DASHES: number[][] = [
  [0, 4, 3],
  [0.5, 4, 2.5],
  [1, 4, 2],
  [1.5, 4, 1.5],
  [2, 4, 1],
  [2.5, 4, 0.5],
  [3, 4, 0],
  [0, 0.5, 3, 3.5],
  [0, 1, 3, 3],
  [0, 1.5, 3, 2.5],
  [0, 2, 3, 2],
  [0, 2.5, 3, 1.5],
  [0, 3, 3, 1],
  [0, 3.5, 3, 0.5],
];

/**
 * Each aircraft's opacity: its fade in or out, a hint of altitude (lower ones a little fainter), and
 * `shown`, how much of the map is still in view over the diorama.
 */
export function aircraftOpacity(shown: number): DataDrivenPropertyValueSpecification<number> {
  return ["*", shown, ["*", ["coalesce", ["get", "fade"], 1], ["interpolate", ["linear"], ["coalesce", ["get", "altitude"], 0], 0, 0.72, 38000, 1]]];
}

/** City buildings, metres of drawn height per metre of real height, at full rise: the diorama's own scale, so the two meet. */
export const BUILDING_SCALE = MODEL.heightScale;

/** The city's buildings' drawn height at `rise` (0 flat to 1 full). */
export function buildingHeight(rise: number): ExpressionSpecification {
  return ["*", ["coalesce", ["get", "render_height"], 8], BUILDING_SCALE * rise];
}

/** The weather radar's source: a frame's tiles (see radar.ts), credited as RainViewer asks. */
export function radarSource(tiles: string): SourceSpecification {
  return {
    type: "raster",
    tiles: [tiles],
    tileSize: 256,
    maxzoom: RADAR_MAX_ZOOM,
    attribution: `<a href="${RADAR_CREDIT.href}" target="_blank" rel="noopener">RainViewer</a>`,
  };
}

/** How much of the radar shows in each theme: the same picture, a little fainter over imagery that is busy already. */
const RADAR_OPACITY: Record<ThemeKey, number> = { light: 0.7, dark: 0.8, satellite: 0.6 };

/** The weather radar layer, over the land and under the names and the traffic. */
export function radarLayer(key: ThemeKey): LayerSpecification {
  return { id: "radar", type: "raster", source: "radar", paint: { "raster-opacity": RADAR_OPACITY[key], "raster-fade-duration": 300 } };
}

/** A hint of altitude: lower aircraft a little smaller and fainter than those at cruise. */
const altitudeScale: ExpressionSpecification = ["interpolate", ["linear"], ["coalesce", ["get", "altitude"], 0], 0, 0.8, 38000, 1.12];

/** The traffic's icon size by zoom, times `k`: the selected aircraft is drawn at SELECTED_SCALE times it. */
function trafficIconSize(k: number): ExpressionSpecification {
  return ["interpolate", ["linear"], ["zoom"], 5, ["*", 0.42 * k, altitudeScale], 10, ["*", 0.75 * k, altitudeScale], 13, ["*", 1.05 * k, altitudeScale]];
}

/** The selected aircraft is drawn this many times the size it has in the traffic, in the selection colour, so it reads inside its ring. */
export const SELECTED_SCALE = 1.5;

/** How much of their strength the other traffic keeps while one flight is selected: the route arcs, the trails and the aircraft stand back from it. */
export const SELECTION_DIM = { arcs: 0.4, trails: 0.45, aircraft: 0.55 } as const;

/** The route arcs' opacities in a theme, scaled by `dim` (1 with nothing selected). */
export function arcOpacities(key: ThemeKey, dim = 1): { glow: number; line: number; flow: number } {
  const p = PALETTES[key];
  return { glow: p.arcGlow * dim, line: p.arcOpacity * 0.6 * dim, flow: p.arcOpacity * dim };
}

const EMPTY: SourceSpecification = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
const EMPTY_LINES: SourceSpecification = { type: "geojson", data: { type: "FeatureCollection", features: [] }, lineMetrics: true };

/** A colour as rgba with alpha `a`: for gradients, which fade a colour rather than blend two. */
function withAlpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function place(id: string, filter: FilterSpecification, minzoom: number, size: number, p: MapPalette): LayerSpecification {
  const upper = id !== "places-city";
  return {
    id,
    type: "symbol",
    source: "openfreemap",
    "source-layer": "place",
    minzoom,
    filter,
    layout: {
      "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
      "text-font": REGULAR,
      "text-size": size,
      "text-transform": upper ? "uppercase" : "none",
      "text-letter-spacing": upper ? 0.14 : 0.02,
    },
    paint: { "text-color": p.label, "text-halo-color": p.halo, "text-halo-width": 1.2 },
  };
}

/** A trail behind each aircraft of one kind, fading from clear at its tail to the kind's colour at the aircraft. */
function trail(kind: string, color: string): LayerSpecification {
  return {
    id: `trails-${kind}`,
    type: "line",
    source: "trails",
    filter: ["==", ["get", "kind"], kind],
    layout: { "line-cap": "round" },
    paint: {
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2, 13, 3],
      "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, withAlpha(color, 0), 1, withAlpha(color, 0.7)],
    },
  };
}

/** `radar`: a frame's tile URL (radar.ts) to draw the weather radar from; without it the style has no radar layer. */
export function mapStyle(key: ThemeKey, { globe = false, radar = null }: { globe?: boolean; radar?: string | null } = {}): StyleSpecification {
  const theme = THEMES[key];
  const p = PALETTES[key];
  const satellite = key === "satellite";
  const kinds = { arriving: theme.aircraft.arriving, departing: theme.aircraft.departing, ground: theme.aircraft.parked, cruise: p.cruise };
  const sources: Record<string, SourceSpecification> = {
    openfreemap: { type: "vector", url: OPENFREEMAP },
    airports: EMPTY,
    aircraft: EMPTY,
    trails: EMPTY_LINES,
    arcs: EMPTY_LINES,
    journey: EMPTY,
    procedure: EMPTY_LINES,
    selected: EMPTY,
    hover: EMPTY,
  };
  if (radar) sources.radar = radarSource(radar);
  if (satellite) {
    sources.imagery = { type: "raster", tiles: [USGS_IMAGERY], tileSize: 256, maxzoom: 16, attribution: "Imagery: USDA, USGS The National Map: Orthoimagery" };
  }
  const arc = arcOpacities(key);
  const layers: LayerSpecification[] = [
    { id: "background", type: "background", paint: { "background-color": satellite ? theme.background : theme.surfaces.ground } },
    ...(satellite ? [{ id: "imagery", type: "raster", source: "imagery", paint: { "raster-saturation": -0.1 } } satisfies LayerSpecification] : []),
    // The shore is the fill's own outline, not a line layer over the same polygons: a lake's outline is one ring of thousands of points (Lake Lanier is 6,500 at zoom 10), and a
    // line bucket asks for ten vertices a point, past the 65,535 a segment holds ("Max vertices per segment is 65535" in the console, the line drawn wrong). A fill asks for one a point.
    // On the aerial view the fill is transparent rather than faded out, so its outline still draws.
    { id: "water", type: "fill", source: "openfreemap", "source-layer": "water", paint: { "fill-color": satellite ? "rgba(0,0,0,0)" : p.water, "fill-outline-color": p.shore } },
    {
      id: "roads",
      type: "line",
      source: "openfreemap",
      "source-layer": "transportation",
      minzoom: 5,
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary"]]],
      paint: { "line-color": ["match", ["get", "class"], ["motorway", "trunk"], p.majorRoad, p.road], "line-width": ["interpolate", ["exponential", 1.6], ["zoom"], 5, 0.4, 14, 5] },
    },
    { id: "aeroway-apron", type: "fill", source: "openfreemap", "source-layer": "aeroway", filter: ["==", ["get", "class"], "apron"], paint: { "fill-color": theme.surfaces.apron, "fill-opacity": satellite ? 0 : 1 } },
    {
      id: "aeroway-taxiway",
      type: "line",
      source: "openfreemap",
      "source-layer": "aeroway",
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "class"], "taxiway"]],
      paint: { "line-color": theme.surfaces.taxiway, "line-opacity": satellite ? 0 : 1, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 10, 0.5, 16, 12] },
    },
    { id: "aeroway-runway", type: "fill", source: "openfreemap", "source-layer": "aeroway", filter: ["all", ["==", ["geometry-type"], "Polygon"], ["==", ["get", "class"], "runway"]], paint: { "fill-color": theme.surfaces.runway, "fill-opacity": satellite ? 0 : 1 } },
    {
      id: "aeroway-runway-line",
      type: "line",
      source: "openfreemap",
      "source-layer": "aeroway",
      filter: ["all", ["==", ["geometry-type"], "LineString"], ["==", ["get", "class"], "runway"]],
      paint: { "line-color": theme.surfaces.runway, "line-opacity": satellite ? 0 : 1, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 10, 1, 16, 45] },
    },
    { id: "boundary-state", type: "line", source: "openfreemap", "source-layer": "boundary", filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]], paint: { "line-color": p.stateLine, "line-width": 0.6, "line-dasharray": [3, 2] } },
    { id: "boundary-country", type: "line", source: "openfreemap", "source-layer": "boundary", filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]], paint: { "line-color": p.boundary, "line-width": 1.1 } },
    ...(radar ? [radarLayer(key)] : []),
    {
      // The cities by night: a soft warm glow for each, larger for the larger ones.
      id: "city-lights",
      type: "circle",
      source: "openfreemap",
      "source-layer": "place",
      filter: ["in", ["get", "class"], ["literal", ["city", "town"]]],
      paint: {
        "circle-color": p.cityLight,
        "circle-opacity": p.cityLightOpacity,
        "circle-blur": 1,
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 3, ["interpolate", ["linear"], ["coalesce", ["get", "rank"], 10], 1, 9, 6, 4, 12, 1.5], 9, ["interpolate", ["linear"], ["coalesce", ["get", "rank"], 10], 1, 34, 6, 16, 12, 7]],
      },
    },
    {
      // The city's buildings near an airport, raised with the diorama's buildings as it comes in.
      id: "buildings-3d",
      type: "fill-extrusion",
      source: "openfreemap",
      "source-layer": "building",
      minzoom: 13,
      paint: { "fill-extrusion-color": theme.surfaces.wall, "fill-extrusion-height": buildingHeight(0), "fill-extrusion-opacity": 0 },
    },
    // Few names, as an atlas would: countries, then states, then only the larger cities as the view
    // closes in, so the airports stay the thing to read.
    place("places-country", ["==", ["get", "class"], "country"], 0, 12, p),
    place("places-state", ["==", ["get", "class"], "state"], 4, 10, p),
    place("places-city", ["all", ["==", ["get", "class"], "city"], ["<=", ["get", "rank"], 3]], 5, 11, p),
    // The network: each route flown from a built airport, a soft glow under a fine line, and a dash flowing along it.
    {
      id: "arcs-glow",
      type: "line",
      source: "arcs",
      layout: { "line-cap": "round" },
      paint: { "line-color": p.arc, "line-opacity": arc.glow, "line-blur": 6, "line-width": ["interpolate", ["linear"], ["get", "flights"], 1, 6, 10, 12] },
    },
    { id: "arcs", type: "line", source: "arcs", layout: { "line-cap": "round" }, paint: { "line-color": p.arc, "line-opacity": arc.line, "line-width": ["interpolate", ["linear"], ["get", "flights"], 1, 0.8, 10, 2.4] } },
    { id: "arcs-flow", type: "line", source: "arcs", paint: { "line-color": p.arc, "line-opacity": arc.flow, "line-width": ["interpolate", ["linear"], ["get", "flights"], 1, 1.4, 10, 3], "line-dasharray": FLOW_DASHES[0] } },
    trail("cruise", kinds.cruise),
    trail("arriving", kinds.arriving),
    trail("departing", kinds.departing),
    // The selected flight's approach or climb-out (features.ts procedureFeatures), in the diorama's state colours, fading out with distance from the field.
    {
      id: "procedure",
      type: "line",
      source: "procedure",
      filter: ["!=", ["get", "own"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": ["match", ["get", "state"], "arriving", theme.aircraft.arriving, "departing", theme.aircraft.departing, "taxiing", theme.aircraft.taxiing, theme.aircraft.parked],
        "line-opacity": ["get", "fade"],
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 3.2],
      },
    },
    {
      id: "aircraft",
      type: "symbol",
      source: "aircraft",
      layout: {
        "icon-image": "aircraft",
        "icon-size": trafficIconSize(1),
        "icon-rotate": ["coalesce", ["get", "track"], 0],
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        "symbol-sort-key": ["coalesce", ["get", "altitude"], 0],
      },
      paint: {
        "icon-color": ["match", ["get", "kind"], "arriving", kinds.arriving, "departing", kinds.departing, "ground", kinds.ground, kinds.cruise],
        "icon-opacity": aircraftOpacity(1),
        "icon-halo-color": p.halo,
        "icon-halo-width": 1,
      },
    },
    // The selected flight (a click on the map): what the page saw of its track, solid and bright; the
    // way back to its origin, faint, and the way on to its destination, dashed, both only estimates; a
    // halo under the track so it reads over the arcs, and a glowing ring round the aircraft, drawn larger
    // than the traffic and over it. Everything else stands back (SELECTION_DIM).
    {
      id: "selected-casing",
      type: "line",
      source: "selected",
      filter: ["in", ["get", "part"], ["literal", ["observed", "ahead"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.halo, "line-opacity": ["match", ["get", "part"], "observed", 0.85, 0.5], "line-width": ["interpolate", ["linear"], ["zoom"], 5, 5.5, 12, 8] },
    },
    { id: "selected-from", type: "line", source: "selected", filter: ["==", ["get", "part"], "from"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": p.selected, "line-opacity": 0.4, "line-width": 1.8 } },
    { id: "selected-ahead", type: "line", source: "selected", filter: ["==", ["get", "part"], "ahead"], layout: { "line-join": "round" }, paint: { "line-color": p.selected, "line-opacity": 0.95, "line-width": 2.4, "line-dasharray": [1.8, 1.4] } },
    {
      id: "selected-observed",
      type: "line",
      source: "selected",
      filter: ["==", ["get", "part"], "observed"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.selected, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 4.5] },
    },
    // The approach or climb-out the diorama's selected flight has (the "procedure" layer), when that flight is the selected one: drawn as its path is, not as one more line.
    {
      id: "procedure-selected-casing",
      type: "line",
      source: "procedure",
      filter: ["==", ["get", "own"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.halo, "line-opacity": ["*", 0.85, ["get", "fade"]], "line-width": ["interpolate", ["linear"], ["zoom"], 5, 5.5, 12, 8] },
    },
    {
      id: "procedure-selected",
      type: "line",
      source: "procedure",
      filter: ["==", ["get", "own"], true],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": p.selected, "line-opacity": ["get", "fade"], "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3, 12, 4.5] },
    },
    // A lost aircraft (left the feed) keeps its place, ring and path, faded.
    { id: "selected-glow", type: "circle", source: "selected", filter: ["==", ["get", "part"], "aircraft"], paint: { "circle-radius": 34, "circle-color": p.selected, "circle-opacity": ["case", ["get", "lost"], 0.12, 0.4], "circle-blur": 0.8 } },
    {
      id: "selected-ring",
      type: "circle",
      source: "selected",
      filter: ["==", ["get", "part"], "aircraft"],
      paint: { "circle-radius": BEACON_RADIUS_PX + 3, "circle-color": p.halo, "circle-opacity": ["case", ["get", "lost"], 0.2, 0.5], "circle-stroke-color": p.selected, "circle-stroke-width": 2.5, "circle-stroke-opacity": ["case", ["get", "lost"], 0.45, 1] },
    },
    {
      id: "selected-aircraft",
      type: "symbol",
      source: "selected",
      filter: ["==", ["get", "part"], "aircraft"],
      layout: {
        "icon-image": "aircraft",
        "icon-size": trafficIconSize(SELECTED_SCALE),
        "icon-rotate": ["coalesce", ["get", "track"], 0],
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      // Filled solid: its halo is the selection colour too, which thickens the glyph rather than outlining it.
      paint: { "icon-color": p.selected, "icon-opacity": ["case", ["get", "lost"], 0.5, 1], "icon-halo-color": p.selected, "icon-halo-width": 1.2 },
    },
    // The aircraft under the pointer (desktop): a faint ring, so it is plain which one a click takes.
    { id: "hover-ring", type: "circle", source: "hover", paint: { "circle-radius": BEACON_RADIUS_PX, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": p.selected, "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.6 } },
    // The followed flight (gate to gate): the way it has flown, solid, and the way left to its destination,
    // dashed, under the aircraft itself, drawn larger than the traffic in the airports' marker colour.
    {
      id: "journey-beacon",
      type: "circle",
      source: "journey",
      filter: ["==", ["get", "part"], "aircraft"],
      paint: { "circle-radius": BEACON_RADIUS_PX, "circle-color": p.dot, "circle-opacity": 0.12, "circle-stroke-color": p.dot, "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.55, "circle-pitch-alignment": "map" },
    },
    { id: "journey-left", type: "line", source: "journey", filter: ["==", ["get", "part"], "left"], layout: { "line-cap": "round" }, paint: { "line-color": p.dot, "line-opacity": 0.55, "line-width": 1.6, "line-dasharray": [1.5, 2.5] } },
    // The published climb-out and approach still ahead of it, as the diorama draws a procedure: solid, in the arriving or departing colour, so it reads as published where the rest of the way left is a dashed guess.
    { id: "journey-procedure-casing", type: "line", source: "journey", filter: ["in", ["get", "part"], ["literal", ["climb-out", "approach"]]], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": p.halo, "line-opacity": 0.7, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 4, 12, 7] } },
    {
      id: "journey-procedure",
      type: "line",
      source: "journey",
      filter: ["in", ["get", "part"], ["literal", ["climb-out", "approach"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": ["match", ["get", "part"], "approach", theme.aircraft.arriving, theme.aircraft.departing], "line-opacity": 0.95, "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.6, 12, 3.2] },
    },
    { id: "journey-flown", type: "line", source: "journey", filter: ["==", ["get", "part"], "flown"], layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": p.dot, "line-opacity": 0.9, "line-width": 2.4 } },
    {
      id: "journey-aircraft",
      type: "symbol",
      source: "journey",
      filter: ["==", ["get", "part"], "aircraft"],
      layout: {
        "icon-image": "aircraft",
        "icon-size": ["interpolate", ["linear"], ["zoom"], ...JOURNEY_ICON.flat()],
        "icon-rotate": ["coalesce", ["get", "track"], 0],
        "icon-rotation-alignment": "map",
        "icon-pitch-alignment": "map",
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
      paint: { "icon-color": p.dot, "icon-halo-color": p.halo, "icon-halo-width": 1.5 },
    },
    // The airports: a ripple that beats out from each, a dot sized by its traffic, and a chip naming it with its live count.
    { id: "airport-pulse", type: "circle", source: "airports", paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": ripple(0).radius, "circle-stroke-color": p.dot, "circle-stroke-width": 1.4, "circle-stroke-opacity": ripple(0).opacity } },
    { id: "airports", type: "circle", source: "airports", paint: { "circle-color": p.dot, "circle-radius": DOT_RADIUS, "circle-stroke-color": p.halo, "circle-stroke-width": 1.5 } },
    {
      id: "airport-labels",
      type: "symbol",
      source: "airports",
      layout: {
        "text-field": ["case", ["has", "count"], ["format", ["upcase", ["get", "code"]], {}, "  ", {}, ["to-string", ["get", "count"]], { "text-font": ["literal", REGULAR], "text-color": p.chipCount }], ["upcase", ["get", "code"]]],
        "text-font": BOLD,
        "text-size": 11,
        "text-letter-spacing": 0.04,
        "text-anchor": "bottom",
        "text-offset": [0, -1.1],
        "icon-image": `chip-${key}`,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [3, 7, 3, 7],
        "text-allow-overlap": false,
        "icon-allow-overlap": false,
        // The busiest airports keep their chip where two would collide.
        "symbol-sort-key": ["-", 0, ["coalesce", ["get", "count"], 0]],
      },
      paint: { "text-color": p.chipText },
    },
  ];
  return {
    version: 8,
    glyphs: GLYPHS,
    sources,
    layers,
    // Web Mercator at region zoom and closer, which the camera conversion assumes. At world zoom a globe
    // where the renderer draws one properly (see globeCapable).
    projection: { type: globe ? ["interpolate", ["linear"], ["zoom"], 4.5, "vertical-perspective", 6, "mercator"] : "mercator" },
    // The horizon fades into the page colour, as the diorama's fog does.
    sky: { "sky-color": theme.background, "horizon-color": theme.background, "fog-color": theme.background, "sky-horizon-blend": 0.5, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.6, "atmosphere-blend": 0 },
  };
}
