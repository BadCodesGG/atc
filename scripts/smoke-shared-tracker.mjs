/**
 * Smoke check for the page's one tracker (#20, docs/adr/0001-one-shared-tracker.md): on the live code path
 * (no fixture; every API route the page reads is stubbed, on the wall's clock), a flight over Atlanta is
 * followed, and inside one animation frame the Diorama, the World map and the Journey are asked where it is.
 * They must be one tracker, read at one moment, and give one pose, 12 s behind live; the airport feed's fixes
 * of the flight and the journey's own (each answered on a clock a little apart) must be one aircraft's.
 * On its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3184 node scripts/smoke-shared-tracker.mjs
 *
 * The page exposes no handle on its tracker, so the check reaches it through React's fiber, as
 * scripts/smoke-journey-live.mjs does.
 */

import { launchChrome } from "./lib/chrome.mjs";
import { waitForTruthy } from "./smoke-journey-procedures.mjs";

const ATL = { latitude: 33.6367, longitude: -84.4281 };
const HEX = "a4c2e7";
const CALLSIGN = "DAL1947";
const R = 6371008.8;
const RAD = Math.PI / 180;
/** The same azimuthal equidistant metres as src/lib/geo.ts's toGeo: change them together. */
function toGeo(origin, x, y) {
  const rho = Math.hypot(x, y);
  if (rho < 1e-9) return [origin.latitude, origin.longitude];
  const c = rho / R;
  const p0 = origin.latitude * RAD;
  const lat = Math.asin(Math.cos(c) * Math.sin(p0) + (y * Math.sin(c) * Math.cos(p0)) / rho);
  const lon = origin.longitude * RAD + Math.atan2(x * Math.sin(c), rho * Math.cos(p0) * Math.cos(c) - y * Math.sin(p0) * Math.sin(c));
  return [lat / RAD, lon / RAD];
}

const T0 = Date.now() / 1000;
/** The flight at `t`, wall seconds: climbing out east of the field at 80 m/s and 2,000 ft a minute (a departure, so Follow makes a journey of it). */
function flightAt(t) {
  const x = 1_500 + 80 * (t - T0);
  const y = 0;
  const [latitude, longitude] = toGeo(ATL, x, y);
  return { x, y, latitude, longitude, altitudeFt: 1_600 + (2_000 / 60) * (t - T0) };
}
const regionAircraft = (t, age) => {
  const p = flightAt(t - age);
  return { id: HEX, callsign: CALLSIGN, typeCode: "A321", military: false, latitude: p.latitude, longitude: p.longitude, altitudeFt: p.altitudeFt, onGround: false, groundSpeedKt: 155.5, trackDeg: 90, verticalRateFpm: 2_000, positionAgeS: age };
};
const trafficAircraft = (t, age) => {
  const p = flightAt(t - age);
  return { ...regionAircraft(t, age), registration: "N123DN", category: "A3", x: p.x, y: p.y, positionAge: age, source: "adsb_icao", squawk: "1200" };
};

/** Finds a value held in React state or a ref below `from`. */
const FIBER = (test, from = "main") => `(() => {
  const el = document.querySelector(${JSON.stringify(from)});
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      for (const c of [h.memoizedState, h.memoizedState && h.memoizedState.current]) if (c && typeof c === "object" && ${test}) return c;
    }
  }
  return null;
})()`;
const GLOBE = FIBER(`c.map && typeof c.map.project === "function" && c.drawn`);
const JOURNEY = FIBER(`typeof c.stage === "string" && typeof c.hex === "string" && c.origin`);
const TRAFFIC = FIBER(`c.tracker && typeof c.tracker.at === "function" && c.view && typeof c.clock === "function"`, "[role='application']");

/** Inside one animation frame: where each view has the flight, and the moment each read. */
const ONE_FRAME = `new Promise((resolve) => requestAnimationFrame(() => {
  const g = ${GLOBE};
  const j = ${JOURNEY};
  const traffic = ${TRAFFIC};
  if (!g || !j || !traffic) return resolve({ missing: [!g && "map", !j && "journey", !traffic && "traffic"].filter(Boolean) });
  const dioramaAt = traffic.clock();
  const d = traffic.tracker.at(dioramaAt).find((a) => a.id === "${HEX}");
  const mapAt = g.skyTime();
  const m = g.sky.one("${HEX}", mapAt, { frame: { latitude: 39, longitude: -96 } });
  const f = j.fix();
  resolve({
    sameTracker: g.sky === j.sky.tracker,
    dioramaAt, mapAt, journeyAt: j.sky.time(),
    diorama: d ? [d.latitude, d.longitude, d.altitudeFt, d.headingDeg] : null,
    map: m ? [m.latitude, m.longitude, m.altitudeFt, m.headingDeg] : null,
    journey: f ? [f.latitude, f.longitude, f.altitudeFt, f.headingDeg] : null,
    samples: g.sky.tracks.get("${HEX}")?.samples.length ?? 0,
    feeds: [...(g.sky.tracks.get("${HEX}")?.listed.keys() ?? [])].sort(),
  });
}))`;

/** Metres between two [latitude, longitude]. */
const apart = (a, b) => Math.hypot((a[0] - b[0]) * 111_195, (a[1] - b[1]) * 111_195 * Math.cos(a[0] * RAD));

export async function sharedTrackerChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  // Every route the page reads, answered on the wall's clock: the airport feed lists the fix 0.5 s old, the map's
  // regions 0.7 s ahead of it, the journey's hex 1 s old.
  await page.route("**/api/traffic/atl", (r) => {
    const t = Date.now() / 1000;
    return r.fulfill({ json: { airport: "atl", time: t, aircraft: [trafficAircraft(t, 0.5)], routes: {} } });
  });
  await page.route("**/api/region/**", (r) => {
    const t = Date.now() / 1000 + 0.7;
    const cell = { latitude: 32, longitude: -84 };
    return r.fulfill({ json: { cell, time: t, aircraft: [regionAircraft(t, 1.2)] } });
  });
  await page.route(`**/api/hex/${HEX}`, (r) => {
    const t = Date.now() / 1000;
    return r.fulfill({ json: { hex: HEX, time: t, aircraft: regionAircraft(t, 1) } });
  });
  await page.route("**/api/counts", (r) => r.fulfill({ json: { counts: {} } }));
  await page.route("**/api/flight/**", (r) => r.fulfill({ json: { callsign: CALLSIGN, route: null } }));
  await page.route("**/api/weather/**", (r) => r.fulfill({ json: { station: "KATL", raw: "", wind: { directionDeg: 270, speedKt: 8, gustKt: null, variable: false, range: null } } }));
  await page.route("**/api/status/**", (r) => r.fulfill({ status: 404, body: "" }));
  await page.route("**/api/squawk/**", (r) => r.fulfill({ json: { aircraft: [] } }));
  await page.goto(`${base}/?airport=atl&flight=${CALLSIGN}`);
  // The picture plays 12 s behind the feed: the flight is drawn once the first answer is that old.
  const selected = await page
    .waitForFunction((c) => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === c, CALLSIGN, { timeout: 90_000 })
    .then(() => true, () => false);
  check("shared tracker: the live page draws the stubbed flight over Atlanta and selects it", selected);
  if (selected) {
    await page.locator("section[aria-label^='Selected flight']").getByRole("button", { name: "Follow this flight" }).last().click();
    await waitForTruthy(page, `(() => { const j = ${JOURNEY}; return j && j.fix() !== null; })()`, 30_000).catch(() => {});
    // A few seconds of the journey's own reads and the map's region reads.
    await page.waitForTimeout(12_000);
    const frames = [];
    for (let i = 0; i < 20; i++) {
      const f = await page.evaluate(ONE_FRAME);
      if (f) frames.push(f);
      await page.waitForTimeout(150);
    }
    const drawn = frames.filter((f) => f.diorama && f.map && f.journey);
    check("shared tracker: the Diorama, the World map and the Journey read one tracker, at one moment per frame", drawn.length > 10 && drawn.every((f) => f.sameTracker && f.dioramaAt === f.mapAt && f.mapAt === f.journeyAt), JSON.stringify(frames[0] ?? null));
    const worst = Math.max(...drawn.map((f) => Math.max(apart(f.diorama, f.map), apart(f.diorama, f.journey), Math.abs(f.diorama[2] - f.map[2]), Math.abs(f.diorama[2] - f.journey[2]))));
    check("shared tracker: ... and draw the followed flight at the same place, within a millimetre", drawn.length > 10 && worst < 1e-3, `${drawn.length} frames, worst ${worst} m`);
    // Where the flight was 12 s ago on the wall's clock (the stubbed feeds' clock), a metre or two either way for the frame's timing.
    const last = drawn.at(-1);
    const shouldBe = last ? flightAt(last.dioramaAt - 12) : null;
    const behind = last && shouldBe ? apart(last.diorama, [shouldBe.latitude, shouldBe.longitude]) : Infinity;
    check("shared tracker: ... 12 s behind live", behind < 80 * 0.5, `${behind.toFixed(1)} m from where it was 12 s before the frame`);
    const feeds = last?.feeds ?? [];
    check("shared tracker: the airport feed's and the journey's fixes are one aircraft's, merged in time order", feeds.includes("airport:atl") && feeds.includes(`hex:${HEX}`) && (last?.samples ?? 0) > 3, JSON.stringify(feeds));
  }
  check("shared tracker: no page errors", problems.length === 0, problems.slice(0, 3).join(" | "));
  await page.close();
}

if (process.argv[1] && process.argv[1].endsWith("smoke-shared-tracker.mjs")) {
  let failures = 0;
  let total = 0;
  const check = (name, ok, detail = "") => {
    total++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  const browser = await launchChrome({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await sharedTrackerChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3184", check });
  } catch (error) {
    check("shared tracker run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}
