import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const call = (code: string, query = "") => GET(new Request(`http://localhost/api/squawk/${code}${query}`), { params: Promise.resolve({ code }) } as Parameters<typeof GET>[1]);

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/squawk/[code]", () => {
  it("answers 400 for anything but 7700, 7600 and 7500, without asking adsb.lol", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["1200", "7701", "..%2Fsecrets", "7700/..", "07700", "abcd", "%E2%80%94", ""]) {
      const res = await call(bad);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("Cache-Control"), bad).toBe("no-store");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects a query string to the bare address, permanently, without asking adsb.lol", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const query of ["?x=1", "?x=" + "a".repeat(40), "?a=1&a=2"]) {
      const res = await call("7700", query);
      expect(res.status, query).toBe(308);
      expect(res.headers.get("Location"), query).toBe("/api/squawk/7700");
      expect(res.headers.get("Cache-Control"), query).toBe("public, max-age=3600, s-maxage=86400");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers who squawks the code, asking adsb.lol for exactly that code", async () => {
    const fetchMock = vi.fn(async () => Response.json({ now: 1_790_856_776_000, ac: [{ hex: "abcdef", flight: "DAL1", lat: 34.4, lon: -83.1, alt_baro: 9000, gs: 250, track: 48 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("7600");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=4, stale-while-revalidate=20");
    expect(await res.json()).toMatchObject({ code: "7600", aircraft: [{ id: "abcdef", callsign: "DAL1" }] });
    expect(fetchMock.mock.calls[0]).toEqual(["https://api.adsb.lol/v2/sqk/7600", expect.anything()]);
  });

  it("answers 502 when adsb.lol fails and there is no recent answer to fall back on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const res = await call("7500");
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=4");
  });
});
