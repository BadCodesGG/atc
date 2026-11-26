/**
 * Smoke check for the En-route view's tracer (ticket #21): a flight followed on the World map, the Journey
 * card's Chase camera picked and then Map again. In Chase the terrain source and the terrain are on, the
 * aircraft's custom layer is there and draws the model where the camera looks, and the terrain's credit
 * shows; back in Map the terrain and its source are gone, and no terrain tile is ever asked for in Map.
 *
 * The terrain tiles are answered here (a flat Terrarium tile 300 m up), so the run needs no network for
 * them and counts every one the page asks for. On its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3185 node scripts/smoke-en-route-chase.mjs
 *
 * The page exposes no handle on its map, so the checks reach it through React's fiber, as
 * scripts/smoke-journey-live.mjs does.
 */

import { launchChrome } from "./lib/chrome.mjs";
import { CALLSIGN, flatTerrain, HEX, STATE } from "./lib/en-route.mjs";
import { GLOBE, sleep, waitForTruthy } from "./lib/page.mjs";

export async function enRouteChaseChecks({ browser, base, check, shots = null }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  const blocked = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
    if (/Content Security Policy/i.test(m.text())) blocked.push(m.text());
  });
  const terrainAsked = await flatTerrain(page);
  const t0 = Date.now() / 1000;
  await page.route(`**/api/hex/${HEX}`, (r) => {
    const now = Date.now() / 1000;
    const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A320", military: false, latitude: 33.7, longitude: -85.4 - (now - t0) * 0.0021, altitudeFt: 11000, onGround: false, groundSpeedKt: 420, trackDeg: 270, verticalRateFpm: 800 };
    return r.fulfill({ json: { hex: HEX, time: now, aircraft } });
  });
  await page.route(`**/api/flight/${CALLSIGN}`, (r) => r.fulfill({ json: { callsign: CALLSIGN, route: null } }));
  // `fps=hold`: the smokes' software GL draws 3D at a few frames a second, which would otherwise send the view back to Map.
  await page.goto(`${base}/?fixture=1&fps=hold#map=7/33.6/-84.4`);
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
  // Let the flat map follow it a while: still no terrain.
  await sleep(3_000);
  const inMap = await page.evaluate(STATE);
  check("en-route: Following starts in Map, flat, with no terrain source, no terrain and no aircraft layer", inMap?.camera === "map" && inMap.pressed === "Map" && inMap.source === null && inMap.terrain === null && inMap.layer === null, JSON.stringify(inMap));
  check("en-route: no terrain tile is asked for in Map", terrainAsked.length === 0, `${terrainAsked.length} asked`);

  await group.getByRole("button", { name: "Chase", exact: true }).click();
  const chased = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.source === "raster-dem" && s.terrain && s.layer === "custom" && s.drawn > 30; })()`, 30_000).then(() => true, () => false);
  // The camera eases in from the flat map's shot: give it time to settle behind the aircraft.
  await sleep(4_000);
  const inChase = await page.evaluate(STATE);
  check("en-route: Chase turns on the raster-dem terrain source and the terrain, and adds the aircraft's custom layer, which draws", chased && inChase.camera === "chase" && inChase.pressed === "Chase", JSON.stringify({ ...inChase, credit: undefined }));
  check("en-route: Chase tilts the map behind the aircraft, within the map's 78 degrees", inChase.pitch > 60 && inChase.pitch <= 78, `pitch ${inChase.pitch}`);
  check("en-route: Chase loads the terrain tiles", terrainAsked.length > 0, `${terrainAsked.length} asked`);
  // The Content-Security-Policy lets the tiles in through connect-src alone (src/lib/csp.ts): MapLibre fetches
  // them, so a tile the policy blocked would never reach the route, and an <img> load would need img-src.
  const kinds = [...new Set(terrainAsked.map((a) => a.type))];
  check("en-route: the terrain tiles are fetched (connect-src), never loaded as images", kinds.length === 1 && kinds[0] === "fetch", kinds.join(", "));
  check("en-route: the tiles come from the Terrarium path the policy names", terrainAsked.every((a) => a.url.startsWith("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/")), terrainAsked[0]?.url ?? "none");
  check("en-route: no Content-Security-Policy violation", blocked.length === 0, blocked.slice(0, 2).join(" | "));
  check("en-route: the terrain's credit shows in Chase", /Terrain Tiles/.test(inChase.credit), inChase.credit);

  // The model where the camera looks: the screen round the map's centre point, with the layer and without.
  const centre = await page.evaluate(`(() => { const g = ${GLOBE}; const p = g.map.getPadding(); const r = g.map.getContainer().getBoundingClientRect(); return { x: r.left + p.left + (r.width - p.left - p.right) / 2, y: r.top + p.top + (r.height - p.top - p.bottom) / 2 }; })()`);
  const clip = { x: Math.round(centre.x - 150), y: Math.round(centre.y - 100), width: 300, height: 200 };
  const shown = await page.screenshot({ clip });
  if (shots) await page.screenshot({ path: `${shots}/en-route-chase.png` });
  await page.evaluate(`(() => { const g = ${GLOBE}; g.map.setLayoutProperty("en-route-aircraft", "visibility", "none"); })()`);
  await sleep(400);
  const hidden = await page.screenshot({ clip });
  await page.evaluate(`(() => { const g = ${GLOBE}; g.map.setLayoutProperty("en-route-aircraft", "visibility", "visible"); })()`);
  const changed = await page.evaluate(
    async ([a, b]) => {
      const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = `data:image/png;base64,${b64}`; });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const pixels = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
      const pa = pixels(ia);
      const pb = pixels(ib);
      let n = 0;
      for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 60) n++;
      return n;
    },
    [shown.toString("base64"), hidden.toString("base64")],
  );
  check("en-route: the aircraft's model is drawn where the Chase camera looks (pixels round the centre change with the layer on and off)", changed > 800, `${changed} of ${clip.width * clip.height} pixels differ`);

  // A theme switch restyles the map in place: the terrain, its source and the aircraft's layer come through it.
  await page.getByRole("group", { name: "Map style" }).locator("visible=true").getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("main")?.dataset.theme === "dark", null, { timeout: 10_000 });
  const drawnBefore = (await page.evaluate(STATE)).drawn;
  const themed = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.source === "raster-dem" && s.terrain && s.layer === "custom" && s.drawn > ${drawnBefore} + 5; })()`, 15_000).then(() => true, () => false);
  check("en-route: a theme switch in Chase keeps the terrain and the aircraft's layer, still drawing", themed, JSON.stringify({ ...(await page.evaluate(STATE)), credit: undefined }));

  await group.getByRole("button", { name: "Map", exact: true }).click();
  const flat = await waitForTruthy(page, `(() => { const s = ${STATE}; return s && s.camera === "map" && s.source === null && s.terrain === null && s.layer === null; })()`, 10_000).then(() => true, () => false);
  await sleep(500);
  const askedAtMap = terrainAsked.length;
  await sleep(4_000);
  const back = await page.evaluate(STATE);
  check("en-route: Map takes the terrain, its source and the aircraft's layer off again", flat && back.pressed === "Map", JSON.stringify({ ...back, credit: undefined }));
  check("en-route: no more terrain tiles are asked for once back in Map", terrainAsked.length === askedAtMap, `${askedAtMap} then ${terrainAsked.length}`);
  check("en-route: the terrain's credit goes with it", !/Terrain Tiles/.test(back.credit), back.credit);
  check("en-route: the journey runs on through it all", (await page.locator("section[aria-label^='Followed flight']").count()) > 0);
  check("en-route: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
  await page.close();
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-en-route-chase.mjs")) {
  const results = [];
  let failures = 0;
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(results.at(-1));
    if (!ok) failures++;
  };
  const args = process.env.HEADED ? ["--ignore-gpu-blocklist"] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
  const browser = await launchChrome({ headless: !process.env.HEADED, args });
  try {
    await enRouteChaseChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3185", check, shots: process.env.SMOKE_SHOTS ?? null });
  } catch (error) {
    check("en-route run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
