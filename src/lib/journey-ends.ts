import type { Runway } from "./airport-map";
import type { Airport } from "./airports";
import type { FeedSource } from "./feed-source";
import { FEET, type Origin, toLocal } from "./geo";
import { aheadOf, alongLine, arrivalRunway, departureRunway } from "./journey-procedure";
import type { Metar, Wind } from "./metar";
import { citeProcedure } from "./path-pulse";
import { type LinePoint, type LocalProcedures, type ProcedurePath, procedurePath } from "./procedure-path";

/**
 * The published procedures of the two ends of a gate-to-gate journey, held for the journey: the origin's
 * SID the flight likely flew (looked for only for a flight seen taking off or climbing out), and the destination's
 * approach to the runway it is likely landing on. Loaded once per airport (the chunks are lazy, and
 * cached), the destination's wind read when the journey knows where it is going and again every ten
 * minutes; nothing here runs a read or a search per frame but arithmetic on lines already made. The
 * sums are journey-procedure.ts's.
 */

export interface EndData {
  procedures: LocalProcedures;
  runways: readonly Runway[];
}

const loaded = new Map<Airport["code"], Promise<EndData | null>>();

/** An airport's procedures and runways, loaded on the first ask; null when either would not load. */
export function loadEnd(airport: Airport): Promise<EndData | null> {
  let end = loaded.get(airport.code);
  if (!end) {
    end = Promise.all([import("./procedure-data").then((m) => m.loadProcedures(airport)), import("./airport-data").then((m) => m.loadAirportMap(airport.code))])
      .then(([procedures, map]): EndData => ({ procedures, runways: map.runways }))
      .catch((error: unknown) => {
        console.error("atc: the journey's procedures failed to load", error);
        return null;
      });
    loaded.set(airport.code, end);
  }
  return end;
}

/** Seconds of the feed's clock between reads of the destination's wind. */
const WIND_S = 600;
/** A flight first seen in the air is taken to be climbing out of its origin when it is no higher than this above the field, metres. */
const CLIMB_OUT_M = 900;
/** The arrival's runway is picked again when the aircraft has moved this far, metres, from where it last was. */
const REPICK_M = 2000;

export interface EndsFix {
  latitude: number;
  longitude: number;
  altitudeFt: number;
  onGround: boolean;
  /** Degrees true; null before any report has carried one. */
  headingDeg: number | null;
}

/** What is still ahead of the aircraft: each line as [longitude, latitude, metres above its field], and the card's words for the procedure it is on or next to fly. */
export interface EndsPlan {
  climbOut: LinePoint[];
  approach: LinePoint[];
  /** The aircraft is on the approach's line (not converging on it), so the map draws the approach on from the aircraft with no estimate beside it. */
  onApproach: boolean;
  cites: string[];
}

export class JourneyEnds {
  private origin: EndData | null = null;
  private destination: { airport: Airport; data: EndData | null } | null = null;
  /** Where the flight is going, built or not: the SID leaving toward it is the likely one. */
  private bound: Origin | null = null;
  private wind: Wind | null = null;
  private stopWind: (() => void) | null = null;
  private stopped = false;
  private sawGround = false;
  private homeLoading = false;
  private liftOff: (Origin & { headingDeg: number; heightM: number }) | null = null;
  /** The SID, once worked out: undefined before, null when there is none. */
  private sid: ProcedurePath | null | undefined;
  private arrival: { runway: string; path: ProcedurePath | null; at: Origin; wind: Wind | null } | null = null;

  constructor(
    private readonly source: FeedSource,
    private readonly home: Airport,
    private readonly load: (airport: Airport) => Promise<EndData | null> = loadEnd,
  ) {}

  /** Where the flight is going: a built airport (its approach is drawn), or just a place (its bearing picks the SID), or nowhere known. */
  setDestination(airport: Airport | null, point: Origin | null): void {
    if (airport?.code !== this.destination?.airport.code) {
      this.destination = airport && { airport, data: null };
      this.arrival = null;
      this.wind = null;
      this.stopWind?.();
      this.stopWind = null;
      if (airport) {
        void this.load(airport).then((data) => {
          if (!this.stopped && this.destination?.airport === airport) this.destination.data = data;
        });
        void this.readWind(airport);
        this.stopWind = this.source.every(WIND_S, () => void this.readWind(airport));
      }
    }
    if (point?.latitude !== this.bound?.latitude || point?.longitude !== this.bound?.longitude) {
      this.bound = point;
      this.sid = undefined;
    }
  }

  /**
   * Takes in a sighting of the aircraft, to see it lift off: the first time it is in the air having been on
   * the ground, or first seen low enough to be climbing out (a flight followed after it left the runway).
   */
  watch(fix: EndsFix): void {
    if (this.liftOff) return;
    if (fix.onGround) {
      this.sawGround = true;
      this.loadHome();
      return;
    }
    const heightM = Math.max(0, (fix.altitudeFt - this.home.elevationFt) * FEET);
    if ((this.sawGround || heightM <= CLIMB_OUT_M) && fix.headingDeg !== null) {
      this.liftOff = { latitude: fix.latitude, longitude: fix.longitude, headingDeg: fix.headingDeg, heightM };
      this.loadHome();
    }
  }

  /** The procedures ahead of the aircraft at `fix`; empty while nothing is loaded, published, or still ahead. */
  plan(fix: EndsFix): EndsPlan {
    const cites: string[] = [];
    let climbOut: LinePoint[] = [];
    let approach: LinePoint[] = [];
    let onApproach = false;
    const sid = this.departure();
    if (sid && this.origin) {
      const [x, y] = toLocal(this.origin.procedures.origin, fix.latitude, fix.longitude);
      climbOut = sid.geo.slice(aheadOf(sid.points, x, y, "drop"));
      if (climbOut.length) cites.push(citeProcedure({ kind: "climb-out", name: sid.name, cycle: sid.cycle, likely: sid.likely }));
    }
    const path = this.arrivalPath(fix);
    if (path && this.destination?.data) {
      const [x, y] = toLocal(this.destination.data.procedures.origin, fix.latitude, fix.longitude);
      approach = path.geo.slice(aheadOf(path.points, x, y, "from-start"));
      onApproach = approach.length > 0 && alongLine(path.points, x, y);
      // One line on the card: the climb-out while it is still ahead, the approach after.
      if (approach.length && !cites.length) cites.push(citeProcedure({ kind: "approach", name: path.name, cycle: path.cycle, likely: true }));
    }
    return { climbOut, approach, onApproach, cites };
  }

  dispose(): void {
    this.stopped = true;
    this.stopWind?.();
  }

  /** The origin's procedures, once a flight there is seen to be taking off: they load while it taxis. */
  private loadHome(): void {
    if (this.homeLoading) return;
    this.homeLoading = true;
    void this.load(this.home).then((data) => {
      if (!this.stopped) this.origin = data;
    });
  }

  private departure(): ProcedurePath | null {
    if (this.sid !== undefined) return this.sid;
    const { origin, liftOff, bound } = this;
    if (!origin || !liftOff || !bound) return null;
    const [x, y] = toLocal(origin.procedures.origin, liftOff.latitude, liftOff.longitude);
    const runway = departureRunway({ runways: origin.runways, procedures: origin.procedures, liftOff: { x, y, headingDeg: liftOff.headingDeg } });
    return (this.sid = runway ? procedurePath(origin.procedures, runway, "climb-out", { from: [x, y, liftOff.heightM], destination: bound }) : null);
  }

  /** The approach to the runway the aircraft is likely landing on, picked again only when the wind has changed or it has moved on. */
  private arrivalPath(fix: EndsFix): ProcedurePath | null {
    const data = this.destination?.data;
    if (!data) return null;
    const held = this.arrival;
    if (held && held.wind === this.wind && Math.hypot(...toLocal(held.at, fix.latitude, fix.longitude)) < REPICK_M) return held.path;
    const [x, y] = toLocal(fix, data.procedures.origin.latitude, data.procedures.origin.longitude);
    const runway = arrivalRunway({ runways: data.runways, wind: this.wind, bearingDeg: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360, held: held?.runway });
    const path = runway ? procedurePath(data.procedures, runway, "approach") : null;
    this.arrival = { runway: runway ?? "", path, at: { latitude: fix.latitude, longitude: fix.longitude }, wind: this.wind };
    return path;
  }

  private async readWind(airport: Airport): Promise<void> {
    try {
      const res = await this.source.get(`/api/weather/${airport.code}`);
      const body = res.ok ? ((await res.json()) as Partial<Metar>) : null;
      if (this.stopped || this.destination?.airport !== airport) return;
      this.wind = body?.wind ?? null;
    } catch {
      // A missed read leaves the last wind; without one the inbound bearing picks the runway.
    }
  }
}
