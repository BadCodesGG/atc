/**
 * Where the sun is in the sky over a place at a moment: NOAA's solar position algorithm (the one in
 * its solar calculator spreadsheet, after Meeus), good to a fraction of a degree for centuries either
 * side of 2000, which is far finer than a shadow on the model can show.
 */

export interface SunPosition {
  /** Degrees clockwise from true north, 0 to 360. */
  azimuthDeg: number;
  /** Degrees above the horizon, refraction included; negative below it. */
  elevationDeg: number;
}

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const cos = (deg: number) => Math.cos(deg * RAD);
const tan = (deg: number) => Math.tan(deg * RAD);

/** The sun's position at `timeMs` (UTC milliseconds) seen from `latitude`, `longitude` (degrees, east positive). */
export function sunPosition(timeMs: number, latitude: number, longitude: number): SunPosition {
  const julianDay = timeMs / 86_400_000 + 2_440_587.5;
  const t = (julianDay - 2_451_545) / 36_525;
  const meanLongitude = (((280.46646 + t * (36_000.76983 + t * 0.0003032)) % 360) + 360) % 360;
  const meanAnomaly = 357.52911 + t * (35_999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    sin(meanAnomaly) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * meanAnomaly) * (0.019993 - 0.000101 * t) + sin(3 * meanAnomaly) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const apparentLongitude = meanLongitude + centre - 0.00569 - 0.00478 * sin(omega);
  const meanObliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * cos(omega);
  const declination = Math.asin(sin(obliquity) * sin(apparentLongitude)) / RAD;

  const y = tan(obliquity / 2) ** 2;
  const equationOfTime =
    (4 / RAD) *
    (y * sin(2 * meanLongitude) -
      2 * eccentricity * sin(meanAnomaly) +
      4 * eccentricity * y * sin(meanAnomaly) * cos(2 * meanLongitude) -
      0.5 * y * y * sin(4 * meanLongitude) -
      1.25 * eccentricity * eccentricity * sin(2 * meanAnomaly));

  const minutesOfDay = ((timeMs % 86_400_000) + 86_400_000) % 86_400_000 / 60_000;
  const trueSolarTime = (((minutesOfDay + equationOfTime + 4 * longitude) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 - 180;

  const cosZenith = Math.min(1, Math.max(-1, sin(latitude) * sin(declination) + cos(latitude) * cos(declination) * cos(hourAngle)));
  const zenith = Math.acos(cosZenith) / RAD;
  const azimuth = Math.atan2(sin(hourAngle), cos(hourAngle) * sin(latitude) - tan(declination) * cos(latitude)) / RAD + 180;
  const elevation = 90 - zenith;
  return { azimuthDeg: ((azimuth % 360) + 360) % 360, elevationDeg: elevation + refraction(elevation) };
}

/** NOAA's approximation of atmospheric refraction, degrees, for a geometric elevation. */
function refraction(elevation: number): number {
  if (elevation > 85) return 0;
  const te = tan(elevation);
  const arcSeconds =
    elevation > 5
      ? 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5
      : elevation > -0.575
        ? 1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))
        : -20.772 / te;
  return arcSeconds / 3600;
}

const partsFormat = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock fields of `timeMs` in `timeZone`. */
function wallClock(timeMs: number, timeZone: string) {
  let format = partsFormat.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    partsFormat.set(timeZone, format);
  }
  const f: Record<string, number> = {};
  for (const p of format.formatToParts(timeMs)) if (p.type !== "literal") f[p.type] = Number(p.value);
  return f as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/**
 * The moment that is `hhmm` ("08:30") on the clocks of `timeZone`, on the local day `timeMs` falls on
 * there: for showing the airport at a chosen time of day. Null when `hhmm` is not a time of day.
 */
export function localTimeAt(timeMs: number, hhmm: string, timeZone: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  const { year, month, day } = wallClock(timeMs, timeZone);
  const wanted = Date.UTC(year, month - 1, day, Number(m[1]), Number(m[2]));
  // Guess with the zone's offset at the wanted wall time, then correct once for a change of offset.
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const w = wallClock(guess, timeZone);
    guess += wanted - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  }
  return guess;
}
