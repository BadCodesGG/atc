import type { Airport } from "./airports";

/** The US states (and DC and Puerto Rico) by their two-letter code, for the picker's headings and for searching by state name. */
const US_STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  PR: "Puerto Rico",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

/** Region names by country, so airports outside the US can be grouped the same way once they are added. */
const REGIONS: Record<string, Record<string, string>> = { US: US_STATES };

/** The full name of a region ("Georgia" for US, GA), or the code itself when the name is not known. */
export function regionName(country: string, state: string): string {
  return REGIONS[country]?.[state] ?? state;
}

/** "Atlanta, GA": how a row names the place. */
export function placeOf(airport: Airport): string {
  return `${airport.city}, ${airport.state}`;
}

export interface AirportGroup {
  country: string;
  state: string;
  /** The region's full name, the group's heading. */
  name: string;
  airports: Airport[];
}

/** Lower case, accents and punctuation gone, so "O'Hare" and "ohare", or "St. Paul" and "st paul", meet. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The words of a query, folded; none for a blank one. */
function termsOf(query: string): string[] {
  return fold(query).split(" ").filter(Boolean);
}

/** An airport's own codes, folded: IATA, ICAO and a renamed airport's old pair. */
function ownCodes(airport: Airport): string[] {
  return [airport.code, airport.icao, ...(airport.formerly ? [airport.formerly.code, airport.formerly.icao] : [])].map(fold);
}

/** What a query is matched against: codes by their start (a renamed airport's old ones too), words by the start of any word. */
function fields(airport: Airport): { codes: string[]; words: string[][] } {
  const region = regionName(airport.country, airport.state);
  return {
    codes: [...ownCodes(airport), fold(airport.state)],
    words: [airport.city, region, airport.name].map((text) => fold(text).split(" ")),
  };
}

/**
 * The airports a search box matches, in the order given. A query is split into words and every word has
 * to match something: the start of the IATA or ICAO code or of the state code (so "kat" and "ga" work),
 * or the start of a word of the city, the state's full name or the airport's name ("tex" finds Texas,
 * "ohare" finds O'Hare). An empty query matches everything.
 */
export function matchAirports(airports: readonly Airport[], query: string): Airport[] {
  const terms = termsOf(query);
  if (!terms.length) return [...airports];
  return airports.filter((airport) => {
    const { codes, words } = fields(airport);
    return terms.every((term) => codes.some((code) => code.startsWith(term)) || words.some((list) => list.some((word) => word.startsWith(term))));
  });
}

/**
 * How well an airport's own codes (IATA, ICAO and any former pair, not the state's) answer a query: 0 when
 * a word of it is a whole code, 1 when one starts a code, 2 otherwise. A query matched only by name, city
 * or state, or no query, ranks 2.
 */
function codeRank(airport: Airport, terms: readonly string[]): number {
  const codes = ownCodes(airport);
  if (terms.some((term) => codes.includes(term))) return 0;
  if (terms.some((term) => codes.some((code) => code.startsWith(term)))) return 1;
  return 2;
}

/**
 * Airports under their region, regions in alphabetical order of their full names, airports by city then code.
 * Given the query the airports matched, an airport whose code is the query comes first, then those whose code
 * starts with it, so the first row (the one Enter picks) is "pit" for "pit" and not Pittsburgh-Butler: within a
 * region by that rank before the city, and regions by their best rank before the name.
 */
export function groupAirports(airports: readonly Airport[], query = ""): AirportGroup[] {
  const terms = termsOf(query);
  const rank = new Map(airports.map((a) => [a, codeRank(a, terms)]));
  const rankOf = (airport: Airport) => rank.get(airport)!;
  const groups = new Map<string, AirportGroup>();
  for (const airport of airports) {
    const key = `${airport.country}-${airport.state}`;
    let group = groups.get(key);
    if (!group) {
      group = { country: airport.country, state: airport.state, name: regionName(airport.country, airport.state), airports: [] };
      groups.set(key, group);
    }
    group.airports.push(airport);
  }
  const byText = (a: string, b: string) => a.localeCompare(b, "en");
  const best = (group: AirportGroup) => Math.min(...group.airports.map(rankOf));
  for (const group of groups.values()) group.airports.sort((a, b) => rankOf(a) - rankOf(b) || byText(a.city, b.city) || byText(a.code, b.code));
  return [...groups.values()].sort((a, b) => best(a) - best(b) || byText(a.name, b.name));
}

/** The picker's list for a query: the airports it matches, grouped and ranked by that same query. */
export function searchAirports(airports: readonly Airport[], query: string): AirportGroup[] {
  return groupAirports(matchAirports(airports, query), query);
}
