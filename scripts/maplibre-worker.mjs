/**
 * Copies MapLibre's web worker into public/maplibre/, where the page loads it from.
 *
 * MapLibre 6 starts its worker from a file beside its own module (`maplibre-gl-worker.mjs`, which
 * imports `maplibre-gl-shared.mjs`). Once the bundler has moved MapLibre into a chunk there is no such
 * file beside it, so the page points MapLibre at this copy instead (see globe-map.ts). Run on every
 * install and before every build, so the copy always matches the installed version; the folder is
 * not committed.
 */

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(ROOT, "node_modules", "maplibre-gl", "dist");
const to = path.join(ROOT, "public", "maplibre");

mkdirSync(to, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(path.join(from, file), path.join(to, file));
