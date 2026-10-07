import { describe, expect, it } from "vitest";
import { airlineCode, airlineName, airlineNameOf, typeFamily, typeName } from "./flight-names";

describe("airlineName", () => {
  it("names the operator from the callsign's ICAO prefix", () => {
    expect(airlineName("DAL3118")).toBe("Delta");
    expect(airlineName("EDV5051")).toBe("Endeavor Air");
  });

  it("returns null for a registration or an unknown prefix", () => {
    expect(airlineName("N744WG")).toBeNull();
    expect(airlineName("ZZZ12")).toBeNull();
    expect(airlineName(null)).toBeNull();
  });
});

describe("typeName", () => {
  it("spells out a known ICAO type designator", () => {
    expect(typeName("B712")).toBe("Boeing 717-200");
    expect(typeName("A21N")).toBe("Airbus A321neo");
  });

  it("falls back to the designator itself", () => {
    expect(typeName("ZZ99")).toBe("ZZ99");
    expect(typeName(null)).toBeNull();
  });
});

describe("airlineCode", () => {
  it("reads the ICAO prefix of an airline callsign, known or not", () => {
    expect(airlineCode("DAL3118")).toBe("DAL");
    expect(airlineCode("ZZZ12")).toBe("ZZZ");
  });

  it("returns null for a registration, a bare hex or nothing", () => {
    expect(airlineCode("N744WG")).toBeNull();
    expect(airlineCode("A40694")).toBeNull();
    expect(airlineCode(null)).toBeNull();
  });
});

describe("airlineNameOf", () => {
  it("names a known prefix and returns null for any other", () => {
    expect(airlineNameOf("DAL")).toBe("Delta");
    expect(airlineNameOf("ZZZ")).toBeNull();
  });
});

describe("typeFamily", () => {
  it("groups the variants of a type the way the card names them", () => {
    expect(typeFamily("B738")).toEqual({ key: "B737", name: "Boeing 737" });
    expect(typeFamily("B39M")).toEqual({ key: "B737", name: "Boeing 737" });
    expect(typeFamily("A21N")).toEqual({ key: "A320", name: "Airbus A320 family" });
    expect(typeFamily("E75L")?.key).toBe("EJET");
  });

  it("makes a type outside the table a family of its own, named by its code", () => {
    expect(typeFamily("C172")).toEqual({ key: "C172", name: "C172" });
  });

  it("is null when there is no type", () => {
    expect(typeFamily(null)).toBeNull();
    expect(typeFamily("")).toBeNull();
  });
});
