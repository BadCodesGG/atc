import { parseAircraftList, type RegionAircraft } from "./region";

/**
 * Aircraft squawking an emergency code anywhere, from adsb.lol (free, no key, ODbL), or adsb.fi when it refuses: `GET /v2/sqk/{code}`.
 * The alerts watch the three codes that mean something is wrong; the page keeps those inside the area it
 * shows. (`/v2/mil` is not read: it answers all the world's military, a hundred kilobytes, and the airport's
 * own feed already flags military aircraft in the area.)
 */

/** General emergency, radio failure, unlawful interference: the only codes that are ever asked for. */
export const EMERGENCY_SQUAWKS = ["7700", "7600", "7500"] as const;
export type EmergencySquawk = (typeof EMERGENCY_SQUAWKS)[number];

/** The code when it is one of the three, else null. Nothing else ever reaches a URL. */
export function readSquawk(value: string): EmergencySquawk | null {
  return (EMERGENCY_SQUAWKS as readonly string[]).includes(value) ? (value as EmergencySquawk) : null;
}

export interface SquawkSnapshot {
  code: EmergencySquawk;
  /** UTC seconds the upstream built the response. */
  time: number;
  aircraft: RegionAircraft[];
}

/** Throws when the body is not an adsb.lol answer: an outage must not read as a quiet sky. */
export function parseSquawk(json: unknown, code: EmergencySquawk): SquawkSnapshot {
  return { code, ...parseAircraftList(json, "squawk") };
}
