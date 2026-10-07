import type { Airport } from "./airports";
import type { FlightRoute } from "./routes";
import { parseTraffic, type TrafficSnapshot } from "./traffic";

/**
 * The fixture (`?fixture=1`): recorded moments, so a page or a shot is reproducible and never touches
 * the live feed. Atlanta has its own recording; Dallas-Fort Worth is cut from the region recorded round
 * it (the same adsb.lol answer, read at a wider radius), each with the routes looked up for its flights.
 * Any other airport has no recording, and its diorama stands empty.
 */
const RECORDINGS: Partial<Record<Airport["code"], () => Promise<[{ default: unknown }, { default: unknown }]>>> = {
  atl: () => Promise.all([import("./__fixtures__/adsblol_atl.json"), import("./__fixtures__/routes_atl.json")]),
  dfw: () => Promise.all([import("./__fixtures__/adsblol_region_dfw.json"), import("./__fixtures__/routes_dfw.json")]),
};

export async function recordedTraffic(airport: Airport): Promise<{ snapshot: TrafficSnapshot; routes: Record<string, FlightRoute> } | null> {
  const load = RECORDINGS[airport.code];
  if (!load) return null;
  const [traffic, routes] = await load();
  return { snapshot: parseTraffic(traffic.default, airport), routes: routes.default as Record<string, FlightRoute> };
}
