import { describe, expect, it } from "vitest";
import { groupAirports, matchAirports, placeOf, regionName } from "./airport-search";
import { AIRPORTS } from "./airports";

const codes = (list: readonly { code: string }[]) => list.map((a) => a.code).sort();

describe("the airport list", () => {
  it("gives every airport a country and a state with a known name", () => {
    for (const airport of AIRPORTS) {
      expect(airport.country, airport.code).toBe("US");
      expect(airport.state, airport.code).toMatch(/^[A-Z]{2}$/);
      expect(regionName(airport.country, airport.state), airport.code).not.toBe(airport.state);
    }
  });

  it("names a place as city and state", () => {
    expect(placeOf(AIRPORTS.find((a) => a.code === "atl")!)).toBe("Atlanta, GA");
  });
});

describe("matchAirports", () => {
  it("matches everything for an empty or blank query", () => {
    expect(matchAirports(AIRPORTS, "")).toHaveLength(AIRPORTS.length);
    expect(matchAirports(AIRPORTS, "   ")).toHaveLength(AIRPORTS.length);
  });

  it("matches by IATA and ICAO code", () => {
    expect(codes(matchAirports(AIRPORTS, "jfk"))).toEqual(["jfk"]);
    expect(codes(matchAirports(AIRPORTS, "KJFK"))).toEqual(["jfk"]);
    expect(codes(matchAirports(AIRPORTS, "phnl"))).toEqual(["hnl"]);
  });

  it("matches by city", () => {
    expect(codes(matchAirports(AIRPORTS, "fort laud"))).toEqual(["fll"]);
    expect(codes(matchAirports(AIRPORTS, "new york"))).toEqual(["jfk", "lga"]);
  });

  it("matches by state code and by full state name", () => {
    expect(codes(matchAirports(AIRPORTS, "tx"))).toEqual(["aus", "dfw", "iah"]);
    expect(codes(matchAirports(AIRPORTS, "tex"))).toEqual(["aus", "dfw", "iah"]);
    expect(codes(matchAirports(AIRPORTS, "Texas"))).toEqual(["aus", "dfw", "iah"]);
    expect(codes(matchAirports(AIRPORTS, "hawaii"))).toEqual(["hnl"]);
  });

  it("matches by airport name, ignoring case, accents and punctuation", () => {
    expect(codes(matchAirports(AIRPORTS, "o'hare"))).toEqual(["ord"]);
    expect(codes(matchAirports(AIRPORTS, "OHARE"))).toEqual(["ord"]);
    expect(codes(matchAirports(AIRPORTS, "hartsfield"))).toEqual(["atl"]);
    expect(codes(matchAirports(AIRPORTS, "Dulles"))).toEqual(["iad"]);
  });

  it("needs every word of the query to match", () => {
    expect(codes(matchAirports(AIRPORTS, "dallas tx"))).toEqual(["dfw"]);
    expect(matchAirports(AIRPORTS, "dallas ca")).toEqual([]);
  });

  it("matches the start of words and codes, not the middle", () => {
    expect(matchAirports(AIRPORTS, "tlanta")).toEqual([]);
    expect(matchAirports(AIRPORTS, "xyz")).toEqual([]);
  });

  it("keeps the order it was given", () => {
    const reversed = [...AIRPORTS].reverse();
    expect(matchAirports(reversed, "tex").map((a) => a.code)).toEqual(reversed.filter((a) => a.state === "TX").map((a) => a.code));
  });
});

describe("groupAirports", () => {
  it("groups by state under its full name, sorted by that name", () => {
    const groups = groupAirports(AIRPORTS);
    const names = groups.map((g) => g.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    expect(names[0]).toBe("Arizona");
    expect(names).toContain("District of Columbia");
    expect(groups.flatMap((g) => g.airports)).toHaveLength(AIRPORTS.length);
  });

  it("sorts airports within a state by city, then code", () => {
    const groups = groupAirports(AIRPORTS);
    expect(groups.find((g) => g.state === "TX")!.airports.map((a) => a.code)).toEqual(["aus", "dfw", "iah"]);
    expect(groups.find((g) => g.state === "NY")!.airports.map((a) => a.code)).toEqual(["jfk", "lga"]);
  });

  it("keeps only the states that have a match", () => {
    expect(groupAirports(matchAirports(AIRPORTS, "tex")).map((g) => g.name)).toEqual(["Texas"]);
    expect(groupAirports([])).toEqual([]);
  });
});
