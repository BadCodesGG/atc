/**
 * End-to-end smoke test: boots the production build and drives the page in a real browser.
 *
 *   npm run build && npm run test:smoke        starts `next start` on SMOKE_PORT (3119) and stops it after
 *   SMOKE_URL=http://localhost:3109 npm run test:smoke    uses a server already running
 *
 * The page checks run on the frozen fixture (`?fixture=1`), so they never depend on what is in the
 * sky; only the two API checks touch the live upstreams. Exits 1 on the first failed check.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { journeyLiveChecks } from "./smoke-journey-live.mjs";
import { journeyProcedureChecks } from "./smoke-journey-procedures.mjs";
import { mapSelectChecks } from "./smoke-map-select.mjs";
import { procedureChecks } from "./smoke-procedures.mjs";
import { remoteFlightChecks } from "./smoke-remote-flight.mjs";
import { titleRowChecks, titleRowPointerChecks } from "./smoke-title-row.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 3119);
const BASE = process.env.SMOKE_URL ?? `http://localhost:${PORT}`;
const THEMES = ["light", "dark", "satellite"];

let failures = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  console.log(results.at(-1));
  if (!ok) failures++;
}

/** An init script that replaces the Notification API with a recorder (window.__notes), with `permission` (null: no API at all) and, if `opted`, the page's own opt-in stored. */
const recorder = (permission, opted) => `
  window.__asked = 0;
  window.__notes = [];
  ${permission === null ? "delete window.Notification;" : `
  class N {
    static permission = "${permission}";
    static async requestPermission() { window.__asked++; N.permission = "granted"; return "granted"; }
    constructor(title, opts) { window.__notes.push({ title, body: opts?.body }); }
  }
  window.Notification = N;`}
  ${opted ? 'localStorage.setItem("atc-alerts", "on");' : ""}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`smoke: ${url} did not answer within ${ms} ms`);
}

/** The upstreams are live and rate limited, so a 502 is retried a few times before it counts. */
async function fetchOk(url, tries = 4) {
  let res;
  for (let i = 0; i < tries; i++) {
    res = await fetch(url);
    if (res.status === 200) return res;
    await sleep(5_000);
  }
  return res;
}

/** True when the canvas shows a picture rather than one flat colour: a flat frame compresses to almost nothing. */
async function canvasDraws(page) {
  // The diorama's canvas; the world map under it has its own.
  const box = await page.locator("[role='application'] canvas").boundingBox();
  // A software GPU draws slowly; give it time rather than failing on a busy machine.
  const shot = await page.screenshot({ clip: box, timeout: 30_000, animations: "allow", caret: "initial" });
  return shot.length > 20_000;
}

async function boxes(page, selectors) {
  const out = {};
  for (const [name, sel] of Object.entries(selectors)) {
    const loc = page.locator(sel).first();
    out[name] = (await loc.count()) && (await loc.isVisible()) ? await loc.boundingBox() : null;
  }
  return out;
}

// The line crediting adsb.lol and adsb.fi, along the foot of every view.
const DATA_CREDIT = "p:has(> a[href='https://adsb.fi'])";
const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

let server = null;
if (!process.env.SMOKE_URL) {
  server = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT)], { cwd: ROOT, stdio: "inherit" });
}

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  await waitFor(BASE);

  // The routes.
  check("page answers 200", (await fetch(BASE)).status === 200);
  const traffic = await fetchOk(`${BASE}/api/traffic/atl`);
  const trafficBody = traffic.status === 200 ? await traffic.json() : null;
  check("/api/traffic/atl answers 200 with aircraft and a routes map", Array.isArray(trafficBody?.aircraft) && typeof trafficBody?.routes === "object", `status ${traffic.status}`);
  check("/api/traffic for an unlisted airport is a 404", (await fetch(`${BASE}/api/traffic/lhr`)).status === 404);
  check("/api/hex for anything but six hex digits is a 400, before adsb.lol is asked", (await fetch(`${BASE}/api/hex/a1b2c3d4`)).status === 400 && (await fetch(`${BASE}/api/hex/~a1b2c`)).status === 400);
  const status = await fetchOk(`${BASE}/api/status`);
  const statusBody = status.status === 200 ? await status.json() : null;
  check("/api/status answers 200 with an airports map", typeof statusBody?.airports === "object" && statusBody.airports !== null, `status ${status.status}`);

  // Every theme draws, on the fixture, with a clean console.
  for (const theme of THEMES) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(`${BASE}/?fixture=1${theme === "light" ? "" : `&theme=${theme}`}`);
    await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await sleep(1500);
    check(`${theme}: the WebGL canvas draws`, await canvasDraws(page));
    check(`${theme}: page carries the theme`, (await page.locator("main").getAttribute("data-theme")) === theme);
    check(`${theme}: console stays clean`, problems.length === 0, problems.slice(0, 3).join(" | "));
    await page.close();
  }

  // Interaction, on the light theme at a wide size.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(`${BASE}/?fixture=1`);
    const card = page.locator("section[aria-label^='Selected flight']");
    await card.waitFor({ timeout: 30_000 });

    // A row of the movements list selects its flight in the card.
    const rows = page.locator("#movements-list li button");
    const n = await rows.count();
    check("the movements list has rows", n > 0, `${n} rows`);
    const pick = rows.nth(Math.min(1, n - 1));
    const callsign = ((await pick.locator("span.truncate").first().innerText()).split(" ")[0] ?? "").trim();
    await pick.click();
    await page.waitForFunction((c) => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === c, callsign, { timeout: 5_000 }).catch(() => {});
    check("clicking a row selects that flight in the card", (await card.locator("h2").innerText()) === callsign, callsign);

    // A flight with a known route shows it in the card.
    const routed = page.locator("#movements-list li button", { hasText: / (to|from) [A-Z]{3}/ });
    if (await routed.count()) {
      await routed.first().click();
      await sleep(400);
      const route = await card.locator("[data-route]").innerText().catch(() => "");
      // The arrow is hidden from screen readers, which hear a visually hidden "to" instead.
      check("a routed flight shows its route on the card", /[A-Z]{3}\s*→\s*to\s*[A-Z]{3}/.test(route), route.replace(/\s+/g, " "));
    } else {
      check("a routed flight shows its route on the card", false, "no routed row in the fixture's top rows");
    }
    check("the card says what the FAA reports (the fixture: nothing)", (await card.locator("[data-delays]").innerText()).startsWith("No FAA delay programs at ATL"));

    // Follow engages, at once, and a drag on the map lets go. The toggle keeps one name; aria-pressed
    // carries the state.
    const follow = card.getByRole("button", { name: "Follow this flight" });
    const pressed = async () => (await follow.getAttribute("aria-pressed")) === "true";
    await follow.click();
    check("Follow this flight engages, its name unchanged", await pressed());
    // The view buttons still work while following: Zoom in moves the camera, and Follow holds.
    const labelAt = () => page.evaluate(() => document.querySelector(".scene-label")?.style.transform ?? "");
    // Wait for Follow's own ease to finish, or the camera moving on its own would pass the check.
    const settle = async () => {
      let last = await labelAt();
      // Readings far enough apart that a frame is drawn between them, even under a software renderer.
      for (let i = 0; i < 16; i++) {
        await sleep(2500);
        const now = await labelAt();
        if (now === last) return now;
        last = now;
      }
      return null;
    };
    const settled = await settle();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await sleep(1500);
    check("Zoom in works while following, and Follow holds", settled !== null && (await labelAt()) !== settled && (await pressed()));
    await page.mouse.move(500, 500);
    await page.mouse.down();
    await page.mouse.move(560, 460, { steps: 6 });
    await page.mouse.up();
    await sleep(400);
    check("dragging the map lets go of the followed flight", !(await pressed()));

    // The wheel zooms, and Reset view goes back to the framed view. Zoomed in close, the airport's
    // labels project far off the screen: the case that once let the page scroll when Reset view, which
    // had focus, went away.
    await page.mouse.move(600, 450);
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, -200);
      await sleep(60);
    }
    await sleep(400);
    const reset = page.getByRole("button", { name: "Reset view" });
    check("zooming offers Reset view", await reset.isVisible());
    const offscreen = await page.evaluate(() =>
      Math.max(
        ...[...document.querySelectorAll(".scene-label")].map((l) => {
          const r = l.getBoundingClientRect();
          return Math.max(-r.top, -r.left, r.bottom - window.innerHeight, r.right - window.innerWidth);
        }),
      ),
    );
    check("zoomed in close, labels lie well off the screen (the scroll case is real)", offscreen > 200, `${Math.round(offscreen)} px out`);
    // Whatever might try (focus moving, a find in the page, a label scrolled into view), the page must not move.
    const shifted = await page.evaluate(() => {
      const main = document.querySelector("main");
      const far = [...document.querySelectorAll(".scene-label")].sort((p, q) => q.getBoundingClientRect().bottom - p.getBoundingClientRect().bottom)[0];
      far?.scrollIntoView();
      main.scrollTop += 300;
      main.scrollLeft += 300;
      const moved = main.scrollTop + main.scrollLeft + window.scrollY + window.scrollX;
      main.scrollTop = main.scrollLeft = 0;
      return moved;
    });
    check("zoomed in close, nothing can scroll the page", shifted === 0, `moved ${shifted} px`);
    await reset.focus();
    await reset.click();
    await reset.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    check("Reset view returns to the framed view", (await reset.count()) === 0);
    check("nothing scrolls the page", (await page.evaluate(() => document.querySelector("main").scrollTop)) === 0);

    // The keyboard moves the view too: the model takes focus, and plus zooms in, as the button does.
    const map = page.getByRole("application");
    await map.focus();
    await page.keyboard.press("+");
    await reset.waitFor({ timeout: 5_000 }).catch(() => {});
    check("the model takes focus and plus zooms in", (await map.evaluate((el) => el === document.activeElement)) && (await reset.isVisible()));
    await reset.click();
    await reset.waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});

    // A camera mode keeps the reader in it while they look around: a drag in Drone stays in Drone and
    // moves the view; Escape goes back to the orbit.
    const cameraOn = (name) => page.getByRole("group", { name: "Camera" }).getByRole("button", { name, exact: true }).getAttribute("aria-pressed");
    await page.getByRole("group", { name: "Camera" }).getByRole("button", { name: "Drone", exact: true }).click();
    await sleep(2500);
    const droneAt = await labelAt();
    await page.mouse.move(600, 450);
    await page.mouse.down();
    await page.mouse.move(420, 500, { steps: 8 });
    await page.mouse.up();
    await sleep(1500);
    check("a drag in Drone keeps Drone and moves the view", (await cameraOn("Drone")) === "true" && (await labelAt()) !== droneAt);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector("[role='group'][aria-label='Camera'] button[aria-pressed='true']")?.textContent?.trim() === "Orbit", null, { timeout: 8_000 }).catch(() => {});
    check("Escape goes back to Orbit", (await cameraOn("Orbit")) === "true");
    await sleep(1600);

    // The theme switch.
    await page.getByRole("group", { name: "Map style" }).getByRole("button", { name: "Dark" }).click();
    await page.waitForFunction(() => document.querySelector("main")?.dataset.theme === "dark", null, { timeout: 5_000 }).catch(() => {});
    check("the theme switch changes the theme and the address", (await page.locator("main").getAttribute("data-theme")) === "dark" && page.url().includes("theme=dark"));
    await sleep(1200);
    check("the switched theme draws", await canvasDraws(page));
    check("interaction console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
    await page.close();
  }

  // The airport picker: choosing PIT loads it, keeps the fixture in the address, and with no recorded
  // traffic there says so in one line instead of empty counts.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/?fixture=1`);
    await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: /change airport/ }).click();
    const search = page.getByRole("combobox", { name: /Search airports/ });
    await search.fill("pit");
    await search.press("Enter");
    await page.waitForFunction(() => location.search.includes("airport=pit"), null, { timeout: 10_000 }).catch(() => {});
    await page.locator(".atc-title", { hasText: "PIT" }).waitFor({ timeout: 30_000 }).catch(() => {});
    check("the picker switches to PIT, in the header and the address", (await page.locator(".atc-title").innerText()).includes("PIT") && page.url().includes("fixture=1"));
    await page.locator("#movements-list").waitFor({ timeout: 30_000 }).catch(() => {});
    const empty = await page.locator("#movements-list").innerText().catch(() => "");
    check("with no traffic, one plain line and no zero pills", /No aircraft/.test(empty) && !/at gates/.test(empty) && !/\d/.test(await page.locator("#column-tab-movements").innerText()), empty);
    await page.close();
  }

  // Search: a gate eases the camera there and names it, and `?airport=&flight=` opens that airport with the
  // flight selected. (A flight found elsewhere is smoke-remote-flight.mjs's.)
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const card = page.locator("section[aria-label^='Selected flight']");
    await page.goto(`${BASE}/?fixture=1`);
    await card.waitFor({ timeout: 30_000 });
    const box = page.locator("#atc-search");
    await box.fill("B12");
    await page.locator("[role='option']", { hasText: "Gate B12" }).first().waitFor({ timeout: 5_000 }).catch(() => {});
    await box.press("Enter");
    await page.locator("[data-search-place]").waitFor({ timeout: 5_000 }).catch(() => {});
    await sleep(2500);
    const named = await page.locator("[data-search-place]").evaluate((el) => ({ text: el.textContent, visible: el.style.visibility !== "hidden" })).catch(() => null);
    check("a gate from the search is named where the camera stops", named?.text === "Gate B12" && named.visible, JSON.stringify(named));

    await page.goto(`${BASE}/?fixture=1&airport=dfw&flight=AAL972`);
    await page.locator(".atc-title", { hasText: "DFW" }).waitFor({ timeout: 30_000 });
    await card.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "AAL972", null, { timeout: 10_000 }).catch(() => {});
    check("?airport=dfw&flight= opens DFW with that flight selected, and drops the flight from the address", (await card.locator("h2").innerText()) === "AAL972" && !page.url().includes("flight="), page.url());

    // On the map, a gate at the airport already chosen lands on the diorama and goes there.
    await page.goto(`${BASE}/?fixture=1#map=6.5/33.5/-84.4`);
    await page.locator("main[data-on-map]").waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(3000);
    await box.fill("B12");
    await page.locator("[role='option']", { hasText: "Gate B12" }).first().waitFor({ timeout: 10_000 }).catch(() => {});
    await box.press("Enter");
    await page.waitForFunction(() => !document.querySelector("main")?.dataset.onMap && document.querySelector("[data-search-place]")?.textContent === "Gate B12", null, { timeout: 60_000 }).catch(() => {});
    check("on the map, a gate here lands on the diorama and names the gate", !(await page.locator("main").getAttribute("data-on-map")) && (await page.locator("[data-search-place]").textContent().catch(() => null)) === "Gate B12");

    await page.close();
  }

  // Filters: the airline choice narrows the counts and the movements list, lives in the address, fades the
  // rest in the diorama, and a link carrying it opens the same way. The fixture is Atlanta's frozen moment:
  // 29 aircraft, 17 of them Delta.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(`${BASE}/?fixture=1`);
    await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    const trigger = page.locator("button[aria-label^='Filters']");
    const tracked = () => page.locator("[aria-live='polite']", { hasText: "tracked" }).first().innerText();
    check("filters: nothing is filtered at first", (await trigger.getAttribute("aria-label")) === "Filters" && /^29\s+tracked/.test(await tracked()), await tracked());
    await trigger.click();
    const panel = page.locator("section[aria-label='Filters']");
    check("filters: the button opens a panel that lists the airlines in the traffic with their counts", (await panel.isVisible()) && (await panel.getByRole("button", { name: /^Delta\s*17$/ }).count()) === 1);
    await panel.getByRole("button", { name: /^Delta/ }).click();
    // A software GPU draws a frame slowly, and the chrome catches up on the next one.
    await page.waitForFunction(() => /17\s+of\s+29\s+tracked/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {});
    check("filters: choosing Delta writes it into the address", new URL(page.url()).searchParams.get("airline") === "DAL", page.url());
    check("filters: the counts say what is shown of the whole", /17\s+of\s+29\s+tracked/.test((await tracked()).replace(/\s+/g, " ")), (await tracked()).replace(/\s+/g, " "));
    const callsigns = await page.locator("#movements-list li button").evaluateAll((els) => els.map((e) => e.innerText.trim().split(" ")[0].split(String.fromCharCode(10))[0]));
    check("filters: the movements list holds only Delta flights", callsigns.length > 0 && callsigns.every((c) => c.startsWith("DAL")), callsigns.join(" "));
    check("filters: the panel says how many are shown", /17 of 29 aircraft shown/.test(await panel.innerText()));
    await page.keyboard.press("Escape");
    check("filters: Escape closes the panel and gives the button its focus", !(await panel.isVisible()) && (await trigger.evaluate((el) => el === document.activeElement)));
    // The diorama fades what is filtered out rather than dropping it, so its canvas still draws.
    check("filters: the diorama still draws", await canvasDraws(page));
    await trigger.click();
    await panel.getByRole("button", { name: "Clear" }).click();
    await page.waitForFunction(() => !/of\s+29\s+tracked/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {});
    check("filters: Clear takes the filter out of the address and the counts", !new URL(page.url()).searchParams.has("airline") && /^29\s+tracked/.test(await tracked()), page.url());
    check("filters: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
    await page.close();

    // A link that carries the filter opens filtered, with the right button state.
    const shared = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await shared.goto(`${BASE}/?fixture=1&airline=dal,xx,UAL`);
    await shared.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await shared.waitForFunction(() => /19\s+of\s+29\s+tracked/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {});
    const label = await shared.locator("button[aria-label^='Filters']").getAttribute("aria-label");
    const text = (await shared.locator("[aria-live='polite']", { hasText: "tracked" }).first().innerText()).replace(/\s+/g, " ");
    check("filters: a link carrying an airline opens filtered, a bad code dropped", label === "Filters, 2 chosen" && /19\s+of\s+29\s+tracked/.test(text), `${label}; ${text}`);
    await shared.close();

    // On the world map the filter narrows the aircraft in view, and the header says so.
    const map = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await map.goto(`${BASE}/?fixture=1&airline=DAL#map=8/33.64/-84.43`);
    await map.locator("main[data-on-map]").waitFor({ timeout: 30_000 }).catch(() => {});
    await map.waitForFunction(() => /\d+ of \d+ aircraft in view/.test(document.querySelector(".atc-title")?.textContent ?? ""), null, { timeout: 30_000 }).catch(() => {});
    const header = (await map.locator(".atc-title").innerText()).replace(/\s+/g, " ");
    check("filters: on the map the header counts the aircraft in view that pass", /\d+ of \d+ aircraft in view/.test(header), header);
    await map.close();
  }

  // The other filters, each through the address (the fixture's 29 aircraft: 12 taxiing, 3 at gates, 3
  // holding, 10 arriving, 1 departing; 18 on the ground, 5 Boeing 737s), then a click in the panel, the
  // board's filtering, and the military flag on the map.
  {
    const open = async (query, wait = /\d+\s+of\s+29\s+tracked/) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${BASE}/?fixture=1&${query}`);
      await page.locator("section[aria-label^='Selected flight'], section[aria-label='Active movements']").first().waitFor({ state: "attached", timeout: 30_000 });
      await page.waitForFunction((src) => new RegExp(src).test(document.body.innerText), wait.source, { timeout: 30_000 }).catch(() => {});
      return page;
    };
    const tracked = async (page) => (await page.locator("[aria-live='polite']", { hasText: "tracked" }).first().innerText()).replace(/\s+/g, " ");
    const cases = [
      ["state=gate", "3 of 29 tracked"],
      ["state=holding", "3 of 29 tracked"],
      ["state=taxiing,departing", "13 of 29 tracked"],
      ["alt=ground", "18 of 29 tracked"],
      ["alt=ground,low", "24 of 29 tracked"],
      ["speed=fast", "6 of 29 tracked"],
      ["type=B737", "5 of 29 tracked"],
      ["from=SRQ", "1 of 29 tracked"],
      ["to=ATL", "5 of 29 tracked"],
      ["mil=1", "0 of 29 tracked"],
      ["airline=DAL&state=taxiing", "7 of 29 tracked"],
    ];
    for (const [query, want] of cases) {
      const page = await open(query, new RegExp(want.replace(/ /g, "\\s+")));
      check(`filters: ?${query} narrows the traffic`, (await tracked(page)).startsWith(want), (await tracked(page)).slice(0, 40));
      await page.close();
    }

    // The panel: a click on a chip in each group, the summary line, and a phone's scrolling panel.
    const page = await open("airline=DAL");
    await page.locator("button[aria-label^='Filters']").click();
    const panel = page.locator("section[aria-label='Filters']");
    for (const group of ["Airline", "Aircraft", "Ground state", "Altitude", "Speed", "From", "To", "Military"]) {
      check(`filters: the panel has a ${group} group`, (await panel.getByRole("group", { name: group, exact: true }).count()) === 1);
    }
    await panel.getByRole("button", { name: "Taxiing" }).click();
    await page.waitForFunction(() => /(?:^|\s)7\s+of\s+29\s+tracked/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {});
    check("filters: a chip in another group narrows further, and the address holds both", (await tracked(page)).startsWith("7 of 29") && new URL(page.url()).searchParams.get("state") === "taxiing" && new URL(page.url()).searchParams.get("airline") === "DAL", `${await tracked(page)}; ${page.url()}`);
    check("filters: the panel header sums the filters up in one line", (await panel.locator("[data-filter-summary]").innerText()) === "Delta · Taxiing");
    check("filters: the button carries the number of choices", (await page.locator("button[aria-label^='Filters']").getAttribute("aria-label")) === "Filters, 2 chosen");
    await panel.getByRole("button", { name: "Military only" }).click();
    await page.waitForFunction(() => /(?:^|\s)0\s+of\s+29\s+tracked/.test(document.body.innerText), null, { timeout: 20_000 }).catch(() => {});
    check("filters: Military only leaves nothing in the diorama's fixture, and says so in the list", (await tracked(page)).startsWith("0 of 29") && (await page.locator("#movements-list").innerText()).includes("No aircraft match the filters"));
    await panel.getByRole("button", { name: "Clear" }).click();
    await page.close();

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.goto(`${BASE}/?fixture=1`);
    await phone.locator("section[aria-label^='Selected flight']").waitFor({ state: "attached", timeout: 30_000 });
    await phone.locator("button[aria-label^='Filters']").click();
    const small = await phone.locator("section[aria-label='Filters']").evaluate((el) => {
      const r = el.getBoundingClientRect();
      const body = el.querySelector("div.overflow-y-auto");
      return { bottom: r.bottom, top: r.top, scrolls: body.scrollHeight > body.clientHeight, height: window.innerHeight };
    });
    check("filters: on a phone the full panel scrolls inside the screen rather than running off it", small.scrolls && small.bottom <= small.height && small.top >= 0, JSON.stringify(small));
    await phone.close();

    // The board keeps a record of each aircraft, so it filters on what the entry no longer shows too.
    const board = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await board.goto(`${BASE}/?fixture=sequence&airline=DAL`);
    await board.locator("#column-tab-board").waitFor({ timeout: 30_000 });
    await board.locator("#column-tab-board").click();
    await board.locator("[data-board] li").first().waitFor({ timeout: 30_000 }).catch(() => {});
    const rows = (page) => page.locator("[data-board] li > span:first-child").allInnerTexts();
    const dal = await rows(board);
    check("filters: the board lists only the airline's flights", dal.length > 0 && dal.every((c) => c.startsWith("DAL")), dal.slice(0, 4).join(" "));
    await board.close();
    const byType = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await byType.goto(`${BASE}/?fixture=sequence`);
    await byType.locator("#column-tab-board").click();
    await byType.locator("[data-board] li").first().waitFor({ timeout: 30_000 }).catch(() => {});
    const all = (await rows(byType)).length;
    await byType.goto(`${BASE}/?fixture=sequence&type=B717`);
    await byType.locator("#column-tab-board").click();
    await byType.locator("[data-board] li, [data-board]").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    const mds = (await rows(byType)).length;
    check("filters: the board filters on the aircraft's type, which its rows do not carry", mds > 0 && mds < all, `${mds} of ${all}`);
    await byType.close();

    // Military, on the map: the region reads carry the aircraft database's flag, so the Chinooks the
    // recording holds south of Atlanta are the only aircraft left.
    const map = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await map.goto(`${BASE}/?fixture=1&mil=1#map=6.5/32.5/-84.9`);
    await map.waitForFunction(() => /\d+ of \d+ aircraft in view/.test(document.querySelector(".atc-title")?.textContent ?? ""), null, { timeout: 40_000 }).catch(() => {});
    const header = (await map.locator(".atc-title").innerText()).replace(/\s+/g, " ");
    const [shown, total] = (/(\d+) of (\d+) aircraft in view/.exec(header) ?? []).slice(1).map(Number);
    check("filters: on the map military leaves a few of the aircraft in view", shown > 0 && shown < total / 2, header);
    await map.close();
  }

  // Share links: the button copies a link, shows it, and the link opens the same view; a camera, a selected
  // flight, a theme and filters survive the trip, as does a map view; replay time does not, and says so.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    const page = await context.newPage();
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    await page.goto(`${BASE}/?fixture=1&airline=DAL&state=taxiing&theme=dark`);
    const card = page.locator("section[aria-label^='Selected flight']");
    await card.waitFor({ timeout: 30_000 });
    const row = page.locator("#movements-list li button").nth(1);
    const callsign = (await row.innerText()).trim().split(" ")[0].split(String.fromCharCode(10))[0];
    await row.click();
    await page.waitForFunction((c) => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === c, callsign, { timeout: 20_000 }).catch(() => {});
    await page.getByRole("group", { name: "Camera" }).getByRole("button", { name: "Tower" }).click();
    await sleep(800);
    await page.getByRole("button", { name: "Share this view" }).click();
    const share = page.locator("section[aria-label='Share this view']");
    await share.locator("[data-share-state='copied']").waitFor({ timeout: 10_000 }).catch(() => {});
    const link = await share.getByLabel("Link to this view").inputValue();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    check("share: the button copies the link and shows it, selected", copied === link && (await share.locator("[data-share-state]").getAttribute("data-share-state")) === "copied", link);
    const parsed = new URL(link);
    check(
      "share: the link carries the theme, the filters, the selected flight and the camera",
      parsed.searchParams.get("theme") === "dark" && parsed.searchParams.get("airline") === "DAL" && parsed.searchParams.get("state") === "taxiing" && parsed.searchParams.get("flight") === callsign && parsed.searchParams.get("camera") === "tower" && parsed.searchParams.get("fixture") === "1" && parsed.hash === "",
      link,
    );
    check("share: nothing says replay time is lost while the picture is live", (await share.locator("[data-share-replay]").count()) === 0);

    // The first page rests while the link is opened: two WebGL pages on a software GPU starve each other.
    await page.goto("about:blank");
    const opened = await context.newPage();
    await opened.goto(link);
    await opened.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await opened.waitForFunction((c) => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === c, callsign, { timeout: 30_000 }).catch(() => {});
    await opened.getByRole("group", { name: "Camera" }).getByRole("button", { name: "Tower", pressed: true }).waitFor({ timeout: 20_000 }).catch(() => {});
    check(
      "share: opening the link lands on the same view: theme, filtered traffic, flight and camera",
      (await opened.locator("main").getAttribute("data-theme")) === "dark" &&
        /^7 of 29/.test((await opened.locator("[aria-live='polite']", { hasText: "tracked" }).first().innerText()).replace(/\s+/g, " ")) &&
        (await opened.locator("section[aria-label^='Selected flight'] h2").innerText()) === callsign &&
        (await opened.getByRole("group", { name: "Camera" }).getByRole("button", { name: "Tower" }).getAttribute("aria-pressed")) === "true",
    );
    check("share: the link's flight and camera are taken up and dropped from the address", !opened.url().includes("flight=") && !opened.url().includes("camera="), opened.url());
    await opened.close();

    // Another airport: the link names it, and the flight is looked for there.
    await page.goto(`${BASE}/?fixture=1&airport=dfw`);
    await page.locator(".atc-title", { hasText: "DFW" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Share this view" }).click();
    const dfw = new URL(await page.locator("section[aria-label='Share this view']").getByLabel("Link to this view").inputValue());
    check("share: the link names an airport that is not the default", dfw.searchParams.get("airport") === "dfw" && !dfw.searchParams.has("theme"), dfw.search);

    // On the map: the position, in the hash, and nothing of the diorama.
    await page.goto(`${BASE}/?fixture=1&airline=DAL#map=6.5/33.5/-84.4`);
    await page.locator("main[data-on-map]").waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    await page.getByRole("button", { name: "Share this view" }).click();
    const mapLink = new URL(await page.locator("section[aria-label='Share this view']").getByLabel("Link to this view").inputValue());
    const hash = /^#map=(\d+(\.\d+)?)\/(-?\d+(\.\d+)?)\/(-?\d+(\.\d+)?)/.exec(mapLink.hash);
    check("share: on the map the link holds the map's position, the filters, and no flight or camera", !!hash && Math.abs(Number(hash[3]) - 33.5) < 0.5 && mapLink.searchParams.get("airline") === "DAL" && !mapLink.searchParams.has("flight") && !mapLink.searchParams.has("camera"), mapLink.href);
    const reopened = await context.newPage();
    await reopened.goto(mapLink.href);
    await reopened.locator("main[data-on-map]").waitFor({ timeout: 30_000 }).catch(() => {});
    check("share: that link opens on the map", (await reopened.locator("main").getAttribute("data-on-map")) !== null);
    await reopened.close();

    // A hash with a NaN in it (which the map has been known to write) is dropped, and the page opens on the diorama.
    const bad = await context.newPage();
    const badProblems = [];
    bad.on("pageerror", (e) => badProblems.push(String(e)));
    await bad.goto(`${BASE}/?fixture=1#map=NaN/NaN/NaN`);
    await bad.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    check("share: a hash with no usable view is dropped and the page opens on the diorama", (await bad.locator("main").getAttribute("data-on-map")) === null && !bad.url().includes("NaN") && badProblems.length === 0, `${bad.url()} ${badProblems.join(" | ")}`);
    await bad.close();
    check("share: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
    await page.close();
    await context.close();

    // Where the Clipboard API is missing the field is the way: the panel says to copy by hand.
    const noClip = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await noClip.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
    await noClip.goto(`${BASE}/?fixture=1`);
    await noClip.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await noClip.getByRole("button", { name: "Share this view" }).click();
    const manual = noClip.locator("section[aria-label='Share this view']");
    await manual.locator("[data-share-state='manual']").waitFor({ timeout: 10_000 }).catch(() => {});
    const selected = await manual.getByLabel("Link to this view").evaluate((el) => el.value.length > 0 && el.selectionStart === 0 && el.selectionEnd === el.value.length);
    check("share: with no Clipboard API the link is shown selected and the panel says to copy it", (await manual.innerText()).includes("Copy the link below") && selected);
    await noClip.close();

    // Replaying: the panel says replay time cannot be shared.
    const replay = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await replay.goto(`${BASE}/?fixture=sequence`);
    await replay.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await replay.getByRole("button", { name: "10x" }).click();
    await sleep(800);
    await replay.getByRole("button", { name: "Share this view" }).click();
    check("share: while replaying, the panel says replay time can't be shared", (await replay.locator("[data-share-replay]").innerText()).includes("Replay time can't be shared"));
    await replay.close();
  }

  // The LIVE dot carries the feed's state. `&feed=` starts the fixture's feed late or offline, as a
  // rate-limited upstream would leave it; the label is what a reader sees.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const dot = page.locator("main > div:has(> time) [data-live]");
    const label = dot.locator("> span").nth(1);
    for (const [flag, state, pattern] of [
      ["", "fresh", /^LIVE$/],
      ["&feed=stale", "stale", /^LIVE · \d+ s$/],
      ["&feed=offline", "offline", /^Offline$/],
    ]) {
      await page.goto(`${BASE}/?fixture=1${flag}`);
      await page.waitForFunction((s) => document.querySelector("main > div:has(> time) [data-live]")?.getAttribute("data-live") === s, state, { timeout: 30_000 }).catch(() => {});
      const text = (await label.innerText().catch(() => "")).trim();
      check(`the LIVE dot reads ${state}`, (await dot.getAttribute("data-live")) === state && pattern.test(text), text);
      if (state === "fresh") check("the fresh dot pulses", (await dot.locator(".live-dot").evaluate((el) => getComputedStyle(el).animationName)) === "live-pulse");
      if (state === "stale") {
        // A software GPU can hold the main thread for a while; the age only has to move on.
        await page.waitForFunction((t) => document.querySelector("main > div:has(> time) [data-live] > span:nth-child(2)")?.textContent?.trim() !== t, text, { timeout: 10_000 }).catch(() => {});
        const later = (await label.innerText()).trim();
        check("the late feed's age keeps counting", later !== text && pattern.test(later), `${text} then ${later}`);
      }
      if (state === "offline") {
        const spoken = await dot.locator("[aria-live='polite']").innerText();
        const anim = await dot.locator(".live-dot").evaluate((el) => getComputedStyle(el).animationName);
        check("offline is said politely and does not pulse", spoken === "Offline" && anim === "none", `${spoken}, ${anim}`);
      }
    }
    // On the world map the dot carries the map's own feed, in the same four states (replay is the diorama's).
    for (const [flag, state, pattern] of [
      ["", "fresh", /^LIVE$/],
      ["&feed=stale", "stale", /^LIVE · \d+ s$/],
      ["&feed=offline", "offline", /^Offline$/],
    ]) {
      await page.goto(`${BASE}/?fixture=1${flag}#map=6.5/33.5/-84.4`);
      await page.locator("main[data-on-map]").waitFor({ timeout: 30_000 }).catch(() => {});
      await page.waitForFunction((s) => document.querySelector("main > div:has(> time) [data-live]")?.getAttribute("data-live") === s, state, { timeout: 15_000 }).catch(() => {});
      const text = (await label.innerText().catch(() => "")).trim();
      check(`on the map, the LIVE dot reads ${state}`, (await page.locator("main").getAttribute("data-on-map")) === "true" && (await dot.getAttribute("data-live")) === state && pattern.test(text), text);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${BASE}/?fixture=1`);
    await dot.waitFor({ timeout: 30_000 });
    check("reduced motion stops the pulse", (await dot.locator(".live-dot").evaluate((el) => getComputedStyle(el).animationName)) === "none");
    await page.close();
  }

  // The recorded sequence: the replay plays and seeks through it, and the board shows what happened in it.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${BASE}/?fixture=sequence`);
    await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 60_000 });
    await page.locator("#column-tab-board").click();
    await page.locator("[data-board] li").first().waitFor({ timeout: 20_000 }).catch(() => {});
    check("?fixture=sequence fills the board", (await page.locator("[data-board] li").count()) > 5);
    const clock = page.locator("main > div:has(> time) > time");
    const live = await clock.innerText();
    await page.getByRole("button", { name: "30x", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("main > div:has(> time) button[aria-pressed='true']")?.textContent?.trim() === "30x", null, { timeout: 8_000 }).catch(() => {});
    check("30x replays from the start of the sequence", (await clock.innerText()) !== live);
    check("replaying, the LIVE dot is grey", (await page.locator("main > div:has(> time) [data-live]").getAttribute("data-live")) === "replay");
    await page.locator("main input[type='range']").fill("120");
    await sleep(800);
    const seeked = Number(await page.locator("main input[type='range']").inputValue());
    check("the scrubber seeks", seeked >= 120 && seeked < 200, String(seeked));
    await page.getByRole("button", { name: "LIVE", exact: true }).click();
    await page.waitForFunction((t) => document.querySelector("main > div:has(> time) > time")?.textContent === t, live, { timeout: 8_000 }).catch(() => {});
    check("LIVE goes back to the end", (await clock.innerText()) === live, `${live} / ${await clock.innerText()}`);
    await page.close();
  }

  // The world map (`#map=` opens on it): the diorama's chrome (the flight card, the counts, the camera
  // modes, the replay) goes, and what stays covers neither the map's middle nor its credit line.
  // Light and night: the night theme's wider type is what once pushed the map style onto the view buttons.
  for (const [width, height, theme] of [
    [1440, 900, "light"],
    [390, 844, "light"],
    [390, 844, "dark"],
    [800, 494, "light"],
    [800, 494, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    await page.goto(`${BASE}/?fixture=1${theme === "dark" ? "&theme=dark" : ""}#map=6.5/33.5/-84.4`);
    await page.locator("main[data-on-map]").waitFor({ timeout: 30_000 }).catch(() => {});
    await page.locator(".maplibregl-ctrl-attrib").waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(1500);
    const size = `${width}x${height}${theme === "dark" ? " dark" : ""}`;
    const gone = await Promise.all(["section[aria-label^='Selected flight']", "#column-tab-movements", "[role='group'][aria-label='Camera']", "#atc-camera", "main > ul", "main input[type='range']"].map((sel) => page.locator(sel).first().isVisible().catch(() => false)));
    check(`${size} on the map: no flight card, counts list, camera modes, legend or replay`, gone.every((v) => !v), String(gone));
    const b = await boxes(page, {
      // The title and subtitle (the header's row also holds the picker, and on a short window the radar switch between them).
      header: ".atc-title > div:first-child",
      search: "#atc-search",
      radar: "[data-radar]",
      filters: "button[aria-label^='Filters']",
      view: "[role='group'][aria-label='View']",
      themes: "[role='group'][aria-label='Map style']:visible",
      time: "main > div:has(> time)",
      credit: ".maplibregl-ctrl-attrib",
      data: DATA_CREDIT,
    });
    const names = Object.keys(b).filter((k) => b[k]);
    const clashes = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (overlaps(b[names[i]], b[names[j]])) clashes.push(`${names[i]}/${names[j]}`);
    check(`${size} on the map: the controls and the credit are all on screen and nothing overlaps`, names.length === 9 && clashes.length === 0, `missing: ${Object.keys(b).filter((k) => !b[k]).join(", ") || "none"}; ${clashes.join(", ")}`);
    // The map's middle is clear: nothing but the header and search above it, nothing but the foot below it
    // (a short window has room for little more than those two rows).
    // The radar switch is in the top rows on a tall screen and in the foot row on a short one.
    const radarTop = b.radar && b.radar.y < height / 2;
    const top = Math.max(b.header?.y + b.header?.height, b.search?.y + b.search?.height, radarTop ? b.radar.y + b.radar.height : 0);
    const below = [b.view, b.themes, b.time, radarTop ? null : b.radar].filter(Boolean).map((r) => r.y);
    const clear = Math.min(...below) - top;
    check(`${size} on the map: the chrome leaves most of the height clear`, width >= 1280 || clear >= height * 0.45, `${Math.round(clear)} px of ${height}`);
    check(`${size} on the map: console stays clean`, problems.length === 0, problems.slice(0, 3).join(" | "));
    await page.close();
  }

  // Aircraft photos (Planespotters) on the flight card. The API is answered here by a stub, so the
  // checks do not depend on a third party; what they check is how the page uses what it is given.
  {
    const API = "https://api.planespotters.net/pub/photos/hex/";
    const PIC = "https://t.plnspttrs.net/00000/stub_280.svg";
    const LINK = "https://www.planespotters.net/photo/1/stub-aircraft?utm_source=api";
    const stub = (page, photos) =>
      page.route(`${API}*`, (route) =>
        route.fulfill({ json: { photos }, headers: { "access-control-allow-origin": "*" } }),
      );
    const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="280"><rect width="420" height="280" fill="#789"/></svg>';
    const asked = [];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("request", (r) => {
      if (r.url().startsWith(API)) asked.push(r.url());
    });
    await page.route(PIC, (route) => route.fulfill({ body: SVG, contentType: "image/svg+xml", headers: { "access-control-allow-origin": "*" } }));
    await stub(page, [{ id: "1", thumbnail: { src: PIC, size: { width: 200, height: 133 } }, thumbnail_large: { src: PIC, size: { width: 420, height: 280 } }, link: LINK, photographer: "Test Photographer" }]);

    // A fixture does not ask a third party unless `&photos=1` says so.
    await page.goto(`${BASE}/?fixture=1`);
    const card = page.locator("section[aria-label^='Selected flight']");
    await card.waitFor({ timeout: 30_000 });
    await sleep(1500);
    check("a fixture page asks Planespotters for nothing and draws no photo", asked.length === 0 && (await page.locator("[data-photo]").count()) === 0);

    await page.goto(`${BASE}/?fixture=1&photos=1`);
    await card.waitFor({ timeout: 30_000 });
    const figure = page.locator("[data-photo]");
    await figure.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    check("a flight with a photo shows it on the card", await figure.isVisible());
    const link = figure.locator("a").first();
    check("the picture links to the photo's page as given, without nofollow", (await link.getAttribute("href")) === LINK && !((await link.getAttribute("rel")) ?? "").includes("nofollow"));
    check("the picture is the CDN's URL as given, and the photographer is credited in text beside it", (await figure.locator("img").getAttribute("src")) === PIC && (await figure.locator("figcaption").innerText()).includes("Test Photographer"));
    check("the photo is asked for by hex, once", asked.length === 1 && /\/hex\/[0-9a-f]{6}$/.test(asked[0]), asked.join(" "));

    // No photo: no figure, and no gap where one would go.
    await page.unroute(`${API}*`);
    await stub(page, []);
    const before = await card.boundingBox();
    await page.goto(`${BASE}/?fixture=1&photos=1&airport=pit`);
    await card.waitFor({ timeout: 30_000 }).catch(() => {});
    await sleep(2000);
    check("a flight without a photo has no photo box", (await page.locator("[data-photo]").count()) === 0 && before !== null);
    await page.close();
  }

  // The weather radar layer (RainViewer): off until asked for, nothing fetched before then, credited while on.
  {
    const INDEX = "https://api.rainviewer.com/public/weather-maps.json";
    const TILE = "https://tilecache.rainviewer.com/";
    const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const requests = { index: 0, tiles: 0 };
    let mode = "ok";
    page.on("request", (r) => {
      if (r.url().startsWith(INDEX)) requests.index++;
      if (r.url().startsWith(TILE)) requests.tiles++;
    });
    await page.route(`${INDEX}*`, (route) => {
      if (mode === "down") return route.fulfill({ status: 503, body: "down", headers: { "access-control-allow-origin": "*" } });
      const now = Math.floor(Date.now() / 1000);
      return route.fulfill({ json: { version: "2.0", generated: now, host: "https://tilecache.rainviewer.com", radar: { past: [{ time: now - 600, path: "/v2/radar/aaaa1111" }, { time: now - 60, path: "/v2/radar/bbbb2222" }], nowcast: [] } }, headers: { "access-control-allow-origin": "*" } });
    });
    await page.route(`${TILE}**`, (route) => route.fulfill({ body: PNG, contentType: "image/png", headers: { "access-control-allow-origin": "*" } }));
    await page.goto(`${BASE}/?fixture=1#map=5.5/38.5/-96`);
    await page.locator("main[data-on-map]").waitFor({ timeout: 30_000 });
    await sleep(2500);
    const toggle = page.getByRole("button", { name: "Radar", exact: true });
    check("the radar toggle is on the map, off, and nothing has been fetched for it", (await toggle.getAttribute("aria-pressed")) === "false" && requests.index === 0 && requests.tiles === 0);
    await toggle.click();
    await page.waitForFunction(() => document.querySelector("[data-radar] a[href='https://www.rainviewer.com/']"), null, { timeout: 15_000 }).catch(() => {});
    const credit = page.locator("[data-radar] a[href='https://www.rainviewer.com/']");
    check("on, the radar shows RainViewer's credit with a link", (await toggle.getAttribute("aria-pressed")) === "true" && (await credit.innerText()) === "Weather data by RainViewer");
    const note = (await page.locator("[data-radar] p").innerText()).replace(/\s+/g, " ");
    check("on, the radar says how old its frame is, not a clock time", /^Radar · (1 min ago|2 min ago|just now) · Weather data by RainViewer$/.test(note), note);
    await sleep(3000);
    check("on, the newest frame's tiles are drawn from the tile host", requests.index >= 1 && requests.tiles > 0, JSON.stringify(requests));
    const mapCredit = await page.locator(".maplibregl-ctrl-attrib").innerHTML();
    check("the map's own credit line names RainViewer too", mapCredit.includes("rainviewer.com"));
    await toggle.click();
    check("off again, the credit goes", (await toggle.getAttribute("aria-pressed")) === "false" && (await credit.count()) === 0);

    // An index that is down leaves the toggle on and says so, without an error in the console.
    mode = "down";
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    await toggle.click();
    await page.getByText("Radar unavailable right now").waitFor({ timeout: 15_000 }).catch(() => {});
    check("with the radar service down it says so and the page carries on", (await page.getByText("Radar unavailable right now").count()) === 1 && problems.length === 0);
    await page.close();
  }

  // Browser alerts: opt-in from the bell, never asked on load, each event notified once. The Notification
  // API is replaced by a recorder, and "?alerts=" plays a scripted run of traffic through the detector.
  {
    const open = async (query, permission, opted) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.addInitScript(recorder(permission, opted));
      await page.goto(`${BASE}/?fixture=1${query}`);
      await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
      return page;
    };
    const bell = (page) => page.locator("[data-alerts] > button");
    const notes = (page) => page.evaluate(() => window.__notes.map((n) => n.title));

    // Opt-in: nothing is asked or said on load; the one button asks, and then it is on.
    {
      const page = await open("&alerts=takeoff", "default", false);
      await sleep(3000);
      check("alerts: nothing is asked of the browser or notified on load", (await page.evaluate(() => window.__asked)) === 0 && (await notes(page)).length === 0);
      check("alerts: the bell is off and says so", (await page.locator("[data-alerts]").getAttribute("data-alerts")) === "off" && (await bell(page).getAttribute("aria-label")) === "Alerts, off");
      await bell(page).click();
      check("alerts: the panel says what they are and offers to turn them on", (await page.locator("[data-alerts-message]").innerText()).includes("pushes back, takes off or lands") && (await page.getByRole("button", { name: "Turn on alerts" }).count()) === 1);
      await page.getByRole("button", { name: "Turn on alerts" }).click();
      await page.waitForFunction(() => document.querySelector("[data-alerts]")?.getAttribute("data-alerts") === "on", null, { timeout: 5_000 }).catch(() => {});
      check("alerts: the click asks the browser once and turns them on", (await page.evaluate(() => window.__asked)) === 1 && (await page.locator("[data-alerts]").getAttribute("data-alerts")) === "on");
      await page.waitForFunction(() => window.__notes.length > 0, null, { timeout: 8_000 }).catch(() => {});
      await sleep(2500);
      check("alerts: the scripted takeoff is notified once, however many polls follow it", JSON.stringify(await notes(page)) === JSON.stringify(["AAL200 has taken off"]), JSON.stringify(await notes(page)));
      await page.getByRole("button", { name: "Turn off alerts" }).click();
      await page.waitForFunction(() => document.querySelector("[data-alerts]")?.getAttribute("data-alerts") === "off", null, { timeout: 5_000 }).catch(() => {});
      check("alerts: Turn off alerts turns them off", (await page.locator("[data-alerts]").getAttribute("data-alerts")) === "off");
      await page.close();
    }

    // Each kind, from a page that has opted in: exactly one notification, with the words for it.
    for (const [kind, title] of [
      ["pushback", "DAL100 is pushing back"],
      ["takeoff", "AAL200 has taken off"],
      ["landing", "UAL300 has landed"],
      ["emergency", "SWA400 is squawking 7700"],
      ["military", "Military aircraft in the area"],
    ]) {
      const page = await open(`&alerts=${kind}`, "granted", true);
      await page.waitForFunction(() => window.__notes.length > 0, null, { timeout: 10_000 }).catch(() => {});
      await sleep(3000);
      check(`alerts: ${kind} is notified exactly once`, JSON.stringify(await notes(page)) === JSON.stringify([title]), JSON.stringify(await notes(page)));
      await page.close();
    }
    {
      const page = await open("&alerts=all", "granted", true);
      await page.waitForFunction(() => window.__notes.length >= 5, null, { timeout: 20_000 }).catch(() => {});
      await sleep(2000);
      check("alerts: all five kinds, in turn, once each", (await notes(page)).length === 5, JSON.stringify(await notes(page)));
      await page.close();
    }

    // Where the browser will not do it, the control says so plainly and offers nothing to press.
    for (const [permission, state, words] of [
      ["denied", "blocked", "Notifications are blocked for this site."],
      [null, "unsupported", "This browser does not support notifications"],
    ]) {
      const page = await open("", permission, true);
      await bell(page).click();
      check(`alerts: ${state} says so plainly, with no button to turn them on`, (await page.locator("[data-alerts]").getAttribute("data-alerts")) === state && (await page.locator("[data-alerts-message]").innerText()).startsWith(words) && (await page.locator("[data-alerts] [role='group'] button").count()) === 0);
      await page.close();
    }

    // The bell sits in the header beside the picker: at the narrowest wide layout, in the theme with the widest header, it still clears the search box.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(`${BASE}/?fixture=1&theme=satellite`);
      await page.locator("[data-alerts]").waitFor({ timeout: 30_000 });
      await sleep(800);
      const b = await boxes(page, { header: ".atc-title", search: "#atc-search" });
      check("alerts: at 1280 the header, bell included, clears the search box", b.header !== null && b.search !== null && !overlaps(b.header, b.search), JSON.stringify(b));
      await page.close();
    }
  }

  // Gate to gate, on `?fixture=journey` (a recorded Atlanta to Charlotte flight, played compressed, through
  // the live code): Follow on the flight turns its route line into the journey's progress, and once it has
  // climbed out of the diorama the map takes the camera and the journey's own card goes with it.
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") problems.push(m.text());
    });
    page.on("pageerror", (e) => problems.push(String(e)));
    // Alerts on, to see the live path (the poll, not a script) tell of the followed flight.
    await page.addInitScript(recorder("granted", true));
    // From 90 s in the flight is still taxiing: at 150 s it is already on its takeoff roll, and on a
    // busy machine Follow could land after the takeoff was confirmed, when there is nothing left to tell.
    await page.goto(`${BASE}/?fixture=journey&flight=DAL1947&fixtureFrom=90`);
    const card = page.locator("section[aria-label^='Selected flight']");
    await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "DAL1947", null, { timeout: 60_000 }).catch(() => {});
    await card.getByRole("button", { name: "Follow this flight" }).last().click();
    const journey = card.locator("[data-journey]");
    await journey.waitFor({ timeout: 10_000 }).catch(() => {});
    const text = (await journey.innerText().catch(() => "")).replace(/\s+/g, " ");
    check("following a flight leaving ATL shows its journey: both ends and the distance left", /ATL.*CLT/.test(text) && /NM to go/.test(text), text);
    await page.waitForFunction(() => document.querySelector("main")?.dataset.onMap && document.querySelector("section[aria-label^='Followed flight'] [data-journey]"), null, { timeout: 240_000 }).catch(() => {});
    check(
      "climbing out, the map takes the camera and the journey's card goes with it",
      (await page.locator("main").getAttribute("data-on-map")) !== null && (await page.locator("section[aria-label^='Followed flight']").count()) === 1,
    );
    const told = await page.evaluate(() => window.__notes.map((n) => n.title));
    check("alerts: the followed flight's takeoff is notified once, from the live poll", told.filter((t) => t === "DAL1947 has taken off").length === 1, JSON.stringify(told));
    check("journey: console stays clean", problems.length === 0, problems.slice(0, 3).join(" | "));
    await page.close();
  }

  // A phone, and a short landscape window that has the wide layout's column at the right (the counts then sit in the
  // title row, between the title and the airport picker): nothing overlaps. The fixture opens on a flight with a route, the tallest card.
  for (const [width, height, theme] of [
    [390, 844, "light"],
    [390, 844, "dark"],
    [800, 494, "light"],
    [800, 494, "dark"],
  ]) {
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 500, hasTouch: width < 500 });
    await page.goto(`${BASE}/?fixture=1${theme === "dark" ? "&theme=dark" : ""}`);
    await page.locator("section[aria-label^='Selected flight']").waitFor({ timeout: 30_000 });
    await sleep(800);
    const short = height < 640;
    const b = await boxes(page, {
      // On a short window the title row also holds the counts, between the title text and the picker: the title's box is its text.
      header: short ? ".atc-title > div:first-child" : ".atc-title",
      search: "#atc-search",
      filters: "button[aria-label^='Filters']",
      counts: "[aria-live='polite']",
      // Rendered twice, once for each layout; only the one on screen counts.
      themes: "[role='group'][aria-label='Map style']:visible",
      view: "[role='group'][aria-label='View']",
      // The camera picker on phones and tablets (the button row is for wide screens).
      camera: "#atc-camera",
      tabs: "[role='tablist'][aria-label='Traffic']",
      card: "section[aria-label^='Selected flight']",
      // Hidden on a short screen, where it would not fit; counted only when shown.
      legend: "main > ul",
      time: "main > div:has(> time)",
      data: DATA_CREDIT,
    });
    const names = Object.keys(b).filter((k) => b[k]);
    const clashes = [];
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) if (overlaps(b[names[i]], b[names[j]])) clashes.push(`${names[i]}/${names[j]}`);
    const size = `${width}x${height}${theme === "dark" ? " dark" : ""}`;
    check(`${size}: the card shows the route`, (await page.locator("[data-route]").count()) === 1);
    check(`${size}: every control is on screen`, names.length === (height < 640 ? 11 : 12), `missing: ${Object.keys(b).filter((k) => !b[k]).join(", ") || "none"}`);
    check(`${size}: nothing overlaps`, clashes.length === 0, clashes.join(", "));
    if (short) {
      const row = await page.evaluate(() => {
        const edge = (sel, side) => document.querySelector(sel).getBoundingClientRect()[side];
        return { title: edge(".atc-title > div:first-child", "right"), countsLeft: edge("[aria-live='polite']", "left"), countsRight: edge("[aria-live='polite']", "right"), picker: edge(".atc-title > div:last-child", "left") };
      });
      check(`${size}: the counts sit in the title row, between the title and the airport picker`, row.title <= row.countsLeft && row.countsRight <= row.picker, JSON.stringify(row));
      const column = await boxes(page, { card: "section[aria-label^='Selected flight']", tabs: "[role='tablist'][aria-label='Traffic']" });
      check(`${size}: the card and the tabs stand in a column at the right, left of which the model is framed`, !!column.card && !!column.tabs && column.card.x > width / 2 && column.tabs.x > width / 2, JSON.stringify(column));
    }
    check(`${size}: the traffic panel starts folded to its tabs`, (await page.locator("section[aria-label='Traffic']").getAttribute("data-open")) === "false");

    // Open, the list keeps to the space between its tabs and the card (or, where that is too short
    // to be useful, the card steps aside), so nothing covers anything: not the list over the card, nor
    // the card pushed down onto the legend or the time bar.
    await page.locator("#column-tab-movements").click();
    await sleep(400);
    const o = await boxes(page, {
      list: "#movements-list",
      view: "[role='group'][aria-label='View']",
      camera: "#atc-camera",
      card: "section[aria-label^='Selected flight']",
      legend: "main > ul",
      time: "main > div:has(> time)",
    });
    const shown = Object.keys(o).filter((k) => o[k]);
    const openClashes = [];
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) if (overlaps(o[shown[i]], o[shown[j]])) openClashes.push(`${shown[i]}/${shown[j]}`);
    const shownRows = await page.locator("#movements-list li").evaluateAll((items) => {
      const ul = document.querySelector("#movements-list ul").getBoundingClientRect();
      return items.filter((li) => li.getBoundingClientRect().top < ul.bottom - 20).length;
    });
    check(`${size}: the open list shows rows and covers nothing`, o.list !== null && shownRows > 0 && openClashes.length === 0, `${shownRows} rows; ${openClashes.join(", ") || "no overlap"}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    check(`${size}: no sideways scroll`, !wide);
    await page.close();
  }

  // The longest airport names in that short window's title row, which the counts must not cover (scripts/smoke-title-row.mjs).
  await titleRowChecks({ browser, base: BASE, check });
  await titleRowPointerChecks({ browser, base: BASE, check });

  // The published approach and climb-out paths, cited on the card (scripts/smoke-procedures.mjs).
  await procedureChecks({ browser, base: BASE, check });
  await remoteFlightChecks({ browser, base: BASE, check });

  // A flight selected on the world map: its card, Escape, the lost state, a link, and the card clear of the chrome (scripts/smoke-map-select.mjs).
  await mapSelectChecks({ browser, base: BASE, check });

  // The published procedures in the gate-to-gate journey, and the journey panel's "from" for a flight picked on the map (scripts/smoke-journey-procedures.mjs).
  await journeyProcedureChecks({ browser, base: BASE, check });

  // The journey under what the live feed brings that the recording does not: a hand into the airport already on show, a quiet transponder, a feed that loses the aircraft (scripts/smoke-journey-live.mjs).
  await journeyLiveChecks({ browser, base: BASE, check });
} catch (error) {
  check("smoke run completed", false, String(error));
} finally {
  await browser.close();
  server?.kill();
}

console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
