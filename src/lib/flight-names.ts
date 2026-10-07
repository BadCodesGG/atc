/**
 * Plain names for the two codes a transponder gives away: the operator's ICAO prefix at the start of
 * the callsign, and the ICAO aircraft type designator. Only the operators and types common at the
 * airports the app shows; anything else falls back to the code itself.
 */

const AIRLINES: Record<string, string> = {
  AAL: "American",
  ASA: "Alaska",
  ASH: "Mesa",
  AFR: "Air France",
  BAW: "British Airways",
  DAL: "Delta",
  EDV: "Endeavor Air",
  ENY: "Envoy",
  FDX: "FedEx",
  FFT: "Frontier",
  JBU: "JetBlue",
  KLM: "KLM",
  NKS: "Spirit",
  RPA: "Republic",
  SKW: "SkyWest",
  SWA: "Southwest",
  UAL: "United",
  UPS: "UPS",
  VIR: "Virgin Atlantic",
  DLH: "Lufthansa",
  AAY: "Allegiant",
  GJS: "GoJet",
  JIA: "PSA",
  PDT: "Piedmont",
  AMX: "Aeroméxico",
  KAL: "Korean Air",
  QTR: "Qatar Airways",
  ETD: "Etihad",
  UAE: "Emirates",
  THY: "Turkish Airlines",
};

const TYPES: Record<string, string> = {
  A319: "Airbus A319",
  A320: "Airbus A320",
  A20N: "Airbus A320neo",
  A321: "Airbus A321",
  A21N: "Airbus A321neo",
  A332: "Airbus A330-200",
  A333: "Airbus A330-300",
  A339: "Airbus A330-900",
  A359: "Airbus A350-900",
  A35K: "Airbus A350-1000",
  A388: "Airbus A380",
  B712: "Boeing 717-200",
  B737: "Boeing 737-700",
  B738: "Boeing 737-800",
  B739: "Boeing 737-900",
  B38M: "Boeing 737 MAX 8",
  B39M: "Boeing 737 MAX 9",
  B752: "Boeing 757-200",
  B753: "Boeing 757-300",
  B763: "Boeing 767-300",
  B764: "Boeing 767-400",
  B772: "Boeing 777-200",
  B77W: "Boeing 777-300ER",
  B788: "Boeing 787-8",
  B789: "Boeing 787-9",
  BCS1: "Airbus A220-100",
  BCS3: "Airbus A220-300",
  CRJ2: "Bombardier CRJ200",
  CRJ7: "Bombardier CRJ700",
  CRJ9: "Bombardier CRJ900",
  E170: "Embraer 170",
  E75L: "Embraer 175",
  E75S: "Embraer 175",
  E190: "Embraer 190",
  MD11: "McDonnell Douglas MD-11",
  R44: "Robinson R44",
};

/** The ICAO airline prefix of a callsign such as "DAL3118" ("DAL"), or null for a registration or anything else. */
export function airlineCode(callsign: string | null): string | null {
  return callsign?.match(/^([A-Z]{3})\d/)?.[1] ?? null;
}

/** The operator behind an ICAO airline prefix, or null when the prefix is not one this table knows. */
export function airlineNameOf(code: string): string | null {
  return AIRLINES[code] ?? null;
}

/** The operator behind an airline callsign such as "DAL3118", or null for a registration or an unknown prefix. */
export function airlineName(callsign: string | null): string | null {
  const code = airlineCode(callsign);
  return code ? airlineNameOf(code) : null;
}

export function typeName(typeCode: string | null): string | null {
  if (!typeCode) return null;
  return TYPES[typeCode] ?? typeCode;
}

/** The type families the filter groups aircraft by, named as the card names the types: key (as it goes in an address), name, and the ICAO designators in it. */
const FAMILIES: [key: string, name: string, types: string[]][] = [
  ["A220", "Airbus A220", ["BCS1", "BCS3"]],
  ["A320", "Airbus A320 family", ["A319", "A320", "A20N", "A321", "A21N"]],
  ["A330", "Airbus A330", ["A332", "A333", "A339"]],
  ["A350", "Airbus A350", ["A359", "A35K"]],
  ["A380", "Airbus A380", ["A388"]],
  ["B717", "Boeing 717", ["B712"]],
  ["B737", "Boeing 737", ["B737", "B738", "B739", "B38M", "B39M"]],
  ["B757", "Boeing 757", ["B752", "B753"]],
  ["B767", "Boeing 767", ["B763", "B764"]],
  ["B777", "Boeing 777", ["B772", "B77W"]],
  ["B787", "Boeing 787", ["B788", "B789"]],
  ["CRJ", "Bombardier CRJ", ["CRJ2", "CRJ7", "CRJ9"]],
  ["EJET", "Embraer E-Jet", ["E170", "E75L", "E75S", "E190"]],
  ["MD11", "McDonnell Douglas MD-11", ["MD11"]],
  ["R44", "Robinson R44", ["R44"]],
];

const FAMILY_OF = new Map(FAMILIES.flatMap(([key, name, types]) => types.map((t) => [t, { key, name }] as const)));

/**
 * The family an ICAO type designator belongs to, for grouping: "B738" and "B39M" are both the Boeing
 * 737. A type outside the table is a family of its own, named by its code. Null when there is no type.
 */
export function typeFamily(typeCode: string | null): { key: string; name: string } | null {
  if (!typeCode) return null;
  return FAMILY_OF.get(typeCode) ?? { key: typeCode.toUpperCase(), name: typeCode };
}

/** The name of a type family by its key, or the key itself when it is a type of its own. */
export function familyName(key: string): string {
  return FAMILIES.find(([k]) => k === key)?.[1] ?? key;
}
