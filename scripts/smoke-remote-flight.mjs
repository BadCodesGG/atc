/**
 * Smoke check for a flight found elsewhere: searching a callsign that is not at the airport on show asks
 * the flight lookup (stubbed here with a position over ATL, so it never waits on adsb.lol), and choosing
 * the result flies the map to that airport, lands, and has the flight selected. scripts/smoke.mjs runs it
 * with the rest; on its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3128 node scripts/smoke-remote-flight.mjs
 *
 * The page's first seconds on a software GPU are long tasks of six to eleven seconds, during which typing
 * is only queued: the result is waited for as long as that takes, and a result that never comes is a
 * failure here, not an Enter pressed on nothing.
 */

import { chromium } from "playwright";

export async function remoteFlightChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const card = page.locator("section[aria-label^='Selected flight']");
  const box = page.locator("#atc-search");
  await page.route("**/api/flight/**", (route) =>
    route.fulfill({ json: { callsign: "RPA4349", registration: null, typeCode: "E170", latitude: 33.66, longitude: -84.43, altitudeFt: 1500, groundSpeedKt: 140, route: null } }),
  );
  await page.goto(`${base}/?fixture=1&airport=pit`);
  await page.locator(".atc-title", { hasText: "PIT" }).waitFor({ timeout: 30_000 });
  await page.locator("#movements-list").waitFor({ timeout: 30_000 }).catch(() => {});
  await box.fill("RPA4349");
  const shown = await page.locator("[role='option']", { hasText: "Open ATL" }).waitFor({ timeout: 60_000 }).then(() => true, () => false);
  if (shown) await box.press("Enter");
  await page.locator(".atc-title", { hasText: "ATL" }).waitFor({ timeout: 30_000 }).catch(() => {});
  // The map flies there and lands on the diorama, which then shows the card.
  await page.waitForFunction(() => document.querySelector("section[aria-label^='Selected flight'] h2")?.textContent === "RPA4349" && !document.querySelector("main")?.dataset.onMap, null, { timeout: 60_000 }).catch(() => {});
  check(
    "a flight found elsewhere flies the map to its airport, lands, and has the flight selected",
    shown && (await page.locator(".atc-title").innerText()).includes("ATL") && (await card.locator("h2").innerText().catch(() => "")) === "RPA4349" && page.url().includes("fixture=1"),
    shown ? page.url() : `no "Open ATL" result within 60 s; ${page.url()}`,
  );
  await page.close();
}

if (process.argv[1] && process.argv[1].endsWith("smoke-remote-flight.mjs")) {
  const base = process.env.SMOKE_URL ?? "http://localhost:3128";
  const times = Number(process.env.TIMES ?? 1);
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  let failures = 0;
  try {
    for (let i = 0; i < times; i++) {
      await remoteFlightChecks({
        browser,
        base,
        check: (name, ok, detail = "") => {
          console.log(`${i + 1}/${times} ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
          if (!ok) failures++;
        },
      });
    }
  } finally {
    await browser.close();
  }
  console.log(`${times - failures}/${times} runs passed`);
  process.exit(failures ? 1 : 0);
}
