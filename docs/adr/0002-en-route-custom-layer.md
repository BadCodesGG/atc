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
  The rig shrinks its offset from the shot at least as fast as its distance closes, so the offset never grows
  against the distance: eased in from the flat shot at FL390 the camera's distance (eased in log) came within a
  few kilometres while its centre was still most of the 11.9 km below the aircraft, which on hardware GL left
  the aircraft off the top of the screen and then behind the eye from about 1.0 to 4.3 s after the click
  (1440x900; 3.4 s at 375x812). With the shrink nothing at 1440x900; at 375x812 under 0.4 s while the share
  is under 1 (`blendPlacement`, which mixes the centre by the share and the distance in log): Chase 0.18 s
  and at most 172 px above the top, Side 0.39 s just past the right edge, Top 0.08 s by 5 px. The settled
  framing is unchanged.
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
  unchanged. The relief shades harder from cruise heights (`reliefStrength`, the layer's
  `hillshade-exaggeration` over the map's zoom: the theme's `reliefStrength` from zoom 15 up, about
  11,000 ft and lower, as before, rising to its `reliefCruiseStrength` by zoom 13, about FL400; Satellite
  the same at both). From higher up the map's zoom is lower (its centre is the eye's height out) and the
  relief faded with it: measured as the spread of the ground's luminance under the aircraft on hardware GL
  over the same Alabama ground, Dark's Chase fell from 5.3 at 11,000 ft to 3.6 at FL400, its Cockpit from
  2.1 to 1.6 and its Side from 2.9 to 1.5 (Light's from 4.2, 1.9 and 2.6 to 4.0, 2.9 and 1.7). With the
  ramp and the haze's floor below, FL400 reads 5.4, 2.3 and 2.5 in Dark and 5.7, 5.2 and 2.4 in Light, and
  11,000 ft is unchanged. That coarser terrain tiles carry the fade is the likely mechanism, not measured.
  Dark's Cockpit and Side were still near black from cruise heights (its strength already 1, the most there is),
  so Dark also lights its slopes brighter on the same zooms (the layer's `hillshade-highlight-color`: the
  shores' navy `reliefLight`, #2a4468, from zoom 15 up, as before, to a moonlit blue `reliefCruiseLight`,
  #6a94d0, by zoom 13; Light and Satellite light theirs white at every zoom, so the lever has nothing to give
  Light's Side). Measured over the same crop on hardware GL at FL400, the same ground shot with each colour
  on one page, Dark's Chase, Cockpit and Side read 7.5, 4.9 and 3.0 against 3.7, 2.4 and 1.8 (Top 13.3
  against 9.2; at FL510, where the blue is whole, Chase 8.4, Top 16.2), the ground's mean luminance rising
  from about 23 to 25 to 31 of 255: still night. Side stays under 4: it looks across at the far ground, low
  and in the haze. A brighter blue (#87b8ff) gave Side only 3.6 while Top at FL510 began to read as day.
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
- **The centre goes out along the look in MapLibre's own world, and the zoom is in its own metres**
  (`mapEye`, `mapCamera`; the aircraft's place in the frame moved with its altitude after release). The
  first `sightPlacement` stepped the centre out on the sphere (`toGeo`, a great circle) and handed the map
  a distance in the equatorial metres of `orbitToMap`. MapLibre puts its eye back from the centre along a
  straight line in its Web Mercator world, with heights and distances in metres on its own radius
  (6,371,008.8 m) at the centre's latitude. Kilometres out, a great circle leaves that straight line by
  metres, the metre itself changes with the latitude, and the two radii differ by 0.11%: the map's eye stood
  metres off the camera's, and the aircraft, a few hundred metres ahead of it, slid across the frame by a
  share that grew with the eye's height and depended on the track (on hardware GL at 1440x900, track 020:
  Chase's aircraft 8 px off its framing point at 11,000 ft, 116 at 39,000 and 167 at 47,000, down the frame;
  on track 200 the same distance up it, as the live flights showed; westbound only sideways). Now `mapEye` is the eye MapLibre draws from, the centre moves out from it along MapLibre's
  look in its world, and `mapCamera` gives the zoom in MapLibre's metres, so the eye, the aircraft and the
  centre are on one line in the map's own maths and the aircraft is drawn on the framing point (the middle
  of the padded view) at every height, track and ground (`en-route.test.ts` projects it with MapLibre's
  camera, 1,000 to 51,000 ft, within half a pixel; `smoke-en-route-journey.mjs` checks it at FL390 on
  track 020 at every size).
- **The far ground fades into the horizon's haze, drawn by the layer.** MapLibre's own fog cannot do it on
  a look near level: its fog starts at its fog matrix's near plane, the map centre's height over sea level
  over the cosine of a pitch near 89 degrees (about 250 km out at 11,000 ft), so it only touched the last
  pixels before the horizon, and the far ground showed as a band of low-zoom imagery with a hard seam
  against the near relief and a white line at the horizon (ticket #23's review; a probe with a magenta fog
  showed it). So the En-route layer draws the haze itself, before the aircraft (`hazeShells`): 24 spheres
  round the eye, from 8% of the way to the horizon (past Chase's ground), and in Light and Dark never
  nearer than 4.8 of the eye's heights over the ground (the palette's `hazeFloorHeights`; Satellite has
  none, its haze as it was), out to full haze at the horizon's
  distance over a round Earth (`sqrt(2Rh)`), or just inside the map's far plane when that comes first.
  The horizon grows only as the root of the height: at FL400 the 8% alone started the haze 2.6 heights
  out, over all the ground a level look sees, and Dark's Cockpit was a near-black frame. The 8% is 4.8
  heights out from an eye 11,600 ft over the ground and more from lower, so the floor leaves 11,000 ft
  as it was and keeps the look's first 11 degrees below level clear from any height.
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
- **Satellite's imagery stays one product out to the horizon in a 3D camera** (`imageryTileZoom`,
  `IMAGERY_NEAR_ZOOM` in `map-style.ts`). Cockpit and Side in Satellite showed a hard line about 40 km out
  at 11,000 and 37,000 ft, olive beyond, grey near. It was not the haze: USGSImageryOnly serves a
  different small-scale product at zoom 8 and under (mean colour 54/57/17 over the same Alabama ground at
  zoom 8, 109/111/94 at zoom 9, measured on the tiles), and MapLibre's level of detail on a pitched map
  dropped from 9 to 8 there. A haze starting nearer, as a share of the horizon distance, hazed the near
  ground and still showed the line at 37,000 ft (tried and reverted). Instead, in a 3D camera the imagery
  source's `calculateTileZoom` (MapLibre's own, from `setSourceTileLodParams` with its defaults,
  `MAPLIBRE_LOD`) is floored at zoom 9 for every tile nearer than the horizon (`horizonM`, where the haze
  is full), so the ground in sight is all the large-scale product and the olive one is only ever under full
  haze; Map gets MapLibre's own back. It costs zoom-9 tiles to the horizon: imagery tiles drawn, floor off
  against on in the same page with the tiles loaded, Cockpit 4 to 6 against 14 to 22 and Side 5 to 8
  against 16 to 33 (11,000 and 37,000 ft); Chase and Top barely change. Imagery requests on entering
  Cockpit from a fresh page: 107 at 11,000 ft and 131 at 37,000 ft (91 and 214 before, so within the
  run-to-run spread), then Side 17 and 54 more (5 and 10 before). With the tiles loaded the frame
  rate was the same either way on hardware GL, within the runs' own spread (Cockpit 123 to 148 fps off,
  140 to 148 on); while the extra tiles are still arriving the first seconds of a camera run slower.
  Light and Dark have no imagery and are unchanged. What still shows is the imagery's own
  state mosaic (the Alabama and Georgia orthophotos differ in colour along the state line, at every zoom
  and on Map too), which is the ground's picture, not a level of detail.
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
  the pose, the model's matrix, the rig, the band's padding and the fit in it, the aircraft on the framing
  point from 1,000 to 51,000 ft through MapLibre's own camera, and in front of the eye and in the frame all
  through the rig's ease from the flat shot), `src/lib/globe/en-route-journey.test.ts` (the share at both ends,
  its ease, the blend, the camera held in the origin's Diorama, Approach else Orbit, the fallback rule and
  its notice), `src/lib/globe/map-style.test.ts` (terrain, hillshade and sky only when asked, the flat
  sky unchanged, the relief's strength and Dark's light by zoom, the haze's start in eye heights); smoke: `scripts/smoke-en-route-chase.mjs`, `scripts/smoke-en-route-cameras.mjs` and
  `scripts/smoke-en-route-journey.mjs` (gate to gate in Chase, phone and tablet, the aircraft in the band
  below the card, the switch on one row, hillshade and sky in 3D only, the same band and the wide Chase
  framing at FL390 on track 020, the fallback).

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
