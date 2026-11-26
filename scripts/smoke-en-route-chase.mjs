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

import { deflateSync } from "node:zlib";
import { launchChrome } from "./lib/chrome.mjs";
import { waitForTruthy } from "./smoke-journey-procedures.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The map's instance (GlobeMap), found through React's fiber from `main`. */
const GLOBE = `(() => {
  const el = document.querySelector("main");
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      const c = h.memoizedState && h.memoizedState.current;
      if (c && c.map && typeof c.map.project === "function" && c.drawn) return c;
    }
  }
  return null;
})()`;

/** What the map has of the En-route view now. */
const STATE = `(() => {
  const g = ${GLOBE};
  if (!g) return null;
  const m = g.map;
  const layer = m.getLayer("en-route-aircraft");
  const credit = document.querySelector(".maplibregl-ctrl-attrib-inner");
  return {
    camera: g.enRouteCamera,
    source: m.getSource("terrain")?.type ?? null,
    terrain: m.getTerrain(),
    layer: layer ? layer.type : null,
    drawn: layer ? layer.implementation.drawnFrames : 0,
    pitch: m.getPitch(),
    credit: credit ? credit.textContent : "",
    pressed: document.querySelector("[role='group'][aria-label='En-route camera'] button[aria-pressed='true']")?.textContent?.trim() ?? null,
  };
})()`;

// A Terrarium tile all at one height: height = R * 256 + G + B / 256 - 32768.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function flatTile(heightM, size = 256) {
  const v = heightM + 32768;
  const [r, g, b] = [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)];
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) raw.set([r, g, b], row + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const TILE = flatTile(300);

/**
 * JBU1897 (hex a37fb0) is in the fixture's sky 51 NM west of Atlanta. Picked on the map and followed, its
 * own reads have it cruising west at 11,000 ft, climbing gently, with no route: the journey stays on the map.
 */
const HEX = "a37fb0";
const CALLSIGN = "JBU1897";

export async function enRouteChaseChecks({ browser, base, check, shots = null }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const terrainAsked = [];
  await page.route("**/elevation-tiles-prod/terrarium/**", (r) => {
    terrainAsked.push(r.request().url());
    return r.fulfill({ status: 200, contentType: "image/png", body: TILE, headers: { "access-control-allow-origin": "*" } });
  });
  const t0 = Date.now() / 1000;
  await page.route(`**/api/hex/${HEX}`, (r) => {
    const now = Date.now() / 1000;
    const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A320", military: false, latitude: 33.7, longitude: -85.4 - (now - t0) * 0.0021, altitudeFt: 11000, onGround: false, groundSpeedKt: 420, trackDeg: 270, verticalRateFpm: 800 };
    return r.fulfill({ json: { hex: HEX, time: now, aircraft } });
  });
  await page.route(`**/api/flight/${CALLSIGN}`, (r) => r.fulfill({ json: { callsign: CALLSIGN, route: null } }));
  await page.goto(`${base}/?fixture=1#map=7/33.6/-84.4`);
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
