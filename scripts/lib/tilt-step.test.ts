import { describe, expect, it } from "vitest";
import { SHARE_EASE_S as EASE_IN_APP } from "../../src/lib/globe/en-route-journey";
import { SHARE_EASE_S, TILT_STEP_DEG, tiltStep } from "./tilt-step.mjs";

// Chase stands at 75 degrees; the journey's flat shot at 47.5 (as in the software GL run).
const at = (ms: number, share: number, pitch: number) => ({ at: ms, share, pitch, flatPitch: 47.5 });
const blend = (s: number) => s * s * (3 - 2 * s);
const pitch = (share: number) => 47.5 + (75 - 47.5) * blend(share);

describe("tiltStep", () => {
  it("reads the app's own ease", () => {
    expect(SHARE_EASE_S).toBe(EASE_IN_APP);
  });

  it("passes a 60 fps ease into the flat shot", () => {
    const share = 0.5 - 16.7 / 1200;
    expect(tiltStep(at(1000, 0.5, pitch(0.5)), at(1016.7, share, pitch(share))).ok).toBe(true);
  });

  it("holds frames drawn close together to 12 degrees, as before", () => {
    const judged = tiltStep(at(1000, 1, 75), at(1100, 1, 75 - TILT_STEP_DEG - 1));
    expect(judged.bound).toBe(TILT_STEP_DEG);
    expect(judged.ok).toBe(false);
  });

  it("derives the short gap from the ease's pace: no gap under it can explain more than 12 degrees", () => {
    const { shortGapMs } = tiltStep(at(0, 1, 75), at(0, 1, 75));
    // 12 degrees over a 27.5 degree span at the blend's steepest (1.5) is 0.29 of the share: 349 ms of the ease, less the pace's leeway.
    expect(shortGapMs).toBeCloseTo(((12 / (1.5 * 27.5)) * 1200) / 1.01, 0);
    const share = 0.6 - shortGapMs / 1200;
    const just = tiltStep(at(0, 0.6, pitch(0.6)), at(shortGapMs, share, pitch(share)));
    expect(just.bound).toBe(TILT_STEP_DEG);
    expect(just.ok).toBe(true);
  });

  it("passes the software GL run's slow frame that eased the share half way, by what that explains", () => {
    // Recorded: share 1 to 0.486 over a drawn frame 733 ms long, 14.1 degrees, the flat shot moving 0.57.
    const judged = tiltStep(
      { at: 57624.1, share: 1, pitch: 74.99999964035348, flatPitch: 47.33047177224721 },
      { at: 58357.4, share: 0.4856068891959751, pitch: 60.865028518489915, flatPitch: 47.899898357439646 },
    );
    expect(judged.step).toBeGreaterThan(TILT_STEP_DEG);
    expect(judged.ok).toBe(true);
  });

  it("fails a share that jumps faster than its ease, however slow the frame", () => {
    const judged = tiltStep(at(1000, 1, 75), at(1600, 0, 47.5));
    expect(judged.paced).toBe(false);
    expect(judged.ok).toBe(false);
  });

  it("fails a share that moves at all between frames drawn on the same tick", () => {
    expect(tiltStep(at(1000, 0.5, pitch(0.5)), at(1000, 0.49, pitch(0.49))).paced).toBe(false);
  });

  it("fails a tilt step over a slow frame the share does not explain", () => {
    const judged = tiltStep(at(1000, 1, 75), at(1600, 1, 60));
    expect(judged.bound).toBe(TILT_STEP_DEG);
    expect(judged.ok).toBe(false);
  });

  it("falls back to the map's whole tilt range while the view is flat", () => {
    const judged = tiltStep({ at: 0, share: 0, pitch: 40, flatPitch: null }, { at: 100, share: 0, pitch: 41, flatPitch: null });
    expect(judged.ok).toBe(true);
    expect(judged.shortGapMs).toBeCloseTo(((12 / (1.5 * 78)) * 1200) / 1.01, 0);
  });
});
