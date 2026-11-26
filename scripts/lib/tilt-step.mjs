/**
 * The journey smoke's rule for the 3D camera's tilt between two drawn frames (smoke-en-route-journey.mjs): no
 * step like the old snap back to Map (75 to 60 degrees at once). It is frame-rate aware: the share eases by the
 * time between drawn frames, so a slow device moves it farther in one frame, and that is held to the ease's pace.
 */

/** The share's ease all the way between flat and 3D, seconds: SHARE_EASE_S of src/lib/globe/en-route-journey.ts. */
export const SHARE_EASE_S = 1.2;
/** The most the tilt may change between two drawn frames close together, degrees. */
export const TILT_STEP_DEG = 12;
/** The map's tilt limit (MAX_PITCH): the most the flat shot and the 3D camera can be apart when the frames cannot tell. */
const MAX_PITCH = 78;
/** Leeway on the ease's pace: the share moves exactly gap / SHARE_EASE_S, so this only absorbs rounding. */
const PACE_TOL = 0.01;
/**
 * Over a slow frame the 3D camera's own framing moves a little too (the rig's ease), degrees. The journey's
 * flat shot's move is measured; with it, the software GL run's half-share frame was explained with 0.9 to spare.
 */
const RIG_DRIFT_DEG = 1;
/** The blend's steepest slope: shareBlend's at a share of a half. */
const STEEPEST = 1.5;

/** shareBlend of src/lib/globe/en-route-journey.ts. */
const blend = (share) => share * share * (3 - 2 * share);

/**
 * How far apart in tilt the journey's flat shot and the 3D camera's framing stand, from frames far enough into
 * 3D to tell (the map's tilt is the flat shot's moved toward the 3D camera's by the blend); the map's whole
 * tilt range when neither is.
 */
function span(...frames) {
  const known = frames.filter((f) => f.flatPitch != null && blend(f.share) >= 0.1).map((f) => Math.abs(f.pitch - f.flatPitch) / blend(f.share));
  return known.length ? Math.max(...known) : MAX_PITCH;
}

/**
 * Judges the tilt's change between two drawn frames `a` and `b`, each { at, share, pitch, flatPitch }: `at` the
 * time (ms) the share's ease stepped on for that frame, `share` the eased share, `pitch` the map's, `flatPitch`
 * the journey's flat shot's (null while the view is flat).
 *
 * - `paced`: the share moved no more than its ease's pace allows in the time between the two frames.
 * - `bound`: TILT_STEP_DEG whenever that time is short, so short the pace alone could not move the tilt more
 *   (`shortGapMs`, derived from the pace, the blend's steepest slope and the span), as on a device that keeps up;
 *   over a longer gap, what the share's own change explains through the blend plus the shots' own moves, if
 *   that is more.
 * - `ok`: paced, and the tilt's step within the bound.
 */
export function tiltStep(a, b) {
  const step = Math.abs(b.pitch - a.pitch);
  const gapMs = Math.max(0, b.at - a.at);
  const moved = Math.abs(b.share - a.share);
  const pace = (gapMs / 1000 / SHARE_EASE_S) * (1 + PACE_TOL) + 1e-9;
  const apart = span(a, b);
  const shortGapMs = ((TILT_STEP_DEG / (STEEPEST * apart)) * SHARE_EASE_S * 1000) / (1 + PACE_TOL);
  const flatMoved = a.flatPitch != null && b.flatPitch != null ? Math.abs(b.flatPitch - a.flatPitch) : 0;
  const explained = Math.abs(blend(b.share) - blend(a.share)) * apart + flatMoved + RIG_DRIFT_DEG;
  const bound = gapMs <= shortGapMs ? TILT_STEP_DEG : Math.max(TILT_STEP_DEG, explained);
  const paced = moved <= pace;
  return { ok: paced && step <= bound, paced, step, bound, gapMs, moved, pace, shortGapMs };
}
