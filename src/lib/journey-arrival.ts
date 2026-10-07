import type { Place } from "./aircraft-state";
import type { AirportMap } from "./airport-map";
import type { JourneyStage } from "./journey-follow";

/**
 * A journey that ends without the aircraft ever being read standing at its gate. Transponders are often
 * switched off on the stand, and a taxiing aircraft is often lost behind a terminal; both leave the feeds
 * with the last position heard slow, on the ground, near where the aircraft is going to rest. A flight that
 * went quiet there has arrived.
 */

/** Seconds of the feed's clock with no new position, before a flight last seen near a stand is taken to have parked. */
export const QUIET_S = 30;
/** Last seen no faster than this, knots, is last seen slow: slow enough to be easing into a stand, which a taxi past it is not. */
export const SLOW_KT = 12;
/** Last seen no faster than this, knots, is last seen stopped, or creeping onto the stand: evidence enough that it parked where it was. */
export const STOPPED_KT = 3;
/** A gate or stand this near the last position, metres, is the one it parked at (a gate's own reach is 80 m, a stand's 60). */
export const SPOT_M = 150;
/** Within this of a spot, metres, an aircraft is on it, whichever way it faces; further off, a spot behind it is not the one it is pulling into. */
export const ON_SPOT_M = 40;
/** Slower by at least this much, as a share of the first step, over its last few positions, is an aircraft braking. */
const BRAKING_SHARE = 0.75;
/** An aircraft closer to a spot by at least this over its last few positions, metres, is coming in to it. */
const CLOSING_M = 2;
/** Measurement noise in a position, metres: a step or a distance may disagree with the trend by this much. */
const JITTER_M = 1;

/** A gate or stand, with where it is. */
interface Spot {
  place: Place | null;
  x: number;
  y: number;
}

/**
 * The gate or stand an aircraft at (x, y) is at, in the airport's metres, within `radiusM`. The nearest, except that
 * one behind an aircraft that is not on it (further than ON_SPOT_M, and more than a quarter turn off its heading) comes
 * after every one it is facing: it has passed that one, and is pulling into another.
 */
function spotAt(map: Pick<AirportMap, "gates" | "stands">, x: number, y: number, radiusM: number, headingDeg: number | null | undefined): Spot | null {
  let best: Spot | null = null;
  let bestCost = Infinity;
  for (const [kind, spots] of [["gate", map.gates], ["stand", map.stands]] as const) {
    for (const spot of spots) {
      const d = Math.hypot(spot.x - x, spot.y - y);
      if (d > radiusM) continue;
      const bearing = ((Math.atan2(spot.x - x, spot.y - y) * 180) / Math.PI + 360) % 360;
      const off = headingDeg == null ? 0 : Math.abs(((bearing - headingDeg + 540) % 360) - 180);
      const cost = d + (d > ON_SPOT_M && off > 90 ? radiusM : 0);
      if (cost < bestCost) {
        bestCost = cost;
        best = { place: spot.ref ? { kind, ref: spot.ref } : null, x: spot.x, y: spot.y };
      }
    }
  }
  return best;
}

/** The gate or stand nearest (x, y), in the airport's metres, within `radiusM`: named when the map names it; null when there is none. */
export function spotNear(map: Pick<AirportMap, "gates" | "stands">, x: number, y: number, radiusM = SPOT_M): { place: Place | null } | null {
  const spot = spotAt(map, x, y, radiusM, null);
  return spot && { place: spot.place };
}

/**
 * Whether the last positions heard (oldest first, the latest last) are an aircraft braking toward `spot`: each
 * step shorter than the one before and the whole run closer to it. A taxi along a lane at a steady pace passing
 * the stand does neither.
 */
function brakingInto(recent: readonly { x: number; y: number }[], spot: Spot): boolean {
  if (recent.length < 3) return false;
  const away = recent.map((p) => Math.hypot(spot.x - p.x, spot.y - p.y));
  const steps = recent.slice(1).map((p, i) => Math.hypot(p.x - recent[i].x, p.y - recent[i].y));
  const closing = away.every((d, i) => i === 0 || d <= away[i - 1] + JITTER_M) && away[0] - away.at(-1)! >= CLOSING_M;
  const slowing = steps.every((s, i) => i === 0 || s <= steps[i - 1] + JITTER_M) && steps.at(-1)! <= steps[0] * BRAKING_SHARE;
  return closing && slowing;
}

/**
 * Whether a flight whose position has not been heard for `silentS` seconds has arrived: last seen on the
 * ground within reach of a gate or stand, and having stopped there. That is evidence, not just a spot in
 * reach: it was last seen stopped or creeping (STOPPED_KT), or slow and braking toward the spot over its last
 * positions `recent` (oldest first, ending at `last`). One taxiing past a stand at a taxi's pace, then lost
 * behind a terminal, has not arrived. The spot it parked at, when the map names it: the one it is on, or facing,
 * rather than whichever is nearest.
 */
export function quietArrival(
  last: { onGround: boolean; groundSpeedKt: number | null; x: number; y: number; headingDeg?: number | null },
  silentS: number | null,
  map: Pick<AirportMap, "gates" | "stands">,
  recent: readonly { x: number; y: number }[] = [],
): { place: Place | null } | null {
  const kt = last.groundSpeedKt ?? 0;
  if (silentS === null || silentS < QUIET_S || !last.onGround || kt > SLOW_KT) return null;
  const spot = spotAt(map, last.x, last.y, SPOT_M, last.headingDeg);
  if (!spot || (kt > STOPPED_KT && !brakingInto(recent, spot))) return null;
  return { place: spot.place };
}

/**
 * A followed flight missing from both the airport's feed and the journey's own reads this long, ms of the
 * feed's clock, is lost: adsb.lol can answer 429 for minutes, and a taxiing aircraft is flown on for only seconds.
 */
export const LOST_MS = 300_000;

/**
 * What a journey does with a flight that has gone from every feed. Within the hold, wait. Past it: an
 * aircraft on the ground cannot have gone anywhere, so at its origin the journey waits for it to be heard
 * again (a transponder may stay off at the gate through a long delay) and at its destination it has
 * arrived; one in the air may be anywhere by now, and is let go with its journey.
 */
export function whenLost({ stage, lostMs, onGround }: { stage: JourneyStage; lostMs: number; onGround: boolean }): "hold" | "arrive" | "release" {
  if (lostMs <= LOST_MS || stage === "arrived" || stage === "map") return "hold";
  if (onGround) return stage === "destination" ? "arrive" : "hold";
  return "release";
}
