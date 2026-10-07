/**
 * Smoke checks for the published procedures in the gate-to-gate journey and for the journey panel's
 * "from" code: on `?fixture=journey` (a recorded Atlanta to Charlotte flight) the map draws the SID the
 * flight likely flew, then the estimate to the approach of the runway it is likely landing on and the
 * approach itself, and the journey card cites each as the flight card does; a destination that is not
 * built, or no route, draws no approach; and a flight followed from the world map out of an airport that
 * is not built shows the route's origin code, or none. scripts/smoke.mjs runs them with the rest; on
 * their own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3128 node scripts/smoke-journey-procedures.mjs
 *
 * and `... smoke-journey-procedures.mjs none` runs only the unbuilt and no-route destinations. Each run follows the flight until the
 * page stops showing anything new, not for a set time, and a run that cannot go on says where it stopped (see fly()).
 * (`SMOKE_ONLY=map-follow` runs only the checks on a flight picked on the world map.)
 *
 * The page exposes no handle on its map, so the checks reach it through React's fiber, as
 * scripts/smoke-map-select.mjs does, for the lines the map was last given.
 */

import { chromium } from "playwright";

/**
 * Waits until `expression` is truthy in the page. Not page.waitForFunction: given a string, Playwright
 * evaluates it inside the page with eval, which the app's Content-Security-Policy forbids (no
 * 'unsafe-eval'), so the wait would fail on the policy rather than on the page. page.evaluate goes
 * through the debugger protocol, which the policy does not govern.
 */
export async function waitForTruthy(page, expression, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(expression).catch(() => false)) return true;
    if (Date.now() >= end) throw new Error(`timed out after ${timeout} ms waiting for ${expression.slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const CLT = [-80.9431, 35.2144];
const GSP = [-82.2189, 34.8957];
const AUS = [-97.6699, 30.1945];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const km = ([ax, ay], [bx, by]) => Math.hypot((ax - bx) * 111.32 * Math.cos((ay * Math.PI) / 180), (ay - by) * 110.57);

const APPROACH = /^Likely approach: .*, from FAA CIFP cycle \d{4}$/;
const CLIMB_OUT = /^Likely climb-out: \S+ departure, from FAA CIFP cycle \d{4}$/;

/** The map's instance, found through the React fiber of <main>. */
const GLOBE = `(() => {
  const el = document.querySelector("main");
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      const c = h.memoizedState && h.memoizedState.current;
      if (c && c.map && typeof c.map.project === "function" && c.journeyData) return c;
    }
  }
  return null;
})()`;

/** What the page shows of the followed flight now: the lines the map holds for it, and what its card says. */
const SAMPLE = `(() => {
  const g = ${GLOBE};
  const features = g ? g.journeyData.features : [];
  const line = (part) => features.find((f) => f.properties.part === part)?.geometry.coordinates ?? null;
  const card = document.querySelector("section[aria-label^='Followed flight']");
  return {
    onMap: !!document.querySelector("main")?.dataset.onMap,
    // Everything the page shows of the flight, which changes as the recording plays: the stall watch in fly() reads it.
    sig: [...document.querySelectorAll("section[aria-label^='Selected flight'], section[aria-label^='Followed flight']")].map((e) => e.innerText).join("|").replace(/\\s+/g, " "),
    card: card ? card.innerText.replace(/\\s+/g, " ") : "",
    lines: card ? [...card.querySelectorAll("[data-journey-procedure]")].map((e) => e.textContent) : [],
    left: line("left"),
    climbOut: line("climb-out"),
    approach: line("approach"),
    aircraft: line("aircraft"),
    // Where the aircraft and the approach's end are on screen, and the card and the controls round them.
    screen: g && card && line("approach") ? (() => {
      const at = (c) => { const p = g.map.project(c); return { x: p.x, y: p.y }; };
      const rect = (e) => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; };
      return {
        aircraft: at(features.find((f) => f.properties.part === "aircraft").geometry.coordinates),
        end: at(line("approach").at(-1)),
        card: rect(card),
        foot: [...document.querySelectorAll("[data-map-foot], .maplibregl-ctrl-attrib")].map(rect).filter((r) => r.width > 0 && r.height > 0),
      };
    })() : null,
  };
})()`;

/**
 * How long the page may show nothing new before a run gives up on it. The recording plays by the page's own
 * clock, which moves at most 0.1 s for each time the page reads it (src/lib/journey-source.ts), so a busy machine
 * stretches the minute or so it takes the flight to climb out of Atlanta by however slow the page's frames get:
 * no wall-clock limit can be right for both. What does not stretch is whether it is moving at all.
 */
const STALL_MS = 90_000;
/** The most a run may take in all, a backstop for a page that keeps changing without getting anywhere. */
const CAP_MS = 20 * 60_000;
/** How long the Atlanta card has to show the flight, and a pressed Follow to start its journey. */
const CARD_MS = 120_000;
const JOURNEY_MS = 30_000;

/**
 * Opens the journey fixture, follows the flight out of Atlanta, and samples it on the map until `done` says
 * enough, or it lands. A run waits for the page to move on rather than for a time, and when it cannot go on says
 * where it stopped in `stuck` (null when it ran its course), so a check never fails on "0 samples" alone.
 */
export async function fly(browser, query, done, { viewport = { width: 1440, height: 900 }, cardMs = CARD_MS, stallMs = STALL_MS } = {}) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  const samples = [];
  const stop = async (stuck) => {
    await page.close();
    return { samples, problems, stuck };
  };
  try {
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    await page.goto(query);
    const card = page.locator("section[aria-label^='Selected flight']");
    // Never on another flight's card: Follow there starts no journey, and the run would wait for a map that is not coming.
    const shown = () => page.evaluate(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent ?? null);
    await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "DAL1947", null, { timeout: cardMs }).catch(() => {});
    const first = await shown();
    if (first !== "DAL1947") return await stop(`the card never showed DAL1947 in ${cardMs / 1000} s (it shows ${first ?? "no flight"})`);
    // Follow starts a journey for a flight with no route only once it is leaving (on its takeoff roll): a
    // taxiing flight could be coming in. A page that loads quickly shows it still taxiing, so wait for that.
    await page.waitForFunction(() => /Departing/.test(document.querySelector("section[aria-label^='Selected flight']")?.textContent ?? ""), null, { timeout: cardMs }).catch(() => {});
    // The press starts the journey only while the card says the flight is leaving; if the page has not caught up, it is pressed again.
    const follow = card.getByRole("button", { name: "Follow this flight" }).last();
    let started = false;
    for (let attempt = 1; attempt <= 3 && !started; attempt++) {
      if ((await follow.getAttribute("aria-pressed")) === "true") await follow.click({ timeout: JOURNEY_MS });
      await follow.click({ timeout: JOURNEY_MS });
      started = await page.waitForFunction(() => !!document.querySelector("[data-journey]"), null, { timeout: JOURNEY_MS }).then(() => true, () => false);
    }
    if (!started) return await stop(`Follow was pressed three times and no journey started (the card says: ${(await card.innerText().catch(() => "")).replace(/\s+/g, " ")})`);
    const begun = Date.now();
    let moved = Date.now();
    let seen = "";
    let onMapOnce = false;
    while (true) {
      const s = await page.evaluate(SAMPLE);
      if (s.onMap) onMapOnce = true;
      if (s.onMap) samples.push(s);
      // Over: it has come down onto the destination's diorama, or the caller has what it came for.
      if ((onMapOnce && !s.onMap) || done(s, samples)) return await stop(null);
      const now = Date.now();
      if (s.sig !== seen) {
        seen = s.sig;
        moved = now;
      }
      if (now - moved > stallMs) return await stop(`the page showed nothing new for ${stallMs / 1000} s ${onMapOnce ? "on the map" : "before the flight reached the map"} (${s.sig.slice(0, 160)})`);
      if (now - begun > CAP_MS) return await stop(`still going after ${CAP_MS / 60_000} minutes ${onMapOnce ? "on the map" : "without reaching the map"} (${s.sig.slice(0, 160)})`);
      await sleep(300);
    }
  } catch (error) {
    return await stop(String(error).split("\n")[0]);
  }
}

/** The run's own check: it got to the map and was sampled there, or says where it stopped. */
function reached(check, name, run) {
  check(`journey procedures: ${name}: the flight reached the map and was sampled`, run.stuck === null && run.samples.length > 0, run.stuck ?? `${run.samples.length} samples`);
}

export async function journeyProcedureChecks({ browser, base, check }) {
  // The recorded flight to Charlotte, a built destination: the SID while it is ahead, the approach all the way.
  {
    const run = await fly(browser, `${base}/?fixture=journey&flight=DAL1947&fixtureFrom=150`, () => false);
    const { samples, problems } = run;
    reached(check, "Charlotte", run);
    const climb = samples.filter((s) => s.climbOut);
    const approach = samples.filter((s) => s.approach);
    check("journey procedures: the map draws the SID the flight likely flew, and the card cites it alone", climb.length > 0 && climb.every((s) => s.lines.length === 1 && CLIMB_OUT.test(s.lines[0])), `${climb.length} samples; ${climb[0]?.lines.join(" | ")}`);
    const cruise = samples.findIndex((s) => /Cruising/.test(s.card));
    check("journey procedures: once the aircraft is past the SID's last point it is dropped from the map and the card", cruise > 0 && samples.slice(cruise).every((s) => !s.climbOut && !s.lines.some((l) => /climb-out/.test(l))), `cruise at sample ${cruise} of ${samples.length}`);
    const after = approach.filter((s) => !s.climbOut);
    check("journey procedures: once the SID is behind, the card cites the approach to the likely runway as the flight card does", after.length > 0 && after.every((s) => s.lines.length === 1 && APPROACH.test(s.lines[0])), after[0]?.lines.join(" | "));
    const s = approach.find((a) => /Descending/.test(a.card)) ?? approach.at(-1);
    check("journey procedures: the approach ends at Charlotte", !!s && km(s.approach.at(-1), CLT) < 4, s && `${km(s.approach.at(-1), CLT).toFixed(1)} km from the field`);
    // The estimate never runs beside the published line: it ends where the approach begins, or, with the aircraft on the approach, it is gone and the approach runs on from the aircraft.
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    const stray = approach.filter((a) => (a.left?.length ? !same(a.left.at(-1), a.approach[0]) : !a.aircraft || !same(a.aircraft, a.approach[0])));
    check("journey procedures: the dashed estimate ends where the approach begins, or the approach runs on from the aircraft with none", approach.length > 0 && stray.length === 0, `${stray.length} of ${approach.length} samples; ${JSON.stringify(stray[0]?.left?.at(-1))} vs ${JSON.stringify(stray[0]?.approach[0])}`);
    check("journey procedures: no console errors on the way", problems.length === 0, problems.slice(0, 3).join(" | "));
  }

  // On a phone the card takes the top of the map and the controls the foot: the aircraft and the approach's end both stay in the band between.
  {
    const run = await fly(browser, `${base}/?fixture=journey&flight=DAL1947&fixtureFrom=150`, (s) => s.screen && Number(/(\d+) NM to go/.exec(s.card)?.[1] ?? 1e9) <= 8, { viewport: { width: 390, height: 844 } });
    reached(check, "on a phone", run);
    const s = run.samples.at(-1)?.screen;
    const below = s && Math.min(...s.foot.filter((r) => r.top > s.card.bottom).map((r) => r.top));
    const inside = (p) => p.x > 0 && p.x < 390 && p.y > s.card.bottom && p.y < below;
    check("journey procedures: on a phone the aircraft and the approach's end are both in the band between the card and the controls", !!s && inside(s.aircraft) && inside(s.end), s && JSON.stringify({ aircraft: s.aircraft, end: s.end, cardBottom: s.card.bottom, below }));
  }

  await noApproachChecks({ browser, base, check });
  await mapFollowChecks({ browser, base, check });
}

/** A destination that is not built, and no route at all: the straight estimate as before, no approach, nothing extra on the card. */
export async function noApproachChecks({ browser, base, check }) {
  for (const route of ["unbuilt", "none"]) {
    const run = await fly(browser, `${base}/?fixture=journey&flight=DAL1947&fixtureFrom=150&route=${route}`, (s) => /Cruising/.test(s.card));
    const { samples } = run;
    reached(check, `${route} destination`, run);
    check(`journey procedures: ${route} destination: no approach is drawn or cited`, samples.length > 0 && samples.every((s) => !s.approach && !s.lines.some((l) => /approach/.test(l))), `${samples.length} samples`);
    if (route === "unbuilt") {
      const s = samples.find((x) => /Cruising/.test(x.card));
      check("journey procedures: unbuilt destination: the estimate runs straight on to it", !!s?.left && s.left.length === 2 && km(s.left[1], GSP) < 0.1, JSON.stringify(s?.left));
    }
  }
}

/** AAL972 (hex adacfd), the one aircraft in the fixture's sky with a recorded route that is in the air: DFW to AUS, climbing out of Dallas-Fort Worth. */
const HEX = "adacfd";
const CALLSIGN = "AAL972";
const VIEW = "#map=7/32.3/-97.1";

const place = (code, city, latitude, longitude) => ({ code, city, country: "US", latitude, longitude });

/** A flight picked on the world map and followed: its panel's "from" is the route's origin, whether or not that is one of the 32. */
export async function mapFollowChecks({ browser, base, check }) {
  const t0 = Date.now() / 1000;
  // `late`: no route is known at the pick, and the flight lookup learns this one a moment after. Dallas-Fort Worth, the nearest built airport to this flight, is its destination here.
  const late = { origin: place("AUS", "Austin", 30.1945, -97.6699), destination: place("DFW", "Dallas-Fort Worth", 32.8968, -97.038) };
  for (const [name, route, from, learned] of [
    ["an origin that is not built", { origin: place("GSP", "Greenville", 34.8957, -82.2189), destination: place("AUS", "Austin", 30.1945, -97.6699) }, "GSP"],
    ["no route known", null, "?"],
    ["a route learned after the pick, its destination the nearest built airport", null, "AUS", late],
  ]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route(`**/api/hex/${HEX}`, (r) => {
      const now = Date.now() / 1000;
      const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A321", military: false, latitude: 32.88 - ((now - t0) * 85) / 111000, longitude: -97.06, altitudeFt: 4000 + (now - t0) * 30, onGround: false, groundSpeedKt: 165, trackDeg: 180, verticalRateFpm: 1800 };
      return r.fulfill({ json: { hex: HEX, time: now, aircraft } });
    });
    // Austin's wind from the north, and no lookup that could name a route: what the page learns is what is set below.
    await page.route("**/api/weather/aus", (r) => r.fulfill({ json: { station: "KAUS", raw: "", wind: { directionDeg: 350, speedKt: 12, gustKt: null, variable: false, range: null } } }));
    await page.route(`**/api/flight/${CALLSIGN}`, (r) => (learned ? r.fulfill({ json: { callsign: CALLSIGN, route: learned } }) : r.fulfill({ status: 404, body: "" })));
    await page.goto(`${base}/?fixture=1${VIEW}`);
    await page.locator("main[data-on-map]").waitFor({ timeout: 60_000 });
    const where = () => page.evaluate(`(() => { const g = ${GLOBE}; const f = g && g.drawn.find((x) => x.properties.id === "${HEX}"); if (!f) return null; const p = g.map.project(f.geometry.coordinates); return { x: p.x, y: p.y }; })()`);
    let at = null;
    for (let i = 0; i < 120 && !at; i++) {
      at = await where();
      if (!at) await sleep(500);
    }
    // The recorded routes load just after the map, and the map keeps the first it learns: wait for ours, then replace it before the flight is picked.
    await waitForTruthy(page, `(() => { const g = ${GLOBE}; return !!g && g.routes.has("${CALLSIGN}"); })()`, 30_000).catch(() => {});
    // The route the map has learned for the flight, replaced before it is picked.
    await page.evaluate(`(() => { const g = ${GLOBE}; ${route ? `g.routes.set("${CALLSIGN}", ${JSON.stringify(route)})` : `g.routes.delete("${CALLSIGN}")`}; })()`);
    if (at) await page.mouse.click(at.x, at.y);
    const card = page.locator("section[aria-label^='Selected flight']").locator("visible=true");
    await card.waitFor({ timeout: 15_000 }).catch(() => {});
    await page.getByRole("button", { name: "Follow this flight" }).locator("visible=true").first().click();
    await page.locator("[data-journey]").first().waitFor({ timeout: 60_000 }).catch(() => {});
    if (learned) await page.waitForFunction((code) => document.querySelector("[data-journey]")?.textContent?.startsWith(code), learned.origin.code, { timeout: 30_000 }).catch(() => {});
    const panel = (await page.locator("[data-journey]").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    check(`journey from: a flight followed from the map with ${name}: the panel's "from" is ${from}, not the nearest built airport`, panel.startsWith(`${from} `) && (learned || !panel.includes("DFW")), panel);
    if (learned) {
      // Measured from Austin, where the route says it set out: about 190 NM flown and a few to go, not the same distance from Dallas-Fort Worth twice.
      const [flown, toGo] = [/([\d,]+) NM flown/, /([\d,]+) NM to go/].map((re) => Number(re.exec(panel)?.[1].replace(/,/g, "")));
      check("journey progress: a flight whose route is learned after the map pick is measured from the route's origin, not from the nearest built airport", flown > 100 && flown > toGo + 50, panel);
    }
    if (route) {
      // The wind at Austin is from the north, so its approach is to the south end of the runways: the line ends 1.7 km south of the field.
      let ends = null;
      for (let i = 0; i < 100 && !ends; i++) {
        ends = await page.evaluate(`(() => { const g = ${GLOBE}; return g.journeyData.features.find((f) => f.properties.part === "approach")?.geometry.coordinates.at(-1) ?? null; })()`);
        if (!ends) await sleep(300);
      }
      check("journey procedures: a map-started flight to a built airport follows the approach into the destination's wind", !!ends && km(ends, AUS) < 4 && ends[1] < AUS[1] - 0.01, JSON.stringify(ends));
    }
    await page.close();
  }
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-journey-procedures.mjs")) {
  const results = [];
  let failures = 0;
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(results.at(-1));
    if (!ok) failures++;
  };
  const args = process.env.HEADED ? ["--ignore-gpu-blocklist"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  const browser = await chromium.launch({ headless: !process.env.HEADED, args });
  try {
    // `node scripts/smoke-journey-procedures.mjs none` runs only the unbuilt and no-route blocks, which is how their timing is looked at on its own;
    // SMOKE_ONLY=map-follow runs just the flights picked on the map (the rest play the recording in real time, minutes of it).
    const run = process.argv[2] === "none" ? noApproachChecks : process.env.SMOKE_ONLY === "map-follow" ? mapFollowChecks : journeyProcedureChecks;
    await run({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check });
  } catch (error) {
    check("journey procedures run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
