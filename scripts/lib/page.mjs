/**
 * What the smoke scripts share to drive a page: a pause, a wait for an expression, the page's own objects
 * reached through React's fiber (the page exposes no handle on its map, journey or Diorama), and a flight
 * selected on the map with a click.
 */

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until `expression` is truthy in the page, polling every 200 ms; throws after `timeout` ms. Not
 * page.waitForFunction: given a string, Playwright evaluates it inside the page with eval, which the app's
 * Content-Security-Policy forbids (no 'unsafe-eval'), so the wait would fail on the policy rather than on the
 * page. page.evaluate goes through the debugger protocol, which the policy does not govern.
 */
export async function waitForTruthy(page, expression, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(expression).catch(() => false)) return true;
    if (Date.now() >= end) throw new Error(`timed out after ${timeout} ms waiting for ${expression.slice(0, 80)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * An expression for page.evaluate that finds a value React holds at or above the element `from`: the first
 * object `c` for which `test` (an expression of `c`) holds, or null. It looks in each hook's ref (its
 * `.current`), and with `state` in each hook's state as well. With `ref` it answers the ref holding the value,
 * so a check can clear it.
 */
export const fiber = (test, { from = "main", state = false, ref = false } = {}) => `(() => {
  const el = document.querySelector(${JSON.stringify(from)});
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      for (const c of ${state ? "[h.memoizedState, h.memoizedState && h.memoizedState.current]" : "[h.memoizedState && h.memoizedState.current]"}) {
        if (c && typeof c === "object" && ${test}) return ${ref ? "h.memoizedState" : "c"};
      }
    }
  }
  return null;
})()`;

/** The map's instance (GlobeMap), found from `main`. */
export const GLOBE = fiber(`c.map && typeof c.map.project === "function" && c.drawn`);

/** How long selectOnMap waits for the aircraft to be drawn and still, and to be taken, ms (a click's own wait can end up to a second past it), and the clicks it tries. */
const SELECT_WAIT_MS = 60_000;
const SELECT_CLICKS = 3;

/**
 * Selects the aircraft `hex` on the World map with a click, as a reader would, and returns once the map has
 * taken it (its selection is `hex`). The click goes where the aircraft is drawn, in the page's pixels, once
 * that point holds still between two reads: the page's padding and layout can land after the traffic first
 * draws, moving the map on screen by tens of pixels, past the click's reach (pick.ts REACH_PX), so a point
 * read once and clicked later can miss. A click the map did not take is tried again from a fresh read. With
 * `forgetRoute` (a callsign) the map forgets the route it learned for that flight before each click, so the
 * flight is one first met on the map with no route. Throws, saying what the map had, when the aircraft is
 * never drawn and still, or no click takes it.
 */
export async function selectOnMap(page, hex, { forgetRoute = null } = {}) {
  const id = JSON.stringify(hex);
  const drawnAt = `(() => {
    const g = ${GLOBE};
    const f = g && g.drawn.find((x) => x.properties.id === ${id});
    if (!f) return null;
    const p = g.map.project(f.geometry.coordinates);
    const box = g.map.getContainer().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  })()`;
  const taken = `(() => { const g = ${GLOBE}; return !!g && g.selectedId === ${id}; })()`;
  const end = Date.now() + SELECT_WAIT_MS;
  let clicks = 0;
  let at = null;
  while (clicks < SELECT_CLICKS) {
    at = null;
    let last = null;
    while (Date.now() < end) {
      const now = await page.evaluate(drawnAt);
      if (now && last && Math.hypot(now.x - last.x, now.y - last.y) < 2) {
        at = now;
        break;
      }
      last = now;
      await sleep(300);
    }
    if (!at) break;
    if (forgetRoute) await page.evaluate(`(() => { const g = ${GLOBE}; g.routes.delete(${JSON.stringify(forgetRoute)}); })()`);
    await page.mouse.click(at.x, at.y);
    clicks++;
    if (await waitForTruthy(page, taken, Math.min(5_000, Math.max(1_000, end - Date.now()))).then(() => true, () => false)) return at;
  }
  const seen = await page.evaluate(`(() => {
    const g = ${GLOBE};
    if (!g) return "no map";
    return { drawnAt: ${drawnAt}, selected: g.selectedId, zoom: g.map.getZoom(), moving: g.map.isMoving() };
  })()`);
  const why = at ? `${clicks} of ${clicks} clicks were not taken` : `${clicks ? `after ${clicks} untaken, ` : ""}it was not drawn and still within ${SELECT_WAIT_MS} ms`;
  throw new Error(`the map did not select ${hex}: ${why} (${JSON.stringify(seen)})`);
}
