import { afterEach, describe, expect, it } from "vitest";
import { airportByCode } from "./airports";
import type { FeedSource } from "./feed-source";
import { toGeo, toLocal } from "./geo";
import { MAP_ORIGIN, mergeRegions, skyFeatures } from "./globe/map-traffic";
import { Journey } from "./journey-follow";
import type { RegionAircraft } from "./region";
import { oncePerFrame, SharedSky } from "./shared-sky";
import { PLAYBACK_DELAY } from "./tracker";

const ATL = airportByCode("atl")!;
const HEX = "a4c2e7";

describe("the moment every view draws", () => {
  it("is read once a frame: every view drawing it is given the same moment, the next frame a new one", () => {
    let clock = 100;
    let frame: number | null = 16;
    const time = oncePerFrame(
      () => clock,
      () => frame,
    );
    expect(time()).toBe(100);
    clock = 100.004;
    expect(time()).toBe(100);
    frame = 33;
    expect(time()).toBe(100.004);
    // A hidden page draws no frames: it reads the clock as it stands.
    frame = null;
    clock = 101;
    expect(time()).toBe(101);
    clock = 102;
    expect(time()).toBe(102);
  });
});

/**
 * A page's feeds on a clock the test runs: the journey's hex poll answers as /api/hex does. The frame stamp
 * moves on with the clock, as a page's frames do.
 */
function page() {
  let time = 1_000_000;
  let poll: () => void = () => {};
  let answer: RegionAircraft | null = null;
  const source: FeedSource = {
    now: () => time,
    clock: () => time,
    heard: () => {},
    every: (_seconds, fn) => {
      poll = fn;
      return () => {};
    },
    get: async (path) => {
      if (!path.startsWith(`/api/hex/${HEX}`) || !answer) return { ok: false } as Response;
      const body = { hex: HEX, time, aircraft: answer };
      return { ok: true, json: async () => body } as Response;
    },
  };
  const sky = new SharedSky(source, () => time);
  return {
    sky,
    source,
    get time() {
      return time;
    },
    set time(t: number) {
      time = t;
    },
    async hexRead(a: RegionAircraft) {
      answer = a;
      poll();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

/** A flight climbing out east of Atlanta at 200 m/s, `x` metres east of the field. */
function climbing(x: number, ageS = 0): RegionAircraft {
  const [latitude, longitude] = toGeo(ATL, x, 1_500);
  return { id: HEX, callsign: "DAL1947", typeCode: "A321", military: false, latitude, longitude, altitudeFt: 3_000 + x / 10, onGround: false, groundSpeedKt: 389, trackDeg: 90, verticalRateFpm: 2_000, positionAgeS: ageS };
}

describe("one tracker for the Diorama, the World map and the Journey", () => {
  const journeys: Journey[] = [];
  afterEach(() => journeys.splice(0).forEach((j) => j.dispose()));

  it("draws a followed flight at the same place in all three at the same instant, whichever poll last heard it", async () => {
    const p = page();
    const airport = p.sky.airport(ATL.code, ATL);
    const worldMap = p.sky.worldMap(MAP_ORIGIN);
    const j = new Journey(p.source, { hex: HEX, callsign: "DAL1947", origin: ATL, route: null }, p.sky);
    journeys.push(j);
    const start = p.time;
    let compared = 0;
    // Every second for a minute: the airport feed every 5 s, the map's region read every 10 s on a clock
    // 0.6 s ahead, and the journey's own poll every 5 s, 2.5 s after the airport feed.
    for (let s = 0; s <= 60; s++) {
      p.time = start + s;
      const flown = 200 * s;
      if (s % 5 === 0) airport.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time, aircraft: [climbing(flown)] }], ATL));
      if (s % 10 === 3) worldMap.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time + 0.6, aircraft: [climbing(flown, 0.6)] }], MAP_ORIGIN));
      if (s % 5 === 2) await p.hexRead(climbing(flown));
      if (s < PLAYBACK_DELAY + 2) continue;
      // The diorama's frame, the map's and the journey's, all at this frame's one moment.
      const inDiorama = airport.at(p.sky.time()).find((a) => a.id === HEX)!;
      const onMap = skyFeatures(worldMap.at(p.sky.time()), MAP_ORIGIN, [ATL], 75).aircraft.features.find((f) => f.properties.id === HEX)!;
      const inJourney = j.fix()!;
      const [dLat, dLon] = toGeo(ATL, inDiorama.x, inDiorama.y);
      const [mLon, mLat] = onMap.geometry.coordinates;
      expect(Math.hypot(...toLocal({ latitude: dLat, longitude: dLon }, inJourney.latitude, inJourney.longitude))).toBeLessThan(1e-3);
      expect(Math.hypot(...toLocal({ latitude: dLat, longitude: dLon }, mLat, mLon))).toBeLessThan(1e-3);
      expect(inJourney.altitudeFt).toBe(inDiorama.altitudeFt);
      expect(onMap.properties.altitude).toBe(inDiorama.altitudeFt);
      expect(inJourney.headingDeg).toBe(inDiorama.headingDeg);
      compared++;
    }
    expect(compared).toBeGreaterThan(40);
  });

  it("gives each view a feed of its own: the map reads every aircraft, as long as its region reads list them; a flight's reads, that flight", () => {
    const p = page();
    const airport = p.sky.airport(ATL.code, ATL);
    const worldMap = p.sky.worldMap(MAP_ORIGIN);
    const flight = p.sky.flight(HEX);
    const other = { ...climbing(0), id: "a00001", callsign: "N1" };
    expect(worldMap.size).toBe(0);
    airport.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time, aircraft: [other] }], ATL));
    worldMap.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time, aircraft: [climbing(0)] }], MAP_ORIGIN));
    expect(worldMap.size).toBe(2);
    p.time += PLAYBACK_DELAY + 2;
    // The map reads both, whichever feed listed them; the Diorama only its own feed's.
    expect(worldMap.at(p.sky.time()).map((a) => a.id).sort()).toEqual(["a00001", HEX]);
    expect(airport.at(p.sky.time()).map((a) => a.id)).toEqual(["a00001"]);
    expect(flight.at(p.sky.time())?.id).toBe(HEX);
    // A region read flies an aircraft on for REGION_RECKON (30 s) after its last listing, the airport feed for 15 s.
    p.time += 25;
    expect(worldMap.at(p.sky.time()).map((a) => a.id)).toEqual([HEX]);
    // The flight's own reads list it as a feed of their own, flown on for a minute.
    flight.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time, aircraft: [climbing(5_000)] }], MAP_ORIGIN));
    p.time += 50;
    expect(flight.at(p.sky.time())?.id).toBe(HEX);
    expect(worldMap.at(p.sky.time()).map((a) => a.id)).toEqual([HEX]);
  });

  it("draws the journey's flight from the airport feed's fixes before its own poll has heard it", () => {
    const p = page();
    const airport = p.sky.airport(ATL.code, ATL);
    const j = new Journey(p.source, { hex: HEX, callsign: "DAL1947", origin: ATL, route: null }, p.sky);
    journeys.push(j);
    airport.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time, aircraft: [climbing(0)] }], ATL));
    airport.add(mergeRegions([{ cell: { latitude: 0, longitude: 0 }, time: p.time + 5, aircraft: [climbing(1_000)] }], ATL));
    p.time += PLAYBACK_DELAY + 2.5;
    const fix = j.fix()!;
    const [x] = toLocal(ATL, fix.latitude, fix.longitude);
    expect(x).toBeCloseTo(500, 0);
  });
});
