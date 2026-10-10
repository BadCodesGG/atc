/**
 * Smoke checks for selecting a flight on the world map, on the frozen fixture: a click on an aircraft
 * opens its card, Escape and a click on empty map clear it, a flight that leaves the feed is said to be
 * lost with its last figures kept, a link reopens with the flight selected, and the card clears the
 * map's chrome at four sizes in light and dark. scripts/smoke.mjs runs them with the rest; on their own,
 * against a server already running:
 *
 *   SMOKE_URL=http://localhost:3127 node scripts/smoke-map-select.mjs
 *
 * The page exposes no handle on its map, so the checks reach it through React's fiber: for where an
 * aircraft is on screen (to click it) and, for the lost state, to take it out of the sky.
 */

import { chromium } from "playwright";

/** AAL972 (hex adacfd), the one aircraft in the fixture's sky with a recorded route that is in the air: DFW to AUS, climbing out of Dallas-Fort Worth. */
const HEX = "adacfd";
const CALLSIGN = "AAL972";
const VIEW = "#map=7/32.3/-97.1";
const SIZES = [
  [1440, 900],
  [1280, 720],
  [390, 844],
  [800, 494],
];
const API = "https://api.planespotters.net/pub/photos/hex/";
const PIC = "https://t.plnspttrs.net/00000/stub_280.svg";
const LINK = "https://www.planespotters.net/photo/1/stub-aircraft?utm_source=api";
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280"><rect width="420" height="280" fill="#789"/></svg>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The map's instance, found through the React fiber of <main>. */
const GLOBE = `(() => {
  const el = document.querySelector("main");
  const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      const c = h.memoizedState && h.memoizedState.current;
      if (c && c.map && typeof c.map.project === "function" && c.drawn) return c;
    }
  }
  return null;
})()`;

/** Where the aircraft is on screen, or null before the map has drawn it. */
const where = (page) =>
  page.evaluate(`(() => { const g = ${GLOBE}; const f = g && g.drawn.find((x) => x.properties.id === "${HEX}"); if (!f) return null; const p = g.map.project(f.geometry.coordinates); return { x: p.x, y: p.y }; })()`);

async function aircraftAt(page) {
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const at = await where(page);
    if (at) return at;
    await sleep(500);
  }
  return null;
}

async function opened(browser, url, size, setup = async () => {}) {
  const page = await browser.newPage({ viewport: { width: size[0], height: size[1] } });
  await setup(page);
  await page.route(`${API}*`, (route) =>
    route.fulfill({ json: { photos: [{ id: "1", thumbnail: { src: PIC, size: { width: 200, height: 133 } }, thumbnail_large: { src: PIC, size: { width: 420, height: 280 } }, link: LINK, photographer: "Test Photographer" }] }, headers: { "access-control-allow-origin": "*" } }),
  );
  await page.route(PIC, (route) => route.fulfill({ body: SVG, contentType: "image/svg+xml", headers: { "access-control-allow-origin": "*" } }));
  await page.goto(url);
  await page.locator("main[data-on-map]").waitFor({ timeout: 60_000 });
  return page;
}

/** The map's chrome the card must clear. */
const CHROME = {
  header: ".atc-title",
  search: "#atc-search",
  filter: "button[aria-label*='ilter']",
  radar: "[data-radar]",
  view: "[role='group'][aria-label='View']",
  // A row of three wide, one button in the view row on phones and tablets.
  themes: "[role='group'][aria-label='Map style'], button[aria-label^='Map style']",
  time: "main > div:has(> time)",
  credit: "p:has(> a[href='https://adsb.fi'])",
  attribution: ".maplibregl-ctrl-attrib",
};

export async function mapSelectChecks({ browser, base, check }) {
  const cardOf = (page) => page.locator("section[aria-label^='Selected flight']").locator("visible=true");

  // A click on the aircraft, Escape, a click on empty map, and the flight lost from the feed.
  {
    const page = await opened(browser, `${base}/?fixture=1&photos=1${VIEW}`, [1440, 900]);
    const at = await aircraftAt(page);
    check("map select: the fixture's sky has the routed aircraft on the map", at !== null);
    const card = cardOf(page);
    check("map select: no card before a click", (await card.count()) === 0);
    await page.mouse.click(at.x, at.y);
    await card.waitFor({ timeout: 15_000 }).catch(() => {});
    check("map select: a click on an aircraft opens its card, with the callsign", (await card.count()) === 1 && (await card.locator("h2").innerText()) === CALLSIGN);
    check("map select: the card names its route from the route cache", (await card.locator("[data-route]").innerText().catch(() => "")).includes("DFW") && (await card.locator("[data-route]").innerText().catch(() => "")).includes("AUS"));
    check("map select: the card says the faint and dashed lines are estimates", (await card.locator("[data-note]").innerText().catch(() => "")).includes("estimates"));
    await card.locator("[data-photo]").waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    check("map select: the card shows the aircraft's photo, credited", (await card.locator("[data-photo]").isVisible().catch(() => false)) && (await card.locator("figcaption").innerText().catch(() => "")).includes("Test Photographer"));

    // Clear of the card: where it ends up after the map has eased.
    await sleep(2500);
    const box = await card.boundingBox();
    const now = await where(page);
    check("map select: the aircraft stands clear of the card", box !== null && now !== null && !(now.x > box.x - 20 && now.x < box.x + box.width + 20 && now.y > box.y - 20 && now.y < box.y + box.height + 20), JSON.stringify({ now, box }));

    await page.keyboard.press("Escape");
    await sleep(500);
    check("map select: Escape clears the selection", (await card.count()) === 0);

    await page.mouse.click((await where(page)).x, (await where(page)).y);
    await card.waitFor({ timeout: 15_000 }).catch(() => {});
    check("map select: it can be selected again", (await card.count()) === 1);
    await page.mouse.click(700, 760);
    await sleep(500);
    check("map select: a click on empty map clears the selection", (await card.count()) === 0);

    // Lost: taken out of the sky, the card keeps its figures and says so.
    const again = await where(page);
    await page.mouse.click(again.x, again.y);
    await card.waitFor({ timeout: 15_000 }).catch(() => {});
    const speed = await card.locator("dl").innerText().catch(() => "");
    await page.evaluate(`(() => { const g = ${GLOBE}; g.sky.tracks.delete("${HEX}"); })()`);
    await sleep(1500);
    const lost = (await card.locator("[data-note]").innerText().catch(() => "")) || "";
    check("map select: a flight that leaves the feed is said to be lost, with when it was last seen", /^Not in the feed now\. Last seen \d\d:\d\d\.$/.test(lost), lost);
    check("map select: the lost card keeps its last figures", speed.includes("kt") && (await card.locator("dl").innerText().catch(() => "")) === speed);
    check("map select: the lost card cannot be followed", await card.getByRole("button", { name: "Follow this flight" }).first().isDisabled().catch(() => false));
    await page.keyboard.press("Escape");
    await sleep(500);
    check("map select: Escape clears a lost flight too", (await card.count()) === 0);
    await page.close();
  }

  // Follow on the map's card starts the gate-to-gate journey the diorama's Follow does. The flight is
  // climbing out of Dallas-Fort Worth, so the page brings up that airport's diorama on it, and the
  // journey's panel is on its card; the flight lookup is answered here by a stub flying south.
  {
    const t0 = Date.now() / 1000;
    const page = await opened(browser, `${base}/?fixture=1&flight=${CALLSIGN}${VIEW}`, [1440, 900], (p) =>
      p.route(`**/api/hex/${HEX}`, (route) => {
        const now = Date.now() / 1000;
        const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A321", military: false, latitude: 32.88 - ((now - t0) * 85) / 111000, longitude: -97.06, altitudeFt: 4000 + (now - t0) * 30, onGround: false, groundSpeedKt: 165, trackDeg: 180, verticalRateFpm: 1800 };
        return route.fulfill({ json: { hex: HEX, time: now, aircraft } });
      }),
    );
    const card = cardOf(page);
    await card.waitFor({ timeout: 60_000 }).catch(() => {});
    // The recorded routes load just after the map: Follow once the card shows this flight's.
    await card.locator("[data-route]").waitFor({ timeout: 30_000 }).catch(() => {});
    const follow = page.getByRole("button", { name: "Follow this flight" }).locator("visible=true").first();
    await follow.click();
    await page.waitForFunction(() => document.querySelector("[data-journey]") !== null && document.querySelector(".atc-title")?.textContent?.includes("DFW"), null, { timeout: 60_000 }).catch(() => {});
    check("map select: Follow on the map's card starts the journey, on the origin's diorama with the flight's journey panel", (await page.locator("[data-journey]").count()) === 1 && (await page.locator(".atc-title").innerText()).includes("DFW"));
    const pressed = await follow.getAttribute("aria-pressed");
    const panel = await page.locator("[data-journey]").innerText();
    check("map select: the followed flight is pressed on its card, and its panel names both ends", pressed === "true" && panel.includes("DFW") && panel.includes("AUS"), `${pressed}; ${panel.split("\n").join(" ")}`);
    await follow.click();
    await sleep(800);
    check("map select: pressing Follow again lets the flight go", (await page.locator("[data-journey]").count()) === 0);
    await page.close();
  }

  // A link reopens on the map with the flight selected, and the card clears the chrome at each size.
  for (const theme of ["light", "dark"]) {
    for (const size of SIZES) {
      const label = `${size[0]}x${size[1]} ${theme}`;
      const page = await opened(browser, `${base}/?fixture=1&flight=${CALLSIGN}${theme === "light" ? "" : `&theme=${theme}`}${VIEW}`, size);
      const card = cardOf(page);
      await card.waitFor({ timeout: 60_000 }).catch(() => {});
      check(`map select: ${label}: a link with ?flight= reopens with that flight selected`, (await card.count()) === 1 && (await card.locator("h2").innerText().catch(() => "")) === CALLSIGN);
      check(`map select: ${label}: the flight is taken out of the address once it is selected`, !page.url().includes("flight="));
      await sleep(2500);
      const cb = await card.boundingBox();
      const clashes = [];
      for (const [name, sel] of Object.entries(CHROME)) {
        const loc = page.locator(sel).locator("visible=true").first();
        if (!(await loc.count())) continue;
        const b = await loc.boundingBox();
        if (b && cb && overlaps(cb, b)) clashes.push(name);
      }
      check(`map select: ${label}: the card clears the map's chrome`, cb !== null && clashes.length === 0, clashes.join(", "));
      const at = await where(page);
      check(`map select: ${label}: the aircraft is in view and not under the card`, cb !== null && at !== null && at.x > 0 && at.x < size[0] && at.y > 0 && at.y < size[1] && !(at.x > cb.x && at.x < cb.x + cb.width && at.y > cb.y && at.y < cb.y + cb.height), JSON.stringify({ at, cb }));
      await page.close();
    }
  }
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-map-select.mjs")) {
  const results = [];
  let failures = 0;
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(results.at(-1));
    if (!ok) failures++;
  };
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await mapSelectChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3127", check });
  } catch (error) {
    check("map select run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
