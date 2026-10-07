/**
 * The two names a flight goes by: the ICAO callsign a transponder sends ("DAL3104") and the IATA flight
 * number printed on the ticket ("DL3104"). The operators are the ones flight-names.ts knows.
 */

/** ICAO airline prefix to IATA code. */
const IATA: Record<string, string> = {
  AAL: "AA",
  AAY: "G4",
  AFR: "AF",
  AMX: "AM",
  ASA: "AS",
  ASH: "YV",
  BAW: "BA",
  DAL: "DL",
  DLH: "LH",
  EDV: "9E",
  ENY: "MQ",
  ETD: "EY",
  FDX: "FX",
  FFT: "F9",
  GJS: "G7",
  JBU: "B6",
  JIA: "OH",
  KAL: "KE",
  KLM: "KL",
  NKS: "NK",
  PDT: "PT",
  QTR: "QR",
  RPA: "YX",
  SKW: "OO",
  SWA: "WN",
  THY: "TK",
  UAE: "EK",
  UAL: "UA",
  UPS: "5X",
  VIR: "VS",
};

const ICAO: Record<string, string> = Object.fromEntries(Object.entries(IATA).map(([icao, iata]) => [iata, icao]));

/** The flight number for a callsign such as "DAL3104" ("DL3104"), or null when the prefix is unknown or no number follows. */
export function iataFlight(callsign: string | null): string | null {
  const m = callsign?.match(/^([A-Z]{3})(\d{1,4})$/);
  return m && IATA[m[1]] ? `${IATA[m[1]]}${m[2]}` : null;
}

/**
 * What to look a typed flight up as: an IATA flight number becomes its ICAO callsign ("dl3104" is
 * "DAL3104"); anything else is the same text, trimmed and upper-cased.
 */
export function callsignFor(input: string): string {
  const text = input.trim().toUpperCase();
  const m = text.match(/^([A-Z0-9]{2})(\d{1,4})$/);
  return m && ICAO[m[1]] ? `${ICAO[m[1]]}${m[2]}` : text;
}
