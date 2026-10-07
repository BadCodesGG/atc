/**
 * Reads the FAA's Coded Instrument Flight Procedures (CIFP, the file FAACIFP18) for a few airports:
 * each runway's final approach and its SIDs' runway transitions, with every fix placed. Pure: no
 * network, no fs. scripts/procedures.mjs runs it under Node's type stripping, so it sticks to
 * erasable TypeScript and imports nothing.
 *
 * The file is ARINC 424-18 with the exceptions in the FAA's CIFP Readme: fixed 132-column records,
 * one per line. Column numbers below are 1-based, as the specification gives them, each checked
 * against real records (ILS 9R and the SIDs at ATL, cycle 2610). Field names follow ARINC 424-18
 * chapter 5, with its section numbers.
 *
 * What it does not do, said here so nothing downstream assumes it: it keeps no approach transitions,
 * no missed approaches, no circling approaches (no runway fix to land on), no STARs, and no SID
 * enroute transitions. Leg types it reads but nothing can draw exactly (holds, procedure turns, legs
 * ending at a DME distance or a radial) stay in the legs, typed, for procedure-path.ts to skip.
 */

export interface Fix {
  id: string;
  lat: number;
  lon: number;
  /** A VHF navaid's station declination (5.66), degrees, east positive: what its radials are measured from. */
  declinationDeg?: number;
}

/** An altitude constraint (5.29, 5.30), feet above mean sea level. */
export interface Altitude {
  kind: "at" | "atOrAbove" | "atOrBelow" | "between";
  ft: number;
  /** The lower bound of "between". */
  lowerFt?: number;
}

export interface ProcedureLeg {
  /** The path and termination (5.21), "TF", "CF", "VA". */
  type: string;
  /** The fix the leg ends at (or, for an IF, is). */
  fix?: Fix;
  /** From the waypoint description code (5.17): the final approach fix, or the missed approach point. */
  role?: "FAF" | "MAP";
  /** Course or heading, degrees true: the record's magnetic one (5.26) turned true with the airport's variation. */
  courseDeg?: number;
  /** Route distance (5.27), nautical miles. */
  distanceNm?: number;
  /** Turn direction (5.20). */
  turn?: "L" | "R";
  /** An RF leg's arc centre (5.144). */
  centre?: Fix;
  /** The recommended navaid (5.23) a leg ending at a DME distance (VD, CD; the distance in distanceNm) or a radial (VR, CR) is measured from. */
  navaid?: Fix;
  /** The radial a VR or CR leg ends on (theta, 5.24), degrees true. */
  radialDeg?: number;
  altitude?: Altitude;
  /** The final's published descent angle (5.70), degrees, positive. */
  verticalAngleDeg?: number;
}

export interface Threshold {
  lat: number;
  lon: number;
  /** Landing threshold elevation (5.68) and threshold crossing height (5.67), feet. */
  elevationFt: number;
  crossingHeightFt: number;
}

export interface Approach {
  /** The CIFP's identifier, "I09R". */
  ident: string;
  /** As the chart is titled, "ILS RWY 9R". */
  name: string;
  /** From its intermediate fix (when the final route has one) to the runway, the missed approach left off. */
  legs: ProcedureLeg[];
  threshold: Threshold;
}

export interface Departure {
  /** The SID's identifier, "CUTTN2". */
  ident: string;
  /** Its runway transition, then its common route. */
  legs: ProcedureLeg[];
}

export interface AirportProcedures {
  icao: string;
  /** Degrees, east positive. */
  magVarDeg: number;
  elevationFt: number;
  /** One approach a runway (by designator, "9R"): the ILS where there is one, then RNAV (GPS), LOC, RNAV (RNP), anything else. */
  approaches: Record<string, Approach>;
  /** Every SID with a transition from the runway. */
  departures: Record<string, Departure[]>;
  /** Procedures dropped because a fix they name is in no record of the file. */
  unresolved: number;
}

export interface CifpProcedures {
  /** The AIRAC cycle, "2610". */
  cycle: string;
  /** The day it took effect, "2026-10-01". */
  effective: string;
  airports: Record<string, AirportProcedures | undefined>;
}

/** Columns `from` to `to` of a record, 1-based and inclusive as ARINC 424 numbers them. */
const col = (line: string, from: number, to = from) => line.slice(from - 1, to);

/** "N33375422" (N 33 37 54.22) or "W084325788" (W 084 32 57.88), latitude 5.36 and longitude 5.37, to degrees. */
export function parseLatLon(lat: string, lon: string): [number, number] | null {
  const la = /^([NS])(\d{2})(\d{2})(\d{4})$/.exec(lat);
  const lo = /^([EW])(\d{3})(\d{2})(\d{4})$/.exec(lon);
  if (!la || !lo) return null;
  const deg = (d: string, m: string, s: string) => Number(d) + Number(m) / 60 + Number(s) / 360_000;
  return [(la[1] === "S" ? -1 : 1) * deg(la[2], la[3], la[4]), (lo[1] === "W" ? -1 : 1) * deg(lo[2], lo[3], lo[4])];
}

/** An altitude field (5.30): "05000" feet, "FL180" a flight level; null when blank or not a number. */
function feet(field: string): number | null {
  const f = field.trim();
  if (/^FL\d{3}$/.test(f)) return Number(f.slice(2)) * 100;
  return /^-?\d+$/.test(f) ? Number(f) : null;
}

/**
 * The altitude description (5.29, col 83) with altitudes 1 and 2 (cols 85-89, 90-94). The glide slope
 * codes (G, H, I, J) and the step-down codes (V, X, Y) carry the same constraint in altitude 1 as
 * their plain counterparts, with a glide slope or step-down altitude in altitude 2 that is not a
 * constraint; "C" puts its floor in altitude 2.
 */
function altitude(line: string): Altitude | undefined {
  const code = col(line, 83);
  const a1 = feet(col(line, 85, 89));
  const a2 = feet(col(line, 90, 94));
  if (code === "C") return a2 === null ? undefined : { kind: "atOrAbove", ft: a2 };
  if (a1 === null) return undefined;
  if (code === "B") return a2 === null ? { kind: "atOrBelow", ft: a1 } : { kind: "between", ft: a1, lowerFt: a2 };
  if (code === "+" || code === "H" || code === "J" || code === "V") return { kind: "atOrAbove", ft: a1 };
  if (code === "-" || code === "Y") return { kind: "atOrBelow", ft: a1 };
  return { kind: "at", ft: a1 };
}

/** A runway identifier (5.46), "RW09R", as a pilot says it: "9R". */
const designatorOf = (rw: string) => rw.trim().replace(/^RW0?/, "");

/** Approach identifiers' first letter (5.10, col 14) as the FAA titles its charts. */
const APPROACH_KIND: Record<string, string> = {
  I: "ILS",
  R: "RNAV (GPS)",
  L: "LOC",
  H: "RNAV (RNP)",
  B: "LOC BC",
  X: "LDA",
  U: "SDF",
  D: "VOR/DME",
  V: "VOR",
  S: "VOR",
  Q: "NDB/DME",
  N: "NDB",
  P: "GPS",
};
/** Which approach a runway is drawn with, best first. */
const APPROACH_PREFERENCE = ["I", "R", "L", "H"];

interface LegRecord {
  airport: string;
  /** Section and subsection, "PF" an approach, "PD" a SID (5.4, 5.5). */
  kind: "PF" | "PD";
  ident: string;
  routeType: string;
  transition: string;
  line: string;
}

/**
 * Parses the file for the airports named (ICAO, "KATL"). Fix records are read for the whole file,
 * since a procedure can name an enroute waypoint or a navaid anywhere in it.
 */
export function parseCifp(text: string, icaos: readonly string[]): CifpProcedures {
  const wanted = new Set(icaos);
  const fixes = new Map<string, Fix>();
  const runways = new Map<string, Threshold & { id: string }>();
  const refs = new Map<string, { magVarDeg: number; elevationFt: number }>();
  const legs: LegRecord[] = [];
  let cycle = "";

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.padEnd(132);
    if (line.startsWith("HDR01")) {
      // Header 01 (ARINC 424-18 6.2.1): the cycle in columns 36-39.
      cycle = col(line, 36, 39);
      continue;
    }
    if (col(line, 1) !== "S") continue;
    const section = col(line, 5);
    const sub = section === "P" ? col(line, 13) : col(line, 6);
    const airport = col(line, 7, 10).trim();

    if (section === "P" && (sub === "F" || sub === "D")) {
      if (!wanted.has(airport)) continue;
      // Continuation number (5.16) 0 or 1 is a primary record; 2 and on add notes this does not use.
      if (!"01".includes(col(line, 39))) continue;
      legs.push({ airport, kind: sub === "F" ? "PF" : "PD", ident: col(line, 14, 19).trim(), routeType: col(line, 20), transition: col(line, 21, 25).trim(), line });
      continue;
    }

    // Fix records: continuation number in column 22, latitude in 33-41 and longitude in 42-51.
    if (!"01".includes(col(line, 22))) continue;
    if (section === "P" && sub === "A") {
      // Airport reference point (4.1.7): magnetic variation (5.39) in 52-56, elevation (5.55) in 57-61.
      const v = col(line, 52, 56);
      const tenths = Number(v.slice(1));
      refs.set(airport, { magVarDeg: (v[0] === "W" ? -1 : 1) * (tenths / 10), elevationFt: Number(col(line, 57, 61)) });
      continue;
    }
    const at = parseLatLon(col(line, 33, 41), col(line, 42, 51));
    if (section === "P" && sub === "G") {
      // Runway (4.1.10): identifier in 14-18, threshold elevation 67-71, threshold crossing height 76-77.
      const id = col(line, 14, 18).trim();
      if (at) runways.set(`${airport}|${id}`, { id, lat: at[0], lon: at[1], elevationFt: Number(col(line, 67, 71)), crossingHeightFt: Number(col(line, 76, 77)) || 50 });
      continue;
    }
    // Terminal waypoints (PC) and enroute waypoints (EA) carry a five-letter identifier in 14-18 and
    // their region in 20-21; navaids (D, DB, PN) and localizers (PI) a four-letter one in 14-17.
    const fiveLetter = (section === "P" && sub === "C") || (section === "E" && sub === "A");
    const navaid = (section === "D" && (sub === " " || sub === "B")) || (section === "P" && (sub === "N" || sub === "I"));
    if (!fiveLetter && !navaid) continue;
    const id = (fiveLetter ? col(line, 14, 18) : col(line, 14, 17)).trim();
    // A DME without a VOR has its position in the DME fields (5.36, 5.37 at 56-64, 65-74).
    const where = at ?? (section === "D" ? parseLatLon(col(line, 56, 64), col(line, 65, 74)) : null);
    if (!where) continue;
    const region = section === "P" ? airport : col(line, 20, 21);
    const fix: Fix = { id, lat: where[0], lon: where[1] };
    // A VHF navaid's station declination (5.66) in 75-79, "E0150" 15.0 east.
    const declination = section === "D" && sub === " " ? /^([EW])(\d{4})$/.exec(col(line, 75, 79)) : null;
    if (declination) fix.declinationDeg = ((declination[1] === "W" ? -1 : 1) * Number(declination[2])) / 10;
    fixes.set(`${section}${sub}|${region}|${id}`, fix);
  }

  const airports: Record<string, AirportProcedures | undefined> = {};
  for (const icao of icaos) {
    const ref = refs.get(icao);
    if (!ref) continue;
    airports[icao] = assemble(
      icao,
      ref,
      legs.filter((l) => l.airport === icao),
      fixes,
      runways,
    );
  }
  return { cycle, effective: cycle ? airacEffective(cycle) : "", airports };
}

class Unresolved extends Error {}

function assemble(
  icao: string,
  ref: { magVarDeg: number; elevationFt: number },
  records: LegRecord[],
  fixes: Map<string, Fix>,
  runways: Map<string, Threshold & { id: string }>,
): AirportProcedures {
  const out: AirportProcedures = { icao, ...ref, approaches: {}, departures: {}, unresolved: 0 };
  const toTrue = (magnetic: number) => (((magnetic + ref.magVarDeg) % 360) + 360) % 360;

  /** A fix named in a leg: identifier, region, section and subsection (cols 30-38, or 107-116 for a centre fix). */
  const fixAt = (line: string, idCols: [number, number], regionCols: [number, number], secCol: number): Fix | undefined => {
    const id = col(line, ...idCols).trim();
    if (!id) return undefined;
    const section = col(line, secCol);
    const sub = col(line, secCol + 1);
    if (section === "P" && sub === "G") {
      const rw = runways.get(`${icao}|${id}`);
      if (!rw) throw new Unresolved(id);
      return { id, lat: rw.lat, lon: rw.lon };
    }
    const region = section === "P" ? icao : col(line, ...regionCols);
    const fix = fixes.get(`${section}${sub}|${region}|${id}`);
    if (!fix) throw new Unresolved(id);
    return fix;
  };

  const legOf = (line: string): ProcedureLeg => {
    const leg: ProcedureLeg = { type: col(line, 48, 49) };
    const fix = fixAt(line, [30, 34], [35, 36], 37);
    if (fix) leg.fix = fix;
    // Waypoint description code (5.17), its fourth character: F the final approach fix, M the missed approach point.
    const role = col(line, 43);
    if (role === "F") leg.role = "FAF";
    else if (role === "M") leg.role = "MAP";
    // Magnetic course (5.26), tenths of a degree; a T in its last column marks a true course in whole degrees.
    const course = col(line, 71, 74);
    if (/^\d{3}T$/.test(course)) leg.courseDeg = Number(course.slice(0, 3));
    else if (/^\d{4}$/.test(course)) leg.courseDeg = toTrue(Number(course) / 10);
    const distance = col(line, 75, 78);
    if (/^\d{4}$/.test(distance)) leg.distanceNm = Number(distance) / 10;
    const turn = col(line, 44);
    if (turn === "L" || turn === "R") leg.turn = turn;
    // Legs ending at a DME distance or on a radial: the recommended navaid in 51-56, its section and subsection in 79-80, the radial (theta) in 63-66.
    if (leg.type === "VD" || leg.type === "CD" || leg.type === "VR" || leg.type === "CR") {
      const navaid = fixAt(line, [51, 54], [55, 56], 79);
      if (navaid) leg.navaid = navaid;
      const theta = col(line, 63, 66);
      if (navaid && (leg.type === "VR" || leg.type === "CR") && /^\d{4}$/.test(theta)) {
        leg.radialDeg = ((((Number(theta) / 10 + (navaid.declinationDeg ?? ref.magVarDeg)) % 360) + 360) % 360);
      }
    }
    if (leg.type === "RF") {
      const centre = fixAt(line, [107, 111], [113, 114], 115);
      if (centre) leg.centre = centre;
    }
    const alt = altitude(line);
    if (alt) leg.altitude = alt;
    // Vertical angle (5.70), hundredths of a degree, negative for a descent; "000" when there is none.
    const angle = col(line, 103, 106).trim();
    if (/^-\d{3}$/.test(angle) && Number(angle) < 0) leg.verticalAngleDeg = -Number(angle) / 100;
    return leg;
  };

  const routes = new Map<string, LegRecord[]>();
  for (const r of records) {
    const key = `${r.kind}|${r.ident}|${r.routeType}|${r.transition}`;
    routes.set(key, [...(routes.get(key) ?? []), r]);
  }

  // Approaches: the final route is the one with no transition (5.11) and a route type (5.7) other than A (an approach transition).
  const finals: { runway: string; approach: Approach; rank: number }[] = [];
  for (const route of routes.values()) {
    const first = route[0];
    if (first.kind !== "PF" || first.routeType === "A" || first.transition) continue;
    // The final ends at its missed approach point; the leg after it (flagged M in the description code's third character) begins the missed approach.
    const final = [];
    for (const r of route) {
      if (col(r.line, 42) === "M") break;
      final.push(r);
      if (col(r.line, 43) === "M") break;
    }
    const runwayLine = final.find((r) => col(r.line, 37, 38) === "PG");
    // A circling approach names no runway fix: there is no straight-in final to draw.
    if (!runwayLine) continue;
    const rwId = col(runwayLine.line, 30, 34).trim();
    const threshold = runways.get(`${icao}|${rwId}`);
    if (!threshold) continue;
    try {
      const runway = designatorOf(rwId);
      const ident = first.ident;
      // The identifier (5.10) is the approach type in column 14, the runway in 15-17 and, where the
      // chart has one, the suffix in 18: "R08LY" is RNAV (GPS) Y RWY 8L.
      const suffix = col(first.line, 18).trim();
      const kind = APPROACH_KIND[ident[0]] ?? "Approach";
      const t: Threshold = { lat: threshold.lat, lon: threshold.lon, elevationFt: threshold.elevationFt, crossingHeightFt: threshold.crossingHeightFt };
      const rank = APPROACH_PREFERENCE.indexOf(ident[0]);
      finals.push({
        runway,
        rank: (rank < 0 ? APPROACH_PREFERENCE.length : rank) * 2 + (suffix ? 1 : 0),
        approach: { ident, name: `${kind}${suffix ? ` ${suffix}` : ""} RWY ${runway}`, legs: final.map((r) => legOf(r.line)), threshold: t },
      });
    } catch (e) {
      if (!(e instanceof Unresolved)) throw e;
      out.unresolved++;
    }
  }
  finals.sort((p, q) => p.rank - q.rank || p.approach.ident.localeCompare(q.approach.ident));
  for (const f of finals) out.approaches[f.runway] ??= f.approach;

  // SIDs: each runway transition ("RW09L"; "RW08B" for every parallel of 08; "ALL" for every runway), then the common route (no transition).
  const allRunways = [...runways.keys()].filter((k) => k.startsWith(`${icao}|`)).map((k) => k.slice(icao.length + 1));
  const sids = new Map<string, { transitions: LegRecord[][]; common: LegRecord[] }>();
  for (const route of routes.values()) {
    const first = route[0];
    // Route type 0 is an engine-out SID, not the one flown.
    if (first.kind !== "PD" || first.routeType === "0") continue;
    const sid = sids.get(first.ident) ?? { transitions: [], common: [] };
    sids.set(first.ident, sid);
    if (!first.transition) sid.common = route;
    else if (first.transition.startsWith("RW") || first.transition === "ALL") sid.transitions.push(route);
  }
  for (const [ident, sid] of sids) {
    const routesByRunway = sid.transitions.length ? sid.transitions : sid.common.length ? [[]] : [];
    for (const transition of routesByRunway) {
      const name = transition[0]?.transition ?? "ALL";
      const ids = name === "ALL" ? allRunways : name.endsWith("B") ? allRunways.filter((id) => id.startsWith(name.slice(0, 4)) && /[LCR]$/.test(id)) : [name];
      let built: ProcedureLeg[];
      try {
        built = [...transition, ...sid.common].map((r) => legOf(r.line));
      } catch (e) {
        if (!(e instanceof Unresolved)) throw e;
        out.unresolved++;
        continue;
      }
      for (const id of ids) {
        if (!allRunways.includes(id)) continue;
        const runway = designatorOf(id);
        (out.departures[runway] ??= []).push({ ident, legs: built });
      }
    }
  }
  return out;
}

const DAY = 86_400_000;
/** AIRAC cycle 2401 took effect on 25 January 2024; every cycle is 28 days. */
const AIRAC_EPOCH = Date.UTC(2024, 0, 25);

/** The day an AIRAC cycle ("2610", year and cycle of the year) takes effect, "2026-10-01". */
export function airacEffective(cycle: string): string {
  const year = 2000 + Number(cycle.slice(0, 2));
  const n = Number(cycle.slice(2));
  // The year's first cycle: the first 28-day step from the epoch that falls in it.
  const steps = Math.ceil((Date.UTC(year, 0, 1) - AIRAC_EPOCH) / (28 * DAY));
  return new Date(AIRAC_EPOCH + (steps + n - 1) * 28 * DAY).toISOString().slice(0, 10);
}
