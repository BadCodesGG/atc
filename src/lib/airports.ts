/**
 * The airports the scene can show: the 30 busiest US airports by 2025 enplanements (FAA), plus PIT and CLE.
 * Reference points, elevations and time zones come from the mwgg/Airports dataset, cross-checked against
 * OurAirports; the state is OurAirports' iso_region (US-GA is GA). Every local coordinate in the app is metres east and north of the ARP.
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
    | "cle";
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
];

export const DEFAULT_AIRPORT = AIRPORTS[0];

export function airportByCode(code: string): Airport | undefined {
  return AIRPORTS.find((a) => a.code === code);
}
