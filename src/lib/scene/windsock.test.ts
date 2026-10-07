import { describe, expect, it } from "vitest";
import type { Wind } from "../metar";
import { windsockPose } from "./windsock";

const wind = (directionDeg: number | null, speedKt: number, extra: Partial<Wind> = {}): Wind => ({ directionDeg, speedKt, gustKt: null, variable: false, range: null, ...extra });

describe("windsockPose", () => {
  it("points downwind: a wind from the west streams the sock east", () => {
    expect(windsockPose(wind(270, 10)).headingDeg).toBe(90);
    expect(windsockPose(wind(30, 10)).headingDeg).toBe(210);
  });

  it("fills a stripe every 3 knots, standing straight out at 15", () => {
    expect(windsockPose(wind(270, 15)).fill).toBe(1);
    expect(windsockPose(wind(270, 30)).fill).toBe(1);
    expect(windsockPose(wind(270, 6)).fill).toBeCloseTo(0.4);
    expect(windsockPose(wind(270, 15)).droopDeg).toBe(0);
  });

  it("droops more the lighter the wind, and hangs almost straight down in a calm", () => {
    const calm = windsockPose(wind(null, 0));
    const light = windsockPose(wind(270, 4));
    const fresh = windsockPose(wind(270, 10));
    expect(calm.droopDeg).toBeGreaterThan(75);
    expect(light.droopDeg).toBeLessThan(calm.droopDeg);
    expect(fresh.droopDeg).toBeLessThan(light.droopDeg);
  });

  it("takes the middle of a reported variable arc, and swings with the gusts", () => {
    expect(windsockPose(wind(270, 12, { range: [240, 300] })).headingDeg).toBe(90);
    expect(windsockPose(wind(350, 12, { range: [330, 30] })).headingDeg).toBe(180);
    expect(windsockPose(wind(270, 8, { gustKt: 20 })).gustFill).toBe(1);
    expect(windsockPose(wind(270, 8)).gustFill).toBeCloseTo(8 / 15);
  });

  it("hangs limp with no report", () => {
    expect(windsockPose(null)).toMatchObject({ fill: 0, gustFill: 0 });
  });
});
