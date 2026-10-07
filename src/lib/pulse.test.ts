import { describe, expect, it } from "vitest";
import type { Situation } from "./aircraft-state";
import { Pulse, type PulseAircraft } from "./pulse";

/** One aircraft at one moment, as the pulse reads it. */
function at(id: string, s: Partial<Situation> & Pick<Situation, "state" | "activity">, where: { x?: number; y?: number; onGround?: boolean } = {}): PulseAircraft {
  const onGround = where.onGround ?? (s.aglFt ?? 0) === 0;
  return {
    id,
    callsign: id.toUpperCase(),
    x: where.x ?? 0,
    y: where.y ?? 0,
    onGround,
    situation: { runway: null, aglFt: 0, moving: s.state !== "parked" && s.activity !== "Holding", ...s },
  };
}

const parked = (id: string, gate: string, x = 0, y = 0) => at(id, { state: "parked", activity: `At gate ${gate}`, place: { kind: "gate", ref: gate }, moving: false }, { x, y });
const taxi = (id: string, x: number, y = 0) => at(id, { state: "taxiing", activity: "Taxiing" }, { x, y });
const roll = (id: string, runway: string, x: number) => at(id, { state: "departing", activity: "Takeoff roll", runway }, { x });
const climb = (id: string, runway: string, agl: number) => at(id, { state: "departing", activity: "Climbing out", runway, aglFt: agl }, { onGround: false });
const final = (id: string, runway: string, agl: number) => at(id, { state: "arriving", activity: "Final approach", runway, aglFt: agl }, { onGround: false });
const rollout = (id: string, runway: string, x: number) => at(id, { state: "arriving", activity: "Landing rollout", runway }, { x });

/** Feeds `steps` one per `dt` seconds from `t0`. */
function play(pulse: Pulse, t0: number, dt: number, steps: PulseAircraft[][]): number {
  steps.forEach((list, i) => pulse.observe(t0 + i * dt, list));
  return t0 + (steps.length - 1) * dt;
}

const T0 = 1_790_794_000;

describe("Pulse: the observed board", () => {
  it("logs a departure's pushback, takeoff and taxi-out time", () => {
    const pulse = new Pulse(T0);
    const end = play(pulse, T0, 60, [
      [parked("dal1", "A12")],
      [parked("dal1", "A12")],
      [taxi("dal1", 20)],
      [taxi("dal1", 200)],
      [taxi("dal1", 900)],
      [roll("dal1", "9L", 1200)],
      [climb("dal1", "9L", 300)],
    ]);
    const [flight] = pulse.board();
    expect(flight.callsign).toBe("DAL1");
    expect(flight.events.map((e) => [e.kind, e.at, e.place?.ref ?? e.runway ?? null])).toEqual([
      ["seen", T0, "A12"],
      ["pushback", T0 + 120, "A12"],
      ["takeoff", T0 + 360, "9L"],
    ]);
    expect(pulse.now(end).taxiOut).toEqual({ minutes: 4, flights: 1 });
    expect(pulse.now(end).departuresThisHour).toBe(1);
  });

  it("logs an arrival's landing, its gate and taxi-in time", () => {
    const pulse = new Pulse(T0);
    const end = play(pulse, T0, 30, [
      [final("dal2", "8L", 900)],
      [final("dal2", "8L", 100)],
      [rollout("dal2", "8L", 600)],
      [taxi("dal2", 1500)],
      [taxi("dal2", 1600)],
      [taxi("dal2", 1700)],
      [parked("dal2", "B4", 1800)],
      [parked("dal2", "B4", 1800)],
      [parked("dal2", "B4", 1800)],
    ]);
    const [flight] = pulse.board();
    expect(flight.events.map((e) => [e.kind, e.at, e.place?.ref ?? e.runway ?? null])).toEqual([
      ["seen", T0, "8L"],
      ["landing", T0 + 60, "8L"],
      ["in", T0 + 180, "B4"],
    ]);
    expect(pulse.now(end).taxiIn).toEqual({ minutes: 2, flights: 1 });
    expect(pulse.now(end).arrivalsThisHour).toBe(1);
  });

  it("does not call a pause beside a gate an arrival at it", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 10, [[final("dal3", "8L", 100)], [rollout("dal3", "8L", 600)], [taxi("dal3", 1500)], [parked("dal3", "C1", 1600)], [taxi("dal3", 1700)]]);
    expect(pulse.board()[0].events.map((e) => e.kind)).toEqual(["seen", "landing"]);
  });

  it("does not call creeping about on the stand a pushback", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 10, [[parked("dal4", "D1")], [taxi("dal4", 8)], [parked("dal4", "D1")]]);
    expect(pulse.board()[0].events.map((e) => e.kind)).toEqual(["seen"]);
  });

  it("puts the latest news first", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 60, [
      [parked("a", "A1"), final("b", "8L", 500)],
      [taxi("a", 100), final("b", "8L", 200)],
      [taxi("a", 200), rollout("b", "8L", 500)],
    ]);
    expect(pulse.board().map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("counts only this hour's movements", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 60, [[final("x", "8L", 100)], [rollout("x", "8L", 500)]]);
    expect(pulse.now(T0 + 1800).arrivalsThisHour).toBe(1);
    expect(pulse.now(T0 + 3700).arrivalsThisHour).toBe(0);
  });

  it("forgets nothing about a flight that leaves the feed", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 60, [[final("x", "8L", 100)], [rollout("x", "8L", 500)], []]);
    expect(pulse.board()[0].events).toHaveLength(2);
  });
});

describe("Pulse: runways in use", () => {
  it("names the runways seen taking arrivals and departures, by role", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 20, [[final("a", "8L", 1500), climb("b", "9L", 800), final("c", "9R", 600)], [final("a", "8L", 1200), climb("d", "9L", 400)]]);
    expect(pulse.runwaysInUse(T0 + 20)).toEqual([
      { runway: "8L", arrivals: 1, departures: 0, source: "observed" },
      { runway: "9L", arrivals: 0, departures: 2, source: "observed" },
      { runway: "9R", arrivals: 1, departures: 0, source: "observed" },
    ]);
  });

  it("takes the runway a flight landed on over the parallel its approach was read against", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 15, [[final("a", "9L", 2000)], [final("a", "9R", 900)], [rollout("a", "9R", 800)]]);
    expect(pulse.runwaysInUse(T0 + 30).map((r) => [r.runway, r.arrivals])).toEqual([["9R", 1]]);
  });

  it("takes the runway a flight took off from over the parallel it drifted over climbing out", () => {
    const pulse = new Pulse(T0);
    play(pulse, T0, 15, [[roll("d", "8R", 900)], [climb("d", "8R", 200)], [climb("d", "8L", 1400)]]);
    expect(pulse.runwaysInUse(T0 + 30).map((r) => [r.runway, r.departures])).toEqual([["8R", 1]]);
  });

  it("does not take a departure just off the ground, not yet climbing, for an arrival", () => {
    const pulse = new Pulse(T0);
    const liftoff = at("d", { state: "arriving", activity: "Landing", runway: "8R", aglFt: 0 }, { onGround: false });
    play(pulse, T0, 15, [[roll("d", "8R", 900)], [liftoff], [climb("d", "8R", 600)]]);
    expect(pulse.runwaysInUse(T0 + 30)).toEqual([{ runway: "8R", arrivals: 0, departures: 1, source: "observed" }]);
  });

  it("drops a runway nobody has used for half an hour", () => {
    const pulse = new Pulse(T0);
    pulse.observe(T0, [final("a", "26R", 1000)]);
    pulse.observe(T0 + 1000, [final("b", "8L", 1000)]);
    expect(pulse.runwaysInUse(T0 + 2000).map((r) => r.runway)).toEqual(["8L"]);
  });

  it("falls back on what the weather says when nothing has been seen", () => {
    const pulse = new Pulse(T0);
    const wind = () => ({ arrivals: ["26R"], departures: ["26L"] });
    expect(pulse.runwaysInUse(T0, wind)).toEqual([
      { runway: "26L", arrivals: 0, departures: 1, source: "fallback" },
      { runway: "26R", arrivals: 1, departures: 0, source: "fallback" },
    ]);
    expect(pulse.runwaysInUse(T0)).toEqual([]);
  });

  it("ignores a runway named by an aircraft only taxiing on it", () => {
    const pulse = new Pulse(T0);
    pulse.observe(T0, [at("a", { state: "taxiing", activity: "Taxiing", runway: "9L" })]);
    expect(pulse.runwaysInUse(T0)).toEqual([]);
  });
});
