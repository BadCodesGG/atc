import type { Airport } from "./airports";

/**
 * The airport's current weather, from its METAR: the hourly (and special) observation every airport
 * with a weather station publishes. Read from aviationweather.gov's data API (NOAA's Aviation Weather
 * Center: public, no key; at most 100 requests a minute, a custom User-Agent asked for). Only what
 * the scene and the readout use is parsed: wind, visibility, cloud, weather and temperature. The
 * remarks section (after RMK) is not read.
 */

export const metarUrl = (icao: string) => `https://aviationweather.gov/api/data/metar?ids=${encodeURIComponent(icao)}&format=json`;

export type Intensity = "light" | "moderate" | "heavy";

export interface Wind {
  /** Degrees true the wind blows from; null when calm or variable. */
  directionDeg: number | null;
  speedKt: number;
  gustKt: number | null;
  /** Reported as VRB: light and shifting, no one direction. */
  variable: boolean;
  /** The arc a steady wind is varying across ("240V300"), degrees true, or null. */
  range: [number, number] | null;
}

/** The most cloud reported, in any layer. "Obscured" is a sky hidden by fog or precipitation (VV). */
export type CloudCover = "clear" | "few" | "scattered" | "broken" | "overcast" | "obscured";

export interface Metar {
  station: string;
  /** UTC milliseconds of the observation, or null when it could not be dated. */
  timeMs: number | null;
  raw: string;
  /** Null when the report has no wind group. */
  wind: Wind | null;
  /** Prevailing visibility, metres; null when not reported. */
  visibilityM: number | null;
  /** Height of the lowest broken, overcast or obscured layer, feet above the field; null for none. */
  ceilingFt: number | null;
  cover: CloudCover | null;
  /** The weather groups as reported ("-RA", "BR", "VCSH"). */
  weather: string[];
  /** Precipitation at the field (drizzle counts as light rain); null for none. */
  precipitation: { kind: "rain" | "snow"; intensity: Intensity } | null;
  thunder: boolean;
  fog: boolean;
  mist: boolean;
  haze: boolean;
  temperatureC: number | null;
  dewpointC: number | null;
}

const SM = 1609.344;
const COVER_RANK: CloudCover[] = ["clear", "few", "scattered", "broken", "overcast", "obscured"];
const COVER: Record<string, CloudCover> = { FEW: "few", SCT: "scattered", BKN: "broken", OVC: "overcast", VV: "obscured" };
const RAIN = /DZ|RA/;
const SNOW = /SN|SG|PL|IC|GS|GR/;

/** Dates a report's "DDHHMM" against `referenceMs`: the latest such moment no more than an hour after it. */
function reportTime(day: number, hour: number, minute: number, referenceMs: number): number {
  const ref = new Date(referenceMs);
  for (let back = 0; back < 3; back++) {
    const t = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() - back, day, hour, minute);
    // A day past the month's end rolls into the next month; that month is skipped.
    if (new Date(t).getUTCDate() === day && t <= referenceMs + 3_600_000) return t;
  }
  return NaN;
}

/** "10SM", "1/2SM", "M1/4SM", "P6SM" (with any whole miles before a fraction) to metres. */
function statuteMiles(whole: string | null, text: string): number | null {
  const m = /^([MP])?(?:(\d+)\/(\d+)|(\d+))SM$/.exec(text);
  if (!m) return null;
  let miles = (whole ? Number(whole) : 0) + (m[4] !== undefined ? Number(m[4]) : Number(m[2]) / Number(m[3]));
  // "Less than a quarter mile" is taken as half of it; "more than six" as six.
  if (m[1] === "M") miles /= 2;
  return Math.round(miles * SM);
}

/** Parses the body of a METAR or SPECI. `referenceMs` dates its day-and-time stamp. */
export function parseMetar(raw: string, referenceMs: number = Date.now()): Metar {
  const tokens = raw.trim().split(/\s+/);
  const out: Metar = {
    station: "",
    timeMs: null,
    raw: raw.trim(),
    wind: null,
    visibilityM: null,
    ceilingFt: null,
    cover: null,
    weather: [],
    precipitation: null,
    thunder: false,
    fog: false,
    mist: false,
    haze: false,
    temperatureC: null,
    dewpointC: null,
  };
  const deepen = (cover: CloudCover) => {
    if (!out.cover || COVER_RANK.indexOf(cover) > COVER_RANK.indexOf(out.cover)) out.cover = cover;
  };
  let i = 0;
  if (tokens[i] === "METAR" || tokens[i] === "SPECI") i++;
  if (/^[A-Z][A-Z0-9]{3}$/.test(tokens[i] ?? "")) out.station = tokens[i++];
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    // Remarks and trend forecasts are not the observation.
    if (t === "RMK" || t === "NOSIG" || t === "BECMG" || t === "TEMPO") break;
    let m: RegExpExecArray | null;
    if ((m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(t))) {
      const time = reportTime(Number(m[1]), Number(m[2]), Number(m[3]), referenceMs);
      out.timeMs = Number.isFinite(time) ? time : null;
    } else if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(t))) {
      const unit = m[4] === "MPS" ? 1.943844 : m[4] === "KMH" ? 0.539957 : 1;
      const speedKt = Math.round(Number(m[2]) * unit);
      const variable = m[1] === "VRB";
      out.wind = {
        directionDeg: variable || speedKt === 0 ? null : Number(m[1]) % 360 === 0 ? 360 : Number(m[1]),
        speedKt,
        gustKt: m[3] ? Math.round(Number(m[3]) * unit) : null,
        variable,
        range: null,
      };
    } else if ((m = /^(\d{3})V(\d{3})$/.exec(t)) && out.wind) {
      out.wind.range = [Number(m[1]), Number(m[2])];
    } else if (/^\d$/.test(t) && /^[MP]?\d+\/\d+SM$/.test(tokens[i + 1] ?? "")) {
      out.visibilityM = statuteMiles(t, tokens[++i]);
    } else if (/SM$/.test(t) && statuteMiles(null, t) !== null) {
      out.visibilityM = statuteMiles(null, t);
    } else if (/^\d{4}$/.test(t) && out.visibilityM === null) {
      out.visibilityM = t === "9999" ? 10_000 : Number(t);
    } else if (t === "CAVOK") {
      out.visibilityM = 10_000;
      out.cover = "clear";
    } else if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)/.exec(t))) {
      const cover = COVER[m[1]];
      deepen(cover);
      const base = m[2] === "///" ? null : Number(m[2]) * 100;
      if (base !== null && (cover === "broken" || cover === "overcast" || cover === "obscured") && (out.ceilingFt === null || base < out.ceilingFt)) out.ceilingFt = base;
    } else if (/^(CLR|SKC|NSC|NCD)$/.test(t)) {
      deepen("clear");
    } else if ((m = /^(M?\d{2})\/(M?\d{2})?$/.exec(t))) {
      const c = (s: string) => Number(s.replace("M", "-"));
      out.temperatureC = c(m[1]);
      out.dewpointC = m[2] ? c(m[2]) : null;
    } else if ((m = /^(-|\+|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/.exec(t)) && (m[2] || m[3])) {
      out.weather.push(t);
      // Weather "in the vicinity" is within 10 miles but not at the field.
      if (m[1] === "VC") continue;
      const intensity: Intensity = m[1] === "-" ? "light" : m[1] === "+" ? "heavy" : "moderate";
      const phenomena = m[3];
      if (m[2] === "TS") out.thunder = true;
      if (/FG/.test(phenomena)) out.fog = true;
      if (/BR/.test(phenomena)) out.mist = true;
      if (/HZ|FU|DU|SA/.test(phenomena)) out.haze = true;
      if (!out.precipitation) {
        const rain = phenomena.search(RAIN);
        const snow = phenomena.search(SNOW);
        if (rain >= 0 || snow >= 0) {
          // Mixed precipitation is drawn as whichever is reported first; drizzle is light rain.
          const kind = snow >= 0 && (rain < 0 || snow < rain) ? "snow" : "rain";
          out.precipitation = { kind, intensity: kind === "rain" && /^DZ/.test(phenomena.slice(rain)) && intensity === "moderate" ? "light" : intensity };
        }
      }
    }
  }
  return out;
}

/** The airport's report out of aviationweather.gov's JSON answer. Throws unless it is there. */
export function parseMetarResponse(json: unknown, icao: string): Metar {
  if (!Array.isArray(json)) throw new Error("metar: not a list of reports");
  const entry = json.find((e): e is { icaoId: string; rawOb: string; obsTime?: unknown } => typeof e === "object" && e !== null && e.icaoId === icao && typeof e.rawOb === "string");
  if (!entry) throw new Error(`metar: no report for ${icao}`);
  const metar = parseMetar(entry.rawOb);
  if (typeof entry.obsTime === "number" && Number.isFinite(entry.obsTime)) metar.timeMs = entry.obsTime * 1000;
  return metar;
}

type Fetcher = (url: string) => Promise<unknown>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
    headers: { "User-Agent": "atc (live airport visualisation)", Accept: "application/json" },
  });
  // 204 is the API's "no recent report for that station".
  if (!res.ok || res.status === 204) throw new Error(`metar: ${res.status}`);
  return res.json();
};

/** The current report for one listed airport; the request names its ICAO code and nothing else. */
export async function fetchMetar(airport: Airport, get: Fetcher = defaultFetcher): Promise<Metar> {
  return parseMetarResponse(await get(metarUrl(airport.icao)), airport.icao);
}

/** "270° 15 kt, gusts 28", "Variable 3 kt", "Calm"; `short` for a phone. */
export function describeWind(wind: Wind, { short = false }: { short?: boolean } = {}): string {
  if (wind.speedKt === 0) return "Calm";
  // Short, for a phone: "VRB 3 kt", no gusts.
  const gust = wind.gustKt && !short ? `, gusts ${wind.gustKt}` : "";
  if (wind.directionDeg === null) return `${short ? "VRB" : "Variable"} ${wind.speedKt} kt${gust}`;
  return `${String(wind.directionDeg).padStart(3, "0")}° ${wind.speedKt} kt${gust}`;
}

/** Visibility as US reports give it: "10 SM", "1 1/2 SM", "< 1/4 SM". */
export function formatVisibility(metres: number): string {
  const miles = metres / SM;
  if (miles >= 9.5) return "10 SM";
  if (miles >= 3) return `${Math.round(miles)} SM`;
  const quarters = Math.round(miles * 4);
  if (quarters < 1) return "< 1/4 SM";
  const whole = Math.floor(quarters / 4);
  const fraction = ["", "1/4", "1/2", "3/4"][quarters % 4];
  return `${[whole || null, fraction || null].filter(Boolean).join(" ")} SM`;
}

/** The weather in two phrases at most, most important first ("Thunderstorm, heavy rain"); null when there is none. */
export function describeWeather(m: Metar): string | null {
  const words: string[] = [];
  if (m.thunder) words.push("Thunderstorm");
  if (m.precipitation) {
    const { kind, intensity } = m.precipitation;
    words.push(intensity === "moderate" ? kind : `${intensity} ${kind}`);
  }
  if (m.fog) words.push("fog");
  else if (m.mist) words.push("mist");
  else if (m.haze) words.push("haze");
  if (!words.length) return null;
  // Two at most, so the readout stays one short line.
  const text = words.slice(0, 2).join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
