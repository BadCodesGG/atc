import { airportByCode } from "./airports";
import { fixtureSource, type FeedSource, liveSource } from "./feed-source";

/** The most of the wall's time the recording plays between two reads of its clock, seconds. */
const MAX_STEP_S = 0.1;

/**
 * The page's feed source, chosen once from the address: `?fixture=journey` plays the gate-to-gate
 * recording (journey-fixture.ts) compressed, answering the same API paths the live feed does; anything
 * else is the network. With the fixture, `&fixtureFrom=` starts that many seconds into the recording,
 * `&pace=` scales its speed (below 1 is slower), so a shot can catch one moment of it, and `&route=none`
 * or `&route=unbuilt` changes what the route lookups say, for the journey's other ends. `&gap=A:B` (seconds
 * into the recording, a negative one counted back from its end, B left out for ever) has the flight's
 * transponder fall silent from A to B: its last position is listed ever older until the feeds drop it,
 * the way a live one loses an aircraft taxiing behind a terminal or parked at a gate. Several, comma apart.
 */
export async function feedSourceFor(params: URLSearchParams): Promise<FeedSource> {
  if (params.get("fixture") !== "journey") return liveSource();
  const [{ loadAirportMap }, { journeyAnswer, journeyPlan, readSilences, recordJourney, WarpClock, withRoute }, recorded] = await Promise.all([
    import("./airport-data"),
    import("./journey-fixture"),
    import("./__fixtures__/adsblol_atl.json"),
  ]);
  const atl = airportByCode("atl")!;
  const clt = airportByCode("clt")!;
  const [atlMap, cltMap] = await Promise.all([loadAirportMap(atl.code), loadAirportMap(clt.code)]);
  const flown = recordJourney(journeyPlan({ airport: atl, map: atlMap }, { airport: clt, map: cltMap }));
  const route = params.get("route");
  const rec = route === "none" || route === "unbuilt" ? withRoute(flown, route) : flown;
  const clock = new WarpClock(rec, { from: Number(params.get("fixtureFrom")) || 0, speed: Number(params.get("pace")) || 1 });
  const silences = readSilences(params.get("gap"), rec.samples[0].t, rec.samples.at(-1)!.t);
  // Atlanta's gates as they were recorded, so the flight leaves from a working airport.
  const parked = (recorded.default.ac as Record<string, unknown>[]).filter((r) => r.alt_baro === "ground" && typeof r.gs === "number" && r.gs < 1).map((r) => ({ ...r, seen_pos: 0, seen: 0 }));
  // Wall seconds played: a stalled page (a long frame, a busy machine) pauses the recording rather than
  // skipping it, so the aircraft is never past its last answer for longer than the trackers allow.
  let played = 0;
  let last = performance.now();
  const now = () => {
    const t = performance.now();
    played += Math.min(MAX_STEP_S, (t - last) / 1000);
    last = t;
    return clock.at(played);
  };
  return fixtureSource((path, t) => journeyAnswer(rec, path, t, { atl: parked }, silences), now);
}
