import { describe, expect, it } from "vitest";
import { RUNWAY_CONTRAST, THEMES } from "./theme";

/** WCAG relative luminance of an sRGB hex colour, computed here rather than taken from the module. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

describe("every theme's runway", () => {
  it("asks for a contrast a reader can see, not a token one", () => {
    expect(RUNWAY_CONTRAST).toBeGreaterThanOrEqual(1.3);
  });

  it.each(Object.entries(THEMES))("in %s is clearly darker than the taxiway pavement", (_, theme) => {
    const { runway, taxiway } = theme.surfaces;
    expect(luminance(runway)).toBeLessThan(luminance(taxiway));
    expect(contrast(runway, taxiway)).toBeGreaterThanOrEqual(RUNWAY_CONTRAST);
  });

  it.each(Object.entries(THEMES))("in %s keeps its unlit edge fixtures visible on it", (_, theme) => {
    // By day the edge lights are dots in the fixtures' colour along the runway's edge.
    if (theme.night) return;
    expect(contrast(theme.surfaces.runway, theme.fixtures.color)).toBeGreaterThanOrEqual(1.15);
  });
});
