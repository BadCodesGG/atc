import { type AirsideContext, assess, countTraffic, type FlightState, groundHeading, pickFeatured, type Place, type Situation, type TrafficCounts } from "./aircraft-state";
import type { AirportMap } from "./airport-map";
import type { Airport } from "./airports";
import { FEET, KNOTS } from "./geo";
import { classify, MODEL_LENGTH } from "./aircraft-class";
import { airlineName, typeName } from "./flight-names";
import { Pavement } from "./pavement";
import type { FlightRoute } from "./routes";
import type { SceneAircraft } from "./scene/airport-scene";
import { FADE_IN, PLAYBACK_DELAY, type TrackedAircraft } from "./tracker";
import type { TrafficSnapshot } from "./traffic";

/**
 * Turns what the tracker says at one moment into what the page shows: an aircraft for the scene and a
 * card's worth of words for each, the counts, and the flight the view opens on.
 */

/** Everything the selected-flight card and the leader-line tag print. */
export interface FlightCard {
  id: string;
  callsign: string;
  /** "Delta · Boeing 717-200", or whichever half is known. */
  operator: string;
  state: FlightState;
  /** "Takeoff roll, runway 9R". */
  headline: string;
  /** "Takeoff roll · 47 kt". */
  tag: string;
  speed: string;
  heading: string;
  /** Height above the field, "480 ft AGL", or "Ground". */
  altitude: string;
  /** Where it flies from and to, when known (this airport is always one end). */
  route: FlightRoute | null;
  /** Leaving this airport or coming in: from the route, else from what it is doing; null when neither says. */
  direction: "outbound" | "inbound" | null;
  /** The gate or stand it is at, or (`left`) the one it was last seen parked at before it moved off. */
  gate: (Place & { left: boolean }) | null;
}

export interface TrafficEntry {
  aircraft: TrackedAircraft;
  situation: Situation;
  scene: SceneAircraft;
  card: FlightCard;
}

export interface TrafficFrame {
  entries: TrafficEntry[];
  counts: TrafficCounts;
  featured: TrafficEntry | null;
}

/**
 * The clock at which a single fixture snapshot is drawn: the tracker's playback moment two seconds
 * after the snapshot, so every aircraft has faded fully in and moved as little as possible.
 */
export function fixtureTime(snapshot: TrafficSnapshot): number {
  return snapshot.time + PLAYBACK_DELAY + FADE_IN;
}

/**
 * Share of the way the snap moves toward its new offset each frame. Where the nearest pavement
 * changes (between two taxiways, at a junction) the aircraft eases across instead of jumping.
 */
const SNAP_EASE = 0.15;

/** The model an aircraft is drawn as, and its scale against that model. */
function drawn(a: TrackedAircraft): { model: SceneAircraft["model"]; size: number } {
  const { model, lengthM } = classify(a.typeCode, a.category, a.military);
  return { model, size: lengthM / MODEL_LENGTH[model] };
}

/** The gate or stand an aircraft was last parked at, and whether it was already parked there when first seen. */
interface LastPlace {
  place: Place;
  firstSeenThere: boolean;
}

function card(a: TrackedAircraft, s: Situation, route: FlightRoute | null, here: string, last: LastPlace | undefined): FlightCard {
  const operator = [airlineName(a.callsign), typeName(a.typeCode)].filter(Boolean).join(" · ");
  const speedKt = a.groundSpeedKt === null ? null : Math.round(a.groundSpeedKt);
  const speed = speedKt === null ? "—" : `${speedKt} kt`;
  const direction = directionOf(route, s.state, here);
  return {
    id: a.id,
    callsign: a.callsign ?? a.id.toUpperCase(),
    operator,
    state: s.state,
    headline: s.runway ? `${s.activity}, runway ${s.runway}` : s.activity,
    tag: speedKt !== null && s.moving ? `${s.activity} · ${speed}` : s.activity,
    speed,
    heading: a.headingKnown ? `${String(Math.round(a.headingDeg) % 360).padStart(3, "0")}°` : "—",
    altitude: a.onGround ? "Ground" : `${(Math.round(s.aglFt / 10) * 10).toLocaleString("en-US")} ft AGL`,
    route,
    direction,
    gate: s.place ? { ...s.place, left: false } : last && s.moving && leftFrom(last, direction) ? { ...last.place, left: true } : null,
  };
}

/**
 * Whether moving off `last` means leaving its gate. An arrival that paused by a gate on its way in has
 * not left it: so without a route to say it is outbound, only an aircraft already parked there when
 * first seen counts.
 */
function leftFrom(last: LastPlace, direction: FlightCard["direction"]): boolean {
  return direction === "outbound" || (direction === null && last.firstSeenThere);
}

function directionOf(route: FlightRoute | null, state: FlightState, here: string): FlightCard["direction"] {
  if (route) return route.origin.code.toLowerCase() === here ? "outbound" : "inbound";
  if (state === "departing") return "outbound";
  if (state === "arriving") return "inbound";
  return null;
}

export class TrafficView {
  private readonly ctx: AirsideContext;
  /** Each aircraft's last state: settles takeoff versus landing on a runway. */
  private readonly previous = new Map<string, FlightState>();
  /** Headings guessed for ground aircraft that never sent one, by id and the position they were guessed at. */
  private readonly guessed = new Map<string, { x: number; y: number; heading: number }>();
  private readonly pavement: Pavement;
  /** Each ground aircraft's current offset onto the pavement, metres east and north. */
  private readonly snaps = new Map<string, { dx: number; dy: number }>();
  /** The gate or stand each aircraft was last seen parked at. */
  private readonly places = new Map<string, LastPlace>();
  /** Routes by callsign, as the feed has sent them; kept when a later answer leaves one out. */
  private readonly routes = new Map<string, FlightRoute>();
  private readonly here: string;

  constructor(
    private readonly map: AirportMap,
    airport: Airport,
  ) {
    this.ctx = { runways: map.runways, gates: map.gates, stands: map.stands, elevationFt: airport.elevationFt };
    this.here = airport.code;
    this.pavement = new Pavement(map);
  }

  /** Takes in the routes a traffic answer carried. */
  addRoutes(routes: Record<string, FlightRoute> | undefined): void {
    for (const [callsign, route] of Object.entries(routes ?? {})) this.routes.set(callsign, route);
  }

  /**
   * Drops what it remembers about each aircraft (its last state, pavement snap, last gate), keeping the
   * routes: for when the picture jumps to another moment, where that memory would be wrong.
   */
  forget(): void {
    this.previous.clear();
    this.guessed.clear();
    this.snaps.clear();
    this.places.clear();
  }

  frame(list: TrackedAircraft[]): TrafficFrame {
    const entries: TrafficEntry[] = [];
    const seen = new Set<string>();
    for (const tracked of list) {
      seen.add(tracked.id);
      let a = tracked;
      const snap = this.snap(a);
      if (snap.dx || snap.dy) a = { ...a, x: a.x + snap.dx, y: a.y + snap.dy };
      if (!a.headingKnown && a.onGround) a = { ...a, headingDeg: this.guess(a) };
      const before = this.previous.get(a.id);
      const situation = assess(a, this.ctx, before);
      this.previous.set(a.id, situation.state);
      if (situation.place) {
        const last = this.places.get(a.id);
        const same = last && last.place.kind === situation.place.kind && last.place.ref === situation.place.ref;
        this.places.set(a.id, { place: situation.place, firstSeenThere: before === undefined || (!!same && last.firstSeenThere) });
      }
      const speedMps = (a.groundSpeedKt ?? 0) * KNOTS;
      const route = (a.callsign && this.routes.get(a.callsign)) || null;
      const lastPlace = this.places.get(a.id);
      const here = this.here;
      let built: FlightCard | null = null;
      entries.push({
        aircraft: a,
        situation,
        // Built when read: the page reads a few cards four times a second, not every card every frame.
        get card() {
          return (built ??= card(a, situation, route, here, lastPlace));
        },
        scene: {
          id: a.id,
          x: a.x,
          y: a.y,
          heightM: situation.aglFt * FEET,
          headingDeg: a.headingDeg,
          state: situation.state,
          ...drawn(a),
          // An aircraft whose direction is unknown is drawn still: no trail pointing the wrong way.
          speedMps: a.headingKnown ? speedMps : 0,
          climbMps: a.onGround ? 0 : ((a.verticalRateFpm ?? 0) / 60) * FEET,
          fade: a.fade,
        },
      });
    }
    for (const id of this.previous.keys()) if (!seen.has(id)) this.previous.delete(id);
    for (const id of this.guessed.keys()) if (!seen.has(id)) this.guessed.delete(id);
    for (const id of this.snaps.keys()) if (!seen.has(id)) this.snaps.delete(id);
    for (const id of this.places.keys()) if (!seen.has(id)) this.places.delete(id);
    const featured = pickFeatured(entries.map((e) => ({ x: e.aircraft.x, y: e.aircraft.y, situation: e.situation, entry: e })))?.entry ?? null;
    return { entries, counts: countTraffic(entries.map((e) => ({ onGround: e.aircraft.onGround, situation: e.situation }))), featured };
  }

  /**
   * How far to move an aircraft to put it on the pavement: position noise and dead reckoning can
   * leave a ground aircraft on the grass. Eased from frame to frame, except on first sight.
   */
  private snap(a: TrackedAircraft): { dx: number; dy: number } {
    const [dx, dy] = a.onGround ? this.pavement.offset(a.x, a.y) : [0, 0];
    const previous = this.snaps.get(a.id);
    const next = previous ? { dx: previous.dx + (dx - previous.dx) * SNAP_EASE, dy: previous.dy + (dy - previous.dy) * SNAP_EASE } : { dx, dy };
    this.snaps.set(a.id, next);
    return next;
  }

  private guess(a: TrackedAircraft): number {
    const cached = this.guessed.get(a.id);
    if (cached && Math.hypot(cached.x - a.x, cached.y - a.y) < 5) return cached.heading;
    const heading = groundHeading(this.map, a.x, a.y);
    this.guessed.set(a.id, { x: a.x, y: a.y, heading });
    return heading;
  }
}
