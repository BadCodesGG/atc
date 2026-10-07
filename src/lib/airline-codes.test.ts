import { describe, expect, it } from "vitest";
import { callsignFor, iataFlight } from "./airline-codes";

describe("callsignFor", () => {
  it("maps an IATA flight number to the ICAO callsign", () => {
    expect(callsignFor("DL3104")).toBe("DAL3104");
    expect(callsignFor(" ua1831 ")).toBe("UAL1831");
    expect(callsignFor("wn7")).toBe("SWA7");
  });

  it("maps IATA codes that start with a digit", () => {
    expect(callsignFor("9E5051")).toBe("EDV5051");
    expect(callsignFor("5X1234")).toBe("UPS1234");
  });

  it("leaves a callsign, a registration or an unknown prefix as typed, upper-cased", () => {
    expect(callsignFor("dal3104")).toBe("DAL3104");
    expect(callsignFor("N820DX")).toBe("N820DX");
    expect(callsignFor("XX1234")).toBe("XX1234");
    expect(callsignFor("dl 3104")).toBe("DL 3104");
  });
});

describe("iataFlight", () => {
  it("gives the flight number a callsign is sold under", () => {
    expect(iataFlight("DAL3104")).toBe("DL3104");
    expect(iataFlight("EDV5051")).toBe("9E5051");
  });

  it("is null without a known prefix and a number", () => {
    expect(iataFlight("N820DX")).toBeNull();
    expect(iataFlight("ZZZ12")).toBeNull();
    expect(iataFlight("DALX")).toBeNull();
    expect(iataFlight(null)).toBeNull();
  });
});
