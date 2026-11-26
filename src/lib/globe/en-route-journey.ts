import { turn, wrap360 } from "../geo";
import type { JourneyStage } from "../journey-follow";
import type { CameraMode } from "../scene/cameras";
import type { EnRouteCamera, EnRoutePlacement } from "./en-route";
import type { Band } from "./handover";

/**
 * How the En-route view joins the Journey (CONTEXT.md): when its chosen 3D camera has the World map, how it
 * gives way to the Handover at both ends, and when it gives up and returns to Map. Pure, so each rule is
 * tested on its own; the map (globe-map.ts) and the page (atc-app.tsx) only carry them out.
 */

/** The 3D camera is all there from this many times the Handover band's outer distance out. */
export const SHARE_FROM = 2.5;

/**
 * How much of the chosen 3D camera the view is to take (0 to 1), by the distance of the Journey's own Map
 * shot (the camera the Handover reads): none of it inside the Handover `band`, where the flat map and the
 * Diorama crossfade on one camera; all of it from SHARE_FROM times the band's outer edge out; even in log
 * distance between, as the band itself is. So leaving the origin the 3D camera takes over once the flight is
 * out of the Diorama, and arriving it eases into the Journey's own shot before the Handover begins. With no
 * band (no Diorama at this end) it is all 3D. It is the target ShareEase moves the share toward; the view
 * then takes shareBlend of that share, so the one smoothing eases it in log distance and in time alike.
 */
export function enRouteShare(distanceM: number, band: Band | null): number {
  if (!band) return 1;
  return Math.min(1, Math.max(0, Math.log(distanceM / band.far) / Math.log(SHARE_FROM)));
}

/**
 * How far the view is into the 3D camera for a share (0 to 1): the share smoothed at both ends. The share is
 * even in log distance (enRouteShare) and moved at an even pace in time (ShareEase), and this is the one
 * smoothing on top, in both places the view reads it (the camera's blendPlacement and the Handover's
 * crossfade, both through EnRouteController.blend).
 */
export const shareBlend = (share: number): number => share * share * (3 - 2 * share);

/** The stretch round an airport where its Handover band reaches the 3D camera: out to SHARE_FROM times the band's outer edge. */
export const shareReach = (band: Band): Band => ({ near: band.near, far: band.far * SHARE_FROM });

/**
 * The camera the World map shows for the one chosen on the Journey card: a 3D camera chosen while the flight
 * is still in its origin's Diorama is held there and takes over once the map has the flight; once the
 * destination's Diorama has it, the map under it is flat again.
 */
export const mapCamera = (stage: JourneyStage, chosen: EnRouteCamera): EnRouteCamera => (stage === "map" ? chosen : "map");

/** The camera the destination's Diorama opens in when the Handover gives it the flight: Approach when it offers one for the flight (cameraModes), else Orbit. */
export const arrivalCamera = (available: readonly CameraMode[]): CameraMode => (available.includes("approach") ? "approach" : "orbit");

/** Whether the Journey card offers the cameras: from the origin's Diorama (a pick there waits for the map) until the destination's has the flight. */
export const enRouteOffered = (stage: JourneyStage): boolean => stage === "origin" || stage === "map";

/** How long the share takes to go all the way between flat and 3D, seconds: at an even pace, then smoothed by shareBlend. */
export const SHARE_EASE_S = 1.2;
/**
 * A return to Map the frames have not finished by this long after it began, seconds, is finished at once by a
 * timer (globe-map.ts): a device drawing a frame every few seconds still lands on Map in about this time.
 */
export const RETURN_TO_MAP_S = 1.6;

/**
 * The share of the 3D camera the view takes, moved toward its target at an even pace (all the way in
 * SHARE_EASE_S of real time, however far apart the frames), so a target that steps (a camera picked, the
 * Handover band changing with the airport, a fallback) never steps the camera on a device that keeps up, and
 * arrives exactly. Only the time a page was hidden (resume) is not counted: its first frame back does not move.
 */
export class ShareEase {
  private value: number | null = null;
  private at = 0;
  private resumed = false;

  /** The share at `now` (ms), moved toward `target`; the first step starts at the target. */
  step(target: number, now: number): number {
    const skip = this.resumed;
    this.resumed = false;
    if (this.value === null) {
      this.value = target;
      this.at = now;
      return target;
    }
    const dt = skip ? 0 : Math.max(0, (now - this.at) / 1000);
    this.at = now;
    const room = dt / SHARE_EASE_S;
    this.value = target > this.value ? Math.min(target, this.value + room) : Math.max(target, this.value - room);
    return this.value;
  }

  /** The page is shown again after being hidden: the time it drew nothing is not counted, so the next step eases from where it was. */
  resume(): void {
    this.resumed = true;
  }
}

/** A 3D camera that draws fewer frames a second than this ... */
export const SLOW_FPS = 20;
/** ... for this many seconds running goes back to Map. */
export const SLOW_FOR_S = 3;
/** The frame rate is counted over the last this many ms. */
const RATE_WINDOW_MS = 1000;

/**
 * Watches the frame rate while a 3D camera is on: it calls for Map once the frames drawn over the last
 * second have stayed under SLOW_FPS for SLOW_FOR_S, so a short stutter (the terrain loading, one long stall)
 * is forgiven, while a device drawing a frame every few seconds still gives way. A gap between frames is
 * never taken as a pause by its length alone: the page resets the watch when it is shown again after being
 * hidden, so a hidden tab's pause counts as nothing.
 */
export class FrameWatch {
  private frames: number[] = [];
  /** When the watch started (its first frame), ms; null before. */
  private started: number | null = null;
  private lowSince: number | null = null;

  /** A frame drawn at `now` (ms); true when the 3D camera should give way to Map. */
  frame(now: number): boolean {
    this.started ??= now;
    this.frames.push(now);
    while (this.frames[0] <= now - RATE_WINDOW_MS) this.frames.shift();
    // Judged only once a whole window has been watched.
    if (now - this.started < RATE_WINDOW_MS) return false;
    const fps = (this.frames.length * 1000) / RATE_WINDOW_MS;
    if (fps >= SLOW_FPS) {
      this.lowSince = null;
      return false;
    }
    this.lowSince ??= now;
    return now - this.lowSince >= SLOW_FOR_S * 1000;
  }

  /** Starts over (a camera or theme switch, the page shown again after being hidden). */
  reset(): void {
    this.frames = [];
    this.lowSince = null;
    this.started = null;
  }
}

/** Why a 3D camera gave way to Map: its WebGL failed, or it was too slow. */
export type FallbackCause = "webgl" | "slow";

/**
 * The short notice the Journey card shows when a 3D camera gives way to Map by itself: its WebGL (the
 * terrain, the aircraft's layer or its module) failed, or its frame rate stayed low (FrameWatch).
 */
export const FALLBACK_NOTICE: Record<FallbackCause, string> = {
  webgl: "The 3D cameras are not available on this device, so you are back on Map.",
  slow: "The 3D cameras could not keep up on this device, so you are back on Map.",
};

/**
 * The camera `share` of the way from the flat Map shot `flat` to the 3D camera's placement `threeD`: the
 * point looked at and its height moved between the two, the distance closed evenly in scale, the bearing
 * turned the short way round, the tilt between the two.
 */
export function blendPlacement(flat: EnRoutePlacement, threeD: EnRoutePlacement, share: number): EnRoutePlacement {
  if (share <= 0) return flat;
  if (share >= 1) return threeD;
  const mix = (a: number, b: number) => a + (b - a) * share;
  return {
    center: { latitude: mix(flat.center.latitude, threeD.center.latitude), longitude: mix(flat.center.longitude, threeD.center.longitude) },
    elevationM: mix(flat.elevationM, threeD.elevationM),
    distanceM: flat.distanceM * (threeD.distanceM / flat.distanceM) ** share,
    bearingDeg: wrap360(flat.bearingDeg + turn(flat.bearingDeg, threeD.bearingDeg) * share),
    pitchDeg: mix(flat.pitchDeg, threeD.pitchDeg),
  };
}
