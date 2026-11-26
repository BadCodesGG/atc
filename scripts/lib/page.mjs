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
