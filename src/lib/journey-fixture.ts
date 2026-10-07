import type { AirportMap, Point } from "./airport-map";
import type { Airport } from "./airports";
import { KNOTS, type Origin, toGeo, toLocal } from "./geo";
import { parseHex } from "./hex";
import { journeyShot } from "./journey";
import type { FlightRoute } from "./routes";
import { TaxiRouter } from "./taxi-route";
import { parseTraffic } from "./traffic";

/**
 * The journey fixture (`?fixture=journey`): one flight gate to gate, Atlanta to Charlotte, with the
 * shape of a recording. It pushes back from a real gate, taxis along the real taxiways to the runway
 * (each airport's own taxi network), takes off, climbs, cruises, descends onto the destination's final
 * approach, lands, and taxis to a real gate there. Every second is an adsb.lol record with the fields
 * the feed sends, and the page reads it through the same parsers the API routes use: the fixture only
 * stands in for the network, never for the code that reads what comes back over it.
 *
 * A clock plays it compressed (WarpClock): fast at cruise, slower on the ground and through each hand
 * between the diorama and the map, so the whole journey runs in about two minutes.
 */

/** Seconds of simulation per step, and steps per recorded second. */
const STEP_S = 0.2;
const STEPS_PER_SAMPLE = 5;

/** Ground handling: pushback and taxi speeds and the acceleration either way, m/s and m/s^2. */
const PUSH_MS = 1.5;
const TAXI_MS = 9;
const GATE_MS = 2.5;
const TAXI_ACCEL = 0.5;
/** Rounding of taxiway corners, metres. */
const TAXI_CORNER_M = 35;
/** Takeoff and landing: acceleration on the roll, the speed it lifts off at, touchdown speed and braking. */
const ROLL_ACCEL = 2.2;
const LIFTOFF_KT = 150;
const TOUCHDOWN_KT = 135;
const BRAKING = 2;
/** Where the wheels touch down past the threshold, metres. */
const TOUCHDOWN_M = 300;
/** Speed the rollout slows to before the aircraft turns off, m/s. */
const TURN_OFF_MS = 10;
/** Climb gradients below and above 10,000 ft, feet per metre flown (2,500 fpm at 200 kt; 2,000 at 380). */
const CLIMB_LOW = 0.405;
const CLIMB_HIGH = 0.17;
/** The descent, feet per metre to go: about 3 degrees all the way down, as a continuous descent is. */
const DESCENT = 0.165;
/** The straight climb-out past the runway's end, and the final approach's length, metres. */
const CLIMB_OUT_M = 4000;
const FINAL_M = 20_000;
/** Turn radii, metres: the departure turn at 250 kt, and the turn onto final at 180. */
const DEPARTURE_TURN_M = 3500;
const FINAL_TURN_M = 2500;
/** Seconds at the gate before pushback, with the engines started, lined up before the roll, and at the gate on arrival. */
const AT_GATE_S = 20;
const ENGINES_S = 8;
const LINED_UP_S = 15;
const ARRIVED_S = 40;

export interface JourneyEnd {
  airport: Airport;
  map: AirportMap;
  /** The gate's ref in the map, "A34". */
  gate: string;
  /** The runway end used, "08R" or "01L". */
  runway: string;
}

export interface JourneyPlan {
  hex: string;
  callsign: string;
  registration: string;
  typeCode: string;
  /** UTC seconds of the first record. */
  start: number;
  cruiseFt: number;
  origin: JourneyEnd;
  destination: JourneyEnd;
}

/** One recorded second. */
export interface JourneySample {
  /** UTC seconds. */
  t: number;
  latitude: number;
  longitude: number;
  /** Feet above mean sea level; the field's elevation on the ground. */
  altitudeFt: number;
  onGround: boolean;
  groundSpeedKt: number;
  /** Degrees true the nose points: the track, except in a pushback, which goes backwards. */
  headingDeg: number;
  verticalRateFpm: number;
  pushback: boolean;
}

export interface JourneyRecording {
  plan: Omit<JourneyPlan, "origin" | "destination"> & { origin: Airport; destination: Airport };
  /** The route the lookups answer with; null as if adsbdb knew none. */
  route: FlightRoute | null;
  samples: JourneySample[];
}

/** A polyline measured along its length. */
class Path {
  private readonly cumulative: number[] = [0];
  readonly length: number;

  constructor(readonly points: Point[]) {
    for (let i = 1; i < points.length; i++) this.cumulative.push(this.cumulative[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
    this.length = this.cumulative.at(-1)!;
  }

  /** The point `s` metres along, and the direction there (degrees clockwise from north). */
  at(s: number): { p: Point; heading: number } {
    const d = Math.max(0, Math.min(this.length, s));
    let lo = 0;
    let hi = this.cumulative.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] <= d) lo = mid;
      else hi = mid;
    }
    const a = this.points[lo];
    const b = this.points[Math.min(lo + 1, this.points.length - 1)];
    const span = this.cumulative[hi] - this.cumulative[lo];
    const u = span > 0 ? (d - this.cumulative[lo]) / span : 0;
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], heading: bearing(a, b) };
  }
}

const RAD = Math.PI / 180;
const bearing = (a: Point, b: Point) => ((Math.atan2(b[0] - a[0], b[1] - a[1]) / RAD) % 360 + 360) % 360;
const along = (p: Point, deg: number, m: number): Point => [p[0] + Math.sin(deg * RAD) * m, p[1] + Math.cos(deg * RAD) * m];

/**
 * The polyline with each corner rounded into an arc of `radius` (or `radius(i)` for the corner at point
 * i; less where the legs are too short for it), drawn every few degrees.
 */
export function rounded(points: Point[], radius: number | ((i: number) => number)): Point[] {
  const out: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]];
    const inn = bearing(a, p);
    const outb = bearing(p, b);
    const turn = ((outb - inn + 540) % 360) - 180;
    const half = Math.abs(turn) / 2;
    if (Math.abs(turn) < 1) {
      out.push(p);
      continue;
    }
    const legs = Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(b[0] - p[0], b[1] - p[1])) / 2;
    const r = Math.min(typeof radius === "number" ? radius : radius(i), legs / Math.tan(half * RAD));
    const cut = r * Math.tan(half * RAD);
    const start = along(p, inn + 180, cut);
    const side = turn > 0 ? 90 : -90;
    const centre = along(start, inn + side, r);
    const steps = Math.max(2, Math.ceil(Math.abs(turn) / 4));
    for (let k = 0; k <= steps; k++) {
      const h = inn + (turn * k) / steps;
      out.push(along(centre, h - side, r));
    }
  }
  out.push(points.at(-1)!);
  return out;
}

/** One stretch of the journey: where it goes, how fast at each point along it, and how high. */
interface Leg {
  path: Path;
  /** m/s at `s` metres along. */
  speed: (s: number) => number;
  /** Feet MSL at `s`, or null on the ground. */
  altitude: (s: number) => number | null;
  /** The field's elevation, feet, for the ground: `[before, after]` the middle of a leg that starts at one airport and ends at the other. */
  ground: number | [number, number];
  /** A fixed heading for the nose (a pushback), else the path's direction. */
  heading?: number;
  /** Held in place this long, seconds, instead of moving. */
  hold?: number;
}

/** A gentle start and stop at `accel`, up to `top`. */
const eased = (length: number, top: number, accel: number, from = 0.3, to = 0.3) => (s: number) => Math.max(0.3, Math.min(top, Math.sqrt(from * from + 2 * accel * s), Math.sqrt(to * to + 2 * accel * Math.max(0, length - s))));

/** A map's gate and runway end, in the map's own metres. */
function endOf(end: JourneyEnd): { gate: Point; threshold: Point; far: Point } {
  const gate = end.map.gates.find((g) => g.ref === end.gate);
  if (!gate) throw new Error(`journey: no gate ${end.gate} at ${end.airport.code}`);
  for (const r of end.map.runways) {
    const i = r.ends.findIndex((e) => e.ref === end.runway);
    if (i < 0 || r.ends.length < 2) continue;
    const near = r.ends[i];
    const other = r.ends[1 - i];
    return { gate: [gate.x, gate.y], threshold: [near.x, near.y], far: [other.x, other.y] };
  }
  throw new Error(`journey: no runway ${end.runway} at ${end.airport.code}`);
}

/** The nearest point to `p` on any of the map's taxiways' centrelines: where a pushback from a gate ends, and a taxi in turns off for it. */
function nearestTaxiway(map: AirportMap, p: Point): Point {
  let best: Point = p;
  let bestD = Infinity;
  for (const { line } of map.taxiways) {
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len2 = dx * dx + dy * dy;
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
      const q: Point = [a[0] + u * dx, a[1] + u * dy];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < bestD) {
        best = q;
        bestD = d;
      }
    }
  }
  return best;
}

/** The taxi from `from` to `to` along the airport's taxiways, ends included, corners rounded. */
function taxiway(map: AirportMap, from: Point, to: Point): Point[] {
  const routed = new TaxiRouter(map).route(from, to);
  if (!routed) throw new Error("journey: no taxi route");
  return rounded([from, ...routed, to], TAXI_CORNER_M);
}

/** Builds the whole journey, second by second, in the origin's metres and then in latitude and longitude. */
export function recordJourney(plan: JourneyPlan): JourneyRecording {
  const o = plan.origin;
  const d = plan.destination;
  const O = endOf(o);
  const D = endOf(d);
  // The destination's points in the origin's metres, so the whole flight is one frame.
  const fromDest = ([x, y]: Point): Point => {
    const [lat, lon] = toGeo(d.airport, x, y);
    return toLocal(o.airport, lat, lon);
  };

  const legs: Leg[] = [];
  // At the gate, then pushed back onto the taxilane nose to the terminal, then out to the runway.
  const pushTo = nearestTaxiway(o.map, O.gate);
  const noseIn = bearing(pushTo, O.gate);
  const elevO = o.airport.elevationFt;
  const elevD = d.airport.elevationFt;
  const onGround = () => null;
  legs.push({ path: new Path([O.gate, O.gate]), speed: () => 0, altitude: onGround, ground: elevO, heading: noseIn, hold: AT_GATE_S });
  const push = new Path([O.gate, pushTo]);
  legs.push({ path: push, speed: eased(push.length, PUSH_MS, 0.3), altitude: onGround, ground: elevO, heading: noseIn });
  legs.push({ path: new Path([pushTo, pushTo]), speed: () => 0, altitude: onGround, ground: elevO, heading: noseIn, hold: ENGINES_S });
  const taxiOut = new Path(taxiway(o.map, pushTo, O.threshold));
  legs.push({ path: taxiOut, speed: eased(taxiOut.length, TAXI_MS, TAXI_ACCEL), altitude: onGround, ground: elevO });
  const runwayHeading = bearing(O.threshold, O.far);
  legs.push({ path: new Path([O.threshold, O.threshold]), speed: () => 0, altitude: onGround, ground: elevO, heading: runwayHeading, hold: LINED_UP_S });

  // The flight: the roll, the climb-out, the turn toward the destination's final, the final, the rollout.
  const threshold = fromDest(D.threshold);
  const finalCourse = bearing(threshold, fromDest(D.far));
  const fix = along(threshold, finalCourse + 180, FINAL_M);
  const climbOut = along(O.threshold, runwayHeading, Math.hypot(O.far[0] - O.threshold[0], O.far[1] - O.threshold[1]) + CLIMB_OUT_M);
  const rolloutM = TOUCHDOWN_M + ((TOUCHDOWN_KT * KNOTS) ** 2 - TURN_OFF_MS ** 2) / (2 * BRAKING);
  const stop = along(threshold, finalCourse, rolloutM);
  // The departure turn at the end of the climb-out, wider than the turn onto final at the fix.
  const flight = new Path(rounded([O.threshold, climbOut, fix, threshold, stop], (i) => (i === 1 ? DEPARTURE_TURN_M : FINAL_TURN_M)));
  const liftoff = (LIFTOFF_KT * KNOTS) ** 2 / (2 * ROLL_ACCEL);
  const touchdown = flight.length - rolloutM + TOUCHDOWN_M;
  const climbFt = (u: number) => {
    const low = (10_000 - elevO) / CLIMB_LOW;
    return u <= low ? elevO + u * CLIMB_LOW : 10_000 + (u - low) * CLIMB_HIGH;
  };
  const descentFt = (w: number) => elevD + w * DESCENT;
  const altitude = (s: number): number | null => (s < liftoff || s > touchdown ? null : Math.min(climbFt(s - liftoff), descentFt(touchdown - s), plan.cruiseFt));
  const lerp = (a: number, b: number, u: number) => a + (b - a) * Math.max(0, Math.min(1, u));
  const speedKt = (s: number): number => {
    const alt = altitude(s)!;
    const climbing = climbFt(s - liftoff) <= descentFt(touchdown - s) && alt < plan.cruiseFt;
    const descending = !climbing && alt < plan.cruiseFt;
    if (climbing) {
      const agl = alt - elevO;
      if (agl < 3000) return lerp(LIFTOFF_KT, 250, agl / 3000);
      if (alt < 10_000) return 250;
      return lerp(250, 440, (alt - 10_000) / 10_000);
    }
    if (descending) {
      const agl = alt - elevD;
      if (alt > 12_000) return lerp(280, 440, (alt - 12_000) / (plan.cruiseFt - 12_000));
      if (alt > 10_000) return lerp(250, 280, (alt - 10_000) / 2000);
      if (agl > 3000) return lerp(180, 250, (agl - 3000) / (10_000 - elevD - 3000));
      if (agl > 1000) return lerp(140, 180, (agl - 1000) / 2000);
      return lerp(TOUCHDOWN_KT, 140, agl / 1000);
    }
    return 440;
  };
  legs.push({
    path: flight,
    speed: (s) => {
      if (s < liftoff) return Math.max(1, Math.sqrt(2 * ROLL_ACCEL * s));
      if (s > touchdown) return Math.max(TURN_OFF_MS, Math.sqrt(Math.max(0, (TOUCHDOWN_KT * KNOTS) ** 2 - 2 * BRAKING * (s - touchdown))));
      return speedKt(s) * KNOTS;
    },
    altitude,
    // The roll is on the origin's ground, the rollout on the destination's.
    ground: [elevO, elevD],
  });

  // Off the runway and along the taxiways to the taxilane by the gate, then slowly into it.
  const runwayLength = Math.hypot(D.far[0] - D.threshold[0], D.far[1] - D.threshold[1]);
  const turnOff: Point = [D.threshold[0] + ((D.far[0] - D.threshold[0]) * rolloutM) / runwayLength, D.threshold[1] + ((D.far[1] - D.threshold[1]) * rolloutM) / runwayLength];
  const lane = nearestTaxiway(d.map, D.gate);
  const taxiIn = new Path(taxiway(d.map, turnOff, lane).map(fromDest));
  legs.push({ path: taxiIn, speed: eased(taxiIn.length, TAXI_MS, TAXI_ACCEL, TURN_OFF_MS, GATE_MS), altitude: onGround, ground: elevD });
  const parked = fromDest(D.gate);
  const intoGate = new Path(rounded([taxiIn.points.at(-1)!, parked], 0));
  legs.push({ path: intoGate, speed: eased(intoGate.length, GATE_MS, 0.3, GATE_MS), altitude: onGround, ground: elevD });
  legs.push({ path: new Path([parked, parked]), speed: () => 0, altitude: onGround, ground: elevD, heading: bearing(fromDest(lane), parked), hold: ARRIVED_S });

  // Flown leg by leg in small steps, a sample taken every second.
  const samples: JourneySample[] = [];
  let t = plan.start;
  let step = 0;
  let lastAlt = elevO;
  const take = (p: Point, heading: number, speed: number, alt: number | null, ground: number, pushback: boolean) => {
    if (step++ % STEPS_PER_SAMPLE !== 0) return;
    const [latitude, longitude] = toGeo(o.airport, p[0], p[1]);
    const altitudeFt = alt ?? ground;
    // Feet a minute over the last second, in the 64 fpm steps a transponder reports.
    const rate = alt === null ? 0 : Math.round(((altitudeFt - lastAlt) * 60) / 64) * 64;
    lastAlt = altitudeFt;
    samples.push({ t, latitude, longitude, altitudeFt, onGround: alt === null, groundSpeedKt: speed / KNOTS, headingDeg: heading, verticalRateFpm: rate, pushback });
  };
  const groundOf = (leg: Leg, s: number) => (typeof leg.ground === "number" ? leg.ground : leg.ground[s < leg.path.length / 2 ? 0 : 1]);
  for (const leg of legs) {
    if (leg.hold !== undefined) {
      for (let k = 0; k < leg.hold / STEP_S; k++, t += STEP_S) take(leg.path.at(0).p, leg.heading ?? 0, 0, null, groundOf(leg, 0), false);
      continue;
    }
    let s = 0;
    while (s < leg.path.length) {
      const { p, heading } = leg.path.at(s);
      const v = leg.speed(s);
      take(p, leg.heading ?? heading, v, leg.altitude(s), groundOf(leg, s), leg.heading !== undefined);
      s += v * STEP_S;
      t += STEP_S;
    }
  }
  const route: FlightRoute = {
    origin: { code: o.airport.code.toUpperCase(), city: o.airport.city, country: o.airport.country, latitude: o.airport.latitude, longitude: o.airport.longitude },
    destination: { code: d.airport.code.toUpperCase(), city: d.airport.city, country: d.airport.country, latitude: d.airport.latitude, longitude: d.airport.longitude },
  };
  const { origin, destination, ...rest } = plan;
  return { plan: { ...rest, origin: origin.airport, destination: destination.airport }, route, samples };
}

/** The recording's second at feed time `t`, between samples, held at either end. */
export function sampleAt(rec: JourneyRecording, t: number): JourneySample {
  const s = rec.samples;
  const i = Math.max(0, Math.min(s.length - 2, Math.floor(t - s[0].t)));
  const a = s[i];
  const b = s[i + 1];
  const u = Math.max(0, Math.min(1, t - a.t));
  const turn = ((b.headingDeg - a.headingDeg + 540) % 360) - 180;
  return {
    t,
    latitude: a.latitude + (b.latitude - a.latitude) * u,
    longitude: a.longitude + (b.longitude - a.longitude) * u,
    altitudeFt: a.altitudeFt + (b.altitudeFt - a.altitudeFt) * u,
    onGround: u < 0.5 ? a.onGround : b.onGround,
    groundSpeedKt: a.groundSpeedKt + (b.groundSpeedKt - a.groundSpeedKt) * u,
    headingDeg: (a.headingDeg + turn * u + 360) % 360,
    verticalRateFpm: u < 0.5 ? a.verticalRateFpm : b.verticalRateFpm,
    pushback: u < 0.5 ? a.pushback : b.pushback,
  };
}

/** One record as adsb.lol sends it (the fields src/lib/traffic.ts and region.ts read). */
export function rawRecord(rec: JourneyRecording, s: JourneySample): Record<string, unknown> {
  const { hex, callsign, registration, typeCode } = rec.plan;
  return {
    hex,
    type: "adsb_icao",
    flight: callsign.padEnd(8, " "),
    r: registration,
    t: typeCode,
    category: "A3",
    lat: Math.round(s.latitude * 1e6) / 1e6,
    lon: Math.round(s.longitude * 1e6) / 1e6,
    alt_baro: s.onGround ? "ground" : Math.round(s.altitudeFt / 25) * 25,
    gs: Math.round(s.groundSpeedKt * 10) / 10,
    // A pushback sends where the nose points: its track runs backwards.
    ...(s.pushback ? { true_heading: Math.round(s.headingDeg * 10) / 10 } : { track: Math.round(s.headingDeg * 10) / 10 }),
    baro_rate: s.verticalRateFpm,
    seen_pos: 0,
    seen: 0,
  };
}

/** A stretch of feed time (UTC seconds) in which the flight's transponder is quiet, as it goes on a taxiway behind a terminal or at a gate. */
export interface Silence {
  from: number;
  to: number;
}

/**
 * The windows `&gap=` asks for: `A:B,C:` in seconds into the recording, a negative one counted back from
 * its end (so `-30:` is a transponder that goes quiet 30 s before the end, at the gate, for good). A
 * part that is not a pair of numbers is left out.
 */
export function readSilences(value: string | null, start: number, end: number): Silence[] {
  const at = (n: number) => (n < 0 ? end + n : start + n);
  return (value ?? "")
    .split(",")
    .map((part) => /^(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)?$/.exec(part.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ from: at(Number(m[1])), to: m[2] === undefined ? Infinity : at(Number(m[2])) }));
}

/**
 * What the API routes would answer at feed time `t`, built through their own parsers: the airport's
 * traffic (the flight while it is within the airport's 40 km, with `background`'s records, and its
 * route), the one aircraft by hex, and the flight by callsign. Null for anything else.
 *
 * In a `silences` window the feeds go on listing the last position heard, a second older with each
 * second, as adsb.lol does; the parsers drop it once it is past a minute old, which is how a live feed
 * loses an aircraft whose transponder has gone quiet.
 */
export function journeyAnswer(rec: JourneyRecording, path: string, t: number, background: Partial<Record<Airport["code"], unknown[]>> = {}, silences: readonly Silence[] = []): unknown | null {
  const quiet = silences.find((w) => t >= w.from && t < w.to);
  const record = { ...rawRecord(rec, sampleAt(rec, quiet ? quiet.from : t)), ...(quiet && { seen_pos: t - quiet.from, seen: t - quiet.from }) };
  const s = sampleAt(rec, t);
  const now = Math.round(t * 1000);
  let m = /^\/api\/traffic\/([a-z]{3})$/.exec(path);
  if (m) {
    const airport = [rec.plan.origin, rec.plan.destination].find((a) => a.code === m![1]);
    if (!airport) return null;
    const snapshot = parseTraffic({ now, ac: [record, ...(background[airport.code] ?? [])] }, airport);
    return { ...snapshot, routes: rec.route ? { [rec.plan.callsign]: rec.route } : {} };
  }
  m = /^\/api\/hex\/([0-9a-f]{6})$/.exec(path);
  if (m) return parseHex({ now, ac: m[1] === rec.plan.hex ? [record] : [] }, m[1]);
  m = /^\/api\/flight\/([A-Z0-9]{2,8})$/.exec(path);
  if (m && m[1] === rec.plan.callsign) {
    return { callsign: rec.plan.callsign, registration: rec.plan.registration, typeCode: rec.plan.typeCode, latitude: s.latitude, longitude: s.longitude, altitudeFt: s.altitudeFt, groundSpeedKt: s.groundSpeedKt, route: rec.route };
  }
  return null;
}

/**
 * How fast the fixture plays at each point, as a multiple of real time: by how far back the camera
 * stands there (journeyShot), so it runs fastest at cruise, slower on the ground, and slowest while
 * the diorama and the map hand over (the camera between about 8 and 40 km). Log-linear between the rows.
 */
const PACE: readonly (readonly [number, number])[] = [
  [1_400, 15],
  [8_000, 12],
  [12_000, 8],
  [40_000, 8],
  [150_000, 120],
];

export function paceAt(distanceM: number): number {
  if (distanceM <= PACE[0][0]) return PACE[0][1];
  for (let i = 1; i < PACE.length; i++) {
    const [d1, r1] = PACE[i];
    if (distanceM <= d1) {
      const [d0, r0] = PACE[i - 1];
      const u = Math.log(distanceM / d0) / Math.log(d1 / d0);
      return Math.exp(Math.log(r0) + (Math.log(r1) - Math.log(r0)) * u);
    }
  }
  return PACE.at(-1)![1];
}

/** How far back the journey's camera stands at a recorded second (journeyShot). */
export function sampleDistance(rec: JourneyRecording, s: JourneySample): number {
  const to = (a: Origin) => toLocal(s, a.latitude, a.longitude);
  const bearing = ([x, y]: [number, number]) => ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  const { origin, destination } = rec.plan;
  return journeyShot({
    altitudeFt: s.altitudeFt,
    onGround: s.onGround,
    headingDeg: s.headingDeg,
    toOriginM: Math.hypot(...to(origin)),
    toDestinationM: Math.hypot(...to(destination)),
    bearingToOriginDeg: bearing(to(origin)),
    bearingToDestinationDeg: bearing(to(destination)),
    originElevationFt: origin.elevationFt,
    destinationElevationFt: destination.elevationFt,
  }).distance;
}

/**
 * The fixture's clock: wall seconds since the page opened to feed seconds in the recording, played at
 * paceAt's speed for where the flight is (times `speed`, below 1 to slow the whole of it for shots),
 * starting `from` seconds into the recording. Past the end it runs on at real time.
 */
export class WarpClock {
  /** Wall seconds from the recording's start to each recorded second. */
  private readonly wall: number[] = [0];
  private readonly offset: number;

  constructor(
    private readonly rec: JourneyRecording,
    { from = 0, speed = 1 }: { from?: number; speed?: number } = {},
  ) {
    const s = rec.samples;
    for (let i = 1; i < s.length; i++) this.wall.push(this.wall[i - 1] + 1 / (paceAt(sampleDistance(rec, s[i - 1])) * speed));
    this.offset = this.wallAt(Math.max(0, Math.min(s.length - 1, from)));
  }

  private wallAt(i: number): number {
    const k = Math.floor(i);
    return k >= this.wall.length - 1 ? this.wall.at(-1)! : this.wall[k] + (this.wall[k + 1] - this.wall[k]) * (i - k);
  }

  /** Wall seconds the recording takes to play from where it starts. */
  get duration(): number {
    return this.wall.at(-1)! - this.offset;
  }

  /** Feed seconds (UTC) after `wallS` seconds of playing. */
  at(wallS: number): number {
    const w = this.offset + Math.max(0, wallS);
    const start = this.rec.samples[0].t;
    const end = this.wall.at(-1)!;
    if (w >= end) return start + this.wall.length - 1 + (w - end);
    let lo = 0;
    let hi = this.wall.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.wall[mid] <= w) lo = mid;
      else hi = mid;
    }
    return start + lo + (w - this.wall[lo]) / (this.wall[hi] - this.wall[lo]);
  }
}

/**
 * The recording with the route its lookups give changed, for the journey's other ends: `"none"`, as if
 * adsbdb knew no route; `"unbuilt"`, as if it were bound for Greenville-Spartanburg (GSP), which is not
 * one of the airports built in 3D. The track is the same; only what the lookups say changes.
 */
export function withRoute(rec: JourneyRecording, route: "none" | "unbuilt"): JourneyRecording {
  if (route === "none") return { ...rec, route: null };
  const origin = rec.route?.origin ?? { code: "ATL", city: "Atlanta", country: "US" };
  return { ...rec, route: { origin, destination: { code: "GSP", city: "Greenville", country: "US", latitude: 34.8957, longitude: -82.2189 } } };
}

/** The flight the fixture records: Delta from Atlanta's A34 off 8R, to Charlotte's A26 on 1L. */
export function journeyPlan(origin: { airport: Airport; map: AirportMap }, destination: { airport: Airport; map: AirportMap }): JourneyPlan {
  return {
    hex: "a4c2e7",
    callsign: "DAL1947",
    registration: "N392DN",
    typeCode: "A321",
    // 14:40 in Atlanta on the day the fixture was made.
    start: Date.UTC(2026, 8, 30, 18, 40) / 1000,
    cruiseFt: 29_000,
    origin: { ...origin, gate: "A34", runway: "08R" },
    destination: { ...destination, gate: "A26", runway: "01L" },
  };
}
