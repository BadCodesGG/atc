import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { airacEffective, parseCifp } from "./cifp";

/**
 * Real records cut from FAACIFP18, cycle 2610: ATL's header, reference point, five runways, four
 * approaches, five SID routes and their fixes; and a SID each at LAX (a heading to a radial) and LAS
 * (a heading to a DME distance) with their navaids.
 */
const text = readFileSync(path.join(import.meta.dirname, "__fixtures__/cifp_sample.txt"), "utf8");
const { cycle, effective, airports } = parseCifp(text, ["KATL"]);
const atl = airports.KATL!;

describe("parseCifp: the file", () => {
  it("reads the cycle from the header and dates it by the AIRAC calendar", () => {
    expect(cycle).toBe("2610");
    expect(effective).toBe("2026-10-01");
  });

  it("reads the airport's magnetic variation (west is negative) and elevation", () => {
    expect(atl.magVarDeg).toBe(-5);
    expect(atl.elevationFt).toBe(1026);
  });

  it("returns nothing for an airport the file does not have", () => {
    expect(parseCifp(text, ["KPIT"]).airports.KPIT).toBeUndefined();
  });

  it("accepts CRLF line ends, as git on Windows may write the file", () => {
    expect(parseCifp(text.replace(/\n/g, "\r\n"), ["KATL"]).airports.KATL?.approaches["9R"]?.ident).toBe("I09R");
  });
});

describe("parseCifp: approaches", () => {
  it("takes the final route of ILS 9R from its intermediate fix to the threshold, without transitions or the missed approach", () => {
    const a = atl.approaches["9R"]!;
    expect(a.ident).toBe("I09R");
    expect(a.name).toBe("ILS RWY 9R");
    expect(a.legs.map((l) => `${l.type} ${l.fix?.id ?? ""}`)).toEqual(["IF GGUYY", "CF EEASY", "CF BURNY", "CF RW09R"]);
    expect(a.legs.map((l) => l.role ?? null)).toEqual([null, null, "FAF", "MAP"]);
  });

  it("stops at the missed approach's first leg even where the missed approach point is not flagged", () => {
    // ILS 9R's runway record with its description code's M (column 43) blanked: the next leg's own M (column 42) still ends the final.
    const unflagged = text
      .split(/\r?\n/)
      .map((line) => (line.startsWith("SUSAP KATLK7FI09R  I      030RW09R") ? `${line.slice(0, 42)} ${line.slice(43)}` : line))
      .join("\n");
    const legs = parseCifp(unflagged, ["KATL"]).airports.KATL!.approaches["9R"]!.legs;
    expect(legs.map((l) => l.fix?.id ?? l.type)).toEqual(["GGUYY", "EEASY", "BURNY", "RW09R"]);
  });

  it("resolves fixes from the waypoint and runway records (N33 37 54.22, W084 32 57.88 is BURNY)", () => {
    const burny = atl.approaches["9R"]!.legs[2].fix!;
    expect(burny.lat).toBeCloseTo(33 + 37 / 60 + 54.22 / 3600, 6);
    expect(burny.lon).toBeCloseTo(-(84 + 32 / 60 + 57.88 / 3600), 6);
  });

  it("turns magnetic courses true with the airport's variation: 095.0 magnetic is 090.0 true at ATL", () => {
    expect(atl.approaches["9R"]!.legs[2].courseDeg).toBeCloseTo(90, 6);
  });

  it("reads altitude constraints in feet above sea level, glide slope codes included", () => {
    const [gguyy, eeasy, burny, rw] = atl.approaches["9R"]!.legs;
    expect(gguyy.altitude).toEqual({ kind: "atOrAbove", ft: 5000 });
    expect(eeasy.altitude).toEqual({ kind: "atOrAbove", ft: 4000 });
    expect(burny.altitude).toEqual({ kind: "atOrAbove", ft: 2700 });
    expect(rw.altitude).toEqual({ kind: "at", ft: 1082 });
    expect(rw.verticalAngleDeg).toBe(3);
  });

  it("gives each approach its runway's threshold: position, elevation and crossing height", () => {
    const t = atl.approaches["8L"]!.threshold;
    expect(t.lat).toBeCloseTo(33 + 38 / 60 + 58.32 / 3600, 6);
    expect(t.lon).toBeCloseTo(-(84 + 26 / 60 + 20.49 / 3600), 6);
    expect(t.elevationFt).toBe(1015);
    expect(t.crossingHeightFt).toBe(50);
  });

  it("prefers the ILS to an RNAV approach to the same runway", () => {
    expect(atl.approaches["8L"]!.ident).toBe("I08L");
  });

  it("reads an RNP approach's runway from its runway fix, and skips continuation records", () => {
    const a = atl.approaches["26R"]!;
    expect(a.ident).toBe("H26RZ");
    expect(a.name).toBe("RNAV (RNP) Z RWY 26R");
    expect(a.legs.map((l) => l.fix?.id)).toEqual(["BAMBU", "AJAAY", "RW26R"]);
  });

  it("drops a procedure whose fix the file cannot place, and counts it", () => {
    const without = text
      .split(/\r?\n/)
      .filter((line) => !line.startsWith("SUSAP KATLK7CBURNY"))
      .join("\n");
    const parsed = parseCifp(without, ["KATL"]).airports.KATL!;
    expect(parsed.approaches["9R"]).toBeUndefined();
    expect(parsed.unresolved).toBeGreaterThan(0);
  });
});

describe("parseCifp: departures", () => {
  it("gives each runway its SIDs' runway transitions, without the enroute transitions", () => {
    const cuttn = atl.departures["9L"]!.find((d) => d.ident === "CUTTN2")!;
    expect(cuttn.legs.map((l) => `${l.type} ${l.fix?.id ?? ""}`.trim())).toEqual(["VI", "CF GRITZ", "TF HYZMN", "TF TYRNN", "TF CUTTN"]);
    expect(cuttn.legs[0].courseDeg).toBeCloseTo(90, 6);
  });

  it("expands a transition for both parallels (RW08B) to each of them", () => {
    expect(atl.departures["8L"]!.map((d) => d.ident)).toContain("BANNG3");
    expect(atl.departures["8R"]!.map((d) => d.ident)).toContain("BANNG3");
  });

  it("keeps a vector SID's heading-to-altitude leg with its altitude", () => {
    const atl2 = atl.departures["8R"]!.find((d) => d.ident === "ATL2")!;
    expect(atl2.legs.map((l) => l.type)).toEqual(["VA", "VM"]);
    expect(atl2.legs[0].altitude).toEqual({ kind: "atOrAbove", ft: 1500 });
  });
});

describe("parseCifp: legs ending at a navaid's distance or radial", () => {
  const { KLAX: lax, KLAS: las } = parseCifp(text, ["KLAX", "KLAS"]).airports;

  it("gives a heading-to-radial leg its navaid and the radial, turned true with the station's declination (154.0 at SMO, 15 E)", () => {
    const gmn = lax!.departures["24L"]!.find((d) => d.ident === "GMN7")!;
    expect(gmn.legs.map((l) => l.type)).toEqual(["VR", "VM", "CF"]);
    const vr = gmn.legs[0];
    expect(vr.navaid?.id).toBe("SMO");
    expect(vr.navaid!.lat).toBeCloseTo(34 + 0 / 60 + 36.88 / 3600, 6);
    expect(vr.radialDeg).toBeCloseTo(169, 6);
    // Its heading, 251.0 magnetic, turns true with the airport's variation (12 E).
    expect(vr.courseDeg).toBeCloseTo(263, 6);
  });

  it("gives a heading-to-DME leg its navaid and the distance", () => {
    const vd = las!.departures["26L"]!.find((d) => d.ident === "HOOVR8")!.legs[0];
    expect(vd.type).toBe("VD");
    expect(vd.navaid?.id).toBe("LAS");
    expect(vd.distanceNm).toBe(3);
  });
});

describe("airacEffective", () => {
  it("dates a cycle by the 28-day AIRAC calendar", () => {
    expect(airacEffective("2601")).toBe("2026-01-22");
    expect(airacEffective("2610")).toBe("2026-10-01");
    expect(airacEffective("2501")).toBe("2025-01-23");
  });
});
