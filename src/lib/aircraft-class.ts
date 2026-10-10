import { isVehicle } from "./aircraft-state";

/**
 * Which model the scene draws an aircraft as, and how long it is, from what ADS-B says: the ICAO type
 * designator when the feed has one ("B738"), the emitter category otherwise ("A3"), and the
 * military flag. Generic shapes, one per kind of aircraft, so a regional jet, a widebody, a
 * helicopter and a Cessna are told apart at a glance.
 */

export type AircraftModel =
  /** Twin jet, engines under the wings: A320s, 737s, 757s, E-jets. */
  | "narrow"
  /** Twin-aisle twin: 767, 777, 787, A330, A350. */
  | "wide"
  /** Four engines under the wings: 747, A380, A340. */
  | "quad"
  /** Engines on the tail, T-tail: CRJs, 717s, MD-80s, ERJs, business jets. */
  | "rearjet"
  /** High wing, propellers: ATRs, Dash 8s, Saab 340s. */
  | "turboprop"
  /** Small piston or turboprop single: Cessnas, Pipers, Cirrus. */
  | "light"
  | "heli"
  /** Fast jets. */
  | "fighter"
  /** High wing, T-tail, four engines: C-17, C-130, C-5, A400M. */
  | "airlifter";

/** The length each model's geometry is built at, metres (scene/aircraft-model.ts). */
export const MODEL_LENGTH: Record<AircraftModel, number> = {
  narrow: 44,
  wide: 74,
  quad: 71,
  rearjet: 36,
  turboprop: 27,
  light: 8,
  heli: 13.4,
  fighter: 16,
  airlifter: 53,
};

export interface AircraftClass {
  model: AircraftModel;
  /** Length to draw it at, metres. */
  lengthM: number;
}

/** Type designators by model, with their lengths in metres. */
const TYPES: Record<AircraftModel, Record<string, number>> = {
  narrow: {
    A318: 31, A319: 34, A320: 38, A321: 44, A19N: 34, A20N: 38, A21N: 44, BCS1: 35, BCS3: 39,
    B736: 31, B737: 33, B738: 40, B739: 42, B37M: 36, B38M: 40, B39M: 42, B3XM: 44,
    B752: 47, B753: 54, E170: 30, E75L: 32, E75S: 32, E190: 36, E195: 39, E290: 36, E295: 42,
  },
  wide: {
    B762: 49, B763: 55, B764: 61, B772: 64, B773: 74, B77L: 64, B77W: 74, B778: 70, B779: 77,
    B788: 57, B789: 63, B78X: 68, A332: 59, A333: 64, A338: 59, A339: 64, A359: 67, A35K: 74, A306: 54, A310: 47, MD11: 61, DC10: 55,
  },
  quad: { B741: 71, B742: 71, B743: 71, B744: 71, B748: 76, A388: 73, A342: 59, A343: 64, A345: 68, A346: 75, K35R: 41, B703: 47, E3TF: 47, E6: 46 },
  rearjet: {
    CRJ1: 27, CRJ2: 27, CRJ7: 33, CRJ9: 36, CRJX: 39, B712: 38, MD81: 45, MD82: 45, MD83: 45, MD88: 45, MD90: 46, DC93: 36, F100: 36, F70: 31,
    E135: 26, E145: 30, E35L: 26, CL30: 21, CL35: 21, CL60: 21, GLF4: 27, GLF5: 30, GLF6: 30, GL5T: 30, GL7T: 34, GLEX: 30, G280: 20,
    C25A: 13, C25B: 15, C25C: 16, C510: 13, C525: 13, C550: 15, C560: 16, C56X: 16, C680: 19, C68A: 19, C700: 22, C750: 22,
    E50P: 13, E55P: 16, E545: 20, E550: 20, LJ35: 15, LJ45: 18, LJ60: 18, LJ75: 18, H25B: 16, F2TH: 20, F900: 20, FA7X: 23, FA8X: 25, PC24: 17, HDJT: 13,
  },
  turboprop: { AT43: 23, AT45: 23, AT72: 27, AT75: 27, AT76: 27, DH8A: 23, DH8B: 23, DH8C: 26, DH8D: 33, SF34: 20, SB20: 27, E120: 20, B190: 18, JS41: 20, D328: 21, B350: 14, BE20: 13, BE9L: 11 },
  light: {
    C150: 7, C152: 7, C162: 7, C172: 8, C177: 8, C182: 9, C206: 9, C208: 12, C210: 9, C310: 9, C340: 10, C414: 11, C421: 11,
    P28A: 7, P28B: 7, P28R: 8, PA32: 9, PA34: 9, PA44: 8, PA46: 9, P46T: 9, SR20: 8, SR22: 8, S22T: 8, BE33: 8, BE35: 8, BE36: 8, BE55: 9, BE58: 9,
    M20P: 8, M20T: 8, DA40: 8, DA42: 9, DA62: 9, PC12: 14, TBM7: 11, TBM8: 11, TBM9: 11, KODI: 12, AA5: 7, RV7: 6, RV10: 7,
  },
  heli: {
    R22: 9, R44: 12, R66: 12, EC20: 10, EC30: 12, EC35: 12, EC45: 13, EC55: 14, EC75: 16, AS50: 13, AS55: 13, AS65: 14, B06: 12, B407: 13, B412: 17, B429: 13, B505: 11,
    S76: 16, S92: 21, A109: 13, A119: 13, A139: 17, A169: 15, H60: 20, UH60: 20, H47: 30, CH47: 30, H64: 18, AH64: 18, MD52: 10, MD60: 11, H500: 9, V22: 17,
  },
  fighter: { F16: 15, F15: 19, F18: 17, F18S: 18, F35: 16, F22: 19, A10: 16, T38: 14, T45: 12, F5: 15, EUFI: 16, TOR: 17, B1: 45, B2: 21, B52: 49 },
  airlifter: { C17: 53, C5: 75, C5M: 75, C130: 30, C30J: 34, A400: 45, C2: 20, P3: 36, P8: 40, KC10: 55, KC46: 50 },
};

const BY_TYPE = new Map<string, AircraftClass>();
for (const [model, types] of Object.entries(TYPES) as [AircraftModel, Record<string, number>][]) {
  for (const [type, lengthM] of Object.entries(types)) BY_TYPE.set(type, { model, lengthM });
}

/** What an aircraft of each emitter category is drawn as when its type is not known. */
const BY_CATEGORY: Record<string, AircraftClass> = {
  A1: { model: "light", lengthM: 8 },
  A2: { model: "rearjet", lengthM: 20 },
  A3: { model: "narrow", lengthM: 38 },
  A4: { model: "narrow", lengthM: 47 },
  A5: { model: "wide", lengthM: 64 },
  A6: { model: "fighter", lengthM: 16 },
  A7: { model: "heli", lengthM: 12 },
  B1: { model: "light", lengthM: 7 },
  B4: { model: "light", lengthM: 7 },
};

const DEFAULT: AircraftClass = { model: "narrow", lengthM: 38 };

/**
 * Small aircraft are drawn a little larger than life, so a Cessna is still a shape rather than a speck
 * at the framed view's scale.
 */
export const MIN_DRAWN_LENGTH = 18;

/** A ground vehicle has no model of its own: drawn as the smallest there is, not as an airliner. */
const VEHICLE: AircraftClass = { model: "light", lengthM: 6 };

export function classify(typeCode: string | null, category: string | null, military = false): AircraftClass {
  if (isVehicle({ typeCode, category })) return { model: VEHICLE.model, lengthM: Math.max(MIN_DRAWN_LENGTH, VEHICLE.lengthM) };
  const known = typeCode ? BY_TYPE.get(typeCode.toUpperCase()) : undefined;
  const found = known ?? (category ? BY_CATEGORY[category.toUpperCase()] : undefined) ?? DEFAULT;
  // A military aircraft the type table does not know: a fast jet if it is small, else a transport.
  const cls = !known && military && found.model !== "heli" ? (found.lengthM < 25 ? { model: "fighter" as const, lengthM: 16 } : { model: "airlifter" as const, lengthM: 45 }) : found;
  return { model: cls.model, lengthM: Math.max(MIN_DRAWN_LENGTH, cls.lengthM) };
}
