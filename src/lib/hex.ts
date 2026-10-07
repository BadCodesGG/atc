import { parseAircraftList, type RegionAircraft } from "./region";

/**
 * One aircraft by its ICAO address, as adsb.lol's (or adsb.fi's) `GET /v2/hex/{hex}` answers: what the address may be,
 * and how the answer is read. The server's feed (hex-feed.ts) and the page both use these.
 */

/**
 * ICAO 24-bit addresses: six hex digits. adsb.lol also lists TIS-B tracks under a leading `~`; those are
 * a ground station's relay of a radar track rather than an aircraft's own address, and are not followed.
 */
const HEX = /^[0-9a-f]{6}$/;

/** The lower-cased hex, or null when the value is not one. Nothing else ever reaches a URL. */
export function readHex(value: string): string | null {
  const hex = value.toLowerCase();
  return HEX.test(hex) ? hex : null;
}

export interface HexSnapshot {
  hex: string;
  /** UTC seconds the upstream built the response. */
  time: number;
  /** The aircraft, or null when adsb.lol has no position for it now (on the ground with its transponder off, out of coverage). */
  aircraft: RegionAircraft | null;
}

/** Throws when the body is not an adsb.lol answer: an outage must not read as an aircraft gone. */
export function parseHex(json: unknown, hex: string): HexSnapshot {
  const { time, aircraft } = parseAircraftList(json, "hex");
  return { hex, time, aircraft: aircraft.find((a) => a.id === hex) ?? null };
}
