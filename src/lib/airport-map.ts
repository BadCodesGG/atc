/**
 * Turns one raw Overpass response (`out geom;`) into the compact ground-geometry file the renderer
 * loads. Pure: no network, no fs. The same file runs under `node` (scripts/airports.mjs relies on
 * Node's type stripping), so it sticks to erasable TypeScript and imports only types.
 *
 * Every coordinate is metres east/north of the airport reference point, rounded to 0.1 m, using the
 * projection in geo.ts (copied below because a Node ESM import of "./geo" would not resolve; the
 * test suite checks the two agree). Rings are closed without repeating the first point, outer
 * counter-clockwise first, holes clockwise.
 */

import type { Airport } from "./airports";

export type Point = [number, number];
export type Ring = Point[];

export interface RunwayEnd {
  ref: string;
  x: number;
  y: number;
}

export interface Runway {
  /** Zero-padded "08L/26R", or whatever the mapper wrote when it is not a pair of designators. */
  ref: string | null;
  width: number;
  surface: string | null;
  /** Runs from ends[0] to ends[1] when the ends are known. */
  centerline: Point[];
  ends: RunwayEnd[];
}

export interface Taxiway {
  ref: string | null;
  width: number;
  kind: "taxiway" | "taxilane";
  line: Point[];
}

export interface Apron {
  /** Outer ring first, then holes. Area-mapped taxiways are filed here too: they are paved area. */
  rings: Ring[];
}

export interface Terminal {
  name: string | null;
  rings: Ring[];
  height: number;
}

export interface Building {
  rings: Ring[];
  height: number;
}

export interface Gate {
  ref: string | null;
  x: number;
  y: number;
}

export interface Stand {
  ref: string | null;
  x: number;
  y: number;
  /** Degrees clockwise from true north the aircraft faces, from the way's direction or a `direction` tag. */
  headingDeg: number | null;
}

export interface HoldingPosition {
  ref: string | null;
  point?: Point;
  line?: Point[];
}

export interface Tower {
  x: number;
  y: number;
  height: number;
}

export interface NavAid {
  kind: string;
  ref: string | null;
  x: number;
  y: number;
}

export interface AirportMap {
  code: Airport["code"];
  source: "OpenStreetMap contributors (ODbL)";
  /** YYYY-MM-DD. */
  generated: string;
  origin: { latitude: number; longitude: number };
  /** The aerodrome outline: outer ring first, then holes. Empty when OSM has no area for it. */
  boundary: Ring[];
  runways: Runway[];
  taxiways: Taxiway[];
  aprons: Apron[];
  terminals: Terminal[];
  buildings: Building[];
  gates: Gate[];
  stands: Stand[];
  holdingPositions: HoldingPosition[];
  towers: Tower[];
  windsocks: Point[];
  navaids: NavAid[];
}

export interface OsmPoint {
  lat: number;
  lon: number;
}

export interface OsmMember {
  type: "node" | "way" | "relation";
  ref: number;
  role: string;
  geometry?: OsmPoint[];
  lat?: number;
  lon?: number;
}

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: OsmPoint[];
  members?: OsmMember[];
}

export interface OverpassJson {
  elements: OsmElement[];
}

export interface BuildOptions {
  /** Drop plain buildings whose footprint is below this many square metres. Default keeps all. */
  minBuildingArea?: number;
  /** Stamp for `generated`; defaults to today (UTC). */
  generated?: string;
}

export const DEFAULTS = {
  runwayWidth: 45,
  longRunwayWidth: 60,
  /** A runway this long (metres) or longer gets longRunwayWidth. */
  longRunwayLength: 3000,
  taxiwayWidth: 23,
  taxilaneWidth: 15,
  buildingHeight: 8,
  terminalHeight: 18,
  towerHeight: 40,
  metresPerLevel: 4,
  /** Douglas-Peucker tolerance, metres. */
  simplify: 0.4,
} as const;

/** Tags mappers use for a control tower; man_made=tower alone also covers lighting masts, which are not towers here. */
const TOWER_TYPES = new Set(["observation", "airport_control"]);
const TOWER_SERVICES = new Set(["air_traffic_control", "aircraft_control"]);

const R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Same formula as toLocal in geo.ts (azimuthal equidistant about the ARP). */
export function project(origin: { latitude: number; longitude: number }, latitude: number, longitude: number): Point {
  const p0 = origin.latitude * RAD;
  const p = latitude * RAD;
  const dl = (longitude - origin.longitude) * RAD;
  const cosc = Math.sin(p0) * Math.sin(p) + Math.cos(p0) * Math.cos(p) * Math.cos(dl);
  const c = Math.acos(Math.min(1, Math.max(-1, cosc)));
  const k = c < 1e-12 ? 1 : c / Math.sin(c);
  return [R * k * Math.cos(p) * Math.sin(dl), R * k * (Math.cos(p0) * Math.sin(p) - Math.sin(p0) * Math.cos(p) * Math.cos(dl))];
}

/** Rounds to 0.1 m; the trailing + 0 turns -0 into 0. */
const round1 = (v: number) => Math.round(v * 10) / 10 + 0;
const samePoint = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];

/** Signed area, positive when the ring runs counter-clockwise (x east, y north). */
export function signedArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function pointInRing(pt: Point, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas-Peucker on an open polyline; keeps both endpoints. Iterative, so long runways cannot overflow the stack. */
export function simplifyLine(line: Point[], tolerance: number): Point[] {
  if (line.length <= 2) return line.slice();
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, line.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = distToSegment(line[i], line[lo], line[hi]);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** Simplifies an open ring (no repeated closing point) by splitting it at the point farthest from its start. */
export function simplifyRing(ring: Ring, tolerance: number): Ring {
  if (ring.length <= 3) return ring.slice();
  let far = 1;
  let farD = -1;
  for (let i = 1; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const first = simplifyLine(ring.slice(0, far + 1), tolerance);
  const second = simplifyLine([...ring.slice(far), ring[0]], tolerance);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

/** Metres from a tag such as "45", "45 m", "150 ft" or `150'`. Null when absent or unreadable. */
export function parseLength(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m|ft|feet|'|km)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  const unit = (m[2] ?? "m").toLowerCase();
  const metres = unit === "ft" || unit === "feet" || unit === "'" ? n * 0.3048 : unit === "km" ? n * 1000 : n;
  return metres > 0 ? metres : null;
}

function heightOf(tags: Record<string, string>, fallback: number): number {
  const h = parseLength(tags.height);
  if (h) return round1(h);
  const levels = parseFloat(tags["building:levels"]);
  if (levels > 0) return round1(levels * DEFAULTS.metresPerLevel);
  return fallback;
}

const BOUNDARY_SLACK_M = 300;
const MARKING_MAX_M = 300;
const RUNWAY_MARKINGS = new Set(["displaced_threshold", "blast_pad", "stopway"]);

/** Runway ways whose ends are this close (metres) are one runway: OSM draws them with separate nodes a few decimetres apart. */
const RUNWAY_JOIN_M = 1;

/**
 * Joins open segments end to end (reversing where needed) until nothing more touches. Ends count as
 * touching when they are within `tolerance` metres: OSM runways are often drawn as separate nodes a
 * few decimetres apart, which the exact comparison used for everything else leaves unjoined.
 */
export function stitch(segments: Point[][], tolerance = 0): Point[][] {
  const touch = (a: Point, b: Point) => (tolerance > 0 ? Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance : samePoint(a, b));
  const pool = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  const chains: Point[][] = [];
  while (pool.length) {
    let chain = pool.shift()!;
    for (;;) {
      if (chain.length >= 4 && touch(chain[0], chain[chain.length - 1])) break;
      const head = chain[0];
      const tail = chain[chain.length - 1];
      const i = pool.findIndex((s) => [head, tail].some((e) => touch(e, s[0]) || touch(e, s[s.length - 1])));
      if (i < 0) break;
      const [s] = pool.splice(i, 1);
      if (touch(tail, s[0])) chain = chain.concat(s.slice(1));
      else if (touch(tail, s[s.length - 1])) chain = chain.concat(s.slice(0, -1).reverse());
      else if (touch(head, s[s.length - 1])) chain = s.concat(chain.slice(1));
      else chain = s.slice().reverse().concat(chain.slice(1));
    }
    chains.push(chain);
  }
  return chains;
}

const isClosed = (pts: Point[]) => pts.length >= 4 && samePoint(pts[0], pts[pts.length - 1]);

/** Smallest degrees between two bearings. */
const angleBetween = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

const bearing = (from: Point, to: Point) => ((Math.atan2(to[0] - from[0], to[1] - from[1]) / RAD) + 360) % 360;

function lineLength(line: Point[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return s;
}

const pad2 = (n: string) => n.padStart(2, "0");

/** "8L/26R" becomes ["08L", "26R"]; null for anything that is not a pair of runway designators. */
export function splitRunwayRef(ref: string | undefined): [string, string] | null {
  const m = /^\s*(\d{1,2})([LRC]?)\s*[/;-]\s*(\d{1,2})([LRC]?)\s*$/i.exec(ref ?? "");
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  if (a < 1 || a > 36 || b < 1 || b > 36) return null;
  return [pad2(m[1]) + m[2].toUpperCase(), pad2(m[3]) + m[4].toUpperCase()];
}

export function buildAirportMap(json: OverpassJson, airport: Airport, options: BuildOptions = {}): AirportMap {
  const origin = { latitude: airport.latitude, longitude: airport.longitude };
  const minBuildingArea = options.minBuildingArea ?? 0;
  const proj = (p: OsmPoint): Point => project(origin, p.lat, p.lon);
  const tol = DEFAULTS.simplify;

  const cleanLine = (raw: Point[]): Point[] | null => {
    const out: Point[] = [];
    for (const p of simplifyLine(raw, tol)) {
      const q: Point = [round1(p[0]), round1(p[1])];
      if (!out.length || !samePoint(out[out.length - 1], q)) out.push(q);
    }
    return out.length >= 2 ? out : null;
  };

  /** Simplify, round, drop repeats, then wind. Null when the outer ring collapses. */
  const cleanRings = (rings: Ring[]): Ring[] | null => {
    const out: Ring[] = [];
    for (let r = 0; r < rings.length; r++) {
      const open = rings[r].length > 1 && samePoint(rings[r][0], rings[r][rings[r].length - 1]) ? rings[r].slice(0, -1) : rings[r];
      const ring: Ring = [];
      for (const p of simplifyRing(open, tol)) {
        const q: Point = [round1(p[0]), round1(p[1])];
        if (!ring.length || !samePoint(ring[ring.length - 1], q)) ring.push(q);
      }
      if (ring.length > 1 && samePoint(ring[0], ring[ring.length - 1])) ring.pop();
      const area = ring.length >= 3 ? signedArea(ring) : 0;
      if (area === 0) {
        if (r === 0) return null;
        continue;
      }
      if (r === 0 ? area < 0 : area > 0) ring.reverse();
      out.push(ring);
    }
    return out;
  };

  const polygonArea = (rings: Ring[]) => Math.abs(signedArea(rings[0])) - rings.slice(1).reduce((s, h) => s + Math.abs(signedArea(h)), 0);

  const wayPoints = (el: OsmElement): Point[] => (el.geometry ?? []).map(proj);

  /** Every polygon an element describes, each as [outer, ...holes] in local metres (unsimplified). */
  const polygonsOf = (el: OsmElement): Ring[][] => {
    if (el.type === "way") {
      const pts = wayPoints(el);
      return isClosed(pts) ? [[pts.slice(0, -1)]] : [];
    }
    if (el.type !== "relation" || !["multipolygon", "boundary"].includes(el.tags?.type ?? "")) return [];
    const side = (inner: boolean) =>
      stitch((el.members ?? []).filter((m) => m.type === "way" && (m.role === "inner") === inner && m.geometry?.length).map((m) => m.geometry!.map(proj)))
        .filter(isClosed)
        .map((r) => r.slice(0, -1));
    const outers = side(false);
    const holes = outers.map(() => [] as Ring[]);
    for (const inner of side(true)) {
      let best = -1;
      let bestVotes = 0;
      outers.forEach((outer, i) => {
        const votes = inner.filter((p) => pointInRing(p, outer)).length;
        if (votes > bestVotes || (votes === bestVotes && votes > 0 && Math.abs(signedArea(outer)) < Math.abs(signedArea(outers[best])))) {
          best = i;
          bestVotes = votes;
        }
      });
      if (best >= 0) holes[best].push(inner);
    }
    return outers.map((outer, i) => [outer, ...holes[i]]);
  };

  /** A representative point: the node itself, or the mean of the first polygon/line vertices. */
  const anchorOf = (el: OsmElement): Point | null => {
    if (el.type === "node") return el.lat === undefined || el.lon === undefined ? null : proj({ lat: el.lat, lon: el.lon });
    const pts = el.type === "way" ? wayPoints(el) : (polygonsOf(el)[0]?.[0] ?? []);
    if (!pts.length) return null;
    const ring = isClosed(pts) ? pts.slice(0, -1) : pts;
    return [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  };

  // The aerodrome outline first: a matching ICAO wins, then whichever contains the ARP, then the largest.
  let boundary: Ring[] = [];
  {
    const candidates: Array<{ icao: boolean; rings: Ring[] }> = [];
    for (const el of json.elements) {
      if (el.tags?.aeroway !== "aerodrome") continue;
      for (const rings of polygonsOf(el)) candidates.push({ icao: el.tags.icao === airport.icao, rings });
    }
    const arp: Point = [0, 0];
    const score = (c: { icao: boolean; rings: Ring[] }) => (c.icao ? 2 : 0) + (pointInRing(arp, c.rings[0]) ? 1 : 0);
    candidates.sort((a, b) => score(b) - score(a) || Math.abs(signedArea(b.rings[0])) - Math.abs(signedArea(a.rings[0])));
    if (candidates.length) boundary = cleanRings(candidates[0].rings) ?? [];
  }
  const insideBoundary = (p: Point) => !boundary.length || pointInRing(p, boundary[0]);

  const runwaySegments = new Map<string, { tags: Record<string, string>; segments: Point[][] }>();
  const taxiways: Taxiway[] = [];
  const aprons: Apron[] = [];
  const terminals: Terminal[] = [];
  const buildings: Building[] = [];
  const gates: Gate[] = [];
  const stands: Stand[] = [];
  const holdingPositions: HoldingPosition[] = [];
  const towers: Tower[] = [];
  const windsocks: Point[] = [];
  const navaids: NavAid[] = [];

  const r1 = (p: Point): Point => [round1(p[0]), round1(p[1])];
  const refOf = (tags: Record<string, string>) => tags.ref ?? null;

  for (const el of json.elements) {
    const tags = el.tags ?? {};
    const aeroway = tags.aeroway;
    const isTower = aeroway === "tower" || aeroway === "control_tower" || (tags.man_made === "tower" && (TOWER_TYPES.has(tags["tower:type"]) || TOWER_SERVICES.has(tags.service)));

    if (isTower) {
      const a = anchorOf(el);
      if (a && (aeroway || insideBoundary(a))) towers.push({ x: round1(a[0]), y: round1(a[1]), height: heightOf(tags, DEFAULTS.towerHeight) });
      continue;
    }

    switch (aeroway) {
      case "runway": {
        // Runways are lines; segments sharing a ref are joined below. Area-mapped ones are not drawable as a centerline.
        if (el.type !== "way" || tags.area === "yes") break;
        const pts = wayPoints(el);
        if (pts.length < 2) break;
        // A short stretch tagged as a displaced threshold or blast pad is a marking, not a runway of its own. Long ones are
        // kept: some mappers tag the whole runway that way (LAS does).
        if (RUNWAY_MARKINGS.has(tags.runway) && lineLength(pts) < MARKING_MAX_M) break;
        // "06R/24L" and "24L/06R" are the same runway; a way with no ref gets a key of its own and is attached below.
        const designators = splitRunwayRef(tags.ref);
        const key = designators ? [...designators].sort().join("/") : (tags.ref ?? `way/${el.id}`);
        const entry = runwaySegments.get(key) ?? { tags, segments: [] };
        entry.segments.push(pts);
        runwaySegments.set(key, entry);
        break;
      }
      case "taxiway":
      case "taxilane": {
        if (el.type === "relation" || tags.area === "yes") {
          for (const poly of polygonsOf(el)) {
            const rings = cleanRings(poly);
            if (rings) aprons.push({ rings });
          }
          break;
        }
        const pts = wayPoints(el);
        const line = el.type === "way" && pts.length >= 2 ? cleanLine(pts) : null;
        if (!line) break;
        const kind = aeroway;
        taxiways.push({
          ref: refOf(tags),
          width: round1(parseLength(tags.width) ?? (kind === "taxilane" ? DEFAULTS.taxilaneWidth : DEFAULTS.taxiwayWidth)),
          kind,
          line,
        });
        break;
      }
      case "apron":
        for (const poly of polygonsOf(el)) {
          const rings = cleanRings(poly);
          if (rings) aprons.push({ rings });
        }
        break;
      case "terminal":
        for (const poly of polygonsOf(el)) {
          const rings = cleanRings(poly);
          if (rings) terminals.push({ name: tags.name ?? null, rings, height: heightOf(tags, DEFAULTS.terminalHeight) });
        }
        break;
      case "gate": {
        const a = anchorOf(el);
        if (a) gates.push({ ref: refOf(tags), x: round1(a[0]), y: round1(a[1]) });
        break;
      }
      case "parking_position": {
        if (el.type === "node") {
          const a = anchorOf(el);
          const dir = Number(tags.direction);
          if (a) stands.push({ ref: refOf(tags), x: round1(a[0]), y: round1(a[1]), headingDeg: tags.direction !== undefined && Number.isFinite(dir) ? Math.round(((dir % 360) + 360) % 360) : null });
        } else if (el.type === "way") {
          // The way is the aircraft's path into the stand: it stops at the last node, facing along the way.
          const pts = wayPoints(el);
          if (isClosed(pts)) {
            const a = anchorOf(el)!;
            stands.push({ ref: refOf(tags), x: round1(a[0]), y: round1(a[1]), headingDeg: null });
          } else if (pts.length >= 2) {
            const last = pts[pts.length - 1];
            stands.push({ ref: refOf(tags), x: round1(last[0]), y: round1(last[1]), headingDeg: lineLength(pts) >= 1 ? Math.round(bearing(pts[0], last)) % 360 : null });
          }
        }
        break;
      }
      case "holding_position": {
        if (el.type === "node") {
          const a = anchorOf(el);
          if (a) holdingPositions.push({ ref: refOf(tags), point: r1(a) });
        } else if (el.type === "way") {
          const line = cleanLine(wayPoints(el));
          if (line) holdingPositions.push({ ref: refOf(tags), line });
        }
        break;
      }
      case "windsock": {
        const a = anchorOf(el);
        if (a) windsocks.push(r1(a));
        break;
      }
      case "navigationaid": {
        const a = anchorOf(el);
        if (a) navaids.push({ kind: tags.navigationaid ?? "unknown", ref: refOf(tags), x: round1(a[0]), y: round1(a[1]) });
        break;
      }
      default:
        break;
    }

    if (aeroway === "terminal" || aeroway === "apron" || aeroway === "taxiway" || aeroway === "taxilane") continue;

    // Everything else that is a building: hangars, plain buildings, and terminals only tagged building=terminal.
    const isBuilding = (tags.building !== undefined && tags.building !== "no") || aeroway === "hangar";
    if (!isBuilding) continue;
    for (const poly of polygonsOf(el)) {
      const rings = cleanRings(poly);
      if (!rings) continue;
      if (tags.building === "terminal") {
        terminals.push({ name: tags.name ?? null, rings, height: heightOf(tags, DEFAULTS.terminalHeight) });
      } else if (polygonArea(rings) >= minBuildingArea) {
        buildings.push({ rings, height: heightOf(tags, DEFAULTS.buildingHeight) });
      }
    }
  }

  // A runway way with no ref is usually one stretch of a runway whose other ways carry it: join it to the one it touches.
  const endsOf = (segments: Point[][]) => segments.flatMap((seg) => [seg[0], seg[seg.length - 1]]);
  for (const [key, entry] of [...runwaySegments]) {
    if (!key.startsWith("way/")) continue;
    const mine = endsOf(entry.segments);
    const host = [...runwaySegments].find(
      ([k, other]) => !k.startsWith("way/") && endsOf(other.segments).some((e) => mine.some((m) => Math.hypot(e[0] - m[0], e[1] - m[1]) <= RUNWAY_JOIN_M)),
    );
    if (!host) continue;
    host[1].segments.push(...entry.segments);
    runwaySegments.delete(key);
  }

  const runways: Runway[] = [];
  for (const { tags, segments } of runwaySegments.values()) {
    for (const chain of stitch(segments, RUNWAY_JOIN_M)) {
      // A neighbouring field inside the query box (a naval air station, a heliport pad) is not this airport's runway.
      const mid: Point = [(chain[0][0] + chain[chain.length - 1][0]) / 2, (chain[0][1] + chain[chain.length - 1][1]) / 2];
      if (!insideBoundary(mid)) continue;
      const centerline = cleanLine(chain);
      if (!centerline) continue;
      const length = lineLength(chain);
      const designators = splitRunwayRef(tags.ref)?.sort() as [string, string] | undefined;
      const runway: Runway = {
        ref: designators ? designators.join("/") : (tags.ref ?? null),
        width: round1(parseLength(tags.width) ?? (length >= DEFAULTS.longRunwayLength ? DEFAULTS.longRunwayWidth : DEFAULTS.runwayWidth)),
        surface: tags.surface ?? null,
        centerline,
        ends: [],
      };
      if (designators) {
        // Runway NN points toward NN*10 degrees, so its threshold is the end you start from when heading that way.
        const heading = bearing(centerline[0], centerline[centerline.length - 1]);
        const firstIsA = angleBetween(heading, parseInt(designators[0], 10) * 10) <= angleBetween(heading, parseInt(designators[1], 10) * 10);
        if (!firstIsA) runway.centerline.reverse();
        const [a, b] = [runway.centerline[0], runway.centerline[runway.centerline.length - 1]];
        runway.ends = [
          { ref: designators[0], x: a[0], y: a[1] },
          { ref: designators[1], x: b[0], y: b[1] },
        ];
      }
      runways.push(runway);
    }
  }
  runways.sort((p, q) => (p.ref ?? "").localeCompare(q.ref ?? ""));

  // Paving that belongs to a neighbouring field (a naval air station's taxiways) can sit inside the query box. Keep a
  // feature when any vertex is within BOUNDARY_SLACK_M of the aerodrome outline's bounding box; with no outline, keep all.
  const bounds = boundary.length ? boundary[0].reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]) : null;
  const nearAirport = (pts: Point[]) =>
    !bounds || pts.some(([x, y]) => x >= bounds[0] - BOUNDARY_SLACK_M && x <= bounds[2] + BOUNDARY_SLACK_M && y >= bounds[1] - BOUNDARY_SLACK_M && y <= bounds[3] + BOUNDARY_SLACK_M);

  return {
    code: airport.code,
    source: "OpenStreetMap contributors (ODbL)",
    generated: options.generated ?? new Date().toISOString().slice(0, 10),
    origin,
    boundary,
    runways,
    taxiways: taxiways.filter((t) => nearAirport(t.line)),
    aprons: aprons.filter((a) => nearAirport(a.rings[0])),
    terminals: terminals.filter((t) => nearAirport(t.rings[0])),
    buildings,
    gates,
    stands,
    holdingPositions,
    towers,
    windsocks,
    navaids,
  };
}
