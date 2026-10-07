import type { FlightState } from "./aircraft-state";
import { airlineName, typeName } from "./flight-names";
import type { JourneyArrival, JourneyFix, JourneyStatus } from "./journey-follow";

/** The journey as the panel prints it. */
export interface JourneyView {
  callsign: string;
  /** "Delta · Airbus A321", or whichever half is known. */
  operator: string;
  /** Where it set out, as the route names it; null with no route to name it. */
  from: string | null;
  /** The destination's code; null with no route known. */
  to: string | null;
  /** Share of the way flown, 0 to 1; null with no destination. */
  share: number | null;
  flown: string;
  toGo: string | null;
  /** The estimated arrival, "14:51" in the destination's time (UTC, marked, where it is not a built airport). */
  arrival: string | null;
  /** "At gate" or "At stand" once it has arrived at a known one; "Arrived" once it has arrived somewhere no gate or stand could be named. */
  phase: "At gate" | "At stand" | "Arrived" | "Taxiing" | "Climbing" | "Cruising" | "Descending";
  speed: string;
  /** "FL290" at the flight levels, "12,300 ft" below them, "Ground" on it. */
  altitude: string;
  endLine: string | null;
  /** The published procedures drawn on the map now, as the flight card cites them. */
  procedures: string[];
  /** The map draws a dashed estimate of the way left, which the card says is one. */
  estimated: boolean;
}

/** Climbing or descending faster than this, feet a minute, is not level flight. */
const LEVEL_FPM = 300;
/** The US transition altitude: heights at and above it are flight levels. */
const FLIGHT_LEVELS_FT = 18_000;

const clocks = new Map<string, Intl.DateTimeFormat>();
function clock(timeZone: string): Intl.DateTimeFormat {
  let format = clocks.get(timeZone);
  if (!format) clocks.set(timeZone, (format = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone })));
  return format;
}

/** The badge colour of each phase: the flight card's states, with a cruise as neutral as a parked aircraft. */
export const PHASE_STATE: Record<JourneyView["phase"], FlightState> = { "At gate": "parked", "At stand": "parked", Arrived: "parked", Taxiing: "taxiing", Climbing: "departing", Cruising: "parked", Descending: "arriving" };

/** What a flight is doing, from its fix. */
export function flightPhase(fix: Pick<JourneyFix, "onGround" | "groundSpeedKt" | "verticalRateFpm">): JourneyView["phase"] {
  const rate = fix.verticalRateFpm ?? 0;
  return fix.onGround ? ((fix.groundSpeedKt ?? 0) > 1 ? "Taxiing" : "At gate") : rate > LEVEL_FPM ? "Climbing" : rate < -LEVEL_FPM ? "Descending" : "Cruising";
}

/** "FL290" at the flight levels, "12,300 ft" below them, "Ground" on it. */
export function formatAltitude(fix: Pick<JourneyFix, "onGround" | "altitudeFt">): string {
  return fix.onGround ? "Ground" : fix.altitudeFt >= FLIGHT_LEVELS_FT ? `FL${String(Math.round(fix.altitudeFt / 100)).padStart(3, "0")}` : `${(Math.round(fix.altitudeFt / 100) * 100).toLocaleString("en-US")} ft`;
}

/** The line that says where a journey ended, as the flight card and the journey card print it. */
export function arrivalLine({ place, quiet }: JourneyArrival): string {
  const where = place ? `Arrived at ${place.kind} ${place.ref}.` : "Arrived.";
  return quiet ? `${where} Its transponder went quiet ${place ? "there" : "on the ground"}.` : where;
}

export function journeyView(status: JourneyStatus): JourneyView | null {
  const { fix, progress } = status;
  if (!fix || !progress) return null;
  const nm = (n: number) => `${Math.round(n).toLocaleString("en-US")} NM`;
  const place = status.arrival?.place;
  // A transponder often goes quiet short of the stand: then it has arrived, but at no gate the card can name.
  const phase = status.arrival ? (place ? (place.kind === "stand" ? "At stand" : "At gate") : "Arrived") : flightPhase(fix);
  // Down at its destination, the way is done: what is left is the walk from the runway to the airport's reference point, which means nothing to a reader.
  const done = !!status.arrival || (status.stage === "destination" && fix.onGround);
  const altitude = formatAltitude(fix);
  const arrival = progress.arrival === null ? null : status.timeZone ? clock(status.timeZone).format(new Date(progress.arrival)) : `${clock("UTC").format(new Date(progress.arrival))} UTC`;
  return {
    callsign: status.callsign,
    operator: [airlineName(fix.callsign ?? status.callsign), typeName(fix.typeCode)].filter(Boolean).join(" · "),
    from: status.from,
    to: status.to,
    share: done ? 1 : progress.share,
    flown: nm(progress.flownNm),
    toGo: done || progress.toGoNm === null ? null : nm(progress.toGoNm),
    arrival: done ? null : arrival,
    phase,
    speed: fix.groundSpeedKt === null ? "—" : `${Math.round(fix.groundSpeedKt)} kt`,
    altitude,
    endLine: status.arrival ? arrivalLine(status.arrival) : status.endLine,
    procedures: status.procedures,
    estimated: status.estimated,
  };
}
