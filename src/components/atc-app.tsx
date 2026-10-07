"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { flushSync } from "react-dom";
import { type KeyboardEvent, type RefObject, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { countTraffic, pickFeatured, type TrafficCounts } from "@/lib/aircraft-state";
import type { AirportMap, Point } from "@/lib/airport-map";
import type { NasStatus } from "@/lib/faa-status";
import { AIRPORTS, type Airport, airportByCode } from "@/lib/airports";
import type { GlobeMap } from "@/lib/globe/globe-map";
import { AIRCRAFT_GLYPH, BEACON_RADIUS_PX, GLYPH_BOX, GLYPH_PX } from "@/lib/globe/aircraft-glyph";
import { groundView, liftView, mapHashCamera, orbitToMap, withoutBadMapHash } from "@/lib/globe/camera";
import { journeyIconSize, PALETTES } from "@/lib/globe/map-style";
import { fogReach } from "@/lib/journey";
import { type Band, landingAirport, reveal, revealMask } from "@/lib/globe/handover";
import { type Filters, filterOptions, type FilterOptions, filtersActive, Ghosts, GHOST_MS, matches, NO_OPTIONS, rememberSeen, snapshotSubject, type Subject, subjectOfEntry, withFilters } from "@/lib/filters";
import { toGeo, toLocal } from "@/lib/geo";
import type { JourneyFix } from "@/lib/journey-follow";
import { withAirport } from "@/lib/airport-url";
import { parseMapHash, shareLink } from "@/lib/share-link";
import type { FeedSource } from "@/lib/feed-source";
import { Journey, type JourneyStatus } from "@/lib/journey-follow";
import { feedSourceFor } from "@/lib/journey-source";
import { readHex } from "@/lib/hex";
import type { FlightRoute } from "@/lib/routes";
import { activeMovements, type Movements as MovementsData } from "@/lib/movements";
import type { AirportScene, ScenePath } from "@/lib/scene/airport-scene";
import { type CameraMode, cameraModes, CameraRig, lookDrag, lookKey, MODES, type ModeLook, modeShot } from "@/lib/scene/cameras";
import type { Rect, SceneLabel } from "@/lib/scene/labels";
import { ease, type OrbitView, orbit, pan, panAlong, turn, zoom } from "@/lib/scene/orbit";
import { MODEL, type SceneTheme, THEMES, type ThemeKey } from "@/lib/scene/theme";
import { viewKey } from "@/lib/scene/view-keys";
import { fixtureFeed, recordFeedAnswer, recordFeedFailure, startFeed } from "@/lib/feed-health";
import { PLAYBACK_DELAY, type Tracker } from "@/lib/tracker";
import type { TrafficSnapshot } from "@/lib/traffic";
import type { FlightCard as FlightCardData, TrafficEntry, TrafficView } from "@/lib/traffic-view";
import type { OpsView, PathPulse } from "@/lib/path-pulse";
import { CameraMenu, CameraSwitch, COLUMN_BESIDE, ColumnPanel, Counts, DataCredit, ESTIMATES_NOTE, FlightCard, Header, JourneyCard, Legend, RadarToggle, Search, SideColumn, STACKED, ThemeSwitch, TimeBar, type TimeBarReplay, useMedia, useTrafficReadout, ViewControls, WeatherReadout, WIDE } from "./chrome";
import { FilterControl } from "./filter-control";
import { ShareControl } from "./share-control";
import { quietArrival } from "@/lib/journey-arrival";
import { journeyFrame, type ReaderAction, releasesJourney } from "@/lib/journey-release";
import { arrivedCard, selectedOf } from "@/lib/journey-card";
import { flightPhase, journeyView } from "@/lib/journey-view";
import { lostNote, type MapFlight, mapFlightCard } from "@/lib/globe/map-flight";
// weather
import type { Metar } from "@/lib/metar";
import { atmosphere, backdropOver } from "@/lib/scene/atmosphere";
import { localTimeAt, sunPosition } from "@/lib/sun";
// /weather
// replay
import type { Replay, ReplayRate } from "@/lib/replay";
// /replay
// search
import { useSearch } from "./use-search";
import { type RadarControl, useRadar } from "./use-radar";
// alerts
import { inBounds } from "@/lib/alerts";
import { MAX_RANGE_M } from "@/lib/traffic";
import { AlertsMenu } from "./alerts-menu";
import { type AlertsControl, useAlerts } from "./use-alerts";
// /alerts
// /search

/** How often the live feed is polled, and how often the counts and card are refreshed from the frame. */
const POLL_MS = 5_000;
const CHROME_MS = 250;
/** A click within this many pixels of an aircraft selects it. */
const PICK_RADIUS = 28;
/** Space the airport keeps from the frame's edges on a wide screen, CSS pixels: beside the column, and under the header and over the controls. */
const FIELD_MARGIN = { x: 40, top: 88, bottom: 88 };
/** The same on a short landscape window (COLUMN_BESIDE without the wide layout), where the title, search, wind and map style rows run to 176 px (the model is framed a little under them, as the corners of its plan are empty) and the view controls start 124 px up from the foot. */
const SHORT_FIELD_MARGIN = { top: 168, bottom: 124 };
/** Rows in the active movements list. */
const MOVEMENT_ROWS = 5;
/** Faded out past this much by the filters, an aircraft counts as left out: it cannot be picked and has no path drawn. */
const GHOSTED = 0.5;
/** How long a link's camera waits for its flight to be selected, ms. */
const CAMERA_WAIT_MS = 40_000;
/** Most aircraft the filters remember having seen (the oldest go first): a day at a busy airport is a few thousand. */
const SEEN_MAX = 4_000;
/** How often the FAA's delay programs are read again. */
const STATUS_MS = 120_000;
/** A drag shorter than this, CSS pixels, is a click. */
const CLICK_PX = 5;
/** How close Follow brings the camera, metres, unless the reader is already closer. */
const FOLLOW_DISTANCE = 1400;
/** Share of the way a followed flight's camera closes on it in a 60th of a second. */
const EASE = 0.14;
/** How long a button's move or Reset view takes, ms. */
const MOVE_MS = 600;
/** How far an arrow key slides the ground, as a share of the camera's distance. */
const KEY_PAN = 0.15;
/**
 * The world map hands over to the diorama between the farthest the diorama lets the camera go and this
 * many times that (a zoom level and a half or so), but never past HANDOVER_MAX_M: the airport has to
 * stay inside the scene's 60 km draw distance.
 */
const HANDOVER_FAR = 3.2;
const HANDOVER_MAX_M = 55_000;
/** How often the map under the diorama is moved to keep up with it, ms: it is hidden, so only its tiles need to be ready. */
const MAP_FOLLOW_MS = 250;
/** How far down the frame, CSS pixels, the colour under the header's fade is read: the middle of its solid part. */
const SCRIM_ROW_PX = 56;
/** A flight followed from the map this near its origin, metres, brings that airport's diorama up first. */
const FOLLOW_NEAR_M = 150_000;
/**
 * The followed flight's beacon shows where its model is shorter on screen than BEACON_UNTIL_PX, fully
 * from BEACON_FADE_PX shorter than that; the model's length is measured as a typical airliner's.
 */
const BEACON_UNTIL_PX = 30;
const BEACON_FADE_PX = 14;
const SUBJECT_LENGTH_M = 40;
/** The buildings start to rise once this much of the diorama is in, after the ground plan. */
const RISE_FROM = 0.45;

/** The handover band for a scene: from the diorama's farthest view out to HANDOVER_FAR times it. */
function bandOf(scene: AirportScene): Band {
  const near = scene.bounds.maxDistance;
  return { near, far: Math.max(near * 1.5, Math.min(near * HANDOVER_FAR, HANDOVER_MAX_M)) };
}

/**
 * Which camera leads: the map's (the reader is on the world map, the diorama drawn over it as the camera
 * closes on the airport) or the diorama's (the map kept in step under it). `armed` is set once the map
 * has been outside the diorama's range, so a hand back to the map is not taken straight back. `land` is
 * set by a pick of another airport: the map flies down onto it once its diorama has loaded.
 */
interface Lead {
  by: "map" | "scene";
  armed: boolean;
  land: boolean;
}

/** The world map, which outlives every airport's diorama: the page owns it and hands it to each one. */
interface World {
  globeRef: RefObject<GlobeMap | null>;
  leadRef: RefObject<Lead>;
  mapRef: RefObject<HTMLDivElement | null>;
  /** The map takes the lead (the diorama hands back) or gives it up; the chrome follows. */
  setLead: (by: Lead["by"]) => void;
  /** Whether the map leads, as React state, for the chrome. */
  onMap: boolean;
  /** Where the feeds come from: the network, or `?fixture=journey`'s recording. Made once, on first ask. */
  source: () => Promise<FeedSource>;
  /** The flight followed gate to gate, which outlives each airport's diorama, and what the chrome shows of it. */
  journeyRef: RefObject<Journey | null>;
  journey: JourneyStatus | null;
  /** The hex of the flight whose journey is under way or just asked for (its Journey is made once the feed source resolves); null with none. */
  journeyHexRef: RefObject<string | null>;
  startJourney: (flight: { hex: string; callsign: string; origin: Airport; route: FlightRoute | null; originKnown?: boolean }, ready?: () => void) => void;
  stopJourney: () => void;
  /** The flight has climbed out of the diorama: the map takes the camera from `view` (aimed at it) and follows it. */
  journeyToMap: (view: OrbitView, airport: Airport, now: number) => void;
  /** It has come down into the destination's diorama, which follows it from here. */
  journeyLanded: () => void;
  /** The chrome's map or diorama layout, apart from which leads: a journey switches it once the map is what shows. */
  showMap: (on: boolean) => void;
  /** The weather radar layer, which belongs to the map and so outlives each airport's diorama. */
  radar: RadarControl;
  /** Browser alerts, which follow the reader from airport to airport and onto the map. */
  alerts: AlertsControl;
  /** The flight selected on the map, which outlives each airport's diorama like the map does; null with none. */
  mapFlight: MapFlight | null;
  /** The map's flight card, which the selected aircraft is kept clear of. */
  mapCardRef: RefObject<HTMLDivElement | null>;
  /** The journey's card on the map. */
  journeyCardRef: RefObject<HTMLDivElement | null>;
}

let webgl2: boolean | null = null;

/** WebGL 2 only: three dropped WebGL 1. Probed once; the probe context is released straight away. */
function supportsWebGL2(): boolean {
  if (webgl2 === null) {
    try {
      const gl = document.createElement("canvas").getContext("webgl2");
      gl?.getExtension("WEBGL_lose_context")?.loseContext();
      webgl2 = gl !== null;
    } catch {
      webgl2 = false;
    }
  }
  return webgl2;
}

const noSubscription = () => () => {};

/** Said in the counts' place when a fixture, a recording of other airports, is asked for at one it does not hold. */
const NO_FIXTURE_TRAFFIC = "No recorded aircraft at this airport";

const clockFormats = new Map<string, Intl.DateTimeFormat>();
/** "14:02" in the airport's own time, one formatter per time zone. */
function clockFormatFor(airport: Airport): Intl.DateTimeFormat {
  let format = clockFormats.get(airport.timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: airport.timeZone });
    clockFormats.set(airport.timeZone, format);
  }
  return format;
}
/** A diorama's drawn aircraft as the journey reads a fix: where it is, how high and how fast. */
function journeyFix(entry: TrafficEntry, airport: Airport): JourneyFix {
  const a = entry.aircraft;
  const [latitude, longitude] = toGeo(airport, a.x, a.y);
  return { latitude, longitude, altitudeFt: a.altitudeFt, onGround: a.onGround, groundSpeedKt: a.groundSpeedKt, headingDeg: a.headingDeg, verticalRateFpm: a.verticalRateFpm, callsign: a.callsign, typeCode: a.typeCode };
}

/** What a replay draws for the predicted paths: none, and the same array each frame so the scene skips rebuilding. */
const NO_PATHS: ReturnType<PathPulse["update"]> = [];

// weather
/** How often the airport's METAR is read again: it is issued hourly, and specially when the weather turns. */
const WEATHER_MS = 300_000;

/**
 * The live light and air: the latest report, and an optional time of day to light the model at
 * (`?sun=08:30`, airport time, for shots). Applied to a scene from the frame loop, again only when the
 * scene, the report or the drawn minute changes.
 */
interface LiveWeather {
  metar: Metar | null;
  sunAt: string | null;
  applied: { scene: AirportScene; metar: Metar | null; minute: number } | null;
}

/** The moment drawn, UTC milliseconds, for the feed's time (UTC seconds): that time, or `?sun=`'s time of day on its date. */
function drawnTime(live: LiveWeather, time: number, airport: Airport): number {
  return (live.sunAt && localTimeAt(time * 1000, live.sunAt, airport.timeZone)) || time * 1000;
}

function applyWeather(live: LiveWeather, scene: AirportScene, theme: SceneTheme, time: number, airport: Airport): void {
  const minute = Math.floor(time / 60);
  const last = live.applied;
  if (last && last.scene === scene && last.metar === live.metar && last.minute === minute) return;
  live.applied = { scene, metar: live.metar, minute };
  const { sun, weather } = atmosphere(theme, sunPosition(drawnTime(live, time, airport), airport.latitude, airport.longitude), live.metar);
  scene.setSun(sun);
  scene.setWeather(weather);
}
// /weather
// replay
/** The time bar's view of the replay, in whole seconds so the chrome only changes when the bar would. */
function replayStatus(replay: Replay, liveClock: number, clockFormat: Intl.DateTimeFormat): TimeBarReplay {
  const { live, rate, picture, start, end } = replay.status(liveClock);
  return { live, rate, position: Math.round(picture - start), span: Math.round(end - start), since: clockFormat.format(new Date(start * 1000)) };
}
// /replay

interface ChromeState {
  /** What the filters leave showing, and how many aircraft there are in all. */
  counts: TrafficCounts | null;
  total: number | null;
  /** The airlines, types and routes the filters offer: those in the traffic drawn (the diorama's, or the map's in view). */
  options: FilterOptions;
  card: FlightCardData | null;
  /** "Approach: ILS RWY 8L, from FAA CIFP cycle 2610": what the selected flight's drawn path follows, when it is published. */
  procedure: string | null;
  movements: MovementsData | null;
  clock: string;
  following: boolean;
  /** Whether the reader has moved the view off the framed one. */
  moved: boolean;
  /** The camera mode, and the modes the selected flight (and the map) can offer. */
  camera: CameraMode;
  cameras: CameraMode[];
  // replay
  replay: TimeBarReplay | null;
  // /replay
  /** On the map, the aircraft it draws in view and how many the filters leave (the header's count); null in the diorama or with none drawn. */
  inView: { shown: number; total: number } | null;
}

/** The traffic side, which outlives any one scene: switching theme rebuilds the model, not the feed. */
interface Traffic {
  map: AirportMap;
  tracker: Tracker;
  view: TrafficView;
  /** The live clock in the feed's own UTC seconds (frozen for the fixture). */
  clock: () => number;
  // replay
  /** Every snapshot since the page opened, and where the picture is in them. */
  replay: Replay;
  /** The replay's own view of the traffic, so what it remembers about each aircraft never reaches the live one. */
  replayView: TrafficView;
  /** With `?fixture=sequence`: the recorded ATL run, which the board and pulse are played through as well. */
  sequence: TrafficSnapshot[] | null;
  // /replay
  /** Said in the counts' place when there is nothing to count; null when the traffic is as live as it gets. */
  notice: string | null;
}

/**
 * The page's two choices that outlive an airport: the map style and which airport is on. Both are kept
 * in the address (replaced, not pushed, so Back still leaves the page). Switching airport rebuilds
 * everything under it (traffic, ground plan, scene, routes, status) by keying it on the airport. The
 * world map is the page's too, made once, so a switch made on the map (flying down onto another
 * airport) never tears it down mid-flight.
 */
export function AtcApp({ initialTheme, initialAirport, initialFilters }: { initialTheme: ThemeKey; initialAirport: Airport["code"]; initialFilters: Filters }) {
  const [theme, setTheme] = useState<ThemeKey>(initialTheme);
  const [filters, setFilters] = useState<Filters>(initialFilters);
  /** The filters for the map, which is made once, outside React's render. */
  const filtersRef = useRef(initialFilters);
  const [airport, setAirport] = useState<Airport>(() => airportByCode(initialAirport)!);
  /** Set once the reader has switched airports, so the rebuilt header gives the picker its focus back. */
  const [switched, setSwitched] = useState(false);
  // The server cannot probe; it renders as if WebGL 2 is there and the client corrects it.
  const hasWebGL2 = useSyncExternalStore(noSubscription, supportsWebGL2, () => true);
  const mapRef = useRef<HTMLDivElement>(null);
  const globeRef = useRef<GlobeMap | null>(null);
  const leadRef = useRef<Lead>({ by: "scene", armed: false, land: false });
  const [onMap, setOnMap] = useState(false);
  const [mapFlight, setMapFlight] = useState<MapFlight | null>(null);
  const mapCardRef = useRef<HTMLDivElement>(null);
  const journeyCardRef = useRef<HTMLDivElement>(null);
  /** The theme and airport for the map, which is made once, outside React's render. */
  const themeRef = useRef(initialTheme);
  const airportRef = useRef(airport);

  const setLead = (by: Lead["by"]) => {
    leadRef.current = { ...leadRef.current, by, armed: false };
    setOnMap(by === "map");
  };

  // feed-source
  const sourceRef = useRef<Promise<FeedSource> | null>(null);
  const source = useCallback(() => (sourceRef.current ??= feedSourceFor(new URLSearchParams(window.location.search))), []);
  // /feed-source

  // journey
  const journeyRef = useRef<Journey | null>(null);
  const [journey, setJourney] = useState<JourneyStatus | null>(null);
  const journeyTimer = useRef(0);
  const journeyHexRef = useRef<string | null>(null);
  /**
   * Which start the journey belongs to: bumped by every start and every stop. A start builds its Journey
   * only once the feed source has resolved, and by then the reader may have stopped it or started another,
   * in which case the Journey is never made (it would be an orphan ticking on its own timer, or a journey
   * the reader had already ended).
   */
  const journeyGeneration = useRef(0);
  /** Brings the journey card up to date now rather than at the timer's next tick. */
  const journeyRefresh = useRef<() => void>(() => {});
  const stopJourney = () => {
    journeyGeneration.current++;
    journeyHexRef.current = null;
    const j = journeyRef.current;
    journeyRef.current = null;
    window.clearInterval(journeyTimer.current);
    j?.dispose();
    const globe = globeRef.current;
    globe?.setDriver(null);
    globe?.setUserMove(null);
    globe?.setJourney(null, null);
    setJourney(null);
  };
  const startJourney: World["startJourney"] = (flight, ready) => {
    stopJourney();
    journeyHexRef.current = flight.hex;
    const generation = journeyGeneration.current;
    void source()
      .then((s) => {
      if (generation !== journeyGeneration.current) return;
      const j = new Journey(s, flight);
      journeyRef.current = j;
      // The panel's figures, four times a second, timed by the feed's clock (the fixture's runs fast).
      ready?.();
      const refresh = () => setJourney((prev) => {
        const next = j.status(j.clock() * 1000);
        return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
      });
      journeyRefresh.current = refresh;
      refresh();
      journeyTimer.current = window.setInterval(refresh, 250);
    })
      .catch((error: unknown) => console.error("atc: the journey failed to start", error));
  };
  const journeyToMap: World["journeyToMap"] = (view, at, now) => {
    const j = journeyRef.current;
    const globe = globeRef.current;
    if (!j || !globe) return;
    // The map leads from here, but the chrome stays the diorama's until the map is what shows (showMap).
    leadRef.current = { by: "map", armed: false, land: false };
    globe.handBack(view);
    j.toMap(view, at, now);
    globe.setDriver((frame) => {
      const steer = j.mapView(frame);
      if (!steer) return;
      globe.followView(steer.view, steer.frame);
      globe.setJourney(j.hex, j.features(steer.view, steer.frame));
      // The card cites what the map was just given, in the same task: not a timer's tick later.
      if (j.citeChanged()) flushSync(journeyRefresh.current);
    });
    // A drag or a wheel on the map takes the camera back, and ends the journey there.
    globe.setUserMove(stopJourney);
  };
  const journeyLanded = () => {
    journeyRef.current?.landed();
    globeRef.current?.setDriver(null);
    globeRef.current?.setUserMove(null);
  };
  useEffect(
    () => () => {
      // A start still waiting for the feed source must not build its journey once the page is gone.
      journeyGeneration.current++;
      window.clearInterval(journeyTimer.current);
    },
    [],
  );
  // /journey

  // The world map, made once: a theme switch restyles it in place, so its camera survives. An address
  // that names a map view (`#map=`) opens on the map; otherwise the page opens on the diorama.
  useEffect(() => {
    const container = mapRef.current;
    if (!hasWebGL2 || !container) return;
    let stopped = false;
    let globe: GlobeMap | null = null;
    (async () => {
      const { GlobeMap } = await import("@/lib/globe/globe-map");
      if (stopped) return;
      const params = new URLSearchParams(window.location.search);
      const fixture = params.has("fixture");
      // The map's LIVE dot: a fixture's as the diorama's; live, held current until the map reads aircraft.
      startFeed(Date.now(), fixture ? fixtureFeed(params.get("feed")) : { hold: true }, "map");
      // Read before the map starts: it writes its own view into the address straight away. A #map= with
      // a part that is not a finite number (a hidden tab once wrote NaN there) is dropped, not opened on.
      const hash = withoutBadMapHash(window.location.hash);
      if (hash !== window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${hash}`);
      const named = mapHashCamera(hash) !== null;
      globe = new GlobeMap(container, { theme: themeRef.current, airport: airportRef.current, fixture });
      globeRef.current = globe;
      globe.setFilters(filtersRef.current);
      globe.setSelectionListener(setMapFlight);
      globe.setCardRect(() => mapCardRef.current?.firstElementChild?.getBoundingClientRect() ?? null);
      // On a phone the followed flight and its approach are kept between the journey's card and the controls at the foot.
      globe.setFrameBand(() =>
        window.matchMedia(WIDE).matches
          ? null
          : { card: journeyCardRef.current?.firstElementChild?.getBoundingClientRect() ?? null, controls: [...document.querySelectorAll("[data-map-foot], .maplibregl-ctrl-attrib")].map((e) => e.getBoundingClientRect()) },
      );
      if (named) {
        // A link's flight is selected on the map once the traffic shows it, and taken out of the address so the diorama does not go looking for it too.
        const wanted = params.get("flight")?.trim();
        if (wanted) {
          globe.selectCallsign(wanted);
          const url = new URL(window.location.href);
          url.searchParams.delete("flight");
          window.history.replaceState(window.history.state, "", url);
        }
        leadRef.current = { by: "map", armed: true, land: false };
        setOnMap(true);
        container.style.visibility = "visible";
      }
    })().catch((error: unknown) => console.error("atc: map failed to start", error));
    return () => {
      stopped = true;
      if (globeRef.current === globe) globeRef.current = null;
      globe?.dispose();
    };
  }, [hasWebGL2]);

  useEffect(() => {
    themeRef.current = theme;
    globeRef.current?.setTheme(theme);
  }, [theme]);

  // alerts: "in view" is the map's view while the map leads, else the airport on show
  const inArea = useCallback((latitude: number, longitude: number) => {
    const globe = globeRef.current;
    if (leadRef.current.by === "map" && globe) return inBounds(globe.viewBounds(), latitude, longitude);
    const [x, y] = toLocal(airportRef.current, latitude, longitude);
    return Math.hypot(x, y) <= MAX_RANGE_M;
  }, []);
  const alerts = useAlerts(inArea);
  // /alerts

  const radar = useRadar();
  const radarFrame = radar.frame;
  useEffect(() => {
    globeRef.current?.setRadar(radarFrame);
  }, [radarFrame]);

  const chooseTheme = (next: ThemeKey) => {
    setTheme(next);
    // Keep the address in step, so a reload or a shared link opens on the same style.
    const url = new URL(window.location.href);
    if (next === "light") url.searchParams.delete("theme");
    else url.searchParams.set("theme", next);
    window.history.replaceState(window.history.state, "", url);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEMES[next].background);
  };

  const chooseFilters = (next: Filters) => {
    filtersRef.current = next;
    setFilters(next);
    globeRef.current?.setFilters(next);
    // Kept in the address, so a reload or a shared link carries the same view of the traffic.
    window.history.replaceState(window.history.state, "", withFilters(window.location.href, next));
  };

  /**
   * Switches the airport on show. A pick (the picker, or a search result elsewhere, with `flight` to
   * select there once it is in the feed, as `?flight=`) flies the map there, landing once the new
   * diorama has loaded; a landing, the map already coming down onto it, just switches.
   */
  const chooseAirport = (code: Airport["code"], flight?: string, how: "pick" | "landing" = "pick") => {
    const next = airportByCode(code);
    if (!next || next.code === airportRef.current.code) return;
    airportRef.current = next;
    const globe = globeRef.current;
    globe?.setAirport(next);
    globe?.setGuide(null);
    if (globe && how === "pick") {
      leadRef.current = { by: "map", armed: false, land: true };
      setOnMap(true);
      globe.flyToward(next);
    }
    const url = withAirport(window.location.href, code);
    if (flight) url.searchParams.set("flight", flight);
    else url.searchParams.delete("flight");
    window.history.replaceState(window.history.state, "", url);
    setAirport(next);
    setSwitched(true);
  };

  const world: World = { globeRef, leadRef, mapRef, setLead, onMap, source, journeyRef, journey, journeyHexRef, startJourney, stopJourney, journeyToMap, journeyLanded, showMap: setOnMap, radar, alerts, mapFlight, mapCardRef, journeyCardRef };
  return (
    <main data-theme={theme} data-on-map={onMap || undefined} className="relative h-dvh w-full overflow-clip bg-paper font-sans text-ink">
      {/* The world map, under the diorama; shown once the page knows which of the two leads. MapLibre's
          stylesheet makes its container position: relative, so it fills a positioned box rather than being one. */}
      {/* Isolated, so MapLibre's controls (z-index 2) stay under the diorama while it leads. */}
      {/* Inert while the diorama is what shows: the map under it would otherwise hold five tab stops (its canvas and the credit line) and stay in the accessibility tree. */}
      <div className="absolute inset-0 isolate" inert={!onMap}>
        <div ref={mapRef} className="size-full" style={{ visibility: "hidden" }} role="region" aria-label="World map of live air traffic" />
      </div>
      <Viewer key={airport.code} airport={airport} theme={theme} onTheme={chooseTheme} onAirport={chooseAirport} filters={filters} onFilters={chooseFilters} focusPicker={switched} world={world} hasWebGL2={hasWebGL2} />
    </main>
  );
}

interface ViewerProps {
  airport: Airport;
  theme: ThemeKey;
  onTheme: (theme: ThemeKey) => void;
  onAirport: (code: Airport["code"], flight?: string, how?: "pick" | "landing") => void;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  focusPicker: boolean;
  world: World;
  hasWebGL2: boolean;
}

function Viewer({ airport, theme, onTheme, onAirport, filters, onFilters, focusPicker, world, hasWebGL2 }: ViewerProps) {
  const { globeRef, leadRef, mapRef, setLead, onMap, source, journeyRef, journey, journeyHexRef, radar, alerts, mapFlight, mapCardRef, journeyCardRef } = world;
  const feedAlerts = alerts.feed;
  const viewAlerts = alerts.view;
  /** The layer holding the diorama and everything pinned to it, faded in over the map as the camera closes on the airport. */
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const tagRef = useRef<HTMLDivElement>(null);
  const beaconRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AirportScene | null>(null);
  const leaderRef = useRef<SVGLineElement>(null);
  const pickedRef = useRef<string | null>(null);
  // A diorama made while a flight is followed on the map (one followed from the map, near its origin) opens on that flight, as the origin's does when it climbs out.
  useEffect(() => {
    const j = journeyRef.current;
    if (j?.stage === "map") pickedRef.current = j.hex;
  }, [journeyRef]);
  /** What the draw loop drew last, live or replayed: the search reads it. */
  const entriesRef = useRef<TrafficEntry[]>([]);
  /** The camera, kept here so a theme switch (a new scene) opens on the same view; null is the framed view. */
  const viewRef = useRef<OrbitView | null>(null);
  /**
   * A move under way (a button, Reset view): where to, and from where and when it began, which the
   * frame loop fills in on its first frame. A fixed time, so it lands on time at any frame rate.
   */
  const goalRef = useRef<{ to: OrbitView | "home"; from: OrbitView | null; start: number } | null>(null);
  /**
   * The aircraft the camera follows, how far back it follows from, and the bearing and tilt a button
   * asked for while following (null: keep whatever the view has).
   */
  const followRef = useRef<{
    id: string;
    distance: number;
    angle: Pick<OrbitView, "azimuthDeg" | "elevationDeg"> | null;
    /** A journey's camera: what still separates its aim (east, north, up, metres) from the shot's, dying away. */
    settle?: [number, number, number];
  } | null>(null);
  /** Set when the selection changes outside the frame loop, so the chrome catches up on the next frame. */
  const refreshRef = useRef(false);
  const [status, setStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [chrome, setChrome] = useState<ChromeState>({ counts: null, total: null, options: NO_OPTIONS, card: null, procedure: null, movements: null, clock: "--:--", following: false, moved: false, camera: "orbit", cameras: ["orbit"], replay: null, inView: null });
  /** The filters, read by the frame loop; a change of them has the chrome catch up on the next frame. */
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
    refreshRef.current = true;
  }, [filters]);
  /** What was last seen of each aircraft by the filters, kept for the board, which lists flights after they leave the feed. */
  const seenRef = useRef(new Map<string, Subject>());
  const [nas, setNas] = useState<NasStatus | null | undefined>(undefined);
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  /** Whether this airport's feed has answered once: until it has, and with nothing to read it from, the counts say so rather than "0 tracked". */
  const [heard, setHeard] = useState(false);
  // weather
  const weatherRef = useRef<LiveWeather>({ metar: null, sunAt: null, applied: null });
  const [metar, setMetar] = useState<Metar | null>(null);
  // /weather

  // path-pulse
  /**
   * Predicted paths and the airport's pulse, built with the traffic (so a theme switch keeps what has
   * been seen) and fed by the frame loop.
   */
  const opsRef = useRef<PathPulse | null>(null);
  const [ops, setOps] = useState<OpsView | null>(null);
  useEffect(() => {
    if (!traffic) return;
    let stopped = false;
    const clockFormat = clockFormatFor(airport);
    const format = (t: number) => clockFormat.format(new Date(t * 1000));
    (async () => {
      const [{ PathPulse }, { replayPulse }, procedures] = await Promise.all([
        import("@/lib/path-pulse"),
        import("@/lib/pulse-replay"),
        // The published approaches and SIDs; without them the air legs are the extended centreline.
        import("@/lib/procedure-data").then(({ loadProcedures }) => loadProcedures(airport)),
      ]);
      if (stopped) return;
      const { sequence } = traffic;
      if (!sequence?.length) {
        opsRef.current = new PathPulse(traffic.map, { since: traffic.clock() - PLAYBACK_DELAY, format, procedures });
        return;
      }
      // As if the page had been open for the whole recording: the board and pulse show what happened in it.
      const pulse = new PathPulse(traffic.map, { since: sequence[0].time - PLAYBACK_DELAY, format, procedures });
      replayPulse(pulse, sequence, traffic.map, airport);
      opsRef.current = pulse;
    })().catch((error: unknown) => console.error("atc: predicted paths failed to start", error));
    return () => {
      stopped = true;
      opsRef.current = null;
    };
  }, [traffic, airport]);
  // /path-pulse

  // cameras
  /**
   * The camera mode (tower, chase, threshold, cockpit) and the ease in and out of it. The orbit's own
   * view stays in viewRef the whole time, so leaving a mode goes back to where the reader was.
   */
  const rigRef = useRef(new CameraRig());
  const chooseCamera = (mode: CameraMode) => {
    rigRef.current.set(mode);
    goalRef.current = null;
    refreshRef.current = true;
  };
  /** Reset view in a mode goes back to the orbit, and does nothing else. */
  const leaveCamera = (): boolean => {
    if (!rigRef.current.active) return false;
    chooseCamera("orbit");
    return true;
  };
  /**
   * In a mode the view buttons and keys look around in it, eased, and never leave it (only the Orbit
   * button, Reset view and Escape do). True when the step was the mode's.
   */
  const lookInMode = (step: ModeLook): boolean => {
    const rig = rigRef.current;
    if (rig.mode === "orbit") return false;
    rig.lookBy(step, true);
    refreshRef.current = true;
    return true;
  };
  // Escape anywhere on the page goes back to the orbit, unless something (the airport picker) used it.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || rigRef.current.mode === "orbit") return;
      rigRef.current.set("orbit");
      goalRef.current = null;
      refreshRef.current = true;
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  // /cameras

  // A link's camera (`?camera=drone`) is taken up once the flight it follows is selected (`?flight=` is dropped when it is), if the mode is on offer by then.
  const takeUpCamera = useRef(chooseCamera);
  useEffect(() => {
    takeUpCamera.current = chooseCamera;
  });
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const want = MODES.find((m) => m === params.get("camera"));
    if (!want) return;
    if (want !== "orbit" && (params.has("flight") || !chrome.cameras.includes(want))) return;
    takeUpCamera.current(want);
    const url = new URL(window.location.href);
    url.searchParams.delete("camera");
    window.history.replaceState(window.history.state, "", url);
  }, [chrome.cameras, chrome.card?.id]);
  // Not for ever: a camera that never became available is dropped from the address, so it does not surprise a later pick.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      if (!url.searchParams.has("camera")) return;
      url.searchParams.delete("camera");
      window.history.replaceState(window.history.state, "", url);
    }, CAMERA_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // share
  /** A link to the view as it is: the map's position when the map leads, else the airport with the selected flight and camera. */
  const shareThisView = () =>
    shareLink(window.location.href, {
      airport: airport.code,
      theme,
      flight: onMap ? (mapFlight ? (mapFlight.callsign ?? mapFlight.id.toUpperCase()) : null) : (chrome.card?.callsign ?? null),
      camera: chrome.camera,
      filters,
      map: onMap ? parseMapHash(window.location.hash) : null,
    }).href;
  // /share

  // map-select
  /**
   * Follow the flight selected on the map, gate to gate: the same journey the diorama's Follow starts,
   * with the map in charge of the camera from the first frame (the flight is already in the air). Its
   * origin is the route's, where that is a built airport, else the built airport nearest the aircraft.
   */
  const followMapFlight = (on: boolean) => {
    const globe = globeRef.current;
    const flight = mapFlight;
    if (!on) {
      world.stopJourney();
      return;
    }
    const hex = flight && readHex(flight.id);
    const at = globe?.selectedAt;
    if (!globe || !flight || !hex || !at || flight.lostAt !== null) return;
    const named = flight.route && airportByCode(flight.route.origin.code.toLowerCase());
    const nearest = AIRPORTS.reduce((best, a) => (Math.hypot(...toLocal(a, at.latitude, at.longitude)) < Math.hypot(...toLocal(best, at.latitude, at.longitude)) ? a : best));
    const origin = named || nearest;
    const near = origin.code !== airport.code && Math.hypot(...toLocal(origin, at.latitude, at.longitude)) < FOLLOW_NEAR_M;
    world.startJourney({ hex, callsign: flight.callsign ?? hex.toUpperCase(), origin, route: flight.route, originKnown: !!named }, () => {
      // The page's diorama is the origin's while the flight is still near it, as it is when a flight climbs out of its own: the map's camera and the diorama's metres then agree.
      if (near) onAirport(origin.code, undefined, "landing");
      world.journeyToMap(globe.view, airportByCode(globe.airportCode) ?? origin, performance.now());
    });
  };
  // /map-select

  // journey
  /**
   * The reader's own acts end a journey, and only they do (journey-release.ts): every place that lets go of
   * the follow on the reader's behalf calls this beside it. A follow cleared for any other reason leaves the
   * journey running, and the frame loop puts the follow back.
   */
  const letGo = (action: ReaderAction) => {
    if (releasesJourney(action, journeyHexRef.current)) world.stopJourney();
  };
  /**
   * The reader's act that lets go of the followed flight (all but a few of the places that clear the follow): the follow goes, unless it is
   * on `keepId`'s flight, and the journey goes with it as letGo says. The follow cleared for any other reason is a plain write, and says why.
   */
  const clearFollow = (action: ReaderAction, keepId: string | null = null) => {
    letGo(action);
    if (followRef.current?.id !== keepId) followRef.current = null;
  };
  // /journey

  /** A row of the movements list picks its aircraft, as a click on it in the scene does. */
  const selectFlight = (id: string) => {
    pickedRef.current = id;
    clearFollow({ kind: "pick", id }, id); // journey
    refreshRef.current = true;
  };

  /**
   * Follow the selected flight: the camera eases to it and keeps it in the middle of the free area. A
   * flight leaving this airport is followed gate to gate: out of the diorama, across the map, and into its
   * destination's diorama when that is built.
   */
  const follow = (on: boolean) => {
    const id = chrome.card?.id;
    if (on && id) {
      followRef.current = { id, distance: Math.min(sceneRef.current?.currentView.distance ?? Infinity, FOLLOW_DISTANCE), angle: null };
      pickedRef.current = id;
    } else {
      clearFollow({ kind: "unfollow" }); // journey: Follow toggled off lets go of the journey's flight
    }
    // journey
    const card = chrome.card;
    const hex = card && readHex(card.id);
    if (on && card && hex && (card.direction === "outbound" || (!card.route && card.state === "departing"))) {
      world.startJourney({ hex, callsign: card.callsign, origin: airport, route: card.route });
    } else if (on && id) {
      // Following another flight lets go of the journey's.
      letGo({ kind: "follow", id });
    }
    // /journey
    goalRef.current = null;
    refreshRef.current = true;
    // The toggle answers at once; the frame loop's next refresh agrees with it.
    setChrome((prev) => ({ ...prev, following: followRef.current !== null }));
  };

  /** The buttons' moves, eased from wherever the view is (or is already heading). */
  const nudge = (step: (v: OrbitView) => OrbitView) => {
    const scene = sceneRef.current;
    // Easing back from a mode, the orbit's view is not the reader's to move yet.
    if (!scene || rigRef.current.active) return;
    const followed = followRef.current;
    if (followed) {
      // The frame loop eases a followed view, so the button changes what it eases toward.
      const v = step({ ...scene.currentView, distance: followed.distance, ...followed.angle });
      followed.distance = v.distance;
      followed.angle = { azimuthDeg: v.azimuthDeg, elevationDeg: v.elevationDeg };
      refreshRef.current = true;
      return;
    }
    const to = goalRef.current?.to;
    goalRef.current = { to: step(to === undefined ? scene.currentView : to === "home" ? scene.homeView : to), from: null, start: 0 };
    refreshRef.current = true;
  };
  // globe
  /**
   * Hands the camera back to the map, where the diorama lets go: the map carries on from the same view.
   * Camera modes and the replay are the diorama's, so the orbit and the live picture come back first.
   */
  const toMap = () => {
    const globe = globeRef.current;
    const scene = sceneRef.current;
    if (!globe || !scene) return;
    leaveCamera();
    traffic?.replay.goLive();
    // Asked for only by the reader's zoom out (outToMap), which a followed flight refuses: a journey still here has no follow left to keep, and the reader is leaving the diorama.
    clearFollow({ kind: "slide" }); // journey
    setLead("map");
    goalRef.current = null;
    globe.handBack(scene.currentView);
    refreshRef.current = true;
  };
  /**
   * The map, while it leads the camera; null while the diorama does. Asked for by the reader's own
   * controls, so a journey on the map lets go of the camera to them, as a drag on the map does.
   */
  const mapLeading = () => {
    if (leadRef.current.by !== "map") return null;
    if (journeyRef.current?.stage === "map") world.stopJourney();
    return globeRef.current;
  };
  /** Whether a zoom out by `factor` goes past the farthest the diorama goes, and so to the map. */
  const outToMap = (factor: number) => {
    const scene = sceneRef.current;
    return !!scene && !!globeRef.current && factor > 1 && !followRef.current && scene.currentView.distance >= scene.bounds.maxDistance * 0.999;
  };
  /** From the map, down into this airport's framed view, as Reset view does there. False when the map does not lead. */
  const landHere = (): boolean => {
    const globe = mapLeading();
    const scene = sceneRef.current;
    if (!globe || !scene) return false;
    globe.flyTo({ ...scene.homeView, distance: scene.bounds.maxDistance * 0.98 });
    return true;
  };
  /** A search pick made on the map, run once the diorama has taken the lead (the map's frames would undo it before then). */
  const pendingRef = useRef<(() => void) | null>(null);
  const afterLanding = (pick: () => void) => {
    if (leadRef.current.by === "map" && landHere()) pendingRef.current = pick;
    else pick();
  };
  /**
   * A pick of another airport (the picker, a search result there) leaves the diorama for the map, which
   * flies there; a pick of this one, made on the map, lands on its diorama.
   */
  const pickAirport = (code: Airport["code"], flight?: string) => {
    // A pick that goes somewhere else lets the journey go; this airport again only lands the map on it (landHere lets go of a journey the map is leading).
    letGo({ kind: "airport", to: code, here: airport.code });
    if (code === airport.code) {
      landHere();
      return;
    }
    if (leadRef.current.by === "scene") toMap();
    onAirport(code, flight, "pick");
  };
  // /globe
  /** The view buttons and keys: in a mode they look around in it; on the map they move the map; zooming out past the diorama's farthest hands over to the map. */
  const zoomBy = (factor: number) => {
    if (lookInMode(lookKey({ kind: "zoom", factor }))) return;
    const globe = mapLeading();
    if (globe) globe.zoomBy(factor);
    else if (outToMap(factor)) toMap();
    else nudge((v) => (sceneRef.current ? zoom(v, factor, sceneRef.current.bounds) : v));
  };
  const turnBy = (deg: number, tilt = 0) => {
    if (lookInMode(lookKey({ kind: "turn", deg, tilt }))) return;
    const globe = mapLeading();
    if (globe) globe.turn(deg);
    else nudge((v) => turn(v, deg, tilt));
  };
  /** The keyboard's way to do what the view buttons and drags do, once the model has focus. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const key = viewKey(e);
    if (!key) return;
    e.preventDefault();
    if (lookInMode(lookKey(key))) return;
    if (key.kind === "zoom") zoomBy(key.factor);
    else if (key.kind === "turn") turnBy(key.deg, key.tilt);
    else {
      // Sliding lets go of a followed flight, as a drag does, and of a journey.
      letGo({ kind: "slide" }); // journey
      if (followRef.current) follow(false);
      nudge((v) => (sceneRef.current ? panAlong(v, key.forward * v.distance * KEY_PAN, key.right * v.distance * KEY_PAN, sceneRef.current.bounds) : v));
    }
  };
  const resetView = () => {
    // From the map, back down into the diorama's framed view.
    if (landHere()) return;
    clearFollow({ kind: "reset", inMode: rigRef.current.active }); // journey
    if (leaveCamera()) {
      // Out of a mode straight to the framed view, in one ease.
      viewRef.current = null;
      return;
    }
    goalRef.current = { to: "home", from: null, start: 0 };
    refreshRef.current = true;
  };

  // globe
  // The frame loop and gestures, set up once per scene, call the page's latest actions through this.
  /** The diorama has taken the lead from the map: a search pick made on the map runs now. */
  const landed = () => {
    setLead("scene");
    const pick = pendingRef.current;
    pendingRef.current = null;
    pick?.();
  };
  // journey
  /** The followed flight has climbed out of the diorama: the map takes the camera, aimed at it, from here. */
  const journeyOut = (now: number) => {
    const scene = sceneRef.current;
    if (!scene || !globeRef.current) return;
    leaveCamera();
    traffic?.replay.goLive();
    goalRef.current = null;
    followRef.current = null; // not the reader's: the camera passes to the map, and the journey goes with it
    world.journeyToMap(scene.currentView, airport, now);
    refreshRef.current = true;
  };
  // /journey
  const actionsRef = useRef({ toMap, mapLeading, outToMap, onAirport, landed, journeyOut, journeyLanded: world.journeyLanded, stopJourney: world.stopJourney, clearFollow, showMap: world.showMap, setLead });
  useEffect(() => {
    actionsRef.current = { toMap, mapLeading, outToMap, onAirport, landed, journeyOut, journeyLanded: world.journeyLanded, stopJourney: world.stopJourney, clearFollow, showMap: world.showMap, setLead };
  });
  // /globe

  // search
  const search = useSearch({
    map: traffic?.map ?? null,
    entriesRef,
    sceneRef,
    labelsRef,
    goalRef,
    viewRef,
    followRef,
    refreshRef,
    onFlight: (id, on) => {
      selectFlight(id);
      if (!on) return;
      // Following is the orbit's: out of a mode first, as the card's Follow does from the orbit.
      leaveCamera();
      followRef.current = { id, distance: Math.min(sceneRef.current?.currentView.distance ?? Infinity, FOLLOW_DISTANCE), angle: null };
      goalRef.current = null;
      setChrome((prev) => ({ ...prev, following: true }));
    },
    leaveCamera,
    onAirport: pickAirport,
  });
  // On the map, a flight or place here lands on the diorama first; its own frames would undo the pick before then.
  const searchProps = {
    ...search,
    onFlight: (id: string, follow: boolean) => afterLanding(() => search.onFlight(id, follow)),
    onPlace: (place: Parameters<typeof search.onPlace>[0]) =>
      afterLanding(() => {
        clearFollow({ kind: "slide" }); // journey: the camera goes to the place, away from the flight
        search.onPlace(place);
      }),
  };
  // /search

  // replay
  // The time bar: LIVE, a speed, or a moment since the page opened, on performance.now() as the frame loop is.
  const replayLive = () => {
    traffic?.replay.goLive();
    refreshRef.current = true;
  };
  const replayRate = (rate: ReplayRate) => {
    if (traffic) traffic.replay.play(rate, traffic.clock(), performance.now() / 1000);
    refreshRef.current = true;
  };
  const replaySeek = (position: number) => {
    if (!traffic) return;
    const { start } = traffic.replay.status(traffic.clock());
    traffic.replay.seek(start + position, traffic.clock(), performance.now() / 1000);
    refreshRef.current = true;
  };
  // /replay

  // Traffic: the fixture (a frozen, reproducible moment) or the live feed.
  useEffect(() => {
    if (!hasWebGL2) return;
    let stopped = false;
    let stopPoll = () => {};
    (async () => {
      const [{ TrafficView, fixtureTime }, { Tracker }, { parseTraffic }, { loadAirportMap }, { Replay }, { GroundPaths }, { recordedTraffic }] = await Promise.all([
        import("@/lib/traffic-view"),
        import("@/lib/tracker"),
        import("@/lib/traffic"),
        import("@/lib/airport-data"),
        import("@/lib/replay"),
        import("@/lib/taxi-route"),
        import("@/lib/recorded-traffic"),
      ]);
      const map = await loadAirportMap(airport.code);
      if (stopped) return;
      const tracker = new Tracker();
      const view = new TrafficView(map, airport);
      // replay
      // Taxi trails follow the taxiways, so the time-lapse never draws an aircraft across the grass.
      const replay = new Replay(tracker, { elevationFt: airport.elevationFt, ground: new GroundPaths(map) });
      const replayView = new TrafficView(map, airport);
      const addRoutes = (routes: Parameters<TrafficView["addRoutes"]>[0]) => {
        view.addRoutes(routes);
        replayView.addRoutes(routes);
        // The routes flown from the built airports are the world map's network at country scale.
        globeRef.current?.addRoutes(routes);
      };
      // /replay
      let clock: () => number;
      let sequence: TrafficSnapshot[] | null = null;
      let notice: string | null = null;
      const params = new URLSearchParams(window.location.search);
      const fixture = params.get("fixture");
      if (fixture) startFeed(Date.now(), fixtureFeed(params.get("feed")));
      else startFeed(Date.now());
      // The recorded sequence is of Atlanta: elsewhere it only supplies the frozen moment, and there is no traffic.
      const atlanta = airportByCode("atl")!;
      const elsewhere = airport.code !== atlanta.code;
      if (fixture === "1") {
        // The airport's recording, frozen (Atlanta's, and Dallas-Fort Worth's cut from the region recorded
        // round it); an airport with none stands empty at the moment Atlanta's was made.
        const recorded = await recordedTraffic(airport);
        if (recorded) {
          tracker.add(recorded.snapshot);
          addRoutes(recorded.routes);
        } else notice = NO_FIXTURE_TRAFFIC;
        const frozen = fixtureTime(recorded?.snapshot ?? parseTraffic((await import("@/lib/__fixtures__/adsblol_atl.json")).default, atlanta));
        clock = () => frozen;
        // replay
      } else if (fixture === "sequence") {
        // A recorded stretch of live traffic, loaded as if the page had been open all through it; the clock stops at its end.
        const { readSequence, SEQUENCE_URL } = await import("@/lib/sequence");
        const res = await fetch(SEQUENCE_URL);
        if (!res.ok) throw new Error(`sequence: ${res.status}`);
        const snapshots = await readSequence(await res.arrayBuffer(), atlanta);
        if (elsewhere) notice = NO_FIXTURE_TRAFFIC;
        else {
          sequence = snapshots;
          for (const snapshot of snapshots) {
            tracker.add(snapshot);
            replay.add(snapshot);
          }
          addRoutes((await import("@/lib/__fixtures__/routes_atl.json")).default);
        }
        const frozen = fixtureTime(snapshots.at(-1)!);
        clock = () => frozen;
        // /replay
      } else {
        // The live feed, or `?fixture=journey`'s recording standing in for the network: the same code reads both.
        const feed = await source();
        if (stopped) return;
        // Run on the feed's own clock, the page's one, so the playback delay is measured against its
        // timestamps and every tracker on the page plays back to the same moment.
        clock = () => feed.clock();
        const load = async () => {
          try {
            const res = await feed.get(`/api/traffic/${airport.code}`);
            if (!res.ok) {
              if (!stopped) recordFeedFailure(res.status);
              return;
            }
            const snapshot = await res.json();
            if (stopped || typeof snapshot?.time !== "number") return;
            feed.heard(snapshot.time);
            // feed-health
            // A stale answer is the server's last good snapshot: the tracker drops one that is not newer than
            // what it holds, and the LIVE dot says how old the data is.
            recordFeedAnswer(snapshot, Date.now());
            // /feed-health
            tracker.add(snapshot);
            setHeard(true);
            replay.add(snapshot); // replay
            addRoutes(snapshot.routes);
            // alerts: from the poll, not the drawn frame, so a tab the browser has stopped drawing still alerts
            const watched = new Set<string>();
            if (followRef.current) watched.add(followRef.current.id);
            if (journeyRef.current) watched.add(journeyRef.current.hex);
            feedAlerts(snapshot.time, snapshot.aircraft, watched);
            // On the map, military aircraft that fly into the view, wherever it is.
            const globe = globeRef.current;
            if (globe && leadRef.current.by === "map") {
              const military = globe.militaryInView;
              viewAlerts(snapshot.time, military.list, military.view);
            }
            // /alerts
          } catch {
            // A missed poll is covered by the tracker's dead reckoning; the next one catches up, and until
            // then the LIVE dot counts the data's age.
            if (!stopped) recordFeedFailure(null);
          }
        };
        void load();
        stopPoll = feed.every(POLL_MS / 1000, load);
      }
      // The fixtures hold their traffic from the start; the live feed (and the journey's recording) is heard from its first answer, above.
      if (fixture === "1" || fixture === "sequence") setHeard(true);
      if (!stopped) setTraffic({ map, tracker, view, clock, replay, replayView, sequence, notice });
    })().catch((error: unknown) => {
      console.error("atc: traffic failed to start", error);
      if (!stopped) setStatus("failed");
    });
    return () => {
      stopped = true;
      stopPoll();
    };
  }, [hasWebGL2, airport, globeRef, leadRef, source, journeyRef, feedAlerts, viewAlerts]);

  // The FAA's delay programs, airport-wide. The fixture has none, so its cards say so.
  useEffect(() => {
    let stopped = false;
    if (new URLSearchParams(window.location.search).has("fixture")) {
      queueMicrotask(() => {
        if (!stopped) setNas({ updated: null, airports: {} });
      });
      return () => {
        stopped = true;
      };
    }
    // One failed read keeps the last answer (it is at most a poll old); a second says it is unavailable.
    let failures = 0;
    const load = async () => {
      let body: NasStatus | null = null;
      try {
        const res = await fetch("/api/status");
        if (res.ok) body = (await res.json()) as NasStatus;
      } catch {
        // Counted below as a failed read.
      }
      if (stopped) return;
      if (body && typeof body.airports === "object" && body.airports !== null) {
        failures = 0;
        setNas(body);
      } else {
        failures++;
        setNas((prev) => (failures < 2 ? (prev ?? null) : null));
      }
    };
    void load();
    const timer = window.setInterval(load, STATUS_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  // weather
  // The airport's METAR: the recorded one with the fixture, the live one otherwise; `?metar=` puts any
  // report in its place (and `?sun=` any time of day), so a shot can show fog or rain at will.
  useEffect(() => {
    let stopped = false;
    const params = new URLSearchParams(window.location.search);
    weatherRef.current.sunAt = params.get("sun");
    const take = (m: Metar | null) => {
      if (stopped) return;
      weatherRef.current.metar = m;
      setMetar(m);
    };
    let timer = 0;
    (async () => {
      const lib = await import("@/lib/metar");
      const raw = params.get("metar");
      if (raw) return take(lib.parseMetar(raw));
      if (params.get("fixture") === "1") return take(airport.code === "atl" ? lib.parseMetarResponse((await import("@/lib/__fixtures__/metar_atl.json")).default, airport.icao) : null);
      // The journey is a recording: no live weather with it, only what ?metar= asks for.
      if (params.get("fixture") === "journey") return take(null);
      // As the FAA status poll: one failed read keeps the last report; a second drops it.
      let failures = 0;
      const load = async () => {
        let body: Metar | null = null;
        try {
          const res = await fetch(`/api/weather/${airport.code}`);
          if (res.ok) body = (await res.json()) as Metar;
        } catch {
          // Counted below as a failed read.
        }
        if (body && typeof body.raw === "string") {
          failures = 0;
          take(body);
        } else if (++failures >= 2) {
          take(null);
        }
      };
      await load();
      if (!stopped) timer = window.setInterval(load, WEATHER_MS);
    })().catch((error: unknown) => console.error("atc: weather failed to load", error));
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [airport]);
  // /weather

  // The model, in the chosen theme, and the frame loop that draws the traffic on it.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !traffic) return;
    let stopped = false;
    let teardown = () => {};

    (async () => {
      const [{ AirportScene, DEFAULT_VIEW }, { placeTag, sceneLabels }] = await Promise.all([import("@/lib/scene/airport-scene"), import("@/lib/scene/labels")]);
      if (stopped) return;
      const { map, view, clock, replay, replayView } = traffic;
      const sceneTheme = THEMES[theme];
      const clockFormat = clockFormatFor(airport);
      const scene = new AirportScene(host, map, sceneTheme);
      sceneRef.current = scene;

      // Labels pinned to the model, as DOM so they stay crisp and in the page's typeface. A halo in the
      // page colour keeps them readable over the aircraft drawn under them.
      const labels: { label: SceneLabel; el: HTMLDivElement; width: number; height: number }[] = [];
      const labelLayer = labelsRef.current!;
      for (const label of sceneLabels(map, MODEL.heightScale)) {
        const el = document.createElement("div");
        el.textContent = label.text;
        el.className =
          label.kind === "concourse"
            ? "scene-label absolute left-0 top-0 text-[12.5px] font-semibold tracking-[0.08em] text-label will-change-transform"
            : "scene-label absolute left-0 top-0 text-[10.5px] font-semibold tracking-[0.06em] text-label-faint will-change-transform";
        labelLayer.appendChild(el);
        labels.push({ label, el, width: 0, height: 0 });
      }
      // Their sizes, for keeping the selected flight's tag off them; measured again once the fonts are in.
      const measure = () => {
        for (const item of labels) {
          item.width = item.el.offsetWidth;
          item.height = item.el.offsetHeight;
        }
      };
      measure();
      void document.fonts.ready.then(() => {
        if (!stopped) measure();
      });
      let tagSize = { width: 0, height: 0 };
      let tagSide = 0;
      /** Where the page's controls sit, measured with the chrome four times a second. */
      let controls: Rect[] = [];
      let bounds: Rect = { left: 0, top: 0, right: 0, bottom: 0 };

      const resize = () => {
        const width = host.clientWidth;
        const height = host.clientHeight;
        // The side column's actual left edge on a wide screen: the airport is framed, and the selected
        // flight's tag kept, left of it. On phones and tablets it is a band across the screen, not a column.
        const column = window.matchMedia(COLUMN_BESIDE).matches ? columnRef.current?.getBoundingClientRect() : undefined;
        const free = column && column.width > 0 ? column.left - host.getBoundingClientRect().left : width;
        const margin = column && !window.matchMedia(WIDE).matches ? SHORT_FIELD_MARGIN : FIELD_MARGIN;
        scene.resize(width, height, window.devicePixelRatio, {
          left: FIELD_MARGIN.x,
          top: margin.top,
          right: free - FIELD_MARGIN.x,
          bottom: height - margin.bottom,
        });
        bounds = { left: 8, top: 8, right: free - 8, bottom: height - 8 };
      };
      resize();
      scene.setView(viewRef.current);
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      let entries: TrafficEntry[] = entriesRef.current;
      /** The journey's flight as this diorama last drew it, for the card to keep while the feed has lost the aircraft. */
      let lastFollowed: TrafficEntry | null = null;
      // filters: how far each aircraft is faded out for them, and the predicted paths left once those are taken away.
      const ghosts = new Ghosts();
      const seen = seenRef.current;
      let lastGhost = 0;
      let pathsFrom: ScenePath[] | null = null;
      let pathsHidden = "";
      let pathsKept: ScenePath[] = NO_PATHS;
      const page = host.closest("main");
      let lastBackdrop = "";
      let lastSample = 0;
      let sampled: string | null = null;
      let lastChrome = 0;
      // path-pulse: what the map was last given of the selected flight's approach or climb-out, and which map.
      let mapPath: { path: unknown; globe: unknown } = { path: undefined, globe: undefined };
      let lastFrame = 0;
      let frameId = 0;
      /** Moves the camera and remembers where; null is the framed view. */
      const moveTo = (v: OrbitView | null) => {
        viewRef.current = v;
        scene.setView(v);
      };

      // globe
      /**
       * One camera between the map and the diorama. While the map leads, the diorama takes the map's view
       * and is drawn over it as the camera closes on the airport (the ground plan first, then the
       * buildings rising), until it covers the map and takes the lead, settling on the framed view. While
       * the diorama leads, the map is kept in step under it, ready for the zoom back out. Returns whether
       * the diorama is in view at all, so a frame with nothing of it showing is not drawn.
       */
      let lastFollow = 0;
      /** How much of the diorama covers the map this frame (1 while it leads), for the chrome's backdrop. */
      let shownNow = 1;
      /** How far out the haze is pushed this frame (a journey framing a field), 1 otherwise. */
      let hazeReach = 1;
      const handOver = (now: number): boolean => {
        const globe = globeRef.current;
        const stage = stageRef.current!;
        const mapLayer = mapRef.current!;
        if (!globe) return true;
        // A frame with no size (a hidden tab) has no camera to share with the map: nothing hands over until it has.
        if (!(host.clientHeight > 0)) return false;
        globe.setLens({ height: host.clientHeight, fovDeg: DEFAULT_VIEW.fovDeg });
        // The map centres where the diorama draws the point it looks at (off-centre, clear of the column).
        const at = scene.currentView;
        globe.setAnchor(scene.project(at.target[0], at.target[1], at.height));
        const band = bandOf(scene);
        const lead = leadRef.current;
        // journey
        const j = journeyRef.current;
        const journeying = j?.stage === "map";
        if (journeying) globe.drive(now, true);
        // /journey
        if (lead.by === "map") {
          if (lead.land) {
            // Picked from the picker or the search: this diorama has loaded, so the map comes down onto it.
            lead.land = false;
            globe.flyTo({ ...scene.homeView, distance: scene.bounds.maxDistance * 0.98 });
          }
          const v = globe.view;
          // Coming down on another built airport: switch to it, so its diorama is ready by the time the
          // camera reaches it. This one is not drawn again.
          const centre = globe.camera;
          const below = landingAirport({ lat: centre.lat, lng: centre.lng }, v.distance, AIRPORTS);
          // A followed flight's map comes down only on the flight's destination.
          if (below && below.code !== airport.code && (!journeying || below.code === j.destination?.code)) {
            actionsRef.current.onAirport(below.code, undefined, "landing");
            stage.style.opacity = "0";
            shownNow = 0;
            return false;
          }
          let shown = reveal(v.distance, band);
          if (shown < 0.98) lead.armed = true;
          globe.setGuide({ home: scene.homeView, band });
          // journey
          if (journeying) {
            const entry = entries.find((e) => e.aircraft.id === j.hex);
            if (entry) {
              const shot = j.shot(journeyFix(entry, airport));
              const field = shot.field === "origin" ? j.origin : (j.destination ?? j.origin);
              if (shot.aim > 0) hazeReach = fogReach(v, toLocal(airport, field.latitude, field.longitude));
            }
            // Until the destination's feed has the flight, the diorama stays half over the map, so the
            // aircraft stays drawn on the map meanwhile.
            if (!entry && airport.code === j.destination?.code) shown = Math.min(shown, 0.5);
            if (shown >= 1 && lead.armed && airport.code === j.destination?.code && entry) {
              // The destination's diorama covers the map with the flight in its feed: it follows the flight
              // from the camera the map had, aimed back up at the aircraft, so nothing moves.
              globe.setGuide(null);
              const shot = j.shot(journeyFix(entry, airport));
              const aimed = liftView(v, entry.scene.heightM * (1 - shot.aim));
              moveTo(aimed);
              goalRef.current = null;
              followRef.current = { id: j.hex, distance: aimed.distance, angle: { azimuthDeg: aimed.azimuthDeg, elevationDeg: aimed.elevationDeg } };
              pickedRef.current = j.hex;
              actionsRef.current.journeyLanded();
              actionsRef.current.setLead("scene");
              refreshRef.current = true;
              stage.style.opacity = "1";
              stage.style.maskImage = "";
              scene.setRise(1);
              globe.setReveal(1);
              shownNow = 1;
              return true;
            }
          }
          // /journey
          shownNow = shown;
          // The chrome turns to the map's once the map is most of what shows, and back as the diorama rises.
          if (journeying) actionsRef.current.showMap(shown < 0.5);
          if (shown >= 1 && lead.armed && !journeying) {
            // The diorama covers the map: it takes the lead and settles on the framed view (or on what was
            // picked in the search on the way down).
            globe.setGuide(null);
            followRef.current = null; // not the reader's: the diorama has taken the lead
            moveTo(v);
            goalRef.current = { to: "home", from: null, start: 0 };
            refreshRef.current = true;
            actionsRef.current.landed();
          } else {
            goalRef.current = null;
            followRef.current = null; // not the reader's: the map is leading the camera
            viewRef.current = v;
            scene.setView(v);
          }
          stage.style.opacity = String(shown);
          // The diorama comes up in an ellipse round the field, the map still in view around it.
          const field = scene.homeView.target;
          const pxPerM = host.clientHeight / (2 * v.distance * Math.tan((DEFAULT_VIEW.fovDeg * Math.PI) / 360));
          // A followed flight is not inside the airport's ellipse: its hands are a plain cross-fade, the
          // aircraft drawn on the map where the diorama draws it.
          stage.style.maskImage = shown < 1 && !journeying ? revealMask(scene.project(field[0], field[1], 0), scene.bounds.radius * pxPerM, Math.sin((v.elevationDeg * Math.PI) / 180), shown) : "";
          const rise = Math.max(0, (shown - RISE_FROM) / (1 - RISE_FROM));
          scene.setRise(rise);
          globe.setReveal(shown, rise);
          mapLayer.style.visibility = "visible";
          // While the two show at once on a journey, the map draws this frame's camera now, not on its
          // own next frame, so the map and the diorama never show the flight at two moments.
          if (journeying && shown > 0 && shown < 1) globe.map.redraw();
          return shown > 0;
        }
        shownNow = 1;
        stage.style.opacity = "";
        stage.style.maskImage = "";
        scene.setRise(1);
        globe.setReveal(1);
        if (now - lastFollow > MAP_FOLLOW_MS) {
          lastFollow = now;
          // Aimed at the ground along the diorama's line of sight, the only thing the map can look at.
          globe.follow(groundView(scene.currentView));
          mapLayer.style.visibility = "visible";
        }
        return true;
      };
      // /globe
      const tick = (now: number) => {
        frameId = requestAnimationFrame(tick);
        // React clears the refs when this airport's page goes (a landing on another airport) and runs this
        // effect's cleanup a little later: a frame in between has nothing to draw into.
        if (!stageRef.current || !tagRef.current || !leaderRef.current || !beaconRef.current) return;
        hazeReach = 1;
        const time = clock();
        // replay
        // Live, or the moment the replay is at: the history answers for any time since the page opened.
        const { picture, aircraft } = replay.frame(time, now / 1000);
        const frame = replay.views(view, replayView).frame(aircraft);
        // /replay
        entries = frame.entries;
        // journey: on a phone the shot keeps the aircraft clear of the card at the foot.
        if (journeyRef.current) journeyRef.current.compact = !window.matchMedia(COLUMN_BESIDE).matches;
        // journey: the flight as this diorama draws it is the journey's sighting while it is in this feed.
        const sighted = journeyRef.current && entries.find((e) => e.aircraft.id === journeyRef.current!.hex);
        journeyRef.current?.sight(sighted ? journeyFix(sighted, airport) : null, now);
        // The search reads what is drawn from here rather than working the frame out again.
        entriesRef.current = entries;
        // filters
        // An aircraft the filters leave out fades rather than goes; the one picked or followed stays, whatever they say.
        const filters = filtersRef.current;
        const filtering = filtersActive(filters);
        const ghostStep = Math.min(1, (now - lastGhost) / GHOST_MS);
        lastGhost = now;
        const kept: TrafficEntry[] = [];
        const hidden: string[] = [];
        for (const e of entries) {
          const id = e.aircraft.id;
          const out = filtering && id !== pickedRef.current && id !== followRef.current?.id && id !== journeyRef.current?.hex && !matches(filters, subjectOfEntry(e));
          const ghost = ghosts.track(id, out, ghostStep);
          if (ghost > 0) e.scene.ghost = ghost;
          if (ghost >= GHOSTED) hidden.push(id);
          if (!out) kept.push(e);
        }
        ghosts.sweep();
        const counts = filtering ? countTraffic(kept.map((e) => ({ onGround: e.aircraft.onGround, situation: e.situation }))) : frame.counts;
        const featured = filtering ? (pickFeatured(kept.map((e) => ({ x: e.aircraft.x, y: e.aircraft.y, situation: e.situation, entry: e })))?.entry ?? null) : frame.featured;
        // /filters
        // Easing goes by elapsed time, so a slow frame does not slow the camera.
        const k = 1 - (1 - EASE) ** Math.min(4, lastFrame ? (now - lastFrame) / (1000 / 60) : 1);
        lastFrame = now;
        let followed = followRef.current;
        const rig = rigRef.current;
        // journey: only the reader's own acts end a journey (clearFollow, where the reader clears the follow). A follow found cleared with the
        // journey running was cleared by something else (a scene rebuilt for a theme, a Viewer remounted by a hand, a frame with no fix): it goes
        // back on the journey's flight once the flight is drawn here.
        const journeying = journeyRef.current;
        if (journeying) {
          // Where the flight is, as this diorama draws it, else as the journey last had it (its own reads, then where it stood on the ground).
          const drawnEntry = entries.find((e) => e.aircraft.id === journeying.hex);
          const at = drawnEntry ? journeyFix(drawnEntry, airport) : journeying.fix();
          const frame = journeyFrame({ journey: { hex: journeying.hex, stage: journeying.stage, lostMs: journeying.lostFor() }, followedId: followed?.id ?? null, drawn: !!drawnEntry, onGround: !!at?.onGround, cameraActive: rig.active, mapLeads: leadRef.current.by === "map" });
          if (frame.restore) {
            followed = followRef.current = { id: journeying.hex, distance: Math.min(scene.currentView.distance, FOLLOW_DISTANCE), angle: null };
            refreshRef.current = true;
          }
          // A flight lost from every feed: held where it was last seen, camera and card, for the hold; then, on the ground, waited for at its
          // origin and arrived at its destination, and in the air let go. Judged whether or not the camera follows it (journeyFrame).
          if (frame.lost === "arrive") journeying.arrive(null, true);
          else if (frame.lost === "release") {
            followRef.current = null; // not the reader's: the journey ends because the flight is gone, which stopJourney says
            refreshRef.current = true;
            actionsRef.current.stopJourney();
          } else if (journeying.stage === "destination" && at) {
            // Read standing at a gate or stand, the journey ends there; or the flight went quiet by one (its transponder switched off on the stand).
            if (drawnEntry && drawnEntry.aircraft.onGround && (drawnEntry.aircraft.groundSpeedKt ?? 0) < 1 && drawnEntry.situation.state === "parked") journeying.arrive(drawnEntry.situation.place ?? null, false);
            else {
              const [x, y] = toLocal(airport, at.latitude, at.longitude);
              const recent = journeying.recentGround().map((f) => {
                const [fx, fy] = toLocal(airport, f.latitude, f.longitude);
                return { x: fx, y: fy };
              });
              const quiet = quietArrival({ onGround: at.onGround, groundSpeedKt: at.groundSpeedKt, x, y, headingDeg: at.headingDeg }, journeying.silentFor(), map, recent);
              if (quiet) journeying.arrive(quiet.place, true);
            }
          }
        }
        // journey: a journey's flight is the card's from the journey's first frame, in whichever diorama shows it (see selectedOf).
        const owner = journeyRef.current;
        if (owner) pickedRef.current = owner.hex;
        const drawnNow = owner && entries.find((e) => e.aircraft.id === owner.hex);
        if (drawnNow) lastFollowed = drawnNow;
        else if (!owner || lastFollowed?.aircraft.id !== owner.hex) lastFollowed = null;
        const found = selectedOf({ entries, picked: pickedRef.current, featured, journey: owner, held: lastFollowed });
        // A flight that went quiet by its stand is shown parked there, whatever its last listing said.
        const arrived = owner?.arrived();
        const selected = found && arrived?.quiet && found.aircraft.id === owner!.hex ? { ...found, card: arrivedCard(found.card, arrived) } : found;
        // /journey
        if (rig.active) {
          // cameras
          // A mode's view of the selected flight, eased into and out of; the orbit's view waits in viewRef.
          const picked = selected;
          const aspect = host.clientWidth / Math.max(1, host.clientHeight);
          // Looked around as the reader has, within the mode's limits, which the rig keeps from here.
          // An arrival not yet lined up has the runway its predicted path makes for, so the cameras can keep it in frame.
          const pickedRunway = picked && (picked.situation.runway ?? (picked.situation.state === "arriving" ? (opsRef.current?.pathOf(picked.aircraft.id)?.runway ?? null) : null));
          const shot = modeShot(rig.mode, map, picked && { scene: picked.scene, runway: pickedRunway, state: picked.situation.state }, scene.homeView.target, aspect, rig.look, scene.bounds);
          if (shot) rig.look = shot.look;
          const goal = shot?.view ?? null;
          if (rig.mode !== "orbit" && !goal) {
            // Nothing left to look at (the flight left the feed, or stopped arriving): back to the orbit.
            rig.set("orbit");
            refreshRef.current = true;
          }
          const v = rig.frame(now, scene.currentView, goal ?? viewRef.current ?? scene.homeView, picked?.aircraft.id ?? null);
          scene.setView(v ?? viewRef.current);
          // The map's labels sit at the drawn buildings' heights, which come down to true height close up.
          labelLayer.style.opacity = String(1 - (scene.currentView.eyeLevel ?? 0));
          // /cameras
        } else if (followed) {
          const target = entries.find((e) => e.aircraft.id === followed.id);
          // journey
          // A journey's flight is followed through a gap in this airport's feed (adsb.lol answers 429 and
          // times out under load) on the journey's own reads of it: only with neither for a while is it let go.
          const j = journeyRef.current?.hex === followed.id && journeyRef.current.stage !== "map" ? journeyRef.current : null;
          const fix = target ? journeyFix(target, airport) : (j?.fix() ?? null);
          // /journey
          if (!fix && !j) {
            // Gone from the feed (out of range, or landed and switched off): let go of it. A journey's own flight is never here (j holds it through the gap).
            followRef.current = null;
            refreshRef.current = true;
          } else if (fix && followRef.current === followed) {
            const from = scene.currentView;
            const [px, py] = target ? [target.scene.x, target.scene.y] : toLocal(airport, fix.latitude, fix.longitude);
            let to: Point = [px, py];
            let height = target ? target.scene.heightM : j!.heightOf(fix);
            // journey
            if (j) {
              // The journey's shot of the flight: how far back, which way, and aimed part of the way toward
              // the airport it is leaving or coming to, so both are in the frame.
              const shot = j.shot(fix);
              if (j.setsDistance(fix)) followed.distance = shot.distance;
              const look = j.look(shot, now, from);
              if (look) followed.angle = look;
              const field = shot.field === "origin" ? j.origin : (j.destination ?? j.origin);
              const [fx, fy] = toLocal(airport, field.latitude, field.longitude);
              to = [to[0] + (fx - to[0]) * shot.aim, to[1] + (fy - to[1]) * shot.aim];
              height *= 1 - shot.aim;
              // The camera sits on the shot, plus whatever separated them when it took the flight, dying
              // away at the ease's own pace: an ease toward a moving aircraft trails it, and the map, which
              // carries on from this camera at the hand, would then glide to where the aim should be.
              const s = (followed.settle ??= [from.target[0] - to[0], from.target[1] - to[1], from.height - height]);
              s[0] *= 1 - k;
              s[1] *= 1 - k;
              s[2] *= 1 - k;
              const eased = ease(from, { ...from, ...followed.angle, distance: followed.distance }, k);
              moveTo({ ...eased, target: [to[0] + s[0], to[1] + s[1]], height: height + s[2] });
              // The haze is pushed out past the field the shot frames, so it reads rather than fading into the page.
              if (shot.aim > 0) hazeReach = fogReach(scene.currentView, [fx, fy]);
              // Climbed out past the farthest the diorama goes: the map takes the camera.
              if (j.stage === "origin" && !fix.onGround && scene.currentView.distance >= scene.bounds.maxDistance) actionsRef.current.journeyOut(now);
            } else {
              moveTo(ease(from, { ...from, ...followed.angle, target: to, height, distance: followed.distance }, k));
            }
            // /journey
          }
        } else if (goalRef.current) {
          const move = goalRef.current;
          if (!move.from) {
            move.from = scene.currentView;
            move.start = now;
          }
          const to = move.to === "home" ? scene.homeView : move.to;
          const t = Math.min(1, (now - move.start) / MOVE_MS);
          if (t >= 1) {
            moveTo(move.to === "home" ? null : to);
            goalRef.current = null;
            refreshRef.current = true;
          } else {
            moveTo(ease(move.from, to, 1 - (1 - t) ** 3));
          }
        }
        const drawn = handOver(now); // globe
        scene.setFogReach(hazeReach);
        applyWeather(weatherRef.current, scene, sceneTheme, picture, airport); // weather, lit for the moment drawn
        scene.setAircraft(
          entries.map((e) => e.scene),
          time,
        );
        // replay
        // At 30x and up, each aircraft's last few minutes as a fading light trail.
        scene.setLightTrails(replay.trails(picture, frame.entries.map((e) => e.scene)));
        // /replay
        if (drawn) scene.render();
        // The header's fade and the labels' halo take the colour the frame draws under them (the ground lit
        // by the hour and the weather, the fog, the sky), mixed with the map's page colour as far as the
        // map still shows. Read back a few times a second, straight after the frame is drawn, without waiting on the GPU.
        if (drawn && now - lastSample > CHROME_MS) {
          lastSample = now;
          sampled = scene.topColour(SCRIM_ROW_PX) ?? sampled;
        }
        const backdrop = backdropOver(sceneTheme.background, sampled ?? sceneTheme.background, shownNow);
        if (backdrop !== lastBackdrop) {
          lastBackdrop = backdrop;
          page?.style.setProperty("--scene-clear", backdrop);
        }

        const obstacles: Rect[] = [];
        for (const { label, el, width, height } of labels) {
          const p = scene.project(label.x, label.y, label.h);
          el.style.visibility = p.visible ? "visible" : "hidden";
          el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -100%)`;
          if (p.visible) obstacles.push({ left: p.x - width / 2, top: p.y - height, right: p.x + width / 2, bottom: p.y });
        }
        obstacles.push(...controls);

        // path-pulse
        const pulse = opsRef.current;
        // The pulse and board keep to the live picture; a replay shows the traffic as it was, without
        // the paths predicted for it now.
        if (pulse) {
          // The wind settles which way the airport lands when no arrival has shown it yet.
          pulse.setWind(weatherRef.current.metar?.wind ?? null);
          const paths = replay.isLive ? pulse.update(entries, time - PLAYBACK_DELAY, selected?.aircraft.id ?? null) : NO_PATHS;
          // filters: no path is drawn for an aircraft faded out; the filtered list is made again only when the paths or the faded set change.
          const hiddenKey = hidden.join(",");
          if (hiddenKey && paths !== NO_PATHS) {
            if (paths !== pathsFrom || hiddenKey !== pathsHidden) {
              pathsFrom = paths;
              pathsHidden = hiddenKey;
              pathsKept = paths.filter((p) => !hidden.includes(p.id));
            }
          }
          scene.setPaths(hiddenKey && paths !== NO_PATHS ? pathsKept : paths, selected?.aircraft.id ?? null);
          // The map draws the same approach or climb-out at region zoom; sent again only when it changes.
          const path = selected && replay.isLive ? pulse.pathOf(selected.aircraft.id) : null;
          const globe = globeRef.current;
          if (globe && (path !== mapPath.path || globe !== mapPath.globe)) {
            mapPath = { path, globe };
            globe.setProcedure(path, airport, selected?.aircraft.id ?? null);
          }
        }
        // /path-pulse
        const tag = tagRef.current!;
        const leader = leaderRef.current!;
        if (selected) {
          const p = scene.project(selected.scene.x, selected.scene.y, selected.scene.heightM);
          // Clear of the concourse letters and runway designators, so the tag never hides them.
          const placed = placeTag(p, tagSize, obstacles, bounds, tagSide);
          tagSide = placed.side;
          tag.style.visibility = leader.style.visibility = p.visible ? "visible" : "hidden";
          tag.style.transform = `translate(${placed.box.left}px, ${placed.box.top}px)`;
          leader.setAttribute("x1", String(p.x));
          leader.setAttribute("y1", String(p.y));
          leader.setAttribute("x2", String(placed.leader.x));
          leader.setAttribute("y2", String(placed.leader.y));
        } else {
          tag.style.visibility = leader.style.visibility = "hidden";
        }
        // journey: the followed flight's beacon, the map's own mark drawn over the diorama wherever the
        // model is too small to read, so the subject reads at every distance and the mark carries
        // straight across a hand (the stage fades it out as the map's fades in, in the same place).
        const beacon = beaconRef.current!;
        const followedHex = journeyRef.current?.hex;
        const subject = followedHex && drawn ? entries.find((e) => e.aircraft.id === followedHex) : undefined;
        if (subject) {
          const s = subject.scene;
          const at = scene.project(s.x, s.y, s.heightM);
          const h = (s.headingDeg * Math.PI) / 180;
          const nose = scene.project(s.x + Math.sin(h) * SUBJECT_LENGTH_M, s.y + Math.cos(h) * SUBJECT_LENGTH_M, s.heightM);
          const lengthPx = Math.hypot(nose.x - at.x, nose.y - at.y);
          const show = at.visible ? Math.max(0, Math.min(1, (BEACON_UNTIL_PX - lengthPx) / BEACON_FADE_PX)) : 0;
          beacon.style.visibility = show > 0 ? "visible" : "hidden";
          if (show > 0) {
            const v = scene.currentView;
            const zoom = orbitToMap(groundView(v), airport, { height: host.clientHeight, fovDeg: v.fovDeg ?? DEFAULT_VIEW.fovDeg }).zoom;
            const iconPx = GLYPH_PX * journeyIconSize(zoom);
            const glyph = beacon.lastElementChild as SVGElement;
            glyph.style.width = glyph.style.height = `${iconPx}px`;
            glyph.style.transform = `translate(-50%, -50%) rotate(${s.headingDeg - v.azimuthDeg}deg)`;
            // Lying on the ground as the map's does: its circle and icon are drawn in the map's plane.
            beacon.style.opacity = String(show);
            beacon.style.transform = `translate(${at.x}px, ${at.y}px) scaleY(${Math.sin((v.elevationDeg * Math.PI) / 180)})`;
          }
        } else {
          beacon.style.visibility = "hidden";
        }

        if (refreshRef.current || now - lastChrome > CHROME_MS) {
          lastChrome = now;
          refreshRef.current = false;
          // filters: what is last seen of each aircraft, for the board and for the lists the filters offer.
          const subjects = entries.map((e) => snapshotSubject(subjectOfEntry(e)));
          rememberSeen(seen, entries.map((e, i) => ({ id: e.aircraft.id, subject: subjects[i] })), SEEN_MAX);
          // The tag's words change with the card's, so the two never disagree.
          tag.children[0].textContent = selected?.card.callsign ?? "";
          tag.children[1].textContent = selected?.card.tag ?? "";
          tagSize = { width: tag.offsetWidth, height: tag.offsetHeight };
          // The page's controls and panels, which the tag keeps clear of as it does the labels.
          const origin = host.getBoundingClientRect();
          controls = [...(host.closest("main")?.querySelectorAll("button, select, input, section, [data-weather]") ?? [])]
            .map((el) => el.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.height > 0)
            .map((r) => ({ left: r.left - origin.left, top: r.top - origin.top, right: r.right - origin.left, bottom: r.bottom - origin.top }));
          if (selected) leader.style.stroke = `var(--color-${selected.card.state})`;
          const next: ChromeState = {
            counts,
            total: entries.length,
            options: filterOptions(leadRef.current.by === "map" ? (globeRef.current?.subjectsInView ?? []) : subjects, filters),
            card: selected?.card ?? null,
            // path-pulse: the published procedure the selected flight's path follows, cited on its card
            procedure: selected && pulse && replay.isLive ? pulse.citationOf(selected.aircraft.id) : null,
            movements: activeMovements(kept, selected?.aircraft.id ?? null, MOVEMENT_ROWS),
            // weather: the drawn time; replay: the moment the picture is of
            clock: clockFormat.format(new Date(drawnTime(weatherRef.current, picture, airport))),
            // A journey is followed even while the map has the camera.
            following: followRef.current !== null || (!!selected && journeyRef.current?.hex === selected.aircraft.id),
            moved: viewRef.current !== null || goalRef.current !== null || rig.active,
            camera: rig.mode,
            cameras: cameraModes(map, selected && { runway: selected.situation.runway, state: selected.situation.state }),
            // replay
            replay: replayStatus(replay, time, clockFormat),
            // /replay
            inView: leadRef.current.by === "map" ? (globeRef.current?.aircraftInView ?? null) : null,
          };
          setChrome((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
          // path-pulse
          if (pulse) {
            const view = pulse.view(time - PLAYBACK_DELAY);
            // filters: the board lists the flights that pass, by what was last seen of each (it keeps those already gone from the feed).
            const shown = filtering ? { ...view, board: view.board.filter((f) => matches(filters, seen.get(f.id) ?? { callsign: f.callsign })) } : view;
            setOps((prev) => (JSON.stringify(prev) === JSON.stringify(shown) ? prev : shown));
          }
          // /path-pulse
        }
      };
      frameId = requestAnimationFrame(tick);

      // Gestures. A click picks the aircraft under it (empty ground goes back to the featured flight).
      // A drag slides the ground under the pointer; a right-drag, or a drag with a modifier key, turns
      // and tilts; the wheel zooms about the pointer. Two fingers pinch to zoom, twist to turn and move
      // up or down together to tilt. Sliding lets go of a followed flight; turning and zooming keep it.
      const pointers = new Map<number, { x: number; y: number }>();
      let dragged = 0;
      let turning = false;
      const local = (e: { clientX: number; clientY: number }) => {
        const rect = host.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
      };
      const userMove = (v: OrbitView) => {
        goalRef.current = null;
        // A drag or pinch turns the view itself; a button's bearing would turn it back.
        if (followRef.current) followRef.current.angle = null;
        moveTo(v);
        refreshRef.current = true;
      };
      /** Zooms by `factor`, keeping the ground under (x, y) in place; about the aircraft while following. */
      const zoomAt = (factor: number, x: number, y: number) => {
        // globe
        // A pinch that carried on past the hand back moves the map from here on; zooming out (wheel or
        // pinch) past the farthest the diorama goes hands over to the world map.
        const { mapLeading, outToMap, toMap } = actionsRef.current;
        const globe = mapLeading();
        if (globe) {
          globe.zoomNow(factor);
          return;
        }
        if (outToMap(factor)) {
          toMap();
          return;
        }
        // /globe
        const from = scene.currentView;
        if (followRef.current) {
          const v = zoom(from, factor, scene.bounds);
          followRef.current.distance = v.distance;
          userMove(v);
          return;
        }
        const before = scene.groundAt(x, y);
        scene.setView(zoom(from, factor, scene.bounds));
        const after = scene.groundAt(x, y);
        const v = scene.currentView;
        userMove(before && after ? pan(v, before[0] - after[0], before[1] - after[1], scene.bounds) : v);
      };
      const slide = (from: { x: number; y: number }, to: { x: number; y: number }) => {
        const a = scene.groundAt(from.x, from.y);
        const b = scene.groundAt(to.x, to.y);
        if (!a || !b) return;
        actionsRef.current.clearFollow({ kind: "slide" }); // journey: sliding lets go of its flight
        userMove(pan(scene.currentView, a[0] - b[0], a[1] - b[1], scene.bounds));
      };
      const onDown = (e: PointerEvent) => {
        host.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, local(e));
        if (pointers.size === 1) {
          dragged = 0;
          turning = e.button === 2 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey;
        }
      };
      const onMove = (e: PointerEvent) => {
        const prev = pointers.get(e.pointerId);
        if (!prev) return;
        const cur = local(e);
        // cameras
        // In a mode a drag looks around in it (round the aircraft, or from the tower cab) and a pinch
        // also moves in or out; a click still picks. Easing back to the orbit, a drag waits for it.
        const rig = rigRef.current;
        if (rig.active) {
          if (pointers.size === 2) {
            const other = [...pointers].find(([id]) => id !== e.pointerId)![1];
            const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
            const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
            const twist = Math.atan2(cur.y - other.y, cur.x - other.x) - Math.atan2(prev.y - other.y, prev.x - other.x);
            dragged = Infinity;
            // Each finger moves on its own event, so each tilts by half its rise.
            rig.lookBy({ bearingDeg: (-twist * 180) / Math.PI, pitchDeg: lookDrag(rig.mode, 0, (cur.y - prev.y) / 2).pitchDeg, zoom: d0 > 0 && d1 > 0 ? d0 / d1 : 1 });
          } else {
            dragged += Math.hypot(cur.x - prev.x, cur.y - prev.y);
            if (dragged > CLICK_PX) rig.lookBy(lookDrag(rig.mode, cur.x - prev.x, cur.y - prev.y));
          }
          refreshRef.current = true;
          pointers.set(e.pointerId, cur);
          return;
        }
        // /cameras
        if (pointers.size === 2) {
          const other = [...pointers].find(([id]) => id !== e.pointerId)![1];
          const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
          const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
          const twist = Math.atan2(cur.y - other.y, cur.x - other.x) - Math.atan2(prev.y - other.y, prev.x - other.x);
          dragged = Infinity;
          if (d0 > 0 && d1 > 0) zoomAt(d0 / d1, (cur.x + other.x) / 2, (cur.y + other.y) / 2);
          // Each finger moves on its own event, so each tilts by half its rise.
          userMove(turn(orbit(scene.currentView, 0, (cur.y - prev.y) / 2), (-twist * 180) / Math.PI));
        } else {
          dragged += Math.hypot(cur.x - prev.x, cur.y - prev.y);
          if (dragged > CLICK_PX) {
            if (turning) userMove(orbit(scene.currentView, cur.x - prev.x, cur.y - prev.y));
            else slide(prev, cur);
          }
        }
        pointers.set(e.pointerId, cur);
      };
      const onUp = (e: PointerEvent) => {
        if (!pointers.delete(e.pointerId)) return;
        if (pointers.size > 0 || dragged > CLICK_PX) return;
        const { x, y } = local(e);
        let best: string | null = null;
        let bestD = PICK_RADIUS;
        for (const entry of entries) {
          const p = scene.project(entry.scene.x, entry.scene.y, entry.scene.heightM);
          const d = Math.hypot(p.x - x, p.y - y);
          if (p.visible && d < bestD && (entry.scene.ghost ?? 0) < GHOSTED) {
            best = entry.aircraft.id;
            bestD = d;
          }
        }
        pickedRef.current = best;
        // journey: a pick of another flight, or of empty ground, lets go of it; a click on the flight itself keeps it.
        actionsRef.current.clearFollow({ kind: "pick", id: best }, best);
        refreshRef.current = true;
      };
      const onCancel = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        dragged = Infinity;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1;
        const factor = Math.exp(Math.max(-60, Math.min(60, e.deltaY * unit)) * 0.004);
        // cameras: in a mode the wheel sets its distance (the tower's lens) within the mode's range.
        if (rigRef.current.active) {
          rigRef.current.lookBy({ bearingDeg: 0, pitchDeg: 0, zoom: factor });
          refreshRef.current = true;
          return;
        }
        // /cameras
        const { x, y } = local(e);
        zoomAt(factor, x, y);
      };
      const onMenu = (e: Event) => e.preventDefault();
      host.addEventListener("pointerdown", onDown);
      host.addEventListener("pointermove", onMove);
      host.addEventListener("pointerup", onUp);
      host.addEventListener("pointercancel", onCancel);
      host.addEventListener("wheel", onWheel, { passive: false });
      host.addEventListener("contextmenu", onMenu);

      setStatus("ready");
      teardown = () => {
        cancelAnimationFrame(frameId);
        observer.disconnect();
        host.removeEventListener("pointerdown", onDown);
        host.removeEventListener("pointermove", onMove);
        host.removeEventListener("pointerup", onUp);
        host.removeEventListener("pointercancel", onCancel);
        host.removeEventListener("wheel", onWheel);
        host.removeEventListener("contextmenu", onMenu);
        if (sceneRef.current === scene) sceneRef.current = null;
        for (const { el } of labels) el.remove();
        scene.dispose();
      };
      if (stopped) teardown();
    })().catch((error: unknown) => {
      console.error("atc: scene failed to start", error);
      if (!stopped) setStatus("failed");
    });

    return () => {
      stopped = true;
      teardown();
    };
  }, [traffic, theme, airport, globeRef, leadRef, mapRef, journeyRef]);

  /** What only means something in the diorama is hidden while the map leads, but keeps its place, so the field is framed beside the column on the way back down. */
  const dioramaOnly = onMap ? "invisible" : undefined;
  // journey: the followed flight's panel, in its card in a diorama and in a card of its own on the map.
  const journeyPanel = journey ? journeyView(journey) : null;
  const readout = useTrafficReadout(heard, chrome.counts?.tracked ?? 0);
  // The DOM follows what is seen, so the keyboard goes where the eye does: on a phone the view buttons are above the tabs and the flight card below
  // them, on a wide screen the card is above the tabs and the column is read before the buttons at its foot. Keyed, so a window resized across
  // the breakpoint moves the controls rather than rebuilding them.
  const wide = useMedia(WIDE);
  const stacked = useMedia(STACKED);
  const flightCard = <FlightCard key="card" card={chrome.card} procedure={chrome.procedure} here={airport.code} status={nas} following={chrome.following} onFollow={follow} journey={chrome.card && journey?.hex === chrome.card.id ? journeyPanel : null} />;
  const trafficTabs = <ColumnPanel key="tabs" movements={chrome.movements} ops={ops} filtered={filtersActive(filters)} readout={readout} onSelect={selectFlight} />;
  const dioramaColumn = (
    <div key="diorama-column" className={dioramaOnly}>
      <SideColumn ref={columnRef}>{wide ? [flightCard, trafficTabs] : [trafficTabs, flightCard]}</SideColumn>
    </div>
  );
  // On the map a journey's card stands where the column's would on a wide screen; stacked, under the
  // search, so the map's foot (its controls and its credit line) stays clear. A flight selected on the map has the
  // diorama's card, in the column's place; a followed one has its journey card instead.
  const mapCards = [
    onMap && mapFlight && !journeyPanel && (
      <SideColumn key="map-card" ref={mapCardRef}>
        <FlightCard
          card={mapFlightCard(mapFlight)}
          phase={mapFlight.lostAt !== null ? "Lost" : flightPhase({ onGround: mapFlight.onGround, groundSpeedKt: mapFlight.speedKt, verticalRateFpm: mapFlight.verticalRateFpm })}
          note={lostNote(mapFlight, clockFormatFor(airport)) ?? (mapFlight.estimated ? ESTIMATES_NOTE : null)}
          unavailable={mapFlight.lostAt !== null}
          here={airport.code}
          status={undefined}
          following={journey?.hex === mapFlight.id}
          onFollow={followMapFlight}
        />
      </SideColumn>
    ),
    onMap && journeyPanel && (
      <div key="journey-card" ref={journeyCardRef} className="pointer-events-none absolute inset-x-4 top-[132px] flex flex-col xl:left-auto xl:right-8 xl:top-[104px] xl:w-[300px]">
        <JourneyCard journey={journeyPanel} onStop={world.stopJourney} />
      </div>
    ),
  ];
  // The map style's copy for the stacked layout: under the counts on the diorama, and on the map above the view buttons at its foot.
  const phoneTheme = <ThemeSwitch key="phone-theme" theme={theme} onChange={onTheme} className="xl:hidden" />;
  const viewControls = (
    <ViewControls
      key="view-controls"
      moved={chrome.moved || onMap}
      onTurn={turnBy}
      onZoom={zoomBy}
      onReset={resetView}
      // cameras: the diorama's only, so not offered on the map
      before={!onMap && <CameraMenu camera={chrome.camera} available={chrome.cameras} onChange={chooseCamera} />}
    >
      {!onMap && <CameraSwitch camera={chrome.camera} available={chrome.cameras} onChange={chooseCamera} />}
    </ViewControls>
  );
  return (
    <>
      {/* The frame loop owns the stage's opacity (handOver): React never writes it, so a lead changing
          hands mid-fade cannot blank it for a frame. A stage made while the map leads starts hidden. */}
      <div
        ref={(el) => {
          stageRef.current = el;
          if (!el || el.dataset.made) return;
          el.dataset.made = "1";
          if (leadRef.current.by === "map") el.style.opacity = "0";
        }}
        className="absolute inset-0"
        style={onMap ? { pointerEvents: "none" } : undefined}
      >
        <div
          ref={hostRef}
          tabIndex={0}
          role="application"
          aria-label={`3D model of ${airport.name} with live aircraft`}
          aria-describedby="atc-keys"
          onKeyDown={onKeyDown}
          className="absolute inset-0 touch-none outline-hidden focus-visible:outline-3 focus-visible:outline-solid focus-visible:-outline-offset-4 focus-visible:outline-ink"
        />
        <p id="atc-keys" className="sr-only">
          Arrow keys slide the map, plus and minus zoom, Q and E turn, shift with the up and down arrows tilts. In the Tower, Drone and
          Approach views, drags and these keys look around without leaving the view; Escape or Reset view returns to Orbit.
        </p>
        <div ref={labelsRef} aria-hidden className="pointer-events-none absolute inset-0 select-none overflow-clip" />
        <svg aria-hidden className="pointer-events-none absolute inset-0 size-full overflow-visible">
          <line ref={leaderRef} strokeWidth="1.2" style={{ visibility: "hidden" }} />
        </svg>
        <div ref={beaconRef} aria-hidden className="pointer-events-none absolute left-0 top-0 size-0 will-change-transform" style={{ visibility: "hidden" }}>
          <div
            className="absolute rounded-full"
            style={{
              left: -BEACON_RADIUS_PX,
              top: -BEACON_RADIUS_PX,
              width: 2 * BEACON_RADIUS_PX,
              height: 2 * BEACON_RADIUS_PX,
              background: `${PALETTES[theme].dot}1f`,
              boxShadow: `inset 0 0 0 1.5px ${PALETTES[theme].dot}8c`,
            }}
          />
          <svg className="absolute left-0 top-0 overflow-visible" viewBox={`${-GLYPH_BOX / 2} ${-GLYPH_BOX / 2} ${GLYPH_BOX} ${GLYPH_BOX}`}>
            <path d={AIRCRAFT_GLYPH} fill={PALETTES[theme].dot} stroke={PALETTES[theme].halo} strokeWidth={3} paintOrder="stroke" vectorEffect="non-scaling-stroke" />
          </svg>
        </div>
        <div
          ref={tagRef}
          aria-hidden
          style={{ visibility: "hidden" }}
          className="pointer-events-none absolute left-0 top-0 flex flex-col rounded-md bg-surface px-2 py-1 shadow-[0_0_0_1px_var(--color-hairline)] will-change-transform"
        >
          <span className="text-[11px] font-bold leading-tight text-ink" />
          <span className="text-[9.5px] leading-tight text-label" />
        </div>
      </div>

      {!hasWebGL2 && (
        <p className="absolute inset-x-6 top-1/2 mx-auto max-w-md -translate-y-1/2 rounded-2xl bg-surface p-6 text-center text-[15px] leading-relaxed text-ink-2 shadow-[0_0_0_1px_var(--color-hairline)]">
          The 3D airport needs WebGL 2, which this browser does not offer. Try a current version of Chrome, Edge, Firefox or Safari.
        </p>
      )}
      {status === "failed" && (
        <p className="absolute inset-x-6 top-1/2 mx-auto max-w-md -translate-y-1/2 rounded-2xl bg-surface p-6 text-center text-[15px] leading-relaxed text-ink-2 shadow-[0_0_0_1px_var(--color-hairline)]">
          The 3D airport could not start. Reload the page to try again.
        </p>
      )}

      {/* In the order they are seen, so the keyboard goes where the eye does: the map style comes
          under the counts on phones and last, at the bottom right, on wide screens. */}
      <Header airport={airport} onAirport={pickAirport} focusPicker={focusPicker} onMap={onMap} inView={chrome.inView} alerts={<AlertsMenu alerts={alerts} />} />
      <Search {...searchProps} />
      <FilterControl filters={filters} options={chrome.options} readout={onMap ? chrome.inView : readout === "ready" && chrome.counts && chrome.total !== null ? { shown: chrome.counts.tracked, total: chrome.total } : null} onChange={onFilters} />
      {/* The counts, the wind, the legend and the camera modes are this airport's diorama's; on the map they go. */}
      {!onMap && <Counts counts={chrome.counts} total={chrome.total} note={traffic?.notice ?? null} readout={readout} />}
      {!onMap && <WeatherReadout metar={metar} />}
      {onMap && <RadarToggle radar={radar} />}
      {stacked ? [...mapCards, phoneTheme, viewControls, dioramaColumn] : [phoneTheme, dioramaColumn, ...mapCards, viewControls]}
      {!onMap && <Legend />}
      <TimeBar clock={chrome.clock} replay={chrome.replay} onLive={replayLive} onRate={replayRate} onSeek={replaySeek} liveOnly={onMap} share={<ShareControl getLink={shareThisView} replaying={!onMap && !!chrome.replay && !chrome.replay.live} />} />
      <ThemeSwitch theme={theme} onChange={onTheme} className="max-xl:hidden" />
      <DataCredit />
    </>
  );
}
