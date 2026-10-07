import { describe, expect, it } from "vitest";
import { type Alert, AlertDetector, inBounds, type Sighting } from "./alerts";

/** One aircraft as the feed reports it, parked at a gate near Atlanta unless said otherwise. */
function plane(over: Partial<Sighting> = {}): Sighting {
  return { id: "a1b2c3", callsign: "DAL100", typeCode: "A321", squawk: "1200", military: false, onGround: true, groundSpeedKt: 0, latitude: 33.64, longitude: -84.43, ...over };
}

const NONE: ReadonlySet<string> = new Set();
const WATCH: ReadonlySet<string> = new Set(["a1b2c3"]);

/** A detector fed one list per poll, five seconds apart, collecting what it says. */
function run(detector = new AlertDetector(), start = 1000) {
  let t = start;
  const said: Alert[] = [];
  return {
    detector,
    said,
    /** The time the next poll will carry. */
    get now() {
      return t;
    },
    poll(list: Sighting[], watched: ReadonlySet<string> = WATCH, step = 5) {
      t += step;
      const out = detector.observe(t, list, watched);
      said.push(...out);
      return out;
    },
  };
}

const kinds = (alerts: Alert[]) => alerts.map((a) => a.kind);

describe("a followed flight takes off", () => {
  it("is said once, when it has been seen in the air twice, not on every poll after", () => {
    const r = run();
    r.poll([plane()]);
    expect(r.poll([plane({ onGround: false, groundSpeedKt: 150 })])).toEqual([]);
    expect(kinds(r.poll([plane({ onGround: false, groundSpeedKt: 160 })]))).toEqual(["takeoff"]);
    for (let i = 0; i < 10; i++) expect(r.poll([plane({ onGround: false, groundSpeedKt: 250 })])).toEqual([]);
    expect(kinds(r.said)).toEqual(["takeoff"]);
    expect(r.said[0]).toMatchObject({ id: "a1b2c3", title: "DAL100 has taken off" });
  });

  it("is not said for an aircraft nobody follows", () => {
    const r = run();
    r.poll([plane()], NONE);
    r.poll([plane({ onGround: false })], NONE);
    r.poll([plane({ onGround: false })], NONE);
    expect(r.said).toEqual([]);
  });

  it("is not said for one first seen in the air", () => {
    const r = run();
    for (let i = 0; i < 4; i++) r.poll([plane({ onGround: false, groundSpeedKt: 300 })]);
    expect(r.said).toEqual([]);
  });

  it("is not said for one poll of a position that jumps off the ground and back", () => {
    const r = run();
    r.poll([plane()]);
    r.poll([plane({ onGround: false })]);
    r.poll([plane()]);
    r.poll([plane()]);
    expect(r.said).toEqual([]);
  });
});

describe("a followed flight lands", () => {
  it("is said once, when it has been seen on the ground twice after the air", () => {
    const r = run();
    r.poll([plane({ onGround: false, groundSpeedKt: 140 })]);
    expect(r.poll([plane({ groundSpeedKt: 90 })])).toEqual([]);
    expect(kinds(r.poll([plane({ groundSpeedKt: 40 })]))).toEqual(["landing"]);
    for (let i = 0; i < 6; i++) r.poll([plane({ groundSpeedKt: 12 })]);
    expect(kinds(r.said)).toEqual(["landing"]);
    expect(r.said[0].title).toBe("DAL100 has landed");
  });

  it("is said again for a second landing after another takeoff", () => {
    const r = run();
    const air = plane({ onGround: false, groundSpeedKt: 140 });
    r.poll([air]);
    r.poll([plane()]);
    r.poll([plane()]);
    r.poll([air]);
    r.poll([air]);
    r.poll([plane()]);
    r.poll([plane()]);
    expect(kinds(r.said)).toEqual(["landing", "takeoff", "landing"]);
  });
});

describe("a followed flight pushes back", () => {
  const parkedFor = (r: ReturnType<typeof run>, polls: number) => {
    for (let i = 0; i < polls; i++) r.poll([plane()]);
  };
  const away = (metres: number, over: Partial<Sighting> = {}) => plane({ latitude: 33.64 + metres / 111_000, groundSpeedKt: 3, ...over });

  it("is said once, when it moves off a stand it has stood on for two minutes", () => {
    const r = run();
    parkedFor(r, 26);
    expect(r.poll([away(10)])).toEqual([]);
    expect(kinds(r.poll([away(55)]))).toEqual(["pushback"]);
    for (let i = 0; i < 8; i++) r.poll([away(60 + i * 20)]);
    expect(kinds(r.said)).toEqual(["pushback"]);
    expect(r.said[0].title).toBe("DAL100 is pushing back");
  });

  it("is not said for creeping on the stand, or for a stop of under two minutes", () => {
    const r = run();
    parkedFor(r, 6);
    r.poll([away(30)]);
    r.poll([away(80)]);
    expect(r.said).toEqual([]);
  });

  it("is not said for an aircraft that landed minutes ago and paused on the way in, but is for the same aircraft after a turnaround", () => {
    const r = run();
    r.poll([plane({ onGround: false, groundSpeedKt: 140 })]);
    r.poll([plane({ groundSpeedKt: 60 })]);
    r.poll([plane({ groundSpeedKt: 20 })]);
    expect(kinds(r.said)).toEqual(["landing"]);
    r.said.length = 0;
    parkedFor(r, 40);
    r.poll([away(80)]);
    expect(r.said).toEqual([]);
    parkedFor(r, 130);
    r.poll([away(80)]);
    expect(kinds(r.said)).toEqual(["pushback"]);
  });

  it("is not said for an aircraft nobody follows", () => {
    const r = run();
    for (let i = 0; i < 30; i++) r.poll([plane()], NONE);
    r.poll([away(80)], NONE);
    expect(r.said).toEqual([]);
  });
});

describe("an aircraft squawks an emergency", () => {
  const sq = (squawk: string, over: Partial<Sighting> = {}) => plane({ squawk, onGround: false, groundSpeedKt: 300, ...over });

  it("says so once, and not again on every poll that it goes on squawking", () => {
    const r = run();
    r.poll([sq("1200")], NONE);
    expect(kinds(r.poll([sq("7700")], NONE))).toEqual(["emergency"]);
    for (let i = 0; i < 20; i++) expect(r.poll([sq("7700")], NONE)).toEqual([]);
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toMatchObject({ id: "a1b2c3", title: "DAL100 is squawking 7700", body: "General emergency." });
  });

  it("is said for every aircraft in the list, whether or not it is followed", () => {
    const r = run();
    const out = r.poll([sq("7600", { id: "000001", callsign: null }), sq("7500", { id: "000002", callsign: "N12" })], NONE);
    expect(out.map((a) => a.title)).toEqual(["000001 is squawking 7600", "N12 is squawking 7500"]);
    expect(out.map((a) => a.body)).toEqual(["Radio failure.", "Unlawful interference (the hijack code)."]);
  });

  it("says a change from one emergency code to another as a new alert", () => {
    const r = run();
    r.poll([sq("7600")], NONE);
    r.poll([sq("7700")], NONE);
    expect(r.said.map((a) => a.title)).toEqual(["DAL100 is squawking 7600", "DAL100 is squawking 7700"]);
  });

  it("says it again if the aircraft clears the code and later squawks it again", () => {
    const r = run();
    r.poll([sq("7700")], NONE);
    r.poll([sq("1200")], NONE);
    r.poll([sq("7700")], NONE);
    expect(kinds(r.said)).toEqual(["emergency", "emergency"]);
  });

  it("says it again if the aircraft leaves the area for over five minutes and returns still squawking", () => {
    const r = run();
    r.poll([sq("7700")], NONE);
    r.poll([], NONE, 200);
    r.poll([sq("7700")], NONE, 60);
    expect(kinds(r.said)).toEqual(["emergency"]);
    r.poll([], NONE, 400);
    r.poll([sq("7700")], NONE);
    expect(kinds(r.said)).toEqual(["emergency", "emergency"]);
  });

  it("does not say it twice when the airport's feed and the squawk list both carry the aircraft", () => {
    const r = run();
    r.poll([sq("7700")], NONE);
    expect(r.detector.observeSquawks(r.now + 3, "7700", [sq("7700")])).toEqual([]);
    expect(r.detector.observeSquawks(r.now + 33, "7700", [sq("7700")])).toEqual([]);
    expect(r.said).toHaveLength(1);
  });

  it("says it from the squawk list alone, once, for an aircraft the airport's feed does not carry", () => {
    const d = new AlertDetector();
    const first = d.observeSquawks(2000, "7700", [sq("7700", { id: "f00baa" })]);
    expect(kinds(first)).toEqual(["emergency"]);
    expect(d.observeSquawks(2030, "7700", [sq("7700", { id: "f00baa" })])).toEqual([]);
    expect(d.observeSquawks(2060, "7700", [sq("7700", { id: "f00baa" })])).toEqual([]);
  });
});

describe("military aircraft enter the area", () => {
  const mil = (over: Partial<Sighting> = {}) => plane({ id: "ae1234", callsign: "RCH401", typeCode: "C17", military: true, onGround: false, groundSpeedKt: 400, ...over });

  it("is said once for an aircraft that appears after the first look, not on every poll", () => {
    const r = run();
    r.poll([plane()], NONE);
    expect(kinds(r.poll([plane(), mil()], NONE))).toEqual(["military"]);
    for (let i = 0; i < 20; i++) expect(r.poll([plane(), mil()], NONE)).toEqual([]);
    expect(r.said).toHaveLength(1);
    expect(r.said[0]).toMatchObject({ id: "ae1234", title: "Military aircraft in the area", body: "RCH401 (C17) entered the area." });
  });

  it("is not said for the military aircraft already there when the alerts were turned on", () => {
    const r = run();
    r.poll([mil()], NONE);
    r.poll([mil()], NONE);
    expect(r.said).toEqual([]);
  });

  it("is said again when it returns after ten minutes away, not after a short gap in the feed", () => {
    const r = run();
    r.poll([plane()], NONE);
    r.poll([mil()], NONE);
    r.poll([], NONE, 120);
    r.poll([mil()], NONE, 120);
    expect(r.said).toHaveLength(1);
    r.poll([], NONE, 700);
    r.poll([mil()], NONE);
    expect(r.said).toHaveLength(2);
  });

  it("does not say anything for civil aircraft", () => {
    const r = run();
    r.poll([plane()], NONE);
    r.poll([plane(), plane({ id: "000009" })], NONE);
    expect(r.said).toEqual([]);
  });
});

describe("military aircraft fly into the map's view", () => {
  const rch = { id: "ae1234", callsign: "RCH401", typeCode: "C17" };
  const pat = { id: "ae5678", callsign: "PAT22", typeCode: "C12" };

  it("says one that flies into a view held still, once", () => {
    const d = new AlertDetector();
    expect(d.observeView(1000, [], 1)).toEqual([]);
    const said = d.observeView(1005, [rch], 1);
    expect(said).toMatchObject([{ kind: "military", id: "ae1234", title: "Military aircraft in view" }]);
    expect(said[0].body).toContain("RCH401 (C17)");
    expect(d.observeView(1010, [rch], 1)).toEqual([]);
  });

  it("takes what a new view already holds as its baseline, then says only newcomers", () => {
    const d = new AlertDetector();
    d.observeView(1000, [], 1);
    expect(d.observeView(1005, [rch], 2)).toEqual([]);
    expect(d.observeView(1010, [rch, pat], 2).map((a) => a.id)).toEqual(["ae5678"]);
  });

  it("does not say again one the airport's feed has already said", () => {
    const d = new AlertDetector();
    d.observe(1000, [], NONE);
    expect(d.observe(1005, [plane({ ...rch, military: true, onGround: false, groundSpeedKt: 400 })], NONE).map((a) => a.kind)).toEqual(["military"]);
    d.observeView(1006, [], 1);
    expect(d.observeView(1010, [rch], 1)).toEqual([]);
  });

  it("says one again after it has been gone from view for ten minutes", () => {
    const d = new AlertDetector();
    d.observeView(1000, [], 1);
    expect(d.observeView(1005, [rch], 1)).toHaveLength(1);
    d.observeView(1005 + 601, [], 1);
    expect(d.observeView(1005 + 602, [rch], 1)).toHaveLength(1);
  });
});

describe("inBounds", () => {
  const view = { west: -90, south: 30, east: -80, north: 40 };

  it("is true inside the view and false outside it on any side", () => {
    expect(inBounds(view, 35, -85)).toBe(true);
    for (const [lat, lon] of [[29.9, -85], [40.1, -85], [35, -90.1], [35, -79.9]]) expect(inBounds(view, lat, lon), `${lat},${lon}`).toBe(false);
  });

  it("follows a view across the antimeridian, east running past 180", () => {
    const wrapped = { west: 170, south: -10, east: 190, north: 10 };
    expect(inBounds(wrapped, 0, 175)).toBe(true);
    expect(inBounds(wrapped, 0, -175)).toBe(true);
    expect(inBounds(wrapped, 0, 160)).toBe(false);
    expect(inBounds(wrapped, 0, -160)).toBe(false);
  });
});
