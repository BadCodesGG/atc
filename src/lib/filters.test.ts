import { describe, expect, it } from "vitest";
import {
  altitudeBandOf,
  chosenCount,
  describeFilters,
  type Filters,
  filterOptions,
  filtersActive,
  Ghosts,
  groundStateOf,
  matches,
  NO_FILTERS,
  readFilters,
  rememberSeen,
  snapshotSubject,
  speedBandOf,
  toggleFilter,
  withFilters,
} from "./filters";

const only = (extra: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...extra });

describe("matches", () => {
  it("passes everything when no filter is set", () => {
    expect(matches(NO_FILTERS, { callsign: "DAL3104" })).toBe(true);
    expect(matches(NO_FILTERS, { callsign: null })).toBe(true);
  });

  it("passes an aircraft whose callsign carries a chosen airline's prefix, and no other", () => {
    const f = only({ airlines: ["DAL", "UAL"] });
    expect(matches(f, { callsign: "DAL3104" })).toBe(true);
    expect(matches(f, { callsign: "UAL12" })).toBe(true);
    expect(matches(f, { callsign: "RPA4349" })).toBe(false);
  });

  it("filters out an aircraft with no airline callsign while an airline is chosen", () => {
    expect(matches(only({ airlines: ["DAL"] }), { callsign: "N744WG" })).toBe(false);
    expect(matches(only({ airlines: ["DAL"] }), { callsign: null })).toBe(false);
  });

  it("groups types by family: any 737 passes the Boeing 737 choice", () => {
    const f = only({ types: ["B737"] });
    expect(matches(f, { callsign: null, typeCode: "B738" })).toBe(true);
    expect(matches(f, { callsign: null, typeCode: "B39M" })).toBe(true);
    expect(matches(f, { callsign: null, typeCode: "A321" })).toBe(false);
    expect(matches(f, { callsign: null, typeCode: null })).toBe(false);
  });

  it("passes a type outside the table by its own code", () => {
    expect(matches(only({ types: ["C172"] }), { callsign: null, typeCode: "C172" })).toBe(true);
  });

  it("passes the ground states chosen, and an aircraft with no known state passes none", () => {
    const f = only({ states: ["taxiing", "holding"] });
    expect(matches(f, { callsign: null, state: "taxiing" })).toBe(true);
    expect(matches(f, { callsign: null, state: "holding" })).toBe(true);
    expect(matches(f, { callsign: null, state: "gate" })).toBe(false);
    expect(matches(f, { callsign: null })).toBe(false);
  });

  it("passes the altitude bands chosen", () => {
    const f = only({ altitudes: ["low", "ground"] });
    expect(matches(f, { callsign: null, onGround: true, altitudeFt: 0 })).toBe(true);
    expect(matches(f, { callsign: null, onGround: false, altitudeFt: 3000 })).toBe(true);
    expect(matches(f, { callsign: null, onGround: false, altitudeFt: 12000 })).toBe(false);
    expect(matches(f, { callsign: null, onGround: false, altitudeFt: null })).toBe(false);
  });

  it("passes the speed bands chosen, and an unknown speed passes none", () => {
    const f = only({ speeds: ["fast"] });
    expect(matches(f, { callsign: null, speedKt: 250 })).toBe(true);
    expect(matches(f, { callsign: null, speedKt: 150 })).toBe(false);
    expect(matches(f, { callsign: null, speedKt: null })).toBe(false);
  });

  it("passes the origins and destinations chosen", () => {
    expect(matches(only({ origins: ["SRQ"] }), { callsign: null, origin: "SRQ", destination: "ATL" })).toBe(true);
    expect(matches(only({ origins: ["SRQ"] }), { callsign: null, origin: "JFK", destination: "ATL" })).toBe(false);
    expect(matches(only({ destinations: ["ATL"] }), { callsign: null, origin: "SRQ", destination: "ATL" })).toBe(true);
    expect(matches(only({ destinations: ["ATL"] }), { callsign: null, origin: "SRQ", destination: null })).toBe(false);
  });

  it("passes only military aircraft with military on", () => {
    expect(matches(only({ military: true }), { callsign: null, military: true })).toBe(true);
    expect(matches(only({ military: true }), { callsign: null, military: false })).toBe(false);
    expect(matches(only({ military: true }), { callsign: null })).toBe(false);
  });

  it("needs every field that is set to agree", () => {
    const f = only({ airlines: ["DAL"], states: ["taxiing"] });
    expect(matches(f, { callsign: "DAL1", state: "taxiing" })).toBe(true);
    expect(matches(f, { callsign: "DAL1", state: "gate" })).toBe(false);
    expect(matches(f, { callsign: "UAL1", state: "taxiing" })).toBe(false);
  });
});

describe("bands", () => {
  it("puts an altitude in a band at its edges", () => {
    expect(altitudeBandOf({ onGround: true, altitudeFt: 0 })).toBe("ground");
    expect(altitudeBandOf({ onGround: false, altitudeFt: 4999 })).toBe("low");
    expect(altitudeBandOf({ onGround: false, altitudeFt: 5000 })).toBe("mid");
    expect(altitudeBandOf({ onGround: false, altitudeFt: 24999 })).toBe("mid");
    expect(altitudeBandOf({ onGround: false, altitudeFt: 25000 })).toBe("high");
  });

  it("puts a speed in a band at its edges", () => {
    expect(speedBandOf({ speedKt: 39 })).toBe("slow");
    expect(speedBandOf({ speedKt: 40 })).toBe("mid");
    expect(speedBandOf({ speedKt: 199 })).toBe("mid");
    expect(speedBandOf({ speedKt: 200 })).toBe("fast");
    expect(speedBandOf({ speedKt: 399 })).toBe("fast");
    expect(speedBandOf({ speedKt: 400 })).toBe("jet");
  });
});

describe("groundStateOf", () => {
  it("names a parked aircraft at the gate, and a stopped one off the gates holding", () => {
    expect(groundStateOf({ state: "parked", activity: "At gate E15" })).toBe("gate");
    expect(groundStateOf({ state: "taxiing", activity: "Holding" })).toBe("holding");
    expect(groundStateOf({ state: "taxiing", activity: "Taxiing" })).toBe("taxiing");
    expect(groundStateOf({ state: "taxiing", activity: "Crossing runway 9R" })).toBe("taxiing");
  });

  it("keeps departing and arriving as they are, in the air and on the runway", () => {
    expect(groundStateOf({ state: "departing", activity: "Lined up" })).toBe("departing");
    expect(groundStateOf({ state: "arriving", activity: "Final approach" })).toBe("arriving");
  });
});

describe("readFilters", () => {
  it("reads a comma separated airline list in any case", () => {
    expect(readFilters({ airline: "dal,UAL" }).airlines).toEqual(["DAL", "UAL"]);
  });

  it("drops entries that are not valid, repeats, and anything past the limit", () => {
    expect(readFilters({ airline: "DAL,,DA,DAL,12A,UAL;x, AAL " }).airlines).toEqual(["AAL", "DAL"]);
    const many = Array.from({ length: 40 }, (_, i) => `A${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`).join(",");
    expect(readFilters({ airline: many }).airlines.length).toBe(12);
  });

  it("takes the first of a repeated parameter and nothing from a missing one", () => {
    expect(readFilters({ airline: ["UAL", "DAL"] }).airlines).toEqual(["UAL"]);
    expect(readFilters({})).toEqual(NO_FILTERS);
  });

  it("reads every other field, keeping the fixed ones in their own order and dropping unknown words", () => {
    const f = readFilters({ type: "b737,a320,!!", state: "arriving,taxiing,flying", alt: "high,LOW", speed: "jet,slow", from: "srq", to: "atl,jfk", mil: "1" });
    expect(f).toEqual({ airlines: [], types: ["A320", "B737"], states: ["taxiing", "arriving"], altitudes: ["low", "high"], speeds: ["slow", "jet"], origins: ["SRQ"], destinations: ["ATL", "JFK"], military: true });
  });

  it("reads military only from 1", () => {
    expect(readFilters({ mil: "0" }).military).toBe(false);
    expect(readFilters({ mil: "true" }).military).toBe(false);
  });
});

describe("withFilters", () => {
  it("writes the filters into the address, keeping every other parameter and the hash", () => {
    const url = withFilters("http://x.test/?airport=jfk&theme=dark#map=3/1/2", only({ airlines: ["UAL", "DAL"] }));
    expect(url.searchParams.get("airline")).toBe("DAL,UAL");
    expect(url.searchParams.get("airport")).toBe("jfk");
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.hash).toBe("#map=3/1/2");
  });

  it("removes every parameter when nothing is filtered", () => {
    expect(withFilters("http://x.test/?airline=DAL&type=B737&state=gate&alt=low&speed=slow&from=SRQ&to=ATL&mil=1", NO_FILTERS).search).toBe("");
  });

  it("round trips every field through readFilters", () => {
    const f: Filters = { airlines: ["AAL", "SWA"], types: ["A320", "CRJ"], states: ["gate", "holding"], altitudes: ["ground", "mid"], speeds: ["fast"], origins: ["SRQ"], destinations: ["ATL", "JFK"], military: true };
    expect(readFilters(Object.fromEntries(withFilters("http://x.test/", f).searchParams))).toEqual(f);
  });
});

describe("toggleFilter", () => {
  it("adds a choice in its field's order, and removes one chosen again", () => {
    const one = toggleFilter(NO_FILTERS, "airlines", "UAL");
    expect(one.airlines).toEqual(["UAL"]);
    const two = toggleFilter(one, "airlines", "DAL");
    expect(two.airlines).toEqual(["DAL", "UAL"]);
    expect(toggleFilter(two, "airlines", "UAL").airlines).toEqual(["DAL"]);
  });

  it("keeps a fixed field in its own order", () => {
    const f = toggleFilter(toggleFilter(NO_FILTERS, "states", "arriving"), "states", "gate");
    expect(f.states).toEqual(["gate", "arriving"]);
  });

  it("leaves the other fields alone", () => {
    expect(toggleFilter(only({ military: true }), "types", "B737")).toEqual(only({ military: true, types: ["B737"] }));
  });
});

describe("chosenCount and filtersActive", () => {
  it("counts every choice, military as one, and is active only when something is chosen", () => {
    expect(chosenCount(NO_FILTERS)).toBe(0);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    const f = only({ airlines: ["DAL", "UAL"], states: ["gate"], military: true });
    expect(chosenCount(f)).toBe(4);
    expect(filtersActive(f)).toBe(true);
  });
});

describe("filterOptions", () => {
  const subject = (callsign: string | null, typeCode: string | null, origin: string | null, destination: string | null) => ({ callsign, typeCode, origin, destination });

  it("lists the airlines in the traffic, the busiest first, with their names", () => {
    const { airlines } = filterOptions([subject("DAL1", null, null, null), subject("DAL2", null, null, null), subject("RPA9", null, null, null), subject("DAL3", null, null, null), subject("UAL4", null, null, null), subject("UAL5", null, null, null), subject("N1", null, null, null), subject(null, null, null, null)], NO_FILTERS);
    expect(airlines).toEqual([
      { key: "DAL", name: "Delta", count: 3 },
      { key: "UAL", name: "United", count: 2 },
      { key: "RPA", name: "Republic", count: 1 },
    ]);
  });

  it("names an unknown airline by its code and breaks ties by name", () => {
    expect(filterOptions([subject("ZZZ1", null, null, null), subject("AAL1", null, null, null)], NO_FILTERS).airlines.map((o) => o.name)).toEqual(["American", "ZZZ"]);
  });

  it("groups types into families with the card's names", () => {
    const { types } = filterOptions([subject(null, "B738", null, null), subject(null, "B39M", null, null), subject(null, "A321", null, null), subject(null, null, null, null)], NO_FILTERS);
    expect(types).toEqual([
      { key: "B737", name: "Boeing 737", count: 2 },
      { key: "A320", name: "Airbus A320 family", count: 1 },
    ]);
  });

  it("lists origins and destinations from the routes", () => {
    const o = filterOptions([subject(null, null, "SRQ", "ATL"), subject(null, null, "SRQ", "ATL"), subject(null, null, "ATL", "JFK")], NO_FILTERS);
    expect(o.origins).toEqual([
      { key: "SRQ", name: "SRQ", count: 2 },
      { key: "ATL", name: "ATL", count: 1 },
    ]);
    expect(o.destinations.map((d) => d.key)).toEqual(["ATL", "JFK"]);
  });

  it("keeps a chosen value listed with a count of zero while none of it is in the traffic", () => {
    expect(filterOptions([subject("DAL1", null, null, null)], only({ airlines: ["UAL"] })).airlines).toEqual([
      { key: "DAL", name: "Delta", count: 1 },
      { key: "UAL", name: "United", count: 0 },
    ]);
  });
});

describe("describeFilters", () => {
  it("says what is chosen in one line, by name", () => {
    expect(describeFilters(only({ airlines: ["DAL", "UAL"], states: ["taxiing"], military: true }))).toBe("Delta, United · Taxiing · Military");
    expect(describeFilters(only({ types: ["B737"], altitudes: ["low"], speeds: ["jet"], origins: ["SRQ"], destinations: ["ATL"] }))).toBe("Boeing 737 · Under 5,000 ft · Over 400 kt · from SRQ · to ATL");
  });

  it("is empty when nothing is chosen", () => {
    expect(describeFilters(NO_FILTERS)).toBe("");
  });
});

describe("snapshotSubject", () => {
  it("reads a subject's lazy fields now, so what it holds no longer depends on the card behind them", () => {
    let reads = 0;
    const live = {
      callsign: "DAL1",
      get origin() {
        reads++;
        return reads > 1 ? "CHANGED" : "SRQ";
      },
    };
    const kept = snapshotSubject(live);
    expect(kept.origin).toBe("SRQ");
    expect(kept.origin).toBe("SRQ");
  });
});

describe("rememberSeen", () => {
  const seen = (...ids: string[]) => ids.map((id) => ({ id, subject: { callsign: id } }));

  it("forgets the least recently seen beyond the cap, not the first ever seen: an aircraft still in view is kept", () => {
    const held = new Map<string, { callsign: string | null }>();
    rememberSeen(held, seen("a", "b", "c"), 3);
    // "a" is in view again, then "d" arrives: "b" is the one not seen for longest.
    rememberSeen(held, seen("a", "d"), 3);
    expect([...held.keys()]).toEqual(["c", "a", "d"]);
  });

  it("keeps the newest subject of an aircraft it already held", () => {
    const held = new Map<string, { callsign: string | null }>();
    rememberSeen(held, [{ id: "a", subject: { callsign: "OLD" } }], 3);
    rememberSeen(held, [{ id: "a", subject: { callsign: "NEW" } }], 3);
    expect(held.get("a")).toEqual({ callsign: "NEW" });
    expect(held.size).toBe(1);
  });
});

describe("Ghosts", () => {
  it("starts an aircraft first seen at where it is going, so nothing fades in from nowhere", () => {
    const g = new Ghosts();
    expect(g.track("a", true, 0.1)).toBe(1);
    expect(g.track("b", false, 0.1)).toBe(0);
  });

  it("eases toward its target by the step and stops there", () => {
    const g = new Ghosts();
    g.track("a", false, 0.25);
    g.sweep();
    expect(g.track("a", true, 0.25)).toBeCloseTo(0.25);
    g.sweep();
    expect(g.track("a", true, 0.25)).toBeCloseTo(0.5);
    g.sweep();
    g.track("a", true, 0.25);
    g.sweep();
    expect(g.track("a", true, 0.25)).toBeCloseTo(1);
    g.sweep();
    expect(g.track("a", false, 0.25)).toBeCloseTo(0.75);
  });

  it("forgets an aircraft that was not tracked in the last sweep", () => {
    const g = new Ghosts();
    g.track("a", true, 0.25);
    g.sweep();
    g.sweep();
    g.sweep();
    expect(g.track("a", false, 0.25)).toBe(0);
  });
});
