/**
 * What the smoke scripts share to drive a page: a pause, a wait for an expression, and the page's own objects
 * reached through React's fiber (the page exposes no handle on its map, journey or Diorama).
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

/**
 * Selects the aircraft `hex` on the World map with a click, as a reader would, and returns once the map has
 * taken it (its selection is `hex`). The click goes where the aircraft is drawn, in the page's pixels, once
 * that point holds still between two reads: the page's padding and layout can land after the traffic first
 * draws, moving the map on screen by tens of pixels, past the click's reach (pick.ts REACH_PX), so a point
 * read once and clicked later can miss. A click the map did not take is tried again from a fresh read, up to
 * `tries` in all, and `beforeClick` runs before each. Throws, saying what the map had, when the aircraft is
 * never drawn and still within `timeout` ms, or no click takes it.
 */
export async function selectOnMap(page, hex, { timeout = 60_000, tries = 3, beforeClick = async () => {} } = {}) {
  const id = JSON.stringify(hex);
  const AT = `(() => {
    const g = ${GLOBE};
    const f = g && g.drawn.find((x) => x.properties.id === ${id});
    if (!f) return null;
    const p = g.map.project(f.geometry.coordinates);
    const box = g.map.getContainer().getBoundingClientRect();
    return { x: box.left + p.x, y: box.top + p.y };
  })()`;
  const TAKEN = `(() => { const g = ${GLOBE}; return !!g && g.selectedId === ${id}; })()`;
  const end = Date.now() + timeout;
  let at = null;
  let clicks = 0;
  while (clicks < tries) {
    at = null;
    let last = null;
    while (Date.now() < end) {
      const now = await page.evaluate(AT);
      if (now && last && Math.hypot(now.x - last.x, now.y - last.y) < 2) {
        at = now;
        break;
      }
      last = now;
      await sleep(300);
    }
    if (!at) break;
    await beforeClick();
    await page.mouse.click(at.x, at.y);
    clicks++;
    if (await waitForTruthy(page, TAKEN, 5_000).then(() => true, () => false)) return at;
  }
  const had = await page.evaluate(`(() => {
    const g = ${GLOBE};
    if (!g) return "no map";
    const at = ${JSON.stringify(at)};
    const el = at && document.elementFromPoint(at.x, at.y);
    return { drawn: ${AT}, selected: g.selectedId, zoom: g.map.getZoom(), moving: g.map.isMoving(), under: el ? el.tagName + "." + String(el.className) : null };
  })()`);
  throw new Error(`the map did not select ${hex}: ${clicks ? `${clicks} clicks did not take it` : `it was not drawn and still within ${timeout} ms`} (${JSON.stringify(had)})`);
}
