# Context

Glossary for ATC. Terms are used as defined here in code, tests and UI copy.

## Terms

- **Diorama**: the three.js 3D scene of one airport (ground, pavement, markings, extruded buildings, aircraft), added to the MapLibre map as a custom layer so both share one camera. Code in `src/lib/scene/`.
- **World map**: the MapLibre view showing each airport with its live aircraft count; zooming in hands over to the diorama. Code in `src/lib/globe/`.
- **Handover**: the continuous zoom from the world map into an airport's diorama, with no page change.
- **Journey**: following one flight gate to gate: out of its origin's diorama, across the map, into its destination's.
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
