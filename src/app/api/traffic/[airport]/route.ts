import { after } from "next/server";
import { busy, clientError, redirectToCanonical } from "@/lib/api-response";
import { airportByCode } from "@/lib/airports";
import { RouteBook } from "@/lib/routes";
import { trafficFeed } from "@/lib/traffic-feed";
import { UpstreamBusyError } from "@/lib/upstream";

/**
 * The live aircraft around one airport as JSON. Clients poll every few seconds, so the CDN holds a
 * response for four and serves it stale for up to twenty while it refreshes, and each server instance
 * asks adsb.lol at most once per four seconds per airport however many requests reach it. When adsb.lol
 * fails (it answers 429 to about one poll in three under load) the last good snapshot of up to 90 s ago
 * is served marked `stale`, and after a 429 the upstream is left alone for a while (see traffic-feed.ts).
 *
 * Each answer carries the routes already known for its callsigns (where they fly from and to). The
 * callsigns come from adsb.lol's answer, never from the request, and the lookups for the ones not yet
 * known run after the response, so the board fills in over a few polls.
 *
 * The CDN keys on the whole URL, so a stray `?x=<random>` would be an entry of its own and a cold read of
 * the airport's feed. Only the bare lower-case address is answered (the only spelling `airportByCode`
 * knows; any other is a 404); a query string is a permanent redirect to it, and the page asks for it bare.
 */

const CACHE = "public, s-maxage=4, stale-while-revalidate=20";
// A stale answer is short-lived at the CDN so the first fresh read replaces it.
const STALE_CACHE = "public, s-maxage=2";
const FAILED = { error: "traffic unavailable" };
const FAILED_CACHE = "public, s-maxage=4";
const books = new Map<string, RouteBook>();

export async function GET(req: Request, ctx: RouteContext<"/api/traffic/[airport]">) {
  const { airport: code } = await ctx.params;
  // Only listed airports reach the upstream: the URL is built from their coordinates, never from the request.
  const airport = airportByCode(code);
  if (!airport) return clientError("unknown airport", 404);
  const redirect = redirectToCanonical(req, `/api/traffic/${airport.code}`);
  if (redirect) return redirect;
  let answer;
  try {
    answer = await trafficFeed.read(airport);
  } catch (error) {
    if (error instanceof UpstreamBusyError) return busy(error);
    throw error;
  }
  if (!answer) return Response.json(FAILED, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
  let book = books.get(airport.code);
  if (!book) books.set(airport.code, (book = new RouteBook(airport)));
  const callsigns = new Set(answer.snapshot.aircraft.flatMap((a) => (a.callsign ? [a.callsign] : [])));
  const { routes, work } = book.routesFor(callsigns);
  after(() => work);
  if (answer.stale) return Response.json({ ...answer.snapshot, routes, stale: true, ageS: answer.ageS }, { headers: { "Cache-Control": STALE_CACHE } });
  return Response.json({ ...answer.snapshot, routes }, { headers: { "Cache-Control": CACHE } });
}
