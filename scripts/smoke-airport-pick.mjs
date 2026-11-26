/**
 * Smoke check for the header's airport picker with motion on (prefers-reduced-motion: no-preference, set on the
 * context, so the map really flies): from Atlanta's Diorama, a pick flies the map to the airport picked and lands
 * there. Each pick is sampled every 100 ms: within PICK_MS the header reads the airport picked, the address has
 * it, the map's centre is within 5 km of it and its Diorama is shown, and the header never reads ATL again on the
 * way. Atlanta to Butler (BTP) and to Los Angeles (LAX) with the mouse, and Atlanta to BTP with the keyboard.
 *
 * The bug it holds: the landing guard read the camera still low over Atlanta as "coming down on another airport"
 * and switched back to it, and each Diorama's first frame set the map's padding, a jumpTo that stopped the flight.
 * Under reduced motion the flight is a jump, done before the guard reads, and on software GL the first frame comes
 * too late to catch the camera low over Atlanta: so this runs with motion, on the GPU (airportPickChecks). The
 * size is SMOKE_VIEWPORT (say 375x812), 1440x900 by default.
 *
 * On its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3187 node scripts/smoke-airport-pick.mjs
 */

import { launchChrome } from "./lib/chrome.mjs";
import { GLOBE, sleep } from "./lib/page.mjs";

/** How long a pick has to land, ms: the flights are 2.5 s each, and software GL draws a few frames a second. */
const PICK_MS = 30_000;
/** How near the map's centre must be to the airport picked, metres. */
const NEAR_M = 5_000;
const AIRPORT = { atl: [33.6367, -84.4281], btp: [40.7769, -79.9497], lax: [33.9425, -118.4081] };

/** Metres between two [lat, lng] points on the sphere. */
const metres = ([la1, lo1], [la2, lo2]) => {
  const r = Math.PI / 180;
  const h = Math.sin(((la2 - la1) * r) / 2) ** 2 + Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(((lo2 - lo1) * r) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
};

/** The header's airport, the address's, the map's centre and whether the Diorama is what shows. */
const SAMPLE = `(() => {
  const button = document.querySelector('button[aria-haspopup="listbox"]');
  const g = ${GLOBE};
  const c = g && g.map.getCenter();
  return {
    header: button ? button.getAttribute("aria-label").split(",")[0].toLowerCase() : null,
    url: new URL(location.href).searchParams.get("airport"),
    centre: c ? [c.lat, c.lng] : null,
    diorama: !document.querySelector("main").hasAttribute("data-on-map"),
  };
})()`;

/**
 * Runs in a browser of its own on the machine's GPU, not the other smokes' software GL: there a frame takes
 * so long that the flight is far up and away from Atlanta by the new Diorama's first frame, and the old bug
 * never showed (it passed on the old code). A machine with no GPU fails the first check, saying so.
 */
export async function airportPickChecks({ base, check, viewport = { width: 1440, height: 900 } }) {
  const browser = await launchChrome({ headless: !process.env.HEADED, args: ["--ignore-gpu-blocklist", "--enable-gpu"] });
  try {
    await picks({ browser, base, check, viewport });
  } finally {
    await browser.close();
  }
}

async function picks({ browser, base, check, viewport }) {
  const probe = await browser.newPage();
  await probe.goto(`${base}/robots.txt`).catch(() => {});
  const renderer = await probe.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl && gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
  });
  await probe.close();
  check("airport pick: runs on the GPU, where frames are quick enough to show the old bounce", !!renderer && !/swiftshader|llvmpipe|software|basic render/i.test(renderer), String(renderer));
  for (const [to, how] of [
    ["btp", "mouse"],
    ["lax", "mouse"],
    ["btp", "keyboard"],
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: "no-preference" });
    const page = await context.newPage();
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    await page.goto(`${base}/?airport=atl&fixture=1`);
    await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 60_000 });
    await sleep(3_000);
    const picker = page.getByRole("button", { name: /change airport/ });
    if (how === "mouse") {
      await picker.click();
      await page.getByRole("combobox", { name: /Search airports/ }).fill(to);
      const option = await page.locator(".popover-panel [role=option]").first().boundingBox();
      await page.mouse.click(option.x + option.width / 2, option.y + option.height / 2);
    } else {
      await picker.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("combobox", { name: /Search airports/ }).waitFor({ timeout: 5_000 });
      await page.keyboard.type(to);
      await page.keyboard.press("Enter");
    }
    const t0 = Date.now();
    const headers = [];
    let s = null;
    let landed = false;
    while (Date.now() - t0 < PICK_MS) {
      s = await page.evaluate(SAMPLE).catch(() => null);
      if (s) {
        if (headers.at(-1) !== s.header) headers.push(s.header);
        landed = s.header === to && s.url === to && !!s.centre && metres(s.centre, AIRPORT[to]) <= NEAR_M && s.diorama;
        if (landed) break;
      }
      await sleep(100);
    }
    const took = Date.now() - t0;
    // Held a moment past landing, still sampled: the old bounce came a few frames after the switch.
    for (const end = Date.now() + 2_000; Date.now() < end; await sleep(100)) {
      const later = await page.evaluate(SAMPLE).catch(() => null);
      if (later && headers.at(-1) !== later.header) headers.push(later.header);
    }
    const label = `airport pick (${how}, ATL to ${to.toUpperCase()}, ${viewport.width}x${viewport.height})`;
    const detail = s ? `${took} ms; header ${JSON.stringify(headers)}, url ${s.url}, centre ${s.centre ? `${(metres(s.centre, AIRPORT[to]) / 1000).toFixed(1)} km off` : "none"}, diorama ${s.diorama}` : "no sample";
    check(`${label}: lands within ${PICK_MS / 1000} s, header and address on ${to.toUpperCase()}, the map within ${NEAR_M / 1000} km of it, its Diorama shown`, landed, detail);
    check(`${label}: the header never goes back to ATL`, !headers.slice(1).includes("atl"), JSON.stringify(headers));
    check(`${label}: console stays clean`, problems.length === 0, problems.slice(0, 3).join(" | "));
    await context.close();
  }
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-airport-pick.mjs")) {
  const results = [];
  let failures = 0;
  const check = (name, ok, detail = "") => {
    results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    console.log(results.at(-1));
    if (!ok) failures++;
  };
  try {
    const viewport = process.env.SMOKE_VIEWPORT ? Object.fromEntries(["width", "height"].map((k, i) => [k, Number(process.env.SMOKE_VIEWPORT.split("x")[i])])) : undefined;
    await airportPickChecks({ base: process.env.SMOKE_URL ?? "http://localhost:3188", check, viewport });
  } catch (error) {
    check("airport pick run completed", false, String(error));
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}
