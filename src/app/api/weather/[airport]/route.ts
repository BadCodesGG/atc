import { clientError, redirectToCanonical } from "@/lib/api-response";
import { airportByCode } from "@/lib/airports";
import { fetchMetar, type Metar } from "@/lib/metar";

/**
 * One airport's current METAR, parsed, as JSON: the scene's light and air and the wind readout. A
 * METAR is issued hourly (and specially when the weather turns), so the CDN holds an answer for five
 * minutes and each instance asks aviationweather.gov at most once per five minutes per airport, far
 * inside its 100 requests a minute. Only listed airports reach the upstream, by their ICAO code.
 *
 * The CDN keys on the whole URL, so a stray `?x=<random>` would be an entry of its own. Only the bare
 * lower-case address is answered (the only spelling `airportByCode` knows; any other is a 404); a query
 * string is a permanent redirect to it, and the page asks for it bare.
 */

const CACHE = "public, s-maxage=300, stale-while-revalidate=600";
const MEMO_MS = 300_000;
// The promise is stored, so requests arriving while the upstream is still answering share one read;
// a failure is remembered as long as a success, so an outage does not turn every request into a retry.
const memo = new Map<string, { at: number; metar: Promise<Metar | null> }>();

export async function GET(req: Request, ctx: RouteContext<"/api/weather/[airport]">) {
  const { airport: code } = await ctx.params;
  const airport = airportByCode(code);
  if (!airport) return clientError("unknown airport", 404);
  const redirect = redirectToCanonical(req, `/api/weather/${airport.code}`);
  if (redirect) return redirect;
  let hit = memo.get(airport.code);
  if (!hit || Date.now() - hit.at >= MEMO_MS) {
    hit = {
      at: Date.now(),
      metar: fetchMetar(airport).catch((error: unknown) => {
        console.error("metar", airport.code, error);
        return null;
      }),
    };
    memo.set(airport.code, hit);
  }
  const metar = await hit.metar;
  return metar
    ? Response.json(metar, { headers: { "Cache-Control": CACHE } })
    : Response.json({ error: "weather unavailable" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=30" } });
}
