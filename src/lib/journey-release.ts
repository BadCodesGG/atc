import { whenLost } from "./journey-arrival";
import type { JourneyStage } from "./journey-follow";

/**
 * When a journey ends. The reader ends it, by what they do (releasesJourney), or the flight does, by
 * arriving; nothing the page infers from the camera's follow ends it. The follow is the diorama's camera
 * on the journey's flight, and it is cleared by things that are not the reader letting go (a scene
 * rebuilt for a theme, a Viewer remounted by a hand between airports, a frame with no fix, a camera
 * mode), so a journey that ended whenever the follow was not its flight's ended at all of them.
 */

/** What the reader did to the view or the selection. */
export type ReaderAction =
  /** Follow toggled off, on the flight card or the journey card's Stop. */
  | { kind: "unfollow" }
  /** Follow turned on for a flight. */
  | { kind: "follow"; id: string }
  /** A flight picked (a click, a row of the movements list, a search result), or none: a click on empty ground. */
  | { kind: "pick"; id: string | null }
  /** The view slid away from the flight (a drag, a key pan, a place picked in the search). */
  | { kind: "slide" }
  /** An airport picked (`to`), while `here` is shown: the one shown again goes nowhere. */
  | { kind: "airport"; to: string; here: string }
  /** Reset view; in a camera mode it only goes back to the orbit. */
  | { kind: "reset"; inMode: boolean };

/** Whether the reader's `action` ends the journey of `journeyHex` (null with none, which has nothing to end). */
export function releasesJourney(action: ReaderAction, journeyHex: string | null): boolean {
  if (journeyHex === null) return false;
  switch (action.kind) {
    case "follow":
    case "pick":
      return action.id !== journeyHex;
    case "airport":
      return action.to !== action.here;
    case "reset":
      return !action.inMode;
    default:
      return true;
  }
}

/**
 * Whether the follow, found cleared while a journey is on a diorama, goes back on the journey's flight:
 * once the flight is drawn there, with no camera mode or map in charge of the view. Whatever the reader
 * let go of ended the journey when they did it (releasesJourney), so a follow cleared with the journey
 * still running was not theirs to clear.
 */
export function restoresFollow(state: {
  journey: { hex: string; stage: JourneyStage } | null;
  followedId: string | null;
  /** The journey's flight is in this diorama's feed. */
  drawn: boolean;
  cameraActive: boolean;
  mapLeads: boolean;
}): boolean {
  const { journey } = state;
  return journey !== null && journey.stage !== "map" && state.followedId === null && state.drawn && !state.cameraActive && !state.mapLeads;
}

/**
 * What the frame loop does about a journey in a diorama this frame: put the follow back (restoresFollow),
 * and judge a flight gone from every feed (whenLost). The second does not look at the follow: a journey
 * whose follow was cleared while its flight is absent (a fresh destination Viewer during a feed gap, a theme
 * rebuild) has nothing to restore and must still arrive or be let go, or its card stays empty for good.
 */
export function journeyFrame(state: {
  journey: { hex: string; stage: JourneyStage; /** How long the flight has been missing from every feed, ms of the feed's clock. */ lostMs: number } | null;
  followedId: string | null;
  drawn: boolean;
  onGround: boolean;
  cameraActive: boolean;
  mapLeads: boolean;
}): { restore: boolean; lost: ReturnType<typeof whenLost> } {
  const { journey } = state;
  return { restore: restoresFollow(state), lost: journey ? whenLost({ stage: journey.stage, lostMs: journey.lostMs, onGround: state.onGround }) : "hold" };
}
