/**
 * Regenerates src/data/procedures/<code>.json from the FAA's CIFP (FAACIFP18, ARINC 424): each
 * runway's final approach and its SIDs' runway transitions, with the cycle they come from.
 *
 *   npm run procedures                          every airport
 *   node scripts/procedures.mjs atl             just those codes
 *   node scripts/procedures.mjs --file <path>   an FAACIFP18 already on disk
 *
 * Without --file it uses .cache/cifp/FAACIFP18 when that file is the current cycle's, and otherwise
 * downloads the current cycle's zip from the FAA (published every 28 days, free) into .cache/cifp/
 * and takes FAACIFP18 out of it. The raw file is never committed.
 *
 * The parsing is src/lib/cifp.ts itself, loaded through Node's type stripping (Node 22.18+, on by
 * default from 23.6), so the script and the tests run identical logic.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { AIRPORTS } from "../src/lib/airports.ts";
import { parseCifp } from "../src/lib/cifp.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache", "cifp");
const OUT_DIR = path.join(ROOT, "src", "data", "procedures");
const PAGE = "https://www.faa.gov/air_traffic/flight_info/aeronav/digital_products/cifp/download/";
const USER_AGENT = "atc (live airport visualisation)";
/** The leg types src/lib/procedure-path.ts draws; anything else it skips (holds, procedure turns, DME arcs). */
const DRAWN = new Set(["IF", "TF", "CF", "DF", "RF", "VA", "CA", "FA", "VI", "CI", "VM", "FM", "FC", "VD", "CD", "VR", "CR"]);

/** The one entry `name` out of a zip, read through its central directory (deflate or stored). */
function unzipEntry(zip, name) {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip file");
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const entry = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (entry === name) {
      const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const raw = zip.subarray(data, data + size);
      return method === 0 ? raw : zlib.inflateRawSync(raw);
    }
    at += 46 + nameLength + extra + comment;
  }
  throw new Error(`no ${name} in the zip`);
}

/** The current cycle's zip URL, the newest one the FAA's download page lists ("CIFP_261001.zip"). */
async function currentZip() {
  const res = await fetch(PAGE, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${PAGE} answered ${res.status}`);
  const urls = [...new Set((await res.text()).match(/https?:\/\/[^"']+\/CIFP_\d{6}\.zip/g) ?? [])].sort();
  const today = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  // The page lists the current cycle and, near a changeover, the next: the newest already in effect.
  const current = urls.filter((u) => u.match(/CIFP_(\d{6})\.zip/)[1] <= today).at(-1);
  if (!current) throw new Error(`no CIFP zip in effect listed on ${PAGE}`);
  return current;
}

async function cifpText(file) {
  if (file) return fs.readFileSync(file, "latin1");
  fs.mkdirSync(CACHE, { recursive: true });
  const url = await currentZip();
  const zipPath = path.join(CACHE, path.basename(url));
  const raw = path.join(CACHE, "FAACIFP18");
  const stamp = path.join(CACHE, "FAACIFP18.from");
  if (fs.existsSync(raw) && fs.existsSync(stamp) && fs.readFileSync(stamp, "utf8") === path.basename(url)) {
    console.log(`using ${path.relative(ROOT, raw)} (${path.basename(url)})`);
    return fs.readFileSync(raw, "latin1");
  }
  if (!fs.existsSync(zipPath)) {
    console.log(`downloading ${url}`);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  const data = unzipEntry(fs.readFileSync(zipPath), "FAACIFP18");
  fs.writeFileSync(raw, data);
  fs.writeFileSync(stamp, path.basename(url));
  return data.toString("latin1");
}

/** Six decimals of a degree is about 0.1 m. */
const round = (key, value) => (typeof value === "number" && (key === "lat" || key === "lon") ? Math.round(value * 1e6) / 1e6 : value);

async function main() {
  const args = process.argv.slice(2);
  const fileAt = args.indexOf("--file");
  const file = fileAt >= 0 ? args.splice(fileAt, 2)[1] : null;
  const wanted = (args.length ? args : AIRPORTS.map((a) => a.code)).map((code) => {
    const airport = AIRPORTS.find((a) => a.code === code);
    if (!airport) throw new Error(`unknown airport "${code}"`);
    return airport;
  });

  const { cycle, effective, airports } = parseCifp(await cifpText(file), wanted.map((a) => a.icao));
  if (!cycle) throw new Error("no HDR01 record: is this FAACIFP18?");
  console.log(`CIFP cycle ${cycle}, effective ${effective}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const skipped = new Map();
  for (const airport of wanted) {
    const procedures = airports[airport.icao];
    if (!procedures) {
      console.warn(`${airport.icao}: not in the file`);
      continue;
    }
    const departures = Object.values(procedures.departures).flat();
    for (const leg of [...Object.values(procedures.approaches).flatMap((a) => a.legs), ...departures.flatMap((d) => d.legs)]) {
      if (!DRAWN.has(leg.type)) skipped.set(leg.type, (skipped.get(leg.type) ?? 0) + 1);
    }
    const text = JSON.stringify({ source: "FAA CIFP", cycle, effective, ...procedures }, round);
    const out = path.join(OUT_DIR, `${airport.code}.json`);
    fs.writeFileSync(out, text + "\n");
    const runways = Object.keys(procedures.departures).length;
    console.log(
      `${airport.icao}: ${Object.keys(procedures.approaches).length} runways with an approach (${Object.values(procedures.approaches)
        .map((a) => a.ident)
        .join(" ")}), ${departures.length} SID transitions over ${runways} runways, ${procedures.unresolved} procedures dropped for an unplaced fix; ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`,
    );
  }
  console.log(skipped.size ? `leg types kept but not drawn: ${[...skipped].map(([t, n]) => `${t} ${n}`).join(", ")}` : "every leg type kept is drawn");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
