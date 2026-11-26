/**
 * Smoke check for the wide right-hand column (ticket #18): with a tall flight card open, the card and the
 * Movements / Pulse / Board panel keep their own heights and the column scrolls as one, so the wheel over it
 * reaches the last row of each tab, and the panel is no shorter with the card than without it. Run at 1440x880,
 * the window the squeeze was seen in. scripts/smoke.mjs runs it with the rest; on its own, against a server
 * already running:
 *
 *   SMOKE_URL=http://localhost:3182 node scripts/smoke-wide-column.mjs
 *
 * At Atlanta: `?fixture=1` holds no traffic at most airports (BTP, where the squeeze was seen, among them), and
 * Atlanta's recording opens with a flight selected, its card the full one this window has room for.
 */

import { launchChrome } from "./lib/chrome.mjs";

const SCROLLER = "[data-column-scroll]";
const CARD = "section[aria-label^='Selected flight']";
const PANEL = "section[aria-label='Traffic']";
/** The last row of each tab's list (Pulse is one block: its figures are its foot). */
const LAST = { movements: "#movements-rows > li:last-child", pulse: "[data-pulse] dl", board: "[data-board] > li:last-child, p[data-board]" };

/** The scroller's box and scroll, and the panel's height. */
const measure = (page) =>
  page.evaluate(
    ([scroller, panel]) => {
      const s = document.querySelector(scroller);
      const r = s.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight, panel: document.querySelector(panel).getBoundingClientRect().height };
    },
    [SCROLLER, PANEL],
  );

/**
 * Wheels over the column (a real wheel, so it is the pointer that scrolls it), `dy` a turn, until it is at
 * that end or has not moved for three turns (a dev server's long tasks can swallow one).
 */
async function wheelColumn(page, dy) {
  const box = await measure(page);
  await page.mouse.move((box.left + box.right) / 2, box.top + 120);
  let last = -1;
  let still = 0;
  for (let i = 0; i < 60 && still < 3; i++) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(150);
    const now = await measure(page);
    if (dy > 0 ? now.scrollTop + now.clientHeight >= now.scrollHeight - 2 : now.scrollTop === 0) return;
    still = now.scrollTop === last ? still + 1 : 0;
    last = now.scrollTop;
  }
}

/** Whether `selector`'s element is wholly inside the scroller's visible box, and is what is under its own centre. */
const inView = (page, selector) =>
  page.evaluate(
    ([sel, scroller]) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, why: "no row" };
      const r = el.getBoundingClientRect();
      const s = document.querySelector(scroller).getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const ok = r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.bottom <= window.innerHeight && !!hit && el.contains(hit);
      return { ok, row: [Math.round(r.top), Math.round(r.bottom)], column: [Math.round(s.top), Math.round(s.bottom)] };
    },
    [selector, SCROLLER],
  );

export async function wideColumnChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 880 } });
  await page.goto(`${base}/?fixture=1`);
  await page.locator(CARD).waitFor({ timeout: 60_000 });
  await page.locator("#movements-rows li").first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1000);

  // The card is tall enough to push the panel past the column's foot: what the rest of the checks are about.
  const open = await measure(page);
  check("1440x880: with the card open, the column holds more than it shows, so it scrolls", open.scrollHeight > open.clientHeight + 40, JSON.stringify(open));

  // The scroller takes no clicks of its own: its 12 px margin beside the card and the gap under the card are the map's.
  const through = await page.evaluate(([scroller, card, panel]) => {
    const s = document.querySelector(scroller).getBoundingClientRect();
    const c = document.querySelector(card).getBoundingClientRect();
    const p = document.querySelector(panel).getBoundingClientRect();
    const at = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit ? (hit.closest(scroller) ? "column" : hit.tagName) : null;
    };
    return { margin: at(s.left + 6, c.top + c.height / 2), gap: at(c.left + c.width / 2, (c.bottom + p.top) / 2) };
  }, [SCROLLER, CARD, PANEL]);
  check("1440x880: beside the card and in the gap under it, the map, not the column, is what a click finds", through.margin !== "column" && through.gap !== "column", JSON.stringify(through));

  // The panel's height for each tab, with the card and (the card taken out) without it.
  const heights = {};
  for (const tab of ["movements", "pulse", "board"]) {
    await page.locator(`#column-tab-${tab}`).click();
    await page.waitForTimeout(300);
    const withCard = (await measure(page)).panel;
    await page.locator(CARD).evaluate((el) => (el.style.display = "none"));
    await page.waitForTimeout(200);
    const without = (await measure(page)).panel;
    await page.locator(CARD).evaluate((el) => (el.style.display = ""));
    await page.waitForTimeout(200);
    heights[tab] = [withCard, without];
    check(`1440x880 ${tab}: the panel is no shorter with the card open than without it`, withCard >= without - 1, `${withCard} with, ${without} without`);

    // The wheel over the column takes it to the panel's last row (a tab short enough to fit with the card shows it unscrolled).
    await wheelColumn(page, 400);
    const end = await measure(page);
    const last = await inView(page, LAST[tab]);
    const scrolls = end.scrollHeight > end.clientHeight;
    check(`1440x880 ${tab}: the wheel scrolls the column to the end, and the last row shows whole`, (!scrolls || end.scrollTop > 0) && end.scrollTop + end.clientHeight >= end.scrollHeight - 2 && last.ok, JSON.stringify({ ...last, scrolls, scrollTop: end.scrollTop }));
    await wheelColumn(page, -400);
  }
  check("1440x880: the wheel scrolls back to the card", (await measure(page)).scrollTop === 0);

  // Every moving aircraft: the expanded list runs on in the same scroll, to its last row.
  await page.locator("#column-tab-movements").click();
  const more = page.getByRole("button", { name: /more moving/ });
  if (await more.count()) {
    await more.click();
    await page.waitForTimeout(400);
    await wheelColumn(page, 400);
    const last = await inView(page, LAST.movements);
    check("1440x880: every moving aircraft listed, the column scrolls to the last of them", last.ok, JSON.stringify(last));

    // A flight picked from down the list brings its card back into view at the head of the column.
    const row = page.locator(LAST.movements).locator("button");
    const callsign = (await row.locator("span.truncate").first().innerText()).split(" ")[0];
    await row.click();
    await page.waitForFunction(([sel, c]) => document.querySelector(sel)?.querySelector("h2")?.textContent === c, [CARD, callsign], { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const after = await measure(page);
    const card = await inView(page, `${CARD} h2`);
    check("1440x880: a flight picked from the foot of the list scrolls the column back to its card", after.scrollTop === 0 && card.ok, JSON.stringify({ scrollTop: after.scrollTop, callsign, ...card }));
    await page.getByRole("button", { name: "Show fewer" }).click();
    await page.waitForTimeout(300);
  }

  // A short column (the card taken out) covers only its own height: the map below it takes the clicks.
  await page.locator("#column-tab-pulse").click();
  await page.locator(CARD).evaluate((el) => (el.style.display = "none"));
  await page.waitForTimeout(300);
  const below = await page.evaluate((scroller) => {
    const col = document.querySelector(".side-column").getBoundingClientRect();
    const s = document.querySelector(scroller).getBoundingClientRect();
    const hit = document.elementFromPoint((col.left + col.right) / 2, col.bottom - 20);
    return { scrollerBottom: Math.round(s.bottom), columnBottom: Math.round(col.bottom), hit: hit?.tagName, inColumn: !!hit?.closest(".side-column") };
  }, SCROLLER);
  check("1440x880: under a short column the map, not the column, is what a click finds", below.scrollerBottom < below.columnBottom - 40 && !below.inColumn, JSON.stringify(below));
  await page.close();
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-wide-column.mjs")) {
  let failures = 0;
  let total = 0;
  const check = (name, ok, detail = "") => {
    total++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  const browser = await launchChrome({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await wideColumnChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check });
  } catch (error) {
    check("wide column run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}
