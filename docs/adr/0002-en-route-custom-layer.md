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
- **A 3D camera shades the relief and has a sky** (ticket #23's review). The flat themes' land is one paper
  or night colour, which under a tilted camera read as an empty screen with no horizon. While a 3D camera
  is on, a `hillshade` layer (`hillshadeLayer`, under every other layer) shades the terrain from the same
  Terrarium source, in colours named per theme beside the map's palette (`reliefShadow`, `reliefLight`,
  `reliefStrength`: subtle by day, plainer by night, a touch over the imagery), and the style's `sky` is the
  Diorama's own air in a close camera (`enRouteSky`: the theme's `eyeLevel` horizon graded up to its zenith
  over most of the sky, `sky-horizon-blend` 0.9), so the view has a horizon in every theme, Satellite included.
  Both come and go with the terrain: Map has neither, and keeps its own sky (`flatSky`, the page colour all
  round) exactly as before; a theme switch carries both in the new style. No new tile host: the CSP is
  unchanged.
- **On a phone or tablet the aircraft is framed in the free band** below the Journey card (ticket #23's
  review: the card covered it). Below xl the map's padding in a 3D camera is the band's
  (`bandPadding`, from `freeBand`, the band the flat shot keeps the aircraft in), eased in from the map's
  own padding by the same share the camera eases by (`blendPadding`), and Chase, Side and Top stand back
  as far as the whole model needs to fit 80% of the band each way (`fitDistance`). At 320x700 that band
  is too shallow, so in a 3D camera on a short phone (a `cramped` screen under 640 px wide) the Journey card folds to its
  head, the switch and the progress: the facts and the notes come back on Map. Wide screens are unchanged.
- **The camera is pure** (`src/lib/globe/en-route.ts`): pose and camera in, the map's placement out
  (centre and its elevation, distance, bearing, pitch, eye). Chase stands behind and above along the
  track; Cockpit has its eye just ahead of the nose looking along the track; Side stands abeam on the
  left looking across at the aircraft; Top looks straight down, track up (ticket #22).
- **The 3D cameras tilt past level; the flat map keeps 78.** The flat map and the Diorama keep the map's
  `maxPitch` at 78 (`MAX_PITCH`), the app's own bound, not MapLibre's. While a 3D camera is on, the
  controller raises it to `EN_ROUTE_MAX_PITCH` (110, `90 + MAX_ATTITUDE_DEG`), and puts 78 back on Map,
  once the 3D camera has handed the tilt back at or under 78, so `setMaxPitch` never clamps a camera mid-ease (owner's decision,
  ticket #23). Side looks level at wing height (pitch 90). Cockpit's pitch is `90 + attitude`, the
  attitude bounded at 20 degrees each way, so a climb looks up and a descent down. Chase (75) and Top (0)
  keep their framing, and a drag may tilt up to the same limit. The Cockpit does not draw the aircraft's
  model at all (its eye is inside it), so no look round ever fills the view with it.
- **The map's centre sits on the line of sight, not at the aircraft** (`sightPlacement`). MapLibre sizes
  tile detail, terrain skirts and the near plane from the centre's height and distance: with the centre
  at the aircraft, kilometres above the ground, Top fetched far more tiles than it draws (about 20 to 30
  fps on this GPU) and short skirts let the page's paper show through between tiles (the green slivers in
  the Satellite sky). The camera's eye, bearing and pitch stay the same; only the centre moves along the
  line of sight, as far as the eye is over the ground (at least 2 km, `SIGHT_MIN_M`, for the skirts), or
  to the ground if the look meets it first (Top), and never so far that the near plane would clip the
  aircraft (Cockpit: the ground). Farther (where Chase's slanting look meets the ground, or the near
  plane's farthest for a level look) the frame rate fell to 55 to 85.
- **The far ground fades into the horizon's haze, drawn by the layer.** MapLibre's own fog cannot do it on
  a look near level: its fog starts at its fog matrix's near plane, the map centre's height over sea level
  over the cosine of a pitch near 89 degrees (about 250 km out at 11,000 ft), so it only touched the last
  pixels before the horizon, and the far ground showed as a band of low-zoom imagery with a hard seam
  against the near relief and a white line at the horizon (ticket #23's review; a probe with a magenta fog
  showed it). So the En-route layer draws the haze itself, before the aircraft (`hazeShells`): 24 spheres
  round the eye, from 8% of the way to the horizon (past Chase's ground) out to full haze at the horizon's
  distance over a round Earth (`sqrt(2Rh)`), or just inside the map's far plane when that comes first.
  The shells are first only counted, in the stencil, against the map's depth buffer (never written to
  it): a pixel's count is how many shells are nearer than the ground there. Then each count's haze is
  drawn where the stencil holds it, an equal 1/24 share a shell (too small a step to show as an edge), so
  every pixel is blended once: blended shell by shell, 24 faint layers each rounded to 8 bits tinted and
  darkened the sky in a line. The stencil is cleared after. Over level the haze thins out within about 3
  degrees, so the horizon is soft and a ridge over level fades as the sky beside it does. The haze is
  in full on a look near level (pitch 85 and past: Cockpit, Side) and none at Chase's 75 or steeper
  (`hazeStrength`), so Chase and Top look as they did; a drag tilting Chase up eases it in. The haze, the map's background past the farthest tile (`mapBackground`)
  and the sky's horizon are one colour per theme (`enRouteHaze`, the theme's `eyeLevel` horizon), so the
  ground, the haze and the sky meet without a line. Map has none of it.
- **The address carries the journey's flat shot in a 3D camera.** The map writes its camera into the
  address's `#map=` itself (`GlobeMap.addressCamera`, `withMapHash`, at most every 300 ms), not through
  MapLibre's own hash: that wrote the 3D camera's view past level (pitch 90), which on a reload MapLibre
  refused for being past the map's 78 and opened the world instead. In a 3D camera the address and the
  share link carry the journey's flat shot, so a reload opens on the flat map where the flight is; a
  `#map=` past 78 (an address made before) names no camera (`mapHashCamera`) and is dropped.
- **"In view" in a 3D camera is the journey's flat shot's ground** (owner's decision). Past level the
  map's own bounds are a point (Cockpit and Side at pitch 90 measured `[-85.42,33.7,-85.42,33.7]`), and in
  Chase and Top a small area down the line of sight, so the header's "N aircraft in view", the filters'
  options, the military and squawk alerts and the region's traffic reads saw only the followed flight.
  While a 3D camera has the flight (its share above 0) they all read `GlobeMap.viewBounds`, the one seam:
  the ground the journey's flat Map shot would show for the frame and the map's own padding
  (`shotBounds`, `viewArea` in `src/lib/globe/camera.ts`, MapLibre's own `getBounds` worked through on a
  flat map, its top cut under the horizon), so the count and the alerts are what Map would give. On Map
  the map's own bounds are read unchanged. The followed flight counts in every 3D camera wherever it is.
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
  (`blendPlacement`) by a share: none of the 3D camera inside the Handover band of the Diorama at that end
  of the journey, all of it from 2.5 times the band's outer edge out, even in log distance between
  (`enRouteShare`, the share's target). The share is moved toward that target at an even pace in time
  (`ShareEase`, all the way in 1.2 s), so a band that changes with the airport never steps the camera, and
  smoothed once at both ends where it is used (`shareBlend`, in `EnRouteController`: the camera's blend and
  the Handover's crossfade both read it), which eases it in log distance and in time alike. The ease runs
  on real elapsed time however far apart the frames are; a gap
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
  the pose, the model's matrix, the rig, the band's padding and the fit in it), `src/lib/globe/en-route-journey.test.ts` (the share at both ends,
  its ease, the blend, the camera held in the origin's Diorama, Approach else Orbit, the fallback rule and
  its notice), `src/lib/globe/map-style.test.ts` (terrain, hillshade and sky only when asked, the flat
  sky unchanged); smoke: `scripts/smoke-en-route-chase.mjs`, `scripts/smoke-en-route-cameras.mjs` and
  `scripts/smoke-en-route-journey.mjs` (gate to gate in Chase, phone and tablet, the aircraft in the band
  below the card, the switch on one row, hillshade and sky in 3D only, the fallback).

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
