import { redirectToCanonical } from "@/lib/api-response";
import { fetchStatus, type NasStatus } from "@/lib/faa-status";

/**
 * The FAA's delay programs at every US airport that has one, as JSON: one small document, so a
 * flight's card can show what is slowing both ends of its route. The FAA updates the feed every
 * minute or so; the CDN holds an answer for a minute and each instance reads the feed at most once
 * a minute. The request carries nothing that reaches the upstream, so only the bare address is answered:
 * the CDN keys on the whole URL, and every `?x=<random>` would be an entry of its own and a function run.
 * Any query string is a permanent redirect to it, and the page asks for it bare.
 */

const CACHE = "public, s-maxage=60, stale-while-revalidate=120";
const MEMO_MS = 60_000;
let memo: { at: number; status: Promise<NasStatus | null> } | null = null;

export async function GET(req: Request) {
  const redirect = redirectToCanonical(req, "/api/status");
  if (redirect) return redirect;
  if (!memo || Date.now() - memo.at >= MEMO_MS) {
    memo = {
      at: Date.now(),
      status: fetchStatus().catch((error: unknown) => {
        console.error("faa status", error);
        return null;
      }),
    };
  }
  const current = await memo.status;
  return current
    ? Response.json(current, { headers: { "Cache-Control": CACHE } })
    : Response.json({ error: "status unavailable" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=30" } });
}
