import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AirportMap } from "./airport-map";
import { airportByCode } from "./airports";
import { type FeedSource, fixtureSource } from "./feed-source";
import { toGeo } from "./geo";
import { MAP_ORIGIN } from "./globe/sky";
import type { OrbitView } from "./scene/orbit";
import { boundTrail, Journey, type JourneyFix, TRAIL_MAX } from "./journey-follow";
import type { FlightRoute } from "./routes";

const ATL = airportByCode("atl")!;
const CLIMB_OUT = /^Likely climb-out: \S+ departure, from FAA CIFP cycle \d{4}$/;
const CLT = airportByCode("clt")!;

const end = (code: string, extra = {}) => ({ code, city: code, country: "US", ...extra });
const route = (origin: string, destination: string): FlightRoute => ({ origin: end(origin), destination: end(destination, { latitude: 34.8957, longitude: -82.2189 }) });
const source = () => fixtureSource(() => null, () => 0);
const fix: JourneyFix = { latitude: 34.2, longitude: -83, altitudeFt: 30_000, onGround: false, groundSpeedKt: 440, headingDeg: 63, verticalRateFpm: 0, callsign: "DAL1947", typeCode: "A321" };

const journeys: Journey[] = [];
const follow = (options: Partial<ConstructorParameters<typeof Journey>[1]>) => {
  const j = new Journey(source(), { hex: "a4c2e7", callsign: "DAL1947", origin: ATL, route: null, ...options });
  journeys.push(j);
  return j;
};
afterEach(() => journeys.splice(0).forEach((j) => j.dispose()));

describe("the addresses a journey asks for", () => {
  it("asks for the hex lower-cased and the callsign normalised, the one address each has, so neither meets a redirect", async () => {
    const paths: string[] = [];
    const j = new Journey(fixtureSource((path) => (paths.push(path), null), () => 0), { hex: "a4c2e7", callsign: "dl1947", origin: ATL, route: null });
    journeys.push(j);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(paths.sort()).toEqual(["/api/flight/DAL1947", "/api/hex/a4c2e7"]);
  });
});

describe("the way flown", () => {
  it("thins the older half when it outgrows its cap, keeping the first and the latest points", () => {
    const points = Array.from({ length: 9 }, (_, i) => i);
    boundTrail(points, 8);
    expect(points).toEqual([0, 2, 4, 5, 6, 7, 8]);
    boundTrail(points, 8);
    expect(points).toEqual([0, 2, 4, 5, 6, 7, 8]);
  });

  it("stays within its cap however long the flight, from its first fix to its latest", async () => {
    // The feed's clock and a flight flying east at a point every TRAIL_S seconds, read by the journey's own poll.
    let time = 1_000_000;
    let poll: () => void = () => {};
    const lonAt = (t: number) => -90 + (t - 1_000_000) * 0.0001;
    const feed: FeedSource = {
      now: () => time,
      clock: () => time,
      heard: () => {},
      every: (_seconds, fn) => {
        poll = fn;
        return () => {};
      },
      // Answered without a real body to read, so a few microtasks settle each read.
      get: async (path) => {
        if (!path.startsWith("/api/hex/")) return { ok: false } as Response;
        const body = { hex: "a4c2e7", time, aircraft: { id: "a4c2e7", callsign: "DAL1947", typeCode: "A321", military: false, latitude: 35, longitude: lonAt(time), altitudeFt: 30_000, onGround: false, groundSpeedKt: 440, trackDeg: 90, verticalRateFpm: 0 } };
        return { ok: true, json: async () => body } as Response;
      },
    };
    const settle = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    const j = new Journey(feed, { hex: "a4c2e7", callsign: "DAL1947", origin: ATL, route: null });
    journeys.push(j);
    const reads = TRAIL_MAX * 3;
    for (let i = 0; i < reads; i++) {
      poll();
      await settle();
      time += 10;
    }
    // The clock now stands 10 s past the last read: the moment drawn (8 s behind it) is after every point read.
    const { flown } = j.features(null, MAP_ORIGIN);
    // The origin, the way flown, then the aircraft itself.
    const way = flown.slice(1, -1);
    expect(way.length).toBeGreaterThan(TRAIL_MAX / 2);
    expect(way.length).toBeLessThanOrEqual(TRAIL_MAX);
    expect(flown[0]).toEqual([ATL.longitude, ATL.latitude]);
    expect(way[0][0]).toBeCloseTo(lonAt(1_000_000), 3);
    expect(way.at(-1)![0]).toBeCloseTo(lonAt(1_000_000 + (reads - 1) * 10), 3);
  });
});

describe("the journey's origin as the panel says it", () => {
  it("is the route's origin code", () => {
    expect(follow({ route: route("ATL", "CLT") }).status(0).from).toBe("ATL");
  });

  it("is the route's origin when that is not built and the journey's own frame is the nearest built airport", () => {
    // A flight picked on the map out of Greenville-Spartanburg: ATL is only the nearest of the 32.
    expect(follow({ route: route("GSP", "ATL"), originKnown: false }).status(0).from).toBe("GSP");
  });

  it("is none when no route names one, for a flight whose origin is only the nearest built airport", () => {
    expect(follow({ originKnown: false }).status(0).from).toBeNull();
  });

  it("is the airport the flight is followed from when no route has been found yet", () => {
    expect(follow({}).status(0).from).toBe("ATL");
  });
});

describe("how far it has come, for a flight followed from the map", () => {
  // Picked on the map 50 NM out of Charlotte with no route known yet: the nearest built airport is Charlotte itself, the flight's destination.
  const approach: JourneyFix = { ...fix, latitude: 35.21, longitude: -81.95, altitudeFt: 9000, verticalRateFpm: -1500, groundSpeedKt: 300, headingDeg: 85 };
  const where = ({ latitude, longitude }: { latitude: number; longitude: number }) => ({ latitude, longitude });
  const nm = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
    const r = Math.PI / 180;
    return Math.hypot((b.longitude - a.longitude) * r * Math.cos(((a.latitude + b.latitude) / 2) * r), (b.latitude - a.latitude) * r) * 3440.065;
  };
  /** A feed whose route lookup answers when the test says so (the real one comes seconds after the pick). */
  const slowRoute = () => {
    let answer: (route: FlightRoute | null) => void = () => {};
    const waiting = new Promise<FlightRoute | null>((resolve) => (answer = resolve));
    const feed: FeedSource = {
      ...source(),
      get: async (path) => (path.startsWith("/api/flight/") ? Response.json({ route: await waiting }) : new Response(null, { status: 404 })),
    };
    return { feed, answer };
  };
  const fromMap = (feed: FeedSource, route: FlightRoute | null = null) => {
    const j = new Journey(feed, { hex: "a4c2e7", callsign: "DAL1947", origin: CLT, route, originKnown: false });
    journeys.push(j);
    return j;
  };

  it("measures what is flown from where the flight was first seen until a route names where it set out, never from the nearest built airport, which here is the destination", () => {
    const j = fromMap(slowRoute().feed);
    j.sight(approach, performance.now());
    expect(j.status(0).progress).toMatchObject({ flownNm: 0 });
    // Half a degree of longitude on it has flown about 25 NM; it has not "flown" the 50 NM it is from Charlotte.
    j.sight({ ...approach, longitude: approach.longitude + 0.5 }, performance.now());
    const { flownNm, toGoNm } = j.status(0).progress!;
    expect(flownNm).toBeCloseTo(nm(approach, { latitude: approach.latitude, longitude: approach.longitude + 0.5 }), 0);
    expect(flownNm).not.toBeCloseTo(toGoNm!, 0);
  });

  it("measures it from the route's own origin once the lookup has learned it, built or not", async () => {
    const gsp = { latitude: 34.8957, longitude: -82.2189 };
    // The route's own coordinates, built or not, else the built airport's.
    for (const [origin, set] of [
      [end("ATL", where(ATL)), ATL],
      [end("GSP", gsp), gsp],
      [end("ATL"), ATL],
    ] as const) {
      const { feed, answer } = slowRoute();
      const j = fromMap(feed);
      j.sight(approach, performance.now());
      answer({ origin, destination: end("CLT", where(CLT)) });
      await vi.waitFor(() => expect(j.status(0).from).toBe(origin.code));
      const { flownNm, toGoNm, share } = j.status(0).progress!;
      expect(flownNm).toBeCloseTo(nm(set, approach), 0);
      expect(toGoNm).toBeCloseTo(nm(approach, CLT), 0);
      expect(share).toBeCloseTo(flownNm / (flownNm + toGoNm!), 5);
    }
  });

  it("draws the way flown from the same point, not from the nearest airport", async () => {
    const { feed, answer } = slowRoute();
    const j = fromMap(feed);
    j.sight(approach, performance.now());
    expect(j.features(null, CLT).flown[0]).toEqual([approach.longitude, approach.latitude]);
    answer({ origin: end("ATL", where(ATL)), destination: end("CLT") });
    await vi.waitFor(() => expect(j.features(null, CLT).flown[0]).toEqual([ATL.longitude, ATL.latitude]));
  });

  it("is still measured from the airport it is followed out of, when that is where it set out", () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.sight({ ...fix, latitude: ATL.latitude + 0.05, longitude: ATL.longitude }, performance.now());
    expect(j.status(0).progress!.flownNm).toBeCloseTo(3, 0);
  });
});

/**
 * A feed whose clock the test runs. The aircraft's hex is answered as the real route answers it: 200 with the
 * aircraft, or with `aircraft: null` when it is not listed; `status` and `stale` make a failing or stale-served answer.
 */
function clocked(answer: () => { aircraft: Record<string, unknown> | null; status?: number; stale?: boolean }) {
  let time = 1_000_000;
  let poll: () => void = () => {};
  const feed: FeedSource = {
    now: () => time,
    clock: () => time,
    heard: () => {},
    every: (_seconds, fn) => {
      poll = fn;
      return () => {};
    },
    get: async (path) => {
      if (!path.startsWith("/api/hex/")) return new Response(null, { status: 404 });
      const { aircraft, status = 200, stale } = answer();
      // A stale answer is the last good one, as old as it was.
      return status === 200 ? Response.json({ hex: "a4c2e7", time: stale ? time - 30 : time, aircraft, ...(stale && { stale: true, ageS: 30 }) }) : new Response(null, { status });
    },
  };
  return { feed, advance: (seconds: number) => (time += seconds), poll: () => poll() };
}
const parked: JourneyFix = { ...fix, altitudeFt: 0, onGround: true, groundSpeedKt: 4, headingDeg: 180, verticalRateFpm: 0 };

describe("a flight that has gone from the feeds", () => {
  it("is held where it was last seen on the ground, which an aircraft cannot leave unseen, and let go when it was last in the air", () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.sight(parked, performance.now());
    j.sight(null, performance.now() + 1000);
    expect(j.fix()).toEqual(parked);
    j.sight(fix, performance.now());
    j.sight(null, performance.now() + 1000);
    expect(j.fix()).toBeNull();
  });

  it("is lost for as long as the feed's clock says since it was last read or drawn, so a recording played fast loses it as a live feed does", () => {
    const { feed, advance } = clocked(() => ({ aircraft: null }));
    const j = new Journey(feed, { hex: "a4c2e7", callsign: "DAL1947", origin: ATL, route: null });
    journeys.push(j);
    expect(j.lostFor()).toBe(0);
    j.sight(parked, performance.now());
    advance(100);
    expect(j.lostFor()).toBe(100_000);
    j.sight(parked, performance.now());
    expect(j.lostFor()).toBe(0);
  });

  it("remembers where it was on the ground over its last few seconds, newest last, and forgets it in the air", () => {
    const { feed, advance } = clocked(() => ({ aircraft: null }));
    const j = new Journey(feed, { hex: "a4c2e7", callsign: "DAL1947", origin: ATL, route: null });
    journeys.push(j);
    for (let i = 0; i < 10; i++) {
      j.sight({ ...parked, latitude: parked.latitude + i * 0.0001 }, performance.now());
      // Frames within the same second refresh the newest point rather than adding to the run.
      j.sight({ ...parked, latitude: parked.latitude + i * 0.0001 }, performance.now());
      advance(3);
    }
    const recent = j.recentGround();
    expect(recent).toHaveLength(6);
    expect(recent.map((f) => f.latitude)).toEqual([4, 5, 6, 7, 8, 9].map((i) => parked.latitude + i * 0.0001));
    j.sight(fix, performance.now());
    expect(j.recentGround()).toEqual([]);
  });

  describe("quiet", () => {
    const listed = (age: number) => ({ id: "a4c2e7", callsign: "DAL1947", typeCode: "A321", military: false, latitude: 35.2, longitude: -80.9, altitudeFt: 0, onGround: true, groundSpeedKt: 4, trackDeg: 180, verticalRateFpm: 0, positionAgeS: age });
    const start = async (answer: Parameters<typeof clocked>[0]) => {
      const c = clocked(answer);
      const j = new Journey(c.feed, { hex: "a4c2e7", callsign: "DAL1947", origin: ATL, route: null });
      journeys.push(j);
      await vi.waitFor(() => expect(j.silentFor()).not.toBeNull());
      return { ...c, j };
    };
    /** Polls, and waits for the read to land. */
    const poll = async (c: { poll: () => void }) => {
      c.poll();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it("is for as long as the newest position its own reads have heard is old, whether or not the feeds still list it", async () => {
      let age = 10;
      let gone = false;
      const c = await start(() => ({ aircraft: gone ? null : listed(age) }));
      expect(c.j.silentFor()).toBe(10);
      // The feeds go on listing the same position, a few seconds older at each answer, until a minute.
      c.advance(5);
      age = 15;
      await poll(c);
      expect(c.j.silentFor()).toBe(15);
      // And past it they list nothing: a fresh answer that says the aircraft is gone is the best evidence of silence there is.
      c.advance(50);
      gone = true;
      await poll(c);
      expect(c.j.silentFor()).toBe(65);
    });

    it("is not counted while the journey's own reads are failing or served stale: no answer is not a quiet transponder", async () => {
      let age = 10;
      const state: { status?: number; stale?: boolean } = {};
      const c = await start(() => ({ aircraft: listed(age), ...state }));
      c.advance(30);
      state.status = 503;
      await poll(c);
      expect(c.j.silentFor()).toBeNull();
      state.status = undefined;
      state.stale = true;
      await poll(c);
      expect(c.j.silentFor()).toBeNull();
      state.stale = false;
      age = 40;
      await poll(c);
      expect(c.j.silentFor()).toBe(40);
    });
  });
});

describe("the end of a journey", () => {
  const gate = { kind: "gate", ref: "B12" } as const;

  it("is reached by parking at a gate or stand, only from the destination", () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.arrive(gate, false);
    expect(j.stage).toBe("origin");
    j.stage = "destination";
    j.arrive(gate, false);
    expect(j.stage).toBe("arrived");
    expect(j.status(0).arrival).toEqual({ place: gate, quiet: false });
  });

  it("is also reached by going quiet by a gate, and the flight is then held standing still", () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.stage = "destination";
    j.sight(parked, performance.now());
    j.sight(null, performance.now() + 1000);
    j.arrive(gate, true);
    expect(j.status(0).arrival).toEqual({ place: gate, quiet: true });
    expect(j.fix()).toMatchObject({ onGround: true, groundSpeedKt: 0 });
  });

  it("shows a flight that went quiet at its gate standing still, though its last listing still draws it at the speed it had, until it is drawn moving", () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.stage = "destination";
    j.sight(parked, performance.now());
    j.arrive(gate, true);
    // Drawn again at its last listing (4 kt): the card must not say "At gate" beside 4 kt.
    j.sight(parked, performance.now());
    expect(j.fix()).toMatchObject({ groundSpeedKt: 0 });
    expect(j.status(0).fix).toMatchObject({ groundSpeedKt: 0 });
    // Drawn away from where it stood, it had not parked: the feed's own figures are shown again.
    j.sight({ ...parked, latitude: parked.latitude + 0.002 }, performance.now());
    expect(j.fix()).toMatchObject({ groundSpeedKt: 4 });
  });

  it("is taken back when a flight that went quiet is drawn away from where it stood, but not when it was read parked", () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.stage = "destination";
    j.sight(parked, performance.now());
    j.arrive(gate, true);
    // Its last listing, still drawn where it stood (and as slow as it was) while the feeds hold it.
    j.sight(parked, performance.now());
    expect(j.stage).toBe("arrived");
    const away = { ...parked, latitude: parked.latitude + 0.002 };
    j.sight(away, performance.now());
    expect(j.stage).toBe("destination");
    expect(j.status(0).arrival).toBeNull();
    j.arrive(gate, false);
    j.sight({ ...away, latitude: away.latitude + 0.002 }, performance.now());
    expect(j.stage).toBe("arrived");
  });
});

describe("the way left", () => {
  it("is the straight estimate to the destination when nothing is published: an unbuilt destination, or procedures not yet loaded", () => {
    const j = follow({ route: route("ATL", "GSP") });
    j.sight(fix, performance.now());
    const lines = j.features(null, ATL);
    expect(lines.left).toHaveLength(2);
    expect(lines.left[1]).toEqual([-82.2189, 34.8957]);
    expect(lines.climbOut).toEqual([]);
    expect(lines.approach).toEqual([]);
    expect(j.status(0).procedures).toEqual([]);
  });

  it("is reported as an estimate to the card while the map draws one, and not off the map", () => {
    const j = follow({ route: route("ATL", "GSP") });
    j.sight(fix, performance.now());
    j.features(null, ATL);
    expect(j.status(0).estimated).toBe(false);
    j.stage = "map";
    expect(j.status(0).estimated).toBe(true);
  });

  it("is empty before the aircraft is first read", () => {
    const j = follow({ route: route("ATL", "CLT") });
    expect(j.features(null, ATL)).toMatchObject({ aircraft: null, left: [], climbOut: [], approach: [] });
    expect(j.destination).toBe(CLT);
  });
});

describe("the way left to a built destination", () => {
  it("runs on along the destination's published approach, estimated up to it, and the card cites it while the map has the flight", async () => {
    const j = follow({ route: route("ATL", "CLT") });
    // A sighting stands for a moment only, so it is made afresh each time the lines are asked for.
    const lines = () => {
      j.sight({ ...fix, latitude: 34.6, longitude: -82.4 }, performance.now());
      return j.features(null, ATL);
    };
    // The procedures are a chunk of their own: the lines are the plain estimate until it has loaded.
    expect(lines().approach).toEqual([]);
    await vi.waitFor(() => expect(lines().approach.length).toBeGreaterThan(2), { timeout: 20_000 });
    // The estimate ends where the approach begins, and the approach ends at Charlotte's runway.
    const now = lines();
    expect(now.left.at(-1)).toEqual(now.approach[0]);
    const [lon, lat] = lines().approach.at(-1)!;
    expect(Math.hypot((lon - CLT.longitude) * 0.82, lat - CLT.latitude)).toBeLessThan(0.03);
    j.stage = "map";
    lines();
    expect(j.status(0).procedures).toHaveLength(1);
    expect(j.status(0).procedures[0]).toMatch(/^Likely approach: ILS RWY (36|1L|1R), from FAA CIFP cycle \d{4}$/);
    j.stage = "origin";
    expect(j.status(0).procedures).toEqual([]);
  }, 30_000);
});

describe("what the card cites, in step with what the map is given", () => {
  it("reports, once per change, that the lines changed what is cited, so the page can bring the card up in the frame the map is given the lines", async () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.stage = "map";
    // What the card would say, and whether the page is told, right after each set of lines.
    const said: string[][] = [];
    const told = vi.fn();
    const after = <T,>(lines: T): T => {
      if (j.citeChanged()) {
        told();
        said.push(j.status(0).procedures);
      }
      return lines;
    };
    const lines = () => {
      j.sight({ ...fix, latitude: 34.6, longitude: -82.4 }, performance.now());
      return after(j.features(null, ATL));
    };
    await vi.waitFor(() => expect(lines().approach.length).toBeGreaterThan(2), { timeout: 20_000 });
    // Cited when the approach appeared: told then, not again for the same line.
    expect(told).toHaveBeenCalledTimes(1);
    expect(said[0]).toEqual([expect.stringMatching(/^Likely approach/)]);
    lines();
    lines();
    expect(told).toHaveBeenCalledTimes(1);
    // No aircraft to draw, nothing to cite: told again.
    j.sight(null, performance.now());
    vi.spyOn(performance, "now").mockReturnValue(performance.now() + 60_000);
    after(j.features(null, ATL));
    expect(told).toHaveBeenCalledTimes(2);
    expect(said[1]).toEqual([]);
    vi.restoreAllMocks();
  }, 30_000);
});

describe("the SID of a flight followed from its origin", () => {
  // Atlanta's runway 8R, its start and the way it heads, from the map the diorama draws.
  const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;
  const [start, far] = (map.runways.find((r) => r.ends.some((e) => e.ref === "08R"))!.ends as { ref: string; x: number; y: number }[]).sort((a) => (a.ref === "08R" ? -1 : 1));
  const length = Math.hypot(far.x - start.x, far.y - start.y);
  const [ux, uy] = [(far.x - start.x) / length, (far.y - start.y) / length];
  const heading = (Math.atan2(ux, uy) * 180) / Math.PI;
  /** A sighting `along` metres down 8R, `aglFt` up. */
  const on = (along: number, aglFt: number, onGround = false): JourneyFix => {
    const [latitude, longitude] = toGeo(ATL, start.x + ux * along, start.y + uy * along);
    return { ...fix, latitude, longitude, altitudeFt: onGround ? 0 : ATL.elevationFt + aglFt, onGround, headingDeg: heading, groundSpeedKt: onGround ? 150 : 170 };
  };
  const climbOut = (j: Journey, along: number, aglFt: number) => {
    j.sight(on(along, aglFt), performance.now());
    return j.features(null, ATL).climbOut;
  };

  it("is drawn for a take-off seen before the procedures' chunk has loaded", async () => {
    const j = follow({ route: route("ATL", "CLT") });
    // Everything the journey sees of the take-off happens at once, before anything has had a chance to load.
    j.sight(on(1200, 0, true), performance.now());
    j.sight(on(2400, 150), performance.now());
    await vi.waitFor(() => expect(climbOut(j, 5000, 1500).length).toBeGreaterThan(1), { timeout: 20_000 });
    expect(j.status(0).procedures).toEqual([]);
    j.stage = "map";
    climbOut(j, 5000, 1500);
    expect(j.status(0).procedures).toEqual([expect.stringMatching(CLIMB_OUT)]);
  }, 30_000);

  it("is drawn for a flight first followed already climbing out on the runway's line", async () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.sight(on(4000, 600), performance.now());
    await vi.waitFor(() => expect(climbOut(j, 6000, 1500).length).toBeGreaterThan(1), { timeout: 20_000 });
  }, 30_000);

  it("is one steady line: its published points stay where the SID puts them on the ground, whatever the camera, so a line re-cut every frame cannot step where two tiles of it meet", async () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.sight(on(1200, 0, true), performance.now());
    j.sight(on(2400, 150), performance.now());
    // Two cameras a frame or a minute apart: low and near, and high and far.
    const near: OrbitView = { azimuthDeg: 250, elevationDeg: 20, target: [0, 0], height: 0, distance: 8000 };
    const far: OrbitView = { azimuthDeg: 70, elevationDeg: 35, target: [0, 0], height: 0, distance: 60_000 };
    const lines = (view: OrbitView) => {
      j.sight(on(5000, 1500), performance.now());
      return j.features(view, ATL).climbOut;
    };
    await vi.waitFor(() => expect(lines(near).length).toBeGreaterThan(1), { timeout: 20_000 });
    const a = lines(near);
    const b = lines(far);
    expect(a.length).toBe(b.length);
    // Only the first point, the aircraft as the camera sees it, moves with the camera.
    expect(a[0]).not.toEqual(b[0]);
    expect(a.slice(1)).toEqual(b.slice(1));
    // And each is the SID's own point on the ground, whose first leg runs on the runway's side of the field (PLMMR3 off 8R bears east-northeast).
    const [lon, lat] = a[1];
    const [dx, dy] = [(lon - ATL.longitude) * 92_300, (lat - ATL.latitude) * 111_000];
    expect(Math.hypot(dx, dy)).toBeGreaterThan(20_000);
  }, 30_000);

  it("is not looked for in a flight first seen high or far along the line, such as one picked on the map at cruise", async () => {
    const j = follow({ route: route("ATL", "CLT") });
    j.sight(on(30_000, 12_000), performance.now());
    await new Promise((r) => setTimeout(r, 300));
    expect(climbOut(j, 31_000, 12_500)).toEqual([]);
  });
});
