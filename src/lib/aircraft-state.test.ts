import { describe, expect, it } from "vitest";
import { assess, countTraffic, groundHeading, interest, isVehicle, pickFeatured, type AirsideContext, type Motion } from "./aircraft-state";
import { KNOTS } from "./geo";

/** One runway along the x axis, 2 km long, a gate and a stand north of it. Field elevation 1000 ft. */
const ctx: AirsideContext = {
  elevationFt: 1000,
  runways: [
    {
      ref: "09/27",
      width: 45,
      surface: null,
      centerline: [
        [-1000, 0],
        [1000, 0],
      ],
      ends: [
        { ref: "09", x: -1000, y: 0 },
        { ref: "27", x: 1000, y: 0 },
      ],
    },
  ],
  gates: [{ ref: "E15", x: 0, y: 300 }],
  stands: [{ ref: "R4", x: 600, y: 400, headingDeg: 180 }],
};

function motion(extra: Partial<Motion>): Motion {
  return { x: 0, y: 200, altitudeFt: 0, headingDeg: 90, headingKnown: true, groundSpeedKt: 0, onGround: true, verticalRateFpm: null, ...extra };
}

/** Knots for a speed in metres per second. */
const kt = (mps: number) => mps / KNOTS;

describe("assess on the ground", () => {
  it("calls a stopped aircraft near a gate parked, at that gate", () => {
    const s = assess(motion({ x: 20, y: 320 }), ctx);
    expect(s).toMatchObject({ state: "parked", activity: "At gate E15", runway: null, aglFt: 0, moving: false });
  });

  it("calls a stopped aircraft on a stand with no gate parked", () => {
    expect(assess(motion({ x: 610, y: 390 }), ctx)).toMatchObject({ state: "parked", activity: "Parked" });
  });

  it("calls a slow aircraft away from the runway taxiing", () => {
    expect(assess(motion({ x: 300, y: 150, groundSpeedKt: 15 }), ctx)).toMatchObject({ state: "taxiing", activity: "Taxiing", moving: true });
  });

  it("calls a stopped aircraft on a taxiway holding, in the taxi flow", () => {
    expect(assess(motion({ x: 300, y: 150, groundSpeedKt: 0 }), ctx)).toMatchObject({ state: "taxiing", activity: "Holding", moving: false });
  });

  it("calls a stopped aircraft on the runway lined up for departure from the end behind it", () => {
    expect(assess(motion({ x: -950, y: 5, headingDeg: 90 }), ctx)).toMatchObject({ state: "departing", activity: "Lined up", runway: "9" });
  });

  it("calls a slow aircraft early on the runway a takeoff roll", () => {
    // 150 m in at 24 m/s: what a 2 m/s² takeoff reaches there.
    expect(assess(motion({ x: -850, y: -5, groundSpeedKt: kt(24) }), ctx)).toMatchObject({ state: "departing", activity: "Takeoff roll", runway: "9" });
  });

  it("calls a fast aircraft just past the touchdown zone a landing rollout", () => {
    // 450 m in at 70 m/s: far too fast for a takeoff that started at the threshold.
    expect(assess(motion({ x: 550, y: 0, headingDeg: 270, groundSpeedKt: kt(70) }), ctx)).toMatchObject({ state: "arriving", activity: "Landing rollout", runway: "27" });
  });

  it("trusts an earlier state over the rollout guess", () => {
    const s = assess(motion({ x: -850, y: 0, groundSpeedKt: kt(24) }), ctx, "arriving");
    expect(s).toMatchObject({ state: "arriving", activity: "Landing rollout" });
  });

  it("calls a slow aircraft crossing the runway taxiing", () => {
    expect(assess(motion({ x: 0, y: 0, headingDeg: 0, groundSpeedKt: 12 }), ctx)).toMatchObject({ state: "taxiing", activity: "Crossing runway 9/27", runway: null });
  });
});

describe("assess in the air", () => {
  const air = (extra: Partial<Motion>) => motion({ onGround: false, groundSpeedKt: 140, ...extra });

  it("measures height above the field, never below it", () => {
    expect(assess(air({ x: -5000, y: 3000, altitudeFt: 3500, headingDeg: 180 }), ctx).aglFt).toBe(2500);
    // Uncorrected baro altitude can read under field elevation on short final.
    expect(assess(air({ x: -1100, altitudeFt: 900 }), ctx).aglFt).toBe(0);
  });

  it("calls an aircraft lined up short of a threshold, low, on final for that runway", () => {
    expect(assess(air({ x: -5000, y: 150, altitudeFt: 2500, headingDeg: 92, verticalRateFpm: -700 }), ctx)).toMatchObject({
      state: "arriving",
      activity: "Final approach",
      runway: "9",
    });
  });

  it("picks the nearer of two parallel runways", () => {
    const parallel = { ...ctx.runways[0], ref: "09L/27R", ends: [{ ref: "09L", x: -1000, y: 320 }, { ref: "27R", x: 1000, y: 320 }], centerline: [[-1000, 320], [1000, 320]] as [number, number][] };
    const both: AirsideContext = { ...ctx, runways: [parallel, { ...ctx.runways[0], ref: "09R/27L", ends: [{ ref: "09R", x: -1000, y: 0 }, { ref: "27L", x: 1000, y: 0 }] }] };
    expect(assess(air({ x: -3000, y: 20, altitudeFt: 1600, headingDeg: 90, verticalRateFpm: -700 }), both).runway).toBe("9R");
  });

  it("calls a low aircraft over the runway, lined up and descending, landing", () => {
    expect(assess(air({ x: 800, y: 0, altitudeFt: 1040, headingDeg: 270, verticalRateFpm: -600 }), ctx)).toMatchObject({
      state: "arriving",
      activity: "Landing",
      runway: "27",
    });
  });

  it("calls a climbing aircraft departing and a descending one arriving", () => {
    expect(assess(air({ x: 4000, y: 3000, altitudeFt: 4000, headingDeg: 45, verticalRateFpm: 1500 }), ctx)).toMatchObject({ state: "departing", activity: "Climbing" });
    expect(assess(air({ x: 4000, y: 3000, altitudeFt: 4000, headingDeg: 45, verticalRateFpm: -1500 }), ctx)).toMatchObject({ state: "arriving", activity: "Descending" });
  });

  it("calls a climbing aircraft over the runway, lined up, departing from it", () => {
    expect(assess(air({ x: 600, y: 0, altitudeFt: 1300, headingDeg: 90, verticalRateFpm: 2000 }), ctx)).toMatchObject({ state: "departing", activity: "Climbing out", runway: "9" });
  });

  it("reads a level aircraft by whether it is heading toward the field", () => {
    expect(assess(air({ x: 8000, y: 0, altitudeFt: 6000, headingDeg: 270, verticalRateFpm: 0 }), ctx)).toMatchObject({ state: "arriving", activity: "Inbound" });
    expect(assess(air({ x: 8000, y: 0, altitudeFt: 6000, headingDeg: 90, verticalRateFpm: 0 }), ctx)).toMatchObject({ state: "departing", activity: "Outbound" });
  });
});

describe("ground vehicles", () => {
  it("are told by their emitter category or their type designator", () => {
    expect(isVehicle({ category: "C1" })).toBe(true);
    expect(isVehicle({ category: "c2" })).toBe(true);
    expect(isVehicle({ category: "C3" })).toBe(true);
    expect(isVehicle({ category: "A3", typeCode: "SERV" })).toBe(true);
    expect(isVehicle({ typeCode: "GRND" })).toBe(true);
    expect(isVehicle({ category: "A3", typeCode: "B738" })).toBe(false);
    expect(isVehicle({})).toBe(false);
  });

  it("read as a vehicle, not as lined up, when stopped on a runway", () => {
    const s = assess(motion({ x: -850, y: -5, headingDeg: 92, typeCode: "SERV" }), ctx);
    expect(s).toMatchObject({ state: "taxiing", activity: "Ground vehicle on runway 9/27", runway: null, aglFt: 0, moving: false, vehicle: true });
    expect(s.activity).not.toMatch(/Lined up|Takeoff/);
  });

  it("read as a moving vehicle off the runway, and an emergency one says so", () => {
    expect(assess(motion({ x: 300, y: 150, groundSpeedKt: 20, category: "C2" }), ctx)).toMatchObject({ state: "taxiing", activity: "Ground vehicle", moving: true, vehicle: true });
    expect(assess(motion({ x: 300, y: 150, groundSpeedKt: 40, category: "C1" }), ctx).activity).toBe("Emergency vehicle");
  });

  it("are never in the air, whatever the feed says", () => {
    expect(assess(motion({ onGround: false, altitudeFt: 1300, category: "C2" }), ctx)).toMatchObject({ aglFt: 0, vehicle: true });
  });

  it("rank below every aircraft", () => {
    const vehicle = assess(motion({ x: -850, y: -5, groundSpeedKt: kt(24), category: "C2" }), ctx);
    const parked = assess(motion({ x: 20, y: 320 }), ctx);
    expect(interest(vehicle)).toBeGreaterThan(interest(parked));
  });
});

describe("countTraffic", () => {
  it("counts every aircraft, those on the ground, and those moving", () => {
    const parked = assess(motion({ x: 20, y: 320 }), ctx);
    const taxiing = assess(motion({ x: 300, y: 150, groundSpeedKt: 15 }), ctx);
    const flying = assess(motion({ onGround: false, altitudeFt: 4000, groundSpeedKt: 200, verticalRateFpm: 1500, x: 4000, y: 3000 }), ctx);
    const counts = countTraffic([
      { onGround: true, situation: parked },
      { onGround: true, situation: taxiing },
      { onGround: false, situation: flying },
    ]);
    expect(counts).toEqual({ tracked: 3, onGround: 2, moving: 2 });
  });
});

describe("pickFeatured", () => {
  const entry = (id: string, m: Partial<Motion>) => {
    const full = motion(m);
    return { id, x: full.x, y: full.y, situation: assess(full, ctx) };
  };

  it("prefers an aircraft using a runway over one on final, over one taxiing, over one parked", () => {
    const parked = entry("parked", { x: 20, y: 320 });
    const taxiing = entry("taxi", { x: 300, y: 150, groundSpeedKt: 15 });
    const final = entry("final", { onGround: false, x: -5000, y: 150, altitudeFt: 2500, headingDeg: 92, groundSpeedKt: 140, verticalRateFpm: -700 });
    const roll = entry("roll", { x: -850, y: -5, groundSpeedKt: kt(24) });
    expect(pickFeatured([parked, taxiing, final, roll])?.id).toBe("roll");
    expect(pickFeatured([parked, taxiing, final])?.id).toBe("final");
    expect(pickFeatured([parked, taxiing])?.id).toBe("taxi");
    expect(pickFeatured([parked])?.id).toBe("parked");
    expect(pickFeatured([])).toBeNull();
  });

  it("never opens on a ground vehicle, however busy it looks", () => {
    const parked = entry("parked", { x: 20, y: 320 });
    const van = entry("van", { x: -850, y: -5, groundSpeedKt: kt(24), category: "C2" });
    expect(pickFeatured([parked, van])?.id).toBe("parked");
    expect(pickFeatured([van])).toBeNull();
  });

  it("among equals, prefers the one nearest the field", () => {
    const far = entry("far", { x: 1500, y: 900, groundSpeedKt: 15 });
    const near = entry("near", { x: 300, y: 150, groundSpeedKt: 15 });
    expect(pickFeatured([far, near])?.id).toBe("near");
  });
});

describe("groundHeading", () => {
  const plan = {
    runways: ctx.runways,
    stands: ctx.stands,
    taxiways: [
      {
        ref: "B",
        width: 23,
        kind: "taxiway" as const,
        line: [
          [300, 100],
          [300, 500],
        ] as [number, number][],
      },
    ],
  };

  it("faces a parked aircraft the way its stand points", () => {
    expect(groundHeading(plan, 605, 395)).toBe(180);
  });

  it("lines an aircraft up with the taxiway it is on", () => {
    expect(groundHeading(plan, 305, 200)).toBeCloseTo(0);
  });

  it("lines an aircraft up with the runway when that is nearer", () => {
    expect(groundHeading(plan, 100, 3)).toBeCloseTo(90);
  });
});
