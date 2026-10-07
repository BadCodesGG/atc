/**
 * Smoke checks for the published approach and climb-out paths (src/data/procedures, from the FAA's
 * CIFP): on the frozen fixture at ATL, and at ORD and HNL (which have no recorded fixture) on one
 * stubbed aircraft each, as smoke.mjs stubs the flight lookup. scripts/smoke.mjs runs them with the
 * rest; on their own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3124 node scripts/smoke-procedures.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AIRPORTS } from "../src/lib/airports.ts";
import { toGeo } from "../src/lib/geo.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One stubbed aircraft at `code` on runway end `ref` (the map's zero-padded ref): lined up on it, or
 * 6 km out on its final at three degrees. The page's live traffic request answers with it alone.
 */
async function stubOne(page, code, ref, kind) {
  const airport = AIRPORTS.find((a) => a.code === code);
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/airports", `${code}.json`), "utf8"));
  const runway = map.runways.find((r) => r.ends.length === 2 && r.ends.some((e) => e.ref === ref));
  const [a, b] = runway.ends[0].ref === ref ? runway.ends : [...runway.ends].reverse();
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const [ux, uy] = [(b.x - a.x) / len, (b.y - a.y) / len];
  const along = kind === "departure" ? 40 : -6000;
  const [x, y] = [a.x + ux * along, a.y + uy * along];
  const [latitude, longitude] = toGeo(airport, x, y);
  const air = kind === "arrival";
  const plane = {
    id: "5eed01", callsign: "SMK1", registration: null, typeCode: "B738", military: false, category: "A3", latitude, longitude, x, y,
    altitudeFt: air ? airport.elevationFt + 50 + (6000 * Math.tan(Math.PI / 60)) / 0.3048 : 0,
    onGround: !air, groundSpeedKt: air ? 140 : 0, trackDeg: ((Math.atan2(ux, uy) * 180) / Math.PI + 360) % 360, verticalRateFpm: air ? -700 : 0,
    positionAge: 0, source: "adsb_icao", squawk: null,
  };
  await page.route(`**/api/traffic/${code}`, (route) => route.fulfill({ json: { airport: code, time: Math.floor(Date.now() / 1000), aircraft: [plane] } }));
}

/** Runs the checks in `browser` against `base`, reporting each through `check(name, ok, detail)`. */
export async function procedureChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const cited = async (callsign, on = page) => {
    const card = on.locator("section[aria-label^='Selected flight']");
    await card.locator("h2", { hasText: callsign }).waitFor({ timeout: 30_000 });
    await card.locator("[data-procedure]").waitFor({ timeout: 10_000 }).catch(() => {});
    return card.locator("[data-procedure]").innerText().catch(() => null);
  };

  // RPA4349 is on final to 8L: its path runs down the ILS, cited with the cycle.
  await page.goto(`${base}/?fixture=1&flight=RPA4349`);
  const approach = await cited("RPA4349");
  check("an arrival on final cites the approach its path follows, with the CIFP cycle", /^Approach: ILS RWY 8L, from FAA CIFP cycle \d{4}$/.test(approach ?? ""), approach ?? "no citation");

  // DAL753 is taxiing out for San Francisco: its climb-out is the SID that leaves toward it, said to be a guess.
  await page.goto(`${base}/?fixture=1&flight=DAL753`);
  const climb = await cited("DAL753");
  check("a departure with a destination cites its likely SID, with the CIFP cycle", /^Likely climb-out: CUTTN2 departure, from FAA CIFP cycle \d{4}$/.test(climb ?? ""), climb ?? "no citation");

  await page.close();

  // ORD has no SID in the file at all: a departure's climb-out is the extended centreline, and the card says why.
  const ord = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await stubOne(ord, "ord", "28R", "departure");
  await ord.goto(`${base}/?airport=ord&flight=SMK1`);
  const silence = await cited("SMK1", ord);
  check("a departure at an airport with no SID in the file says so", /^Climb-out: extended centreline, as FAA CIFP cycle \d{4} has no SID for this airport$/.test(silence ?? ""), silence ?? "no citation");
  await ord.close();

  // HNL's 26L has no ILS: its arrivals come down the RNAV (RNP) approach, with its RF arc.
  const hnl = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await stubOne(hnl, "hnl", "26L", "arrival");
  await hnl.goto(`${base}/?airport=hnl&flight=SMK1`);
  const rnp = await cited("SMK1", hnl);
  check("an arrival to a runway without an ILS cites the RNAV (RNP) approach it follows", /^Approach: RNAV \(RNP\) RWY 26L, from FAA CIFP cycle \d{4}$/.test(rnp ?? ""), rnp ?? "no citation");
  await hnl.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import("playwright");
  const base = process.env.SMOKE_URL;
  if (!base) throw new Error("set SMOKE_URL to a running server, e.g. SMOKE_URL=http://localhost:3124");
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failures = 0;
  try {
    await procedureChecks({
      browser,
      base,
      check: (name, ok, detail = "") => {
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
        if (!ok) failures++;
      },
    });
  } finally {
    await browser.close();
  }
  process.exit(failures ? 1 : 0);
}
