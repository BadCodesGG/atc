# Context

Glossary for ATC. Terms are used as defined here in code, tests and UI copy.

## Terms

- **Diorama**: the three.js 3D scene of one airport (ground, pavement, markings, extruded buildings, aircraft), drawn in a canvas of its own over the World map (not a MapLibre custom layer) and kept on the same camera, the two converted into each other's terms each frame; during a **Handover** it crossfades over the map. Code in `src/lib/scene/`.
- **World map**: the MapLibre view showing each airport with its live aircraft count; zooming in hands over to the diorama. Code in `src/lib/globe/`.
- **Handover**: the continuous zoom from the world map into an airport's diorama, with no page change.
- **Journey**: following one flight gate to gate: out of its origin's diorama, across the map, into its destination's.
- **En-route view**: the 3D view of a followed flight on the World map, between its two Dioramas: the map tilted round the aircraft over 3D terrain, with the aircraft's class model drawn at its true position, altitude, heading and climb attitude in a MapLibre custom layer that shares the map's depth buffer (docs/adr/0002-en-route-custom-layer.md). Its **Camera** is picked on the Journey card: **Map** (the flat World map, where Following starts), **Chase** (behind and above the aircraft along its track, looking down at it), **Cockpit** (at the nose, looking ahead, pitched with the climb or descent), **Side** (abeam on the left at wing height) or **Top** (straight down, track up), or with the keys 1 to 5. A **Peek** is a drag in a 3D camera: it orbits the camera round the aircraft (Cockpit turns its look instead) and eases back to the camera's framing on release. Terrain is on only in the 3D cameras. A 3D camera picked while the flight is still in its origin's Diorama takes over once it is out of it; arriving, the camera eases into the Journey's own shot and the usual **Handover** follows, into the destination's Approach camera (else Orbit). If WebGL fails or the frame rate stays under about 20 a second, the view **falls back** to Map with a short notice. Code in `src/lib/globe/en-route.ts`, `en-route-journey.ts` and `en-route-layer.ts`.
- **Flight elsewhere**: a flight the search finds on the feed when nothing on screen matches, by callsign, flight number or **tail number** (its registration: N3596W, G-ZBKJ). Picking it opens the built airport it is near, or flies the world map to it and follows it there.
- **Feed**: a public ADS-B source (adsb.lol, with adsb.fi as fallback) read on request. **Feed health** is its online/offline status.
- **Tracker**: turns feed snapshots into tracked aircraft with a state (parked, pushing back, taxiing, holding, climbing, on approach).
- **Movements**: departures and arrivals observed by the feed since the page opened; the basis of the board.
- **Replay**: rewinding what the page has seen since it opened (10x or 30x) or a time-lapse of light trails. Nothing is stored server side.
- **Fixture**: recorded data used instead of live feeds (`?fixture=1`, `?fixture=sequence`); keeps smoke tests deterministic.
- **Procedure**: an FAA-published approach or departure from CIFP, drawn for the runway in use. **CIFP** is the FAA Coded Instrument Flight Procedures file.
- **Predicted path**: the expected taxi route along an airport's taxiway graph.
- **Squawk**: transponder code; 7700, 7600 and 7500 trigger alerts.
- **METAR**: an airport's weather report, from aviationweather.gov.
- **Ground stop / delay program**: FAA NAS status items shown for an airport.
- **Theme**: light (toy diorama), dark (night ops) or satellite (daylight over aerial imagery).
