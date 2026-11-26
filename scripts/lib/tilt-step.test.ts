import { describe, expect, it } from "vitest";
import { MAX_PITCH as MAX_PITCH_IN_APP } from "../../src/lib/globe/en-route";
import { SHARE_EASE_S as EASE_IN_APP, shareBlend } from "../../src/lib/globe/en-route-journey";
import { blend, judgeFrames, MAX_PITCH, SHARE_EASE_S, TILT_STEP_DEG, tiltStep } from "./tilt-step.mjs";

// Chase stands at 75 degrees; the journey's flat shot at 47.5 (as in the software GL run).
const frame = (ms: number, share: number, pitch: number) => ({ at: ms, share, pitch, flatPitch: 47.5 });
const pitch = (share: number) => 47.5 + (75 - 47.5) * shareBlend(share);

describe("tiltStep", () => {
  it("reads the app's own ease, blend and tilt limit", () => {
    expect(SHARE_EASE_S).toBe(EASE_IN_APP);
    expect(MAX_PITCH).toBe(MAX_PITCH_IN_APP);
    for (const s of [0, 0.1, 0.25, 0.5, 0.8, 1]) expect(blend(s)).toBe(shareBlend(s));
  });

  it("passes a 60 fps ease into the flat shot", () => {
    const share = 0.5 - 16.7 / 1200;
    expect(tiltStep(frame(1000, 0.5, pitch(0.5)), frame(1016.7, share, pitch(share))).ok).toBe(true);
  });

  it("holds frames drawn close together to 12 degrees, as before", () => {
    const judged = tiltStep(frame(1000, 1, 75), frame(1100, 1, 75 - TILT_STEP_DEG - 1));
    expect(judged.bound).toBe(TILT_STEP_DEG);
    expect(judged.ok).toBe(false);
  });

  it("derives the short gap from the ease's pace: no gap under it can explain more than 12 degrees", () => {
    const { shortGapMs } = tiltStep(frame(1, 1, 75), frame(1, 1, 75));
    // 12 degrees over a 27.5 degree span at the blend's steepest (1.5) is 0.29 of the share: 349 ms of the ease.
    expect(shortGapMs).toBeCloseTo((12 / (1.5 * 27.5)) * 1200, 6);
    const gap = 0.99 * shortGapMs;
    const share = 0.6 - gap / 1200;
    const just = tiltStep(frame(1, 0.6, pitch(0.6)), frame(1 + gap, share, pitch(share)));
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
    const judged = tiltStep(frame(1000, 1, 75), frame(1600, 0, 47.5));
    expect(judged.paced).toBe(false);
    expect(judged.ok).toBe(false);
  });

  it("fails a share that moves at all between frames drawn on the same tick", () => {
    expect(tiltStep(frame(1000, 0.5, pitch(0.5)), frame(1000, 0.49, pitch(0.49))).paced).toBe(false);
  });

  it("counts an ease started afresh in between as no time: a jump then fails", () => {
    expect(tiltStep(frame(60_000, 1, 75), frame(0, 1, 75)).gapMs).toBe(0);
    expect(tiltStep(frame(0, 1, 75), frame(60_000, 0, 47.5)).ok).toBe(false);
  });

  it("fails a tilt step over a slow frame the share does not explain", () => {
    const judged = tiltStep(frame(1000, 1, 75), frame(1600, 1, 60));
    expect(judged.bound).toBe(TILT_STEP_DEG);
    expect(judged.ok).toBe(false);
  });

  it("falls back to the map's whole tilt range while the view is flat", () => {
    const judged = tiltStep({ at: 1, share: 0, pitch: 40, flatPitch: null }, { at: 101, share: 0, pitch: 41, flatPitch: null });
    expect(judged.ok).toBe(true);
    expect(judged.shortGapMs).toBeCloseTo((12 / (1.5 * 78)) * 1200, 6);
  });
});

describe("judgeFrames", () => {
  it("passes a 60 fps ease all the way out of 3D", () => {
    const frames = Array.from({ length: 80 }, (_, k) => {
      const share = Math.max(0, 1 - (k * 16.7) / 1200);
      return frame(1000 + k * 16.7, share, pitch(share));
    });
    const { judged, worst } = judgeFrames(frames);
    expect(judged.every((j) => j.ok)).toBe(true);
    expect(worst?.ok).toBe(true);
  });

  it("fails a step spread over a few fast frames, as the old sampled check did", () => {
    // 18 degrees over three frames 17 ms apart, the share held: no neighbour nor pair two apart steps over 12, the window does.
    const frames = [frame(1000, 1, 75), frame(1017, 1, 69), frame(1034, 1, 63), frame(1051, 1, 57)];
    expect(frames.slice(1).every((f, k) => tiltStep(frames[k], f).ok)).toBe(true);
    const { worst } = judgeFrames(frames);
    expect(worst).toMatchObject({ ok: false, from: 0, to: 3 });
  });

  it("names nothing with no pair to judge", () => {
    expect(judgeFrames([frame(1, 1, 75)])).toEqual({ judged: [], worst: null });
  });
});
