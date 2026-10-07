import { busy, clientError, redirectToCanonical } from "@/lib/api-response";
import { readCell, regionPath } from "@/lib/region";
import { regionFeed } from "@/lib/region-feed";
import { UpstreamBusyError } from "@/lib/upstream";

/**
 * The live aircraft over one grid cell of the world, for the map at region zoom: `?lat=&lon=` names
 * any point in the cell. Callers anywhere in a cell get the same answer, so the CDN and each server
 * instance hold one entry per cell. The map reads each cell every ten seconds, so the CDN holds an
 * answer for ten and serves it stale for ten more while it refreshes: a cell costs adsb.lol about one
 * read per ten seconds per CDN region, however many people watch it. An answer is therefore at most
 * twenty seconds old when served, which the map's LIVE dot does not count (it ages only an answer
 * the server marks `stale`, so a cached fresh one never turns it orange) and its playback delay and
 * dead reckoning absorb. When adsb.lol fails, the cell's last good answer of up to 90 s ago is served
 * marked `stale` with its `ageS`, which the dot shows.
 *
 * The CDN keys on the whole URL, so `lat=1&lon=2&x=anything` and `lat=1.0001` would each be an entry of
 * their own for one cell, and a caller could walk past the cache at will. Only the cell's own address
 * (regionPath, which the map asks directly) is answered; any other spelling of a valid cell is a
 * permanent redirect to it, which costs no read and which the CDN holds.
 */

const CACHE = "public, s-maxage=10, stale-while-revalidate=10";
// A stale answer (the last good one, served while adsb.lol fails) is short-lived at the CDN so the first fresh read replaces it, and its ageS is read as of when it was made.
const STALE_CACHE = "public, s-maxage=5";
const FAILED_CACHE = "public, s-maxage=10";

export async function GET(req: Request) {
  const cell = readCell(new URL(req.url).searchParams);
  if (!cell) return clientError("lat and lon must be decimal degrees in range");
  const redirect = redirectToCanonical(req, regionPath(cell));
  if (redirect) return redirect;
  let answer;
  try {
    answer = await regionFeed.read(cell);
  } catch (error) {
    if (error instanceof UpstreamBusyError) return busy(error);
    throw error;
  }
  if (!answer) return Response.json({ error: "traffic unavailable" }, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
  if (answer.stale) return Response.json({ ...answer.snapshot, stale: true, ageS: answer.ageS }, { headers: { "Cache-Control": STALE_CACHE } });
  return Response.json(answer.snapshot, { headers: { "Cache-Control": CACHE } });
}
