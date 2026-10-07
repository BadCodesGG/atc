import { afterEach, describe, expect, it, vi } from "vitest";
import atl from "@/lib/__fixtures__/metar_atl.json";

type Get = (req: Request, ctx: { params: Promise<{ airport: string }> }) => Promise<Response>;

/** A fresh copy of the route (its memo empty), with the upstream answering `answer`. */
async function route(answer: () => Promise<Response>) {
  vi.resetModules();
  const fetch = vi.fn<(url: string) => Promise<Response>>(answer);
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { GET } = (await import("./route")) as unknown as { GET: Get };
  const get = (airport: string, query = "") => GET(new Request(`http://localhost/api/weather/${airport}${query}`), { params: Promise.resolve({ airport }) });
  return { get, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/weather/[airport]", () => {
  it("answers the airport's parsed METAR, read once from aviationweather.gov by its ICAO code, cacheable", async () => {
    const { get, fetch } = await route(async () => Response.json(atl));
    const res = await get("atl");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/^public, s-maxage=\d+, stale-while-revalidate=\d+$/);
    const body = await res.json();
    expect(body).toMatchObject({ station: "KATL", wind: { directionDeg: 100, speedKt: 3 } });
    await get("atl");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("https://aviationweather.gov/api/data/metar?ids=KATL&format=json");
  });

  it("redirects a query string to the bare address, permanently, without asking upstream", async () => {
    const { get, fetch } = await route(async () => Response.json(atl));
    for (const query of ["?x=1", "?x=" + "a".repeat(40), "?a=1&a=2"]) {
      const res = await get("atl", query);
      expect(res.status, query).toBe(308);
      expect(res.headers.get("Location"), query).toBe("/api/weather/atl");
      expect(res.headers.get("Cache-Control"), query).toBe("public, max-age=3600, s-maxage=86400");
    }
    expect((await get("ATL")).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an airport not on the list without asking upstream", async () => {
    const { get, fetch } = await route(async () => Response.json(atl));
    const unknown = await get("lhr");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("Cache-Control")).toBe("no-store");
    expect((await get("KATL&ids=KORD")).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("answers 502 when the upstream fails, has no report, or sends something else", async () => {
    for (const answer of [async () => new Response("down", { status: 503 }), async () => new Response(null, { status: 204 }), async () => Response.json([])]) {
      const { get } = await route(answer);
      const res = await get("atl");
      expect(res.status).toBe(502);
      expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=30");
    }
  });
});
