/**
 * What the En-route view's smokes share (smoke-en-route-chase.mjs, -cameras.mjs and -journey.mjs): the flight
 * they follow, the map's En-route state, and the terrain tiles answered with a flat one.
 */

import { deflateSync } from "node:zlib";
import { GLOBE } from "./page.mjs";

/**
 * JBU1897 (hex a37fb0) is in the fixture's sky 51 NM west of Atlanta. Picked on the map and followed, its
 * own reads have it cruising west at 11,000 ft, climbing gently, with no route: the journey stays on the map.
 */
export const HEX = "a37fb0";
export const CALLSIGN = "JBU1897";

/** What the map has of the En-route view now. */
export const STATE = `(() => {
  const g = ${GLOBE};
  if (!g) return null;
  const m = g.map;
  const layer = m.getLayer("en-route-aircraft");
  const credit = document.querySelector(".maplibregl-ctrl-attrib-inner");
  return {
    camera: g.enRouteCamera,
    source: m.getSource("terrain")?.type ?? null,
    terrain: m.getTerrain(),
    layer: layer ? layer.type : null,
    drawn: layer ? layer.implementation.drawnFrames : 0,
    pitch: m.getPitch(),
    credit: credit ? credit.textContent : "",
    pressed: document.querySelector("[role='group'][aria-label='En-route camera'] button[aria-pressed='true']")?.textContent?.trim() ?? null,
  };
})()`;

// A Terrarium tile all at one height: height = R * 256 + G + B / 256 - 32768.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};
function flatTile(heightM, size = 256) {
  const v = heightM + 32768;
  const [r, g, b] = [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)];
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 3);
    for (let x = 0; x < size; x++) raw.set([r, g, b], row + 1 + x * 3);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
/** A flat Terrarium tile 300 m up. */
export const TILE = flatTile(300);

/**
 * Answers the page's terrain tiles with the flat tile, so a run needs no network for them, and lists each one
 * asked for: its URL and how the browser asked (Playwright's resource type: "fetch" is a connect-src request,
 * "image" an img-src one). A request the page's Content-Security-Policy blocks never reaches the route, so a
 * tile asked for here is one the policy let through.
 */
export async function flatTerrain(page) {
  const asked = [];
  await page.route("**/elevation-tiles-prod/terrarium/**", (r) => {
    asked.push({ url: r.request().url(), type: r.request().resourceType() });
    return r.fulfill({ status: 200, contentType: "image/png", body: TILE, headers: { "access-control-allow-origin": "*" } });
  });
  return asked;
}
