import type { Runway } from "../airport-map";
import type { LocalApproach, LocalDeparture, LocalLeg, LocalProcedures } from "../procedure-path";

/** A synthetic field for the journey's tests: a runway pair running east-west (09/27) and one north-south (18/36), crossing at the origin, each end with a straight-in ILS. */
export const RUNWAYS: Runway[] = [
  { ref: "09/27", width: 45, surface: null, centerline: [], ends: [{ ref: "09", x: -1500, y: 0 }, { ref: "27", x: 1500, y: 0 }] },
  { ref: "18/36", width: 45, surface: null, centerline: [], ends: [{ ref: "18", x: 0, y: 1500 }, { ref: "36", x: 0, y: -1500 }] },
];

/** [east, north] unit vectors of each runway end's heading, to lay procedures out along. */
const HEADING: Record<string, [number, number]> = { "9": [1, 0], "27": [-1, 0], "18": [0, -1], "36": [0, 1] };
const THRESHOLD: Record<string, [number, number]> = { "9": [-1500, 0], "27": [1500, 0], "18": [0, 1500], "36": [0, -1500] };

/** A straight-in ILS to `end`: an intermediate fix 15 km out, the final approach fix 6 km out, the threshold. */
function approach(end: string): LocalApproach {
  const [ux, uy] = HEADING[end];
  const [tx, ty] = THRESHOLD[end];
  const at = (back: number): [number, number] => [tx - ux * back, ty - uy * back];
  const legs: LocalLeg[] = [
    { type: "IF", at: at(15000), altitudeM: { kind: "atOrAbove", m: 900 } },
    { type: "CF", at: at(6000), role: "FAF" },
    { type: "CF", at: [tx, ty], role: "MAP", verticalAngleDeg: 3 },
  ];
  return { ident: `I${end}`, name: `ILS RWY ${end}`, legs, threshold: { x: tx, y: ty, heightM: 15 } };
}

/** The field's procedures: an ILS to each of `ends` (their designators, "9"), and `departures`, in a frame centred on `origin`. */
export const procedures = (ends: string[], departures: Record<string, LocalDeparture[]> = {}, origin = { latitude: 35.2, longitude: -80.9 }): LocalProcedures => ({
  cycle: "2610",
  effective: "2026-10-01",
  origin,
  approaches: Object.fromEntries(ends.map((e) => [e, approach(e)])),
  departures,
});

