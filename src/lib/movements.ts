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

/** Rows the list shows until it is expanded. */
export const MOVEMENT_ROWS = 5;

/**
 * Up to `limit` rows of the moving aircraft, the selected one marked (every one by default, for the
 * list to cut as it is folded or expanded).
 */
export function activeMovements(entries: Entry[], selectedId: string | null, limit = Infinity): Movements {
  const moving = entries.filter((e) => e.situation.moving).sort(order);
  const all: Movements = {
    rows: moving.map((e) => row(e, e.aircraft.id === selectedId)),
    more: 0,
    atGates: entries.filter((e) => e.situation.state === "parked" && !e.situation.vehicle).length,
  };
  return cutMovements(all, limit);
}

/**
 * The first `limit` rows, the rest counted in `more`. A selected aircraft that would fall below the cut
 * takes the last row, so the list always shows which flight the card is about.
 */
export function cutMovements(m: Movements, limit: number): Movements {
  if (m.rows.length <= limit) return m;
  const shown = m.rows.slice(0, limit);
  const selected = m.rows.findIndex((r) => r.selected);
  if (limit > 0 && selected >= limit) shown[limit - 1] = m.rows[selected];
  return { rows: shown, more: m.more + m.rows.length - shown.length, atGates: m.atGates };
}

/**
 * The footer under the rows, without a part that would read zero: the control that expands the list
 * ("+ 18 more moving") or folds it back ("Show fewer"), and the aircraft at gates ("3 at gates").
 * `all` is the whole list; `expanded`, whether every row of it is showing.
 */
export function movementsFoot(all: Movements, expanded: boolean, limit = MOVEMENT_ROWS): { toggle: string | null; atGates: string | null } {
  const hidden = all.more + Math.max(0, all.rows.length - limit);
  return {
    toggle: hidden === 0 ? null : expanded ? "Show fewer" : `+ ${hidden} more moving`,
    atGates: all.atGates > 0 ? `${all.atGates} at gates` : null,
  };
}
