import { type Airport, AIRPORTS, DEFAULT_AIRPORT } from "./airports";

/** Reads `?airport=`: a listed IATA code in any case, else (missing, empty, unlisted) the default airport. */
export function airportFromParam(value: string | string[] | undefined | null): Airport {
  const first = Array.isArray(value) ? value[0] : value;
  const code = first?.trim().toLowerCase();
  return AIRPORTS.find((airport) => airport.code === code) ?? DEFAULT_AIRPORT;
}

/**
 * The address with `airport` switched to `code`, every other parameter and the hash kept (so the theme
 * and the fixture survive a switch). The default airport is the absence of the parameter, as the
 * default theme is.
 */
export function withAirport(href: string, code: Airport["code"]): URL {
  const url = new URL(href);
  if (code === DEFAULT_AIRPORT.code) url.searchParams.delete("airport");
  else url.searchParams.set("airport", code);
  return url;
}
