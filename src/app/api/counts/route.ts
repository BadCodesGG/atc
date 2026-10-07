import { busy, redirectToCanonical } from "@/lib/api-response";
import { AIRPORTS } from "@/lib/airports";
import { regionFeed } from "@/lib/region-feed";
import { UpstreamBusyError } from "@/lib/upstream";

/**
 * Every listed airport's live count (aircraft within 20 NM, and how many are on the ground), for the
 * world map's airport markers. Read off the same region cells as /api/region, so the counts cost one
 * upstream read per cell, not one per airport, and a request reads only the cells the feed already holds
 * plus a couple of others, one after another (see RegionFeed.counts), so the markers fill in over a few
 * minutes instead of bursting on adsb.lol. A count moves slowly at world zoom, so the CDN keeps it for a
 * minute and serves it stale for five more while it refreshes. An airport with no count yet is left out
 * rather than shown as zero.
 *
 * The request carries nothing, so only the bare address is answered: the CDN keys on the whole URL, and
 * a stray `?x=1` would be an entry of its own, and a way to start two cold cell reads a request. Any
 * query string is a permanent redirect to it, and the page asks for it bare.
 */

const CACHE = "public, s-maxage=60, stale-while-revalidate=300";
const FAILED_CACHE = "public, s-maxage=10";

export async function GET(req: Request) {
  const redirect = redirectToCanonical(req, "/api/counts");
  if (redirect) return redirect;
  let counts;
  try {
    counts = await regionFeed.counts(AIRPORTS);
  } catch (error) {
    // The server's cap on upstream requests is spent and no airport has a count to show yet.
    if (error instanceof UpstreamBusyError) return busy(error);
    throw error;
  }
  if (Object.keys(counts).length === 0) return Response.json({ error: "traffic unavailable" }, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
  return Response.json({ time: Date.now() / 1000, counts }, { headers: { "Cache-Control": CACHE } });
}
