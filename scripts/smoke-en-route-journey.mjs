/**
 * Smoke check for the En-route view joining the Journey (ticket #23):
 *
 * - Gate to gate on `?fixture=journey` (the recorded Atlanta to Charlotte flight): Chase picked on the
 *   flight card while the flight is still in Atlanta's Diorama is held there, and takes over once the map
 *   has the flight; it holds across the way, eases into the journey's own shot before the Handover, and the
 *   Handover into Charlotte's Diorama opens in its Approach camera (or Orbit when it has none for the flight).
 * - At phone (375x812) and tablet (768x1024) sizes the Journey card's switch shows, uncovered, on one row (as
 *   on the wide screen's card); Chase, Side and Top each frame the aircraft in the free band below the card,
 *   the whole model clear of it; a 3D camera has the hillshade and a sky, Map neither; back on Map the map
 *   never goes blank.
 * - The fallback: the en-route layer's module failing to load, and a frame rate that stays low (software
 *   GL without `fps=hold`), each return the view to Map with the card's short notice.
 *
 * The terrain tiles are answered here (a flat Terrarium tile, as scripts/smoke-en-route-chase.mjs does). On
 * its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3187 node scripts/smoke-en-route-journey.mjs
 *
 * (`SMOKE_ONLY=screens` or `SMOKE_ONLY=fallback` runs only those parts.) The page exposes no handle on its
 * map, journey or Diorama camera, so the checks reach them through React's fiber, as the other smokes do.
 */

import { launchChrome } from "./lib/chrome.mjs";
import { CALLSIGN, flatTerrain, HEX, STATE } from "./lib/en-route.mjs";
import { fiber, GLOBE, sleep, waitForTruthy } from "./lib/page.mjs";

/** The journey, or null with none. */
const JOURNEY = fiber(`typeof c.stage === "string" && typeof c.hex === "string" && c.origin`);
/** The Diorama's camera rig (Orbit, Tower, Drone, Approach), found from the model's own element. */
const RIG = fiber(`typeof c.mode === "string" && typeof c.lookBy === "function"`, { from: "[role='application']" });

/** What the page shows of the journey and the En-route view now. */
const SAMPLE = `(() => {
  const s = ${STATE};
  const g = ${GLOBE};
  const j = ${JOURNEY};
  const rig = ${RIG};
  const card = document.querySelector("section[aria-label^='Followed flight'], section[aria-label^='Selected flight']");
  return {
    t: Date.now(),
    onMap: !!document.querySelector("main")?.dataset.onMap,
    stage: j ? j.stage : null,
    airport: g ? g.airport.code : null,
    camera: s ? s.camera : null,
    pressed: s ? s.pressed : null,
    terrain: !!(s && s.terrain),
    layer: s ? s.layer : null,
    drawn: s ? s.drawn : 0,
    pitch: g ? g.map.getPitch() : null,
    bearing: g ? g.map.getBearing() : null,
    zoom: g ? g.map.getZoom() : null,
    share: g ? g.enRoute.share : null,
    mode: rig ? rig.mode : null,
    card: card ? card.innerText.replace(/\\s+/g, " ").slice(0, 140) : "",
  };
})()`;

/** How long the page may show nothing new before the gate-to-gate run gives up on it, and the most it may take in all. */
const STALL_MS = 120_000;
const CAP_MS = 30 * 60_000;

/** Criteria 1 and 2: Chase picked in Atlanta's Diorama, ridden gate to gate into Charlotte's. */
async function gateToGate({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  try {
    await flatTerrain(page);
    await page.goto(`${base}/?fixture=journey&flight=DAL1947&fixtureFrom=150&fps=hold`);
    const card = page.locator("section[aria-label^='Selected flight']");
    await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "DAL1947", null, { timeout: 120_000 });
    await page.waitForFunction(() => /Departing/.test(document.querySelector("section[aria-label^='Selected flight']")?.textContent ?? ""), null, { timeout: 120_000 }).catch(() => {});
    const follow = card.getByRole("button", { name: "Follow this flight" }).last();
    let started = false;
    for (let attempt = 1; attempt <= 3 && !started; attempt++) {
      if ((await follow.getAttribute("aria-pressed")) === "true") await follow.click();
      await follow.click();
      started = await page.waitForFunction(() => !!document.querySelector("[data-journey]"), null, { timeout: 30_000 }).then(() => true, () => false);
    }
    check("en-route journey: Follow starts the journey in Atlanta's Diorama", started);
    if (!started) return;

    // Chase, picked on the flight card while the flight is still in the origin's Diorama.
    const group = card.getByRole("group", { name: "En-route camera" });
    const offered = await group.waitFor({ timeout: 15_000 }).then(() => true, () => false);
    check("en-route journey: the flight card offers the En-route cameras while the journey is in the origin's Diorama", offered && (await page.evaluate(SAMPLE)).stage === "origin");
    if (!offered) return;
    await group.getByRole("button", { name: "Chase", exact: true }).click();
    await sleep(2_000);
    const held = await page.evaluate(SAMPLE);
    check("en-route journey: Chase picked in the origin's Diorama is pressed there, but held: the map under the Diorama stays flat, with no terrain or model", held.stage === "origin" && held.pressed === "Chase" && held.camera === "map" && !held.terrain && held.layer === null, JSON.stringify(held));

    // Ride it gate to gate, sampling, until Charlotte's Diorama has the flight.
    const samples = [];
    const begun = Date.now();
    let moved = Date.now();
    let seen = "";
    let stuck = null;
    for (;;) {
      const s = await page.evaluate(SAMPLE);
      samples.push(s);
      if (s.stage === "destination" || s.stage === "arrived") break;
      const sig = `${s.card}|${s.stage}`;
      if (sig !== seen) {
        seen = sig;
        moved = Date.now();
      }
      if (Date.now() - moved > STALL_MS) {
        stuck = `nothing new for ${STALL_MS / 1000} s at ${JSON.stringify(s)}`;
        break;
      }
      if (Date.now() - begun > CAP_MS) {
        stuck = `still going after ${CAP_MS / 60_000} minutes at ${JSON.stringify(s)}`;
        break;
      }
      await sleep(300);
    }
    const onMap = samples.filter((s) => s.stage === "map");
    check("en-route journey: the flight is ridden out of Atlanta, across the map and handed into Charlotte's Diorama", !stuck && onMap.length > 0 && samples.at(-1).stage !== "map", stuck ?? `${onMap.length} samples on the map`);

    // Criterion 2: once out of the origin's Diorama, the chosen Chase takes over: terrain, the model, the tilt.
    const takeover = onMap.findIndex((s) => s.camera === "chase" && s.terrain && s.layer === "custom" && s.drawn > 5 && s.pitch > 60);
    check("en-route journey: leaving the origin's Diorama, the Chase chosen there takes over (terrain, the aircraft's model, the map tilted behind it)", takeover >= 0, takeover >= 0 ? `after ${((onMap[takeover].t - onMap[0].t) / 1000).toFixed(1)} s on the map: ${JSON.stringify(onMap[takeover])}` : JSON.stringify(onMap.slice(0, 3)));
    const leaving = onMap.slice(0, Math.max(0, takeover));
    check("en-route journey: until it has, the flat map hands out of the Diorama as usual (the 3D view eases in only out of its band)", leaving.length > 0 && leaving[0].share < 0.5, leaving.length ? JSON.stringify(leaving[0]) : "taken over on the first sample");
    // Held all the way: the card keeps Chase pressed on the map until the Handover.
    const unheld = onMap.filter((s) => s.pressed !== "Chase");
    check("en-route journey: Chase holds across the way, pressed on the Journey card until the Handover", unheld.length === 0, unheld.length ? JSON.stringify(unheld[0]) : `${onMap.length} samples`);

    // Criterion 1: it eases into the journey's own shot (share to 0, terrain off) before the Handover begins.
    const last3D = onMap.findLastIndex((s) => s.terrain);
    const before = onMap.slice(last3D + 1);
    const eased = before.length > 0 && before.every((s) => s.share === 0 && !s.terrain && s.layer === null);
    check("en-route journey: arriving, Chase eases into the journey's own flat shot, terrain off, before the Handover into Charlotte", last3D >= 0 && eased, `last 3D sample ${last3D} of ${onMap.length}; then ${before.length} flat samples; ${JSON.stringify(onMap[last3D])}`);
    // The ease is continuous: no frame-to-frame step in the tilt like the old snap back to Map (75 to 60 degrees at once).
    let jump = 0;
    for (let i = Math.max(1, takeover); i < onMap.length; i++) if (onMap[i].t - onMap[i - 1].t < 1500) jump = Math.max(jump, Math.abs(onMap[i].pitch - onMap[i - 1].pitch));
    check("en-route journey: the camera's tilt never steps on the way (largest change between samples under 12 degrees)", jump < 12, `${jump.toFixed(1)} degrees`);

    // Charlotte's Diorama opens in its Approach camera when it has one for the flight, else Orbit.
    const mode = await waitForTruthy(page, `(() => { const r = ${RIG}; return r && r.mode; })()`, 10_000).then(() => page.evaluate(`${RIG}.mode`), () => null);
    const offeredModes = await page.evaluate(() => [...document.querySelectorAll("[role='group'][aria-label='Camera'] button, [aria-label='Camera'] button")].map((b) => b.textContent.trim()));
    check("en-route journey: Charlotte's Diorama takes the flight in its Approach camera (Orbit when it has none for the flight)", mode === "approach" || mode === "orbit", `opened in ${mode}; offered ${JSON.stringify(offeredModes)}`);
    const flat = await page.evaluate(STATE);
    check("en-route journey: the map under the destination's Diorama is flat again, the En-route camera back to Map", flat && flat.camera === "map" && flat.terrain === null && flat.layer === null, JSON.stringify({ ...flat, credit: undefined }));
    check("en-route journey: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
  } finally {
    await page.close();
  }
}

/** A flight followed on the map (JBU1897, westbound, no route), at `viewport`; returns the page and the switch. */
async function followOnMap(browser, base, viewport, { query = "fixture=1&fps=hold", before = async () => {} } = {}) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const asked = await flatTerrain(page);
  const t0 = Date.now() / 1000;
  await page.route(`**/api/hex/${HEX}`, (r) => {
    const now = Date.now() / 1000;
    const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A320", military: false, latitude: 33.7, longitude: -85.4 - (now - t0) * 0.0021, altitudeFt: 11000, onGround: false, groundSpeedKt: 420, trackDeg: 270, verticalRateFpm: 800 };
    return r.fulfill({ json: { hex: HEX, time: now, aircraft } });
  });
  await page.route(`**/api/flight/${CALLSIGN}`, (r) => r.fulfill({ json: { callsign: CALLSIGN, route: null } }));
  await before(page);
  await page.goto(`${base}/?${query}#map=7/33.6/-84.4`);
  await page.locator("main[data-on-map]").waitFor({ timeout: 60_000 });
  let at = null;
  for (let i = 0; i < 120 && !at; i++) {
    at = await page.evaluate(`(() => { const g = ${GLOBE}; const f = g && g.drawn.find((x) => x.properties.id === "${HEX}"); if (!f) return null; const p = g.map.project(f.geometry.coordinates); return { x: p.x, y: p.y }; })()`);
    if (!at) await sleep(500);
  }
  await page.evaluate(`(() => { const g = ${GLOBE}; g.routes.delete("${CALLSIGN}"); })()`);
  if (at) await page.mouse.click(at.x, at.y);
  await page.locator("section[aria-label^='Selected flight']").locator("visible=true").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Follow this flight" }).locator("visible=true").first().click();
  const group = page.getByRole("group", { name: "En-route camera" });
  await group.waitFor({ timeout: 30_000 });
  await sleep(1_500);
  return { page, group, problems, asked };
}

/** How much of the map shows below the card at once: pixels unlike the map's most common colour, in the band between the card and the foot. A blank map is all one colour. */
async function mapDetail(page, shot, band) {
  return page.evaluate(
    async ([b64, { top, bottom }]) => {
      const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const x = c.getContext("2d");
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, top, img.width, Math.max(1, bottom - top)).data;
      const counts = new Map();
      for (let i = 0; i < d.length; i += 4) {
        const k = `${d[i] >> 3},${d[i + 1] >> 3},${d[i + 2] >> 3}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const common = [...counts.values()].sort((a, b) => b - a)[0];
      return d.length / 4 - common;
    },
    [shot.toString("base64"), band],
  );
}

/** The camera switch's rows (its buttons' distinct tops) and whether its buttons fit inside it. */
const SWITCH_ROWS = `(() => {
  const g = [...document.querySelectorAll("[role='group'][aria-label='En-route camera']")].find((e) => e.offsetParent);
  if (!g) return null;
  return { rows: new Set([...g.querySelectorAll("button")].map((b) => Math.round(b.getBoundingClientRect().top))).size, fits: g.scrollWidth <= g.clientWidth };
})()`;

/** Where the en-route layer last drew the aircraft's origin, in the map's CSS pixels; null before it has. */
const DRAWN_AT = `(() => {
  const g = ${GLOBE};
  const l = g && g.map.getLayer("en-route-aircraft");
  const d = l && l.implementation.drawnAt;
  if (!d) return null;
  const c = g.map.getContainer();
  return { x: (d.x + 1) / 2 * c.clientWidth, y: (1 - d.y) / 2 * c.clientHeight };
})()`;

/** The 3D view's air on the map now: whether the hillshade layer is in, and the sky's colours. */
const AIR = `(() => { const g = ${GLOBE}; if (!g) return null; const sky = g.map.getSky() || {}; return { hillshade: !!g.map.getLayer("hillshade"), sky: sky["sky-color"] ?? null, horizon: sky["horizon-color"] ?? null }; })()`;

/** The followed aircraft's model paint (Light's selection colour, PALETTES.light.selected) in a screenshot: the box round it, or null with none. */
async function modelBox(page, shot) {
  return page.evaluate(async (b64) => {
    const img = await new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    let [l, t, r, b] = [Infinity, Infinity, -1, -1];
    for (let y = 0; y < img.height; y++) {
      for (let i = 0; i < img.width; i++) {
        const k = (y * img.width + i) * 4;
        if (Math.abs(d[k] - 0x6d) + Math.abs(d[k + 1] - 0x28) + Math.abs(d[k + 2] - 0xd9) < 90) [l, t, r, b] = [Math.min(l, i), Math.min(t, y), Math.max(r, i), Math.max(b, y)];
      }
    }
    return r < 0 ? null : { left: l, top: t, right: r, bottom: b };
  }, shot.toString("base64"));
}

/**
 * Criterion 4: the switch at phone and tablet sizes, one row, into Chase, Side and Top with the aircraft in
 * the free band below the card, the hillshade and sky on in 3D only, and the map never blank on the way back.
 */
async function smallScreens({ browser, base, check }) {
  for (const [name, viewport] of [["phone", { width: 375, height: 812 }], ["tablet", { width: 768, height: 1024 }]]) {
    const { page, group, problems } = await followOnMap(browser, base, viewport);
    try {
      // Every button of the switch on screen and not covered by anything (the foot's controls, the search).
      const buttons = await group.getByRole("button").all();
      const reachable = [];
      for (const b of buttons) {
        const box = await b.boundingBox();
        const hit = box && (await page.evaluate(([x, y, label]) => document.elementFromPoint(x, y)?.closest("button")?.textContent?.trim() === label, [box.x + box.width / 2, box.y + box.height / 2, (await b.textContent()).trim()]));
        reachable.push({ label: (await b.textContent()).trim(), inside: !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, hit, height: box?.height ?? 0 });
      }
      check(`en-route ${name} (${viewport.width}x${viewport.height}): the Journey card shows the switch, every camera on screen, uncovered and at least 44 px tall`, reachable.length === 5 && reachable.every((r) => r.inside && r.hit && r.height >= 43.5), JSON.stringify(reachable));
      const rows = await page.evaluate(SWITCH_ROWS);
      check(`en-route ${name}: the switch's five cameras are one row`, rows && rows.rows === 1 && rows.fits, JSON.stringify(rows));
      const flatAir = await page.evaluate(AIR);

      // Chase, Side and Top: the aircraft framed in the band between the card and the controls at the foot, the whole model clear of the card.
      for (const camera of ["Chase", "Side", "Top"]) {
        await group.getByRole("button", { name: camera, exact: true }).click();
        const on = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.camera === "${camera.toLowerCase()}" && s.pressed === "${camera}" && s.terrain && s.layer === "custom" && s.drawn > 5; })()`, 60_000).then(() => true, () => false);
        if (camera === "Chase") check(`en-route ${name}: Chase comes on (terrain, the aircraft's model, the map tilted behind it)`, on && (await page.evaluate(STATE)).pitch > 60, JSON.stringify({ ...(await page.evaluate(STATE)), credit: undefined }));
        // The rig eases onto the aircraft; software GL draws a frame every second or so: wait until it holds still.
        let at = null;
        let last = null;
        const until = Date.now() + 60_000;
        while (Date.now() < until) {
          await sleep(1_500);
          at = await page.evaluate(DRAWN_AT);
          if (at && last && Math.hypot(at.x - last.x, at.y - last.y) < 3) break;
          last = at;
        }
        const card = await page.locator("section[aria-label^='Followed flight']").boundingBox();
        const foot = await page.evaluate(() => Math.min(...[...document.querySelectorAll("[data-map-foot], .maplibregl-ctrl-attrib")].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0 && r.top > 200).map((r) => r.top)));
        const band = { top: card.y + card.height, bottom: Math.min(foot, viewport.height) };
        const model = await modelBox(page, await page.screenshot());
        const inBand = !!at && at.y > band.top && at.y < band.bottom && at.x > 0 && at.x < viewport.width;
        const clear = !!model && model.top > band.top && model.bottom < band.bottom;
        check(`en-route ${name}: in ${camera} the aircraft stands in the free band below the Journey card, the whole model clear of the card and the foot`, on && inBand && clear, JSON.stringify({ at, band, model }));
        if (camera === "Top") {
          const air = await page.evaluate(AIR);
          check(`en-route ${name}: a 3D camera shades the relief (a hillshade layer) and has a sky apart from its horizon, unlike the flat map's`, air.hillshade && air.sky !== air.horizon && !flatAir.hillshade && flatAir.sky === flatAir.horizon, JSON.stringify({ air, flatAir }));
        }
      }

      // Back to Map: the map eases back out, and shows the map all the way (no blank frame as it lands on Map).
      const card = await page.locator("section[aria-label^='Followed flight']").boundingBox();
      const foot = await page.evaluate(() => Math.min(...[...document.querySelectorAll("[data-map-foot], .maplibregl-ctrl-attrib")].map((e) => e.getBoundingClientRect()).filter((r) => r.height > 0 && r.top > 200).map((r) => r.top)));
      const band = { top: Math.round(card.y + card.height + 8), bottom: Math.round(Math.min(foot, viewport.height) - 8) };
      await group.getByRole("button", { name: "Map", exact: true }).click();
      const details = [];
      const end = Date.now() + 4_000;
      while (Date.now() < end) details.push(await mapDetail(page, await page.screenshot(), band));
      const flat = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.camera === "map" && s.pressed === "Map" && s.terrain === null && s.layer === null; })()`, 15_000).then(() => true, () => false);
      check(`en-route ${name}: Map takes the terrain and the model off again`, flat, JSON.stringify({ ...(await page.evaluate(STATE)), credit: undefined }));
      const backAir = await page.evaluate(AIR);
      check(`en-route ${name}: Map takes the hillshade off and has its own sky back`, !backAir.hillshade && JSON.stringify(backAir) === JSON.stringify(flatAir), JSON.stringify(backAir));
      const area = viewport.width * (band.bottom - band.top);
      check(`en-route ${name}: going back to Map the map is never blank (every screenshot over 4 s shows map detail below the card)`, details.length > 3 && Math.min(...details) > area * 0.002, `${details.length} shots, least detail ${Math.min(...details)} of ${area} pixels`);
      check(`en-route ${name}: the journey runs on, console clean`, (await page.locator("section[aria-label^='Followed flight']").count()) > 0 && problems.length === 0, problems.slice(0, 3).join(" | "));
    } finally {
      await page.close();
    }
  }
}

/** The fallback in the page: the layer's module failing to load, and a frame rate that stays low, each go back to Map with the notice. */
async function fallbacks({ browser, base, check }) {
  {
    // The module is a chunk loaded on the first 3D pick: from the Follow on, a chunk with the layer's shader in it fails.
    let armed = false;
    let refused = 0;
    const { page, group } = await followOnMap(browser, base, { width: 1440, height: 900 }, {
      before: (p) =>
        p.route("**/_next/static/chunks/**", async (r) => {
          if (!armed) return r.fallback();
          const res = await r.fetch();
          const body = await res.text();
          if (body.includes("u_turn")) {
            refused++;
            return r.fulfill({ status: 503, body: "" });
          }
          return r.fulfill({ response: res, body });
        }),
    });
    try {
      const rows = await page.evaluate(SWITCH_ROWS);
      check("en-route wide (1440x900): the switch's five cameras are one row on the flight card in the column", rows && rows.rows === 1 && rows.fits, JSON.stringify(rows));
      armed = true;
      await group.getByRole("button", { name: "Chase", exact: true }).click();
      const back = await waitForTruthy(page, `(() => { const s = ${STATE}; const n = document.querySelector("[data-en-route-notice]"); return s && s.camera === "map" && s.pressed === "Map" && n && /not available/.test(n.textContent); })()`, 30_000).then(() => true, () => false);
      const flat = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.terrain === null && s.layer === null; })()`, 15_000).then(() => true, () => false);
      const notice = await page.locator("[data-en-route-notice]").innerText().catch(() => "");
      check("en-route fallback: the aircraft's layer failing to load returns the view to Map, terrain off, with the card's notice", refused > 0 && back && flat, `${refused} refused; notice "${notice}"`);
    } finally {
      await page.close();
    }
  }
  {
    // Software GL draws Chase at a few frames a second: without `fps=hold` the view gives up after a few seconds.
    const { page, group } = await followOnMap(browser, base, { width: 1440, height: 900 }, { query: "fixture=1" });
    try {
      await group.getByRole("button", { name: "Chase", exact: true }).click();
      const on = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.terrain && s.layer === "custom"; })()`, 30_000).then(() => Date.now(), () => null);
      const back = await waitForTruthy(page, `(() => { const s = ${STATE}; const n = document.querySelector("[data-en-route-notice]"); return s && s.camera === "map" && s.pressed === "Map" && n && /could not keep up/.test(n.textContent); })()`, 40_000).then(() => Date.now(), () => null);
      const flat = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.terrain === null && s.layer === null; })()`, 15_000).then(() => true, () => false);
      const fps = await page.evaluate(`new Promise((res) => { const t = []; const f = (n) => { t.push(n); if (n - t[0] < 1000) requestAnimationFrame(f); else res(Math.round(t.length / ((n - t[0]) / 1000))); }; requestAnimationFrame(f); })`);
      check("en-route fallback: a frame rate that stays under 20 fps returns the view to Map after a few seconds, with the card's notice", !!on && !!back && flat && back - on >= 2_500, on && back ? `back after ${((back - on) / 1000).toFixed(1)} s in Chase; ${fps} fps on Map` : `on ${on}, back ${back}`);
      // The notice goes after a while.
      const gone = await waitForTruthy(page, `(() => { const n = document.querySelector("[data-en-route-notice]"); return n && !n.textContent.trim(); })()`, 15_000).then(() => true, () => false);
      check("en-route fallback: the notice is short-lived", gone);
    } finally {
      await page.close();
    }
  }
}

export async function enRouteJourneyChecks({ browser, base, check }) {
  const only = process.env.SMOKE_ONLY;
  if (!only || only === "screens") await smallScreens({ browser, base, check });
  if (!only || only === "fallback") await fallbacks({ browser, base, check });
  if (!only || only === "journey") await gateToGate({ browser, base, check });
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-en-route-journey.mjs")) {
  const results = [];
  let failures = 0;
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(results.at(-1));
    if (!ok) failures++;
  };
  const browser = await launchChrome({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await enRouteJourneyChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3187", check });
  } catch (error) {
    check("en-route journey run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
