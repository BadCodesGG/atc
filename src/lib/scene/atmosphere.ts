import { Color } from "three";
import type { Metar, Wind } from "../metar";
import type { SunPosition } from "../sun";
import type { SceneTheme } from "./theme";

/**
 * The light and the air over the model: where the real sun puts the key light and how warm it is, and
 * what the METAR does to the air (fog, rain, snow, wind). Pure: a theme, a sun position and a report
 * in, the numbers AirportScene applies out. Only light, colour and post effects change, as with a
 * theme; nothing moves and the camera stays where it is.
 *
 * Night ops stays night: the sun never lights it, and only the weather reaches it.
 */

export interface SunLight {
  /** Where the key light comes from: degrees clockwise from true north, and above the horizon. */
  azimuthDeg: number;
  elevationDeg: number;
  color: string;
  intensity: number;
  /** The hemisphere fill. */
  sky: string;
  groundBounce: string;
  hemisphere: number;
  /**
   * Share of their own colour the aircraft emit, so they stay legible when the light falls after
   * sunset: 0 by day and in night ops (whose aircraft glow by the theme's own night lighting).
   */
  aircraftGlow: number;
  /** The sky the close camera views see: at the horizon, warmed by a low sun, and overhead, both dimmed with the light. */
  horizon: string;
  zenith: string;
}

export interface Precipitation {
  kind: "rain" | "snow";
  /** How many drops or flakes are in the air around the view. */
  count: number;
  color: string;
  opacity: number;
  /** On-screen size of one drop's streak or one flake, CSS pixels. */
  sizePx: number;
  /** Seconds a drop takes to fall through the volume drawn around the view. */
  fallSeconds: number;
  /** Sideways drift per second, as shares of the volume's width: map east and north. */
  drift: [number, number];
}

export interface SceneWeather {
  /** Clear colour and fog colour: the page, lit like the ground and greyed by the fog. */
  background: string;
  /** Linear fog in multiples of the camera's distance, as SceneTheme's. */
  fog: { near: number; far: number } | null;
  /** The close camera views' haze as a share of the clear air's: 1 in good visibility, closing in with the fog as the orbit's does. */
  haze: number;
  precipitation: Precipitation | null;
  /** For the windsocks. */
  wind: Wind | null;
}

/** Linear interpolation through a table of [x, y] rows sorted by x, held flat past either end. */
function table(rows: readonly (readonly [number, number])[], x: number): number {
  if (x <= rows[0][0]) return rows[0][1];
  for (let i = 1; i < rows.length; i++) {
    const [x1, y1] = rows[i];
    if (x <= x1) {
      const [x0, y0] = rows[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return rows[rows.length - 1][1];
}

/**
 * The light on the ground relative to the theme's own (its noon), by the sun's elevation: it dims a
 * little toward sunset, more through twilight, and holds at a dusk level through the night, so the
 * model stays readable in every theme at every hour.
 */
const EXPOSURE = [
  [-18, 0.46],
  [-12, 0.5],
  [-6, 0.58],
  [-2, 0.68],
  [0, 0.74],
  [4, 0.85],
  [10, 0.94],
  [25, 1],
] as const;
/** The sun's share of that light relative to the theme's: none below the horizon, all of it from 20 degrees up. */
const DIRECT = [
  [-1, 0],
  [2, 0.4],
  [8, 0.8],
  [20, 1],
] as const;
/**
 * How far the sun's colour goes toward a low sun's orange; how far the sky goes toward a golden hour's
 * peach while the sun is just up, and toward dusk blue once it has set.
 */
const WARM = [
  [0, 0.8],
  [5, 0.55],
  [12, 0.28],
  [30, 0],
] as const;
const GOLDEN = [
  [-2, 0],
  [3, 0.4],
  [8, 0.32],
  [18, 0],
] as const;
const DUSK = [
  [-12, 0.85],
  [-8, 0.6],
  [-1, 0.3],
  [3, 0],
] as const;
const LOW_SUN = new Color("#ff9447");
const GOLDEN_SKY = new Color("#ffd2a8");
const DUSK_SKY = new Color("#bccbea");
/** A low sun's key light never passes this multiple of the theme's, so walls facing it do not burn out. */
const SUN_CAP = 2.4;
/** The key light never comes from lower than this, so shadows stay on the field. */
const MIN_ELEVATION = 4;

/** How much of the sun's direct light reaches the ground through the reported sky. */
const COVER_DIRECT: Record<NonNullable<Metar["cover"]>, number> = { clear: 1, few: 1, scattered: 0.85, broken: 0.45, overcast: 0.1, obscured: 0.05 };
/** And how much light there is in all, under that sky. */
const COVER_LIGHT: Record<NonNullable<Metar["cover"]>, number> = { clear: 1, few: 1, scattered: 1, broken: 0.95, overcast: 0.88, obscured: 0.85 };

/** Visibility, metres, at which fog starts and is at its thickest. */
const CLEAR_VIS = 8000;
const THICK_VIS = 200;
/** The fog's near and far, in camera distances, at its thickest. */
const THICK_FOG = { near: 0.28, far: 2 };
/** Share of the low sun's change of colour the eye-level horizon takes. */
const HORIZON_WARMTH = 0.5;
/** The close views' haze at its thickest, as a share of the clear air's: ten kilometres come in to six hundred metres. */
const THICK_HAZE = 0.06;
/** Aircraft are lit to at least this share of their colour in the theme's own light, however dark it is. */
const AIRCRAFT_FLOOR = 0.85;
const MIST_DAY = new Color("#d3d7db");
const MIST_NIGHT = new Color("#1d2734");

const hex = (c: Color) => `#${c.getHexString()}`;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const luminance = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** 0 in good visibility to 1 in the thickest fog: by the log of the visibility, mist and haze never quite clear. */
export function fogAmount(m: Metar | null): number {
  if (!m) return 0;
  let a = m.visibilityM === null ? 0 : clamp01(Math.log(CLEAR_VIS / m.visibilityM) / Math.log(CLEAR_VIS / THICK_VIS));
  if (m.mist || m.haze) a = Math.max(a, 0.2);
  return a;
}

function sunLight(theme: SceneTheme, sun: SunPosition | null, m: Metar | null, fog: number): { light: SunLight; tint: Color } {
  const own = theme.lights;
  const base: SunLight = {
    azimuthDeg: own.sun.azimuthDeg,
    elevationDeg: own.sun.elevationDeg,
    color: own.sun.color,
    intensity: own.sun.intensity,
    sky: own.sky,
    groundBounce: own.groundBounce,
    hemisphere: own.hemisphere,
    aircraftGlow: 0,
    horizon: theme.eyeLevel.horizon,
    zenith: theme.eyeLevel.zenith,
  };
  if (theme.night || !sun) return { light: base, tint: new Color(1, 1, 1) };

  const sin = (deg: number) => Math.sin((deg * Math.PI) / 180);
  const ownDirect = own.sun.intensity * sin(own.sun.elevationDeg);
  const ownTotal = own.hemisphere + ownDirect;
  const cover = m?.cover ?? "clear";
  const wet = m?.precipitation ? { light: 0.97, moderate: 0.94, heavy: 0.88 }[m.precipitation.intensity] : 1;
  const dim = COVER_LIGHT[cover] * wet * (m?.thunder ? 0.9 : 1) * (1 - 0.12 * fog);
  const direct = table(DIRECT, sun.elevationDeg) * COVER_DIRECT[cover] * (1 - 0.9 * fog);
  const total = table(EXPOSURE, sun.elevationDeg) * dim * ownTotal;

  const elevation = Math.max(MIN_ELEVATION, sun.elevationDeg);
  const intensity = Math.min((ownDirect * direct * table(EXPOSURE, sun.elevationDeg) * dim) / sin(elevation), own.sun.intensity * SUN_CAP);
  const sunColor = new Color(own.sun.color).lerp(LOW_SUN, table(WARM, sun.elevationDeg));
  const skyColor = new Color(own.sky).lerp(DUSK_SKY, table(DUSK, sun.elevationDeg)).lerp(GOLDEN_SKY, table(GOLDEN, sun.elevationDeg));
  // Whatever the sun does not give, the sky does. Only the sky's hue shifts: its strength makes up
  // the brightness the tint takes away, so the exposure table alone sets how light the model is.
  const hemisphere = (total - ownDirect * direct * table(EXPOSURE, sun.elevationDeg) * dim) * (luminance(new Color(own.sky)) / luminance(skyColor));

  // What a horizontal surface receives now, against what it receives in the theme's own light, per
  // channel: the unlit page colour is scaled by it so it stays the ground's colour where they meet.
  const now = skyColor.clone().multiplyScalar(hemisphere).add(sunColor.clone().multiplyScalar(intensity * sin(elevation)));
  const ref = new Color(own.sky).multiplyScalar(own.hemisphere).add(new Color(own.sun.color).multiplyScalar(ownDirect));
  const tint = new Color(now.r / ref.r, now.g / ref.g, now.b / ref.b);
  // The sky dims as the page does (half as much as the ground in log terms); the horizon takes half
  // the sun's change of colour (the haze it fades into covers the whole far field, so the full shift
  // would dye the model), and overhead takes the fill's, each as a shift from the theme's own.
  const skyTint = new Color(Math.sqrt(tint.r), Math.sqrt(tint.g), Math.sqrt(tint.b));
  const shift = (from: Color, to: Color) => new Color(to.r / from.r, to.g / from.g, to.b / from.b);
  const ownHorizon = new Color(theme.eyeLevel.horizon);
  const horizon = ownHorizon.clone().lerp(ownHorizon.clone().multiply(shift(new Color(own.sun.color), sunColor)), HORIZON_WARMTH).multiply(skyTint);
  const zenith = new Color(theme.eyeLevel.zenith).multiply(shift(new Color(own.sky), skyColor)).multiply(skyTint);

  return {
    light: {
      azimuthDeg: sun.azimuthDeg,
      elevationDeg: elevation,
      color: hex(sunColor),
      intensity: direct > 0 ? intensity : 0,
      sky: hex(skyColor),
      groundBounce: own.groundBounce,
      hemisphere,
      // Only the dark makes up its loss; weather dims the aircraft with everything else.
      aircraftGlow: Math.max(0, AIRCRAFT_FLOOR - table(EXPOSURE, sun.elevationDeg)),
      horizon: hex(horizon),
      zenith: hex(zenith),
    },
    tint,
  };
}

function precipitation(m: Metar | null, background: Color): Precipitation | null {
  const p = m?.precipitation;
  if (!p) return null;
  const level = { light: 0, moderate: 1, heavy: 2 }[p.intensity];
  const dark = luminance(background) < 0.35;
  const wind = m.wind;
  // Carried downwind: toward the opposite of where the wind is from, faster in a stronger wind.
  const toward = wind && wind.directionDeg !== null ? ((wind.directionDeg + 180) * Math.PI) / 180 : 0;
  const speed = wind && wind.directionDeg !== null ? wind.speedKt : 0;
  const rate = p.kind === "rain" ? 0.004 : 0.008;
  const drift: [number, number] = [Math.sin(toward) * speed * rate, Math.cos(toward) * speed * rate];
  if (p.kind === "rain") {
    return { kind: "rain", count: [1800, 3600, 6000][level], color: dark ? "#a9bfdc" : "#4f5d70", opacity: dark ? 0.5 : 0.4, sizePx: 16, fallSeconds: 0.9, drift };
  }
  return { kind: "snow", count: [1500, 3000, 5000][level], color: dark ? "#f2f5fa" : "#8996a8", opacity: 0.85, sizePx: 4, fallSeconds: 7, drift };
}

/** The scene's light and weather for a theme, the sun's position (null: the theme's own light) and the airport's report. */
export function atmosphere(theme: SceneTheme, sun: SunPosition | null, metar: Metar | null): { sun: SunLight; weather: SceneWeather } {
  const fog = fogAmount(metar);
  const { light, tint } = sunLight(theme, sun, metar, fog);
  const page = new Color(theme.background);
  // The page (and the far field, fogged into it) dims half as much as the ground in log terms: a
  // lighter horizon, as at dusk, which keeps the chrome over it legible.
  const pageTint = new Color(Math.sqrt(tint.r), Math.sqrt(tint.g), Math.sqrt(tint.b));
  const lit = page.clone().multiply(pageTint);
  const mist = (theme.night ? MIST_NIGHT : MIST_DAY).clone().multiply(pageTint);
  const background = fog > 0 ? lit.clone().lerp(mist, 0.85 * fog) : lit;
  const own = theme.fog;
  return {
    sun: light,
    weather: {
      background: hex(background),
      fog: own && fog > 0 ? { near: own.near + (THICK_FOG.near - own.near) * fog, far: own.far + (THICK_FOG.far - own.far) * fog } : own,
      // On the log scale the fog amount is read on, as visibility is.
      haze: THICK_HAZE ** fog,
      precipitation: precipitation(metar, background),
      wind: metar?.wind ?? null,
    },
  };
}

/**
 * The colour behind the chrome's scrims (the header's fade, the labels' halo): the page's `page` where
 * the map shows, the scene's clear colour `scene` where the diorama covers it (`shown`, its opacity
 * over the map, 0 to 1), mixed in between as the browser composites the two, channel by channel in sRGB.
 */
export function backdropOver(page: string, scene: string, shown: number): string {
  const a = new Color(page).getHex();
  const b = new Color(scene).getHex();
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    out |= Math.round(from + (to - from) * shown) << shift;
  }
  return `#${out.toString(16).padStart(6, "0")}`;
}

/** Points read along a row by rowColour. */
const ROW_POINTS = 9;

/** The colour a row of RGBA pixels mostly shows: the median of each channel over points spread along it. */
export function rowColour(rgba: Uint8Array): string {
  const n = Math.floor(rgba.length / 4);
  const channels: number[][] = [[], [], []];
  for (let i = 0; i < ROW_POINTS; i++) {
    const at = Math.min(n - 1, Math.round(((i + 0.5) / ROW_POINTS) * n - 0.5)) * 4;
    for (let c = 0; c < 3; c++) channels[c].push(rgba[at + c]);
  }
  const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  return `#${channels.map((v) => median(v).toString(16).padStart(2, "0")).join("")}`;
}
