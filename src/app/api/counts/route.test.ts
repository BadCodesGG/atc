import { beforeEach, describe, expect, it, vi } from "vitest";
import { regionFeed } from "@/lib/region-feed";
import { UpstreamBusyError } from "@/lib/upstream";
import { GET as route } from "./route";

vi.mock("@/lib/region-feed", () => ({ regionFeed: { counts: vi.fn() } }));

const counts = vi.mocked(regionFeed.counts);
const GET = (path = "/api/counts") => route(new Request(`http://localhost${path}`));

describe("GET /api/counts", () => {
  beforeEach(() => {
    counts.mockReset();
  });

  it("is kept by the CDN for a minute and served stale for five more", async () => {
    counts.mockResolvedValue({ atl: { total: 3, ground: 1 } });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=300");
    expect((await res.json()).counts).toEqual({ atl: { total: 3, ground: 1 } });
  });

  it("redirects every query string to the bare address, permanently, without a read, and answers the bare address itself", async () => {
    counts.mockResolvedValue({ atl: { total: 3, ground: 1 } });
    for (const path of ["/api/counts?x=1", "/api/counts?x=" + "a".repeat(40), "/api/counts?a=1&a=2"]) {
      const res = await GET(path);
      expect(res.status, path).toBe(308);
      expect(res.headers.get("Location"), path).toBe("/api/counts");
      expect(res.headers.get("Cache-Control"), path).toBe("public, max-age=3600, s-maxage=86400");
    }
    expect(counts).not.toHaveBeenCalled();
    expect((await GET("/api/counts")).status).toBe(200);
    expect(counts).toHaveBeenCalledTimes(1);
  });

  it("answers 503 with a Retry-After, cached nowhere, when the server's cap on upstream requests leaves it with no count", async () => {
    counts.mockRejectedValue(new UpstreamBusyError(1));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("answers 502, briefly cached, only when it has no count at all", async () => {
    counts.mockResolvedValue({});
    const res = await GET();
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=10");
  });
});
