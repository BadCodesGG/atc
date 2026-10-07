import { busy, clientError, redirectToCanonical } from "@/lib/api-response";
import { readSquawk } from "@/lib/squawk";
import { squawkFeed } from "@/lib/squawk-feed";
import { UpstreamBusyError } from "@/lib/upstream";

/**
 * Who is squawking 7700, 7600 or 7500 right now, for the alerts. The code comes from the request, so
 * only those three pass (`readSquawk`) before any URL is built. As /api/hex does, the CDN holds an answer
 * for four seconds and serves it stale for up to twenty while it refreshes; when adsb.lol fails, the
 * code's last good answer of up to 90 s ago is served marked `stale` with its `ageS`.
 *
 * The CDN keys on the whole URL, so a stray `?x=<random>` would be an entry of its own for each of the
 * three codes. Only the bare address is answered; a query string is a permanent redirect to it, and the
 * alerts ask for it bare.
 */

const CACHE = "public, s-maxage=4, stale-while-revalidate=20";
const STALE_CACHE = "public, s-maxage=2";
const FAILED_CACHE = "public, s-maxage=4";

export async function GET(req: Request, ctx: RouteContext<"/api/squawk/[code]">) {
  const code = readSquawk((await ctx.params).code);
  if (!code) return clientError("not an emergency squawk code");
  const redirect = redirectToCanonical(req, `/api/squawk/${code}`);
  if (redirect) return redirect;
  let answer;
  try {
    answer = await squawkFeed.read(code);
  } catch (error) {
    if (error instanceof UpstreamBusyError) return busy(error);
    throw error;
  }
  if (!answer) return Response.json({ error: "squawks unavailable" }, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
  if (answer.stale) return Response.json({ ...answer.snapshot, stale: true, ageS: answer.ageS }, { headers: { "Cache-Control": STALE_CACHE } });
  return Response.json(answer.snapshot, { headers: { "Cache-Control": CACHE } });
}
