import { busy, clientError, redirectToCanonical } from "@/lib/api-response";
import { findFlight, type FlightLookup, lookupCallsign } from "@/lib/flight-lookup";
import { UpstreamBusyError } from "@/lib/upstream";

/**
 * One flight anywhere, by callsign or flight number ("DAL3104", "DL3104"): where it is now, and its
 * route where adsbdb knows it. The search box asks this when nothing at the airport on screen matches.
 *
 * The value comes from a person's typing, so it is validated (`lookupCallsign`) before anything is
 * remembered or any URL is built: a value that is not a callsign is a 400 that touches nothing, and
 * the memo is keyed by the callsign it names, so "dl3104" and "DAL3104" share an entry. The CDN keys on
 * the URL as typed, so every spelling ("dl3104", "Dal3104", "DAL3104") would be an entry of its own: only
 * the callsign itself is answered, and any other spelling is a permanent redirect to it (the search box
 * and the journey ask for it already normalised). Answers are held
 * for fifteen seconds per callsign, "not airborne" and failures included, so an outage or a repeated
 * query does not become a retry per keystroke. When the server's cap on upstream requests is spent the
 * answer is a 503 with Retry-After, and is not remembered.
 */

const CACHE = "public, s-maxage=15, stale-while-revalidate=30";
const FAILED_CACHE = "public, s-maxage=15";
const MEMO_MS = 15_000;
/** Longest value worth looking at: a flight number is at most eight characters, with room for padding. */
const MAX_TYPED = 12;
/** Callsigns remembered; the oldest are forgotten first. */
const MAX_ENTRIES = 200;
type Settled = FlightLookup | { kind: "failed" } | { kind: "busy"; error: UpstreamBusyError };
const memo = new Map<string, { at: number; lookup: Promise<Settled> }>();

export async function GET(req: Request, ctx: RouteContext<"/api/flight/[callsign]">) {
  const { callsign: typed } = await ctx.params;
  const callsign = typed.length <= MAX_TYPED ? lookupCallsign(typed) : null;
  if (!callsign) return clientError("not a callsign");
  const redirect = redirectToCanonical(req, `/api/flight/${callsign}`);
  if (redirect) return redirect;
  const hit = memo.get(callsign);
  let lookup: Promise<Settled>;
  if (hit && Date.now() - hit.at < MEMO_MS) {
    lookup = hit.lookup;
  } else {
    lookup = findFlight(callsign).catch((error: unknown): Settled => {
      if (error instanceof UpstreamBusyError) {
        // Not an answer about the flight: asked again next time.
        if (memo.get(callsign)?.lookup === lookup) memo.delete(callsign);
        return { kind: "busy", error };
      }
      console.error("flight", error);
      return { kind: "failed" };
    });
    memo.delete(callsign);
    memo.set(callsign, { at: Date.now(), lookup });
    if (memo.size > MAX_ENTRIES) memo.delete(memo.keys().next().value!);
  }
  const found = await lookup;
  if (found.kind === "busy") return busy(found.error);
  if (found.kind === "failed") return Response.json({ error: "flight lookup unavailable" }, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
  if (found.kind === "bad") return clientError("not a callsign");
  if (found.kind === "none") return clientError("not airborne", 404);
  return Response.json(found.flight, { headers: { "Cache-Control": CACHE } });
}
