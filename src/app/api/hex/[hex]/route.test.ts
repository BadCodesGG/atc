import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/** The request for `hex` as the path spells it, which is all the route sees of what was typed (Next decodes the path segment it hands over as a param). */
const call = (hex: string, query = "") => GET(new Request(`http://localhost/api/hex/${hex}${query}`), { params: Promise.resolve({ hex: decodeURIComponent(hex) }) } as Parameters<typeof GET>[1]);

afterEach(() => vi.unstubAllGlobals());

describe("GET /api/hex/[hex]", () => {
  it("answers 400 for anything but six hex digits, without asking adsb.lol", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const bad of ["..%2Fsecrets", "abc", "~a1b2c", "a1b2c3d4", "a1b2c3/..", "zzzzzz", "%E2%80%94"]) {
      const res = await call(bad);
      expect(res.status, bad).toBe(400);
      expect(res.headers.get("Cache-Control"), bad).toBe("no-store");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects every other spelling of a hex to the lower-case address, permanently, without asking adsb.lol", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    for (const spelling of ["ABCDEF", "AbCdEf", "abcdeF", "%41bcdef"]) {
      const res = await call(spelling);
      expect(res.status, spelling).toBe(308);
      expect(res.headers.get("Location"), spelling).toBe("/api/hex/abcdef");
      expect(res.headers.get("Cache-Control"), spelling).toBe("public, max-age=3600, s-maxage=86400");
    }
    const withQuery = await call("abcdef", "?x=1");
    expect([withQuery.status, withQuery.headers.get("Location")]).toEqual([308, "/api/hex/abcdef"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the aircraft at the lower-case address, asking adsb.lol for it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ now: 1_790_794_144_001, ac: [{ hex: "abcdef", flight: "DAL1234", lat: 34.4, lon: -83.1, alt_baro: 29000, gs: 452, track: 48 }] }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await call("abcdef");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=4, stale-while-revalidate=20");
    expect(await res.json()).toMatchObject({ hex: "abcdef", aircraft: { callsign: "DAL1234", altitudeFt: 29000 } });
    expect(fetchMock.mock.calls[0]).toEqual(["https://api.adsb.lol/v2/hex/abcdef", expect.anything()]);
  });

  it("answers 502 when adsb.lol fails and there is no recent answer to fall back on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("busy", { status: 503 })));
    const res = await call("fedcba");
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=4");
  });
});
