import { describe, expect, it } from "vitest";
import { classify, MIN_DRAWN_LENGTH } from "./aircraft-class";

describe("classify", () => {
  it("knows the common types at ATL", () => {
    expect(classify("B738", "A3")).toEqual({ model: "narrow", lengthM: 40 });
    expect(classify("CRJ9", "A3").model).toBe("rearjet");
    expect(classify("B712", "A3").model).toBe("rearjet");
    expect(classify("A359", "A5")).toEqual({ model: "wide", lengthM: 67 });
    expect(classify("B744", "A5").model).toBe("quad");
    expect(classify("DH8D", "A2").model).toBe("turboprop");
    expect(classify("C17", null, true).model).toBe("airlifter");
    expect(classify("F16", "A6", true).model).toBe("fighter");
  });

  it("draws small aircraft no smaller than the floor", () => {
    expect(classify("C172", "A1")).toEqual({ model: "light", lengthM: MIN_DRAWN_LENGTH });
    expect(classify("R44", "A7")).toEqual({ model: "heli", lengthM: MIN_DRAWN_LENGTH });
  });

  it("falls back on the emitter category, then on an airliner", () => {
    expect(classify(null, "A7").model).toBe("heli");
    expect(classify("ZZZZ", "A1").model).toBe("light");
    expect(classify(null, "A5").model).toBe("wide");
    expect(classify(null, null).model).toBe("narrow");
  });

  it("an unknown military type is a fast jet when small and a transport when large, but a helicopter stays one", () => {
    expect(classify("XYZ1", "A6", true).model).toBe("fighter");
    expect(classify("XYZ2", "A5", true).model).toBe("airlifter");
    expect(classify("XYZ3", "A7", true).model).toBe("heli");
  });

  it("ignores case in the type", () => {
    expect(classify("b738", null).model).toBe("narrow");
  });
});
