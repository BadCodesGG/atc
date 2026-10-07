import type { Airport } from "./airports";
import { type AirportCount, type Cell, cellOf, countsNear, fetchRegion, type RegionSnapshot } from "./region";
import { type FeedAnswer, LastGoodFeed } from "./traffic-feed";
import { type Read, upstream, UpstreamBusyError } from "./upstream";

/** Cells one /api/counts request may read from adsb.lol that the feed does not already hold; the rest wait for later requests. */
export const COLD_CELLS_PER_COUNTS = 2;
/**
 * Cells held at once, the one asked about longest ago forgotten first. The cell comes from the request, so
 * left unbounded a loop over the world's 4,050 cells would grow the feed without end; a map view reads a few
 * dozen at most, and the airports' own cells are about a hundred.
 */
export const MAX_CELLS_HELD = 300;
/** A count is shown this long (ms) after the read it came from: the markers move slowly, and the cells are filled in a few at a time. */
export const COUNTS_KEEP_MS = 15 * 60_000;

/**
 * One server instance's reads of the region cells, as the airports' feed reads theirs: each cell is
 * asked of adsb.lol at most once per time to live however many requests want it (a failure is kept as
 * long as a success, so an outage does not turn every request into a retry), the last good answer is
 * served marked stale for up to 90 s when a read fails, and a 429 backs off.
 */
export class RegionFeed {
  private readonly feed: LastGoodFeed<Cell, RegionSnapshot>;
  private readonly now: () => number;
  /** Each airport's latest count and when it was read. */
  private readonly counted = new Map<Airport["code"], { count: AirportCount; at: number }>();
  /** When counts last tried to read each cell, so no cell that keeps failing starves the others. */
  private readonly tried = new Map<string, number>();

  constructor(read: Read = upstream.read, { ttlMs = 4_000, maxKeys = MAX_CELLS_HELD, now = Date.now, log }: { ttlMs?: number; maxKeys?: number; now?: () => number; log?: (line: string) => void } = {}) {
    this.now = now;
    this.feed = new LastGoodFeed({
      fetchSnapshot: (cell, options) => fetchRegion(cell, read, options),
      keyOf: (cell) => `${cell.latitude}/${cell.longitude}`,
      name: "region",
      memoMs: ttlMs,
      maxKeys,
      // Any of the world's 4,050 cells can be asked for, and most are sea: only a cell with aircraft in it is worth keeping.
      worth: (snapshot) => snapshot.aircraft.length > 0,
      now,
      log,
    });
  }

  /** The cell's answer: fresh, or the last good one marked stale; null when there is none recent enough. */
  read(cell: Cell): Promise<FeedAnswer<RegionSnapshot> | null> {
    return this.feed.read(cell);
  }

  /** The cell's aircraft, fresh or the last good, or null. */
  async get(cell: Cell): Promise<RegionSnapshot | null> {
    return (await this.read(cell))?.snapshot ?? null;
  }

  /**
   * Each airport's live count, read off its cell. A request never bursts on adsb.lol: cells the feed
   * already holds are counted without a read, and at most COLD_CELLS_PER_COUNTS others are read, one
   * after another, the ones tried longest ago first. The rest keep the count they last had (up to
   * COUNTS_KEEP_MS) and are filled in by later requests. An airport with no count yet is left out.
   */
  async counts(airports: readonly Airport[]): Promise<Partial<Record<Airport["code"], AirportCount>>> {
    const byCell = new Map<string, { key: string; cell: Cell; airports: Airport[] }>();
    for (const airport of airports) {
      const cell = cellOf(airport);
      const key = `${cell.latitude}/${cell.longitude}`;
      const group = byCell.get(key) ?? { key, cell, airports: [] };
      group.airports.push(airport);
      byCell.set(key, group);
    }
    const cold: { key: string; cell: Cell; airports: Airport[] }[] = [];
    for (const group of byCell.values()) {
      const held = this.feed.peek(group.cell);
      if (held) this.remember(group.airports, held.snapshot);
      else cold.push(group);
    }
    cold.sort((a, b) => (this.tried.get(a.key) ?? -Infinity) - (this.tried.get(b.key) ?? -Infinity));
    let busy: UpstreamBusyError | null = null;
    for (const { key, cell, airports: here } of cold.slice(0, COLD_CELLS_PER_COUNTS)) {
      this.tried.set(key, this.now());
      try {
        const snapshot = await this.get(cell);
        if (snapshot) this.remember(here, snapshot);
      } catch (error) {
        // The server's cap on upstream requests is spent: the rest wait for a later request.
        if (!(error instanceof UpstreamBusyError)) throw error;
        busy = error;
        break;
      }
    }
    const now = this.now();
    const counts: Partial<Record<Airport["code"], AirportCount>> = {};
    for (const { code } of airports) {
      const kept = this.counted.get(code);
      if (kept && now - kept.at <= COUNTS_KEEP_MS) counts[code] = kept.count;
    }
    if (busy && Object.keys(counts).length === 0) throw busy;
    return counts;
  }

  private remember(airports: readonly Airport[], snapshot: RegionSnapshot): void {
    const at = this.now();
    for (const [code, count] of Object.entries(countsNear(airports, snapshot.aircraft))) this.counted.set(code as Airport["code"], { count, at });
  }
}

/** The instance the API routes share. */
export const regionFeed = new RegionFeed();
