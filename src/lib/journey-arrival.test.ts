import { describe, expect, it } from "vitest";
import { LOST_MS, ON_SPOT_M, QUIET_S, quietArrival, SLOW_KT, SPOT_M, spotNear, STOPPED_KT, whenLost } from "./journey-arrival";

const map = {
  gates: [{ ref: "B12", x: 100, y: 200 }, { ref: null, x: 900, y: 900 }],
  stands: [{ ref: "7", x: -400, y: 50, headingDeg: null }],
};
/** Creeping onto the gate B12 (100, 200). */
const slow = { onGround: true, groundSpeedKt: 2, x: 130, y: 240 };

describe("spotNear", () => {
  it("is the nearest gate or stand within reach, named as the card names it", () => {
    expect(spotNear(map, 130, 240)).toEqual({ place: { kind: "gate", ref: "B12" } });
    expect(spotNear(map, -380, 60)).toEqual({ place: { kind: "stand", ref: "7" } });
  });

  it("says it is at a spot with no name when the map gives it none, and nothing past SPOT_M", () => {
    expect(spotNear(map, 905, 910)).toEqual({ place: null });
    expect(spotNear(map, 100 + SPOT_M + 1, 200)).toBeNull();
  });
});

describe("quietArrival", () => {
  it("counts a flight last seen stopped or creeping by a gate as arrived once its transponder has been quiet long enough", () => {
    expect(quietArrival(slow, QUIET_S, map)).toEqual({ place: { kind: "gate", ref: "B12" } });
  });

  it("waits out a short silence, which a taxiing aircraft behind a terminal also has", () => {
    expect(quietArrival(slow, QUIET_S - 1, map)).toBeNull();
    expect(quietArrival(slow, null, map)).toBeNull();
  });

  it("is not for a flight last seen fast, in the air, or away from every gate and stand", () => {
    expect(quietArrival({ ...slow, groundSpeedKt: SLOW_KT + 1 }, 120, map)).toBeNull();
    expect(quietArrival({ ...slow, onGround: false }, 120, map)).toBeNull();
    expect(quietArrival({ ...slow, x: 3000, y: 3000 }, 120, map)).toBeNull();
  });

  it("is not for a flight taxiing past a stand at a taxi's pace that then goes quiet behind a terminal, whatever it is near", () => {
    const passing = { onGround: true, groundSpeedKt: 10, x: 130, y: 240 };
    expect(quietArrival(passing, 120, map)).toBeNull();
    // Even with its last positions in hand: a steady pace along the lane is not braking.
    const lane = [0, 1, 2, 3].map((i) => ({ x: 130 - (3 - i) * 5, y: 240 }));
    expect(quietArrival(passing, 120, map, lane)).toBeNull();
    expect(quietArrival({ ...passing, groundSpeedKt: STOPPED_KT + 0.5 }, 120, map, lane)).toBeNull();
  });

  it("is for a flight stopped at a stand, which is the stand it parked at", () => {
    expect(quietArrival({ onGround: true, groundSpeedKt: 0, x: -395, y: 52 }, 120, map)).toEqual({ place: { kind: "stand", ref: "7" } });
  });

  it("is for a flight creeping onto a stand at STOPPED_KT, but not one a knot faster with nothing to say it is braking", () => {
    const creeping = { onGround: true, groundSpeedKt: STOPPED_KT, x: -380, y: 60 };
    expect(quietArrival(creeping, 120, map)).toEqual({ place: { kind: "stand", ref: "7" } });
    expect(quietArrival({ ...creeping, groundSpeedKt: STOPPED_KT + 1 }, 120, map)).toBeNull();
  });

  it("is for a flight slower than a taxi but over STOPPED_KT, braking toward the stand over its last positions", () => {
    // 5 m, 3 m, 1.5 m steps toward gate B12 at (100, 200): decelerating, and closing.
    const braking = [{ x: 100, y: 230 }, { x: 100, y: 225 }, { x: 100, y: 222 }, { x: 100, y: 220.5 }];
    const last = { onGround: true, groundSpeedKt: 5, x: 100, y: 220.5 };
    expect(quietArrival(last, 120, map, braking)).toEqual({ place: { kind: "gate", ref: "B12" } });
    // The same speed at a steady pace, or braking away from the spot, is not a flight pulling in.
    expect(quietArrival(last, 120, map, [{ x: 100, y: 231 }, { x: 100, y: 226 }, { x: 100, y: 221 }, { x: 100, y: 216 }])).toBeNull();
    expect(quietArrival(last, 120, map, [{ x: 100, y: 210 }, { x: 100, y: 215 }, { x: 100, y: 218 }, { x: 100, y: 220 }])).toBeNull();
  });

  it("names the stand it is on or pulling into, not merely the nearest one within reach", () => {
    const crowded = { gates: [], stands: [{ ref: "behind", x: -60, y: 0, headingDeg: null }, { ref: "ahead", x: 100, y: 0, headingDeg: null }] };
    const stopped = { onGround: true, groundSpeedKt: 0, x: 0, y: 0, headingDeg: 90 };
    // Facing east, the stand 60 m behind it is one it has passed.
    expect(quietArrival(stopped, 120, crowded)).toEqual({ place: { kind: "stand", ref: "ahead" } });
    // With no heading to go on, the nearest.
    expect(quietArrival({ ...stopped, headingDeg: null }, 120, crowded)).toEqual({ place: { kind: "stand", ref: "behind" } });
    // On a stand (within ON_SPOT_M), whichever way it faces.
    expect(quietArrival({ ...stopped, x: -60 + (ON_SPOT_M - 1) }, 120, crowded)).toEqual({ place: { kind: "stand", ref: "behind" } });
  });

  it("takes a ground speed that was never sent as standing still", () => {
    expect(quietArrival({ ...slow, groundSpeedKt: null }, 120, map)).toEqual({ place: { kind: "gate", ref: "B12" } });
  });
});

describe("whenLost", () => {
  const lost = LOST_MS + 1;

  it("holds a flight lost for less than the hold, wherever it is", () => {
    for (const stage of ["origin", "map", "destination", "arrived"] as const) expect(whenLost({ stage, lostMs: LOST_MS, onGround: false })).toBe("hold");
  });

  it("holds a flight lost on the ground at its origin for as long as it stays lost: an aircraft cannot taxi away unseen, and its transponder may be off at the gate for a long delay", () => {
    expect(whenLost({ stage: "origin", lostMs: lost, onGround: true })).toBe("hold");
    expect(whenLost({ stage: "origin", lostMs: 10 * lost, onGround: true })).toBe("hold");
  });

  it("counts a flight lost on the ground at its destination as arrived, and one already arrived as held", () => {
    expect(whenLost({ stage: "destination", lostMs: lost, onGround: true })).toBe("arrive");
    expect(whenLost({ stage: "arrived", lostMs: lost, onGround: true })).toBe("hold");
  });

  it("lets go of a flight lost in the air, which may be anywhere by now", () => {
    expect(whenLost({ stage: "origin", lostMs: lost, onGround: false })).toBe("release");
    expect(whenLost({ stage: "destination", lostMs: lost, onGround: false })).toBe("release");
  });
});
