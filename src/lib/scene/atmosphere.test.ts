import { Color } from "three";
import { describe, expect, it } from "vitest";
import { parseMetar } from "../metar";
import { atmosphere, backdropOver, rowColour } from "./atmosphere";
import { DIORAMA, NIGHT_OPS, SATELLITE } from "./theme";

const NOW = Date.UTC(2026, 9, 1, 12, 0);
const metar = (body: string) => parseMetar(`KATL 011153Z ${body}`, NOW);
const CLEAR = metar("10003KT 10SM FEW250 23/14 A3011");
const FOG = metar("00000KT 1/4SM FG VV002 14/14 A3001");
const MIST = metar("00000KT 3SM BR BKN010 14/14 A3001");
const RAIN = metar("18010KT 4SM RA BR OVC015 18/17 A2990");
const LIGHT_RAIN = metar("18010KT 6SM -RA OVC025 18/17 A2990");
const HEAVY_RAIN = metar("18010KT 2SM +RA BR OVC015 18/17 A2990");
const SNOW = metar("36008KT 2SM SN OVC010 M01/M02 A2990");

const high = { azimuthDeg: 200, elevationDeg: 50 };
const low = { azimuthDeg: 260, elevationDeg: 6 };
const night = { azimuthDeg: 0, elevationDeg: -30 };

const luminance = (hex: string) => {
  const c = new Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};
/** How bright a horizontal surface is lit: the sky's fill plus the sun's share at its elevation, each by its colour's luminance. */
const horizontal = (s: ReturnType<typeof atmosphere>["sun"]) => s.hemisphere * luminance(s.sky) + s.intensity * luminance(s.color) * Math.sin((s.elevationDeg * Math.PI) / 180);
const calibrated = (theme: typeof DIORAMA) =>
  theme.lights.hemisphere * luminance(theme.lights.sky) + theme.lights.sun.intensity * luminance(theme.lights.sun.color) * Math.sin((theme.lights.sun.elevationDeg * Math.PI) / 180);
const warmth = (hex: string) => {
  const c = new Color(hex);
  return c.r / Math.max(1e-6, c.b);
};

describe("the sun in the light and satellite themes", () => {
  it("comes from where the sun is", () => {
    const { sun } = atmosphere(DIORAMA, high, CLEAR);
    expect(sun.azimuthDeg).toBe(200);
    expect(sun.elevationDeg).toBe(50);
  });

  it("keeps the theme's own light, colour and calibration under a high sun in a clear sky", () => {
    for (const theme of [DIORAMA, SATELLITE]) {
      const { sun, weather } = atmosphere(theme, high, CLEAR);
      expect(horizontal(sun)).toBeCloseTo(calibrated(theme), 2);
      expect(sun.color).toBe(new Color(theme.lights.sun.color).getHexString().replace(/^/, "#"));
      expect(weather.background).toBe(theme.background);
    }
  });

  it("is warmer and dimmer low in the sky, and the page colour dims with it", () => {
    const noon = atmosphere(DIORAMA, high, CLEAR);
    const evening = atmosphere(DIORAMA, low, CLEAR);
    expect(warmth(evening.sun.color)).toBeGreaterThan(warmth(noon.sun.color) * 1.3);
    expect(horizontal(evening.sun)).toBeLessThan(horizontal(noon.sun));
    expect(luminance(evening.weather.background)).toBeLessThan(luminance(noon.weather.background));
  });

  it("gives no direct light below the horizon, and dims well toward dusk after dark", () => {
    const { sun } = atmosphere(SATELLITE, night, CLEAR);
    expect(sun.intensity).toBe(0);
    expect(horizontal(sun)).toBeGreaterThan(calibrated(SATELLITE) * 0.3);
    expect(horizontal(sun)).toBeLessThan(calibrated(SATELLITE) * 0.5);
    // Civil twilight sits between sunset and full dark.
    const twilight = atmosphere(SATELLITE, { azimuthDeg: 270, elevationDeg: -4 }, CLEAR).sun;
    expect(horizontal(twilight)).toBeGreaterThan(horizontal(sun));
    expect(horizontal(twilight)).toBeLessThan(horizontal(atmosphere(SATELLITE, low, CLEAR).sun));
  });

  it("keeps the aircraft legible after dark: their glow makes up what the light loses", () => {
    for (const theme of [DIORAMA, SATELLITE]) {
      expect(atmosphere(theme, high, CLEAR).sun.aircraftGlow).toBe(0);
      const dark = atmosphere(theme, night, CLEAR).sun;
      // What a lit aircraft shows of its paint: the light on it (as a share of the theme's) plus its glow.
      expect(horizontal(dark) / calibrated(theme) + dark.aircraftGlow).toBeGreaterThanOrEqual(0.8);
    }
    expect(atmosphere(NIGHT_OPS, night, CLEAR).sun.aircraftGlow).toBe(0);
  });

  it("is mostly hidden by an overcast and by fog, which turn the light to the sky", () => {
    const clear = atmosphere(DIORAMA, high, CLEAR).sun;
    for (const m of [RAIN, FOG]) {
      const sun = atmosphere(DIORAMA, high, m).sun;
      expect(sun.intensity).toBeLessThan(clear.intensity * 0.3);
      expect(sun.hemisphere).toBeGreaterThan(clear.hemisphere);
    }
  });

  it("is the theme's own when there is no position yet", () => {
    const { sun } = atmosphere(DIORAMA, null, null);
    expect(sun).toMatchObject({ azimuthDeg: DIORAMA.lights.sun.azimuthDeg, elevationDeg: DIORAMA.lights.sun.elevationDeg, intensity: DIORAMA.lights.sun.intensity, hemisphere: DIORAMA.lights.hemisphere });
  });
});

describe("the sky at eye level", () => {
  it("is the theme's own under a high sun in a clear sky, and at night ops", () => {
    for (const theme of [DIORAMA, SATELLITE]) {
      const { sun } = atmosphere(theme, high, CLEAR);
      expect(Math.abs(luminance(sun.horizon) - luminance(theme.eyeLevel.horizon))).toBeLessThan(0.03);
      expect(warmth(sun.horizon)).toBeCloseTo(warmth(theme.eyeLevel.horizon), 1);
      expect(Math.abs(luminance(sun.zenith) - luminance(theme.eyeLevel.zenith))).toBeLessThan(0.03);
    }
    expect(atmosphere(NIGHT_OPS, high, CLEAR).sun).toMatchObject({ horizon: NIGHT_OPS.eyeLevel.horizon, zenith: NIGHT_OPS.eyeLevel.zenith });
    expect(atmosphere(DIORAMA, null, CLEAR).sun).toMatchObject({ horizon: DIORAMA.eyeLevel.horizon, zenith: DIORAMA.eyeLevel.zenith });
  });

  it("takes the low sun's colour: a warmer, dimmer horizon, and darker still after sunset", () => {
    const noon = atmosphere(DIORAMA, high, CLEAR).sun;
    const evening = atmosphere(DIORAMA, low, CLEAR).sun;
    const dark = atmosphere(DIORAMA, night, CLEAR).sun;
    expect(warmth(evening.horizon)).toBeGreaterThan(warmth(noon.horizon) * 1.05);
    expect(luminance(evening.horizon)).toBeLessThan(luminance(noon.horizon));
    expect(luminance(dark.horizon)).toBeLessThan(luminance(evening.horizon));
    expect(luminance(dark.zenith)).toBeLessThan(luminance(noon.zenith));
  });
});

describe("night ops", () => {
  it("stays night whatever the sun is doing", () => {
    for (const position of [high, low, night]) {
      const { sun, weather } = atmosphere(NIGHT_OPS, position, CLEAR);
      expect(sun).toMatchObject({ azimuthDeg: 300, elevationDeg: 60, intensity: NIGHT_OPS.lights.sun.intensity, hemisphere: NIGHT_OPS.lights.hemisphere });
      expect(weather.background).toBe(NIGHT_OPS.background);
    }
  });
});

describe("fog from the visibility", () => {
  it("is the theme's own in good visibility or with no report", () => {
    expect(atmosphere(DIORAMA, high, CLEAR).weather.fog).toEqual(DIORAMA.fog);
    expect(atmosphere(NIGHT_OPS, high, null).weather.fog).toEqual(NIGHT_OPS.fog);
  });

  it("closes in as the visibility drops, so the far field fades before the near one", () => {
    const theme = atmosphere(DIORAMA, high, CLEAR).weather.fog!;
    const mist = atmosphere(DIORAMA, high, MIST).weather.fog!;
    const fog = atmosphere(DIORAMA, high, FOG).weather.fog!;
    expect(mist.far).toBeLessThan(theme.far);
    expect(fog.far).toBeLessThan(mist.far);
    expect(fog.near).toBeLessThan(mist.near);
    // In a quarter mile of fog the framed field stays readable: its middle (one camera distance away)
    // under half hidden, the near field clearer still, the far edge (1.5 distances) more hidden.
    const hidden = (d: number) => Math.min(1, Math.max(0, (d - fog.near) / (fog.far - fog.near)));
    expect(hidden(1)).toBeGreaterThan(0.2);
    expect(hidden(1)).toBeLessThan(0.5);
    expect(hidden(0.7)).toBeLessThan(hidden(1) - 0.15);
    expect(hidden(1.5)).toBeGreaterThan(hidden(1) + 0.15);
  });

  it("closes in the eye-level haze of the close camera views too, in every theme", () => {
    for (const theme of [DIORAMA, NIGHT_OPS, SATELLITE]) {
      expect(atmosphere(theme, high, CLEAR).weather.haze).toBe(1);
      expect(atmosphere(theme, high, null).weather.haze).toBe(1);
      const mist = atmosphere(theme, high, MIST).weather.haze;
      const fog = atmosphere(theme, high, FOG).weather.haze;
      expect(mist).toBeLessThan(1);
      expect(fog).toBeLessThan(mist);
      // A quarter mile (400 m) of fog: the clear air's haze, 9 to 12 km, comes in to two to three and a half times that.
      expect(fog * theme.eyeLevel.fog.far).toBeGreaterThan(800);
      expect(fog * theme.eyeLevel.fog.far).toBeLessThan(1400);
    }
  });

  it("greys the page colour in the light themes and lifts it in night ops", () => {
    expect(luminance(atmosphere(SATELLITE, high, FOG).weather.background)).toBeGreaterThan(luminance(SATELLITE.background));
    expect(luminance(atmosphere(NIGHT_OPS, high, FOG).weather.background)).toBeGreaterThan(luminance(NIGHT_OPS.background));
  });
});

describe("rain and snow", () => {
  it("are absent without precipitation at the field", () => {
    expect(atmosphere(DIORAMA, high, CLEAR).weather.precipitation).toBeNull();
    expect(atmosphere(DIORAMA, high, MIST).weather.precipitation).toBeNull();
  });

  it("thicken with the reported intensity, and snow falls slower than rain", () => {
    const light = atmosphere(NIGHT_OPS, high, LIGHT_RAIN).weather.precipitation!;
    const moderate = atmosphere(NIGHT_OPS, high, RAIN).weather.precipitation!;
    const heavy = atmosphere(NIGHT_OPS, high, HEAVY_RAIN).weather.precipitation!;
    expect(light.count).toBeLessThan(moderate.count);
    expect(moderate.count).toBeLessThan(heavy.count);
    const snow = atmosphere(NIGHT_OPS, high, SNOW).weather.precipitation!;
    expect(snow.kind).toBe("snow");
    expect(snow.fallSeconds).toBeGreaterThan(moderate.fallSeconds * 3);
  });

  it("are drawn to stand out from the page: dark on the paper, light in the night", () => {
    expect(luminance(atmosphere(DIORAMA, high, RAIN).weather.precipitation!.color)).toBeLessThan(luminance(DIORAMA.background) - 0.3);
    expect(luminance(atmosphere(NIGHT_OPS, high, RAIN).weather.precipitation!.color)).toBeGreaterThan(luminance(NIGHT_OPS.background) + 0.2);
  });

  it("drift downwind", () => {
    // A south wind (from 180) carries the drops north: +y on the map.
    const [east, north] = atmosphere(NIGHT_OPS, high, RAIN).weather.precipitation!.drift;
    expect(north).toBeGreaterThan(0);
    expect(Math.abs(east)).toBeLessThan(1e-9);
  });
});

describe("backdropOver", () => {
  it("is the page where the map shows, the scene's clear colour where the diorama covers it, and mixed as the browser composites between", () => {
    expect(backdropOver("#f4f3ef", "#a3acbf", 0)).toBe("#f4f3ef");
    expect(backdropOver("#f4f3ef", "#a3acbf", 1)).toBe("#a3acbf");
    // The stage's opacity blends in sRGB, so the mix is the plain average of the channels.
    expect(backdropOver("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(backdropOver("#204060", "#6080a0", 0.25)).toBe("#305070");
  });
});

describe("rowColour", () => {
  it("is the colour most of a row of pixels shows, so an aircraft or a roof crossing it does not change it", () => {
    // Ten RGBA pixels of #a3acbd with two of an aircraft's white and one of a dark roof among them.
    const px = (r: number, g: number, b: number) => [r, g, b, 255];
    const row = Uint8Array.from([
      ...px(0xa3, 0xac, 0xbd), ...px(255, 255, 255), ...px(0xa3, 0xac, 0xbd), ...px(0xa3, 0xac, 0xbd), ...px(20, 20, 20),
      ...px(0xa3, 0xac, 0xbd), ...px(0xa3, 0xac, 0xbd), ...px(255, 255, 255), ...px(0xa3, 0xac, 0xbd), ...px(0xa3, 0xac, 0xbd),
    ]);
    expect(rowColour(row)).toBe("#a3acbd");
  });
});
