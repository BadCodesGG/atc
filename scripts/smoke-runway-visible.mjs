/**
 * Smoke check that a small airport's runway reads in its Diorama by day (#17): at BTP and BFT, in Light,
 * the runway as drawn is clearly darker than the taxiway pavement beside it and than the ground around it.
 * It measures the drawn pixels, not the theme's values: the runway's centreline is projected through the
 * scene's own camera, every overlay is hidden, and the canvas is sampled from a screenshot.
 * scripts/smoke.mjs runs it with the rest; on its own, against a server already running:
 *
 *   SMOKE_URL=http://localhost:3181 node scripts/smoke-runway-visible.mjs
 *
 * The page exposes no handle on its scene, so the check reaches it through React's fiber, as
 * scripts/smoke-journey-live.mjs does.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome } from "./lib/chrome.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (code) => JSON.parse(readFileSync(path.join(ROOT, "src/data/airports", `${code}.json`), "utf8"));

/** The Diorama's scene: the ref that holds it, found from the model's own element. */
const SCENE = `(() => {
  const el = document.querySelector("[role='application']");
  const key = el && Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
  if (!key) return null;
  for (let f = el[key]; f; f = f.return) {
    for (let h = f.memoizedState; h; h = h.next) {
      const c = h.memoizedState && h.memoizedState.current;
      if (c && typeof c.project === "function" && c.canvas instanceof HTMLCanvasElement) return c;
    }
  }
  return null;
})()`;

/** WCAG contrast of two relative luminances. */
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Points on the runway's pavement, a quarter of its width off the centreline (clear of the dashes), and on the ground well clear of it. */
function runwayPoints(runway) {
  const [e0, e1] = runway.ends;
  const length = Math.hypot(e1.x - e0.x, e1.y - e0.y);
  const ux = (e1.x - e0.x) / length;
  const uy = (e1.y - e0.y) / length;
  const at = (along, across) => [e0.x + ux * along - uy * across, e0.y + uy * along + ux * across];
  const pavement = [0.3, 0.4, 0.5, 0.6, 0.7].flatMap((f) => [at(f * length, runway.width * 0.25), at(f * length, -runway.width * 0.25)]);
  return { pavement, ux, uy, length, e0 };
}

/** Midpoints of the longer mapped taxiway segments that lie well off every runway: taxiway pavement, as drawn. */
function taxiwayPoints(map) {
  const off = (p) =>
    map.runways.every((r) => {
      const { ux, uy, e0 } = runwayPoints(r);
      return Math.abs(-(p[0] - e0.x) * uy + (p[1] - e0.y) * ux) > r.width * 2;
    });
  const points = [];
  for (const t of map.taxiways) {
    for (let i = 1; i < t.line.length; i++) {
      const [a, b] = [t.line[i - 1], t.line[i]];
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 60 && off(mid)) points.push(mid);
    }
  }
  return points;
}

/** Where map points land on screen, through the scene's camera; only those well inside the frame. */
async function project(page, points) {
  return page.evaluate(
    ({ expr, points }) => {
      const scene = eval(expr);
      const w = innerWidth;
      const h = innerHeight;
      // The scene projects into its own canvas; the screenshot is of the page.
      const box = scene.canvas.getBoundingClientRect();
      return points
        .map(([x, y]) => scene.project(x, y, 1.2))
        .map((p) => ({ ...p, x: p.x + box.left, y: p.y + box.top }))
        .filter((p) => p.visible && p.x > 40 && p.x < w - 40 && p.y > 120 && p.y < h - 120);
    },
    { expr: SCENE, points },
  );
}

/** Mean relative luminance of a 3x3 patch at each point, read from a screenshot of the canvas alone. */
async function luminances(page, points) {
  const png = (await page.screenshot()).toString("base64");
  return page.evaluate(
    async ({ png, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return points.map(({ x, y }) => {
        const d = g.getImageData(Math.round(x) - 1, Math.round(y) - 1, 3, 3).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * lin(d[i] / 255) + 0.7152 * lin(d[i + 1] / 255) + 0.0722 * lin(d[i + 2] / 255);
        return sum / 9;
      });
    },
    { png, points },
  );
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** The least contrast the drawn runway holds against taxiway pavement and against the ground, by day in Light. */
const MIN_DRAWN = 1.2;

export async function runwayVisibleChecks({ browser, base, check }) {
  for (const code of ["btp", "bft"]) {
    const map = load(code);
    const runway = map.runways[0];
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const problems = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    await page.goto(`${base}/?fixture=1&airport=${code}`);
    await page.locator("[role='application'] canvas").first().waitFor({ timeout: 60_000 });
    // The scene builds, then the camera eases in to its opening framing.
    for (let i = 0; i < 60 && !(await page.evaluate(`!!${SCENE}`)); i++) await page.waitForTimeout(500);
    await page.waitForTimeout(4000);
    // Only the canvases: the labels, the chrome and the panels are drawn over the model.
    await page.addStyleTag({ content: "body * { visibility: hidden !important; } canvas { visibility: visible !important; }" });
    await page.waitForTimeout(300);

    const { pavement, ux, uy, length, e0 } = runwayPoints(runway);
    // Ground: 150 m either side of the runway's middle, off any mapped pavement there.
    const ground = [-150, 150].map((across) => [e0.x + ux * length * 0.5 - uy * across, e0.y + uy * length * 0.5 + ux * across]);
    const onRunway = await project(page, pavement);
    const onTaxiway = await project(page, taxiwayPoints(map));
    const onGround = await project(page, ground);
    check(`${code.toUpperCase()} light: the runway ${runway.ref} is in frame`, onRunway.length >= 4 && onTaxiway.length >= 2, `runway ${onRunway.length}, taxiway ${onTaxiway.length}, ground ${onGround.length} points`);
    if (onRunway.length && onTaxiway.length) {
      const r = median(await luminances(page, onRunway));
      const t = median(await luminances(page, onTaxiway));
      const detail = `runway ${r.toFixed(3)}, taxiway ${t.toFixed(3)}, contrast ${contrast(r, t).toFixed(2)}`;
      check(`${code.toUpperCase()} light: the runway is drawn clearly darker than the taxiway pavement`, r < t && contrast(r, t) >= MIN_DRAWN, detail);
    }
    if (onRunway.length && onGround.length) {
      const r = median(await luminances(page, onRunway));
      const gl = median(await luminances(page, onGround));
      check(`${code.toUpperCase()} light: the runway is drawn clearly darker than the ground`, r < gl && contrast(r, gl) >= MIN_DRAWN, `runway ${r.toFixed(3)}, ground ${gl.toFixed(3)}, contrast ${contrast(r, gl).toFixed(2)}`);
    }
    check(`${code.toUpperCase()} light: no page errors`, problems.length === 0, problems.join(" | "));
    await page.close();
  }
}

// On its own: against a server already running.
if (process.argv[1] && process.argv[1].endsWith("smoke-runway-visible.mjs")) {
  let failures = 0;
  let total = 0;
  const check = (name, ok, detail = "") => {
    total++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    if (!ok) failures++;
  };
  const browser = await launchChrome({ headless: true, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    await runwayVisibleChecks({ browser, base: process.env.SMOKE_URL ?? "http://localhost:3128", check });
  } catch (error) {
    check("runway visibility run completed", false, String(error));
  } finally {
    await browser.close();
  }
  console.log(`\n${total - failures}/${total} checks passed`);
  process.exit(failures ? 1 : 0);
}
