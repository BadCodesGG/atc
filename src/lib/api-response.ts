import type { UpstreamBusyError } from "./upstream";

/**
 * The answers the API routes share when the request itself is the problem. A 4xx says something about
 * what one caller typed or what this server is doing for the moment, never about the resource, so no
 * cache keeps it: a shared one would hand a stranger's malformed URL, or a busy moment, to everyone
 * asking the same URL for as long as it held it.
 */

export const NO_STORE = "no-store";

/** What a redirect to a canonical address keeps in a cache: the address a spelling names never changes. */
export const REDIRECT_CACHE = "public, max-age=3600, s-maxage=86400";

/**
 * Null when the request is for exactly `canonical` (its path and query, as they print); otherwise the
 * permanent redirect to it. The CDN keys on the whole URL, so every other spelling of one resource
 * ("ABCDEF" for "abcdef", a stray `?x=1`) would be an entry of its own and a way past the cache. The
 * redirect costs no upstream read, and the CDN holds it. Every novel spelling is still a CDN miss and a
 * function invocation before the redirect, which no code can remove; the per-IP Vercel Firewall rule
 * (600 requests per 60 seconds) bounds it.
 */
export function redirectToCanonical(req: Request, canonical: string): Response | null {
  const { pathname, search } = new URL(req.url);
  if (pathname + search === canonical) return null;
  return new Response(null, { status: 308, headers: { Location: canonical, "Cache-Control": REDIRECT_CACHE } });
}

/** A 4xx: `error` says what was wrong with the request. */
export function clientError(error: string, status: 400 | 404 = 400): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": NO_STORE } });
}

/** The server's cap on requests to its upstreams is spent and nothing recent is held to answer with: try again after `Retry-After` seconds. */
export function busy(error: UpstreamBusyError): Response {
  return Response.json({ error: "busy, try again shortly" }, { status: 503, headers: { "Cache-Control": NO_STORE, "Retry-After": error.retryAfter ?? "1" } });
}
