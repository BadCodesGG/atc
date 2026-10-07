/**
 * Regenerates src/data/airports/<code>.json from OpenStreetMap (ODbL) via the Overpass API.
 *
 *   npm run airports                 all airports
 *   node scripts/airports.mjs atl    just those codes
 *   node scripts/airports.mjs --cache <dir>   keep raw responses in <dir> and reuse them on the next run
 *
 * The conversion is src/lib/airport-map.ts itself, loaded through Node's type stripping (Node 22.18+,
 * on by default from 23.6), so the script and the tests run identical logic. Airports go one at a
 * time to stay polite to the public servers.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AIRPORTS } from "../src/lib/airports.ts";
import { buildAirportMap, simplifyRing } from "../src/lib/airport-map.ts";
import { toGeo } from "../src/lib/geo.ts";

const ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const USER_AGENT = "atc (live airport visualisation)";
/** Half-width of the query box around the ARP. A bounding box is used because Overpass answers `around` on a bare key with a 504. */
const RADIUS_M = 6000;
const ATTEMPTS_PER_ENDPOINT = 3;
const MAX_BYTES = 1.5 * 1024 * 1024;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "airports");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HEAD = "[out:json][timeout:120];";

/**
 * The queries for one airport that need nothing but its position: the aeroway features in a box
 * around the ARP, and the tower tags people actually use. They are several small requests because
 * overpass-api.de answers anything that runs past about nine seconds with a 504, and one union of
 * all of it does at ATL and PIT.
 */
export function queriesFor(airport) {
  const dLat = RADIUS_M / 111_320;
  const dLon = RADIUS_M / (111_320 * Math.cos((airport.latitude * Math.PI) / 180));
  const box = [airport.latitude - dLat, airport.longitude - dLon, airport.latitude + dLat, airport.longitude + dLon].map((v) => v.toFixed(5)).join(",");
  const aeroway = (values) => `${HEAD}nwr["aeroway"~"^(${values})$"](${box});out geom;`;
  return [
    aeroway("runway|taxiway|taxilane|apron|terminal|hangar|aerodrome"),
    aeroway("gate|parking_position|holding_position"),
    aeroway("windsock|tower|control_tower|navigationaid"),
    `${HEAD}(nwr["man_made"="tower"]["tower:type"~"^(observation|airport_control)$"](${box});nwr["man_made"="tower"]["service"~"^(air_traffic_control|aircraft_control)$"](${box}););out geom;`,
  ];
}

/**
 * Buildings inside the aerodrome. Asking for them by the aerodrome's derived area runs past the
 * gateway limit, so the outline found by the other queries goes back as a polygon filter, thinned
 * to 15 m so the request stays small.
 */
export function buildingsQuery(airport, raw) {
  const { boundary } = buildAirportMap(raw, airport);
  if (!boundary.length) return `${HEAD}area["aeroway"="aerodrome"]["icao"="${airport.icao}"]->.ad;nwr["building"](area.ad);out geom;`;
  const poly = simplifyRing(boundary[0], 15)
    .map(([x, y]) => toGeo(airport, x, y).map((v) => v.toFixed(5)).join(" "))
    .join(" ");
  return `${HEAD}nwr["building"](poly:"${poly}");out geom;`;
}

async function post(endpoint, query) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }),
  });
  if (!res.ok) throw new Error(`${endpoint} answered ${res.status}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${endpoint} sent a non-JSON body: ${text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160)}`);
  }
  // Overpass reports a timed-out or out-of-memory query as a 200 with a remark and partial data.
  if (json.remark && /error|timed out|out of memory/i.test(json.remark)) throw new Error(`${endpoint} remark: ${json.remark}`);
  return json;
}

async function fetchOverpass(query) {
  let last;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_ENDPOINT; attempt++) {
      try {
        return await post(endpoint, query);
      } catch (err) {
        last = err;
        console.warn(`  ${err.message} (attempt ${attempt + 1}/${ATTEMPTS_PER_ENDPOINT})`);
        if (attempt < ATTEMPTS_PER_ENDPOINT - 1) await sleep(30_000 * 2 ** attempt);
      }
    }
    console.warn(`  giving up on ${endpoint}`);
  }
  throw last;
}

async function main() {
  const args = process.argv.slice(2);
  const cacheAt = args.indexOf("--cache");
  const cacheDir = cacheAt >= 0 ? args.splice(cacheAt, 2)[1] : null;
  const wanted = args.length ? args : AIRPORTS.map((a) => a.code);
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const code of wanted) {
    const airport = AIRPORTS.find((a) => a.code === code);
    if (!airport) throw new Error(`unknown airport "${code}"`);
    console.log(`${airport.icao}: ${airport.name}`);

    const cached = cacheDir ? path.join(cacheDir, `${code}.json`) : null;
    let raw;
    if (cached && fs.existsSync(cached)) {
      raw = JSON.parse(fs.readFileSync(cached, "utf8"));
      console.log(`  raw response from ${cached}`);
    } else {
      const seen = new Set();
      raw = { elements: [] };
      const add = (json) => {
        for (const el of json.elements) {
          const key = `${el.type}/${el.id}`;
          if (seen.has(key)) continue;
          raw.elements.push(el);
          seen.add(key);
        }
      };
      for (const query of queriesFor(airport)) {
        add(await fetchOverpass(query));
        await sleep(6_000);
      }
      add(await fetchOverpass(buildingsQuery(airport, raw)));
      if (cached) fs.writeFileSync(cached, JSON.stringify(raw));
    }
    console.log(`  ${raw.elements.length} OSM elements`);

    let map = buildAirportMap(raw, airport);
    let text = JSON.stringify(map);
    if (Buffer.byteLength(text) > MAX_BYTES) {
      const before = Buffer.byteLength(text);
      map = buildAirportMap(raw, airport, { minBuildingArea: 30 });
      text = JSON.stringify(map);
      console.log(`  ${(before / 1024).toFixed(0)} KB is over budget, dropped buildings under 30 m2`);
    }
    if (!map.boundary.length) console.warn("  warning: no aerodrome boundary found");

    const file = path.join(OUT_DIR, `${code}.json`);
    fs.writeFileSync(file, text + "\n");
    const counts = Object.entries(map)
      .filter(([, v]) => Array.isArray(v))
      .map(([k, v]) => `${k} ${v.length}`)
      .join(", ");
    console.log(`  wrote ${path.relative(process.cwd(), file)} (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB): ${counts}`);

    if (code !== wanted[wanted.length - 1]) await sleep(5_000);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
