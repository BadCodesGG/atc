import type { Sighting } from "./alerts";

/**
 * Scripted traffic for a smoke check of the alerts: `?fixture=1&alerts=takeoff` (or pushback, landing,
 * emergency, military, all) plays the lists below through the same detector the live feed uses, once the
 * reader has turned alerts on. The frozen fixture never changes, so nothing else could make an event.
 * Each script runs on past its event, so a detector that said it on every poll would say it many times.
 */

export const ALERT_FIXTURES = ["pushback", "takeoff", "landing", "emergency", "military", "all"] as const;

export interface FixtureStep {
  /** Feed seconds. */
  time: number;
  list: Sighting[];
}

export interface FixtureScript {
  /** The ids the script follows, as the Follow button would. */
  watched: string[];
  steps: FixtureStep[];
}

function plane(over: Partial<Sighting>): Sighting {
  return { id: "a00001", callsign: "DAL100", typeCode: "A321", squawk: "1200", military: false, onGround: true, groundSpeedKt: 0, latitude: 33.64, longitude: -84.43, ...over };
}

/** `n` polls five seconds apart from `from`, each list made by `make(i)`. */
function polls(from: number, n: number, make: (i: number) => Sighting[]): FixtureStep[] {
  return Array.from({ length: n }, (_, i) => ({ time: from + i * 5, list: make(i) }));
}

const ONE: Record<Exclude<(typeof ALERT_FIXTURES)[number], "all">, () => FixtureScript> = {
  pushback: () => {
    const id = "a00001";
    return {
      watched: [id],
      steps: [
        ...polls(0, 26, () => [plane({ id })]),
        ...polls(130, 6, (i) => [plane({ id, latitude: 33.64 + (60 + i * 20) / 111_000, groundSpeedKt: 3 })]),
      ],
    };
  },
  takeoff: () => {
    const id = "a00002";
    return {
      watched: [id],
      steps: [...polls(0, 2, () => [plane({ id, callsign: "AAL200" })]), ...polls(10, 6, () => [plane({ id, callsign: "AAL200", onGround: false, groundSpeedKt: 160 })])],
    };
  },
  landing: () => {
    const id = "a00003";
    return {
      watched: [id],
      steps: [...polls(0, 2, () => [plane({ id, callsign: "UAL300", onGround: false, groundSpeedKt: 140 })]), ...polls(10, 6, () => [plane({ id, callsign: "UAL300", groundSpeedKt: 30 })])],
    };
  },
  emergency: () => {
    const id = "a00004";
    return {
      watched: [],
      steps: [...polls(0, 2, () => [plane({ id, callsign: "SWA400", onGround: false, groundSpeedKt: 300 })]), ...polls(10, 6, () => [plane({ id, callsign: "SWA400", squawk: "7700", onGround: false, groundSpeedKt: 300 })])],
    };
  },
  military: () => {
    const civil = plane({ id: "a00005", callsign: "DAL500" });
    return {
      watched: [],
      steps: [...polls(0, 2, () => [civil]), ...polls(10, 6, () => [civil, plane({ id: "ae0001", callsign: "RCH401", typeCode: "C17", military: true, onGround: false, groundSpeedKt: 400 })])],
    };
  },
};

/** The script for an `alerts=` value, or null for one that is not a kind. */
export function fixtureScript(name: string): FixtureScript | null {
  if (name === "all") {
    let offset = 0;
    const out: FixtureScript = { watched: [], steps: [] };
    for (const kind of ["pushback", "takeoff", "landing", "emergency", "military"] as const) {
      const one = ONE[kind]();
      out.watched.push(...one.watched);
      for (const step of one.steps) out.steps.push({ time: step.time + offset, list: step.list });
      offset += one.steps.at(-1)!.time + 5;
    }
    return out;
  }
  return Object.hasOwn(ONE, name) ? ONE[name as keyof typeof ONE]() : null;
}
