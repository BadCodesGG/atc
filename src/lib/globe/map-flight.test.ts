import { describe, expect, it } from "vitest";
import { lostNote, type MapFlight, mapFlightCard, markLost } from "./map-flight";

const flight: MapFlight = {
  id: "a0540a",
  callsign: "DAL1601",
  typeCode: "A321",
  altitudeFt: 30_000,
  onGround: false,
  speedKt: 485,
  headingDeg: 257,
  verticalRateFpm: 0,
  route: { origin: { code: "ATL", city: "Atlanta", country: "US" }, destination: { code: "DFW", city: "Dallas-Fort Worth", country: "US" } },
  estimated: true,
  lostAt: null,
};

describe("mapFlightCard", () => {
  it("prints what the diorama's card prints, from what the map knows", () => {
    expect(mapFlightCard(flight)).toMatchObject({
      id: "a0540a",
      callsign: "DAL1601",
      operator: "Delta · Airbus A321",
      speed: "485 kt",
      heading: "257°",
      altitude: "FL300",
      direction: "outbound",
      state: "parked",
    });
  });

  it("colours the badge by the phase, as the journey's card does", () => {
    expect(mapFlightCard({ ...flight, verticalRateFpm: 2000 }).state).toBe("departing");
    expect(mapFlightCard({ ...flight, verticalRateFpm: -2000 }).state).toBe("arriving");
  });

  it("keeps the last figures of a lost flight, with a neutral badge", () => {
    const lost = markLost({ ...flight, verticalRateFpm: 2000 }, 1_700_000_000_000);
    expect(mapFlightCard(lost)).toMatchObject({ speed: "485 kt", altitude: "FL300", state: "parked" });
  });

  it("falls back on the hex for a callsign, and says nothing of what it does not know", () => {
    const card = mapFlightCard({ ...flight, callsign: null, typeCode: null, speedKt: null, headingDeg: null, route: null, altitudeFt: 4_300 });
    expect(card).toMatchObject({ callsign: "A0540A", operator: "", speed: "—", heading: "—", altitude: "4,300 ft", route: null, direction: null });
  });
});

describe("markLost", () => {
  it("stamps when the aircraft left the feed, once: a later call keeps the first time", () => {
    const lost = markLost(flight, 1000);
    expect(lost).toMatchObject({ lostAt: 1000, callsign: "DAL1601" });
    expect(markLost(lost, 5000)).toBe(lost);
    expect(flight.lostAt).toBeNull();
  });

  it("says when it was last seen, only once it is lost, on the clock it is handed", () => {
    // The time bar's clock: the airport's own time zone, whatever the reader's is.
    const atlanta = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York" });
    expect(lostNote(flight, atlanta)).toBeNull();
    // 18:25 UTC on 1 October is 14:25 in Atlanta (EDT).
    expect(lostNote(markLost(flight, Date.UTC(2026, 9, 1, 18, 25)), atlanta)).toBe("Not in the feed now. Last seen 14:25.");
  });
});
