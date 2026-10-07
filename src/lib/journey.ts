import { type Airport, AIRPORTS, airportByCode } from "./airports";
import { FEET, type Origin, toLocal } from "./geo";
import type { FlightRoute } from "./routes";

/**
 * Gate to gate: one flight followed from a gate at one built airport, across the map at cruise, to a
 * gate at another. The parts that are only arithmetic: how far it has come and has to go, when it will
 * likely arrive, where the journey can end, and how far back the camera stands at each point of it.
 * Everything here depends on where the aircraft is, never on when, so a recording played fast and the
 * live feed take the same path through it.
 */

/** How close the camera follows a flight on the ground, metres (the card's Follow). */
export const FOLLOW_DISTANCE_M = 1400;
/** How far back it stands at cruise, metres: a few hundred kilometres of the map in view. */
export const CRUISE_DISTANCE_M = 400_000;
/** On the way up, the camera's distance doubles with every this many feet climbed. */
const CLIMB_DOUBLING_FT = 1500;
/** On the way down, it stands this many times the aircraft's distance from the destination back from it. */
const APPROACH_RATIO = 1.5;

const NM = 1852;

/** Great-circle distance, nautical miles. */
export function nauticalMiles(a: Origin, b: Origin): number {
  const [x, y] = toLocal(a, b.latitude, b.longitude);
  return Math.hypot(x, y) / NM;
}

/** Where the journey can end: at a gate of a built destination, or on the map, with the line that says why. */
export type JourneyEnd = { kind: "gate"; destination: Airport } | { kind: "map"; code: string | null; line: string };

export function journeyEnd(route: FlightRoute | null): JourneyEnd {
  if (!route) return { kind: "map", code: null, line: "No route is known for this flight, so the journey ends on the map." };
  const code = route.destination.code;
  const destination = airportByCode(code.toLowerCase());
  if (destination) return { kind: "gate", destination };
  return { kind: "map", code, line: `${code} is not one of the ${AIRPORTS.length} airports in 3D, so the journey ends on the map.` };
}

export interface JourneyFix extends Origin {
  groundSpeedKt: number | null;
  onGround: boolean;
}

export interface JourneyProgress {
  /** Great-circle distance from the origin, NM. */
  flownNm: number;
  /** Great-circle distance to the destination, NM; null with no destination to measure to. */
  toGoNm: number | null;
  /** Share of the way, 0 to 1; null with no destination. */
  share: number | null;
  /**
   * An estimate of the arrival, UTC milliseconds: the distance left at the ground speed now. Only in the
   * air, where the ground speed means something; null on the ground or without one.
   */
  arrival: number | null;
}

export function journeyProgress(origin: Origin, destination: Origin | null, fix: JourneyFix, nowMs: number): JourneyProgress {
  const flownNm = nauticalMiles(origin, fix);
  if (!destination) return { flownNm, toGoNm: null, share: null, arrival: null };
  const toGoNm = nauticalMiles(fix, destination);
  const share = flownNm + toGoNm > 0 ? flownNm / (flownNm + toGoNm) : 0;
  const speed = fix.groundSpeedKt;
  const arrival = !fix.onGround && speed !== null && speed > 50 ? nowMs + (toGoNm / speed) * 3_600_000 : null;
  return { flownNm, toGoNm, share, arrival };
}

/**
 * How far back the camera follows, metres: close on the ground; on the way up (nearer the origin),
 * doubling with every 1,500 ft above it, so the zoom out runs at an even pace through the climb; on the
 * way down, one and a half times the aircraft's distance from the destination; never past the cruise
 * view. Halfway the climb's rule is long past the approach's, so the hand from one to the other is
 * seamless.
 */
export function journeyDistance({
  altitudeFt,
  onGround,
  toOriginM,
  toDestinationM,
  originElevationFt,
}: {
  altitudeFt: number;
  onGround: boolean;
  toOriginM: number;
  toDestinationM: number | null;
  originElevationFt: number;
}): number {
  if (onGround) return FOLLOW_DISTANCE_M;
  const outbound = toDestinationM === null || toOriginM <= toDestinationM;
  const climb = outbound ? FOLLOW_DISTANCE_M * 2 ** (Math.max(0, altitudeFt - originElevationFt) / CLIMB_DOUBLING_FT) : Infinity;
  const approach = toDestinationM === null ? Infinity : APPROACH_RATIO * toDestinationM;
  return Math.max(FOLLOW_DISTANCE_M, Math.min(climb, approach, CRUISE_DISTANCE_M));
}

/** The aircraft's height above the ground at `airport`, metres, for the camera's line of sight. */
export function heightAbove(altitudeFt: number, airport: Pick<Airport, "elevationFt">): number {
  return Math.max(0, (altitudeFt - airport.elevationFt) * FEET);
}

/** The camera's tilt in the air, degrees above the ground: low close in, so the way ahead is in view, and steeper at cruise. */
const LOW_TILT = { distance: 12_000, elevationDeg: 28 };
const HIGH_TILT = { distance: 150_000, elevationDeg: 50 };

/**
 * Which way the camera looks and how steeply: on the ground whatever the reader chose (null); in the air
 * along the flight's heading, so it flies up the screen, tilted by how far back the camera stands.
 */
export function journeyAngles(distanceM: number, airborne: boolean, headingDeg: number): { azimuthDeg: number | null; elevationDeg: number | null } {
  if (!airborne) return { azimuthDeg: null, elevationDeg: null };
  const u = Math.max(0, Math.min(1, Math.log(distanceM / LOW_TILT.distance) / Math.log(HIGH_TILT.distance / LOW_TILT.distance)));
  return { azimuthDeg: headingDeg, elevationDeg: LOW_TILT.elevationDeg + (HIGH_TILT.elevationDeg - LOW_TILT.elevationDeg) * u };
}

/** Within this of an end of the journey, metres, the camera keeps that end's field in view with the aircraft; past the far edge, the aircraft alone. */
const FRAME_NEAR_M = 25_000;
const FRAME_FAR_M = 45_000;
/**
 * Framing an end of the journey: aimed this share of the way from the aircraft toward the field, standing
 * this many times their distance apart back, this many degrees above the ground. Through the diorama's
 * lens, off-centre above its controls, that puts the field just under the header and the aircraft in the
 * lower third, the field in view through the haze.
 */
const AIM_SHARE = 0.45;
/** On a phone, the share of that the aim takes: the aircraft stays near the middle, clear of the card at the foot. */
const COMPACT_AIM = 0.25;
const FRAME_RATIO = 1.6;
const FRAME_ELEVATION_DEG = 20;
/** The framing comes in over this first stretch above the field (the roll, the lift-off, the touchdown are the aircraft's). */
const AIM_FROM_FT = 1500;

const smoothstep = (from: number, to: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/** The camera for one moment of a journey. */
export interface JourneyShot {
  /** How far back it stands from the point it aims at, metres. */
  distance: number;
  /** Where it aims: this share of the way from the aircraft toward `field`'s airport, at that share of the way down to the ground. */
  aim: number;
  field: "origin" | "destination";
  /** Which way it looks and how steeply; null keeps whatever the camera has. */
  azimuthDeg: number | null;
  elevationDeg: number | null;
}

/**
 * The journey's camera, from where the flight is. On the ground, close on the aircraft as the reader
 * left the view. Climbing out, pulled back to hold the airport behind the aircraft as well. Away from both ends, behind the aircraft looking the way it flies. On the way down, looking
 * toward the destination with its airport in view ahead, closing on the aircraft for the touchdown.
 * Climbing out it looks back at the airport the same way, so the camera turns round after lift-off.
 */
export function journeyShot(input: {
  altitudeFt: number;
  onGround: boolean;
  headingDeg: number;
  toOriginM: number;
  toDestinationM: number | null;
  bearingToOriginDeg: number;
  bearingToDestinationDeg: number | null;
  originElevationFt: number;
  destinationElevationFt: number | null;
  /** A phone's narrow band between its controls and its card: the aim stays nearer the aircraft. */
  compact?: boolean;
}): JourneyShot {
  const outbound = input.toDestinationM === null || input.toOriginM <= input.toDestinationM;
  const field = outbound ? "origin" : "destination";
  if (input.onGround) return { distance: FOLLOW_DISTANCE_M, aim: 0, field, azimuthDeg: null, elevationDeg: null };
  const near = outbound ? input.toOriginM : input.toDestinationM!;
  const agl = input.altitudeFt - (outbound ? input.originElevationFt : (input.destinationElevationFt ?? input.originElevationFt));
  const lift = smoothstep(0, AIM_FROM_FT, agl);
  const frame = lift * (1 - smoothstep(FRAME_NEAR_M, FRAME_FAR_M, near));
  const journey = journeyDistance({ altitudeFt: input.altitudeFt, onGround: false, toOriginM: input.toOriginM, toDestinationM: input.toDestinationM, originElevationFt: input.originElevationFt });
  const distance = Math.min(CRUISE_DISTANCE_M, Math.max(journey, FRAME_RATIO * near * lift));
  const bearing = outbound ? input.bearingToOriginDeg : input.bearingToDestinationDeg!;
  const tilt = journeyAngles(distance, true, input.headingDeg).elevationDeg!;
  return {
    distance,
    aim: AIM_SHARE * frame * (input.compact ? COMPACT_AIM : 1),
    field,
    // Toward the field while it is framed (back at the airport climbing out, ahead at it coming in), else the way it flies.
    azimuthDeg: near < FRAME_FAR_M ? bearing : input.headingDeg,
    elevationDeg: tilt + (FRAME_ELEVATION_DEG - tilt) * frame,
  };
}

/** Where the theme's haze starts, in camera distances (the orbit fog's near), and the room kept past the field. */
const HAZE_STARTS = 1.05;
const FIELD_ROOM = 1.2;

/**
 * How far out to push the diorama's haze for a view framing a field: the orbit's haze starts just past
 * the point the camera looks at, so a field framed beyond it (climbing out, or on the way down) would
 * fade into the page colour. Returns the factor that puts the start of the haze a fifth past the field;
 * never below 1.
 */
export function fogReach(view: { azimuthDeg: number; elevationDeg: number; target: readonly [number, number]; height: number; distance: number }, field: readonly [number, number]): number {
  const az = (view.azimuthDeg * Math.PI) / 180;
  const el = (view.elevationDeg * Math.PI) / 180;
  const back = view.distance * Math.cos(el);
  const camera = [view.target[0] - Math.sin(az) * back, view.target[1] - Math.cos(az) * back, view.height + view.distance * Math.sin(el)];
  const toField = Math.hypot(field[0] - camera[0], field[1] - camera[1], camera[2]);
  return Math.max(1, (FIELD_ROOM * toField) / (HAZE_STARTS * view.distance));
}
