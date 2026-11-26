/**
 * Smoke check for the En-route view's cameras (ticket #22): a flight followed on the World map, switched
 * through Chase, Cockpit, Side, Top and back to Map with the Journey card's buttons, then again with the
 * keys 1 to 5. Each camera's map bearing and pitch stand as it frames the aircraft's track; the camera
 * picked holds across feed reads; a drag in a 3D camera turns the bearing while held, and it eases back
 * to the framing once let go, with the journey still on; a digit typed in the search box switches nothing.
 *
 * The followed flight flies due west (track 270) at 11,000 ft, so:
 *   Chase   bearing 270, pitch 75 (15 degrees down at it)
 *   Cockpit bearing 270, pitch 91 (90 plus its climb's 1.1 degrees: 800 fpm at 420 kt), the map's limit past
 *           level while a 3D camera is on, the camera looking ahead of the aircraft, no model drawn
 *   Side    bearing 0 (from the left of a westbound track, looking north at it), pitch 90 (level, at wing height)
 *   Top     bearing 270, pitch 0
 * and the map's tilt limit is the En-route cameras' (110) in each 3D camera, the flat map's 78 back on Map.
 *
 * On its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3186 node scripts/smoke-en-route-cameras.mjs
 */

import { launchChrome } from "./lib/chrome.mjs";
import { CALLSIGN, flatTerrain, HEX, STATE } from "./lib/en-route.mjs";
import { GLOBE, selectOnMap, sleep, waitForTruthy } from "./lib/page.mjs";

const TRACK = 270;
/** What each camera's map camera should be for the westbound flight: bearing, pitch, each to within `tol` degrees. */
const FRAMING = {
  chase: { bearing: 270, pitch: 75 },
  cockpit: { bearing: 270, pitch: 91.1 },
  side: { bearing: 0, pitch: 90 },
  top: { bearing: 270, pitch: 0 },
};
const LABEL = { map: "Map", chase: "Chase", cockpit: "Cockpit", side: "Side", top: "Top" };
const KEY = { map: "1", chase: "2", cockpit: "3", side: "4", top: "5" };

/** The signed difference between two bearings, -180 to 180. */
const turn = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

/** The camera now, with the aircraft's place (the journey's mark) and whether the layer has a pose to draw. */
const CAMERA = `(() => {
  const s = ${STATE};
  if (!s) return null;
  const g = ${GLOBE};
  const m = g.map;
  const c = m.getCenter();
  const mark = g.journeyData.features.find((f) => f.properties.part === "aircraft");
  const layer = m.getLayer("en-route-aircraft");
  return {
    ...s,
    credit: undefined,
    bearing: ((m.getBearing() % 360) + 360) % 360,
    maxPitch: m.getMaxPitch(),
    centre: [c.lng, c.lat],
    aircraft: mark ? mark.geometry.coordinates : null,
    modelPosed: layer ? !!layer.implementation.pose : null,
    haze: layer ? layer.implementation.hazeDrawn : null,
    hashPitch: Number((/(?:^#|&)map=([^&]*)/.exec(location.hash)?.[1] ?? "").split("/")[4] ?? 0),
  };
})()`;

export async function enRouteCameraChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const problems = [];
  page.on("pageerror", (e) => problems.push(String(e)));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await flatTerrain(page);
  const t0 = Date.now() / 1000;
  let reads = 0;
  await page.route(`**/api/hex/${HEX}`, (r) => {
    reads++;
    const now = Date.now() / 1000;
    const aircraft = { id: HEX, callsign: CALLSIGN, typeCode: "A320", military: false, latitude: 33.7, longitude: -85.4 - (now - t0) * 0.0021, altitudeFt: 11000, onGround: false, groundSpeedKt: 420, trackDeg: TRACK, verticalRateFpm: 800 };
    return r.fulfill({ json: { hex: HEX, time: now, aircraft } });
  });
  await page.route(`**/api/flight/${CALLSIGN}`, (r) => r.fulfill({ json: { callsign: CALLSIGN, route: null } }));
  // `fps=hold`: the smokes' software GL draws 3D at a few frames a second, which would otherwise send the view back to Map.
  await page.goto(`${base}/?fixture=1&fps=hold#map=7/33.6/-84.4`);
  await page.locator("main[data-on-map]").waitFor({ timeout: 60_000 });
  await selectOnMap(page, HEX, { forgetRoute: CALLSIGN });
  await page.locator("section[aria-label^='Selected flight']").locator("visible=true").waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Follow this flight" }).locator("visible=true").first().click();
  const group = page.getByRole("group", { name: "En-route camera" });
  await group.waitFor({ timeout: 30_000 });
  await sleep(2_000);

  const buttons = await group.getByRole("button").allTextContents();
  check("cameras: the Journey card offers Map, Chase, Cockpit, Side and Top, in that order", JSON.stringify(buttons.map((b) => b.trim())) === JSON.stringify(["Map", "Chase", "Cockpit", "Side", "Top"]), JSON.stringify(buttons));

  /** Waits for `camera` to be on and settled, then checks its framing against the track. */
  const framed = async (camera, how) => {
    const on = await waitForTruthy(page, `(() => { const s = ${CAMERA}; return s && s.camera === "${camera}" && s.pressed === "${LABEL[camera]}"; })()`, 10_000).then(() => true, () => false);
    if (camera === "map") {
      const flat = await waitForTruthy(page, `(() => { const s = ${CAMERA}; return s && s.terrain === null && s.layer === null; })()`, 10_000).then(() => true, () => false);
      const s = await page.evaluate(CAMERA);
      check(`cameras (${how}): Map is back, flat, the terrain and the model's layer gone, the tilt limit 78 again`, on && flat && s.pitch <= 60 && s.maxPitch === 78, JSON.stringify(s));
      return s;
    }
    // The rig eases in over a second or two (EASE_S 0.7 s, at most 0.25 s a frame): software WebGL draws a
    // few frames a second, so wait for it to settle, then hold a moment more.
    const want = FRAMING[camera];
    const off = (s) => ({ bearingOff: Math.abs(turn(want.bearing, s.bearing)), pitchOff: Math.abs(s.pitch - want.pitch) });
    let s = await page.evaluate(CAMERA);
    for (let i = 0; i < 60 && s?.camera === camera && (off(s).bearingOff >= 3 || off(s).pitchOff >= 1.5); i++) {
      await sleep(500);
      s = await page.evaluate(CAMERA);
    }
    await sleep(1_000);
    s = await page.evaluate(CAMERA);
    const { bearingOff, pitchOff } = off(s);
    check(`cameras (${how}): ${LABEL[camera]} is on, its button pressed, with terrain, the tilt limit 110`, on && !!s.terrain && s.layer === "custom" && s.maxPitch === 110, JSON.stringify(s));
    check(`cameras (${how}): ${LABEL[camera]} frames the track: bearing ${want.bearing}, pitch ${want.pitch}`, bearingOff < 3 && pitchOff < 1.5, `bearing ${s.bearing.toFixed(1)}, pitch ${s.pitch.toFixed(1)}`);
    if (camera === "cockpit") {
      // Westbound: the point the cockpit looks at is west of the aircraft, and the model it sits in is not drawn.
      const ahead = s.aircraft && s.centre[0] < s.aircraft[0] && Math.abs(s.centre[1] - s.aircraft[1]) < 0.01;
      check(`cameras (${how}): Cockpit looks ahead of the aircraft along its track, and does not draw its model`, !!ahead && s.modelPosed === false, JSON.stringify({ centre: s.centre, aircraft: s.aircraft, modelPosed: s.modelPosed }));
    } else {
      check(`cameras (${how}): ${LABEL[camera]} draws the aircraft's model`, s.modelPosed === true, `posed ${s.modelPosed}`);
    }
    if (camera === "cockpit" || camera === "side") check(`cameras (${how}): ${LABEL[camera]} hazes the far ground to the horizon`, s.haze > 0, `${s.haze} shells`);
    // Not the 3D view past level, which the map refuses on a reload and opens on the world instead.
    check(`cameras (${how}): the address carries the journey's flat shot in ${LABEL[camera]} (pitch at most 78), which a reload opens on`, Number.isFinite(s.hashPitch) && s.hashPitch <= 78, `pitch ${s.hashPitch}`);
    return s;
  };

  // With the buttons.
  for (const camera of ["chase", "cockpit", "side", "top", "map"]) {
    await group.getByRole("button", { name: LABEL[camera], exact: true }).click();
    await framed(camera, "button");
  }

  // With the keys, focus on the page, not a field.
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));
  for (const camera of ["chase", "cockpit", "side", "top", "map"]) {
    await page.keyboard.press(KEY[camera]);
    await framed(camera, `key ${KEY[camera]}`);
  }

  // A digit typed in the search box is the reader's, not a shortcut.
  await page.keyboard.press("4");
  await framed("side", "key 4");
  const search = page.getByRole("combobox").locator("visible=true").first();
  await search.click();
  await search.press("3");
  await sleep(500);
  const typed = await page.evaluate(CAMERA);
  check("cameras: a 3 typed in the search box leaves the camera in Side", typed.camera === "side" && typed.pressed === "Side", JSON.stringify({ camera: typed.camera, pressed: typed.pressed }));
  await search.press("Backspace");
  await search.press("Escape");
  await page.evaluate(() => (document.activeElement instanceof HTMLElement ? document.activeElement.blur() : undefined));

  // The camera holds across feed reads.
  const readsFrom = reads;
  const twoReads = await (async () => {
    for (let i = 0; i < 60 && reads < readsFrom + 2; i++) await sleep(500);
    return reads >= readsFrom + 2;
  })();
  await sleep(500);
  const held = await page.evaluate(CAMERA);
  check("cameras: Side holds across two feed reads, still framing the track", twoReads && held.camera === "side" && held.pressed === "Side" && Math.abs(turn(0, held.bearing)) < 3 && Math.abs(held.pitch - 90) < 1.5, `${reads - readsFrom} reads, ${JSON.stringify({ camera: held.camera, pressed: held.pressed, bearing: held.bearing, pitch: held.pitch })}`);

  // A drag peeks round the aircraft and eases back on release; it neither ends the journey nor changes the camera.
  const box = await page.evaluate(`(() => { const r = ${GLOBE}.map.getContainer().getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const start = { x: box.x - 250, y: box.y + 120 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Right and down: the bearing turns and the camera tilts down toward the aircraft.
  for (let i = 1; i <= 10; i++) await page.mouse.move(start.x + i * 20, start.y + i * 6);
  await sleep(600);
  const dragged = await page.evaluate(CAMERA);
  const turned = Math.abs(turn(0, dragged.bearing));
  check("cameras: a mouse drag in Side turns and tilts the camera round the aircraft while held", turned > 40 && dragged.pitch < 82 && dragged.camera === "side", `bearing ${dragged.bearing.toFixed(1)} (${turned.toFixed(1)} off the framing), pitch ${dragged.pitch.toFixed(1)}`);
  await page.mouse.up();
  /** Waits up to 8 s for Side's framing again: the ease back runs on the map's frames. */
  const easedBack = async () => {
    let s = await page.evaluate(CAMERA);
    for (let i = 0; i < 16 && (Math.abs(turn(0, s.bearing)) >= 2 || Math.abs(s.pitch - 90) >= 1.5); i++) {
      await sleep(500);
      s = await page.evaluate(CAMERA);
    }
    return s;
  };
  const eased = await easedBack();
  check("cameras: let go, the camera eases back to Side's framing", Math.abs(turn(0, eased.bearing)) < 2 && Math.abs(eased.pitch - 90) < 1.5, `bearing ${eased.bearing.toFixed(1)}, pitch ${eased.pitch.toFixed(1)}`);
  check("cameras: the drag kept the journey and the camera", eased.camera === "side" && eased.pressed === "Side" && (await page.locator("section[aria-label^='Followed flight']").count()) > 0, JSON.stringify({ camera: eased.camera, pressed: eased.pressed }));

  // A touch drag takes the same path: touch pointer events on the map's canvas.
  await page.evaluate(`(async () => {
    const el = ${GLOBE}.map.getCanvasContainer();
    const at = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, button: type === "pointermove" ? -1 : 0, clientX: x, clientY: y, bubbles: true }));
    at("pointerdown", ${start.x}, ${start.y});
    for (let i = 1; i <= 10; i++) { at("pointermove", ${start.x} - i * 20, ${start.y}); await new Promise((r) => setTimeout(r, 16)); }
  })()`);
  await sleep(600);
  const touched = await page.evaluate(CAMERA);
  const touchTurn = turn(0, touched.bearing);
  check("cameras: a touch drag in Side turns the camera too (left drag, bearing up)", touchTurn > 40, `bearing ${touched.bearing.toFixed(1)}`);
  await page.evaluate(`(() => { ${GLOBE}.map.getCanvasContainer().dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, pointerType: "touch", isPrimary: true, bubbles: true })); })()`);
  const touchEased = await easedBack();
  check("cameras: let go of the touch, the camera eases back to Side's framing", Math.abs(turn(0, touchEased.bearing)) < 2 && touchEased.camera === "side", `bearing ${touchEased.bearing.toFixed(1)}`);

  await page.keyboard.press("1");
  await framed("map", "key 1");
  check("cameras: the journey runs on through it all", (await page.locator("section[aria-label^='Followed flight']").count()) > 0);
  check("cameras: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
  await page.close();
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-en-route-cameras.mjs")) {
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
    await enRouteCameraChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3186", check });
  } catch (error) {
    check("cameras run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
