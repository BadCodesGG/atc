import { beforeEach, describe, expect, it, vi } from "vitest";
import { trafficFeed } from "@/lib/traffic-feed";
import { UpstreamBusyError } from "@/lib/upstream";
import { GET } from "./route";

vi.mock("@/lib/traffic-feed", () => ({ trafficFeed: { read: vi.fn() } }));
vi.mock("next/server", () => ({ after: vi.fn() }));

const read = vi.mocked(trafficFeed.read);
const call = (airport: string, query = "") => GET(new Request(`http://localhost/api/traffic/${airport}${query}`), { params: Promise.resolve({ airport }) } as Parameters<typeof GET>[1]);

describe("GET /api/traffic/[airport]", () => {
  beforeEach(() => {
    read.mockReset();
  });

  it("answers 404, cached nowhere, for an airport that is not listed, without a read", async () => {
    const res = await call("lhr");
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(read).not.toHaveBeenCalled();
  });

  it("redirects a query string to the bare address, permanently, without a read, and leaves an unlisted airport a 404", async () => {
    for (const query of ["?x=1", "?x=" + "a".repeat(40), "?a=1&a=2"]) {
      const res = await call("atl", query);
      expect(res.status, query).toBe(308);
      expect(res.headers.get("Location"), query).toBe("/api/traffic/atl");
      expect(res.headers.get("Cache-Control"), query).toBe("public, max-age=3600, s-maxage=86400");
    }
    expect((await call("ATL")).status).toBe(404);
    expect((await call("lhr", "?x=1")).status).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });

  it("answers 503 with a Retry-After, cached nowhere, when the server's cap on upstream requests is spent", async () => {
    read.mockRejectedValue(new UpstreamBusyError(2));
    const res = await call("atl");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("2");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
