import { describe, expect, it } from "vitest";
import { groupAirports, matchAirports, placeOf, regionName, searchAirports } from "./airport-search";
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
    expect(codes(matchAirports(AIRPORTS, "tjsj"))).toEqual(["sju"]);
  });

  it("finds an airport by the code it had before a rename (PBI, now DJT)", () => {
    expect(codes(matchAirports(AIRPORTS, "pbi"))).toEqual(["djt"]);
    expect(codes(matchAirports(AIRPORTS, "kpbi"))).toEqual(["djt"]);
    expect(codes(matchAirports(AIRPORTS, "palm beach"))).toEqual(["djt"]);
  });

  it("finds the general aviation fields by city and name", () => {
    expect(codes(matchAirports(AIRPORTS, "butler"))).toEqual(["btp"]);
    expect(codes(matchAirports(AIRPORTS, "beaufort"))).toEqual(["bft"]);
    expect(codes(matchAirports(AIRPORTS, "karw"))).toEqual(["bft"]);
    expect(codes(matchAirports(AIRPORTS, "pittsburgh"))).toEqual(["btp", "pit"]);
  });

  it("matches by city", () => {
    expect(codes(matchAirports(AIRPORTS, "fort laud"))).toEqual(["fll"]);
    // "New York" is a city and a state: Buffalo is in the state, so it matches too, as "texas" finds every Texas airport.
    expect(codes(matchAirports(AIRPORTS, "new york"))).toEqual(["buf", "jfk", "lga"]);
    expect(codes(matchAirports(AIRPORTS, "new york ny"))).toEqual(["buf", "jfk", "lga"]);
  });

  it("matches by state code and by full state name", () => {
    expect(codes(matchAirports(AIRPORTS, "tx"))).toEqual(["aus", "dal", "dfw", "hou", "iah", "sat"]);
    expect(codes(matchAirports(AIRPORTS, "tex"))).toEqual(["aus", "dal", "dfw", "hou", "iah", "sat"]);
    expect(codes(matchAirports(AIRPORTS, "Texas"))).toEqual(["aus", "dal", "dfw", "hou", "iah", "sat"]);
    expect(codes(matchAirports(AIRPORTS, "hawaii"))).toEqual(["hnl", "ogg"]);
    expect(codes(matchAirports(AIRPORTS, "puerto rico"))).toEqual(["sju"]);
    expect(codes(matchAirports(AIRPORTS, "san juan"))).toEqual(["sju"]);
  });

  it("matches by airport name, ignoring case, accents and punctuation", () => {
    expect(codes(matchAirports(AIRPORTS, "o'hare"))).toEqual(["ord"]);
    expect(codes(matchAirports(AIRPORTS, "OHARE"))).toEqual(["ord"]);
    expect(codes(matchAirports(AIRPORTS, "hartsfield"))).toEqual(["atl"]);
    expect(codes(matchAirports(AIRPORTS, "Dulles"))).toEqual(["iad"]);
  });

  it("needs every word of the query to match", () => {
    expect(codes(matchAirports(AIRPORTS, "dallas tx"))).toEqual(["dal", "dfw"]);
    expect(codes(matchAirports(AIRPORTS, "dallas love"))).toEqual(["dal"]);
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
    expect(names[0]).toBe("Alaska");
    expect(names).toContain("Puerto Rico");
    expect(names).toContain("District of Columbia");
    expect(groups.flatMap((g) => g.airports)).toHaveLength(AIRPORTS.length);
  });

  it("sorts airports within a state by city, then code", () => {
    const groups = groupAirports(AIRPORTS);
    expect(groups.find((g) => g.state === "TX")!.airports.map((a) => a.code)).toEqual(["aus", "dal", "dfw", "hou", "iah", "sat"]);
    expect(groups.find((g) => g.state === "NY")!.airports.map((a) => a.code)).toEqual(["buf", "jfk", "lga"]);
  });

  it("keeps only the states that have a match", () => {
    expect(groupAirports(matchAirports(AIRPORTS, "tex")).map((g) => g.name)).toEqual(["Texas"]);
    expect(groupAirports([])).toEqual([]);
  });
});

describe("the picker's rows for a query", () => {
  // What the picker lists, in order; its first row is the one Enter picks.
  const rows = (query: string) => searchAirports(AIRPORTS, query).flatMap((g) => g.airports.map((a) => a.code));

  it("puts the airport whose code is the query first, above a name or city that starts with it", () => {
    expect(rows("pit")[0]).toBe("pit");
    expect(rows("pit")).toContain("btp");
    expect(rows("PIT")[0]).toBe("pit");
    expect(rows("kpit")[0]).toBe("pit");
    expect(rows("btp")[0]).toBe("btp");
    expect(rows("pit pa")[0]).toBe("pit");
  });

  it("puts every airport first for its own IATA and ICAO code, and a renamed one for its old codes", () => {
    for (const a of AIRPORTS) {
      expect(rows(a.code)[0], a.code).toBe(a.code);
      expect(rows(a.icao)[0], a.icao).toBe(a.code);
      if (a.formerly) {
        expect(rows(a.formerly.code)[0], a.formerly.code).toBe(a.code);
        expect(rows(a.formerly.icao)[0], a.formerly.icao).toBe(a.code);
      }
    }
  });

  it("puts a code that starts with the query above a name or city that does", () => {
    // "pi" starts PIT's code and Pittsburgh-Butler's name: the code match comes first.
    const list = rows("pi");
    expect(list).toEqual(expect.arrayContaining(["pit", "btp"]));
    expect(list.indexOf("pit")).toBeLessThan(list.indexOf("btp"));
    // Across states too: CHS (South Carolina) leads Chicago (Illinois), SAN leads the rest of California and San Antonio.
    expect(rows("ch")[0]).toBe("chs");
    expect(rows("ch")).toEqual(expect.arrayContaining(["mdw", "ord"]));
    expect(rows("sa")[0]).toBe("san");
  });

  it("keeps the state and city order when no code matches", () => {
    expect(rows("pittsburgh")).toEqual(["btp", "pit"]);
    expect(rows("")).toEqual(groupAirports(AIRPORTS).flatMap((g) => g.airports.map((a) => a.code)));
  });
});
