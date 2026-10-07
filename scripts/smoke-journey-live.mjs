/**
 * Smoke checks for the gate-to-gate journey under the conditions the live feed brings and the recording
 * does not: a flight followed from the map into the airport the page is already showing, a transponder that
 * goes quiet on the taxiway or at the gate, and a feed that loses the aircraft while it taxis out, and what lets a journey go (the reader, not the camera's follow).
 * scripts/smoke.mjs runs them with the rest; on their own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3128 node scripts/smoke-journey-live.mjs
 *
 * The page exposes no handle on its map or its journey, so the checks reach them through React's fiber,
 * as scripts/smoke-journey-procedures.mjs does.
 */

import { chromium } from "playwright";
import { waitForTruthy } from "./smoke-journey-procedures.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const FIBER = (test, from = "main", ref = false) => `(() => {
  const el = document.querySelector(${JSON.stringify(from)});
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      const c = h.memoizedState && h.memoizedState.current;
      if (c && ${test}) return ${ref ? "h.memoizedState" : "c"};
    }
  }
  return null;
})()`;
/** The map's instance. */
const GLOBE = FIBER(`c.map && typeof c.map.project === "function" && c.drawn`);
/** The journey, or null with none. */
const JOURNEY = FIBER(`typeof c === "object" && typeof c.stage === "string" && typeof c.hex === "string" && c.origin`);
/** The diorama's follow (the aircraft its camera follows), or null; it lives in the Viewer, below `main`, so it is found from the model's own element. */
const FOLLOW_TEST = `typeof c === "object" && typeof c.id === "string" && typeof c.distance === "number" && "angle" in c`;
const FOLLOW = FIBER(FOLLOW_TEST, "[role='application']");
/** The same, as the ref that holds it, so a check can clear it. */
const FOLLOW_REF = FIBER(FOLLOW_TEST, "[role='application']", true);
/** What the page shows of the flight: the diorama's selected card, the map's followed card, and the journey panel. */
const SHOWN = `(() => {
  const text = (s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\\s+/g, " ") : null; };
  const h2 = document.querySelector("section[aria-label^='Selected flight'] h2");
  const j = ${JOURNEY};
  return { onMap: !!document.querySelector("main")?.dataset.onMap, stage: j ? j.stage : null, lostMs: j ? j.lostFor() : null, callsign: h2 ? h2.textContent : null, selected: text("section[aria-label^='Selected flight']"), followed: text("section[aria-label^='Followed flight']"), panel: text("[data-journey]") };
})()`;

/**
 * JBU1897 (hex a37fb0) is in the fixture's sky 51 NM from Atlanta, and Atlanta is the airport the page opens
 * on. It is picked on the map and followed with no route known; the lookup then says it is bound for
 * Atlanta, and its own reads put it on final there. So the diorama that takes the hand is the one that has
 * been on show all along, which no mount ever seeds with the followed flight.
 */
const HEX = "a37fb0";
const CALLSIGN = "JBU1897";
const place = (code, city, latitude, longitude) => ({ code, city, country: "US", latitude, longitude });
const ROUTE = { origin: place("MSY", "New Orleans", 29.9934, -90.258), destination: place("ATL", "Atlanta", 33.6367, -84.4281) };

async function handIntoTheAirportOnShow({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  const t0 = Date.now() / 1000;
  await page.route(`**/api/hex/${HEX}`, (r) => {
    const now = Date.now() / 1000;
    // 6 NM out on final, closing at 150 kt.
    const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A320", military: false, latitude: 33.64, longitude: -84.55 + (now - t0) * 0.00083, altitudeFt: 2100, onGround: false, groundSpeedKt: 150, trackDeg: 90, verticalRateFpm: -700 };
    return r.fulfill({ json: { hex: HEX, time: now, aircraft } });
  });
  await page.route(`**/api/flight/${CALLSIGN}`, (r) => r.fulfill({ json: { callsign: CALLSIGN, route: ROUTE } }));
  await page.route("**/api/weather/atl", (r) => r.fulfill({ json: { station: "KATL", raw: "", wind: { directionDeg: 270, speedKt: 8, gustKt: null, variable: false, range: null } } }));
  await page.goto(`${base}/?fixture=1#map=7/33.6/-84.4`);
  await page.locator("main[data-on-map]").waitFor({ timeout: 60_000 });
  let at = null;
  for (let i = 0; i < 120 && !at; i++) {
    at = await page.evaluate(`(() => { const g = ${GLOBE}; const f = g && g.drawn.find((x) => x.properties.id === "${HEX}"); if (!f) return null; const p = g.map.project(f.geometry.coordinates); return { x: p.x, y: p.y }; })()`);
    if (!at) await sleep(500);
  }
  // The map keeps the recorded route it learns first for the flight; this one has none, as a flight first met on the map often has.
  await page.evaluate(`(() => { const g = ${GLOBE}; g.routes.delete("${CALLSIGN}"); })()`);
  if (at) await page.mouse.click(at.x, at.y);
  await page.locator("section[aria-label^='Selected flight']").locator("visible=true").waitFor({ timeout: 15_000 }).catch(() => {});
  await page.getByRole("button", { name: "Follow this flight" }).locator("visible=true").first().click();
  // From the first frame the diorama shows (the hand's first half), until it has the flight in its own feed (it never will here), its card is not another flight's.
  const seen = [];
  for (let i = 0; i < 100; i++) {
    const s = await page.evaluate(SHOWN);
    if (s.stage === "map" && !s.onMap) seen.push(s.callsign);
    if (seen.length >= 20) break;
    await sleep(150);
  }
  const others = seen.filter((c) => c !== null && c !== CALLSIGN);
  check("journey hand: with the diorama of its destination already on show, the half-revealed diorama's card is the followed flight's, never another's", seen.length > 0 && others.length === 0, `${seen.length} samples with the diorama showing; other flights: ${[...new Set(others)].join(", ") || "none"}`);
  check("journey hand: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
  await page.close();
}

/**
 * The recording followed out of Atlanta with the transponder quiet three times, in seconds of the recording:
 * 100 to 240, from the taxiway out to the climb (the feeds list the last position for a minute, then lose
 * it, and the flight is back in the air); 2700 to 2830, taxiing in at Charlotte; and from 2862 for good, a metre or two
 * short of the gate it parks at 3 s later, creeping in at 2 kt, which the page is never told of. (Lost earlier, on the
 * taxilane at its steady 5 kt, it would not have arrived: nothing says it stopped there.)
 *
 * At Charlotte, while the flight is absent from the feed, the check also does what the reader never does but the
 * page does to itself: it switches the theme (which rebuilds the scene) and keeps clearing the diorama's follow.
 * With no follow and the flight undrawn, the journey must still arrive on its own (a journey judged only while the
 * camera followed its flight never ended, and its card stayed empty for good).
 */
const GAPS = "100:240,2700:2830,2862:";

async function aTransponderThatGoesQuiet({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.goto(`${base}/?fixture=journey&flight=DAL1947&fixtureFrom=76&gap=${GAPS}`);
  await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "DAL1947", null, { timeout: 120_000 });
  await page.locator("section[aria-label^='Selected flight']").getByRole("button", { name: "Follow this flight" }).last().click();
  const out = [];
  const home = [];
  let last = null;
  const end = Date.now() + 360_000;
  let themed = false;
  let cleared = 0;
  while (Date.now() < end) {
    const s = await page.evaluate(SHOWN);
    last = s;
    if (s.stage === "destination" && (s.lostMs ?? 0) > 5_000) {
      if (!themed) {
        themed = true;
        await page.getByRole("group", { name: "Map style" }).locator("visible=true").getByRole("button", { name: "Dark", exact: true }).click();
      }
      cleared += await page.evaluate(`(() => { const r = ${FOLLOW_REF}; if (!r || !r.current) return 0; r.current = null; return 1; })()`);
    }
    // At Atlanta, from Follow to the hand to the map, and at Charlotte, from the hand into its diorama to the end: the card is the flight's.
    if (s.stage === "origin") out.push(s.callsign);
    if (s.stage === "destination" || s.stage === "arrived") home.push(s.callsign);
    if (s.stage === "arrived" && s.selected?.includes("Arrived")) {
      // The chrome and the journey's panel each refresh four times a second, and a software GPU's frames are slow: let the card catch up.
      await page.waitForFunction(() => /At gate/.test(document.querySelector("section[aria-label^='Selected flight']")?.textContent ?? ""), null, { timeout: 10_000 }).catch(() => {});
      last = await page.evaluate(SHOWN);
      break;
    }
    await sleep(150);
  }
  const missing = (samples) => samples.filter((c) => c !== "DAL1947").length;
  check("journey gap: a flight the feed loses on the taxiway out keeps its card, and its journey, through the gap and the climb", out.length > 20 && missing(out) === 0, `${out.length} samples, ${missing(out)} without the flight's card`);
  check("journey gap: a flight the feed loses while taxiing in keeps its card in the destination's diorama", home.length > 20 && missing(home) === 0, `${home.length} samples, ${missing(home)} without the flight's card`);
  check("journey gap: a flight whose transponder goes quiet by its gate has arrived, and the card says so", last?.stage === "arrived" && /Arrived at (gate|stand) \S+\. Its transponder went quiet there\./.test(last.selected ?? "") && /At gate/.test(last.selected), `${last?.stage}: ${last?.selected}`);
  check("journey gap: ... also with the scene rebuilt for a theme and the follow cleared while the flight is absent from the feed", themed && cleared > 0 && last?.stage === "arrived", `themed ${themed}, follow cleared ${cleared} times, stage ${last?.stage}`);
  check("journey gap: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
  await page.close();
}

/**
 * A transponder that goes quiet on the taxiway out and is never heard again (the aircraft takes off unseen,
 * as one with its transponder off at the gate does). The flight cannot have left the airport's ground
 * unseen, so the journey waits for it past the five minutes it holds a flight lost in the air.
 */
async function aTransponderQuietAtTheOrigin({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/?fixture=journey&flight=DAL1947&fixtureFrom=76&gap=100:`);
  await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "DAL1947", null, { timeout: 120_000 });
  await page.locator("section[aria-label^='Selected flight']").getByRole("button", { name: "Follow this flight" }).last().click();
  const samples = [];
  let past = 0;
  const end = Date.now() + 180_000;
  while (Date.now() < end && past < 20) {
    const s = await page.evaluate(SHOWN);
    samples.push(s);
    // Lost for longer than the hold, on the feed's clock; then a few more samples.
    if ((s.lostMs ?? 0) > 330_000) past++;
    await sleep(200);
  }
  const held = samples.filter((s) => s.stage === "origin" && s.callsign === "DAL1947").length;
  check("journey gap: a flight lost on the ground at its origin is waited for past the hold, with its journey and its card", past >= 20 && held === samples.length, `${held} of ${samples.length} samples held; lost for ${Math.round((samples.at(-1)?.lostMs ?? 0) / 1000)} s, stage ${samples.at(-1)?.stage}`);
  await page.close();
}

/**
 * A journey ends when the reader lets go of it (Follow toggled off, another flight or empty ground picked,
 * the view slid) or the flight arrives, never because the diorama's follow stopped matching it. The
 * follow is cleared by things that are not the reader (a scene rebuilt for a theme, a Viewer remounted by
 * a hand, a frame with no fix), and a journey that ended at each of those ended on its own while the
 * flight was still in the feed. Followed out of Atlanta on the ground, with no transponder gap:
 * the causes that are not the reader's leave it running (and the follow comes back), the reader's end it.
 */
async function aJourneyIsLetGoOnlyByTheReader({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  // Played slowly (pace): on the ground the recording runs at 15 times real time, which would have the flight airborne before the checks are done.
  await page.goto(`${base}/?fixture=journey&flight=DAL1947&fixtureFrom=76&pace=0.05`);
  await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "DAL1947", null, { timeout: 120_000 });
  const card = page.locator("section[aria-label^='Selected flight']").getByRole("button", { name: "Follow this flight" }).last();
  await card.click();
  await waitForTruthy(page, `!!(${JOURNEY}) && !!(${FOLLOW})`, 60_000);
  /** Samples the journey for `ms`; it is kept when every sample has it, on the ground at Atlanta, with the flight's own card. */
  const kept = async (ms) => {
    const end = Date.now() + ms;
    const stages = [];
    while (Date.now() < end) {
      const s = await page.evaluate(SHOWN);
      stages.push(s.stage === "origin" && s.callsign === "DAL1947" ? "kept" : `${s.stage}/${s.callsign}`);
      await sleep(200);
    }
    const lost = stages.filter((s) => s !== "kept");
    return { ok: stages.length > 0 && lost.length === 0, detail: `${stages.length} samples, ${lost.length} without it${lost.length ? `: ${[...new Set(lost)].join(", ")}` : ""}` };
  };
  const followed = (ms = 8_000) => waitForTruthy(page, `!!(${FOLLOW})`, ms).then(() => true, () => false);

  // 1. The follow cleared by something that is not the reader (a hand, a remount, a frame with no fix): the journey runs on and the follow comes back.
  await page.evaluate(`(() => { const r = ${FOLLOW_REF}; if (r) r.current = null; })()`);
  const cleared = await kept(3_000);
  check("journey let go: a follow cleared by something that is not the reader leaves the journey running", cleared.ok, cleared.detail);
  check("journey let go: ... and the follow goes back on the journey's flight", await followed());

  // 2. A theme switch rebuilds the scene under the journey.
  await page.getByRole("group", { name: "Map style" }).locator("visible=true").getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("main")?.dataset.theme === "dark", null, { timeout: 10_000 });
  const themed = await kept(4_000);
  check("journey let go: a theme switch, which rebuilds the scene, leaves the journey running and followed", themed.ok && (await followed()), themed.detail);

  // 3. A camera mode in and out.
  const cameras = page.getByRole("group", { name: "Camera" });
  await cameras.getByRole("button", { name: "Drone", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("[role='group'][aria-label='Camera'] button[aria-pressed='true']")?.textContent?.trim() === "Drone", null, { timeout: 10_000 });
  const inMode = await kept(3_000);
  await cameras.getByRole("button", { name: "Orbit", exact: true }).click();
  const outOfMode = await kept(3_000);
  check("journey let go: entering and leaving a camera mode leaves the journey running and followed", inMode.ok && outOfMode.ok && (await followed()), `${inMode.detail}; ${outOfMode.detail}`);

  // 4. The reader lets go: Follow toggled off on the card.
  await card.click();
  const unfollowed = await waitForTruthy(page, `!(${JOURNEY}) && !(${FOLLOW})`, 8_000).then(() => true, () => false);
  check("journey let go: Follow toggled off by the reader ends the journey", unfollowed);

  // 5. The reader lets go: a click on empty ground. Followed again first.
  await card.click();
  await waitForTruthy(page, `!!(${JOURNEY}) && !!(${FOLLOW})`, 30_000);
  const ground = await page.evaluate(() => {
    const host = document.querySelector("[role='application']");
    const r = host.getBoundingClientRect();
    // Somewhere on the model's own element, clear of every control and panel over it, and away from the middle where the flight is held.
    for (const [fx, fy] of [[0.1, 0.7], [0.1, 0.5], [0.2, 0.8], [0.1, 0.3], [0.3, 0.85]]) {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      if (host.contains(document.elementFromPoint(x, y))) return { x, y };
    }
    return null;
  });
  if (ground) await page.mouse.click(ground.x, ground.y);
  const emptied = ground !== null && (await waitForTruthy(page, `!(${JOURNEY})`, 8_000).then(() => true, () => false));
  check("journey let go: a click on empty ground by the reader ends the journey", emptied, ground ? "" : "no clear ground on the model to click");
  check("journey let go: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
  await page.close();
}

const CHECKS = { hand: handIntoTheAirportOnShow, quiet: aTransponderThatGoesQuiet, origin: aTransponderQuietAtTheOrigin, reader: aJourneyIsLetGoOnlyByTheReader };

/** `only` names the checks to run (hand, quiet, origin, reader); all by default. */
export async function journeyLiveChecks({ browser, base, check, only = Object.keys(CHECKS) }) {
  for (const name of only) await CHECKS[name]({ browser, base, check });
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-journey-live.mjs")) {
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
    // SMOKE_ONLY=hand,quiet,origin,reader picks the checks; each plays the recording in real time, minutes of it.
    await journeyLiveChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check, only: process.env.SMOKE_ONLY?.split(",") });
  } catch (error) {
    check("journey live run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
