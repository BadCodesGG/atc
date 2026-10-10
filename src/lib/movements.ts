import { type FlightState, interest } from "./aircraft-state";
import type { TrafficEntry } from "./traffic-view";

/**
 * The active movements list: the aircraft moving right now, most worth watching first, a row of
 * words for each, and what is left over for the footer ("+ 18 more moving · 3 at gates").
 */

export interface MovementRow {
  id: string;
  callsign: string;
  /** ICAO type designator, "B712"; empty when the feed has none. */
  type: string;
  /** What it is doing, "Takeoff roll", "Final 500 ft", "Southbound". */
  phrase: string;
  /** Short state and runway, "DEP 9R", "ARR 8L", "TAXI"; "VEH" for a ground vehicle. */
  tag: string;
  state: FlightState;
  speed: string;
  /** "to PHX" or "from YUL", when the route is known; else empty. */
  route: string;
  selected: boolean;
}

export interface Movements {
  rows: MovementRow[];
  /** Moving aircraft not in the rows. */
  more: number;
  atGates: number;
}

type Entry = Pick<TrafficEntry, "aircraft" | "situation"> & { card?: Pick<TrafficEntry["card"], "route" | "direction"> };

/**
 * Runway traffic first, then taxiing aircraft, then the rest of the air (the tiers the featured
 * flight is picked by); in a tier, lowest first and then by callsign. Neither changes while
 * aircraft taxi, so rows do not reshuffle as speeds wobble.
 */
function order(a: Entry, b: Entry): number {
  return (
    interest(a.situation) - interest(b.situation) ||
    a.situation.aglFt - b.situation.aglFt ||
    callsign(a).localeCompare(callsign(b)) ||
    a.aircraft.id.localeCompare(b.aircraft.id)
  );
}

function callsign(e: Entry): string {
  return e.aircraft.callsign ?? e.aircraft.id.toUpperCase();
}

const TAG: Record<FlightState, string> = { departing: "DEP", arriving: "ARR", taxiing: "TAXI", parked: "" };

const COMPASS = ["Northbound", "Northeast", "Eastbound", "Southeast", "Southbound", "Southwest", "Westbound", "Northwest"];

const feet = (ft: number) => `${(Math.round(ft / 100) * 100).toLocaleString("en-US")} ft`;

function phrase({ aircraft: a, situation: s }: Entry): string {
  if (s.activity.startsWith("Crossing runway ")) return s.activity.replace("Crossing runway ", "Crossing ");
  if (s.activity === "Taxiing") return a.headingKnown ? COMPASS[Math.round(a.headingDeg / 45) % 8] : "Taxiing";
  if (a.onGround || s.vehicle || s.activity === "Landing") return s.activity;
  if (s.activity === "Final approach") return `Final ${feet(s.aglFt)}`;
  return `${s.activity} ${feet(s.aglFt)}`;
}

function routeWords({ card }: Entry): string {
  if (!card?.route) return "";
  return card.direction === "outbound" ? `to ${card.route.destination.code}` : `from ${card.route.origin.code}`;
}

function row(e: Entry, selected: boolean): MovementRow {
  const { aircraft: a, situation: s } = e;
  return {
    id: a.id,
    callsign: callsign(e),
    type: a.typeCode ?? "",
    phrase: phrase(e),
    tag: s.vehicle ? "VEH" : s.runway && s.state !== "taxiing" ? `${TAG[s.state]} ${s.runway}` : TAG[s.state],
    state: s.state,
    speed: a.groundSpeedKt === null ? "" : `${Math.round(a.groundSpeedKt)} kt`,
    route: routeWords(e),
    selected,
  };
}

/**
 * Up to `limit` rows of the moving aircraft, the selected one marked. A selected aircraft that would
 * fall below the cut takes the last row, so the list always shows which flight the card is about.
 */
export function activeMovements(entries: Entry[], selectedId: string | null, limit: number): Movements {
  const moving = entries.filter((e) => e.situation.moving).sort(order);
  const shown = moving.slice(0, limit);
  const selected = moving.findIndex((e) => e.aircraft.id === selectedId);
  if (limit > 0 && selected >= limit) shown[limit - 1] = moving[selected];
  return {
    rows: shown.map((e) => row(e, e.aircraft.id === selectedId)),
    more: moving.length - shown.length,
    atGates: entries.filter((e) => e.situation.state === "parked" && !e.situation.vehicle).length,
  };
}

/** The footer under the rows, "+ 18 more moving · 3 at gates", without a part that would read zero; null when both would. */
export function movementsFoot({ more, atGates }: Pick<Movements, "more" | "atGates">): string | null {
  const parts = [more > 0 ? `+ ${more} more moving` : "", atGates > 0 ? `${atGates} at gates` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
