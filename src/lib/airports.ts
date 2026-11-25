/**
 * The airports the scene can show: every FAA large and medium hub by CY2025 commercial service enplanements,
 * plus Pittsburgh-Butler Regional and Beaufort Executive, two general aviation fields asked for by name.
 * Reference points, elevations and time zones come from the mwgg/Airports dataset, cross-checked against
 * OurAirports; the state is OurAirports' iso_region (US-GA is GA, US-PR is PR). Every local coordinate in the
 * app is metres east and north of the ARP.
 */

export interface Airport {
  /** Lower-case IATA code, used in URLs and API routes. */
  code:
    | "atl"
    | "pit"
    | "jfk"
    | "dfw"
    | "ord"
    | "den"
    | "lax"
    | "mco"
    | "las"
    | "mia"
    | "sfo"
    | "clt"
    | "sea"
    | "phx"
    | "ewr"
    | "iah"
    | "bos"
    | "msp"
    | "dtw"
    | "lga"
    | "fll"
    | "phl"
    | "iad"
    | "slc"
    | "san"
    | "bna"
    | "bwi"
    | "tpa"
    | "dca"
    | "aus"
    | "hnl"
    | "cle"
    | "mdw"
    | "pdx"
    | "dal"
    | "rdu"
    | "stl"
    | "smf"
    | "hou"
    | "sju"
    | "msy"
    | "mci"
    | "sna"
    | "rsw"
    | "sjc"
    | "sat"
    | "ind"
    | "oak"
    | "cmh"
    | "cvg"
    | "djt"
    | "jax"
    | "ont"
    | "ogg"
    | "bdl"
    | "bur"
    | "chs"
    | "mke"
    | "anc"
    | "boi"
    | "oma"
    | "abq"
    | "buf"
    | "ric"
    | "orf"
    | "btp"
    | "bft";
  icao: string;
  name: string;
  city: string;
  latitude: number;
  longitude: number;
  /** Field elevation, feet above mean sea level. */
  elevationFt: number;
  timeZone: string;
  /** ISO 3166-1 alpha-2 country code; the picker groups airports by state within a country. */
  country: string;
  /** Region code within the country (a US state, as "GA"), from the ISO 3166-2 code after the hyphen. */
  state: string;
  /** The codes the airport had before a rename, which route data may still give (adsbdb names DJT as PBI). */
  formerly?: { code: string; icao: string };
  /** Stations nearby whose METAR stands in, nearest first, for a field that issues none of its own. */
  metarFallback?: string[];
}

export const AIRPORTS: readonly Airport[] = [
  { code: "atl", icao: "KATL", name: "Hartsfield-Jackson Atlanta International", city: "Atlanta", latitude: 33.6367, longitude: -84.4281, elevationFt: 1026, timeZone: "America/New_York", country: "US", state: "GA" },
  { code: "pit", icao: "KPIT", name: "Pittsburgh International", city: "Pittsburgh", latitude: 40.4915, longitude: -80.2329, elevationFt: 1203, timeZone: "America/New_York", country: "US", state: "PA" },
  { code: "jfk", icao: "KJFK", name: "John F. Kennedy International", city: "New York", latitude: 40.6399, longitude: -73.7787, elevationFt: 13, timeZone: "America/New_York", country: "US", state: "NY" },
  { code: "dfw", icao: "KDFW", name: "Dallas/Fort Worth International", city: "Dallas-Fort Worth", latitude: 32.8968, longitude: -97.038, elevationFt: 607, timeZone: "America/Chicago", country: "US", state: "TX" },
  { code: "ord", icao: "KORD", name: "Chicago O'Hare International", city: "Chicago", latitude: 41.9786, longitude: -87.9048, elevationFt: 672, timeZone: "America/Chicago", country: "US", state: "IL" },
  { code: "den", icao: "KDEN", name: "Denver International", city: "Denver", latitude: 39.8617, longitude: -104.673, elevationFt: 5431, timeZone: "America/Denver", country: "US", state: "CO" },
  { code: "lax", icao: "KLAX", name: "Los Angeles International", city: "Los Angeles", latitude: 33.9425, longitude: -118.408, elevationFt: 125, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "mco", icao: "KMCO", name: "Orlando International", city: "Orlando", latitude: 28.4294, longitude: -81.309, elevationFt: 96, timeZone: "America/New_York", country: "US", state: "FL" },
  { code: "las", icao: "KLAS", name: "Harry Reid International", city: "Las Vegas", latitude: 36.0801, longitude: -115.152, elevationFt: 2181, timeZone: "America/Los_Angeles", country: "US", state: "NV" },
  { code: "mia", icao: "KMIA", name: "Miami International", city: "Miami", latitude: 25.7932, longitude: -80.2906, elevationFt: 8, timeZone: "America/New_York", country: "US", state: "FL" },
  { code: "sfo", icao: "KSFO", name: "San Francisco International", city: "San Francisco", latitude: 37.619, longitude: -122.375, elevationFt: 13, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "clt", icao: "KCLT", name: "Charlotte Douglas International", city: "Charlotte", latitude: 35.214, longitude: -80.9431, elevationFt: 748, timeZone: "America/New_York", country: "US", state: "NC" },
  { code: "sea", icao: "KSEA", name: "Seattle-Tacoma International", city: "Seattle", latitude: 47.449, longitude: -122.309, elevationFt: 433, timeZone: "America/Los_Angeles", country: "US", state: "WA" },
  { code: "phx", icao: "KPHX", name: "Phoenix Sky Harbor International", city: "Phoenix", latitude: 33.4343, longitude: -112.012, elevationFt: 1135, timeZone: "America/Phoenix", country: "US", state: "AZ" },
  { code: "ewr", icao: "KEWR", name: "Newark Liberty International", city: "Newark", latitude: 40.6925, longitude: -74.1687, elevationFt: 18, timeZone: "America/New_York", country: "US", state: "NJ" },
  { code: "iah", icao: "KIAH", name: "George Bush Intercontinental", city: "Houston", latitude: 29.9844, longitude: -95.3414, elevationFt: 97, timeZone: "America/Chicago", country: "US", state: "TX" },
  { code: "bos", icao: "KBOS", name: "General Edward Lawrence Logan International", city: "Boston", latitude: 42.3643, longitude: -71.0052, elevationFt: 20, timeZone: "America/New_York", country: "US", state: "MA" },
  { code: "msp", icao: "KMSP", name: "Minneapolis-St Paul International/Wold-Chamberlain", city: "Minneapolis", latitude: 44.882, longitude: -93.2218, elevationFt: 841, timeZone: "America/Chicago", country: "US", state: "MN" },
  { code: "dtw", icao: "KDTW", name: "Detroit Metropolitan Wayne County", city: "Detroit", latitude: 42.2124, longitude: -83.3534, elevationFt: 645, timeZone: "America/Detroit", country: "US", state: "MI" },
  { code: "lga", icao: "KLGA", name: "LaGuardia", city: "New York", latitude: 40.7772, longitude: -73.8726, elevationFt: 21, timeZone: "America/New_York", country: "US", state: "NY" },
  { code: "fll", icao: "KFLL", name: "Fort Lauderdale-Hollywood International", city: "Fort Lauderdale", latitude: 26.0726, longitude: -80.1527, elevationFt: 9, timeZone: "America/New_York", country: "US", state: "FL" },
  { code: "phl", icao: "KPHL", name: "Philadelphia International", city: "Philadelphia", latitude: 39.8719, longitude: -75.2411, elevationFt: 36, timeZone: "America/New_York", country: "US", state: "PA" },
  { code: "iad", icao: "KIAD", name: "Washington Dulles International", city: "Dulles", latitude: 38.9445, longitude: -77.4558, elevationFt: 312, timeZone: "America/New_York", country: "US", state: "VA" },
  { code: "slc", icao: "KSLC", name: "Salt Lake City International", city: "Salt Lake City", latitude: 40.7884, longitude: -111.978, elevationFt: 4227, timeZone: "America/Denver", country: "US", state: "UT" },
  { code: "san", icao: "KSAN", name: "San Diego International", city: "San Diego", latitude: 32.7336, longitude: -117.19, elevationFt: 17, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "bna", icao: "KBNA", name: "Nashville International", city: "Nashville", latitude: 36.1245, longitude: -86.6782, elevationFt: 599, timeZone: "America/Chicago", country: "US", state: "TN" },
  { code: "bwi", icao: "KBWI", name: "Baltimore/Washington International Thurgood Marshall", city: "Baltimore", latitude: 39.1754, longitude: -76.6683, elevationFt: 146, timeZone: "America/New_York", country: "US", state: "MD" },
  { code: "tpa", icao: "KTPA", name: "Tampa International", city: "Tampa", latitude: 27.9755, longitude: -82.5332, elevationFt: 26, timeZone: "America/New_York", country: "US", state: "FL" },
  { code: "dca", icao: "KDCA", name: "Ronald Reagan Washington National", city: "Washington", latitude: 38.8521, longitude: -77.0377, elevationFt: 15, timeZone: "America/New_York", country: "US", state: "DC" },
  { code: "aus", icao: "KAUS", name: "Austin-Bergstrom International", city: "Austin", latitude: 30.1945, longitude: -97.6699, elevationFt: 542, timeZone: "America/Chicago", country: "US", state: "TX" },
  { code: "hnl", icao: "PHNL", name: "Daniel K. Inouye International", city: "Honolulu", latitude: 21.3187, longitude: -157.922, elevationFt: 13, timeZone: "Pacific/Honolulu", country: "US", state: "HI" },
  { code: "cle", icao: "KCLE", name: "Cleveland Hopkins International", city: "Cleveland", latitude: 41.4117, longitude: -81.8498, elevationFt: 791, timeZone: "America/New_York", country: "US", state: "OH" },
  { code: "mdw", icao: "KMDW", name: "Chicago Midway International", city: "Chicago", latitude: 41.786, longitude: -87.7524, elevationFt: 620, timeZone: "America/Chicago", country: "US", state: "IL" },
  { code: "pdx", icao: "KPDX", name: "Portland International", city: "Portland", latitude: 45.5887, longitude: -122.598, elevationFt: 31, timeZone: "America/Los_Angeles", country: "US", state: "OR" },
  { code: "dal", icao: "KDAL", name: "Dallas Love Field", city: "Dallas", latitude: 32.8471, longitude: -96.8518, elevationFt: 487, timeZone: "America/Chicago", country: "US", state: "TX" },
  { code: "rdu", icao: "KRDU", name: "Raleigh-Durham International", city: "Raleigh-Durham", latitude: 35.8776, longitude: -78.7875, elevationFt: 435, timeZone: "America/New_York", country: "US", state: "NC" },
  { code: "stl", icao: "KSTL", name: "St. Louis Lambert International", city: "St. Louis", latitude: 38.7487, longitude: -90.37, elevationFt: 618, timeZone: "America/Chicago", country: "US", state: "MO" },
  { code: "smf", icao: "KSMF", name: "Sacramento International", city: "Sacramento", latitude: 38.6954, longitude: -121.591, elevationFt: 27, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "hou", icao: "KHOU", name: "William P. Hobby", city: "Houston", latitude: 29.6454, longitude: -95.2789, elevationFt: 46, timeZone: "America/Chicago", country: "US", state: "TX" },
  { code: "sju", icao: "TJSJ", name: "Luis Munoz Marin International", city: "San Juan", latitude: 18.4394, longitude: -66.0018, elevationFt: 9, timeZone: "America/Puerto_Rico", country: "US", state: "PR" },
  { code: "msy", icao: "KMSY", name: "Louis Armstrong New Orleans International", city: "New Orleans", latitude: 29.9934, longitude: -90.258, elevationFt: 4, timeZone: "America/Chicago", country: "US", state: "LA" },
  { code: "mci", icao: "KMCI", name: "Kansas City International", city: "Kansas City", latitude: 39.2976, longitude: -94.7139, elevationFt: 1026, timeZone: "America/Chicago", country: "US", state: "MO" },
  { code: "sna", icao: "KSNA", name: "John Wayne Orange County", city: "Santa Ana", latitude: 33.6757, longitude: -117.868, elevationFt: 56, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "rsw", icao: "KRSW", name: "Southwest Florida International", city: "Fort Myers", latitude: 26.5362, longitude: -81.7552, elevationFt: 30, timeZone: "America/New_York", country: "US", state: "FL" },
  { code: "sjc", icao: "KSJC", name: "Norman Y. Mineta San Jose International", city: "San Jose", latitude: 37.3626, longitude: -121.929, elevationFt: 62, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "sat", icao: "KSAT", name: "San Antonio International", city: "San Antonio", latitude: 29.5337, longitude: -98.4698, elevationFt: 809, timeZone: "America/Chicago", country: "US", state: "TX" },
  { code: "ind", icao: "KIND", name: "Indianapolis International", city: "Indianapolis", latitude: 39.7173, longitude: -86.2944, elevationFt: 797, timeZone: "America/Indiana/Indianapolis", country: "US", state: "IN" },
  { code: "oak", icao: "KOAK", name: "Oakland San Francisco Bay", city: "Oakland", latitude: 37.7213, longitude: -122.221, elevationFt: 9, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "cmh", icao: "KCMH", name: "John Glenn Columbus International", city: "Columbus", latitude: 39.998, longitude: -82.8919, elevationFt: 815, timeZone: "America/New_York", country: "US", state: "OH" },
  { code: "cvg", icao: "KCVG", name: "Cincinnati/Northern Kentucky International", city: "Cincinnati", latitude: 39.0488, longitude: -84.6678, elevationFt: 896, timeZone: "America/New_York", country: "US", state: "KY" },
  { code: "djt", icao: "KDJT", name: "President Donald J. Trump International", city: "West Palm Beach", latitude: 26.6832, longitude: -80.0956, elevationFt: 20, timeZone: "America/New_York", country: "US", state: "FL", formerly: { code: "pbi", icao: "KPBI" } },
  { code: "jax", icao: "KJAX", name: "Jacksonville International", city: "Jacksonville", latitude: 30.4941, longitude: -81.6879, elevationFt: 30, timeZone: "America/New_York", country: "US", state: "FL" },
  { code: "ont", icao: "KONT", name: "Ontario International", city: "Ontario", latitude: 34.056, longitude: -117.601, elevationFt: 944, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "ogg", icao: "PHOG", name: "Kahului", city: "Kahului", latitude: 20.8986, longitude: -156.43, elevationFt: 54, timeZone: "Pacific/Honolulu", country: "US", state: "HI" },
  { code: "bdl", icao: "KBDL", name: "Bradley International", city: "Hartford", latitude: 41.9389, longitude: -72.6832, elevationFt: 173, timeZone: "America/New_York", country: "US", state: "CT" },
  { code: "bur", icao: "KBUR", name: "Hollywood Burbank", city: "Burbank", latitude: 34.2007, longitude: -118.359, elevationFt: 778, timeZone: "America/Los_Angeles", country: "US", state: "CA" },
  { code: "chs", icao: "KCHS", name: "Charleston International", city: "Charleston", latitude: 32.8986, longitude: -80.0405, elevationFt: 46, timeZone: "America/New_York", country: "US", state: "SC" },
  { code: "mke", icao: "KMKE", name: "Milwaukee Mitchell International", city: "Milwaukee", latitude: 42.9472, longitude: -87.8966, elevationFt: 723, timeZone: "America/Chicago", country: "US", state: "WI" },
  { code: "anc", icao: "PANC", name: "Ted Stevens Anchorage International", city: "Anchorage", latitude: 61.1744, longitude: -149.996, elevationFt: 152, timeZone: "America/Anchorage", country: "US", state: "AK" },
  { code: "boi", icao: "KBOI", name: "Boise Air Terminal/Gowen Field", city: "Boise", latitude: 43.5644, longitude: -116.223, elevationFt: 2871, timeZone: "America/Boise", country: "US", state: "ID" },
  { code: "oma", icao: "KOMA", name: "Eppley Airfield", city: "Omaha", latitude: 41.3032, longitude: -95.8941, elevationFt: 984, timeZone: "America/Chicago", country: "US", state: "NE" },
  { code: "abq", icao: "KABQ", name: "Albuquerque International Sunport", city: "Albuquerque", latitude: 35.0402, longitude: -106.609, elevationFt: 5355, timeZone: "America/Denver", country: "US", state: "NM" },
  { code: "buf", icao: "KBUF", name: "Buffalo Niagara International", city: "Buffalo", latitude: 42.9405, longitude: -78.7322, elevationFt: 728, timeZone: "America/New_York", country: "US", state: "NY" },
  { code: "ric", icao: "KRIC", name: "Richmond International", city: "Richmond", latitude: 37.5052, longitude: -77.3197, elevationFt: 167, timeZone: "America/New_York", country: "US", state: "VA" },
  { code: "orf", icao: "KORF", name: "Norfolk International", city: "Norfolk", latitude: 36.8946, longitude: -76.2012, elevationFt: 26, timeZone: "America/New_York", country: "US", state: "VA" },
  { code: "btp", icao: "KBTP", name: "Pittsburgh-Butler Regional", city: "Butler", latitude: 40.7769, longitude: -79.9497, elevationFt: 1248, timeZone: "America/New_York", country: "US", state: "PA" },
  { code: "bft", icao: "KARW", name: "Beaufort Executive", city: "Beaufort", latitude: 32.4122, longitude: -80.6344, elevationFt: 10, timeZone: "America/New_York", country: "US", state: "SC", metarFallback: ["KNBC", "KHXD"] },
];

export const DEFAULT_AIRPORT = AIRPORTS[0];

/** The airport with this lower-case code, or with it as its code before a rename. */
export function airportByCode(code: string): Airport | undefined {
  return AIRPORTS.find((a) => a.code === code) ?? AIRPORTS.find((a) => a.formerly?.code === code);
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** The time zone's short name at a moment, "EDT" or "MST", for the clock that shows the airport's own time. */
export function zoneAbbreviation(timeMs: number, timeZone: string): string {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
    zoneFormats.set(timeZone, format);
  }
  return format.formatToParts(new Date(timeMs)).find((p) => p.type === "timeZoneName")?.value ?? "";
}
