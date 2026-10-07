import { airlineName, typeName } from "../flight-names";
import { flightPhase, formatAltitude, PHASE_STATE } from "../journey-view";
import type { FlightRoute } from "../routes";
import type { FlightCard } from "../traffic-view";

/**
 * The flight selected on the world map, as the card prints it. Its figures are rounded to what the card
 * shows, so the map only tells the page when the card would change, not every frame the aircraft moves.
 */
export interface MapFlight {
  /** The aircraft's hex. */
  id: string;
  callsign: string | null;
  typeCode: string | null;
  altitudeFt: number;
  onGround: boolean;
  speedKt: number | null;
  /** Degrees, or null before any report has carried one. */
  headingDeg: number | null;
  verticalRateFpm: number | null;
  /** From the routes the page has learned (the map's cache); null when none is known. */
  route: FlightRoute | null;
  /** Part of the drawn path is an estimate between airports, which the card says. */
  estimated: boolean;
  /** When (ms) the aircraft left the feed, or null while it is in it: the card then keeps its last figures and says so. */
  lostAt: number | null;
}

/** The flight as it was last seen, now gone from the feed since `atMs`; the same object once it is already lost. */
export function markLost(flight: MapFlight, atMs: number): MapFlight {
  return flight.lostAt === null ? { ...flight, lostAt: atMs } : flight;
}

/** The card's line for a lost flight, "Not in the feed now. Last seen 14:32.", on the time bar's own clock. */
export function lostNote(flight: MapFlight, clock: Intl.DateTimeFormat): string | null {
  return flight.lostAt === null ? null : `Not in the feed now. Last seen ${clock.format(new Date(flight.lostAt))}.`;
}

/** What the card prints of a selected map flight: the same card the airport's diorama shows, with the figures the map has. */
export function mapFlightCard(f: MapFlight): FlightCard {
  const phase = flightPhase({ onGround: f.onGround, groundSpeedKt: f.speedKt, verticalRateFpm: f.verticalRateFpm });
  return {
    id: f.id,
    callsign: f.callsign ?? f.id.toUpperCase(),
    operator: [airlineName(f.callsign), typeName(f.typeCode)].filter(Boolean).join(" · "),
    // Lost, the badge goes neutral: there is no longer a phase to colour it by.
    state: f.lostAt === null ? PHASE_STATE[phase] : "parked",
    headline: "",
    tag: phase,
    speed: f.speedKt === null ? "—" : `${Math.round(f.speedKt)} kt`,
    heading: f.headingDeg === null ? "—" : `${String(Math.round(f.headingDeg) % 360).padStart(3, "0")}°`,
    altitude: formatAltitude(f),
    route: f.route,
    // The card names the city at the far end: here, where it is going.
    direction: f.route ? "outbound" : null,
    gate: null,
  };
}
