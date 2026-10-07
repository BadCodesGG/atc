import { describe, expect, it } from "vitest";
import { airportFromParam, withAirport } from "./airport-url";

describe("airportFromParam", () => {
  it("reads a listed code in any case", () => {
    expect(airportFromParam("dfw").code).toBe("dfw");
    expect(airportFromParam("DFW").code).toBe("dfw");
    expect(airportFromParam(" Lax ").code).toBe("lax");
  });

  it("falls back to Atlanta for a missing, empty or unknown code", () => {
    for (const value of [undefined, null, "", "  ", "lhr", "katl", "dfw,lax"]) expect(airportFromParam(value).code).toBe("atl");
  });

  it("takes the first of a repeated parameter", () => {
    expect(airportFromParam(["sea", "den"]).code).toBe("sea");
    expect(airportFromParam([]).code).toBe("atl");
  });
});

describe("withAirport", () => {
  it("sets the airport and keeps the other parameters and the hash", () => {
    const url = withAirport("http://localhost:3000/?theme=dark&fixture=1#x", "dfw");
    expect(url.searchParams.get("airport")).toBe("dfw");
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("fixture")).toBe("1");
    expect(url.hash).toBe("#x");
  });

  it("replaces an airport already there", () => {
    expect(withAirport("http://localhost:3000/?airport=den&theme=dark", "sea").search).toBe("?airport=sea&theme=dark");
  });

  it("drops the parameter for the default airport", () => {
    expect(withAirport("http://localhost:3000/?airport=den&theme=dark", "atl").search).toBe("?theme=dark");
    expect(withAirport("http://localhost:3000/?airport=den", "atl").search).toBe("");
  });
});
