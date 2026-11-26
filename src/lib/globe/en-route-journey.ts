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
 * How much of the chosen 3D camera the view takes (0 to 1), by the distance of the Journey's own Map shot
 * (the camera the Handover reads): none of it inside the Handover `band`, where the flat map and the
 * Diorama crossfade on one camera; all of it from SHARE_FROM times the band's outer edge out; eased between
 * in log distance, as the band itself is. So leaving the origin the 3D camera takes over once the flight is
 * out of the Diorama, and arriving it eases into the Journey's own shot before the Handover begins. With no
 * band (no Diorama at this end) it is all 3D.
 */
export function enRouteShare(distanceM: number, band: Band | null): number {
  if (!band) return 1;
  return smoothstep(Math.min(1, Math.max(0, Math.log(distanceM / band.far) / Math.log(SHARE_FROM))));
}

/** An even share (0 to 1) smoothed at both ends: how the view eases between flat and 3D. */
export const smoothstep = (t: number): number => t * t * (3 - 2 * t);

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

/** How long the share takes to go all the way between flat and 3D, seconds: at an even pace, then smoothed (blendPlacement's caller). */
export const SHARE_EASE_S = 1.2;
/** The longest step one frame eases, seconds: a hidden tab's long gap is one short step. */
const MAX_STEP_S = 0.25;

/**
 * The share of the 3D camera the view takes, moved toward its target at an even pace (all the way in
 * SHARE_EASE_S), so a target that steps (a camera picked, the Handover band changing with the airport, a
 * fallback) never steps the camera, and arrives exactly.
 */
export class ShareEase {
  private value: number | null = null;
  private at = 0;

  /** The share at `now` (ms), moved toward `target`; the first step starts at the target. */
  step(target: number, now: number): number {
    if (this.value === null) {
      this.value = target;
      this.at = now;
      return target;
    }
    const dt = Math.max(0, Math.min(MAX_STEP_S, (now - this.at) / 1000));
    this.at = now;
    const room = dt / SHARE_EASE_S;
    this.value = target > this.value ? Math.min(target, this.value + room) : Math.max(target, this.value - room);
    return this.value;
  }
}

/** A 3D camera that draws fewer frames a second than this ... */
export const SLOW_FPS = 20;
/** ... for this many seconds running goes back to Map. */
export const SLOW_FOR_S = 3;
/** The frame rate is counted over the last this many ms. */
const RATE_WINDOW_MS = 1000;
/** A frame this late is a hidden tab or a paused page, not a slow one: the count starts over. */
const PAUSE_MS = 2000;

/**
 * Watches the frame rate while a 3D camera is on: it calls for Map once the frames drawn over the last
 * second have stayed under SLOW_FPS for SLOW_FOR_S, so a short stutter (the terrain loading) is forgiven and
 * a hidden tab's pause counts as nothing.
 */
export class FrameWatch {
  private frames: number[] = [];
  /** When the watch started (its first frame), ms; null before. */
  private started: number | null = null;
  private lowSince: number | null = null;

  /** A frame drawn at `now` (ms); true when the 3D camera should give way to Map. */
  frame(now: number): boolean {
    const last = this.frames.at(-1);
    if (last !== undefined && now - last > PAUSE_MS) this.reset();
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

  /** Starts over (a camera or theme switch, a pause). */
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

const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * The camera `share` of the way from the flat Map shot `flat` to the 3D camera `rode`: the point looked at
 * and its height moved between the two, the distance closed evenly in scale, the bearing turned the short
 * way round, the tilt between the two.
 */
export function blendPlacement(flat: EnRoutePlacement, rode: EnRoutePlacement, share: number): EnRoutePlacement {
  if (share <= 0) return flat;
  if (share >= 1) return rode;
  const mix = (a: number, b: number) => a + (b - a) * share;
  const turn = ((((rode.bearingDeg - flat.bearingDeg) % 360) + 540) % 360) - 180;
  return {
    center: { latitude: mix(flat.center.latitude, rode.center.latitude), longitude: mix(flat.center.longitude, rode.center.longitude) },
    elevationM: mix(flat.elevationM, rode.elevationM),
    distanceM: flat.distanceM * (rode.distanceM / flat.distanceM) ** share,
    bearingDeg: wrap360(flat.bearingDeg + turn * share),
    pitchDeg: mix(flat.pitchDeg, rode.pitchDeg),
  };
}
