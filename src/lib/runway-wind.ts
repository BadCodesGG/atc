import type { Runway } from "./airport-map";
import type { Wind } from "./metar";

/** One runway end the wind favours: aircraft take off and land on it heading into the wind. */
export interface FavouredEnd {
  /** The runway's ref ("08L/26R"). */
  runway: string | null;
  /** The end's designator ("26R"): where a departure starts its roll, an arrival touches down. */
  end: string;
  /** Degrees true an aircraft on it heads, from the mapped geometry rather than the designator. */
  headingDeg: number;
  headwindKt: number;
  /** Across the runway, either side. */
  crosswindKt: number;
}

/**
 * The runway ends the reported wind favours, most headwind first: of each runway with both ends
 * mapped, the end with a headwind. Calm, variable or straight-across winds favour none, and a light
 * wind (under 5 knots or so) seldom decides which way an airport operates on its own: the airport's
 * own preference and its traffic do. Headings are true, as the map and the METAR's wind are.
 */
export function favouredRunwayEnds(runways: readonly Runway[], wind: Wind): FavouredEnd[] {
  if (wind.directionDeg === null || wind.speedKt <= 0) return [];
  const out: FavouredEnd[] = [];
  for (const runway of runways) {
    if (runway.ends.length !== 2) continue;
    for (const [from, to] of [runway.ends, [...runway.ends].reverse()]) {
      const headingDeg = ((Math.atan2(to.x - from.x, to.y - from.y) * 180) / Math.PI + 360) % 360;
      const off = ((wind.directionDeg - headingDeg) * Math.PI) / 180;
      const headwindKt = wind.speedKt * Math.cos(off);
      // Less than a tenth of a knot is straight across.
      if (headwindKt > 0.1) out.push({ runway: runway.ref, end: from.ref, headingDeg: Math.round(headingDeg * 10) / 10, headwindKt: round1(headwindKt), crosswindKt: round1(Math.abs(wind.speedKt * Math.sin(off))) });
    }
  }
  return out.sort((a, b) => b.headwindKt - a.headwindKt);
}

const round1 = (n: number) => Math.round(n * 10) / 10;
