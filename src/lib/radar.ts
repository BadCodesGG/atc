/**
 * The weather radar layer's data: RainViewer's free Weather Maps API
 * (https://www.rainviewer.com/api/weather-maps-api.html). Its terms, read on 2026-10-01:
 *
 * - Free with no key for personal, educational and small community use, which a non-commercial
 *   portfolio site is; no SLA, so a missing frame is an ordinary state, not an error to surface.
 * - The credit "Weather data by RainViewer", with a link to rainviewer.com, must be visible in the app.
 * - No hard rate limits, but cache and do not hammer: the index is read when the layer is on, every
 *   five minutes (the radar moves in ten-minute steps), and tiles come straight from the tile host.
 * - Tiles may be recoloured (the layer is tinted per theme), and go to zoom 7 at most.
 * - The `host` and `path` in the index are used as given, which is why they are checked to be
 *   RainViewer's before a URL is built from them.
 */

export const RADAR_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
/** The credit the terms ask for, shown while the layer is on. */
export const RADAR_CREDIT = { text: "Weather data by RainViewer", href: "https://www.rainviewer.com/" };
/** The finest zoom the tiles exist at; the map stretches them beyond it. */
export const RADAR_MAX_ZOOM = 7;
/** A frame older than this, seconds, is not shown as the weather now. */
export const RADAR_STALE_S = 45 * 60;

const READ_MS = 5 * 60_000;
const RETRY_MS = 30_000;

/** When the index is read again, ms: soon while there is no frame to show, else every five minutes. */
export function nextRadarRead(haveFrame: boolean): number {
  return haveFrame ? READ_MS : RETRY_MS;
}

export interface RadarFrame {
  /** UTC seconds the frame was made. */
  time: number;
  /** A tile URL template for a raster source. */
  tiles: string;
}

const HOST = /^https:\/\/([a-z0-9-]+\.)*rainviewer\.com$/;
const PATH = /^\/v2\/radar\/[A-Za-z0-9]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The newest frame of the index at `now` (UTC seconds), as a tile URL: 256 px tiles in colour scheme 2
 * (Universal Blue, the only one the API offers), smoothed, without snow colours. Null when there is no
 * frame, it is stale, or the index is not RainViewer's.
 */
export function parseRadarIndex(json: unknown, now: number): RadarFrame | null {
  if (!isRecord(json) || typeof json.host !== "string" || !HOST.test(json.host)) return null;
  const past = isRecord(json.radar) && Array.isArray(json.radar.past) ? (json.radar.past as unknown[]) : [];
  let newest: { time: number; path: string } | null = null;
  for (const frame of past) {
    if (!isRecord(frame) || typeof frame.time !== "number" || typeof frame.path !== "string" || !PATH.test(frame.path)) continue;
    if (!newest || frame.time > newest.time) newest = { time: frame.time, path: frame.path };
  }
  if (!newest || now - newest.time > RADAR_STALE_S) return null;
  return { time: newest.time, tiles: `${json.host}${newest.path}/256/{z}/{x}/{y}/2/1_0.png` };
}

/** How old a frame is at `now` (UTC seconds): "just now", "6 min ago", "1 h 5 min ago". Age, not a clock time: the viewer's zone is not the airport's. */
export function radarAge(frameTime: number, now: number): string {
  const min = Math.max(0, Math.floor((now - frameTime) / 60));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)} h ${min % 60} min ago`;
}
