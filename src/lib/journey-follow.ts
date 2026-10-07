import type { Place } from "./aircraft-state";
import { type Airport, airportByCode } from "./airports";
import type { FeedSource } from "./feed-source";
import { lookupCallsign } from "./flight-lookup";
import { FEET, type Origin, toGeo, toLocal } from "./geo";
import { MAP_ORIGIN, mergeRegions } from "./globe/sky";
import type { EndsFix, JourneyEnds } from "./journey-ends";
import { journeyLines } from "./journey-procedure";
import type { HexSnapshot } from "./hex";
import { type JourneyEnd, journeyEnd, journeyProgress, type JourneyProgress, type JourneyShot, journeyShot } from "./journey";
import type { FlightRoute } from "./routes";
import { groundView, seenOnGround } from "./globe/camera";
import type { OrbitView } from "./scene/orbit";
import { PLAYBACK_DELAY, Tracker } from "./tracker";

/**
 * One flight followed gate to gate, held by the page so it outlives each airport's diorama. It reads
 * the aircraft by its hex all the way (`/api/hex`, every five seconds of the feed's clock), on the same
 * playback delay the dioramas draw at, so the map and the diorama show the aircraft at the same moment
 * wherever they hand over. While the map leads, it steers the map's camera behind the flight.
 */

/** Where the journey is: on the origin's diorama, on the map, on the destination's diorama, or parked at the end. */
export type JourneyStage = "origin" | "map" | "destination" | "arrived";

/** A flight that went quiet at its stand and is then drawn this far from where it stood, metres, is moving again: it had not parked. */
const MOVED_M = 50;
/** Seconds of the feed's clock between reads of the aircraft. */
const POLL_S = 5;
/** A read's answer says anything about the flight's silence for this long, seconds of the feed's clock: a few polls. */
const ANSWER_FRESH_S = 3 * POLL_S;
/** Time constants, seconds, of the camera's turn and tilt toward the shot's (slow: it swings round to look ahead at cruise), and of the hand from the diorama's camera to the journey's. */
const TURN_S = 2.5;
const SETTLE_S = 0.8;
/** How long the journey's own reads fly the aircraft on through a gap, seconds. */
const DEAD_RECKON_S = 60;
/** A place the flight was on the ground is kept every this many seconds of the feed's clock, the last GROUND_TRAIL_MAX of them. */
const GROUND_TRAIL_S = 2;
const GROUND_TRAIL_MAX = 6;
/** A diorama's sighting of the flight stands for this long, ms: a frame or two. */
const SIGHTING_MS = 100;
/** A point is added to the way flown every this many seconds of flight. */
const TRAIL_S = 10;
/** The most points the way flown holds: two hours of flight at TRAIL_S, which the map re-projects every frame while it leads. */
export const TRAIL_MAX = 720;

/**
 * Keeps `points` (oldest first) to at most `max` by dropping every other point of the older half whenever
 * it is exceeded: the way flown thins with age, the newest part keeps its full detail, and the first and
 * the latest points are never dropped, so the line still starts where the flight did.
 */
export function boundTrail<T>(points: T[], max: number): void {
  if (points.length <= max) return;
  const older = points.length >> 1;
  points.splice(0, older, ...points.slice(0, older).filter((_, i) => i % 2 === 0));
}

export interface JourneyFix {
  latitude: number;
  longitude: number;
  /** Feet above mean sea level; 0 on the ground, as the feed has it. */
  altitudeFt: number;
  onGround: boolean;
  groundSpeedKt: number | null;
  headingDeg: number;
  verticalRateFpm: number | null;
  callsign: string | null;
  typeCode: string | null;
}

/** Where a journey ended: the gate or stand the flight parked at (null when the map does not name it), and whether it was never read standing there but went quiet by it. */
export interface JourneyArrival {
  place: Place | null;
  quiet: boolean;
}

/** What the page shows of the journey: the panel's figures, and the line that says where it will end. */
export interface JourneyStatus {
  stage: JourneyStage;
  /** The followed aircraft's hex: the card it belongs to. */
  hex: string;
  callsign: string;
  /** Where it set out, as the route names it; null when no route names it (a flight picked on the map before one is known). */
  from: string | null;
  /** The destination's code, or null with no route known. */
  to: string | null;
  progress: JourneyProgress | null;
  /** The destination's time zone, for the estimated arrival; null when it is not a built airport. */
  timeZone: string | null;
  /** Said when the journey cannot end at a gate (no route, or a destination not built). */
  endLine: string | null;
  /** The published procedures drawn on the map now, as the flight card cites them (citeProcedure); empty when none is. */
  procedures: string[];
  /** The map draws a dashed estimate of the way left now, which the card says is one. */
  estimated: boolean;
  /** Where the journey ended, once the flight has parked (stage "arrived"); null before. */
  arrival: JourneyArrival | null;
  fix: JourneyFix | null;
}

/** What the map draws for the followed flight: where the aircraft appears, its heading, the way flown and the way left. */
export interface JourneyFeatures {
  aircraft: [number, number] | null;
  headingDeg: number;
  flown: [number, number][];
  /** The way left that is only an estimate: great circles between the aircraft, the published lines and the field. */
  left: [number, number][];
  /** The published climb-out the flight likely flew, still ahead of it. */
  climbOut: [number, number][];
  /** The published approach to the runway it is likely landing on, from the first fix still ahead. */
  approach: [number, number][];
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;
const turnToward = (from: number, to: number, k: number) => wrap(from + ((((to - from) % 360) + 540) % 360 - 180) * k);

export class Journey {
  readonly hex: string;
  readonly callsign: string;
  readonly origin: Airport;
  stage: JourneyStage = "origin";
  private route: FlightRoute | null;
  private end: JourneyEnd;
  /** Whether `origin` is where the flight set out; false when it is only the built airport nearest it (a flight picked on the map). */
  private readonly originKnown: boolean;
  /** Where the flight was first seen: where the way flown starts for a flight picked on the map, until a route says where it set out. */
  private firstSeen: Origin | null = null;
  /** The published procedures of the two ends, once their chunk has loaded (journey-ends.ts). */
  private ends: JourneyEnds | null = null;
  /** The procedures drawn on the map at the last frame, as the card cites them. */
  private cited: string[] = [];
  /** Set when features() changed what the card cites, until citeChanged() reports it. */
  private citedChanged = false;
  /** Whether the lines last given to the map included a dashed estimate of the way left. */
  private estimating = false;
  /** What the procedures' chunk has missed while it loaded: the first sightings of the aircraft on the ground and in the air, to replay. */
  private early: EndsFix[] = [];
  /** Flown on through a gap in the reads for a minute: an aircraft in the air goes on as it was going. */
  private readonly tracker = new Tracker({ deadReckonMax: DEAD_RECKON_S });
  /** When the flight was last drawn by a diorama or read by the journey's own poll, on the feed's clock, seconds. */
  private lastReport: number | null = null;
  /** The newest position the journey's own reads have heard, on the feed's clock (a read's time less its position's age), seconds. */
  private lastPosition: number | null = null;
  /** When the journey's own reads were last answered with fresh data (not an error, not a stale answer), on the feed's clock, seconds. */
  private lastAnswer: number | null = null;
  /** Where the flight was last seen on the ground: an aircraft cannot leave the ground unseen, so it is still there when the feeds lose it. */
  private ground: JourneyFix | null = null;
  /** Where the journey ended, and where the flight stood when it did. */
  private arrival: (JourneyArrival & { at: Origin }) | null = null;
  /** Where the flight was on the ground over its last few seconds, oldest first, the newest its latest fix: what shows it braking toward a stand. Empty in the air. */
  private groundTrail: JourneyFix[] = [];
  private groundTrailAt = -Infinity;
  /** The flight as shown once it went quiet at its stand: standing still there, whatever its last listing says, until it is drawn moving again. */
  private standing: JourneyFix | null = null;
  private readonly stopPoll: () => void;
  private stopped = false;
  /** The way flown: a fix every so often, with its height, read time and where it was. */
  private readonly flown: { t: number; latitude: number; longitude: number; altitudeFt: number }[] = [];
  private lastTrail = -Infinity;
  /**
   * What still separates the map camera's aim (metres east and north) and distance (a factor) from the
   * shot's since it took the camera from the diorama.
   */
  private cam: { offset: [number, number]; scale: number; at: number } | null = null;
  private sighting: { fix: JourneyFix; at: number } | null = null;
  /** Shown on a phone (the stacked layout): its shots keep the aircraft near the middle. */
  compact = false;
  /** Whether the aircraft was last seen in the air, so a touchdown is seen once. */
  private airborne = false;
  /** The way the camera looks, turned toward the shot's at an even pace, the same in a diorama and on the map; null on the ground. */
  private looking: { azimuthDeg: number; elevationDeg: number; at: number } | null = null;

  constructor(
    private readonly source: FeedSource,
    { hex, callsign, origin, route, originKnown = true }: { hex: string; callsign: string; origin: Airport; route: FlightRoute | null; originKnown?: boolean },
  ) {
    this.hex = hex;
    this.callsign = callsign;
    this.origin = origin;
    this.route = route;
    this.originKnown = originKnown;
    this.end = journeyEnd(route);
    // The procedures are a chunk of their own, loaded for these two airports only.
    void import("./journey-ends")
      .then(({ JourneyEnds }) => {
        if (this.stopped) return;
        this.ends = new JourneyEnds(source, origin);
        for (const fix of this.early.splice(0)) this.ends.watch(fix);
        this.pointEnds();
      })
      .catch((error: unknown) => console.error("atc: the journey's procedures failed to start", error));
    void this.read();
    this.stopPoll = source.every(POLL_S, () => void this.read());
    // No route with the traffic: ask the flight lookup (adsbdb behind it) where it is going.
    if (!route) void this.lookUpRoute();
  }

  /** The journey's destination diorama, when there is one to land on. */
  get destination(): Airport | null {
    return this.end.kind === "gate" ? this.end.destination : null;
  }

  /** The feed's clock, the page's one, which the dioramas run on too. */
  clock(): number {
    return this.source.clock();
  }

  /**
   * The aircraft as a diorama draws it this frame: while an airport's diorama has the flight in its feed,
   * the journey takes it from there, so the camera aims and the map draws exactly where the diorama does
   * (two trackers fed by two polls disagree by a few hundred metres while one waits on a late answer).
   */
  sight(fix: JourneyFix | null, now: number): void {
    this.sighting = fix ? { fix, at: now } : null;
    if (fix) {
      this.firstSeen ??= { latitude: fix.latitude, longitude: fix.longitude };
      this.reported(fix);
      this.watch(fix);
    }
  }

  /** The flight was drawn or read at `fix`: it is not lost, and it is held there if it is on the ground. */
  private reported(fix: JourneyFix): void {
    this.lastReport = this.clock();
    this.ground = fix.onGround ? fix : null;
    if (!fix.onGround) {
      this.groundTrail = [];
      this.groundTrailAt = -Infinity;
    } else if (this.lastReport - this.groundTrailAt >= GROUND_TRAIL_S) {
      this.groundTrailAt = this.lastReport;
      this.groundTrail = [...this.groundTrail, fix].slice(-GROUND_TRAIL_MAX);
    } else this.groundTrail[this.groundTrail.length - 1] = fix;
    // A flight that went quiet by its stand and is drawn moving again had not parked.
    const { arrival } = this;
    if (arrival?.quiet && (!fix.onGround || this.distanceTo(arrival.at, fix) > MOVED_M)) {
      this.stage = "destination";
      this.arrival = null;
      this.standing = null;
    }
  }

  /** Shows the procedures a sighting of the aircraft, or keeps the first on the ground and in the air for when they load. */
  private watch(fix: EndsFix): void {
    if (this.ends) this.ends.watch(fix);
    else if (!this.early.some((e) => e.onGround === fix.onGround) && this.early.length < 2) this.early.push(fix);
  }

  /**
   * How long since the flight was last drawn by a diorama or read, ms of the feed's clock (so a recording
   * played fast and the live feed lose a flight alike); 0 before it ever was, so a journey that has just begun waits.
   */
  lostFor(): number {
    return this.lastReport === null ? 0 : (this.clock() - this.lastReport) * 1000;
  }

  /**
   * How long the flight's position has gone unheard, seconds of the feed's clock, by the journey's own reads
   * (the feeds go on listing a position for a minute). Null before the first, and while the reads are not
   * being answered: an upstream that fails or serves its last answer says nothing of the transponder.
   */
  silentFor(): number | null {
    if (this.lastPosition === null || this.lastAnswer === null || this.clock() - this.lastAnswer > ANSWER_FRESH_S) return null;
    return this.clock() - this.lastPosition;
  }

  /**
   * The flight has parked at its destination: at `place` (the gate or stand, null when the map does not name
   * it), read standing there, or `quiet` when it went from the feeds near one instead (its transponder
   * switched off at the stand). Only a journey in its destination's diorama ends, and a quiet one is shown standing still (fix).
   */
  arrive(place: Place | null, quiet: boolean): void {
    if (this.stage !== "destination") return;
    const held = this.fix();
    this.stage = "arrived";
    this.arrival = { place, quiet, at: held ?? this.destinationPoint() ?? this.origin };
    this.standing = quiet && held ? { ...held, groundSpeedKt: 0 } : null;
  }

  /** Where the flight was on the ground over its last seconds, oldest first (groundTrail); empty in the air. */
  recentGround(): readonly JourneyFix[] {
    return this.groundTrail;
  }

  /** Where the journey ended, once the flight has parked; null before. */
  arrived(): JourneyArrival | null {
    return this.arrival && { place: this.arrival.place, quiet: this.arrival.quiet };
  }

  /** Where the aircraft is drawn now: as the diorama has it (sight), else from its own hex reads, else where it was last seen on the ground; null before the first read, or once lost in the air. A flight that went quiet at its stand is shown standing still until it is drawn moving. */
  fix(): JourneyFix | null {
    if (this.standing) return this.standing;
    if (this.sighting && performance.now() - this.sighting.at < SIGHTING_MS) return this.sighting.fix;
    const a = this.tracker.at(this.clock()).find((t) => t.id === this.hex);
    if (!a) return this.ground;
    const [latitude, longitude] = toGeo(MAP_ORIGIN, a.x, a.y);
    return { latitude, longitude, altitudeFt: a.altitudeFt, onGround: a.onGround, groundSpeedKt: a.groundSpeedKt, headingDeg: a.headingDeg, verticalRateFpm: a.verticalRateFpm, callsign: a.callsign, typeCode: a.typeCode };
  }

  /** The aircraft's height above the nearer end of the journey, metres: the dioramas draw it above their own field. */
  heightOf(fix: Pick<JourneyFix, "latitude" | "longitude" | "altitudeFt" | "onGround">): number {
    if (fix.onGround) return 0;
    const dest = this.destination;
    const nearer = dest && this.distanceTo(dest, fix) < this.distanceTo(this.origin, fix) ? dest : this.origin;
    return Math.max(0, (fix.altitudeFt - nearer.elevationFt) * FEET);
  }

  /** The journey's camera for this fix (journeyShot). */
  shot(fix: JourneyFix): JourneyShot {
    const dest = this.destination;
    const toOrigin = toLocal(fix, this.origin.latitude, this.origin.longitude);
    const toDest = dest ? toLocal(fix, dest.latitude, dest.longitude) : null;
    const bearing = ([x, y]: [number, number]) => ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
    return journeyShot({
      altitudeFt: fix.altitudeFt,
      onGround: fix.onGround,
      headingDeg: fix.headingDeg,
      toOriginM: Math.hypot(...toOrigin),
      toDestinationM: toDest ? Math.hypot(...toDest) : null,
      bearingToOriginDeg: bearing(toOrigin),
      bearingToDestinationDeg: toDest ? bearing(toDest) : null,
      originElevationFt: this.origin.elevationFt,
      destinationElevationFt: dest?.elevationFt ?? null,
      compact: this.compact,
    });
  }

  /**
   * Whether the camera's distance is the journey's to set now: always in the air; on the ground only on
   * the frame of a touchdown, which brings it in close once, and otherwise the reader's, so a zoom on
   * the ground holds.
   */
  setsDistance(fix: Pick<JourneyFix, "onGround">): boolean {
    const touchdown = this.airborne && fix.onGround;
    this.airborne = !fix.onGround;
    return !fix.onGround || touchdown;
  }

  /**
   * The way the camera looks for this shot at `now`: turned and tilted toward the shot's at an even pace
   * from `current`, the camera's own, where it starts. Null on the ground, where the reader's view stands
   * (and where the next climb starts from it again).
   */
  look(shot: JourneyShot, now: number, current: { azimuthDeg: number; elevationDeg: number }): { azimuthDeg: number; elevationDeg: number } | null {
    if (shot.azimuthDeg === null || shot.elevationDeg === null) {
      this.looking = null;
      return null;
    }
    const l = (this.looking ??= { azimuthDeg: current.azimuthDeg, elevationDeg: current.elevationDeg, at: now });
    const dt = Math.max(0, Math.min(0.25, (now - l.at) / 1000));
    l.at = now;
    const k = 1 - Math.exp(-dt / TURN_S);
    l.azimuthDeg = turnToward(l.azimuthDeg, shot.azimuthDeg, k);
    l.elevationDeg += (shot.elevationDeg - l.elevationDeg) * k;
    return { azimuthDeg: l.azimuthDeg, elevationDeg: l.elevationDeg };
  }

  /**
   * The point the camera aims at for this fix and shot, in `frame`'s metres, and its height: the share
   * of the way from the aircraft (at its height) toward the field (on the ground) the shot asks for.
   */
  aimOf(fix: JourneyFix, shot: JourneyShot, frame: Origin): { target: [number, number]; height: number } {
    const [x, y] = toLocal(frame, fix.latitude, fix.longitude);
    const field = shot.field === "origin" ? this.origin : (this.destination ?? this.origin);
    const [fx, fy] = toLocal(frame, field.latitude, field.longitude);
    return { target: [x + (fx - x) * shot.aim, y + (fy - y) * shot.aim], height: this.heightOf(fix) * (1 - shot.aim) };
  }

  status(nowMs: number): JourneyStatus {
    const fix = this.fix();
    const to = this.route?.destination.code ?? null;
    const dest = this.destination;
    const destinationPoint = this.destinationPoint();
    return {
      stage: this.stage,
      hex: this.hex,
      callsign: this.callsign,
      from: this.originKnown ? this.origin.code.toUpperCase() : (this.route?.origin.code.toUpperCase() ?? null),
      to,
      progress: fix ? journeyProgress(this.start(), destinationPoint, fix, nowMs) : null,
      timeZone: dest?.timeZone ?? null,
      endLine: this.end.kind === "map" ? this.end.line : null,
      procedures: this.stage === "map" ? this.cited : [],
      estimated: this.stage === "map" && this.estimating,
      arrival: this.arrived(),
      fix,
    };
  }

  /**
   * The map takes the camera from the diorama: from `view` (the diorama's camera, in `airport`'s metres)
   * exactly, the same camera brought down its line of sight to the ground; whatever separates that from
   * the journey's own shot then (where it aims, how far back) dies away over a second.
   */
  toMap(view: OrbitView, airport: Airport, now: number): void {
    this.stage = "map";
    // The map's camera turns on from the diorama camera's own bearing and tilt.
    this.looking = { azimuthDeg: view.azimuthDeg, elevationDeg: view.elevationDeg, at: now };
    const ground = groundView(view);
    const [lat, lon] = toGeo(airport, ground.target[0], ground.target[1]);
    const fix = this.fix();
    const from = fix ? toLocal(fix, lat, lon) : null;
    const shot = fix && this.shot(fix);
    const ideal = fix && shot ? this.groundShot(fix, shot, view) : null;
    this.cam = {
      offset: ideal && from ? [from[0] - ideal.target[0], from[1] - ideal.target[1]] : [0, 0],
      scale: ideal ? ground.distance / ideal.distance : 1,
      at: now,
    };
  }

  /**
   * The journey's shot as the map draws it, looking as `look` does: the camera's view brought down to the
   * ground, in metres from the aircraft's own ground point. Bearings hold true there: in a frame centred a
   * thousand kilometres away (the map's own) north is turned some degrees, and every offset along the
   * camera's bearing would land that far to the side.
   */
  private groundShot(fix: JourneyFix, shot: JourneyShot, look: { azimuthDeg: number; elevationDeg: number }): OrbitView {
    const aim = this.aimOf(fix, shot, fix);
    return groundView({ azimuthDeg: look.azimuthDeg, elevationDeg: look.elevationDeg, target: aim.target, height: aim.height, distance: shot.distance });
  }

  /** The destination's diorama has the camera: the map no longer steers. */
  landed(): void {
    this.stage = "destination";
    this.cam = null;
  }

  /**
   * The map's camera for this frame, while the map leads: the journey's shot of the flight, on the ground
   * (the map looks at nothing else), turned and tilted toward the shot's at an even pace, with what it
   * took over from the diorama dying away. Returns the view, in metres from `frame` (the aircraft's ground
   * point this frame), and the fix, or null with no fix.
   */
  mapView(now: number): { view: OrbitView; fix: JourneyFix; frame: Origin } | null {
    const fix = this.fix();
    if (!fix || !this.cam) return null;
    const cam = this.cam;
    const dt = Math.max(0, Math.min(0.25, (now - cam.at) / 1000));
    cam.at = now;
    const settle = Math.exp(-dt / SETTLE_S);
    cam.scale = 1 + (cam.scale - 1) * settle;
    cam.offset = [cam.offset[0] * settle, cam.offset[1] * settle];
    const shot = this.shot(fix);
    // The map only leads in the air, where the shot always says which way to look; the diorama started the turn.
    const looking = this.look(shot, now, this.looking ?? { azimuthDeg: shot.azimuthDeg ?? 0, elevationDeg: shot.elevationDeg ?? 45 });
    if (!looking) return null;
    const ideal = this.groundShot(fix, shot, looking);
    const view: OrbitView = { ...ideal, target: [ideal.target[0] + cam.offset[0], ideal.target[1] + cam.offset[1]], distance: ideal.distance * cam.scale };
    return { view, fix, frame: { latitude: fix.latitude, longitude: fix.longitude } };
  }

  /**
   * What the map draws for the flight, as `view`'s camera (in metres from `frame`) sees it: every point of it in the air is drawn
   * where its line of sight meets the ground, which is where the diorama draws it, so the aircraft and the
   * way it has flown (up to the moment drawn, not the latest read) sit where they appear in three
   * dimensions; the way left runs on from the aircraft.
   */
  features(view: OrbitView | null, frame: Origin): JourneyFeatures {
    const fix = this.fix();
    const place = (latitude: number, longitude: number, heightM: number): [number, number] => {
      const at = toLocal(frame, latitude, longitude);
      const [x, y] = view ? seenOnGround(view, at, heightM) : at;
      const [lat, lon] = toGeo(frame, x, y);
      return [lon, lat];
    };
    const seen = (p: { latitude: number; longitude: number; altitudeFt: number; onGround: boolean }) => place(p.latitude, p.longitude, this.heightOf(p));
    const aircraft = fix ? seen(fix) : null;
    const drawn = this.clock() - PLAYBACK_DELAY;
    const way = this.flown.filter((p) => p.t <= drawn).map((p) => seen({ ...p, onGround: false }));
    const dest = this.destinationPoint();
    const start = this.start();
    // What is published and still ahead is drawn on the ground track the procedure flies, whatever the camera:
    // placed by its height as the aircraft is, its far points would shift with every frame of the camera, and the
    // map's source, re-cut each frame in tiles that arrive one by one, would show the line stepped where two meet.
    // The aircraft stands where the diorama draws it; the line runs on from there. The rest of the way left is an estimate.
    const plan = fix ? this.ends?.plan(fix) : undefined;
    // The card cites what the map is given: no lines drawn (no aircraft, or nowhere known to go) is nothing cited.
    const cited = aircraft && dest ? (plan?.cites ?? []) : [];
    const changed = cited.length !== this.cited.length || cited.some((line, i) => line !== this.cited[i]);
    this.cited = cited;
    if (changed) this.citedChanged = true;
    const onGround = ([lon, lat]: readonly number[]): [number, number] => [lon, lat];
    const lines =
      aircraft && dest ? journeyLines(aircraft, [dest.longitude, dest.latitude], plan?.climbOut.map(onGround) ?? [], plan?.approach.map(onGround) ?? [], plan?.onApproach ?? false) : { left: [], climbOut: [], approach: [] };
    this.estimating = lines.left.length > 0;
    return {
      aircraft,
      headingDeg: fix?.headingDeg ?? 0,
      flown: aircraft ? [[start.longitude, start.latitude], ...way, aircraft] : [],
      ...lines,
    };
  }

  /**
   * Whether the lines last given to the map changed what the card cites, reported once. The panel reads
   * status() on a timer, and a card that lags its map by a tick cites a climb-out the map has already
   * dropped (the smoke check for the approach after the SID caught exactly that); the page reads this in
   * the frame it hands the map its lines and brings the card up at once.
   */
  citeChanged(): boolean {
    const changed = this.citedChanged;
    this.citedChanged = false;
    return changed;
  }

  /**
   * Where the way flown is measured from. A flight followed out of its origin set out from that airport.
   * One picked on the map has only the built airport nearest it, which may be its destination: it is
   * measured from the route's origin once the lookup has learned one (built or not), and until then from
   * where it was first seen.
   */
  private start(): Origin {
    if (this.originKnown) return this.origin;
    const set = this.route?.origin;
    if (set?.latitude !== undefined && set.longitude !== undefined) return { latitude: set.latitude, longitude: set.longitude };
    return (set && airportByCode(set.code.toLowerCase())) || this.firstSeen || this.origin;
  }

  /** Where the flight is going, built or not; null with no route. */
  private destinationPoint(): Origin | null {
    const far = this.route?.destination;
    return this.destination ?? (far?.latitude !== undefined && far.longitude !== undefined ? { latitude: far.latitude, longitude: far.longitude } : null);
  }

  /** Tells the procedures where the flight is going, once that is known. */
  private pointEnds(): void {
    this.ends?.setDestination(this.destination, this.destinationPoint());
  }

  dispose(): void {
    this.stopped = true;
    this.stopPoll();
    this.ends?.dispose();
  }

  private distanceTo(from: Origin, fix: Pick<JourneyFix, "latitude" | "longitude">): number {
    return Math.hypot(...toLocal(from, fix.latitude, fix.longitude));
  }

  private async read(): Promise<void> {
    try {
      const res = await this.source.get(`/api/hex/${this.hex}`);
      if (this.stopped || !res.ok) return;
      const body = (await res.json()) as HexSnapshot & { stale?: boolean };
      if (this.stopped || typeof body?.time !== "number") return;
      // A fresh answer that lists nothing is the best evidence of a quiet transponder there is.
      if (!body.stale) this.lastAnswer = this.clock();
      if (!body.aircraft) return;
      this.source.heard(body.time);
      this.firstSeen ??= { latitude: body.aircraft.latitude, longitude: body.aircraft.longitude };
      this.tracker.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: body.time, aircraft: [body.aircraft] }], MAP_ORIGIN));
      const a = body.aircraft;
      this.lastPosition = Math.max(this.lastPosition ?? -Infinity, body.time - (a.positionAgeS ?? 0));
      const fix: JourneyFix = { latitude: a.latitude, longitude: a.longitude, altitudeFt: a.altitudeFt ?? 0, onGround: a.onGround, groundSpeedKt: a.groundSpeedKt, headingDeg: a.trackDeg ?? 0, verticalRateFpm: a.verticalRateFpm, callsign: a.callsign, typeCode: a.typeCode };
      this.reported(fix);
      // The procedures tell a heading never reported from north.
      this.watch({ ...fix, headingDeg: a.trackDeg });
      if (!a.onGround && body.time - this.lastTrail >= TRAIL_S) {
        this.lastTrail = body.time;
        this.flown.push({ t: body.time, latitude: a.latitude, longitude: a.longitude, altitudeFt: a.altitudeFt ?? 0 });
        boundTrail(this.flown, TRAIL_MAX);
      }
    } catch {
      // A missed read is covered by the tracker's dead reckoning; the next one catches up.
    }
  }

  private async lookUpRoute(): Promise<void> {
    try {
      // The route answers the normalised callsign's address only (any other spelling is a redirect).
      const callsign = lookupCallsign(this.callsign);
      if (!callsign) return;
      const res = await this.source.get(`/api/flight/${callsign}`);
      if (this.stopped || !res.ok) return;
      const body = (await res.json()) as { route?: FlightRoute | null };
      if (this.stopped || !body.route) return;
      this.route = body.route;
      this.end = journeyEnd(body.route);
      this.pointEnds();
    } catch {
      // Without a route the journey ends on the map, and says so.
    }
  }
}
