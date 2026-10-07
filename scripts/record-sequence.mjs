/**
 * Records a sequence of live ATL snapshots for `?fixture=sequence`: the page replays it as if it had
 * been open that long. adsb.lol is rate limited and shared, so this asks it at most COUNT times, one
 * request every INTERVAL_MS, one after the other, and never retries a failed request.
 *
 *   node scripts/record-sequence.mjs
 *
 * Writes public/fixtures/atl-sequence.json.gz: `{ airport, interval, snapshots }`, each snapshot an
 * adsb.lol answer cut down to the fields src/lib/traffic.ts reads.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "public", "fixtures", "atl-sequence.json.gz");
// The same URL the traffic route asks for ATL (src/lib/traffic.ts trafficUrl, RADIUS_NM 20).
const URL = "https://api.adsb.lol/v2/point/33.6367/-84.4281/20";
const COUNT = 40;
const INTERVAL_MS = 15_000;
/** Everything parseTraffic reads; the rest of each record is dropped. */
const FIELDS = ["hex", "type", "flight", "r", "t", "dbFlags", "category", "lat", "lon", "seen_pos", "seen", "gs", "alt_baro", "alt_geom", "track", "true_heading", "baro_rate", "geom_rate", "squawk"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snapshots = [];
for (let i = 0; i < COUNT; i++) {
  const started = Date.now();
  try {
    const res = await fetch(URL, { signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "atc (live airport visualisation)", Accept: "application/json" } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = await res.json();
    const ac = (body.ac ?? []).map((a) => Object.fromEntries(FIELDS.filter((f) => a[f] !== undefined).map((f) => [f, a[f]])));
    snapshots.push({ now: body.now, ac });
    console.log(`${i + 1}/${COUNT}  ${new Date(body.now).toISOString()}  ${ac.length} aircraft`);
  } catch (error) {
    console.log(`${i + 1}/${COUNT}  failed: ${error.message}`);
  }
  if (i < COUNT - 1) await sleep(Math.max(0, INTERVAL_MS - (Date.now() - started)));
}

mkdirSync(path.dirname(OUT), { recursive: true });
const json = JSON.stringify({ airport: "atl", interval: INTERVAL_MS / 1000, snapshots });
const gz = gzipSync(json, { level: 9 });
writeFileSync(OUT, gz);
console.log(`wrote ${path.relative(ROOT, OUT)}: ${snapshots.length} snapshots, ${json.length} bytes of JSON, ${gz.length} gzipped`);
