import { describe, expect, it } from "vitest";
import { airportByCode } from "../airports";
import { toGeo } from "../geo";
import type { RegionAircraft, RegionSnapshot } from "../region";
import type { TrackedAircraft } from "../tracker";
import { classify, countInView, MAP_ORIGIN, mergeRegions, skyFeatures, militaryInView, skySubject, subjectsInView } from "./sky";

const ATL = airportByCode("atl")!;
const DFW = airportByCode("dfw")!;

function plane(extra: Partial<RegionAircraft> = {}): RegionAircraft {
  return { id: "a1", callsign: "DAL1", typeCode: "A321", military: false, latitude: 34, longitude: -85, altitudeFt: 35000, onGround: false, groundSpeedKt: 450, trackDeg: 90, verticalRateFpm: 0, ...extra };
}

describe("mergeRegions", () => {
  const cellA: RegionSnapshot = { cell: { latitude: 32, longitude: -84 }, time: 1000, aircraft: [plane({ id: "a1" }), plane({ id: "a2" })] };
  const cellB: RegionSnapshot = { cell: { latitude: 32, longitude: -88 }, time: 1002, aircraft: [plane({ id: "a2" }), plane({ id: "a3" })] };

  it("makes one snapshot of the cells read together, each aircraft once, timed by the newest cell", () => {
    const s = mergeRegions([cellA, cellB], MAP_ORIGIN);
    expect(s.time).toBe(1002);
    expect(s.aircraft.map((a) => a.id).sort()).toEqual(["a1", "a2", "a3"]);
    // A fix from the older cell is older by the difference, so the tracker places it in time correctly.
    expect(s.aircraft.find((a) => a.id === "a1")!.positionAge).toBe(2);
  });

  it("keeps the freshest fix of an aircraft two cells both hold, whichever is listed first", () => {
    const fresh: RegionSnapshot = { cell: { latitude: 32, longitude: -84 }, time: 1002, aircraft: [plane({ id: "a1", latitude: 34.5 })] };
    const old: RegionSnapshot = { cell: { latitude: 32, longitude: -88 }, time: 1000, aircraft: [plane({ id: "a1", latitude: 34 })] };
    expect(mergeRegions([fresh, old], MAP_ORIGIN).aircraft).toMatchObject([{ id: "a1", latitude: 34.5, positionAge: 0 }]);
    expect(mergeRegions([old, fresh], MAP_ORIGIN).aircraft).toMatchObject([{ id: "a1", latitude: 34.5, positionAge: 0 }]);
  });

  it("ages a fix by its own position age as well as its cell's, and lets the fresher fix win across cells", () => {
    // The newer cell's copy was received 30 s before its cell was built; the older cell's, 1 s before: 2 + 1 beats 0 + 30.
    const newer: RegionSnapshot = { cell: { latitude: 32, longitude: -84 }, time: 1002, aircraft: [plane({ id: "a1", latitude: 34.5, positionAgeS: 30 }), plane({ id: "a2", positionAgeS: 4 })] };
    const older: RegionSnapshot = { cell: { latitude: 32, longitude: -88 }, time: 1000, aircraft: [plane({ id: "a1", latitude: 34, positionAgeS: 1 })] };
    const merged = mergeRegions([newer, older], MAP_ORIGIN);
    expect(merged.aircraft.find((a) => a.id === "a1")).toMatchObject({ latitude: 34, positionAge: 3 });
    expect(merged.aircraft.find((a) => a.id === "a2")!.positionAge).toBe(4);
  });

  it("puts each aircraft in the map's metres, so the tracker can move it", () => {
    const [a] = mergeRegions([{ ...cellA, aircraft: [plane({ latitude: 40, longitude: -96 })] }], MAP_ORIGIN).aircraft;
    expect(a.x).toBeCloseTo(0, 0);
    expect(a.y).toBeCloseTo(111_195, -2);
    expect(a).toMatchObject({ altitudeFt: 35000, groundSpeedKt: 450, trackDeg: 90, verticalRateFpm: 0, onGround: false, callsign: "DAL1" });
  });

  it("can treat recordings from different moments as one moment, for the fixture", () => {
    const s = mergeRegions([cellA, { ...cellB, time: 9000 }], MAP_ORIGIN, { rebase: true });
    expect(s.time).toBe(9000);
    expect(s.aircraft.every((a) => a.positionAge === 0)).toBe(true);
  });
});

describe("classify", () => {
  /** A point `km` east of the airport. */
  const east = (km: number) => {
    const [latitude, longitude] = toGeo(ATL, km * 1000, 0);
    return { latitude, longitude };
  };

  it("calls an aircraft descending toward a built airport arriving, and one climbing away departing", () => {
    expect(classify({ ...east(30), altitudeFt: 6000, onGround: false, verticalRateFpm: -900, headingDeg: 270 }, [ATL, DFW])).toBe("arriving");
    expect(classify({ ...east(30), altitudeFt: 7000, onGround: false, verticalRateFpm: 1800, headingDeg: 90 }, [ATL, DFW])).toBe("departing");
  });

  it("calls everything else cruise: high, far, or level and going past", () => {
    expect(classify({ ...east(30), altitudeFt: 36000, onGround: false, verticalRateFpm: -900, headingDeg: 270 }, [ATL])).toBe("cruise");
    expect(classify({ ...east(300), altitudeFt: 6000, onGround: false, verticalRateFpm: -900, headingDeg: 270 }, [ATL])).toBe("cruise");
    expect(classify({ ...east(60), altitudeFt: 9000, onGround: false, verticalRateFpm: 0, headingDeg: 0 }, [ATL])).toBe("cruise");
  });

  it("calls an aircraft on the ground ground, and a low one with no climb rate by which way it heads", () => {
    expect(classify({ ...east(1), altitudeFt: 0, onGround: true, verticalRateFpm: null, headingDeg: 0 }, [ATL])).toBe("ground");
    expect(classify({ ...east(15), altitudeFt: 3000, onGround: false, verticalRateFpm: null, headingDeg: 268 }, [ATL])).toBe("arriving");
    expect(classify({ ...east(15), altitudeFt: 3000, onGround: false, verticalRateFpm: null, headingDeg: 88 }, [ATL])).toBe("departing");
  });
});

describe("skyFeatures", () => {
  const tracked = (extra: Partial<TrackedAircraft> = {}): TrackedAircraft => ({
    id: "a1",
    x: 0,
    y: 0,
    altitudeFt: 35000,
    headingDeg: 90,
    headingKnown: true,
    groundSpeedKt: 360,
    onGround: false,
    verticalRateFpm: 0,
    callsign: "DAL1",
    typeCode: "A321",
    military: false,
    category: null,
    fade: 1,
    ...extra,
  });

  it("draws each aircraft where the tracker has it, turned to its heading, with its kind, altitude and fade", () => {
    const { aircraft } = skyFeatures([tracked({ fade: 0.5 })], MAP_ORIGIN, [ATL], 60);
    expect(aircraft.features[0].geometry.coordinates[0]).toBeCloseTo(-96, 6);
    expect(aircraft.features[0].geometry.coordinates[1]).toBeCloseTo(39, 6);
    expect(aircraft.features[0].properties).toEqual({ id: "a1", kind: "cruise", track: 90, altitude: 35000, fade: 0.5 });
  });

  it("draws a trail back along the heading, as far as the aircraft flies in the trail's time, tail first", () => {
    const { trails } = skyFeatures([tracked()], MAP_ORIGIN, [ATL], 60);
    const [tail, head] = trails.features[0].geometry.coordinates;
    expect(head[0]).toBeCloseTo(-96, 6);
    // 360 kt for 60 s is 11.1 km, west of an aircraft heading east.
    const km = ((head[0] - tail[0]) * 111.195 * Math.cos((39 * Math.PI) / 180));
    expect(km).toBeCloseTo(11.1, 1);
    expect(trails.features[0].properties).toEqual({ kind: "cruise" });
  });

  it("fades an aircraft the filters leave out toward a hint, marks it muted once mostly gone, and draws it no trail", () => {
    const half = skyFeatures([tracked()], MAP_ORIGIN, [ATL], 60, () => 0.4);
    expect(half.aircraft.features[0].properties.fade).toBeCloseTo(1 - 0.4 * 0.86);
    expect(half.aircraft.features[0].properties.muted).toBeUndefined();
    expect(half.trails.features).toHaveLength(1);
    const gone = skyFeatures([tracked({ fade: 0.5 })], MAP_ORIGIN, [ATL], 60, () => 1);
    expect(gone.aircraft.features[0].properties.fade).toBeCloseTo(0.5 * 0.14);
    expect(gone.aircraft.features[0].properties.muted).toBe(true);
    expect(gone.trails.features).toEqual([]);
  });

  it("draws no trail for an aircraft standing or crawling on the ground", () => {
    expect(skyFeatures([tracked({ onGround: true, groundSpeedKt: 12, altitudeFt: 0 })], MAP_ORIGIN, [ATL], 60).trails.features).toEqual([]);
  });
});

describe("countInView", () => {
  const at = (lng: number, lat: number) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lng, lat] as [number, number] }, properties: { id: `${lng},${lat}`, kind: "cruise" as const, track: 0, altitude: 30000, fade: 1 } });
  const features = { type: "FeatureCollection" as const, features: [at(-84.4, 33.6), at(-80.9, 35.2), at(-96.8, 32.9), at(-84, 40.1)] };

  it("counts the aircraft drawn inside the map's bounds", () => {
    expect(countInView(features, { west: -88, east: -78, south: 30, north: 38 })).toEqual({ shown: 2, total: 2 });
    expect(countInView(features, { west: -100, east: -70, south: 20, north: 50 })).toEqual({ shown: 4, total: 4 });
  });

  it("counts the ones the filters mute in the total but not as shown", () => {
    const muted = { ...features.features[0], properties: { ...features.features[0].properties, muted: true as const } };
    expect(countInView({ type: "FeatureCollection", features: [muted, ...features.features.slice(1)] }, { west: -100, east: -70, south: 20, north: 50 })).toEqual({ shown: 3, total: 4 });
  });
});


describe("skySubject", () => {
  const aircraft = (extra: Partial<TrackedAircraft> = {}): TrackedAircraft => ({
    id: "a1",
    x: 0,
    y: 0,
    altitudeFt: 35000,
    headingDeg: 90,
    headingKnown: true,
    groundSpeedKt: 450,
    onGround: false,
    verticalRateFpm: 0,
    callsign: "DAL1",
    typeCode: "B738",
    military: true,
    category: null,
    fade: 1,
    ...extra,
  });
  const route = { origin: { code: "SRQ", city: "Sarasota", country: "US" }, destination: { code: "ATL", city: "Atlanta", country: "US" } };

  it("carries what the filters read: the type, the military flag, the altitude and speed, and the route's ends", () => {
    expect(skySubject(aircraft(), "cruise", route)).toEqual({ callsign: "DAL1", typeCode: "B738", military: true, state: null, onGround: false, altitudeFt: 35000, speedKt: 450, origin: "SRQ", destination: "ATL" });
  });

  it("calls an arriving or departing aircraft by that, a cruising one by none, and says nothing of a route it lacks", () => {
    expect(skySubject(aircraft(), "arriving", null)).toMatchObject({ state: "arriving", origin: null, destination: null });
    expect(skySubject(aircraft(), "departing", null).state).toBe("departing");
    expect(skySubject(aircraft(), "cruise", null).state).toBeNull();
  });

  it("tells a standing aircraft on the ground from a moving one, as at the gate and taxiing", () => {
    expect(skySubject(aircraft({ onGround: true, groundSpeedKt: 0 }), "ground", null).state).toBe("gate");
    expect(skySubject(aircraft({ onGround: true, groundSpeedKt: 12 }), "ground", null).state).toBe("taxiing");
    expect(skySubject(aircraft({ onGround: true, groundSpeedKt: null }), "ground", null).state).toBe("gate");
  });
});

describe("subjectsInView", () => {
  it("makes subjects of the tracked aircraft drawn inside the bounds, with their kinds and routes", () => {
    const feature = (lng: number, lat: number, kind: "cruise" | "arriving") => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lng, lat] as [number, number] }, properties: { id: "x", kind, track: 0, altitude: 0, fade: 1 } });
    const features = { type: "FeatureCollection" as const, features: [feature(-84.4, 33.6, "arriving"), feature(-96.8, 32.9, "cruise")] };
    const tracked = [{ callsign: "DAL1", typeCode: "A321", military: false, groundSpeedKt: 200, altitudeFt: 3000, onGround: false }, { callsign: "SWA2" }] as TrackedAircraft[];
    const subjects = subjectsInView(tracked, features, { west: -88, east: -78, south: 30, north: 38 }, (c) => (c === "DAL1" ? { origin: { code: "JFK", city: "", country: null }, destination: { code: "ATL", city: "", country: null } } : null));
    expect(subjects).toEqual([{ callsign: "DAL1", typeCode: "A321", military: false, state: "arriving", onGround: false, altitudeFt: 3000, speedKt: 200, origin: "JFK", destination: "ATL" }]);
  });
});

describe("militaryInView", () => {
  it("names the military aircraft drawn inside the bounds, and no civil one or one outside", () => {
    const feature = (lng: number, lat: number) => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [lng, lat] as [number, number] }, properties: { id: "x", kind: "cruise" as const, track: 0, altitude: 0, fade: 1 } });
    const features = { type: "FeatureCollection" as const, features: [feature(-84.4, 33.6), feature(-84.0, 34.0), feature(-96.8, 32.9)] };
    const tracked = [
      { id: "ae1234", callsign: "RCH401", typeCode: "C17", military: true },
      { id: "a1b2c3", callsign: "DAL1", typeCode: "A321", military: false },
      { id: "ae5678", callsign: "PAT22", typeCode: "C12", military: true },
    ] as TrackedAircraft[];
    expect(militaryInView(tracked, features, { west: -88, east: -78, south: 30, north: 38 })).toEqual([{ id: "ae1234", callsign: "RCH401", typeCode: "C17" }]);
  });
});
