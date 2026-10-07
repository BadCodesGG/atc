/**
 * The headers every response carries (next.config.ts): a Content-Security-Policy, and the two that go
 * with it. Written out by origin so that adding a third party to the app is a visible change here.
 *
 * - Scripts: 'unsafe-inline', because the App Router puts its bootstrap in inline scripts and a nonce
 *   would make every page dynamic. 'unsafe-eval' only under `next dev`, where React needs it.
 * - frame-ancestors: this site and the portfolio at badcodes.dev, which embeds it (www.badcodes.dev
 *   redirects to the apex, so the apex is the one origin). Not X-Frame-Options, which cannot name an
 *   origin and would block the embed.
 * - Everything the browser itself fetches is named: OpenFreeMap (vector tiles, glyphs), the USGS
 *   satellite imagery, RainViewer (the radar index and its tiles, on a host the index names, always a
 *   rainviewer.com subdomain: radar.ts checks it) and Planespotters (the photo API, and the photos on
 *   plnspttrs.net). adsb.lol, adsb.fi, adsbdb, the FAA and aviationweather.gov are read by the server.
 * - MapLibre runs its tile workers from /maplibre (same origin) and may hand them blobs; its canvas
 *   textures and the aircraft icons are data: and blob: images.
 */

const OPENFREEMAP = "https://tiles.openfreemap.org";
const USGS = "https://basemap.nationalmap.gov";
const RAINVIEWER = ["https://api.rainviewer.com", "https://*.rainviewer.com"];
const PLANESPOTTERS_API = "https://api.planespotters.net";
const PLANESPOTTERS_IMAGES = ["https://*.plnspttrs.net", "https://*.planespotters.net"];

/** Sites allowed to put the app in a frame. */
export const FRAME_ANCESTORS = ["'self'", "https://badcodes.dev"];

export function contentSecurityPolicy({ dev = false }: { dev?: boolean } = {}): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", OPENFREEMAP, USGS, ...RAINVIEWER, ...PLANESPOTTERS_IMAGES],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", OPENFREEMAP, USGS, ...RAINVIEWER, PLANESPOTTERS_API],
    "worker-src": ["'self'", "blob:"],
    "frame-ancestors": FRAME_ANCESTORS,
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ");
}

/** The `headers` entry for next.config.ts. */
export function securityHeaders({ dev = false }: { dev?: boolean } = {}): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy({ dev }) },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  ];
}
