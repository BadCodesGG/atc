/**
 * Smoke check for the title row of a short landscape window (800x494, where the counts join it at 260px): a long
 * airport name must give way to the counts, never run on beneath them. scripts/smoke.mjs runs it with the rest; on its own,
 * against a server already running:
 *
 *   SMOKE_URL=http://localhost:3146 node scripts/smoke-title-row.mjs
 */

import { chromium } from "playwright";

/** The longest names built, which is what the check is for (src/lib/airports.ts), each in the theme that gives the title the most room taken. */
const CASES = [
  ["atl", "light"],
  ["atl", "dark"],
  ["bwi", "light"],
  ["bwi", "satellite"],
  ["msp", "light"],
  ["bos", "light"],
  ["fll", "light"],
];

export async function titleRowChecks({ browser, base, check }) {
  for (const [code, theme] of CASES) {
    const page = await browser.newPage({ viewport: { width: 800, height: 494 } });
    await page.goto(`${base}/?fixture=1&airport=${code}${theme === "light" ? "" : `&theme=${theme}`}`);
    await page.locator("[aria-live='polite']").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    const row = await page.evaluate(() => {
      const edge = (sel, side) => document.querySelector(sel).getBoundingClientRect()[side];
      return { title: edge(".atc-title > div:first-child", "right"), countsLeft: edge("[aria-live='polite']", "left"), countsRight: edge("[aria-live='polite']", "right"), picker: edge(".atc-title > div:last-child", "left"), titleBottom: edge(".atc-title > div:first-child", "bottom"), searchTop: edge("#atc-search", "top"), name: document.querySelector(".atc-title p")?.textContent };
    });
    check(`800x494 ${code.toUpperCase()} ${theme}: the airport's name ends before the counts, which end before the airport picker`, row.title <= row.countsLeft && row.countsRight <= row.picker, JSON.stringify(row));
    check(`800x494 ${code.toUpperCase()} ${theme}: ... and, wrapped to two lines, it still clears the search box`, row.titleBottom <= row.searchTop, JSON.stringify(row));
    await page.close();
  }
}

/**
 * The title row lets clicks through itself (the radar toggle sits in its gap on a short window), but its text
 * is not click-through: the subtitle's tooltip and its text selection work. On the map at 800x494, where the toggle
 * is between the title and the picker: the toggle's own centre is the toggle, a real click flips it, and the subtitle's centre is the subtitle.
 */
export async function titleRowPointerChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 800, height: 494 } });
  // The radar's frames come from a third party; this check is only about whether the toggle can be clicked.
  await page.route(/rainviewer.com/, (route) => route.abort());
  await page.goto(`${base}/?fixture=1#map=6.5/33.5/-84.4`);
  await page.locator("main[data-on-map]").waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const hit = await page.evaluate(() => {
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    };
    const toggle = document.querySelector("[data-radar] button");
    const subtitle = document.querySelector(".atc-title p");
    return { toggle: at(toggle)?.closest("button") === toggle, subtitle: at(subtitle)?.closest("p") === subtitle, title: subtitle?.getAttribute("title") };
  });
  check("800x494 on the map: the radar toggle in the title row's gap is the element under its own centre", hit.toggle, JSON.stringify(hit));
  check("800x494 on the map: the subtitle is the element under its own centre, so its tooltip and its text selection work", hit.subtitle, JSON.stringify(hit));
  const toggle = page.getByRole("button", { name: "Radar", exact: true });
  await toggle.click({ timeout: 5_000 }).catch(() => {});
  check("800x494 on the map: a real click on the radar toggle turns it on", (await toggle.getAttribute("aria-pressed")) === "true");
  await page.close();
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-title-row.mjs")) {
  let failures = 0;
  let total = 0;
  const check = (name, ok, detail = "") => {
    total++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  const browser = await chromium.launch({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await titleRowChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check });
    await titleRowPointerChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check });
  } catch (error) {
    check("title row run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}
