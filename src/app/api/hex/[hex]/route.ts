import { busy, clientError, redirectToCanonical } from "@/lib/api-response";
import { readHex } from "@/lib/hex";
import { hexFeed } from "@/lib/hex-feed";
import { UpstreamBusyError } from "@/lib/upstream";

/**
 * One aircraft anywhere by its ICAO address, for gate to gate: the page follows the flight with this
 * between its two airports. The hex comes from the request, so only six hex digits pass (`readHex`)
 * before anything is remembered or any URL is built. As /api/region does, the CDN holds an answer for four
 * seconds and serves it stale for up to twenty while it refreshes; when adsb.lol fails, the aircraft's
 * last good answer of up to 90 s ago is served marked `stale` with its `ageS`. An address with no
 * position is held longer (hex-feed.ts), and when the server's cap on upstream requests is spent the
 * answer is a 503 with Retry-After.
 *
 * The CDN keys on the whole URL, so `ABCDEF` and its 63 other spellings would each be an entry of their
 * own for one aircraft. Only the lower-case address is answered; any other spelling of a valid hex is a
 * permanent redirect to it. The page asks for it lower-cased, so it never meets the redirect.
 */

const CACHE = "public, s-maxage=4, stale-while-revalidate=20";
const STALE_CACHE = "public, s-maxage=2";
const FAILED_CACHE = "public, s-maxage=4";

export async function GET(req: Request, ctx: RouteContext<"/api/hex/[hex]">) {
  const hex = readHex((await ctx.params).hex);
  if (!hex) return clientError("not an ICAO hex address");
  const redirect = redirectToCanonical(req, `/api/hex/${hex}`);
  if (redirect) return redirect;
  let answer;
  try {
    answer = await hexFeed.read(hex);
  } catch (error) {
    if (error instanceof UpstreamBusyError) return busy(error);
    throw error;
  }
  if (!answer) return Response.json({ error: "aircraft unavailable" }, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
  if (answer.stale) return Response.json({ ...answer.snapshot, stale: true, ageS: answer.ageS }, { headers: { "Cache-Control": STALE_CACHE } });
  return Response.json(answer.snapshot, { headers: { "Cache-Control": CACHE } });
}
