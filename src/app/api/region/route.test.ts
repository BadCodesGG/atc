import { beforeEach, describe, expect, it, vi } from "vitest";
import { cellsCovering, regionPath } from "@/lib/region";
import { regionFeed } from "@/lib/region-feed";
import { UpstreamBusyError } from "@/lib/upstream";
import { GET } from "./route";

vi.mock("@/lib/region-feed", () => ({ regionFeed: { read: vi.fn() } }));

const read = vi.mocked(regionFeed.read);
const snapshot = { cell: { latitude: 32, longitude: -84 }, time: 1_790_794_144, aircraft: [] };
const at = (path: string) => GET(new Request(`http://localhost${path}`));
/** Atlanta's cell, by the address the map asks for it. */
const ask = () => at("/api/region?lat=32&lon=-84");

describe("GET /api/region", () => {
  // Braces: a function a hook returns is run as its clean-up, and the mock is one.
  beforeEach(() => {
    read.mockReset();
  });

  it("answers 400 without asking upstream when lat or lon is not a decimal number in range, and never lets a cache keep it", async () => {
    for (const q of ["", "?lat=33.6", "?lat=abc&lon=1", "?lat=95&lon=1", "?lat=1&lon=0x10", "?lat=%20&lon=1"]) {
      const res = await at(`/api/region${q}`);
      expect(res.status, q).toBe(400);
      expect(res.headers.get("Cache-Control"), q).toBe("no-store");
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("lets the CDN keep a fresh cell for the map's ten-second poll, so one cell costs one read per ten seconds", async () => {
    read.mockResolvedValue({ snapshot, stale: false });
    expect((await ask()).headers.get("Cache-Control")).toBe("public, s-maxage=10, stale-while-revalidate=10");
  });

  it("keeps a stale answer and a failure briefly", async () => {
    read.mockResolvedValue({ snapshot, stale: true, ageS: 20 });
    const stale = await ask();
    expect(stale.headers.get("Cache-Control")).toBe("public, s-maxage=5");
    expect(await stale.json()).toMatchObject({ stale: true, ageS: 20 });
    read.mockResolvedValue(null);
    const failed = await ask();
    expect(failed.status).toBe(502);
    expect(failed.headers.get("Cache-Control")).toBe("public, s-maxage=10");
  });

  it("answers 503 with a Retry-After, cached nowhere, when the server's cap on upstream requests is spent", async () => {
    read.mockRejectedValue(new UpstreamBusyError(2));
    const res = await ask();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  describe("one address per cell", () => {
    it("redirects every other spelling of a valid cell to the canonical address, permanently, without a read", async () => {
      read.mockResolvedValue({ snapshot, stale: false });
      for (const q of ["lat=33.6&lon=-84.4", "lat=32.0&lon=-84", "lat=32&lon=-84&x=1", "lon=-84&lat=32", "lat=32&lon=-84&lat=33", "lat=32.0001&lon=-84", "lat=32&lon=-84&", "lat=%33%32&lon=-84"]) {
        const res = await at(`/api/region?${q}`);
        expect(res.status, q).toBe(308);
        expect(res.headers.get("Location"), q).toBe("/api/region?lat=32&lon=-84");
        expect(res.headers.get("Cache-Control"), q).toMatch(/s-maxage=\d+/);
      }
      expect(read).not.toHaveBeenCalled();
    });

    it("redirects the cells with a sign, a zero or a clamped pole to the one way the map spells them", async () => {
      expect((await at("/api/region?lat=-0&lon=0")).headers.get("Location")).toBe("/api/region?lat=0&lon=0");
      expect((await at("/api/region?lat=90&lon=180")).headers.get("Location")).toBe("/api/region?lat=88&lon=-180");
    });

    it("serves the address the map itself asks for every cell it can ask for, with no redirect", async () => {
      read.mockResolvedValue({ snapshot, stale: false });
      const cells = cellsCovering({ west: -180, south: -90, east: 179, north: 90 });
      expect(cells.length).toBeGreaterThan(4000);
      for (const cell of cells) {
        const res = await at(regionPath(cell));
        if (res.status !== 200) throw new Error(`${regionPath(cell)} answered ${res.status}`);
      }
    });
  });
});
