import { describe, expect, it } from "vitest";
import { airportByCode } from "./airports";
import { fixtureSource } from "./feed-source";
import { toGeo } from "./geo";
import { type EndData, JourneyEnds } from "./journey-ends";
import type { LocalDeparture } from "./procedure-path";
import { procedures, RUNWAYS } from "./__fixtures__/synthetic-field";

const ATL = airportByCode("atl")!;
const CLT = airportByCode("clt")!;

/** The synthetic field standing in for an airport: its ILS to every runway end, and SIDs off 9. */
const SID: LocalDeparture = {
  ident: "ZOOM2",
  legs: [
    { type: "CF", at: [12_000, 0] },
    { type: "CF", at: [30_000, 9000] },
  ],
};
const dataFor = (airport: { latitude: number; longitude: number }, ends = ["9", "27", "18", "36"]): EndData => ({ procedures: procedures(ends, { "9": [SID] }, airport), runways: RUNWAYS });
const loader = (data: Record<string, EndData | null>) => async (a: { code: string }) => data[a.code] ?? null;

const wait = () => new Promise((r) => setTimeout(r, 0));
/** The sky above the field, `x` metres east and `y` north of it. */
const at = (airport: { latitude: number; longitude: number }, x: number, y: number, altitudeFt = 15_000, headingDeg: number | null = 90, onGround = false) => {
  const [latitude, longitude] = toGeo(airport, x, y);
  return { latitude, longitude, altitudeFt, onGround, headingDeg };
};
const weather = (wind: unknown) => fixtureSource((path) => (path === "/api/weather/clt" && wind ? { wind } : null), () => 0);

async function arriving(wind: unknown, endData: EndData | null = dataFor(CLT)) {
  const ends = new JourneyEnds(weather(wind), ATL, loader({ clt: endData }));
  ends.setDestination(CLT, CLT);
  await wait();
  await wait();
  return ends;
}

describe("JourneyEnds arrival", () => {
  it("follows the approach to the runway the destination's wind favours, from its first fix ahead, and cites it as the flight card does", async () => {
    const ends = await arriving({ directionDeg: 270, speedKt: 14, gustKt: null, variable: false, range: null });
    // 60 km west of the field, heading east: runway 27's approach starts 16.5 km east of the field.
    const plan = ends.plan(at(CLT, -60_000, 0));
    expect(plan.cites).toEqual(["Likely approach: ILS RWY 27, from FAA CIFP cycle 2610"]);
    expect(plan.approach).toHaveLength(3);
    const [lon, lat] = plan.approach[0];
    const [startLat, startLon] = toGeo(CLT, 16_500, 0);
    expect(lon).toBeCloseTo(startLon, 5);
    expect(lat).toBeCloseTo(startLat, 5);
    expect(plan.approach.at(-1)![2]).toBeCloseTo(15, 3);
    expect(plan.climbOut).toEqual([]);
  });

  it("falls back to the runway best aligned with the way it is inbound with no wind report", async () => {
    const ends = await arriving(null);
    expect(ends.plan(at(CLT, -60_000, 0)).cites).toEqual(["Likely approach: ILS RWY 9, from FAA CIFP cycle 2610"]);
    expect(ends.plan(at(CLT, 0, -60_000)).cites).toEqual(["Likely approach: ILS RWY 36, from FAA CIFP cycle 2610"]);
  });

  it("keeps to the runway it picked while the aircraft flies on toward it, only the part of the approach still ahead", async () => {
    const ends = await arriving(null);
    // Abeam the 6 km fix, 30 m off the line: the fix at 15 km is behind, the rest ahead.
    const plan = ends.plan(at(CLT, -7600, 30));
    expect(plan.approach).toHaveLength(2);
    expect(plan.cites).toEqual(["Likely approach: ILS RWY 9, from FAA CIFP cycle 2610"]);
    // Within a couple of kilometres of the line, it is on the approach; far out west of it, still on its way there.
    expect(plan.onApproach).toBe(true);
    expect(ends.plan(at(CLT, -7600, 4000)).onApproach).toBe(false);
    expect(ends.plan(at(CLT, -60_000, 0)).onApproach).toBe(false);
  });

  it("has nothing for the part past the threshold", async () => {
    const ends = await arriving(null);
    // Over the middle of the runway it is landing on (the threshold of 09 is 1.5 km west of the field).
    const plan = ends.plan(at(CLT, -100, 0));
    expect(plan).toEqual({ climbOut: [], approach: [], onApproach: false, cites: [] });
  });

  it("says nothing when the likely runway has no published approach, and does not swap it for another", async () => {
    const ends = await arriving({ directionDeg: 270, speedKt: 14, gustKt: null, variable: false, range: null }, dataFor(CLT, ["9", "18", "36"]));
    expect(ends.plan(at(CLT, -60_000, 0))).toEqual({ climbOut: [], approach: [], onApproach: false, cites: [] });
  });

  it("says nothing for a destination that is not built, or whose procedures would not load", async () => {
    const unbuilt = new JourneyEnds(weather(null), ATL, loader({}));
    unbuilt.setDestination(null, { latitude: 34.9, longitude: -82.2 });
    await wait();
    expect(unbuilt.plan(at(CLT, -60_000, 0))).toEqual({ climbOut: [], approach: [], onApproach: false, cites: [] });
    expect((await arriving(null, null)).plan(at(CLT, -60_000, 0)).cites).toEqual([]);
  });
});

describe("JourneyEnds departure", () => {
  const bound = { latitude: 35.9, longitude: -79.9 };
  async function departing(first: "ground" | "low" | "high" = "ground") {
    const ends = new JourneyEnds(weather(null), ATL, loader({ atl: dataFor(ATL), clt: dataFor(CLT) }));
    ends.setDestination(CLT, bound);
    if (first === "ground") ends.watch(at(ATL, -1400, 0, 1026, 90, true));
    ends.watch(first === "high" ? at(ATL, 600, 8, 31_000, 91) : at(ATL, 600, 8, 1200, 91));
    await wait();
    await wait();
    return ends;
  }

  it("follows the SID leaving toward the destination from where the aircraft lifted off, while it is still ahead", async () => {
    const ends = await departing();
    // Climbing out 3 km down the runway: the SID's two fixes are ahead.
    const plan = ends.plan(at(ATL, 3000, 20, 3000));
    expect(plan.climbOut).toHaveLength(2);
    expect(plan.cites).toEqual(["Likely climb-out: ZOOM2 departure, from FAA CIFP cycle 2610"]);
  });

  it("drops the SID once the aircraft is past its last point", async () => {
    const ends = await departing();
    expect(ends.plan(at(ATL, 40_000, 12_000, 12_000)).climbOut).toEqual([]);
    expect(ends.plan(at(ATL, 40_000, 12_000, 12_000)).cites.some((c) => c.includes("climb-out"))).toBe(false);
  });

  it("drops it when the aircraft is not on it", async () => {
    const ends = await departing();
    expect(ends.plan(at(ATL, 3000, 60_000, 12_000)).climbOut).toEqual([]);
  });

  it("also follows it for a flight first seen low on the runway's line, climbing out", async () => {
    const ends = await departing("low");
    expect(ends.plan(at(ATL, 3000, 20, 3000)).climbOut).toHaveLength(2);
  });

  it("looks for no SID for a flight first seen high, such as one picked up at cruise", async () => {
    const ends = await departing("high");
    expect(ends.plan(at(ATL, 3000, 20, 3000)).climbOut).toEqual([]);
  });

  it("cites the climb-out alone while it is ahead, and the approach once it is not", async () => {
    const ends = await departing();
    expect(ends.plan(at(ATL, 3000, 20, 3000)).cites).toEqual(["Likely climb-out: ZOOM2 departure, from FAA CIFP cycle 2610"]);
    // 60 km west of Charlotte's field, heading east: its approach is the only procedure ahead.
    expect(ends.plan(at(CLT, -60_000, 0)).cites).toEqual(["Likely approach: ILS RWY 9, from FAA CIFP cycle 2610"]);
  });

  it("has none when the destination is not known to pick a SID by", async () => {
    const ends = new JourneyEnds(weather(null), ATL, loader({ atl: dataFor(ATL) }));
    ends.watch(at(ATL, -1400, 0, 1026, 90, true));
    ends.watch(at(ATL, 600, 8, 1200, 91));
    await wait();
    expect(ends.plan(at(ATL, 3000, 20, 3000)).climbOut).toEqual([]);
  });
});
