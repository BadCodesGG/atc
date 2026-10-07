# ATC

**Every aircraft at 32 US airports, live, from a world map down to the gate.**
Each airport's real runways, taxiways, aprons and terminals are drawn as a 3D diorama under a map that flies down into it, and the traffic from the open ADS-B feeds moves on it as it happens.

**Live: [atc.badcodes.dev](https://atc.badcodes.dev)**

<!-- demo-video -->

The airport layouts come from OpenStreetMap, the aircraft from [adsb.lol](https://adsb.lol) (with [adsb.fi](https://adsb.fi) as a fallback), the weather from each airport's own METAR, and the light from the sun's real position at that airport. Follow one flight and the camera carries it gate to gate: out of its origin's diorama, across the map and into its destination's.

The app keeps no database. The airport layouts and procedures are committed JSON, and everything live is read from public feeds on request.

## What you can do

| | |
|---|---|
| **Fly in** | Start on the world map, where each airport shows its live aircraft count, and scroll into one. The map tilts and the airport's ground plan rises out of it. |
| **Pick an airport** | Any of the 32 in the picker, or by URL (`?airport=atl`). |
| **Select a flight** | Click an aircraft for its card: callsign, type, route, altitude, speed, state (parked, pushing back, taxiing, holding, climbing, on approach) and, where Planespotters has one, a photo. |
| **See where it is going** | The predicted taxi route along the airport's taxiway graph, and the FAA's published approach or departure drawn for the runway in use. |
| **Follow a journey** | The camera follows a flight from its origin diorama over the map and into the destination's diorama. |
| **Change the camera** | Orbit, tower, drone (chases the selected flight) and approach cameras, plus arrow-key, `Q`/`E` and `+`/`-` controls for the view. |
| **Read the airport** | A departures and arrivals board built from what the feed has observed, runways in use, FAA ground stops and delay programs, and the airport's METAR. |
| **Search and filter** | Search by flight, airline, registration or gate; filter the traffic by airline, aircraft type, altitude, speed and ground state. |
| **Replay** | Rewind what the page has seen since it opened at 10x or 30x, or watch it as a time-lapse of light trails. Nothing is stored on a server, so the replay starts when you open the page. |
| **Get alerts** | Optional browser notifications when a followed flight pushes back, takes off or lands, when something squawks 7700, 7600 or 7500, and when military aircraft enter the area. |
| **Weather radar** | A RainViewer radar layer on the world map. |
| **Share the view** | The address carries the airport, flight, camera, theme and filters, so a copied link opens on the same view. |
| **Three themes** | Light (toy diorama), dark (night ops) and satellite (daylight over aerial imagery). |

## How it works

```
src/app/              Next.js App Router: the page and the API routes under api/
  api/                traffic, region, counts, weather, status, flight, hex and squawk:
                      thin routes over the feeds below
src/components/       The React UI: the app shell, header, flight cards, board, search, alerts
src/lib/              Pure TypeScript, tested: the feeds and their fallbacks, the tracker, replay,
                      alerts, filters, METAR and FAA status parsing, CIFP parsing, taxi routing
src/lib/globe/        The MapLibre side: the world map, handover into an airport, journeys
src/lib/scene/        The three.js side: the airport diorama, aircraft models, cameras, themes
src/data/airports/    One JSON per airport (runways, taxiways, aprons, buildings), committed
src/data/procedures/  One JSON per airport (approaches and departures from the FAA CIFP), committed
public/fixtures/      A recorded ATL sequence for the ?fixture=sequence demo mode
scripts/              Data builders, the end-to-end smoke tests and the MapLibre worker copy
```

**Rendering.** The world map is MapLibre GL with OpenFreeMap vector tiles (or USGS satellite imagery). The airport is a three.js scene added to it as a custom layer, so the map and the diorama share one camera and the zoom from a continent to a gate is continuous, with no page change. Each airport's OpenStreetMap geometry is turned into ground, pavement, markings and extruded buildings by `src/lib/airport-map.ts`, and aircraft are placed on it with models chosen by type.

**Live feed.** The API routes read adsb.lol first and fall back to adsb.fi when it cannot answer, each with its own back-off. The traffic route serves its last good answer through upstream rate limits, so a short outage shows as slightly stale data rather than an empty airport. Routes (origin and destination) come from adsbdb.com, weather from aviationweather.gov, and ground stops and delays from the FAA's NAS status feed. Every upstream failure is an ordinary state the UI shows, not an error page.

**Fallbacks.** If the radar, the photo API or a route lookup is unavailable, that one panel is left out and the rest carries on. `?fixture=1` freezes the page on a recorded snapshot and `?fixture=sequence` replays a recorded ATL run, which is how the smoke tests stay independent of what is in the sky.

## Running it

You need Node 22.18 or later in the 22 line, or Node 24 (the data scripts load the app's TypeScript directly through Node's type stripping).

```bash
git clone https://github.com/BadCodesGG/atc.git
cd atc
npm install            # also copies MapLibre's web worker into public/maplibre/
npm run dev            # http://localhost:3000
```

| Script | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build. Its `prebuild` step copies the MapLibre worker again, so it always matches the installed version |
| `npm start` | Serves the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` |
| `npm test` | Vitest unit tests (feeds, tracker, routing, parsers, scene maths) |
| `npm run test:smoke` | End-to-end checks in a real browser; needs a production build first |

The smoke test starts `next start` on port 3119 and drives the page with Playwright, so run `npm run build` first and install a browser once with `npx playwright install chromium`. The page checks use the frozen fixture; the two API checks call the live feeds, so they need network access. To test a server that is already running, set `SMOKE_URL`:

```bash
npm run build && npm run test:smoke
SMOKE_URL=http://localhost:3000 npm run test:smoke
```

No API keys or environment variables are needed. The `public/maplibre/` folder is generated on install and not committed.

## Regenerating the data

The airport layouts and procedures are committed, so you do not need to run either of these to use or change the app.

```bash
npm run airports                     # every airport, from OpenStreetMap via the Overpass API
node scripts/airports.mjs atl        # just ATL
node scripts/airports.mjs --cache .cache/overpass   # keep raw responses and reuse them next run

npm run procedures                   # every airport, from the FAA CIFP
node scripts/procedures.mjs atl      # just ATL
node scripts/procedures.mjs --file <path to FAACIFP18>
```

`npm run airports` queries the public Overpass servers one airport at a time and converts the result with `src/lib/airport-map.ts`, the same code the tests run. `npm run procedures` downloads the current 28-day CIFP cycle from the FAA into `.cache/` (not committed), and parses it with `src/lib/cifp.ts`. To add an airport, add it to `src/lib/airports.ts` and run both scripts for its code.

`node scripts/record-sequence.mjs` re-records `public/fixtures/atl-sequence.json.gz` from the live ATL feed (40 requests, 15 seconds apart).

## Data and licence

The code is MIT; see [LICENSE](LICENSE). The data files are not covered by it and keep their sources' terms.

| Data | Source | Terms |
|---|---|---|
| Airport layouts (`src/data/airports/`) | [OpenStreetMap](https://www.openstreetmap.org/copyright), through the [Overpass API](https://overpass-api.de) | (c) OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Credited in the app. Overpass's public servers ask for light use, which is why layouts are built once and committed, never per visitor. |
| Approaches and departures (`src/data/procedures/`) | FAA [Coded Instrument Flight Procedures](https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/) | US government work, public domain. Published every 28 days. |
| Live aircraft | [adsb.lol](https://adsb.lol) | ODbL, attribution asked. Credited in the app. |
| Live aircraft (fallback) | [adsb.fi](https://adsb.fi) | Personal use, at most one request per second, with a link to its home page. Credited in the app. |
| Flight routes | [adsbdb.com](https://www.adsbdb.com) | Free, no key. A route is used only when the airport being watched is one of its ends. |
| Weather (METAR) | [aviationweather.gov](https://aviationweather.gov/data/api/), NOAA Aviation Weather Center | US government work, public data API, at most 100 requests a minute, with a custom User-Agent. |
| Ground stops and delays | FAA [NAS status](https://nasstatus.faa.gov) | US government work, public feed. |
| Weather radar | [RainViewer](https://www.rainviewer.com/api/weather-maps-api.html) | Free, no key, for personal, educational and small community use; no SLA. "Weather data by RainViewer" is shown, linked, wherever the layer is on. Tiles go to zoom 7 and are recoloured per theme. |
| Aircraft photos | [Planespotters.net photo API](https://www.planespotters.net/photo/api) | Free, no key, one photo per aircraft. The photographer is credited beside the picture, linked to its page. A visitor's browser asks the API itself and loads the image from the returned URL; photos are never stored, re-hosted or proxied, and there is deliberately no server route for them. Proxying, rewriting URLs, re-exposing the data and training on it are not allowed. |
| Map tiles and glyphs | [OpenFreeMap](https://openfreemap.org) (OpenStreetMap data, OpenMapTiles schema) | Free, no key. Credited on the map. |
| Satellite imagery | [USGS National Map](https://basemap.nationalmap.gov) (USGSImageryOnly) | US government work. Credited on the map. |
| Airport reference points, elevations and time zones | [mwgg/Airports](https://github.com/mwgg/Airports), cross-checked against [OurAirports](https://ourairports.com/data/) | OurAirports data is public domain. |
| Fonts | Instrument Sans, Albert Sans, IBM Plex Mono, IBM Plex Sans Condensed, through `next/font/google` | SIL Open Font License. |
| Test and demo fixtures (`src/lib/__fixtures__/`, `public/fixtures/`) | Captured from adsb.lol (ODbL), adsbdb.com, aviationweather.gov, the FAA NAS status feed, FAA CIFP and OpenStreetMap | Each stays under its source's terms; see [NOTICE](NOTICE). |

If you run your own copy, be a good neighbour to these services: the app caches what it reads and backs off when it is rate limited, and your deployment should keep doing so. The Content-Security-Policy in `src/lib/csp.ts` names every third-party origin the browser may contact, so adding a new one is a visible change there.

Files that are not covered by the MIT licence, and the terms for the BadCodes name and logo, are listed in [NOTICE](NOTICE).
