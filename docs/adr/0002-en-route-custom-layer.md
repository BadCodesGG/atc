# 0002. The En-route view's aircraft is a MapLibre custom layer sharing the map's depth buffer

## Status

Accepted, 2026-11-25 (ticket #21, spec #16); the other cameras, the drag and the keys added by ticket #22; the
Handover at both ends, the fallback to Map and the small screens by ticket #23.

## Context

The En-route view shows a followed flight in 3D on the World map, anywhere between its two Dioramas: the
map tilted behind the aircraft (the Chase, Cockpit, Side and Top cameras), 3D terrain under it,
and the aircraft's own model at its true position, altitude, heading and climb attitude. The models are
the procedural per-class ones the Diorama already draws (`src/lib/scene/aircraft-model.ts`).

The page already has a way of drawing 3D over the map: the Diorama. It is a three.js scene in a canvas
of its own, laid over the map's canvas and kept on the same camera (the map's centre, zoom, bearing and
pitch converted into the airport's metres every frame, `src/lib/globe/camera.ts`). During a Handover it
crossfades over the map. The two canvases never share a depth buffer: the Diorama draws its own ground,
so nothing of the map ever needs to hide part of it.

En route that is not so. The ground is the map's: its terrain, drawn by MapLibre from the raster-dem
source. An aircraft low over a ridge, or a camera behind one, must have the aircraft hidden by the
terrain in front of it, and that needs the aircraft drawn with the depth the terrain left.

## Decision

The aircraft is drawn by `EnRouteLayer` (`src/lib/globe/en-route-layer.ts`), a MapLibre custom layer
with `renderingMode: "3d"`, in the map's own WebGL2 context, into the map's framebuffer, with depth test
and depth write on against the map's depth buffer. So terrain occludes it, and it occludes what is behind
it, with no second canvas.

- **Drawn in raw WebGL2, not three.js.** One mesh (the class's far model, a few hundred faces, its
  positions, normals and paint read from the shared geometry builder) and one small shader lit from
  above. three.js on a context it does not own would need its state reset round every frame; MapLibre
  marks its own GL state dirty after a custom layer, so a layer that sets what it uses and nothing more is
  enough.
- **Placed in doubles on the CPU.** The model's matrix (Mercator position, metres to Mercator units,
  track, climb attitude, size) is composed with MapLibre's `defaultProjectionData.mainMatrix` in doubles
  and only the product goes to the GPU, so the model holds still at metre precision anywhere in the world.
  The camera is always at Mercator zooms (the globe projection ends at zoom 6).
- **One pose a frame, from the shared tracker.** The Journey's driver samples the followed flight once a
  frame (`Journey.fix`, the shared tracker at `SharedSky.time()`, docs/adr/0001-one-shared-tracker.md) and
  hands the same pose to the camera (`enRouteShot`, eased by `EnRouteRig`) and to the layer, which only
  draws. The camera and the model therefore never disagree, and the aircraft holds its place in the frame.
- **Loaded only for a 3D camera.** The layer's module (and the model builder with it) is imported on the
  first 3D pick; the terrain source and the terrain are added then and removed on Map, so the flat map
  loads neither. A theme switch carries the terrain in the new style and adds the layer back after it.
- **The camera is pure** (`src/lib/globe/en-route.ts`): pose and camera in, the map's placement out
  (centre and its elevation, distance, bearing, pitch, eye). Chase stands behind and above along the
  track; Cockpit has its eye just ahead of the nose looking along the track; Side stands abeam on the
  left looking across at the aircraft; Top looks straight down, track up (ticket #22).
- **The map's 78 degree tilt bounds the cameras.** MapLibre's `maxPitch` is 78 here (the Diorama's
  limit too), so no camera can look level or up. Side's level look is held at 78: its eye is 12 degrees
  above wing height. Cockpit's pitch is `90 + attitude` held at 78, so it follows the attitude only in a
  descent steeper than 12 degrees, and a climb or level flight looks 12 degrees below the horizon. The
  Cockpit does not draw the aircraft's model at all (its eye is inside it), so no look round ever fills
  the view with it.
- **A drag peeks, and eases back.** In a 3D camera MapLibre's own drag, rotate, pinch and double-click
  handlers are off and the map's canvas takes pointer drags (mouse and touch alike) itself: a drag adds
  a bearing and tilt offset (`EnRoutePeek`, `peekPlacement`) on top of the rig's eased framing, so the
  camera answers the pointer at once. Chase, Side and Top orbit the aircraft; Cockpit turns its look
  round its eye. On release the offset eases back to nothing. A drag never moves the map, so it does not
  end the journey as a drag on the flat map does; the wheel still does.
- **Keys 1 to 5** pick Map, Chase, Cockpit, Side and Top while the Journey card offers them, ignored in a
  field being typed in and with Ctrl, Alt or Meta held. The camera picked holds across feed reads.
- **The 3D camera eases into the journey's own shot at both ends** (`src/lib/globe/en-route-journey.ts`,
  ticket #23). The Diorama is drawn on the flat map's camera, so the Handover's crossfade needs the map flat
  and on the journey's own Map shot. The view is therefore the 3D camera's framing blended into that shot
  (`blendPlacement`) by a share (`enRouteShare`): none of the 3D camera inside the Handover band of the
  Diorama at that end of the journey, all of it from 2.5 times the band's outer edge out, eased in log
  distance between, and eased in time (`ShareEase`, all the way in 1.2 s) so a band that changes with the
  airport never steps the camera. The ease runs on real elapsed time however far apart the frames are; a gap
  between frames is never taken as a pause by its length alone, only the page being hidden (its
  `visibilitychange`) is, and the first frame after it is shown again does not move it. Leaving the origin,
  a 3D camera chosen in its Diorama (offered on the flight card there) is held until the map has the flight
  and takes over once the flight is out of the band; arriving, it eases into the journey's shot, the terrain
  and the layer come off at a share of nothing, and the usual Handover follows. The Diorama then opens in its
  Approach camera when it has one for the flight, else Orbit. Map eases out the same way, and takes the
  terrain off only once the camera is the flat shot, so the map never shows a frame of tiles it has not
  loaded (the half second of blank map a cut to Map showed). A return to Map (picked, or a fallback) the
  frames have not finished 1.6 s after it began (`RETURN_TO_MAP_S`: a device drawing a frame every few
  seconds, as the smokes' software GL does in Top over terrain) is finished by a timer, which puts the camera
  on the journey's flat shot as it takes the terrain off, so Map is back in under 2 s of wall-clock time
  whatever the frame rate. The arrival ease has no timer: it follows the flight.
- **It falls back to Map** with a short notice on the Journey card when its WebGL fails (the layer's module
  not loading, the layer or the terrain throwing as they are added or drawn, a lost context) or the frame rate
  stays under 20 a second for 3 seconds (`FrameWatch`, which forgives a shorter stutter or one long stall, and
  still trips on a device drawing one frame every few seconds; the page resets it when it is shown again
  after being hidden, so a hidden tab's pause is not counted as slow). `?fps=hold` keeps a 3D camera whatever
  its frame rate: the smokes' software GL draws it at a few frames a second.

The Diorama stays as it is: a separate overlay canvas on the same camera, crossfading during the Handover.

## Consequences

- Terrain hides the aircraft behind a ridge, and the aircraft sits in the same depth as the map's own 3D
  (terrain, extruded buildings), with no compositing between canvases.
- The aircraft is drawn by MapLibre's frame loop, so it is drawn exactly when the map is: no frame where
  the camera has moved and the model has not.
- The layer is a second way of drawing the class models, beside the Diorama's three.js materials. It
  reads the same geometry, so a model change shows in both, but its look (a flat body with paint, one
  light) is its own, and the Diorama's lights, liveries and night lighting are not in it.
- The chosen 3D camera holds until the Handover: it eases continuously into the journey's own shot as the
  flight nears the destination's Handover band, and the Handover crossfade runs from there, on the camera the
  Diorama is drawn on. The Journey card keeps the chosen camera pressed through it. For the last stretch
  before the band the map is flat while a 3D camera is chosen.
- Tests: `src/lib/globe/en-route.test.ts` (each camera's placement, the peek and its ease back, the keys,
  the pose, the model's matrix, the rig), `src/lib/globe/en-route-journey.test.ts` (the share at both ends,
  its ease, the blend, the camera held in the origin's Diorama, Approach else Orbit, the fallback rule and
  its notice), `src/lib/globe/map-style.test.ts` (terrain only when asked); smoke:
  `scripts/smoke-en-route-chase.mjs`, `scripts/smoke-en-route-cameras.mjs` and
  `scripts/smoke-en-route-journey.mjs` (gate to gate in Chase, phone and tablet, the fallback).

## Alternatives considered

- **Draw the aircraft in the Diorama's overlay canvas** (or a second three.js canvas like it), kept on the
  map's camera as the Diorama is. It reuses the Diorama's renderer and materials, but the overlay cannot see
  the map's depth: terrain could never hide the aircraft, and an aircraft behind a ridge would be drawn in
  front of it. Matching the two cameras exactly is also harder in 3D than at the Handover, where a small
  mismatch hides in the crossfade: here the model would swim against the terrain at every camera move.
  Rejected.
- **three.js inside the custom layer** (a `WebGLRenderer` on the map's context, as MapLibre's examples do).
  It would share the depth buffer too and bring three's materials, but it carries three's whole renderer
  and its GL state into MapLibre's context every frame for one mesh with one light. Rejected for a few
  dozen lines of WebGL2.
- **A 2D icon lifted by the map's own symbol layers** (an icon at the aircraft's height, or a
  fill-extrusion footprint). Neither can show a model's shape, heading and climb attitude in a
  ride-along camera. Rejected.
