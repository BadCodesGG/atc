import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchStatus } from "@/lib/faa-status";
import { GET } from "./route";

vi.mock("@/lib/faa-status", () => ({ fetchStatus: vi.fn() }));

const status = vi.mocked(fetchStatus);
const call = (query = "") => GET(new Request(`http://localhost/api/status${query}`));

describe("GET /api/status", () => {
  beforeEach(() => {
    status.mockReset();
  });

  it("redirects every query string to the bare address, permanently, without a read, and answers the bare address itself", async () => {
    status.mockResolvedValue({ airports: {} } as Awaited<ReturnType<typeof fetchStatus>>);
    for (const query of ["?x=1", "?x=" + "a".repeat(40), "?a=1&a=2"]) {
      const res = await call(query);
      expect(res.status, query).toBe(308);
      expect(res.headers.get("Location"), query).toBe("/api/status");
      expect(res.headers.get("Cache-Control"), query).toBe("public, max-age=3600, s-maxage=86400");
    }
    expect(status).not.toHaveBeenCalled();
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=60, stale-while-revalidate=120");
  });
});
