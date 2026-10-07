import type { FlightState } from "../aircraft-state";

/**
 * The model itself, the same in every theme: one airport, one camera, one scale. A theme recolours
 * and relights it and changes the post effects; it cannot move, resize, add or remove anything, so
 * switching theme never changes what is where. (Lights glow at night; by day the same fixtures are
 * drawn unlit.)
 */
export const MODEL = {
  /** Metres of model height per metre of real height, for buildings. */
  heightScale: 2.4,
  /** Aircraft drawn this many times life size, so a jet stays readable at airport scale. */
  aircraftScale: 2.2,
  taxiwayWidthScale: 0.75,
  /**
   * Minor taxilanes (mapped as taxilanes, or running across an apron): the lanes between stands. Drawn
   * narrower than the taxiways, so the network reads as the main routes.
   */
  taxilaneWidthScale: 0.45,
  /** Width of the painted centreline on the main taxiways, metres: wider than paint, so it holds a pixel. */
  taxiwayLineWidth: 3,
  /**
   * The centreline is not drawn where it would be thinner than this on screen (CSS pixels), as at
   * phone zoom: there the antialiasing blends it into the taxiway as brown noise, so it goes instead.
   */
  taxiwayLineMinPx: 0.5,
} as const;

/**
 * Everything about the look of the scene that a theme can change: surface colours, the light rig and
 * the post effects. Geometry and camera are shared (MODEL), so a new theme is a new object of this
 * shape and nothing else.
 */
export interface SceneTheme {
  name: string;
  /** Page colour: clear colour and the fog. */
  background: string;
  surfaces: {
    /** The ground beyond the pavement. */
    ground: string;
    apron: string;
    taxiway: string;
    /** The lanes between stands; nearer the apron's colour than the taxiways. */
    taxilane: string;
    /** Centreline paint on the main taxiways. */
    taxiwayLine: string;
    runway: string;
    marking: string;
    roof: string;
    /** Outline along each roof's edge. */
    roofEdge: string;
    /** Albedo of walls; lighting darkens the ones facing away from the sun. */
    wall: string;
  };
  /** The aircraft's state colours: the whole aircraft, or just its painted parts when there is a livery. */
  aircraft: Record<FlightState, string>;
  /**
   * A painted livery: the fuselage in this colour, and only the tail, wings and engines in the state
   * colour, as real paint is. Null paints the whole aircraft its state colour.
   */
  livery: { body: string } | null;
  /** The ribbon behind a moving aircraft: the state's colour, so the legend holds when aircraft are all one colour. */
  trail: Record<FlightState, string>;
  /** Colour of the drop line and ground dot under an airborne aircraft. */
  dropLine: string;
  /**
   * The time-lapse's light trails, in the trail colours: alpha at the aircraft, how far past 1 the
   * colour goes (the bloom picks out what passes its threshold), whether they add light to what is
   * under them as lights do at night or paint over it, and their width in pixels.
   */
  lightTrails: { opacity: number; intensity: number; glow: boolean; widthPx: number };
  /** The airfield's light fixtures as they look unlit, by day: small dots in the fixtures' places. */
  fixtures: { color: string; size: number };
  /** Gentle variation in the ground's colour, as grass has: strength, feature size in metres, and how much lighter the field's middle is. */
  groundVariation: { strength: number; scale: number; lift: number } | null;
  lights: {
    /**
     * Sky and ground colours and strength of the hemisphere fill. With three's Lambert BRDF a lit
     * horizontal surface shows its albedo exactly when hemisphere + sun * sin(elevation) sum to PI.
     */
    sky: string;
    groundBounce: string;
    hemisphere: number;
    sun: { color: string; intensity: number; azimuthDeg: number; elevationDeg: number };
    /** PCF blur radius, in shadow-map texels. */
    shadowRadius: number;
    shadowMapSize: number;
  };
  /** Linear fog from `near` to `far`, in multiples of the camera's distance from the model; null for none. */
  fog: { near: number; far: number } | null;
  /**
   * The air in a close camera mode (drone, tower, approach): the sky's colour at the horizon, which is
   * also the haze the ground fades into, and overhead; and where the haze starts and ends, metres,
   * ending a little past what any mode's frame reaches (HORIZON_REACH in cameras.ts). Blended in as the
   * camera eases into a mode. `ground` is the ground's colour there, where the page colour under a
   * model on paper would read as a void past the mapped field (the haze grades it into the horizon);
   * absent where the ground already reads as ground.
   */
  eyeLevel: { horizon: string; zenith: string; fog: { near: number; far: number }; ground?: string };
  ambientOcclusion: { radius: number; distanceExponent: number; thickness: number; scale: number; blend: number } | null;
  /** Tilt-shift blur: strength in pixels at the frame's top and bottom edges, 0 in a band at the focus. */
  tiltShift: { blur: number; focus: number; band: number } | null;
  /** Night lighting: airfield lights, aircraft lights, lit aprons and windows, and bloom. Null by day. */
  night: NightLighting | null;
}

/** Colours are sRGB hex; `intensity` multiplies them past 1 so the bloom picks out lights and nothing else. */
export interface NightLighting {
  airfield: {
    runwayEdge: string;
    /** The last 600 m of edge lights before each runway end. */
    runwayCaution: string;
    runwayCentre: string;
    threshold: string;
    runwayEnd: string;
    taxiwayCentre: string;
    approach: string;
    papiRed: string;
    papiWhite: string;
    intensity: number;
    /** Diameter of one light on screen, CSS pixels, for the runway's edge, centreline and PAPI lights. */
    size: number;
    /**
     * The green threshold and red end bars: bright enough to read as coloured bars, too dim to bloom
     * into each other. Approach lights are smaller and dimmer than the runway's, so they lead to the
     * bars without merging with them.
     */
    barSize: number;
    barIntensity: number;
    approachSize: number;
    approachIntensity: number;
    /** Taxiway lights: small and under the bloom threshold, so the taxiways stay quiet. */
    taxiwaySize: number;
    taxiwayIntensity: number;
  };
  aircraft: {
    port: string;
    starboard: string;
    tail: string;
    beacon: string;
    strobe: string;
    intensity: number;
    size: number;
    /** Share of its state colour an aircraft emits, so it reads in the dark whatever the light rig. */
    glow: number;
  };
  /** Pools of light around each stand on the aprons. */
  floodlight: { color: string; radius: number; opacity: number };
  /** Lit windows on terminal walls: colour, emissive strength, and the share of windows lit. */
  windows: { color: string; intensity: number; lit: number };
  bloom: { strength: number; radius: number; threshold: number };
}

/** The sun's share of PI on a horizontal surface, given the hemisphere's: lit pavement shows its albedo. */
function sunFor(hemisphere: number, elevationDeg: number): number {
  return (Math.PI - hemisphere) / Math.sin((elevationDeg * Math.PI) / 180);
}

const SUN_ELEVATION = 52;
const HEMISPHERE = Math.PI * 0.74;

const DIORAMA_STATES: Record<FlightState, string> = {
  arriving: "#2f7fd6",
  departing: "#d6336c",
  taxiing: "#e8762c",
  parked: "#a2a6ad",
};

/** Light: toy diorama. A white architectural model on paper, under soft studio light. */
export const DIORAMA: SceneTheme = {
  name: "diorama",
  background: "#f4f3ef",
  surfaces: {
    ground: "#f4f3ef",
    apron: "#ebe9e3",
    taxiway: "#dcd9d1",
    taxilane: "#e2dfd8",
    taxiwayLine: "#e6e3dc",
    runway: "#d5d2ca",
    marking: "#ffffff",
    roof: "#ffffff",
    roofEdge: "#ffffff",
    wall: "#e4dfd3",
  },
  aircraft: DIORAMA_STATES,
  livery: null,
  trail: DIORAMA_STATES,
  dropLine: "#9a9ca1",
  lightTrails: { opacity: 0.95, intensity: 1, glow: false, widthPx: 3.2 },
  fixtures: { color: "#bdb9b0", size: 1.6 },
  groundVariation: null,
  lights: {
    sky: "#ffffff",
    groundBounce: "#f4f3ef",
    hemisphere: HEMISPHERE,
    sun: { color: "#ffffff", intensity: sunFor(HEMISPHERE, SUN_ELEVATION), azimuthDeg: 300, elevationDeg: SUN_ELEVATION },
    shadowRadius: 6,
    shadowMapSize: 4096,
  },
  fog: { near: 1.05, far: 2.3 },
  eyeLevel: { horizon: "#f4f3ef", zenith: "#dde5ec", fog: { near: 3000, far: 10_000 }, ground: "#e2ded2" },
  ambientOcclusion: { radius: 40, distanceExponent: 1.5, thickness: 20, scale: 1.2, blend: 0.9 },
  tiltShift: { blur: 1.6, focus: 0.5, band: 0.55 },
  night: null,
};

const MOON_ELEVATION = 60;
const MOON_HEMISPHERE = Math.PI * 0.8;

const NIGHT_STATES: Record<FlightState, string> = {
  arriving: "#5cb8ff",
  departing: "#ff5c8a",
  taxiing: "#ffb347",
  parked: "#5f7390",
};

/**
 * Dark: night ops. The same model after dark: near-black ground and pavement, the airfield lit only
 * by its own lights. Surfaces are lit to show their albedo, so the colours land as written here.
 */
export const NIGHT_OPS: SceneTheme = {
  name: "nightops",
  background: "#060a10",
  surfaces: {
    ground: "#060a10",
    apron: "#0a111b",
    taxiway: "#0e2a44",
    taxilane: "#0c1826",
    taxiwayLine: "#0f2d49",
    runway: "#101722",
    marking: "#1a2230",
    roof: "#0f1621",
    roofEdge: "#2b3d57",
    wall: "#0c121b",
  },
  aircraft: NIGHT_STATES,
  livery: null,
  trail: NIGHT_STATES,
  dropLine: "#4f6788",
  lightTrails: { opacity: 0.9, intensity: 2.4, glow: true, widthPx: 2.4 },
  fixtures: { color: "#1a2230", size: 1.6 },
  groundVariation: null,
  lights: {
    sky: "#c9d6ea",
    groundBounce: "#060a10",
    hemisphere: MOON_HEMISPHERE,
    sun: { color: "#dfe7f2", intensity: sunFor(MOON_HEMISPHERE, MOON_ELEVATION), azimuthDeg: 300, elevationDeg: MOON_ELEVATION },
    shadowRadius: 4,
    shadowMapSize: 2048,
  },
  fog: { near: 1.05, far: 2.3 },
  eyeLevel: { horizon: "#0e1724", zenith: "#03060b", fog: { near: 2500, far: 9000 }, ground: "#0a111b" },
  ambientOcclusion: null,
  tiltShift: { blur: 1.2, focus: 0.5, band: 0.6 },
  night: {
    airfield: {
      runwayEdge: "#ffd98a",
      runwayCaution: "#ffb347",
      runwayCentre: "#f4f7ff",
      threshold: "#3ddc84",
      runwayEnd: "#ff4b4b",
      taxiwayCentre: "#3ddc84",
      approach: "#fff4dc",
      papiRed: "#ff4b4b",
      papiWhite: "#ffffff",
      intensity: 2.6,
      size: 3.2,
      barSize: 3.2,
      barIntensity: 1.6,
      approachSize: 2.2,
      approachIntensity: 1.2,
      taxiwaySize: 2,
      taxiwayIntensity: 0.55,
    },
    aircraft: {
      port: "#ff3b3b",
      starboard: "#3dff7a",
      tail: "#ffffff",
      beacon: "#ff2a2a",
      strobe: "#ffffff",
      intensity: 3,
      size: 4,
      glow: 0.55,
    },
    floodlight: { color: "#ffe2b0", radius: 30, opacity: 0.03 },
    windows: { color: "#ffc978", intensity: 1.1, lit: 0.55 },
    bloom: { strength: 0.55, radius: 0.35, threshold: 0.9 },
  },
};

const DAYLIGHT_ELEVATION = 48;
const DAYLIGHT_HEMISPHERE = Math.PI * 0.68;
/** The cool sky and warm sun each give back less than white light; this restores the albedo on the pavement. */
const DAYLIGHT_GAIN = 1.1;

/** The legend's colours (the same in the page's tokens), as paint on white aircraft. */
const SATELLITE_STATES: Record<FlightState, string> = {
  arriving: "#2f7fd6",
  departing: "#d6336c",
  taxiing: "#f08a2c",
  parked: "#a2a6ad",
};

/**
 * Satellite, a realistic daylight look: grass, grey asphalt with white paint and yellow taxiway
 * centrelines, concrete aprons, light roofs, and white-bodied aircraft painted in their state colour
 * under a warm sun. Shadow keeps the hemisphere's share of PI (about 0.7), a 30% shade.
 */
export const SATELLITE: SceneTheme = {
  name: "satellite",
  background: "#5f7c42",
  surfaces: {
    ground: "#6d8b4c",
    apron: "#b4b1a9",
    taxiway: "#5a5d62",
    taxilane: "#a5a29a",
    taxiwayLine: "#e3c14b",
    runway: "#3a3c40",
    marking: "#f4f4f2",
    roof: "#e6e3dc",
    roofEdge: "#bdb8ad",
    wall: "#cfcabe",
  },
  aircraft: SATELLITE_STATES,
  livery: { body: "#f7f7f5" },
  trail: SATELLITE_STATES,
  dropLine: "#2a3320",
  lightTrails: { opacity: 0.95, intensity: 1.1, glow: false, widthPx: 3.2 },
  fixtures: { color: "#e4e1d6", size: 1.8 },
  groundVariation: { strength: 0.18, scale: 220, lift: 0.1 },
  lights: {
    sky: "#f3f6fa",
    groundBounce: "#6d8b4c",
    hemisphere: DAYLIGHT_HEMISPHERE * DAYLIGHT_GAIN,
    sun: {
      color: "#fff4e2",
      intensity: sunFor(DAYLIGHT_HEMISPHERE, DAYLIGHT_ELEVATION) * DAYLIGHT_GAIN,
      azimuthDeg: 300,
      elevationDeg: DAYLIGHT_ELEVATION,
    },
    shadowRadius: 3,
    shadowMapSize: 4096,
  },
  fog: { near: 1.1, far: 2.6 },
  eyeLevel: { horizon: "#cdd8e2", zenith: "#7fa6cc", fog: { near: 3500, far: 12_000 } },
  ambientOcclusion: { radius: 30, distanceExponent: 1.5, thickness: 15, scale: 1, blend: 0.7 },
  tiltShift: null,
  night: null,
};

export const THEMES = { light: DIORAMA, dark: NIGHT_OPS, satellite: SATELLITE } as const;
export type ThemeKey = keyof typeof THEMES;

/** A theme's key from a query value; anything unknown is light. */
export function themeKey(value: unknown): ThemeKey {
  return value === "dark" || value === "satellite" ? value : "light";
}
