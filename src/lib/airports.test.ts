import { describe, expect, it } from "vitest";
import { zoneAbbreviation } from "./airports";

describe("zoneAbbreviation", () => {
  it("names the airport's zone as it reads at that moment, daylight time included", () => {
    expect(zoneAbbreviation(Date.UTC(2026, 6, 1, 12), "America/New_York")).toBe("EDT");
    expect(zoneAbbreviation(Date.UTC(2026, 0, 15, 12), "America/New_York")).toBe("EST");
    // Arizona keeps standard time all year.
    expect(zoneAbbreviation(Date.UTC(2026, 6, 1, 12), "America/Phoenix")).toBe("MST");
    expect(zoneAbbreviation(Date.UTC(2026, 6, 1, 12), "Pacific/Honolulu")).toBe("HST");
  });
});
