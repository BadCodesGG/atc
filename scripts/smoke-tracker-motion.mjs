/**
 * Smoke check for the Tracker's motion rules (#19): in the running page, every aircraft the Diorama draws
 * moves on each frame without stepping back along its track and without a jump of more than about a second
 * of its own speed, while the feed is read. It plays `?fixture=journey` (Atlanta, read every 5 s through
 * the same code as the live feed) and records what the page's own frames ask of the airport's tracker.
 * On its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3128 node scripts/smoke-tracker-motion.mjs
 *
 * The page exposes no handle on its tracker, so the check reaches it through React's fiber, as
 * scripts/smoke-journey-live.mjs does.
 */

import { launchChrome } from "./lib/chrome.mjs";
import { waitForTruthy } from "./smoke-journey-procedures.mjs";

/** The same figures as src/lib/tracker.ts: knots in m/s, rest below 1 kt, the snap distance, the step floor. */
const KNOTS = 1852 / 3600;
const AT_REST_KT = 1;
const SNAP_M = 1500;
const STEP_FLOOR_M = 5;
/** Frames further apart on the picture's clock than this are not one motion (the recording's warp). */
const MAX_FRAME_GAP = 1;
const WATCH_MS = 25_000;

/** Finds the airport's tracker in the Viewer's state (below `main`, so found from the model's own element) and records every frame it is asked for. */
const HOOK = `(() => {
  const el = document.querySelector("[role='application']");
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return false;
  const isTraffic = (c) => c && typeof c === "object" && c.tracker && typeof c.tracker.at === "function" && typeof c.tracker.add === "function" && c.view && typeof c.clock === "function";
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      const c = isTraffic(h.memoizedState) ? h.memoizedState : isTraffic(h.memoizedState?.current) ? h.memoizedState.current : null;
      if (!c) continue;
      if (window.__motion) return true;
      const tracker = c.tracker;
      const at = tracker.at.bind(tracker);
      const frames = [];
      window.__motion = frames;
      tracker.at = (time) => {
        const out = at(time);
        if (frames.length === 0 || frames.at(-1).time !== time) frames.push({ time, aircraft: out.map((a) => [a.id, a.x, a.y, a.groundSpeedKt, a.onGround, a.headingKnown, a.headingDeg]) });
        return out;
      };
      // A headless browser drawing WebGL in software manages a frame or two a second: ask the tracker on
      // the page's own clock at a display's 60 Hz as well, alongside the frames the page draws.
      window.setInterval(() => tracker.at(c.clock()), 1000 / 60);
      return true;
    }
  }
  return false;
})()`;

/** The same rules as the Tracker's replay test (src/lib/tracker.test.ts), over the frames the page drew. */
function violations(frames) {
  const out = [];
  const last = new Map();
  let moves = 0;
  for (let i = 1; i < frames.length; i++) {
    const dt = frames[i].time - frames[i - 1].time;
    const before = new Map(frames[i - 1].aircraft.map((a) => [a[0], a]));
    for (const [id, x, y] of frames[i].aircraft) {
      const b = before.get(id);
      if (!b || dt <= 0 || dt > MAX_FRAME_GAP) {
        last.delete(id);
        continue;
      }
      const [, bx, by, gs, onGround, headingKnown, headingDeg] = b;
      const dx = x - bx;
      const dy = y - by;
      const step = Math.hypot(dx, dy);
      moves++;
      const atRest = gs !== null && gs < AT_REST_KT;
      const bound = Math.max((gs ?? 0) * KNOTS, STEP_FLOOR_M) + 1e-6;
      const snapped = step > SNAP_M;
      if (step > bound && !snapped) out.push(`${id} stepped ${step.toFixed(1)} m (bound ${bound.toFixed(1)} m)`);
      if (!atRest && !snapped) {
        const u = last.get(id);
        if (u && dx * u[0] + dy * u[1] < -1e-6) out.push(`${id} moved ${(-(dx * u[0] + dy * u[1])).toFixed(3)} m back on its last move`);
        if (!onGround && headingKnown) {
          const along = dx * Math.sin((headingDeg * Math.PI) / 180) + dy * Math.cos((headingDeg * Math.PI) / 180);
          if (along < -1e-6) out.push(`${id} flew ${(-along).toFixed(3)} m back along its track`);
        }
      }
      if (snapped || step <= 1e-3) last.delete(id);
      else last.set(id, [dx / step, dy / step]);
    }
  }
  return { out, moves };
}

export async function trackerMotionChecks({ browser, base, check }) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${base}/?fixture=journey&airport=atl`);
  await waitForTruthy(page, HOOK, 60_000);
  // Wait for the first reads to be in and drawn, then watch.
  await waitForTruthy(page, "(window.__motion || []).some((f) => f.aircraft.length > 0)", 60_000);
  await page.evaluate("window.__motion.length = 0");
  await page.waitForTimeout(WATCH_MS);
  const frames = await page.evaluate("window.__motion");
  const span = frames.length > 1 ? frames.at(-1).time - frames[0].time : 0;
  const { out, moves } = violations(frames);
  check(`?fixture=journey at ATL: the airport's tracker drew ${frames.length} frames over ${span.toFixed(1)} s of feed time, with reads arriving`, frames.length > 200 && span > 10, `${moves} aircraft moves`);
  check("... and no drawn aircraft stepped back along its track, or more than a second of its own speed in a frame", out.length === 0, out.slice(0, 10).join("; "));
  check("... with no page errors", errors.length === 0, errors.slice(0, 3).join("; "));
  await page.close();
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-tracker-motion.mjs")) {
  let failures = 0;
  let total = 0;
  const check = (name, ok, detail = "") => {
    total++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  const browser = await launchChrome({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await trackerMotionChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check });
  } catch (error) {
    check("tracker motion run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}
