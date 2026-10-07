import type { Airport } from "./airports";
import { parseTraffic, type TrafficSnapshot } from "./traffic";

/**
 * The recorded sequence behind `?fixture=sequence` (public/fixtures/atl-sequence.json.gz, written by
 * scripts/record-sequence.mjs): adsb.lol answers for ATL, 15 s apart, which the page loads as if it had
 * been open the whole time.
 */

export const SEQUENCE_URL = "/fixtures/atl-sequence.json.gz";

/** Reads the file's bytes, gzipped or (if a server has unpacked it on the way) not. */
export async function readSequence(bytes: ArrayBuffer, airport: Airport): Promise<TrafficSnapshot[]> {
  const head = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  const text = gzipped ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text() : new TextDecoder().decode(bytes);
  const body = JSON.parse(text) as { snapshots?: unknown };
  if (!Array.isArray(body.snapshots)) throw new Error("sequence: no snapshots");
  return body.snapshots.map((raw) => parseTraffic(raw, airport));
}
