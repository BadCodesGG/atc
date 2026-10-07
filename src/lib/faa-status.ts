/**
 * What the FAA's Command Center says is slowing an airport down, from its public NAS status feed
 * (no key, XML): ground stops, ground delay programs, and general departure and arrival delays. This
 * is airport-wide, not per flight: a flight's own delay needs a schedule, which no free feed gives.
 */

export const FAA_STATUS_URL = "https://nasstatus.faa.gov/api/airport-status-information";

export type ProgramKind = "ground-stop" | "ground-delay" | "departure" | "arrival" | "closure";

export interface Program {
  kind: ProgramKind;
  /** "Ground stop until 9:00 pm EDT", "Departures 16–30 min, increasing". */
  summary: string;
  /** "Weather: low ceilings", or null. */
  reason: string | null;
}

export interface NasStatus {
  /** UTC milliseconds the FAA last updated the feed, or null. */
  updated: number | null;
  /** The programs in force, by upper-case FAA airport code ("ATL"); an airport not listed has none. */
  airports: Record<string, Program[]>;
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decode(m[1].trim()) : null;
};

const blocks = (xml: string, name: string): string[] => [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "g"))].map((m) => m[0]);

const decode = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** "16 minutes" to "16 min", "2 hours and 9 minutes" to "2 h 9 min". */
const short = (s: string | null) => (s ? s.replace(/\s*hours?\s*(and)?\s*/g, " h ").replace(/\s*minutes?/g, " min").replace(/\s+/g, " ").trim() : null);

/** "WX:Low Ceilings" to "Weather: low ceilings"; "VOL:Volume" to "Volume". */
function reasonOf(raw: string | null): string | null {
  if (!raw) return null;
  const [code, ...rest] = raw.split(":");
  const text = rest.join(":").trim();
  if (!text) return raw;
  const lower = text.charAt(0) + text.slice(1).toLowerCase();
  return /^(WX|WEATHER)$/i.test(code.trim()) ? `Weather: ${lower.toLowerCase()}` : lower;
}

/** "Thu Oct 1 01:24:53 2026 GMT", which Date.parse reads in every engine this runs on. */
function updatedAt(raw: string | null): number | null {
  if (!raw) return null;
  const t = Date.parse(raw.replace(/\s+GMT$/, " UTC").replace(/^(\w{3}) (\w{3}) (\d{1,2}) ([\d:]+) (\d{4})/, "$1, $3 $2 $5 $4"));
  return Number.isFinite(t) ? t : null;
}

/**
 * The programs in force at every airport in the feed's XML. Closures are left out: at airline
 * airports they are NOTAMs about private aircraft, not about the flights on the board.
 */
export function parseStatus(xml: string): NasStatus {
  if (!xml.includes("<AIRPORT_STATUS_INFORMATION")) throw new Error("faa: not a status document");
  const airports: Record<string, Program[]> = {};
  for (const type of blocks(xml, "Delay_type")) {
    const name = tag(type, "Name") ?? "";
    if (/closure/i.test(name)) continue;
    for (const item of [...blocks(type, "Delay"), ...blocks(type, "Ground_Delay"), ...blocks(type, "Program")]) {
      const code = tag(item, "ARPT")?.toUpperCase();
      if (!code || !/^[A-Z0-9]{3,4}$/.test(code)) continue;
      const programs = (airports[code] ??= []);
      const reason = reasonOf(tag(item, "Reason"));
      if (/ground stop/i.test(name)) {
        const end = tag(item, "End_Time")?.replace(/\.$/, "");
        programs.push({ kind: "ground-stop", summary: end ? `Ground stop until ${end}` : "Ground stop", reason });
      } else if (/ground delay/i.test(name)) {
        const avg = short(tag(item, "Avg"));
        const max = short(tag(item, "Max"));
        const parts = [avg && `average ${avg}`, max && `up to ${max}`].filter(Boolean).join(", ");
        programs.push({ kind: "ground-delay", summary: parts ? `Ground delay program, ${parts}` : "Ground delay program", reason });
      } else {
        for (const ad of blocks(item, "Arrival_Departure")) {
          const kind = /Type="Arrival"/i.test(ad) ? "arrival" : "departure";
          const min = short(tag(ad, "Min"));
          const max = short(tag(ad, "Max"));
          const trend = tag(ad, "Trend")?.toLowerCase();
          const range = min && max ? `${min.replace(/ min$/, "")}–${max}` : (max ?? min);
          const head = kind === "arrival" ? "Arrivals" : "Departures";
          programs.push({ kind, summary: [range ? `${head} delayed ${range}` : `${head} delayed`, trend].filter(Boolean).join(", "), reason });
        }
      }
    }
  }
  return { updated: updatedAt(tag(xml, "Update_Time")), airports };
}

type Fetcher = (url: string) => Promise<string>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
    headers: { "User-Agent": "atc (live airport visualisation)", Accept: "application/xml" },
  });
  if (!res.ok) throw new Error(`faa: ${res.status}`);
  return res.text();
};

export async function fetchStatus(get: Fetcher = defaultFetcher): Promise<NasStatus> {
  return parseStatus(await get(FAA_STATUS_URL));
}

/** A program at one end of a flight's route, with the airport it is at. */
export interface FlightProgram extends Program {
  airport: string;
}

/**
 * The FAA's code for a US airport given by IATA ("PHX") or ICAO code: the feed keys on the three-letter
 * one, and a US ICAO code is that with a K (or, in Alaska, Hawaii and the Pacific, a P) in front.
 */
export function faaCode(code: string): string {
  const c = code.toUpperCase();
  return /^[KP][A-Z0-9]{3}$/.test(c) ? c.slice(1) : c;
}

const AT_ORIGIN: ProgramKind[] = ["departure"];
/** A ground stop or ground delay program at an airport holds the flights bound for it, wherever they are. */
const AT_DESTINATION: ProgramKind[] = ["ground-stop", "ground-delay", "arrival"];

/**
 * The programs that bear on one flight: departure delays where it leaves from, and ground stops,
 * ground delay programs and arrival delays where it is going. `here` is the airport on screen; `other`
 * is the far end of the route when it is known and in the US (the FAA covers no other). With no
 * direction, everything at `here` counts.
 */
export function programsFor(
  status: NasStatus,
  here: string,
  direction: "outbound" | "inbound" | null,
  other: string | null,
): { programs: FlightProgram[]; checked: string[] } {
  const at = (code: string, kinds: ProgramKind[] | null) =>
    (status.airports[code.toUpperCase()] ?? []).filter((p) => !kinds || kinds.includes(p.kind)).map((p) => ({ ...p, airport: code.toUpperCase() }));
  const h = faaCode(here);
  const far = other && faaCode(other);
  if (direction === "outbound") return { programs: [...at(h, AT_ORIGIN), ...(far ? at(far, AT_DESTINATION) : [])], checked: far ? [h, far] : [h] };
  if (direction === "inbound") return { programs: at(h, AT_DESTINATION), checked: [h] };
  return { programs: at(h, null), checked: [h] };
}
