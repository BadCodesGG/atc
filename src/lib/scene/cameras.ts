import { designator, type FlightState } from "../aircraft-state";
import type { AirportMap, Point, Runway } from "../airport-map";
import { MODEL_LENGTH } from "../aircraft-class";
import type { SceneAircraft } from "./airport-scene";
import { DEG_PER_PX, ease, type OrbitBounds, type OrbitView } from "./orbit";
import { MODEL } from "./theme";
import { TILT_STEP, TURN_STEP, type ViewKey } from "./view-keys";

/**
 * The camera modes beside the orbit: a drone chasing the selected flight, the tower's view raised to a
 * high oblique, and an approach camera above and behind an arrival. All three stay above the diorama,
 * looking down at it, and never far enough toward the horizon to show where the model ends. Each is
 * worked out as an eye and a point it looks at, then handed to the scene as an OrbitView, so the scene
 * places it, and eases to and from it, exactly as it does the orbit.
 *
 * Inside a mode the reader can look around (ModeLook) without leaving it: round the aircraft in the
 * drone and approach views, from the cab in the tower, always within the same rules.
 */

export type CameraMode = "orbit" | "tower" | "drone" | "approach";

export const MODES: readonly CameraMode[] = ["orbit", "tower", "drone", "approach"];

const DEG = 180 / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** Degrees into -180 to 180. */
const wrap180 = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/**
 * The reader's look around inside a mode, as offsets from the mode's own framing. The rig keeps it and
 * each frame stores back the offsets as the mode clamped them, so a drag past a limit is not saved up
 * to be undone on the way back.
 */
export interface ModeLook {
  /** Degrees added to the mode's bearing: round the aircraft (drone, approach), or the cab's yaw (tower). */
  bearingDeg: number;
  /** Degrees added to the mode's look down; positive looks more steeply down. */
  pitchDeg: number;
  /** Times the mode's distance from the aircraft (drone, approach), or its lens (tower). */
  zoom: number;
}

export const NO_LOOK: ModeLook = { bearingDeg: 0, pitchDeg: 0, zoom: 1 };
/** How far in and out the wheel or a pinch takes a drone or approach camera, as a share of its own distance. */
export const LOOK_ZOOM = { min: 0.6, max: 2.5 } as const;
/** The tower cab's lens, vertical degrees, as the wheel narrows or widens it. */
const TOWER_LENS = { min: 12, max: 45 } as const;
/**
 * The steepest any mode looks down, degrees: short of straight down, where a turn would only spin the
 * picture and the tower would look into its own walls.
 */
export const LOOK_MAX_PITCH = 75;
/** How long a key's or a button's step of the look takes to ease, ms. */
export const LOOK_EASE_MS = 500;

/** The mapped field, as the orbit keeps to it: a circle round home. */
export type MappedArea = Pick<OrbitBounds, "home" | "radius">;

/**
 * How far a line of sight from `from` along compass bearing `azDeg` runs over the ground before it
 * leaves `area`; 0 when it starts outside.
 */
function runWithin(area: MappedArea, from: Point, azDeg: number): number {
  const ux = Math.sin(azDeg / DEG);
  const uy = Math.cos(azDeg / DEG);
  const ox = from[0] - area.home[0];
  const oy = from[1] - area.home[1];
  const b = ux * ox + uy * oy;
  const c = ox * ox + oy * oy - area.radius * area.radius;
  const disc = b * b - c;
  return disc > 0 ? Math.max(0, -b + Math.sqrt(disc)) : 0;
}

/** A mode's view, and the look it was framed with, clamped to what the mode allows. */
export interface Shot {
  view: OrbitView;
  look: ModeLook;
}

/**
 * What a drag of dx, dy CSS pixels does to the look: across turns as the orbit does; down tilts the
 * drone and approach down round the aircraft, and the tower's look up, as if the picture were held.
 */
export function lookDrag(mode: CameraMode, dxPx: number, dyPx: number): ModeLook {
  return { bearingDeg: -dxPx * DEG_PER_PX || 0, pitchDeg: (mode === "tower" ? -dyPx : dyPx) * DEG_PER_PX || 0, zoom: 1 };
}

/** What a view key does in a mode: the arrows and Q and E turn, up and down (with shift or without) tilt, plus and minus zoom. */
export function lookKey(key: ViewKey): ModeLook {
  switch (key.kind) {
    case "zoom":
      return { bearingDeg: 0, pitchDeg: 0, zoom: key.factor };
    case "turn":
      return { bearingDeg: key.deg, pitchDeg: key.tilt, zoom: 1 };
    default:
      return { bearingDeg: key.right * TURN_STEP || 0, pitchDeg: key.forward * TILT_STEP || 0, zoom: 1 };
  }
}

/** A point in map metres: east, north, and up from the field. */
export type Vec3 = [number, number, number];

/** The view from `eye` toward `look` through a lens `fovDeg` tall, as a close camera mode (eyeLevel 1). */
export function lookFrom(eye: Vec3, look: Vec3, fovDeg: number): OrbitView {
  const dx = look[0] - eye[0];
  const dy = look[1] - eye[1];
  const dh = look[2] - eye[2];
  const ground = Math.hypot(dx, dy);
  return {
    azimuthDeg: (((Math.atan2(dx, dy) * DEG) % 360) + 360) % 360,
    elevationDeg: Math.atan2(-dh, ground) * DEG,
    target: [look[0], look[1]],
    height: look[2],
    distance: Math.hypot(ground, dh),
    fovDeg,
    eyeLevel: 1,
  };
}

/**
 * How far over the ground any part of a close camera's frame may reach, metres. Within it the field
 * and the haze (each theme's close-up fog ends a little past it) cover the ground; beyond it lie the
 * horizon and the end of the model, which no mode shows.
 */
export const HORIZON_REACH = 8000;
/** The frame's top corners lie this much wider than the aspect alone says: the view offset slides the picture sideways. */
const OFFSET_SLACK = 1.25;

/**
 * The least a camera `eyeHeight` metres up must look down, degrees, for every ray through the top
 * edge of a frame `fovDeg` tall and `aspect` wide to land on the ground within `reach` metres.
 */
export function minPitch(fovDeg: number, aspect: number, eyeHeight: number, reach: number): number {
  const t = Math.tan(fovDeg / 2 / DEG);
  const side = aspect * t * OFFSET_SLACK;
  for (let p = fovDeg / 2; p < 89; p += 0.1) {
    const r = p / DEG;
    // The ray through a top corner: forward plus up (tilted with the camera) plus sideways.
    const down = Math.sin(r) - t * Math.cos(r);
    const across = Math.hypot(Math.cos(r) + t * Math.sin(r), side);
    if (down > 0 && (eyeHeight * across) / down <= reach) return p;
  }
  return 89;
}

/** Closer than this the aircraft are drawn at true size; farther than `far`, at the model's exaggeration. */
const TRUE_SIZE = { near: 300, far: 3000 } as const;

/**
 * How many times life size to draw an aircraft `distance` metres from the camera: true size up close,
 * so a chase shows an airliner and not a toy, easing to MODEL.aircraftScale from afar, where it keeps
 * a jet readable at airport scale.
 */
export function drawnScale(distance: number): number {
  const u = clamp((distance - TRUE_SIZE.near) / (TRUE_SIZE.far - TRUE_SIZE.near), 0, 1);
  return 1 + (MODEL.aircraftScale - 1) * u * u * (3 - 2 * u);
}

/** The aircraft a camera rides with or looks at. */
export interface Subject {
  x: number;
  y: number;
  heightM: number;
  headingDeg: number;
  /** Its true length, metres. */
  length: number;
  speedMps: number;
  climbMps: number;
}

/** A drawn aircraft as a camera's subject. */
export function subjectOf(a: SceneAircraft): Subject {
  return { x: a.x, y: a.y, heightM: a.heightM, headingDeg: a.headingDeg, length: MODEL_LENGTH[a.model] * a.size, speedMps: a.speedMps, climbMps: a.climbMps };
}

/** Lenses, vertical degrees. */
const FOV = { drone: 30, approach: 40, tower: 30 } as const;

/**
 * An arrival farther than `beyond` metres short of its runway's threshold has it kept in frame: the
 * camera turns toward it and looks less steeply down, so the threshold sits `at` of the way from the
 * frame's middle to its top edge. The haze then ends `haze` times as far as the threshold, within
 * `maxHaze`, and the tilt is never flatter than `minPitch` degrees.
 */
const GOAL = { beyond: 1500, at: 0.4, haze: 1.5, maxHaze: 25_000, minPitch: 3 } as const;

/** Where a far arrival's camera should keep its runway: its tilt for the threshold, its bearing to it, and how far it is. */
function goalFraming(s: Subject, goal: Point | null, eyeAbove: number, fovDeg: number, back: (pitchDeg: number) => number): { pitchDeg: number; bearingDeg: number; distance: number } | null {
  if (!goal) return null;
  const d = Math.hypot(goal[0] - s.x, goal[1] - s.y);
  if (d <= GOAL.beyond) return null;
  const above = Math.atan(GOAL.at * Math.tan(fovDeg / 2 / DEG)) * DEG;
  // The eye sits behind the aircraft by an amount that itself depends on the tilt: settle it in two passes.
  let pitch = 20;
  for (let i = 0; i < 3; i++) pitch = Math.atan2(s.heightM + eyeAbove, d + back(pitch)) * DEG + above;
  return { pitchDeg: Math.max(GOAL.minPitch, pitch), bearingDeg: (((Math.atan2(goal[0] - s.x, goal[1] - s.y) * DEG) % 360) + 360) % 360, distance: d + back(pitch) };
}

/** Metres above the aircraft a drone or approach camera flies: two and a half lengths, within 60 to 150 m. */
function heightAbove(s: Subject): number {
  return clamp(2.5 * s.length, 60, 150);
}

/**
 * Above and behind the aircraft along `bearingDeg`, looking down `pitchDeg` (steeper if the horizon
 * would show), with the aircraft `belowDeg` under the middle of the frame; turned, tilted and moved in
 * or out by `look`, never flatter than the horizon allows.
 */
function behindAndAbove(s: Subject, bearingDeg: number, pitchDeg: number, belowDeg: number, fovDeg: number, aspect: number, look: ModeLook, goal: Point | null = null): Shot {
  const zoom = clamp(look.zoom, LOOK_ZOOM.min, LOOK_ZOOM.max);
  const above = heightAbove(s) * zoom;
  const below = aspect < 1 ? 0 : belowDeg;
  const framing = goalFraming(s, goal, above, fovDeg, (p) => above / Math.tan((p + below) / DEG));
  if (framing) {
    pitchDeg = Math.min(pitchDeg, framing.pitchDeg);
    bearingDeg = framing.bearingDeg;
  }
  // A far arrival's frame reaches its runway and the horizon past it: the ground plane runs on under
  // the haze, and the sky over it, so only the least tilt holds.
  const floor = framing ? GOAL.minPitch : minPitch(fovDeg, aspect, s.heightM + above, HORIZON_REACH);
  // The offset is from the mode's tilt as the horizon allows it now, so a floor raised by a climb-out
  // holds the view only while it applies.
  const base = Math.max(pitchDeg, floor);
  const pitch = Math.max(floor, Math.min(base + look.pitchDeg, LOOK_MAX_PITCH));
  const b = (bearingDeg + look.bearingDeg) / DEG;
  // A portrait frame keeps the aircraft at its middle: below it on a phone is under the flight card.
  const back = above / Math.tan((pitch + below) / DEG);
  const eye: Vec3 = [s.x - Math.sin(b) * back, s.y - Math.cos(b) * back, s.heightM + above];
  const reach = above / Math.tan(pitch / DEG);
  const haze = framing ? { haze: Math.min(GOAL.maxHaze, framing.distance * GOAL.haze) } : {};
  return {
    view: { ...lookFrom(eye, [eye[0] + Math.sin(b) * reach, eye[1] + Math.cos(b) * reach, s.heightM], fovDeg), trueSize: 1, ...haze },
    look: { bearingDeg: wrap180(look.bearingDeg), pitchDeg: pitch - base, zoom },
  };
}

/**
 * The drone: its tilt, how much of the frame's width the aircraft spans, how far back it may follow
 * (metres, slant), and the speed (m/s) at which it has backed off half as far again.
 */
const DRONE = { pitch: 18, share: 0.2, nearest: 200, farthest: 400, backOff: 150 } as const;
/** Wingspan as a share of length, near enough for every model. */
const SPAN = 0.85;

/**
 * A drone chasing the aircraft along its track: 200 to 400 m back (further the faster it goes),
 * looking down 18 degrees, the aircraft about a fifth of the frame wide in its lower third (its middle
 * on a phone, above the flight card) and the airport ahead in view. Low over the field the top of the
 * frame lands within a couple of kilometres; higher up the horizon may come into frame, so the haze
 * ends before the edge of the model does, rather than the drone looking more steeply down.
 */
export function droneView(s: Subject, aspect: number, goal: Point | null = null): OrbitView {
  return droneShot(s, aspect, NO_LOOK, goal).view;
}

/**
 * The drone turned round the aircraft, tilted and moved in or out by `look`. It never looks flatter
 * than its own tilt, the least that keeps the frame's top edge on the ground ahead.
 */
function droneShot(s: Subject, aspect: number, look: ModeLook, goal: Point | null = null): Shot {
  const t = Math.tan(FOV.drone / 2 / DEG);
  const fit = (SPAN * s.length) / (2 * DRONE.share * aspect * t);
  const zoom = clamp(look.zoom, LOOK_ZOOM.min, LOOK_ZOOM.max);
  const slant = clamp(fit * (1 + Math.max(0, s.speedMps) / DRONE.backOff), DRONE.nearest, DRONE.farthest) * zoom;
  // The lower third's middle, or the frame's middle on a phone.
  const below = aspect < 1 ? 0 : Math.atan(0.5 * t) * DEG;
  // A far arrival: toward its runway, and only as steeply down as keeps the threshold in frame.
  const framing = goalFraming(s, goal, slant * Math.sin((DRONE.pitch + below) / DEG), FOV.drone, (p) => slant * Math.cos((p + below) / DEG));
  const base = framing ? Math.min(DRONE.pitch, framing.pitchDeg) : DRONE.pitch;
  const pitch = clamp(base + look.pitchDeg, base, LOOK_MAX_PITCH);
  const down = (pitch + below) / DEG;
  const h = ((framing?.bearingDeg ?? s.headingDeg) + look.bearingDeg) / DEG;
  const back = slant * Math.cos(down);
  const above = slant * Math.sin(down);
  const eye: Vec3 = [s.x - Math.sin(h) * back, s.y - Math.cos(h) * back, s.heightM + above];
  const reach = above / Math.tan(pitch / DEG);
  const view = lookFrom(eye, [eye[0] + Math.sin(h) * reach, eye[1] + Math.cos(h) * reach, s.heightM], FOV.drone);
  // Ends twice as far as the middle of the frame's top edge reaches over the ground, within the horizon's reach.
  const top = pitch - FOV.drone / 2;
  const clear = top > 0 ? clamp((2 * eye[2]) / Math.tan(top / DEG), 2500, HORIZON_REACH) : HORIZON_REACH;
  const haze = framing ? Math.min(GOAL.maxHaze, Math.max(clear, framing.distance * GOAL.haze)) : clear;
  return { view: { ...view, haze, trueSize: 1 }, look: { bearingDeg: wrap180(look.bearingDeg), pitchDeg: pitch - base, zoom } };
}

/** A runway end by its designator ("9R"): its threshold, and the unit vector down the runway from it. */
function runwayEnd(runways: readonly Runway[], rwy: string | null): { at: Point; dir: Point } | null {
  if (!rwy) return null;
  for (const r of runways) {
    if (r.ends.length < 2) continue;
    const i = r.ends.findIndex((e) => designator(e.ref) === rwy);
    if (i < 0) continue;
    const [end, other] = [r.ends[i], r.ends[1 - i]];
    const length = Math.hypot(other.x - end.x, other.y - end.y) || 1;
    return { at: [end.x, end.y], dir: [(other.x - end.x) / length, (other.y - end.y) / length] };
  }
  return null;
}

/** The approach camera looks as flat as the horizon allows, the arrival low in the frame and the runway ahead of it. */
const APPROACH = { pitch: 22, below: 11 } as const;

/**
 * Above and behind an arrival on runway `rwy` (its designator), on the runway's line, so the runway
 * ahead is in frame. Null for a runway the map does not know.
 */
export function approachView(runways: readonly Runway[], s: Subject, rwy: string | null, aspect: number): OrbitView | null {
  return approachShot(runways, s, rwy, aspect, NO_LOOK)?.view ?? null;
}

function approachShot(runways: readonly Runway[], s: Subject, rwy: string | null, aspect: number, look: ModeLook): Shot | null {
  const found = runwayEnd(runways, rwy);
  if (!found) return null;
  const bearing = (((Math.atan2(found.dir[0], found.dir[1]) * DEG) % 360) + 360) % 360;
  return behindAndAbove(s, bearing, APPROACH.pitch, APPROACH.below, FOV.approach, aspect, look, found.at);
}

/** The tower camera: its least tilt, its steepest (past which it backs away from the tower), and its clearances, metres. */
const TOWER = { pitch: 25, maxPitch: 48, overTower: 60, overRoofs: 150 } as const;

/**
 * From the tallest tower, raised to a high oblique, toward the selected aircraft, or the field's
 * centre (`field`) with none selected. Always well clear of the tower and every roof; it backs away
 * from the tower along the line of sight rather than look straight down. Null when the map has no tower.
 */
export function towerView(map: Pick<AirportMap, "towers" | "terminals" | "buildings">, subject: Subject | null, field: Point, aspect: number): OrbitView | null {
  return towerShot(map, subject, field, aspect, NO_LOOK, null)?.view ?? null;
}

/**
 * The tower's view looked around from the cab by `look`: the eye stays put while the look turns, tilts
 * and the lens narrows or widens. Never flat enough for the frame's top edge to reach past the horizon's
 * reach, nor for its middle to leave the mapped field (`area`), and never steeper than LOOK_MAX_PITCH.
 */
function towerShot(map: Pick<AirportMap, "towers" | "terminals" | "buildings">, subject: Subject | null, field: Point, aspect: number, look: ModeLook, area: MappedArea | null): Shot | null {
  const framed = towerFrame(map, subject, field, aspect);
  if (!framed) return null;
  const { eye, view } = framed;
  const fov = clamp(FOV.tower * look.zoom, TOWER_LENS.min, TOWER_LENS.max);
  const azimuth = view.azimuthDeg + look.bearingDeg;
  // The middle of the frame stays on the field, grown to take in what the mode looks at when that lies beyond it (an arrival on final).
  const mapped = area && { home: area.home, radius: Math.max(area.radius, Math.hypot(view.target[0] - area.home[0], view.target[1] - area.home[1])) };
  const run = mapped ? runWithin(mapped, [eye[0], eye[1]], azimuth) : Infinity;
  const onField = Math.atan2(eye[2] - view.height, run) * DEG;
  const floor = Math.max(minPitch(fov, aspect, eye[2], HORIZON_REACH), onField);
  const base = Math.max(view.elevationDeg, floor);
  const pitch = Math.max(floor, Math.min(base + look.pitchDeg, Math.max(LOOK_MAX_PITCH, view.elevationDeg)));
  const out: ModeLook = { bearingDeg: wrap180(look.bearingDeg), pitchDeg: pitch - base, zoom: fov / FOV.tower };
  if (out.bearingDeg === 0 && pitch === view.elevationDeg && fov === FOV.tower) return { view, look: out };
  // Where the turned line of sight meets the ground at the height looked at.
  const az = azimuth / DEG;
  const across = (eye[2] - view.height) / Math.tan(pitch / DEG);
  return { view: lookFrom(eye, [eye[0] + Math.sin(az) * across, eye[1] + Math.cos(az) * across, view.height], fov), look: out };
}

/** The tower's own framing: its eye, and its view from there. */
function towerFrame(map: Pick<AirportMap, "towers" | "terminals" | "buildings">, subject: Subject | null, field: Point, aspect: number): { eye: Vec3; view: OrbitView } | null {
  if (!map.towers.length) return null;
  const tower = map.towers.reduce((a, b) => (b.height > a.height ? b : a));
  const roofs = Math.max(0, ...[...map.terminals, ...map.buildings].map((b) => b.height)) * MODEL.heightScale;
  const lowest = Math.max(tower.height + TOWER.overTower, roofs + TOWER.overRoofs);
  const look: Vec3 = subject ? [subject.x, subject.y, subject.heightM] : [field[0], field[1], 0];
  const d = Math.hypot(look[0] - tower.x, look[1] - tower.y);
  // Raised until the look down is enough to keep the horizon out; a higher eye needs a little more.
  let pitch: number = TOWER.pitch;
  let height = lowest;
  for (let i = 0; i < 4; i++) {
    height = Math.max(lowest, look[2] + d * Math.tan(pitch / DEG));
    pitch = Math.max(TOWER.pitch, minPitch(FOV.tower, aspect, height, HORIZON_REACH));
  }
  // Too close to the tower to look at from it without looking straight down: back off along the line.
  const span = Math.max(d, (height - look[2]) / Math.tan(TOWER.maxPitch / DEG));
  const [ux, uy] = d > 1 ? [(tower.x - look[0]) / d, (tower.y - look[1]) / d] : [0, -1];
  const eye: Vec3 = [look[0] + ux * span, look[1] + uy * span, height];
  return { eye, view: lookFrom(eye, look, FOV.tower) };
}

/**
 * The modes on offer: the orbit always; the tower when the map has one; the drone for a selected
 * flight; the approach camera for an arrival on a runway the map knows.
 */
export function cameraModes(map: Pick<AirportMap, "towers" | "runways">, selected: { runway: string | null; state: FlightState } | null): CameraMode[] {
  return MODES.filter((mode) => {
    if (mode === "orbit") return true;
    if (mode === "tower") return map.towers.length > 0;
    if (!selected) return false;
    return mode !== "approach" || (selected.state === "arriving" && runwayEnd(map.runways, selected.runway) !== null);
  });
}

/** The selected flight as the cameras need it: where it is drawn, and the runway it is using. */
export interface Picked {
  scene: SceneAircraft;
  runway: string | null;
  state: FlightState;
}

/**
 * Where a mode puts the camera for the selected flight (`picked`) in a frame `aspect` wide, or null
 * when it has nothing to show (and always for the orbit, whose view is the reader's). The tower looks
 * at `field` with no flight.
 */
export function modeView(mode: CameraMode, map: Pick<AirportMap, "towers" | "runways" | "terminals" | "buildings">, picked: Picked | null, field: Point, aspect: number): OrbitView | null {
  return modeShot(mode, map, picked, field, aspect, NO_LOOK)?.view ?? null;
}

/**
 * A mode's view as `modeView` gives it, looked around by `look`, with the look as the mode clamped it.
 * The tower keeps the middle of its frame on `area`, the mapped field, when given one.
 */
export function modeShot(
  mode: CameraMode,
  map: Pick<AirportMap, "towers" | "runways" | "terminals" | "buildings">,
  picked: Picked | null,
  field: Point,
  aspect: number,
  look: ModeLook,
  area: MappedArea | null = null,
): Shot | null {
  const subject = picked ? subjectOf(picked.scene) : null;
  switch (mode) {
    case "tower":
      return towerShot(map, subject, field, aspect, look, area);
    case "drone":
      // An arrival making for a runway keeps it in frame while it is still far out.
      return subject && droneShot(subject, aspect, look, picked?.state === "arriving" ? (runwayEnd(map.runways, picked.runway)?.at ?? null) : null);
    case "approach":
      return picked && subject && picked.state === "arriving" ? approachShot(map.runways, subject, picked.runway, aspect, look) : null;
    default:
      return null;
  }
}

/** How long the camera takes to ease into a mode, out of one, or over to another aircraft, ms. */
export const CAMERA_EASE_MS = 1400;

/**
 * Which mode the camera is in, and the ease between them. The orbit's own view stays the reader's
 * (the page keeps it); the rig only says what to draw instead of it, and for how long.
 */
export class CameraRig {
  mode: CameraMode = "orbit";
  /** The reader's look around in the mode; back to the mode's own framing whenever the mode changes. */
  look: ModeLook = NO_LOOK;
  /** How long the ease under way takes, ms. */
  private duration = CAMERA_EASE_MS;
  /** Set when a switch has not been drawn yet: the next frame starts the ease from where the camera is. */
  private pending = false;
  private from: OrbitView | null = null;
  private start = 0;
  private key: string | null = null;

  /** Chooses a mode; the next frame eases over to it from wherever the camera is. */
  set(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.pending = true;
    this.duration = CAMERA_EASE_MS;
    this.look = NO_LOOK;
  }

  /**
   * Looks around in the mode by `step` (turns and tilts add, the zoom multiplies). A drag follows at
   * once; a key's or a button's step (`eased`) eases over, as the orbit's buttons do.
   */
  lookBy(step: ModeLook, eased = false): void {
    if (this.mode === "orbit") return;
    this.look = { bearingDeg: this.look.bearingDeg + step.bearingDeg, pitchDeg: this.look.pitchDeg + step.pitchDeg, zoom: this.look.zoom * step.zoom };
    if (eased) {
      this.pending = true;
      this.duration = LOOK_EASE_MS;
    }
  }

  /** Whether the rig has the camera: in a mode, or still easing back to the orbit. */
  get active(): boolean {
    return this.mode !== "orbit" || this.pending || this.from !== null;
  }

  /**
   * The view to draw at `now` (ms): `current` is where the camera is, `goal` where the mode puts it (the
   * orbit's own view once back in orbit), and `key` what it is looking at, a change of which eases over
   * too. Null once the orbit has the camera back.
   */
  frame(now: number, current: OrbitView, goal: OrbitView, key: string | null): OrbitView | null {
    if (this.mode !== "orbit" && key !== this.key) {
      this.pending = true;
      this.duration = CAMERA_EASE_MS;
    }
    if (this.pending) {
      this.pending = false;
      this.from = current;
      this.start = now;
    }
    this.key = key;
    if (this.from) {
      const t = Math.min(1, (now - this.start) / this.duration);
      if (t < 1) return ease(this.from, goal, t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);
      this.from = null;
    }
    return this.mode === "orbit" ? null : goal;
  }
}

/** Height of a view's eye above the field, metres. */
function eyeHeight(view: OrbitView): number {
  return view.height + view.distance * Math.sin(view.elevationDeg / DEG);
}

/** The orbit's near plane, kept from above; it comes in as the eye comes down, to a tenth of its height. */
const NEAR = { max: 50, min: 2, share: 0.1 } as const;

/** The camera's near plane for a view, metres: close enough low down that nothing near the camera is clipped. */
export function nearPlane(view: OrbitView): number {
  return clamp(eyeHeight(view) * NEAR.share, NEAR.min, NEAR.max);
}

/**
 * Where linear fog starts and ends for a view: from above, in multiples of the camera's distance
 * (`orbit`, the theme's fog, which the weather has already closed in); in a close camera mode, the
 * theme's haze in metres (`eye`), closed in by the weather's `haze` share; between, a blend.
 */
export function fogRange(view: OrbitView, orbit: { near: number; far: number }, eye: { near: number; far: number }, haze = 1): { near: number; far: number } {
  const k = view.eyeLevel ?? 0;
  // A mode's own haze (view.haze) replaces the theme's, starting at the same share of its end.
  const clear = view.haze === undefined ? eye : { near: view.haze * HAZE_NEAR, far: view.haze };
  // The weather brings it in, but no nearer than the orbit's thickest fog in the camera's own distance,
  // so what the mode looks at stays in sight (and the clear air is never pushed back).
  const thick = (end: "near" | "far") => Math.max(clear[end] * haze, Math.min(clear[end], view.distance * HAZE_FLOOR[end]));
  const air = haze < 1 ? { near: thick("near"), far: thick("far") } : clear;
  return {
    near: view.distance * orbit.near * (1 - k) + air.near * k,
    far: view.distance * orbit.far * (1 - k) + air.far * k,
  };
}

/** Where a mode's own haze starts, as a share of where it ends. */
const HAZE_NEAR = 0.3;
/** The nearest the weather brings a close view's haze, in the camera's distances: the orbit's thickest fog. */
const HAZE_FLOOR = { near: 0.28, far: 2 } as const;
