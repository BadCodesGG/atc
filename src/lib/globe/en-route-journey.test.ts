import { describe, expect, it } from "vitest";
import { arrivalCamera, blendPlacement, enRouteOffered, enRouteShare, FALLBACK_NOTICE, FLAT_BY_S, FrameWatch, mapCamera, SHARE_EASE_S, SHARE_FROM, ShareEase, shareReach, SLOW_FOR_S } from "./en-route-journey";
import type { EnRoutePlacement } from "./en-route";

/** Feeds `watch` frames at `fps` for `seconds` from `from` ms; returns whether it called for Map, and the time it ended. */
function run(watch: FrameWatch, fps: number, seconds: number, from = 0): { slow: boolean; at: number } {
  let slow = false;
  let at = from;
  for (let i = 1; i <= Math.round(fps * seconds); i++) {
    at = from + (i * 1000) / fps;
    slow = watch.frame(at) || slow;
  }
  return { slow, at };
}

describe("FrameWatch: a frame rate that stays low", () => {
  it("calls for Map once the frame rate has stayed under about 20 fps for a few seconds", () => {
    const watch = new FrameWatch();
    expect(run(watch, 10, SLOW_FOR_S).slow).toBe(false);
    expect(run(new FrameWatch(), 10, SLOW_FOR_S + 1.5).slow).toBe(true);
    expect(run(new FrameWatch(), 3, 8).slow).toBe(true);
  });

  it("calls for Map on a device that draws one frame every 3 s, after a few seconds of it", () => {
    expect(run(new FrameWatch(), 1 / 3, 6).slow).toBe(false);
    expect(run(new FrameWatch(), 1 / 3, 9).slow).toBe(true);
  });

  it("forgives one long stall on a camera that otherwise keeps up", () => {
    const watch = new FrameWatch();
    const first = run(watch, 30, 5);
    expect(watch.frame(first.at + 3_000)).toBe(false);
    expect(run(watch, 30, 10, first.at + 3_000).slow).toBe(false);
  });

  it("leaves a camera that keeps up alone, however long", () => {
    expect(run(new FrameWatch(), 30, 60).slow).toBe(false);
    expect(run(new FrameWatch(), 22, 60).slow).toBe(false);
  });

  it("forgives a stutter shorter than that (the terrain loading)", () => {
    const watch = new FrameWatch();
    const first = run(watch, 8, 2.5);
    const then = run(watch, 40, 2, first.at);
    const again = run(watch, 8, 2.5, then.at);
    expect(first.slow || then.slow || again.slow).toBe(false);
  });

  it("does not count a hidden tab's pause as slow, and starts over after it, even when it was already counting low", () => {
    const watch = new FrameWatch();
    const before = run(watch, 10, 3);
    // The tab is hidden for a minute (the page's visibilitychange resets the watch), then shown again at a good rate.
    watch.reset();
    const after = run(watch, 60, 10, before.at + 60_000);
    expect(before.slow || after.slow).toBe(false);
  });

  it("starts over when reset (a camera or theme switch)", () => {
    const watch = new FrameWatch();
    const first = run(watch, 10, 3.5);
    watch.reset();
    expect(first.slow || run(watch, 10, 3.5, first.at).slow).toBe(false);
  });
});

describe("FALLBACK_NOTICE: what the card says on the way back to Map", () => {
  it("says why, for a WebGL failure and for a frame rate that stayed low", () => {
    expect(FALLBACK_NOTICE.webgl).toMatch(/not available/);
    expect(FALLBACK_NOTICE.slow).toMatch(/could not keep up/);
  });

  it("says so in a short line that names the Map it returns to", () => {
    for (const notice of Object.values(FALLBACK_NOTICE)) {
      expect(notice.length).toBeLessThan(80);
      expect(notice).toMatch(/back on Map\.$/);
      expect(notice).not.toMatch(/—/);
    }
  });
});

describe("shareReach: where an airport's band reaches the 3D camera", () => {
  it("runs out to the distance the share is all 3D from", () => {
    const reach = shareReach(band);
    expect(reach.far).toBe(band.far * SHARE_FROM);
    expect(enRouteShare(reach.far, band)).toBe(1);
    expect(reach.near).toBe(band.near);
  });
});

describe("arrivalCamera: the camera the destination's Diorama opens in at the Handover", () => {
  it("is Approach when the Diorama offers it for the flight", () => {
    expect(arrivalCamera(["orbit", "tower", "drone", "approach"])).toBe("approach");
  });

  it("is Orbit otherwise", () => {
    expect(arrivalCamera(["orbit", "tower", "drone"])).toBe("orbit");
    expect(arrivalCamera(["orbit"])).toBe("orbit");
  });
});

describe("mapCamera: the camera the World map shows for the one chosen on the card", () => {
  it("holds a 3D camera chosen in the origin's Diorama until the map takes the flight", () => {
    expect(mapCamera("origin", "chase")).toBe("map");
    expect(mapCamera("map", "chase")).toBe("chase");
  });

  it("is Map once the destination's Diorama has the flight, and Map when Map is chosen", () => {
    expect(mapCamera("destination", "top")).toBe("map");
    expect(mapCamera("arrived", "side")).toBe("map");
    expect(mapCamera("map", "map")).toBe("map");
  });

  it("is offered from the origin's Diorama until the destination's has the flight", () => {
    expect(enRouteOffered("origin")).toBe(true);
    expect(enRouteOffered("map")).toBe(true);
    expect(enRouteOffered("destination")).toBe(false);
    expect(enRouteOffered("arrived")).toBe(false);
  });
});

describe("ShareEase: the share the view takes, eased over time", () => {
  it("starts where it is first asked, then moves toward a new target at an even pace, arriving exactly", () => {
    const ease = new ShareEase();
    expect(ease.step(0, 0)).toBe(0);
    // Frames a tenth of a second apart.
    const at = (t: number) => {
      let s = 0;
      for (let ms = 100; ms <= t * 1000; ms += 100) s = ease.step(1, ms);
      return s;
    };
    expect(at(SHARE_EASE_S / 2)).toBeCloseTo(0.5, 6);
    const ease2 = new ShareEase();
    ease2.step(0, 0);
    let s = 0;
    for (let ms = 100; ms <= SHARE_EASE_S * 2000; ms += 100) s = ease2.step(1, ms);
    expect(s).toBe(1);
  });

  it("follows a target that moves back the other way from where it got to, with no step", () => {
    const ease = new ShareEase();
    ease.step(1, 0);
    const out = ease.step(0, 250);
    expect(out).toBeCloseTo(1 - 0.25 / SHARE_EASE_S, 6);
    const back = ease.step(1, 350);
    expect(back).toBeCloseTo(out + 0.1 / SHARE_EASE_S, 6);
  });

  it("arrives back on Map in its time on a device that draws one frame every 3 s", () => {
    const ease = new ShareEase();
    ease.step(1, 0);
    expect(ease.step(0, 3_000)).toBe(0);
    const half = new ShareEase();
    half.step(1, 0);
    expect(half.step(0, 600)).toBeCloseTo(0.5, 6);
  });

  it("leaves the frames time to finish a return to Map before the timer does, and lands on Map within 2 s", () => {
    expect(FLAT_BY_S).toBeGreaterThan(SHARE_EASE_S);
    expect(FLAT_BY_S).toBeLessThanOrEqual(2);
  });

  it("does not move on the first frame after the page was hidden, then eases on from there", () => {
    const ease = new ShareEase();
    ease.step(0, 0);
    const before = ease.step(1, 120);
    expect(before).toBeCloseTo(0.1, 6);
    ease.pause();
    expect(ease.step(1, 60_000)).toBeCloseTo(before, 6);
    expect(ease.step(1, 60_120)).toBeCloseTo(0.2, 6);
  });

  it("still arrives in its time on a device that draws a frame or two a second", () => {
    const ease = new ShareEase();
    ease.step(1, 0);
    expect(ease.step(0, 700)).toBeCloseTo(1 - 0.7 / SHARE_EASE_S, 6);
    expect(ease.step(0, 1_400)).toBe(0);
  });
});

describe("blendPlacement: the flat Map shot eased into the 3D camera", () => {
  const flat: EnRoutePlacement = { center: { latitude: 35, longitude: -80 }, elevationM: 0, distanceM: 40_000, bearingDeg: 350, pitchDeg: 50 };
  const chase: EnRoutePlacement = { center: { latitude: 35.2, longitude: -80.2 }, elevationM: 3000, distanceM: 240, bearingDeg: 10, pitchDeg: 75 };

  it("is the flat shot at 0 and the 3D camera at 1", () => {
    expect(blendPlacement(flat, chase, 0)).toEqual(flat);
    expect(blendPlacement(flat, chase, 1)).toEqual(chase);
  });

  it("turns the short way round, closes in even in scale, and moves the point looked at between the two", () => {
    const mid = blendPlacement(flat, chase, 0.5);
    expect(mid.bearingDeg).toBeCloseTo(0, 6);
    expect(mid.distanceM).toBeCloseTo(Math.sqrt(40_000 * 240), 6);
    expect(mid.pitchDeg).toBeCloseTo(62.5, 6);
    expect(mid.elevationM).toBeCloseTo(1500, 6);
    expect(mid.center.latitude).toBeCloseTo(35.1, 6);
    expect(mid.center.longitude).toBeCloseTo(-80.1, 6);
  });
});

const band = { near: 10_000, far: 32_000 };

describe("enRouteShare: how much of the 3D camera the view takes, by the Journey's own shot", () => {
  it("is all 3D well away from the band, and none of it inside the band", () => {
    expect(enRouteShare(400_000, band)).toBe(1);
    expect(enRouteShare(band.far * SHARE_FROM, band)).toBe(1);
    expect(enRouteShare(band.far, band)).toBe(0);
    expect(enRouteShare(20_000, band)).toBe(0);
    expect(enRouteShare(band.near, band)).toBe(0);
  });

  it("eases between the two, never stepping, and only grows with the distance", () => {
    let last = 0;
    for (let d = band.far; d <= band.far * SHARE_FROM; d *= 1.01) {
      const s = enRouteShare(d, band);
      expect(s).toBeGreaterThanOrEqual(last);
      expect(s - last).toBeLessThan(0.02);
      last = s;
    }
  });

  it("is all 3D with no band to hand into (no Diorama at this end)", () => {
    expect(enRouteShare(5_000, null)).toBe(1);
  });
});
