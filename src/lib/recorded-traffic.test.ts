import { describe, expect, it } from "vitest";
import { airportByCode } from "./airports";
import { recordedTraffic } from "./recorded-traffic";

describe("recordedTraffic", () => {
  it("gives Atlanta its own recording and routes", async () => {
    const recorded = await recordedTraffic(airportByCode("atl")!);
    expect(recorded?.snapshot.airport).toBe("atl");
    expect(recorded?.snapshot.aircraft).toHaveLength(29);
    expect(Object.keys(recorded?.routes ?? {})).toHaveLength(8);
  });

  it("gives Dallas-Fort Worth the aircraft round it in its recorded region, with its routes", async () => {
    const recorded = await recordedTraffic(airportByCode("dfw")!);
    expect(recorded?.snapshot.airport).toBe("dfw");
    expect(recorded?.snapshot.aircraft.length).toBeGreaterThan(10);
    for (const a of recorded!.snapshot.aircraft) expect(Math.hypot(a.x, a.y)).toBeLessThan(40_000);
    expect(Object.keys(recorded?.routes ?? {})).toHaveLength(9);
  });

  it("has nothing for an airport nobody recorded", async () => {
    expect(await recordedTraffic(airportByCode("lax")!)).toBeNull();
  });
});
