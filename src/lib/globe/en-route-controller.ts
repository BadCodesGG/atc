import type { JumpToOptions, Map as MapLibreMap } from "maplibre-gl";
import { classify } from "../aircraft-class";
import { type Origin, toGeo, toLocal } from "../geo";
import type { JourneyFix } from "../journey-follow";
import type { OrbitView } from "../scene/orbit";
import type { ThemeKey } from "../scene/theme";
import { groundView, type Lens, type MapCamera, mapToOrbit, MAX_PITCH, orbitToMap } from "./camera";
import { bandPadding, blendPadding, EN_ROUTE_MAX_PITCH, type EnRouteCamera, EnRoutePeek, type EnRoutePlacement, enRoutePose, EnRouteRig, enRouteShot, eyeOf, fitDistance, type Insets, is3D, peekPlacement, sightPlacement } from "./en-route";
import { blendPlacement, FALLBACK_NOTICE, type FallbackCause, FrameWatch, RETURN_TO_MAP_S, shareBlend, ShareEase } from "./en-route-journey";
import type { EnRouteLayer } from "./en-route-layer";
import type { Rect } from "./journey-frame";
import { enRouteHaze, enRouteSky, flatSky, hazeStrength, horizonM, IMAGERY, type ImageryReach, imageryTileZoom, MAPLIBRE_LOD, mapBackground, HILLSHADE, HILLSHADE_UNDER, hillshadeLayer, PALETTES, TERRAIN, TERRAIN_SOURCE, terrainSource } from "./map-style";

/**
 * One of MapLibre's Mercator units (the world is 1 across) in metres at the equator: its own Earth's
 * circumference (maplibre-gl's earthRadius, 6,371,008.8 m), which its tile distances are measured on; not
 * camera.ts's WGS84 equator nor the haze's round-number radius.
 */
const MERCATOR_UNIT_M = 2 * Math.PI * 6_371_008.8;

/** What the En-route view needs of the World map that holds it (globe-map.ts). */
export interface EnRouteHost {
  readonly map: MapLibreMap;
  /** The map's element: its height is the lens's. */
  readonly container: HTMLElement;
  /** The airport the map hands over to: the metres the Handover reads the journey's shot in. */
  airport(): Origin;
  theme(): ThemeKey;
  /** Moves the map's camera as the page's own move: not the reader's, and not guided by the Handover. */
  place(camera: JumpToOptions): void;
  /** On a phone or tablet, the free band between the Journey card and the controls at the map's foot (the map's own pixels); null on a wide screen. */
  band(): Rect | null;
  /** The map's own padding: where it puts the point it looks at while the view is flat. */
  padding(): Insets;
}

/** A map camera, as a return to Map lands on it. */
type FlatShot = { center: [number, number]; zoom: number; bearing: number; pitch: number };

/**
 * The En-route view on the World map (CONTEXT.md, docs/adr/0002-en-route-custom-layer.md): the camera framing
 * the followed flight, Map (the flat map, the journey's own shot) or a 3D one, which tilts the map behind the
 * aircraft, turns on terrain and draws its model (en-route-layer.ts, loaded on the first 3D pick). It holds
 * all of the view's state (the camera chosen and the one riding with the flight, the share and its ease, the
 * rig, the peek, the frame watch, the return timer, the layer) and carries out the pure rules of en-route.ts
 * and en-route-journey.ts on the map; GlobeMap holds one and hands it the journey's frames.
 */
export class EnRouteController {
  /** The camera chosen: Map, or a 3D one. */
  private camera: EnRouteCamera = "map";
  /** The 3D camera riding with the flight: the one last chosen, kept while the view eases back out of it. */
  private riding: Exclude<EnRouteCamera, "map"> | null = null;
  /** How much of the 3D camera the Handover leaves the view (enRouteShare), given by the page each frame, and the share eased toward it in time. */
  private shareTarget = 1;
  private shareEase = new ShareEase();
  private share = 0;
  /** Whether the 3D view is on the map: terrain, the aircraft's layer, the map's drags off. On from the first frame with any share of a 3D camera to the last. */
  private on3D = false;
  private layer: EnRouteLayer | null = null;
  private layerLoading = false;
  private readonly rig = new EnRouteRig();
  /** A drag's look round the 3D camera's framing, and the pointer dragging it (its id and where it last was). */
  private readonly peek = new EnRoutePeek();
  private peekPointer: { id: number; x: number; y: number } | null = null;
  /** Whether the rig has been started from the camera the map had when the 3D view came on. */
  private rigStarted = false;
  /** In the 3D view: the journey's own (Map) shot, in the airport's metres, which the Handover still reads; null in Map. */
  private shot: OrbitView | null = null;
  /** Watches the 3D view's frame rate (en-route-journey.ts), unless the page holds it (`?fps=hold`, the smokes' software GL). */
  private readonly frameWatch = new FrameWatch();
  /** Told when the 3D view gives way to Map by itself, with the notice to show. */
  private onFallback: ((notice: string) => void) | null = null;
  /** Finishes a return to Map the frames have not finished in RETURN_TO_MAP_S (armReturnTimer). */
  private returnTimer: number | undefined;
  /** In the 3D view: the map camera of the journey's own flat shot this frame, where a return to Map lands. */
  private flatShot: FlatShot | null = null;
  /** In the 3D view: how far Satellite's large-scale imagery reaches (the horizon), and the metres of ground in one of MapLibre's Mercator units at the eye. */
  private readonly imageryReach: ImageryReach = { metres: 0, metresPerUnit: 0 };
  /**
   * In the 3D view: the camera placed last frame, centred where the camera looks at (the aircraft), before its
   * centre went out along the line of sight (sightPlacement). Another 3D camera eases in from it, not from the
   * map's own centre, which can be kilometres down the line of sight.
   */
  private lastPlaced: EnRoutePlacement | null = null;

  constructor(
    private readonly host: EnRouteHost,
    private readonly holdFrameRate: boolean,
  ) {
    const { map } = host;
    // A lost WebGL context in the 3D view: back to Map at once (nothing draws to ease through), which the map
    // draws again once the context is restored.
    map.on("webglcontextlost", () => {
      if (!this.on3D) return;
      this.fallBack("webgl");
      this.drop();
    });
    // In a 3D camera a drag (mouse or touch) peeks round the aircraft, rather than moving the map.
    const canvas = map.getCanvasContainer();
    canvas.addEventListener("pointerdown", this.onPeekDown);
    canvas.addEventListener("pointermove", this.onPeekMove);
    canvas.addEventListener("pointerup", this.onPeekUp);
    canvas.addEventListener("pointercancel", this.onPeekUp);
    canvas.addEventListener("lostpointercapture", this.onPeekUp);
  }

  /** The camera chosen: Map, or a 3D one. */
  get chosen(): EnRouteCamera {
    return this.camera;
  }

  /** How far the view is into the 3D camera this frame (0 flat, 1 all 3D), smoothed as the camera is (shareBlend): the Handover's crossfade gives way by as much. */
  get blend(): number {
    return shareBlend(this.share);
  }

  /** Whether the 3D view is on the map (terrain and the aircraft's layer with it). */
  get in3D(): boolean {
    return this.on3D;
  }

  /** In the 3D view, the journey's own Map shot (where the flat map would stand) in the airport's metres; null otherwise. */
  get journeyShot(): OrbitView | null {
    return this.shot;
  }

  /**
   * In the 3D view, the map camera of the journey's own flat shot this frame (where the flat map would stand);
   * null otherwise. The map's own centre then lies down the 3D camera's line of sight, far from the flight.
   */
  get journeyCamera(): MapCamera | null {
    const s = this.flatShot;
    return s && { lng: s.center[0], lat: s.center[1], zoom: s.zoom, bearing: s.bearing, pitch: s.pitch };
  }

  /** Told when the 3D view gives way to Map by itself (a WebGL failure, a frame rate that stays low), with the notice to show; null stops it. */
  setFallback(listener: ((notice: string) => void) | null): void {
    this.onFallback = listener;
  }

  /** How much of a 3D camera the Handover leaves the view, this frame (enRouteShare). */
  setShare(share: number): void {
    this.shareTarget = share;
  }

  /** A journey's map takes the flight from a Diorama: the view starts flat, whatever the last journey left, and the page's share takes it from the next frame. */
  start(): void {
    this.shareTarget = 0;
    this.drop();
  }

  /**
   * Picks the camera. A 3D camera eases in from the journey's own shot as the journey steers (terrain and the
   * aircraft's layer added as it starts: the flat map never loads them); Map eases back out of it to the
   * journey's shot, and only then takes the terrain and the layer off, so the map never shows tiles it has not
   * loaded. `atOnce` drops the 3D view straight away (the journey over, or handed to a Diorama that covers the map).
   */
  choose(camera: EnRouteCamera, atOnce = false): void {
    if (camera !== this.camera) {
      this.camera = camera;
      this.frameWatch.reset();
      if (is3D(camera)) {
        this.clearReturnTimer();
        if (camera !== this.riding) {
          // Another 3D camera: the rig eases over to it from the camera the map has now.
          this.riding = camera;
          this.restartRig();
        }
      } else if (!atOnce) this.armReturnTimer();
    }
    if (atOnce && !is3D(camera)) this.drop();
  }

  /** The page is shown again after being hidden: that time is a pause, not slow frames, and the share's ease does not jump over it. */
  resume(): void {
    this.shareEase.resume();
    this.frameWatch.reset();
  }

  /**
   * Frames the followed flight for this frame (the journey's driver, once a frame): `fix` is its pose from the
   * shared tracker, sampled once for the frame, and `mapShot` the journey's own Map shot in `frame`'s metres,
   * which the Handover reads. The view is the 3D camera's framing blended into that shot by the share the
   * Handover leaves it (setShare): the share is moved toward its target at an even pace in time (ShareEase)
   * and smoothed once (shareBlend). The aircraft's model and the camera are placed from the same pose, so the
   * camera never lags the model it frames. Returns false while the view is flat: the journey then steers the
   * flat map itself.
   */
  steer(fix: JourneyFix, mapShot: OrbitView, frame: Origin, now: number): boolean {
    const { map, container } = this.host;
    const share = this.shareEase.step(is3D(this.camera) ? this.shareTarget : 0, now);
    this.share = share;
    const camera = this.riding;
    if (share <= 0 || !camera) {
      this.leave3D();
      return false;
    }
    if (!this.on3D) {
      this.on3D = true;
      this.frameWatch.reset();
      this.apply();
    }
    // Software GL, or a device the terrain is too much for: back to Map once it has stayed slow a few seconds.
    if (!this.holdFrameRate && this.frameWatch.frame(now)) this.fallBack("slow");
    const [slat, slon] = toGeo(frame, mapShot.target[0], mapShot.target[1]);
    this.shot = groundView({ ...mapShot, target: toLocal(this.host.airport(), slat, slon) });
    const ground = map.queryTerrainElevation([fix.longitude, fix.latitude]) ?? 0;
    const pose = enRoutePose(fix, ground);
    const aircraftClass = classify(fix.typeCode, null);
    const lens: Lens = { height: container.clientHeight, fovDeg: map.getVerticalFieldOfView() };
    // On a phone or tablet the aircraft is framed in the band below the Journey card, the camera standing back
    // as far as the whole of it needs to fit there; a wide screen frames it as the map's own padding does.
    const band = this.host.band();
    const ideal = enRouteShot(pose, camera, aircraftClass.lengthM);
    const shot = band ? { ...ideal, distanceM: fitDistance(ideal.distanceM, camera, aircraftClass.lengthM, lens, band) } : ideal;
    if (!this.rigStarted) {
      // Eased in from the camera the map has now: the last one placed in the 3D view (another 3D camera picked), else the map's own.
      this.rigStarted = true;
      const c = map.getCenter();
      const from = mapToOrbit({ lng: c.lng, lat: c.lat, zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() }, { latitude: c.lat, longitude: c.lng }, lens);
      this.rig.start(this.lastPlaced ?? { center: { latitude: c.lat, longitude: c.lng }, elevationM: map.getCenterElevation(), distanceM: from.distance, bearingDeg: map.getBearing(), pitchDeg: map.getPitch() }, shot, now);
    }
    // The rig eases the framing; a drag's peek goes on top, so the camera answers the pointer at once.
    const framed = peekPlacement(this.rig.step(shot, now), camera, this.peek.at(now));
    // The journey's own shot, where the flat map would stand: the 3D camera eases into it by the share.
    const flat: EnRoutePlacement = { center: { latitude: slat, longitude: slon }, elevationM: mapShot.height, distanceM: mapShot.distance, bearingDeg: mapShot.azimuthDeg, pitchDeg: 90 - mapShot.elevationDeg };
    const flatCam = orbitToMap({ azimuthDeg: flat.bearingDeg, elevationDeg: mapShot.elevationDeg, target: [0, 0], height: 0, distance: flat.distanceM }, flat.center, lens);
    this.flatShot = { center: [flatCam.lng, flatCam.lat], zoom: flatCam.zoom, bearing: flatCam.bearing, pitch: flatCam.pitch };
    const eased = blendPlacement(flat, framed, shareBlend(share));
    this.lastPlaced = eased;
    // The same eye and look with the map's centre out along the line of sight, about as far as the eye is over the
    // ground (sightPlacement), so MapLibre sizes its tiles and skirts for the ground it draws, not for a point
    // kilometres above it. The nearest thing drawn: the aircraft's model (Cockpit draws none) or the ground under the eye.
    const eye = eyeOf(eased);
    const overGround = eye.altitudeM - ground;
    const [east, north] = toLocal(eye, fix.latitude, fix.longitude);
    const toModel = Math.hypot(east, north, pose.altitudeM - eye.altitudeM);
    const nearestM = camera === "cockpit" ? overGround : Math.min(toModel, overGround);
    const placed = sightPlacement({ ...eased, eye }, { groundM: ground, nearestM, fovDeg: lens.fovDeg });
    const orbit: OrbitView = { azimuthDeg: placed.bearingDeg, elevationDeg: 90 - placed.pitchDeg, target: [0, 0], height: 0, distance: placed.distanceM };
    const cam = orbitToMap(orbit, placed.center, lens);
    // The band's padding eases in with the 3D camera, so at none of it the map has its own and the flat shot never steps.
    const own = this.host.padding();
    const padding = band ? blendPadding(own, bandPadding({ width: container.clientWidth, height: container.clientHeight }, band), shareBlend(share)) : own;
    this.host.place({ center: [cam.lng, cam.lat], zoom: cam.zoom, bearing: cam.bearing, pitch: cam.pitch, elevation: placed.elevationM, padding });
    // From the Cockpit the aircraft is the one the eye sits in: its model is not drawn, so a peek back never fills the view with it.
    this.layer?.setAircraft(camera === "cockpit" ? null : pose, aircraftClass.model, aircraftClass.lengthM);
    // The far ground's haze round the eye, in the theme's horizon colour (a look near level sees the ground to it).
    this.layer?.setHaze({ eye, aboveM: overGround, colour: enRouteHaze(this.host.theme()), strength: hazeStrength(placed.pitchDeg) });
    // Satellite's large-scale imagery reaches as far as the haze is full (imageryTileZoom reads this each tile).
    this.imageryReach.metres = horizonM(overGround);
    this.imageryReach.metresPerUnit = MERCATOR_UNIT_M * Math.cos((eye.latitude * Math.PI) / 180);
    return true;
  }

  /** Brings the map to the En-route view: terrain, the aircraft's layer, the followed flight's flat marks and the camera's clamp to the ground. Waits for the style (the map's load and a theme's new style call it again). */
  apply(): void {
    const { map } = this.host;
    const on = this.on3D;
    // In a 3D camera the map's own drags are off: a drag peeks round the aircraft (onPeekDown) and never
    // moves the map, so it does not end the journey as a drag on the flat map does. The wheel still does.
    // Set at once, even before the style has loaded: the handlers do not wait for it.
    for (const handler of [map.dragPan, map.dragRotate, map.touchZoomRotate, map.touchPitch, map.doubleClickZoom]) {
      if (on) handler.disable();
      else handler.enable();
    }
    map.getCanvasContainer().style.touchAction = on ? "none" : "";
    // The tilt past level the 3D cameras look at (EN_ROUTE_MAX_PITCH), raised before the first 3D frame is placed;
    // the flat map's and the Diorama's MAX_PITCH back once the view is flat again. The camera is put within it
    // first, so MapLibre never clamps it itself (the view is flat by then: the journey's shot, or drop's).
    if (on) map.setMaxPitch(EN_ROUTE_MAX_PITCH);
    else if (map.getMaxPitch() !== MAX_PITCH) {
      if (map.getPitch() > MAX_PITCH) this.host.place({ pitch: MAX_PITCH });
      map.setMaxPitch(MAX_PITCH);
    }
    if (!map.getLayer("aircraft")) return;
    map.setCenterClampedToGround(!on);
    if (on) {
      try {
        if (!map.getSource(TERRAIN_SOURCE)) map.addSource(TERRAIN_SOURCE, terrainSource());
        if (!map.getTerrain()) map.setTerrain(TERRAIN);
        // The relief shaded from the same tiles, under everything else drawn, and a sky with a horizon.
        if (!map.getLayer(HILLSHADE)) map.addLayer(hillshadeLayer(this.host.theme()), HILLSHADE_UNDER);
        map.setSky(enRouteSky(this.host.theme()));
        // The ground past the farthest tile drawn, which a look near level sees, in the sky's haze (mapBackground).
        map.setPaintProperty("background", "background-color", mapBackground(this.host.theme(), true));
        // Satellite's imagery stays on its own large-scale product out to the horizon (imageryTileZoom).
        const imagery = map.getSource(IMAGERY);
        if (imagery) {
          map.setSourceTileLodParams(MAPLIBRE_LOD.maxZoomLevelsOnScreen, MAPLIBRE_LOD.tileCountMaxMinRatio, IMAGERY);
          if (imagery.calculateTileZoom) imagery.calculateTileZoom = imageryTileZoom(imagery.calculateTileZoom, this.imageryReach);
        }
        // The layer's own WebGL (its shaders) is made as it is added, and throws if the context cannot.
        if (this.layer && !map.getLayer(this.layer.id)) map.addLayer(this.layer);
      } catch (error) {
        console.warn("atc: the en-route view's WebGL failed", error);
        this.fallBack("webgl");
      }
      if (!this.layer && !this.layerLoading) {
        this.layerLoading = true;
        void import("./en-route-layer")
          .then(({ EnRouteLayer }) => {
            this.layer = new EnRouteLayer(() => this.fallBack("webgl"));
            this.paint();
            this.apply();
          })
          // The module did not load (offline, a deploy that moved it): back to Map, not terrain with no aircraft on it.
          .catch((error: unknown) => {
            console.warn("atc: the en-route view failed to load", error);
            this.fallBack("webgl");
          })
          .finally(() => (this.layerLoading = false));
      }
    } else {
      if (this.layer && map.getLayer(this.layer.id)) map.removeLayer(this.layer.id);
      // The hillshade reads the terrain's source: it goes first. The flat map's own sky back.
      if (map.getLayer(HILLSHADE)) map.removeLayer(HILLSHADE);
      if (map.getTerrain()) map.setTerrain(null);
      if (map.getSource(TERRAIN_SOURCE)) map.removeSource(TERRAIN_SOURCE);
      map.setSky(flatSky(this.host.theme()));
      map.setPaintProperty("background", "background-color", mapBackground(this.host.theme()));
      // MapLibre's own level of detail back for the flat map's imagery.
      const imagery = map.getSource(IMAGERY);
      if (imagery?.calculateTileZoom) {
        imagery.calculateTileZoom = undefined;
        map.triggerRepaint();
      }
    }
    // The model stands in for the flat marker and its ring.
    for (const id of ["journey-aircraft", "journey-beacon"]) map.setLayoutProperty(id, "visibility", on ? "none" : "visible");
  }

  /** The aircraft's colours for the theme: light metal, painted in the selection colour. */
  paint(): void {
    const palette = PALETTES[this.host.theme()];
    this.layer?.setColours(palette.modelBody, palette.selected);
  }

  dispose(): void {
    this.clearReturnTimer();
    const canvas = this.host.map.getCanvasContainer();
    canvas.removeEventListener("pointerdown", this.onPeekDown);
    canvas.removeEventListener("pointermove", this.onPeekMove);
    canvas.removeEventListener("pointerup", this.onPeekUp);
    canvas.removeEventListener("pointercancel", this.onPeekUp);
    canvas.removeEventListener("lostpointercapture", this.onPeekUp);
  }

  /**
   * A return to Map (picked, or a fallback) eases out by real time as the frames come; a device drawing a
   * frame every few seconds would still leave it partway, so RETURN_TO_MAP_S after it began a timer finishes
   * it: the 3D view off, and the camera on the journey's own flat shot, where the ease would have landed.
   */
  private armReturnTimer(): void {
    this.clearReturnTimer();
    if (!this.on3D) return;
    this.returnTimer = window.setTimeout(() => {
      this.returnTimer = undefined;
      if (is3D(this.camera) || !this.on3D) return;
      const shot = this.flatShot;
      this.drop();
      if (shot) this.host.place(shot);
      this.host.map.triggerRepaint();
    }, RETURN_TO_MAP_S * 1000);
  }

  /** The return timer off: the frames finished the return, a 3D camera was picked again, or the view went. */
  private clearReturnTimer(): void {
    window.clearTimeout(this.returnTimer);
    this.returnTimer = undefined;
  }

  /** The 3D view off at once, the camera brought down flat where it is. */
  private drop(): void {
    // A fresh ease starts at its first target.
    this.shareEase = new ShareEase();
    this.share = 0;
    // Brought down before the 3D view goes, so the flat map's tilt limit then finds it within.
    if (this.on3D) this.host.place({ elevation: 0, pitch: Math.min(this.host.map.getPitch(), 60) });
    this.leave3D();
  }

  /** The rig and the peek start afresh: the next 3D frame eases in from the camera the map has then. */
  private restartRig(): void {
    this.rig.reset();
    this.peek.reset();
    this.peekPointer = null;
    this.rigStarted = false;
  }

  /** The 3D view is off: terrain and the layer go, and the next 3D camera starts afresh. */
  private leave3D(): void {
    this.clearReturnTimer();
    this.riding = is3D(this.camera) ? this.camera : null;
    this.restartRig();
    this.shot = null;
    this.flatShot = null;
    this.lastPlaced = null;
    if (!this.on3D) return;
    this.on3D = false;
    this.apply();
    // The map's own padding back: the band's was the 3D view's.
    this.host.place({ padding: this.host.padding() });
  }

  /** The 3D view gives way to Map by itself, with the card's notice saying why; the view eases back out to the journey's shot. */
  private fallBack(cause: FallbackCause): void {
    if (!is3D(this.camera)) return;
    this.camera = "map";
    this.frameWatch.reset();
    this.armReturnTimer();
    this.onFallback?.(FALLBACK_NOTICE[cause]);
  }

  /** A press on the map in a 3D camera starts a peek: one pointer at a time, the primary button or a touch. */
  private readonly onPeekDown = (e: PointerEvent) => {
    if (!this.on3D || this.peekPointer || !e.isPrimary || e.button !== 0) return;
    this.peekPointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    try {
      // Held through a drag off the map's edge; a pointer the browser no longer has cannot be captured.
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // The drag still runs, from the moves over the map.
    }
  };

  private readonly onPeekMove = (e: PointerEvent) => {
    const p = this.peekPointer;
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    if (!dx && !dy) return;
    p.x = e.clientX;
    p.y = e.clientY;
    this.peek.drag(dx, dy);
    this.host.map.triggerRepaint();
  };

  /** Let go: the camera eases back to its framing. */
  private readonly onPeekUp = (e: PointerEvent) => {
    if (!this.peekPointer || e.pointerId !== this.peekPointer.id) return;
    this.peekPointer = null;
    if (this.peek.dragging) this.peek.release(performance.now());
  };
}
