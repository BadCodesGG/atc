/**
 * The journey smoke's rule for the 3D camera's tilt between drawn frames (smoke-en-route-journey.mjs): no step
 * like the old snap back to Map (75 to 60 degrees at once). Frame-rate aware: the share eases by the time
 * between drawn frames, so a slow frame may move it far, but never faster than the ease's own pace.
 */

/** The share's ease all the way between flat and 3D, seconds: SHARE_EASE_S of src/lib/globe/en-route-journey.ts. */
export const SHARE_EASE_S = 1.2;
/** The map's tilt limit: MAX_PITCH of src/lib/globe/en-route.ts. */
export const MAX_PITCH = 78;
/** The most the tilt may change between drawn frames close together, degrees. */
export const TILT_STEP_DEG = 12;
/** Frames this close on the ease's clock are judged as a pair too, not only neighbours: the old check's sampling interval, ms. */
export const WINDOW_MS = 300;
/** The share moves exactly gap / SHARE_EASE_S a step; this only absorbs floating-point rounding. */
const ROUNDING = 1e-6;
/**
 * The 3D camera's own framing may move its tilt this much over a slow frame (the rig's ease), degrees. Chase
 * holds its tilt: at a full share the recorded frames read 75 degrees to a millionth, so this is margin only.
 */
const RIG_DRIFT_DEG = 1;
/** shareBlend's steepest slope, at a share of a half. */
const BLEND_MAX_SLOPE = 1.5;

/** shareBlend of src/lib/globe/en-route-journey.ts. */
export const blend = (share) => share * share * (3 - 2 * share);

/**
 * How far apart in tilt the journey's flat shot and the 3D camera's framing stand, from the frames far enough
 * into 3D to tell (the map's tilt is the flat shot's moved toward the 3D camera's by the blend), at most the
 * map's whole tilt range, which is also the answer when neither frame can tell.
 */
function tiltApart(a, b) {
  const known = [a, b].filter((f) => f.flatPitch != null && blend(f.share) >= 0.1).map((f) => Math.abs(f.pitch - f.flatPitch) / blend(f.share));
  return Math.min(MAX_PITCH, known.length ? Math.max(...known) : MAX_PITCH);
}

/**
 * Judges the tilt's change from drawn frame `a` to a later one `b`, each { at, share, pitch, flatPitch }: `at`
 * the time (ms) the share's ease stepped on for that frame (0 before its first step), `share` the eased share,
 * `pitch` the map's, `flatPitch` the journey's flat shot's (null while the view is flat).
 *
 * - `paced`: the share moved no more than its ease's pace allows in the time between the two frames. An ease
 *   started afresh in between (its clock back to 0 or behind) counts as no time at all.
 * - `bound`: TILT_STEP_DEG whenever that time is short, so short the pace alone could not move the tilt more
 *   (`shortGapMs`: TILT_STEP_DEG over the blend's steepest slope times the tilt apart, in the ease's time);
 *   over a longer gap, what the share's own change explains through the blend, plus the flat shot's measured
 *   move and the rig's drift, if that is more.
 * - `ok`: paced, and the tilt's step within the bound.
 */
export function tiltStep(a, b) {
  const step = Math.abs(b.pitch - a.pitch);
  const fresh = a.at <= 0 || b.at < a.at;
  const gapMs = fresh ? 0 : b.at - a.at;
  const moved = Math.abs(b.share - a.share);
  const pace = gapMs / 1000 / SHARE_EASE_S + ROUNDING;
  const apart = tiltApart(a, b);
  const shortGapMs = (TILT_STEP_DEG / (BLEND_MAX_SLOPE * apart)) * SHARE_EASE_S * 1000;
  const flatMoved = a.flatPitch != null && b.flatPitch != null ? Math.abs(b.flatPitch - a.flatPitch) : 0;
  const explained = Math.abs(blend(b.share) - blend(a.share)) * apart + flatMoved + RIG_DRIFT_DEG;
  const bound = gapMs <= shortGapMs ? TILT_STEP_DEG : Math.max(TILT_STEP_DEG, explained);
  const paced = moved <= pace;
  return { ok: paced && step <= bound, paced, step, bound, gapMs, moved, pace, shortGapMs };
}

/**
 * Judges a run of drawn frames: each against the one before it, and against every earlier one within
 * WINDOW_MS on the ease's clock, so a step spread over a few fast frames is held as the old sampled check held
 * it. Returns every pair judged ({ from, to } indices with tiltStep's verdict) and the one to report: the
 * first that fails, else the one nearest its bound.
 */
export function judgeFrames(frames) {
  const judged = [];
  for (let to = 1; to < frames.length; to++) {
    const within = (from) => from === to - 1 || (frames[from].at > 0 && frames[to].at - frames[from].at >= 0 && frames[to].at - frames[from].at <= WINDOW_MS);
    for (let from = to - 1; from >= 0 && within(from); from--) {
      judged.push({ ...tiltStep(frames[from], frames[to]), from, to });
    }
  }
  const worst = judged.find((j) => !j.ok) ?? judged.toSorted((x, y) => y.step / y.bound - x.step / x.bound)[0] ?? null;
  return { judged, worst };
}
