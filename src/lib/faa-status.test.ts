import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAA_STATUS_URL, faaCode, fetchStatus, parseStatus, programsFor } from "./faa-status";

/** A real document, saved from the feed on 2026-10-01 (ORD departure delays, closures elsewhere). */
const real = readFileSync(path.join(__dirname, "__fixtures__", "faa_status.xml"), "utf8");

/** Every program kind at once, in the feed's own element names (fly.faa.gov/AirportStatus.dtd). */
const every = `<AIRPORT_STATUS_INFORMATION><Update_Time>Thu Oct 1 01:24:53 2026 GMT</Update_Time>
<Delay_type><Name>Ground Stop Programs</Name><Ground_Stop_List><Program><ARPT>EWR</ARPT><Reason>WX:Thunderstorms</Reason><End_Time>9:00 pm EDT.</End_Time></Program></Ground_Stop_List></Delay_type>
<Delay_type><Name>Ground Delay Programs</Name><Ground_Delay_List><Ground_Delay><ARPT>SFO</ARPT><Reason>WX:Low Ceilings</Reason><Avg>57 minutes</Avg><Max>2 hours and 9 minutes</Max></Ground_Delay></Ground_Delay_List></Delay_type>
<Delay_type><Name>General Arrival/Departure Delay Info</Name><Arrival_Departure_Delay_List>
<Delay><ARPT>ATL</ARPT><Reason>VOL:Volume</Reason><Arrival_Departure Type="Departure"><Min>16 minutes</Min><Max>30 minutes</Max><Trend>Increasing</Trend></Arrival_Departure></Delay>
<Delay><ARPT>ATL</ARPT><Reason>WX:Wind</Reason><Arrival_Departure Type="Arrival"><Min>31 minutes</Min><Max>45 minutes</Max><Trend>Decreasing</Trend></Arrival_Departure></Delay>
</Arrival_Departure_Delay_List></Delay_type>
<Delay_type><Name>Airport Closures</Name><Airport_Closure_List><Airport><ARPT>ATL</ARPT><Reason>!ATL CLSD TO GA</Reason></Airport></Airport_Closure_List></Delay_type>
</AIRPORT_STATUS_INFORMATION>`;

describe("parseStatus", () => {
  it("reads a real FAA document", () => {
    const status = parseStatus(real);
    expect(status.updated).not.toBeNull();
    expect(new Date(status.updated!).getUTCFullYear()).toBe(2026);
    expect(status.airports.ORD?.[0]).toMatchObject({ kind: "departure", reason: "Weather: low ceilings" });
    expect(status.airports.ORD?.[0].summary).toMatch(/^Departures delayed 16–30 min/);
    // Its closures (LAX, SAN, PHL) are left out.
    expect(status.airports.LAX).toBeUndefined();
  });

  it("reads every kind of program, in plain words", () => {
    const { airports, updated } = parseStatus(every);
    expect(updated).toBe(Date.UTC(2026, 9, 1, 1, 24, 53));
    expect(airports.EWR).toEqual([{ kind: "ground-stop", summary: "Ground stop until 9:00 pm EDT", reason: "Weather: thunderstorms" }]);
    expect(airports.SFO).toEqual([{ kind: "ground-delay", summary: "Ground delay program, average 57 min, up to 2 h 9 min", reason: "Weather: low ceilings" }]);
    expect(airports.ATL).toEqual([
      { kind: "departure", summary: "Departures delayed 16–30 min, increasing", reason: "Volume" },
      { kind: "arrival", summary: "Arrivals delayed 31–45 min, decreasing", reason: "Weather: wind" },
    ]);
  });

  it("throws on anything that is not the status document", () => {
    expect(() => parseStatus("<html>maintenance</html>")).toThrow();
  });

  it("fetches the fixed URL", async () => {
    let asked = "";
    await fetchStatus(async (url) => {
      asked = url;
      return every;
    });
    expect(asked).toBe(FAA_STATUS_URL);
  });
});

describe("programsFor", () => {
  const status = parseStatus(every);

  it("an outbound flight: departure delays here, and what holds flights bound for its destination", () => {
    const { programs, checked } = programsFor(status, "atl", "outbound", "EWR");
    expect(programs.map((p) => `${p.airport} ${p.kind}`)).toEqual(["ATL departure", "EWR ground-stop"]);
    expect(checked).toEqual(["ATL", "EWR"]);
  });

  it("an inbound flight: only what bears on arrivals here", () => {
    expect(programsFor(status, "atl", "inbound", null).programs.map((p) => p.kind)).toEqual(["arrival"]);
  });

  it("no direction: everything here", () => {
    expect(programsFor(status, "atl", null, null).programs).toHaveLength(2);
  });

  it("finds a far end given only by its ICAO code under the FAA's three-letter one", () => {
    const { programs, checked } = programsFor(status, "atl", "outbound", "KEWR");
    expect(programs.map((p) => `${p.airport} ${p.kind}`)).toEqual(["ATL departure", "EWR ground-stop"]);
    expect(checked).toEqual(["ATL", "EWR"]);
    expect([faaCode("PHNL"), faaCode("KOA"), faaCode("phx"), faaCode("CYUL")]).toEqual(["HNL", "KOA", "PHX", "CYUL"]);
  });

  it("an airport with nothing says which airports were checked", () => {
    expect(programsFor(status, "pit", "outbound", "BOS")).toEqual({ programs: [], checked: ["PIT", "BOS"] });
  });
});
