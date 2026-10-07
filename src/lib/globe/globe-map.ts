import { type GeoJSONSource, LngLat, Map as MapLibreMap, type RasterTileSource, setWorkerUrl } from "maplibre-gl";
import { AIRPORTS, type Airport } from "../airports";
import { type Read, recordFeedAnswer, recordFeedFailure, startFeed, summariseReads } from "../feed-health";
import { filtersActive, type Filters, Ghosts, GHOST_MS, matches, NO_FILTERS, type Subject } from "../filters";
import { type AirportCount, type Cell, cellOf, cellsCovering, countsNear, parseRegion, type RegionSnapshot, regionPath } from "../region";
import type { RadarFrame } from "../radar";
import type { FlightRoute } from "../routes";
import type { OrbitView } from "../scene/orbit";
import type { ThemeKey } from "../scene/theme";
import { type TrackedAircraft, Tracker } from "../tracker";
import { routeArcs } from "./arcs";
import { toGeo, toLocal, type Origin } from "../geo";
import type { JourneyFeatures } from "../journey-follow";
import { AIRCRAFT_GLYPH, GLYPH_BOX } from "./aircraft-glyph";
import { finiteCamera, groundView, type Lens, type MapCamera, mapToOrbit, orbitToMap, paddingFor, worldFloor } from "./camera";
import { shiftClearOfCard } from "./clear-of-card";
import { airportFeatures, type ProcedurePiece, procedureFeatures } from "./features";
import { frameShift, freeBand } from "./journey-frame";
import { type Band, globeCapable, Guide } from "./handover";
import { type MapFlight, markLost } from "./map-flight";
import { aircraftOpacity, arcOpacities, buildingHeight, FLOW_DASHES, mapStyle, PALETTES, radarLayer, radarSource, ripple, SELECTION_DIM } from "./map-style";
import { pickAircraft, REACH_PX } from "./pick";
import { isEstimated, selectedPath, selectionFeatures } from "./selected-path";
import { TrackHistory } from "./track-history";
import { countInView, MAP_ORIGIN, mergeRegions, type SkyFeatures, skyFeatures, militaryInView, skySubject, subjectsInView } from "./sky";

/**
 * The world map under the diorama: MapLibre on OpenFreeMap's tiles, with every built airport and its
 * live count, the live aircraft once the view is down to a region, and the routes flown from the
 * built airports at country scale. Everything on it moves: the aircraft glide between reads (the same
 * Tracker the diorama uses), each airport's ripple beats, and the routes flow. It shares the diorama's
 * camera (the same lens, and the same view converted between the map's terms and the airport's metres),
 * so the two can hand over without a cut.
 */

/** The view the page opens on when the map leads and the address names none: the continental US. */
const START = { center: [-96, 38.5] as [number, number], zoom: 3.4 };
/** The map shows aircraft from this zoom in: about a few hundred kilometres across. */
const REGION_ZOOM = 5.5;
/** At most this many region cells are read for one view; a view wider than that shows airports only. */
const MAX_CELLS = 9;
/** How often the aircraft and the airport counts are read again while the map is in view. */
const REGION_MS = 10_000;
const COUNTS_MS = 60_000;
/** Live, the picture runs this far behind the clock so a read is nearly always on each side of it; and an aircraft not heard is flown on this long. */
const LIVE_DELAY = 12;
const LIVE_RECKON = 30;
/** Seconds of flight each trail shows. */
const TRAIL_SECONDS = 75;
/** The live layers are redrawn this often, ms: smooth enough at map scale, and light on a phone. */
const FRAME_MS = 80;
/** The map steers a journey itself once no page has for this many of its frames. */
const PAGE_FRAMES = 2;
/** A position is added to each airborne aircraft's track this often, seconds: a minute of track is a handful of points, and thirty are well inside the bounds. */
const TRACK_STEP_S = 8;
/** How long the page waits for a flight a link names to appear in the traffic, ms. */
const WANTED_MS = 30_000;
/** The map eases the selected aircraft clear of the card no more often than this, ms. */
const EASE_EVERY_MS = 1_500;
/** One beat of an airport's ripple, and one step of the routes' flow, ms. */
const BEAT_MS = 2_400;
const FLOW_STEP_MS = 90;

// MapLibre looks for its worker beside its own module, which the bundler has moved; this copy is put in
// public/ on install (scripts/maplibre-worker.mjs).
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

type Counts = Partial<Record<Airport["code"], AirportCount>>;

/** The region cells the fixture recorded: round Atlanta and round Dallas-Fort Worth. */
const RECORDED_REGIONS: { cell: Cell; load: () => Promise<{ default: unknown }> }[] = [
  { cell: { latitude: 32, longitude: -84 }, load: () => import("../__fixtures__/adsblol_region_atl.json") },
  { cell: { latitude: 32, longitude: -96 }, load: () => import("../__fixtures__/adsblol_region_dfw.json") },
];
const RECORDED_ROUTES = [() => import("../__fixtures__/routes_atl.json"), () => import("../__fixtures__/routes_dfw.json")];

/** The renderer's own name, or null where the browser will not say: read once from a throwaway context. */
function rendererName(): string | null {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof name === "string" ? name : null;
  } catch {
    return null;
  }
}

/** A small airliner seen from above, nose up, drawn once as a signed distance field so the style can colour it. */
function aircraftIcon(): ImageData {
  const size = GLYPH_BOX;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.translate(size / 2, size / 2);
  ctx.fillStyle = "#000";
  // Fuselage, wings, tailplane: the shape the diorama's beacon draws too.
  ctx.fill(new Path2D(AIRCRAFT_GLYPH));
  return ctx.getImageData(0, 0, size, size);
}

/** The airport chip, as the page's own chips are: a rounded panel with a hairline ring, stretched to fit its text. */
function chipImage(key: ThemeKey): { data: ImageData; radius: number; size: number } {
  const p = PALETTES[key];
  const size = 48;
  const radius = 16;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.roundRect(1.5, 1.5, size - 3, size - 3, radius - 2);
  ctx.fillStyle = p.chip;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = p.chipRing;
  ctx.stroke();
  return { data: ctx.getImageData(0, 0, size, size), radius, size };
}

export interface GlobeOptions {
  theme: ThemeKey;
  /** The airport whose diorama the map hands over to: the origin of the scene's metres. */
  airport: Airport;
  /** Read the recorded regions and routes instead of the live feed. */
  fixture: boolean;
}

/** The approach's end is kept in view with the aircraft only within this, metres: farther out the journey's own shot stands. */
const FRAME_RANGE_M = 90_000;
/** One step of zooming out to fit them is never more than this share of the way (a factor in scale). */
const FRAME_STEP = 0.25;
/** On the map, a selected flight's approach or climb-out is whole within this many metres of its airport, and gone by `far`: region zoom shows tens of kilometres. */
const MAP_PATH_FADE = { near: 8000, far: 30_000 } as const;

export class GlobeMap {
  readonly map: MapLibreMap;
  /** The map's element, kept apart from the map: MapLibre asks for camera updates while it is still being made. */
  private readonly container: HTMLElement;
  private airport: Airport;
  private readonly fixture: boolean;
  private theme: ThemeKey;
  /** Whether the world view may be a globe here (a GPU that draws it whole). */
  readonly globe: boolean;
  /** The frame both cameras draw into; kept current by the page. */
  private lens: Lens = { height: 1, fovDeg: 22 };
  /** While set, a zoom in over the airport is drawn toward its framed view (see handover.ts). */
  private guideTo: { home: OrbitView; band: Band } | null = null;
  private readonly guidance = new Guide();
  /** Set while the diorama moves the map, so its moves are not guided back. */
  private following = false;
  private active = true;
  private reveal = -1;
  private rise = -1;
  private counts: Counts = {};
  private readonly routes = new Map<string, FlightRoute>();
  /** The live sky: every aircraft read, moving between reads, in the map's own metres. */
  private sky: Tracker;
  /** The live clock in the feed's UTC seconds; for the fixture, the recorded moment running on from when the page opened. */
  private clock: () => number = () => Date.now() / 1000;
  private offset: number | null = null;
  private recorded: RegionSnapshot[] | null = null;
  private readonly timers: number[] = [];
  private regionRequest = 0;
  private frame = 0;
  private lastFrame = 0;
  private flowStep = -1;
  private skyDrawn = false;
  /** Whether the map's LIVE dot is held current: zoomed out past the aircraft, nothing it shows is a live read. */
  private feedHeld = true;
  private inView: { shown: number; total: number } | null = null;
  /** What the filters read of the aircraft drawn in view, for the lists they offer. */
  private viewSubjects: Subject[] = [];
  /** The military aircraft drawn in view, for the alerts, and which view they are of: it counts up each time the map comes to rest somewhere new. */
  private viewMilitary: { id: string; callsign: string | null; typeCode: string | null }[] = [];
  private viewNumber = 0;
  /** What the reader has narrowed the traffic to, and how far each aircraft is faded out for it. */
  private filters: Filters = NO_FILTERS;
  private readonly ghosts = new Ghosts();
  private lastSkyAt = 0;
  /** The followed flight (gate to gate): its hex, left out of the traffic so it is not drawn twice, and what the map draws for it. */
  private journeyHex: string | null = null;
  /** The followed flight is drawing its own published procedure (setJourney), so the diorama's path for it is not drawn under it. */
  private journeyProcedure = false;
  private journeyData: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  /** The weather radar frame the map draws, or null with the layer off. */
  private radar: RadarFrame | null = null;
  /** What the page has seen of each aircraft's track while the map was up, and when a position was last added to it. */
  private readonly history = new TrackHistory();
  private lastTrack = -Infinity;
  /** The selected aircraft (a click on the map), what the card prints of it, and who is told when that changes. */
  private selectedId: string | null = null;
  private selectionJson = "";
  private onSelection: ((flight: MapFlight | null) => void) | null = null;
  private selectionData: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };
  /** What the card last printed: kept when the aircraft leaves the feed, which it then marks lost. */
  private lastFlight: MapFlight | null = null;
  /** A flight a link names (its callsign), selected once the traffic shows it, until this time (ms). */
  private wanted: { callsign: string; until: number } | null = null;
  /** The aircraft under the pointer, who is not selected: a ring is drawn round it. */
  private hoverId: string | null = null;
  /** Whether the reader has moved the map since the selection: the map then leaves the camera alone. */
  private userMoved = false;
  private lastEase = 0;
  /** The flight card's box on screen, for keeping the selected aircraft clear of it. */
  private cardRect: (() => DOMRect | null) | null = null;
  /** On a phone, the journey's card and the controls round the foot of the map (null elsewhere): the band between them is where the flight is kept. */
  private frameBand: (() => { card: DOMRect | null; controls: DOMRect[] } | null) | null = null;
  /** The followed aircraft as drawn and the end of its approach, [longitude, latitude], to keep in that band; empty with no approach. */
  private framing: [number, number][] = [];
  /** The aircraft drawn last frame, which a click is matched against. */
  private drawn: SkyFeatures["aircraft"]["features"] = [];
  /** The selected flight's approach or climb-out (procedureFeatures), kept across theme changes. */
  private procedureData: { type: "FeatureCollection"; features: ProcedurePiece[] } = { type: "FeatureCollection", features: [] };
  private procedureOf: { path: Parameters<typeof procedureFeatures>[0]; origin: Origin; owner: string | null } | null = null;
  /** Steers the camera each frame while set (a journey on the map), and the frame it last ran for. */
  private driver: ((now: number) => void) | null = null;
  private driven = -1;
  /** The map's own frames, and the last one a page steered in (drive's `byPage`). */
  private frames = 0;
  private pageDrove = -Infinity;
  /** Told when the reader moves the map by hand. */
  private onUserMove: (() => void) | null = null;

  constructor(container: HTMLElement, options: GlobeOptions) {
    this.container = container;
    this.airport = options.airport;
    this.fixture = options.fixture;
    this.theme = options.theme;
    this.globe = globeCapable(rendererName());
    this.sky = options.fixture ? new Tracker({ playbackDelay: 0, deadReckonMax: Infinity }) : new Tracker({ playbackDelay: LIVE_DELAY, deadReckonMax: LIVE_RECKON });
    this.map = new MapLibreMap({
      container,
      style: mapStyle(options.theme, { globe: this.globe }),
      center: START.center,
      zoom: START.zoom,
      // The diorama tilts from 12 to 88 degrees above the ground: 78 to 2 degrees of pitch.
      maxPitch: 78,
      // The address carries the map's camera, so a reload or a shared link opens on the same view.
      hash: "map",
      attributionControl: { compact: true },
      transformCameraUpdate: (next) => this.guideUpdate(next),
    });
    // MapLibre 6 asks a resolver for an image the style names before drawing without it (and warns).
    this.map.setMissingStyleImageResolver((id) => {
      if (this.map.hasImage(id)) return;
      if (id === "aircraft") this.map.addImage("aircraft", aircraftIcon(), { sdf: true, pixelRatio: 2 });
      const chip = /^chip-(light|dark|satellite)$/.exec(id);
      if (chip) {
        const { data, radius, size } = chipImage(chip[1] as ThemeKey);
        this.map.addImage(id, data, { pixelRatio: 2, stretchX: [[radius, size - radius]], stretchY: [[radius, size - radius]], content: [radius / 2, radius / 2, size - radius / 2, size - radius / 2] });
      }
    });
    // A journey moves the map every frame: its traffic is read on the timer then, not on every move.
    this.map.on("moveend", () => {
      this.viewNumber++;
      if (!this.driver) void this.loadRegion();
    });
    this.map.on("click", (e) => this.pick(e.point, e.originalEvent));
    this.map.on("mousemove", (e) => this.hover(e.point));
    this.map.on("mouseout", () => this.hover(null));
    document.addEventListener("keydown", this.onKey);
    // A drag, wheel or pinch carries an original event; the page's own moves do not.
    this.map.on("movestart", (e) => {
      if ((e as { originalEvent?: unknown }).originalEvent) {
        this.userMoved = true;
        this.onUserMove?.();
      }
    });
    this.map.on("load", () => {
      this.applyRadar();
      this.draw();
      void this.loadCounts();
      void this.loadRegion();
      void this.loadRecordedRoutes();
    });
    this.timers.push(
      window.setInterval(() => void this.loadRegion(), REGION_MS),
      window.setInterval(() => void this.loadCounts(), COUNTS_MS),
    );
    // A hidden tab's timers are throttled: back in view, read at once, so the map's dot recovers in one read.
    document.addEventListener("visibilitychange", this.onShown);
    this.frame = requestAnimationFrame(this.tick);
  }

  /** The map's camera now. */
  get camera(): MapCamera {
    const c = this.map.getCenter();
    return { lng: c.lng, lat: c.lat, zoom: this.map.getZoom(), bearing: this.map.getBearing(), pitch: this.map.getPitch() };
  }

  /** The map's camera as the diorama's orbit, in the airport's metres. */
  get view(): OrbitView {
    return mapToOrbit(this.camera, this.airport, this.lens);
  }

  /** The ground in view, as its edges in degrees (east runs past 180 across the antimeridian). */
  viewBounds(): { west: number; south: number; east: number; north: number } {
    const b = this.map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  /** How many aircraft the map draws in view; null while it is zoomed out past them or has read none. */
  get aircraftInView(): { shown: number; total: number } | null {
    return this.inView;
  }

  /** What the filters read of the aircraft drawn in view, whatever they leave showing. */
  get subjectsInView(): Subject[] {
    return this.viewSubjects;
  }

  /** The military aircraft drawn in view, and the number of the view they are in. */
  get militaryInView(): { view: number; list: readonly { id: string; callsign: string | null; typeCode: string | null }[] } {
    return { view: this.viewNumber, list: this.viewMilitary };
  }

  private routeOf(callsign: string | null): FlightRoute | null {
    return (callsign && this.routes.get(callsign)) || null;
  }

  /** Told when the selected flight, or what its card prints, changes; null once nothing is selected. */
  setSelectionListener(listener: ((flight: MapFlight | null) => void) | null): void {
    this.onSelection = listener;
  }

  /** Selects the aircraft with this hex, or clears the selection with null: its path is drawn, and the rest of the traffic stands back. */
  select(id: string | null): void {
    if (id === this.selectedId) return;
    this.selectedId = id;
    this.wanted = null;
    this.userMoved = false;
    this.lastEase = 0;
    this.history.pin(id);
    if (id) this.setHover(null);
    else {
      this.selectionData = { type: "FeatureCollection", features: [] };
      this.map.getSource<GeoJSONSource>("selected")?.setData(this.selectionData);
      this.setSelection(null);
    }
    this.drawProcedure();
    this.applyDim();
  }

  /** Selects the flight with this callsign (or hex, upper case, where it has none) as soon as the traffic shows it: a link's flight. */
  selectCallsign(callsign: string): void {
    this.wanted = { callsign: callsign.toUpperCase(), until: Date.now() + WANTED_MS };
  }

  /** Where the flight card is on screen, so the selected aircraft is kept clear of it; null stops that. */
  setFrameBand(band: (() => { card: DOMRect | null; controls: DOMRect[] } | null) | null): void {
    this.frameBand = band;
  }

  setCardRect(rect: (() => DOMRect | null) | null): void {
    this.cardRect = rect;
  }

  /** The selected aircraft's place, or null while it is not drawn. */
  get selectedAt(): { latitude: number; longitude: number } | null {
    const f = this.drawn.find((x) => x.properties.id === this.selectedId);
    return f ? { latitude: f.geometry.coordinates[1], longitude: f.geometry.coordinates[0] } : null;
  }

  /** Escape clears the selection while the map is what shows. */
  private readonly onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.selectedId && this.active && !e.defaultPrevented) this.select(null);
  };

  /** The aircraft drawn in view that a click can take, on screen. */
  private screenPoints() {
    return this.drawn.filter((f) => !f.properties.muted).map((f) => {
      const p = this.map.project(f.geometry.coordinates);
      return { id: f.properties.id, x: p.x, y: p.y };
    });
  }

  /** The pointer is over `at` (CSS pixels), or has left the map (null): the aircraft it would take is ringed. */
  private hover(at: { x: number; y: number } | null): void {
    const over = at && this.active && this.map.getZoom() >= REGION_ZOOM ? pickAircraft(this.screenPoints(), at, REACH_PX.pointer) : null;
    this.setHover(over !== this.selectedId ? over : null);
  }

  private setHover(id: string | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.map.getCanvas().style.cursor = id ? "pointer" : "";
    this.drawHover();
  }

  private drawHover(): void {
    const f = this.hoverId ? this.drawn.find((x) => x.properties.id === this.hoverId) : null;
    // It follows the aircraft as it moves, and goes when the aircraft does.
    if (this.hoverId && !f) this.setHover(null);
    this.map.getSource<GeoJSONSource>("hover")?.setData({ type: "FeatureCollection", features: f ? [{ type: "Feature", geometry: f.geometry, properties: {} }] : [] });
  }

  /** A click or tap on the map: the aircraft nearest it within reach is selected, and empty map clears the selection. */
  private pick(at: { x: number; y: number }, event: Event | undefined): void {
    if (!this.active || this.map.getZoom() < REGION_ZOOM) return;
    const touch = (event as { pointerType?: string } | undefined)?.pointerType === "touch" || window.matchMedia("(pointer: coarse)").matches;
    this.select(pickAircraft(this.screenPoints(), at, touch ? REACH_PX.touch : REACH_PX.pointer));
  }

  /** Narrows the aircraft drawn to those that pass; the rest fade to a hint. */
  setFilters(filters: Filters): void {
    this.filters = filters;
  }

  /** The airport the map hands over to. */
  get airportCode(): Airport["code"] {
    return this.airport.code;
  }

  /** Hands over to another airport's diorama from now on: its metres become the camera's. */
  setAirport(airport: Airport): void {
    if (airport.code === this.airport.code) return;
    this.airport = airport;
    this.guidance.release();
  }

  /** The frame's height and the diorama's lens: the map takes the same field of view, so a metre is the same size in both. */
  setLens(lens: Lens): void {
    // A frame with no height (a hidden tab) has no lens to share: every conversion through it would be NaN.
    if (!(lens.height > 0)) return;
    this.lens = lens;
    if (Math.abs(this.map.getVerticalFieldOfView() - lens.fovDeg) > 1e-6) this.map.setVerticalFieldOfView(lens.fovDeg);
  }

  /** Where on screen (CSS pixels) the diorama draws the point it looks at: the map puts its centre there too. */
  setAnchor(anchor: { x: number; y: number }): void {
    const want = paddingFor(anchor, this.map.getContainer().clientWidth, this.map.getContainer().clientHeight);
    const have = this.map.getPadding();
    if (Math.abs(want.left - (have.left ?? 0)) + Math.abs(want.right - (have.right ?? 0)) + Math.abs(want.top - (have.top ?? 0)) + Math.abs(want.bottom - (have.bottom ?? 0)) < 0.5) return;
    this.following = true;
    this.map.setPadding(want);
    this.following = false;
  }

  /** Draws zooms into the band over the airport toward `home`; null stops it. */
  setGuide(guideTo: { home: OrbitView; band: Band } | null): void {
    this.guideTo = guideTo;
  }

  /**
   * The diorama hands the camera back: the map carries on from its view (brought down to the ground along
   * its line of sight, the only thing the map can look at), unguided until it leaves the band.
   */
  handBack(view: OrbitView): void {
    this.guidance.release();
    this.follow(groundView(view));
  }

  /** Moves the map to `view`, given in `origin`'s metres and aimed at a point at its height: the camera that follows a flight. */
  followView(view: OrbitView, origin: Origin): void {
    const [lat, lon] = toGeo(origin, view.target[0], view.target[1]);
    this.follow(groundView({ ...view, target: toLocal(this.airport, lat, lon) }));
  }

  /** Steers the camera every frame while set, before the map is drawn; null hands it back to the reader. */
  setDriver(driver: ((now: number) => void) | null): void {
    this.driver = driver;
  }

  /**
   * Runs the driver for this frame, once however many callers ask. A page drawing an airport over the
   * map steers it itself (`byPage`), after it has seen where its diorama draws the flight this frame;
   * the map's own loop steers only while no page has for a few frames.
   */
  drive(now: number, byPage = false): void {
    if (byPage) this.pageDrove = this.frames;
    if (!this.driver || now === this.driven) return;
    this.driven = now;
    this.driver(now);
  }

  /** Called when the reader moves the map by hand (a journey lets go of the camera then). */
  setUserMove(listener: (() => void) | null): void {
    this.onUserMove = listener;
  }

  /** The followed flight, drawn over the traffic and left out of it; null clears it. */
  setJourney(hex: string | null, features: JourneyFeatures | null): void {
    this.journeyHex = hex;
    // The followed flight is drawn apart from the traffic and has its own card: a selection of it is over.
    if (hex && hex === this.selectedId) this.select(null);
    const out: GeoJSON.Feature[] = [];
    if (features) {
      if (features.left.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: features.left }, properties: { part: "left" } });
      if (features.flown.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: features.flown }, properties: { part: "flown" } });
      if (features.climbOut.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: features.climbOut }, properties: { part: "climb-out" } });
      if (features.approach.length > 1) out.push({ type: "Feature", geometry: { type: "LineString", coordinates: features.approach }, properties: { part: "approach" } });
      if (features.aircraft) out.push({ type: "Feature", geometry: { type: "Point", coordinates: features.aircraft }, properties: { part: "aircraft", track: features.headingDeg } });
    }
    this.journeyData = { type: "FeatureCollection", features: out };
    this.map.getSource<GeoJSONSource>("journey")?.setData(this.journeyData);
    const own = !!features && (features.climbOut.length > 1 || features.approach.length > 1);
    if (own !== this.journeyProcedure) {
      this.journeyProcedure = own;
      this.drawProcedure();
    }
    const end = features?.approach.at(-1);
    this.framing = features?.aircraft && end ? [features.aircraft, end] : [];
    this.keepInBand();
  }

  /**
   * On a phone, with an approach drawn and the aircraft near enough to see it with, zooms out and moves the
   * map so the aircraft and the approach's threshold end both stand in the band between the card and the
   * controls. After the journey's own camera for the frame, which is set afresh every frame, so it never
   * pulls against the reader: a drag or a wheel ends the journey's steering and with it this.
   */
  private keepInBand(): void {
    const rects = this.framing.length === 2 ? this.frameBand?.() : null;
    if (!rects || Math.hypot(...toLocal({ latitude: this.framing[0][1], longitude: this.framing[0][0] }, this.framing[1][1], this.framing[1][0])) > FRAME_RANGE_M) return;
    const box = this.container.getBoundingClientRect();
    const within = (r: DOMRect) => ({ left: r.left - box.left, right: r.right - box.left, top: r.top - box.top, bottom: r.bottom - box.top });
    const band = freeBand({ width: box.width, height: box.height }, rects.card && within(rects.card), rects.controls.filter((r) => r.width > 0 && r.height > 0).map(within));
    this.following = true;
    for (let i = 0; i < 3; i++) {
      const first = frameShift(this.framing.map((c) => this.map.project(c)), band);
      if (first.scale < 0.99) this.map.jumpTo({ zoom: this.map.getZoom() + Math.log2(Math.max(first.scale, FRAME_STEP)) });
      const { dx, dy } = frameShift(this.framing.map((c) => this.map.project(c)), band);
      if (Math.hypot(dx, dy) >= 1) this.map.panBy([-dx, -dy], { duration: 0 });
      else if (first.scale >= 0.99) break;
    }
    this.following = false;
  }

  /**
   * The selected flight's approach or climb-out: its predicted path's air legs, in the scene's frame
   * round `origin` (its airport), drawn as the diorama draws them and fading out by MAP_PATH_FADE.
   * Null clears it.
   */
  setProcedure(path: Parameters<typeof procedureFeatures>[0], origin: Origin, owner: string | null = null): void {
    this.procedureOf = { path, origin, owner };
    this.drawProcedure();
  }

  /** The procedure, drawn as the selected flight's path when it belongs to the flight selected on the map, and as a line of its own state's colour otherwise. */
  private drawProcedure(): void {
    // The followed flight draws its own published procedure, as the diorama's selected flight would, but where its camera sees it.
    const p = this.procedureOf && this.journeyProcedure && this.procedureOf.owner === this.journeyHex ? null : this.procedureOf;
    this.procedureData = p ? procedureFeatures(p.path, p.origin, MAP_PATH_FADE, p.owner !== null && p.owner === this.selectedId) : { type: "FeatureCollection", features: [] };
    this.map.getSource<GeoJSONSource>("procedure")?.setData(this.procedureData);
  }

  /** Moves the map to the diorama's view, while the diorama leads. */
  follow(view: OrbitView): void {
    const cam = orbitToMap(view, this.airport, this.lens);
    this.following = true;
    this.map.jumpTo({ center: [cam.lng, cam.lat], zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch });
    this.following = false;
  }

  /** The view buttons, while the map leads: in (factor below 1) or out about the centre, and turning. */
  zoomBy(factor: number): void {
    this.map.easeTo({ zoom: this.map.getZoom() - Math.log2(factor), duration: 300 });
  }

  /** A pinch carried on from the diorama: in (factor below 1) or out about the centre, at once. */
  zoomNow(factor: number): void {
    this.map.jumpTo({ zoom: this.map.getZoom() - Math.log2(factor) });
  }

  turn(deg: number): void {
    this.map.easeTo({ bearing: this.map.getBearing() + deg, duration: 300 });
  }

  /** Flies the map to the diorama's view `view`, as Reset view does from the map. */
  flyTo(view: OrbitView): void {
    const cam = orbitToMap(view, this.airport, this.lens);
    this.map.flyTo({ center: [cam.lng, cam.lat], zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch, duration: 2500 });
  }

  /**
   * Sets off toward another airport, at a height that shows the country on the way, while its diorama
   * loads; the page then brings the map down onto the diorama's framed view (flyTo) once it can.
   */
  flyToward(airport: Airport): void {
    this.map.flyTo({ center: [airport.longitude, airport.latitude], zoom: 9, bearing: 0, pitch: 45, duration: 2500 });
  }

  /** Routes the page has learned for the flights at a built airport: drawn as the network at country scale. */
  addRoutes(routes: Record<string, FlightRoute> | undefined): void {
    let added = false;
    for (const [callsign, route] of Object.entries(routes ?? {})) {
      if (this.routes.has(callsign)) continue;
      this.routes.set(callsign, route);
      added = true;
    }
    if (added) this.draw();
  }

  /**
   * How much of the diorama is drawn over the map (0 to 1), and how far its buildings have risen. The
   * map's own markers for the airport and its traffic give way as it comes in, so nothing is drawn
   * twice, and the city's buildings rise with the diorama's. At 1 the map is hidden under the diorama
   * and stops reading traffic.
   */
  setReveal(reveal: number, rise = reveal): void {
    const wasActive = this.active;
    this.active = reveal < 1;
    if (this.active && !wasActive) {
      void this.loadRegion();
      void this.loadCounts();
    }
    if (!this.map.getLayer("aircraft")) return;
    if (Math.abs(rise - this.rise) >= 0.01 || (rise !== this.rise && (rise === 0 || rise === 1))) {
      this.rise = rise;
      this.map.setPaintProperty("buildings-3d", "fill-extrusion-height", buildingHeight(rise));
      this.map.setPaintProperty("buildings-3d", "fill-extrusion-opacity", rise > 0 ? 0.92 : 0);
    }
    if (Math.abs(reveal - this.reveal) < 0.01 && reveal !== 0 && reveal !== 1) return;
    this.reveal = reveal;
    const k = 1 - reveal;
    this.map.setPaintProperty("aircraft", "icon-opacity", aircraftOpacity(k));
    this.map.setPaintProperty("airport-labels", "text-opacity", k);
    this.map.setPaintProperty("airport-labels", "icon-opacity", k);
    this.map.setPaintProperty("airports", "circle-opacity", k);
    this.map.setPaintProperty("airports", "circle-stroke-opacity", k);
    this.applyDim();
    // The followed flight gives way to the diorama's own aircraft as it comes in, as the traffic does.
    this.map.setPaintProperty("journey-aircraft", "icon-opacity", k);
    this.map.setPaintProperty("journey-beacon", "circle-opacity", 0.12 * k);
    this.map.setPaintProperty("journey-beacon", "circle-stroke-opacity", 0.55 * k);
    this.map.setPaintProperty("journey-flown", "line-opacity", 0.9 * k);
    this.map.setPaintProperty("journey-left", "line-opacity", 0.55 * k);
    this.map.setPaintProperty("journey-procedure", "line-opacity", 0.95 * k);
    this.map.setPaintProperty("journey-procedure-casing", "line-opacity", 0.7 * k);
  }

  /** Draws the weather radar from this frame (a newer one replaces it in place), or removes the layer when null. */
  setRadar(frame: RadarFrame | null): void {
    if (frame?.tiles === this.radar?.tiles) return;
    this.radar = frame;
    this.applyRadar();
  }

  /** Brings the map's radar layer to what `radar` says; waits for the style when it has not loaded yet (the load then applies it). */
  private applyRadar(): void {
    const { map } = this;
    if (!map.getLayer("aircraft")) return;
    if (!this.radar) {
      if (map.getLayer("radar")) map.removeLayer("radar");
      if (map.getSource("radar")) map.removeSource("radar");
      return;
    }
    const source = map.getSource<RasterTileSource>("radar");
    if (source) source.setTiles([this.radar.tiles]);
    else {
      map.addSource("radar", radarSource(this.radar.tiles));
      map.addLayer(radarLayer(this.theme), "city-lights");
    }
  }

  setTheme(theme: ThemeKey): void {
    if (theme === this.theme) return;
    this.theme = theme;
    // The new style carries the data already drawn, so the diff leaves the markers where they are.
    const style = mapStyle(theme, { globe: this.globe, radar: this.radar?.tiles });
    style.sources.airports = { type: "geojson", data: airportFeatures(AIRPORTS, this.counts) };
    style.sources.arcs = { type: "geojson", data: routeArcs(this.routes.values()), lineMetrics: true };
    style.sources.journey = { type: "geojson", data: this.journeyData };
    style.sources.procedure = { type: "geojson", data: this.procedureData };
    style.sources.selected = { type: "geojson", data: this.selectionData };
    style.sources.hover = { type: "geojson", data: { type: "FeatureCollection", features: [] } };
    this.map.setStyle(style);
    this.map.once("styledata", () => {
      this.reveal = -1;
      this.rise = -1;
      this.flowStep = -1;
      this.applyDim();
    });
  }

  /** The route arcs and the trails stand back from the selected flight (SELECTION_DIM); the trails are also as faded out as the diorama has the map. */
  private applyDim(): void {
    if (!this.map.getLayer("trails-cruise")) return;
    const arc = arcOpacities(this.theme, this.selectedId ? SELECTION_DIM.arcs : 1);
    this.map.setPaintProperty("arcs-glow", "line-opacity", arc.glow);
    this.map.setPaintProperty("arcs", "line-opacity", arc.line);
    this.map.setPaintProperty("arcs-flow", "line-opacity", arc.flow);
    // Until the page says how much of the map shows (reveal is -1), all of it does.
    const shown = this.reveal < 0 ? 1 : 1 - this.reveal;
    for (const kind of ["cruise", "arriving", "departing"]) this.map.setPaintProperty(`trails-${kind}`, "line-opacity", shown * (this.selectedId ? SELECTION_DIM.trails : 1));
  }

  private readonly onShown = () => {
    if (document.visibilityState !== "visible") return;
    void this.loadRegion();
    void this.loadCounts();
  };

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onShown);
    document.removeEventListener("keydown", this.onKey);
    cancelAnimationFrame(this.frame);
    for (const t of this.timers) window.clearInterval(t);
    this.map.remove();
  }

  /** The live layers: the sky moved on, each airport's ripple, the routes' flow. A few times a second, not every frame. */
  private readonly tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    this.frames++;
    if (this.frames - this.pageDrove > PAGE_FRAMES) this.drive(now);
    if (!this.active || now - this.lastFrame < FRAME_MS || !this.map.getLayer("aircraft")) return;
    this.lastFrame = now;
    const beat = (now % BEAT_MS) / BEAT_MS;
    // As much of the map as the diorama leaves in view (reveal is -1 until the page first says).
    const pulse = ripple(beat, 1 - this.reveal);
    this.map.setPaintProperty("airport-pulse", "circle-radius", pulse.radius);
    this.map.setPaintProperty("airport-pulse", "circle-stroke-opacity", pulse.opacity);
    const step = Math.floor(now / FLOW_STEP_MS) % FLOW_DASHES.length;
    if (step !== this.flowStep) {
      this.flowStep = step;
      this.map.setPaintProperty("arcs-flow", "line-dasharray", FLOW_DASHES[step]);
    }
    const showSky = this.map.getZoom() >= REGION_ZOOM;
    if (!showSky) {
      this.inView = null;
      this.viewSubjects = [];
    }
    if (showSky || this.skyDrawn) {
      const tracked = showSky ? this.sky.at(this.clock()).filter((a) => a.id !== this.journeyHex) : [];
      const step = Math.min(1, (now - this.lastSkyAt) / GHOST_MS);
      this.lastSkyAt = now;
      const filtering = filtersActive(this.filters);
      const { aircraft, trails } = skyFeatures(tracked, MAP_ORIGIN, AIRPORTS, TRAIL_SECONDS, (a, kind) => this.ghosts.track(a.id, filtering && !matches(this.filters, skySubject(a, kind, this.routeOf(a.callsign))), step));
      this.ghosts.sweep();
      if (showSky) this.followSelection(tracked, aircraft);
      this.drawn = aircraft.features;
      this.drawHover();
      this.map.getSource<GeoJSONSource>("aircraft")?.setData(aircraft);
      this.map.getSource<GeoJSONSource>("trails")?.setData(trails);
      this.skyDrawn = showSky;
      if (showSky) {
        const b = this.map.getBounds();
        const bounds = { west: b.getWest(), east: b.getEast(), south: b.getSouth(), north: b.getNorth() };
        // The followed flight is drawn apart from the traffic, and counts as in view as well.
        const followed = this.journeyData.features.filter((f) => f.properties?.part === "aircraft") as SkyFeatures["aircraft"]["features"];
        const counted = countInView({ type: "FeatureCollection", features: [...aircraft.features, ...followed] }, bounds);
        this.inView = this.sky.size || followed.length ? counted : null;
        this.viewSubjects = subjectsInView(tracked, aircraft, bounds, (c) => this.routeOf(c));
        this.viewMilitary = militaryInView(tracked, aircraft, bounds);
      }
    }
  };

  /**
   * Every camera update passes through here: kept inside the world's floor (never scrolled out until the
   * globe is a speck, nor centred on a pole), then guided toward the airport's framed view in the band.
   */
  private guideUpdate(update: { center: LngLat; zoom: number; pitch: number; bearing: number }) {
    const container = this.container;
    // The lens is the map's own once it exists (it is asked for updates while it is being made).
    const asked = { lng: update.center.lng, lat: update.center.lat, zoom: update.zoom, bearing: update.bearing, pitch: update.pitch };
    // A camera with a NaN or infinite part never reaches the map, nor the address the map writes it to.
    if (!finiteCamera(asked)) {
      if (!this.map) return { center: new LngLat(START.center[0], START.center[1]), zoom: START.zoom, pitch: 0, bearing: 0 };
      return { center: this.map.getCenter(), zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() };
    }
    const floored = worldFloor(asked, { width: container.clientWidth, height: container.clientHeight, fovDeg: this.map?.getVerticalFieldOfView() ?? this.lens.fovDeg }, this.globe);
    const next = floored === asked ? update : { ...update, center: new LngLat(floored.lng, floored.lat), zoom: floored.zoom };
    if (!this.guideTo || this.following) return next;
    const want = mapToOrbit({ lng: next.center.lng, lat: next.center.lat, zoom: next.zoom, bearing: next.bearing, pitch: next.pitch }, this.airport, this.lens);
    const guided = this.guidance.step(this.view, want, this.guideTo.home, this.guideTo.band);
    if (guided === want) return next;
    const cam = orbitToMap(guided, this.airport, this.lens);
    return { center: new LngLat(cam.lng, cam.lat), zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch };
  }

  /**
   * Each frame the map is up: adds to the aircraft's tracks every TRACK_STEP_S, and draws the selected
   * flight (its path, and the card's figures) while the other traffic is dimmed. The aircraft drawn are in
   * the tracked ones' order.
   */
  private followSelection(tracked: readonly TrackedAircraft[], aircraft: SkyFeatures["aircraft"]): void {
    // The page's own clock, which only runs forward: the feed's changes hands when the first read comes in.
    const now = Date.now() / 1000;
    if (now - this.lastTrack >= TRACK_STEP_S) {
      this.lastTrack = now;
      tracked.forEach((a, i) => {
        if (!a.onGround) this.history.record(a.id, now, ...aircraft.features[i].geometry.coordinates);
      });
      this.history.sweep(now);
    }
    if (this.wanted && !this.selectedId) {
      const wanted = this.wanted.callsign;
      const i = tracked.findIndex((a) => (a.callsign ?? a.id.toUpperCase()) === wanted);
      if (i >= 0) this.select(tracked[i].id);
      else if (Date.now() > this.wanted.until) this.wanted = null;
    }
    if (!this.selectedId) return;
    let found = -1;
    aircraft.features.forEach((f, i) => {
      if (f.properties.id === this.selectedId) found = i;
      else f.properties.fade *= SELECTION_DIM.aircraft;
    });
    if (found < 0) {
      // Gone from the feed: the card keeps its last figures and says so, and the ring and path stay where they were, faded.
      const last = this.lastFlight;
      if (last) {
        // On the feed's clock, the one the time bar reads, so "last seen" and the bar agree (the fixture's included).
        const lost = markLost(last, this.clock() * 1000);
        if (lost !== last) {
          this.selectionData = { ...this.selectionData, features: this.selectionData.features.map((f) => (f.properties?.part === "aircraft" ? { ...f, properties: { ...f.properties, lost: true } } : f)) };
          this.map.getSource<GeoJSONSource>("selected")?.setData(this.selectionData);
          this.setSelection(lost);
        }
      }
      return;
    }
    const a = tracked[found];
    const at = aircraft.features[found].geometry.coordinates;
    const route = this.routeOf(a.callsign);
    const path = selectedPath(this.history.track(a.id), at, route);
    this.selectionData = selectionFeatures(path, at, a.headingDeg, a.altitudeFt);
    this.map.getSource<GeoJSONSource>("selected")?.setData(this.selectionData);
    this.setSelection({
      id: a.id,
      callsign: a.callsign,
      typeCode: a.typeCode,
      altitudeFt: Math.round(a.altitudeFt / 100) * 100,
      onGround: a.onGround,
      speedKt: a.groundSpeedKt === null ? null : Math.round(a.groundSpeedKt),
      headingDeg: a.headingKnown ? Math.round(a.headingDeg) % 360 : null,
      verticalRateFpm: a.verticalRateFpm === null ? null : Math.round(a.verticalRateFpm / 100) * 100,
      route,
      estimated: isEstimated(path),
      lostAt: null,
    });
    this.keepClearOfCard(at);
  }

  /**
   * Eases the map so the selected aircraft stands in the free area, clear of the flight card, when it
   * has been selected or has flown under the card. Not once the reader has moved the map themselves, nor
   * while a journey steers it, nor while it is already moving.
   */
  private keepClearOfCard(at: [number, number]): void {
    const rect = this.cardRect?.();
    const now = performance.now();
    if (!rect || this.userMoved || this.driver || this.map.isMoving() || now - this.lastEase < EASE_EVERY_MS) return;
    const box = this.container.getBoundingClientRect();
    const p = this.map.project(at);
    const [dx, dy] = shiftClearOfCard(p, { width: box.width, height: box.height }, { left: rect.left - box.left, right: rect.right - box.left, top: rect.top - box.top, bottom: rect.bottom - box.top });
    if (Math.hypot(dx, dy) < 4) return;
    this.lastEase = now;
    // The camera moves the way the aircraft is to go the other way round.
    this.map.panBy([-dx, -dy], { duration: 600 });
  }

  private setSelection(flight: MapFlight | null): void {
    const json = JSON.stringify(flight);
    if (json === this.selectionJson) return;
    this.selectionJson = json;
    this.lastFlight = flight;
    this.onSelection?.(flight);
  }

  private draw(): void {
    if (!this.map.getLayer("aircraft")) return;
    this.map.getSource<GeoJSONSource>("airports")?.setData(airportFeatures(AIRPORTS, this.counts));
    this.map.getSource<GeoJSONSource>("arcs")?.setData(routeArcs(this.routes.values()));
  }

  /** The recorded regions, parsed once: the fixture's sky and counts. */
  private async recordedRegions(): Promise<RegionSnapshot[]> {
    if (!this.recorded) {
      this.recorded = await Promise.all(RECORDED_REGIONS.map(async ({ cell, load }) => parseRegion((await load()).default, cell)));
    }
    return this.recorded;
  }

  private async loadRecordedRoutes(): Promise<void> {
    if (!this.fixture) return;
    for (const load of RECORDED_ROUTES) this.addRoutes((await load()).default as Record<string, FlightRoute>);
  }

  private async loadCounts(): Promise<void> {
    if (!this.active) return;
    if (this.fixture) {
      const regions = await this.recordedRegions();
      // The airports whose cell was recorded are counted from it, ATL from its own recording (as the
      // diorama counts it, so the marker and the diorama agree); the rest have no count to show.
      const [{ default: raw }, { parseTraffic }] = await Promise.all([import("../__fixtures__/adsblol_atl.json"), import("../traffic")]);
      const atl = AIRPORTS.find((a) => a.code === "atl")!;
      const counts: Counts = {};
      for (const region of regions) {
        const inCell = AIRPORTS.filter((a) => a.code !== "atl" && cellOf(a).latitude === region.cell.latitude && cellOf(a).longitude === region.cell.longitude);
        Object.assign(counts, countsNear(inCell, region.aircraft));
      }
      this.counts = { ...counts, ...countsNear([atl], parseTraffic(raw, atl).aircraft) };
    } else {
      try {
        const res = await fetch("/api/counts");
        // Zoomed out, the counts are the live read the map shows: a 502 (nothing to serve) turns its dot red.
        if (this.feedHeld) {
          if (res.ok) recordFeedAnswer({}, Date.now(), "map");
          else recordFeedFailure(res.status, "map");
        }
        if (!res.ok) return;
        const body = (await res.json()) as { counts?: Counts };
        if (body.counts && typeof body.counts === "object") this.counts = body.counts;
      } catch {
        // The last counts stand until the next read.
        return;
      }
    }
    this.draw();
  }

  private async loadRegion(): Promise<void> {
    if (!this.active || !this.map.getLayer("aircraft")) return;
    if (this.fixture) {
      // The recorded cells as one moment, flown on from when the page opened.
      if (this.sky.size === 0) {
        const snapshot = mergeRegions(await this.recordedRegions(), MAP_ORIGIN, { rebase: true });
        const opened = Date.now() / 1000;
        this.clock = () => snapshot.time + (Date.now() / 1000 - opened);
        this.sky.add(snapshot);
      }
      return;
    }
    const request = ++this.regionRequest;
    let cells = this.map.getZoom() >= REGION_ZOOM ? cellsCovering(this.visibleBounds()) : [];
    if (cells.length > MAX_CELLS) cells = [];
    this.holdFeed(!cells.length);
    if (!cells.length) return;
    const reads: Read[] = [];
    const answers = await Promise.all(
      cells.map(async (c) => {
        try {
          const res = await fetch(regionPath(c));
          if (!res.ok) {
            reads.push({ ok: false, status: res.status });
            return null;
          }
          const body = (await res.json()) as RegionSnapshot & { stale?: unknown; ageS?: unknown };
          reads.push({ ok: true, stale: body.stale === true, ageS: typeof body.ageS === "number" ? body.ageS : undefined });
          return body;
        } catch {
          reads.push({ ok: false, status: null });
          return null;
        }
      }),
    );
    // A slower answer to an older view never overwrites a newer one.
    if (request !== this.regionRequest) return;
    // The map's LIVE dot: as old as the stalest cell drawn, or offline when the server had nothing to serve.
    const round = summariseReads(reads);
    if (round && "answer" in round) recordFeedAnswer(round.answer, Date.now(), "map");
    else if (round) recordFeedFailure(round.failure, "map");
    const read = answers.filter((a): a is RegionSnapshot => a !== null && typeof a.time === "number");
    if (!read.length) return;
    const snapshot = mergeRegions(read, MAP_ORIGIN);
    // Run on the feed's own clock, so the playback delay is measured against its timestamps.
    this.offset ??= snapshot.time - Date.now() / 1000;
    const offset = this.offset;
    this.clock = () => Date.now() / 1000 + offset;
    this.sky.add(snapshot);
  }

  /** Holds the map's LIVE dot current while no aircraft are read (zoomed out), or lets it age from the region reads. Never for a fixture, whose dot the page sets. */
  private holdFeed(held: boolean): void {
    if (this.fixture || held === this.feedHeld) return;
    this.feedHeld = held;
    startFeed(Date.now(), held ? { hold: true } : {}, "map");
  }

  /**
   * The ground in view, kept to a few degrees round the centre: tilted toward the horizon the map's
   * bounds run hundreds of kilometres off, where nothing would be legible anyway.
   */
  private visibleBounds() {
    const b = this.map.getBounds();
    const c = this.map.getCenter();
    const reach = 6;
    return {
      west: Math.max(b.getWest(), c.lng - reach),
      east: Math.min(b.getEast(), c.lng + reach),
      south: Math.max(b.getSouth(), c.lat - reach),
      north: Math.min(b.getNorth(), c.lat + reach),
    };
  }
}
