import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_AIRPORT } from "./airports";
import { KNOTS, toGeo, toLocal } from "./geo";
import { MAP_ORIGIN } from "./globe/map-traffic";
import { readSequence } from "./sequence";
import { CORRECTION_SNAP, FADE_OUT, GROUND_DEAD_RECKON_MAX, type Listing, PLAYBACK_DELAY, type TrackedAircraft, Tracker } from "./tracker";
import type { Aircraft, TrafficSnapshot } from "./traffic";

/** Knots that make one metre per second, so positions in these tests read as plain arithmetic. */
const MPS = 1 / KNOTS;
/**
 * The motion rules do not depend on how far behind live the picture plays: these tests were written at an
 * 8 s delay and keep it, so their times read as before. The page plays at PLAYBACK_DELAY (12 s, tested below).
 */
const DELAY = 8;
const AT_8 = { playbackDelay: DELAY };

function aircraft(id: string, x: number, y: number, extra: Partial<Aircraft> = {}): Aircraft {
  return {
    id,
    callsign: null,
    registration: null,
    typeCode: null,
    military: false,
    category: null,
    latitude: 0,
    longitude: 0,
    x,
    y,
    altitudeFt: 3000,
    onGround: false,
    groundSpeedKt: null,
    trackDeg: null,
    verticalRateFpm: null,
    positionAge: 0,
    source: "adsb_icao",
    squawk: null,
    ...extra,
  };
}

function snapshot(time: number, ...list: Aircraft[]): TrafficSnapshot {
  return { airport: "atl", time, aircraft: list };
}

/** The tracker's view of one aircraft at `time`, where these tests' playback delay is 8 s. */
function only(tracker: Tracker, time: number) {
  const states = tracker.at(time);
  expect(states.length).toBeLessThanOrEqual(1);
  return states[0];
}

describe("Tracker interpolation", () => {
  it("renders 8 s behind the clock, halfway between two samples", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { altitudeFt: 1000 })));
    tracker.add(snapshot(105, aircraft("a", 400, 200, { altitudeFt: 2000 })));
    // Render time 102.5 is the middle of the 100..105 segment.
    const s = only(tracker, 110.5);
    expect(s.id).toBe("a");
    expect(s.x).toBeCloseTo(200);
    expect(s.y).toBeCloseTo(100);
    expect(s.altitudeFt).toBeCloseTo(1500);
    expect(s.fade).toBe(1);
  });

  it("honours a playback delay given to the constructor", () => {
    const tracker = new Tracker({ playbackDelay: 2 });
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(110, aircraft("a", 1000, 0)));
    expect(only(tracker, 107).x).toBeCloseTo(500);
  });

  it("stamps each sample with when the fix was taken, not when the snapshot was built", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    // This fix is 2 s old, so it belongs at t=103 and the segment 100..103 is what gets interpolated.
    tracker.add(snapshot(105, aircraft("a", 300, 0, { positionAge: 2 })));
    expect(only(tracker, 109.5).x).toBeCloseTo(150);
  });

  it("carries identity fields from the newest report", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 10, 0, { callsign: "DAL1", typeCode: "B752", category: "A4" })));
    expect(only(tracker, 110)).toMatchObject({ callsign: "DAL1", typeCode: "B752", category: "A4" });
  });

  it("takes the ground flag from the nearer sample", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { onGround: true, altitudeFt: 0 })));
    tracker.add(snapshot(110, aircraft("a", 500, 0, { onGround: false })));
    expect(only(tracker, 111).onGround).toBe(true);
    expect(only(tracker, 116).onGround).toBe(false);
  });

  it("turns through north when the heading passes 350 to 10", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 350 })));
    tracker.add(snapshot(105, aircraft("a", 0, 0, { trackDeg: 10 })));
    const north = only(tracker, 110.5).headingDeg;
    expect(Math.min(north, 360 - north)).toBeLessThan(1e-6);
    const quarter = only(tracker, 109.25).headingDeg;
    expect(quarter).toBeCloseTo(355);
    const late = only(tracker, 111.75).headingDeg;
    expect(late).toBeCloseTo(5);
  });

  it("turns the short way the other direction too", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 10 })));
    tracker.add(snapshot(105, aircraft("a", 0, 0, { trackDeg: 350 })));
    expect(only(tracker, 109.25).headingDeg).toBeCloseTo(5);
  });

  it("keeps the last known heading when a report has none", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 90 })));
    tracker.add(snapshot(105, aircraft("a", 50, 0)));
    expect(only(tracker, 113).headingDeg).toBeCloseTo(90);
  });

  it("never runs a steady aircraft backward, through late snapshots and uneven fix ages", () => {
    const speed = 100; // m/s due east
    const tracker = new Tracker(AT_8);
    const ages = [0.1, 3.6, 0.5, 2, 1, 4, 0.2, 2.5, 0.9, 3, 0.4, 1.5];
    const gaps = [5, 5.3, 4.6, 5, 5.2, 4.9, 5, 10.1, 5, 4.8, 5.1, 5];
    const arrivals: TrafficSnapshot[] = [];
    let t = 100;
    ages.forEach((age, i) => {
      t += gaps[i];
      // The aircraft was at speed * (t - age) when the fix was taken, whatever the snapshot time.
      arrivals.push(snapshot(t, aircraft("a", speed * (t - age), 0, { positionAge: age, groundSpeedKt: speed * MPS, trackDeg: 90 })));
    });
    let previous = -Infinity;
    let next = 0;
    let checked = 0;
    for (let clock = 108; clock < t; clock += 0.05) {
      while (next < arrivals.length && arrivals[next].time <= clock) tracker.add(arrivals[next++]);
      const s = tracker.at(clock)[0];
      if (!s) continue;
      checked++;
      expect(s.x).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(s.x).toBeCloseTo(speed * (clock - 8), 4);
      previous = s.x;
    }
    expect(checked).toBeGreaterThan(200);
  });

  it("never runs backward when the reported ground speed is noisy", () => {
    const tracker = new Tracker(AT_8);
    const error = [3.5, 0.1, 3.4, 0.2, 3.5, 0.1, 3.3, 0.3, 3.5, 0.1];
    const arrivals = error.map((e, i) => {
      const t = 100 + 5 * i;
      return snapshot(t, aircraft("a", 100 * (t - 100), 0, { groundSpeedKt: 100 * e * MPS, trackDeg: 90 }));
    });
    let previous = -Infinity;
    let next = 0;
    for (let clock = 108; clock < 145; clock += 0.05) {
      while (next < arrivals.length && arrivals[next].time <= clock) tracker.add(arrivals[next++]);
      const s = tracker.at(clock)[0];
      if (!s) continue;
      expect(s.x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = s.x;
    }
  });

  it("ignores a snapshot that is not newer than the newest one", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(105, aircraft("a", 500, 0)));
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 9999, 0)));
    expect(only(tracker, 115).x).toBeCloseTo(500);
    expect(tracker.sampleCount).toBe(1);
  });

  it("does not add a sample when a stale fix is repeated, and keeps such an aircraft on screen", () => {
    const tracker = new Tracker(AT_8);
    // A parked aircraft whose transponder only reported once: every snapshot repeats the same old fix.
    for (let i = 0; i < 12; i++) tracker.add(snapshot(100 + 5 * i, aircraft("a", 40, 60, { onGround: true, altitudeFt: 0, groundSpeedKt: 0, trackDeg: 180, positionAge: 20 + 5 * i })));
    expect(tracker.sampleCount).toBe(1);
    const s = only(tracker, 155 + 8);
    expect(s).toMatchObject({ x: 40, y: 60, fade: 1 });
  });
});

describe("Tracker dead reckoning", () => {
  const cruising = aircraft("a", 0, 0, { groundSpeedKt: 100 * MPS, trackDeg: 90, altitudeFt: 5000, verticalRateFpm: 600 });

  it("carries on along the track and climb rate past the last sample", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, cruising));
    const s = only(tracker, 100 + 8 + 5);
    expect(s.x).toBeCloseTo(500);
    expect(s.y).toBeCloseTo(0);
    expect(s.altitudeFt).toBeCloseTo(5050);
    expect(s.fade).toBe(1);
  });

  it("follows a northbound track up the y axis", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, { ...cruising, trackDeg: 0 }));
    const s = only(tracker, 100 + 8 + 4);
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(400);
  });

  it("stops extrapolating after 15 s, then fades over 3 s and is removed", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, cruising));
    const at = (elapsed: number) => tracker.at(100 + 8 + elapsed)[0];
    expect(at(14.9).x).toBeCloseTo(1490);
    expect(at(14.9).fade).toBe(1);
    expect(at(16.5).x).toBeCloseTo(1500);
    expect(at(16.5).fade).toBeCloseTo(0.5);
    expect(at(17.7).fade).toBeCloseTo(0.1);
    expect(at(18)).toBeUndefined();
    expect(at(40)).toBeUndefined();
  });

  it("does not dead-reckon an aircraft with no ground speed", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 10, 20, { trackDeg: 45 })));
    const s = only(tracker, 100 + 8 + 6);
    expect(s).toMatchObject({ x: 10, y: 20 });
  });

  it("does not dead-reckon an aircraft whose direction was never reported, and says so", () => {
    // Taxiing aircraft often broadcast a speed with no track; guessing north would drive them off the taxiway.
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 10, 20, { onGround: true, altitudeFt: 0, groundSpeedKt: 18, positionAge: 40 })));
    const s = only(tracker, 100 + 8 + 6);
    expect(s).toMatchObject({ x: 10, y: 20, groundSpeedKt: 18, headingKnown: false });
  });

  it("marks the heading known once a report carries one, and keeps it known after a report without", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 90 })));
    tracker.add(snapshot(105, aircraft("a", 50, 0)));
    expect(only(tracker, 113).headingKnown).toBe(true);
  });

  it("stops dead-reckoning a ground aircraft some seconds past its fix, however old the fix", () => {
    // A taxiing aircraft's old fix, carried on for its whole 40 s age, would put it hundreds of metres off the taxiway.
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { onGround: true, altitudeFt: 0, groundSpeedKt: 10 * MPS, trackDeg: 90, positionAge: 40 })));
    const s = only(tracker, 100 + 8 + 2);
    expect(s.x).toBeCloseTo(10 * GROUND_DEAD_RECKON_MAX);
    // Long enough to carry a taxiing aircraft across the playback delay with a read or two missed, far short of the fix's age.
    expect(GROUND_DEAD_RECKON_MAX).toBeGreaterThanOrEqual(PLAYBACK_DELAY + 2 * 2);
    expect(GROUND_DEAD_RECKON_MAX).toBeLessThanOrEqual(20);
  });


  it("does not climb an aircraft through the ground", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0, { altitudeFt: 100, verticalRateFpm: -3000, groundSpeedKt: 100 * MPS, trackDeg: 90 })));
    expect(only(tracker, 100 + 8 + 10).altitudeFt).toBe(0);
  });

  it("holds an aircraft that keeps reporting, however old the last fix is", () => {
    const tracker = new Tracker(AT_8);
    for (let i = 0; i < 10; i++) tracker.add(snapshot(100 + 5 * i, { ...cruising, x: 0, positionAge: 30 }));
    // Fixes are 30 s old and never change, yet the aircraft is in every snapshot: it stays.
    expect(tracker.at(145 + 8)[0].fade).toBe(1);
  });

  it("fades an aircraft out when it stops appearing in snapshots", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, cruising));
    tracker.add(snapshot(105, { ...cruising, x: 500 }));
    // Last seen at 105: dead reckoning to 120, fading out by 123 (render time).
    for (let i = 2; i < 6; i++) tracker.add(snapshot(100 + 5 * i, aircraft("b", 0, 0)));
    expect(tracker.at(121.5 + 8).find((s) => s.id === "a")?.fade).toBeCloseTo(0.5);
    expect(tracker.at(123 + 8).find((s) => s.id === "a")).toBeUndefined();
  });
});

describe("Tracker fade in", () => {
  it("brings a new aircraft up over 2 s, starting when it becomes visible", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 10, 0), aircraft("b", 0, 0)));
    const b = (time: number) => tracker.at(time).find((s) => s.id === "b");
    expect(b(105 + 8 - 0.5)).toBeUndefined();
    expect(b(105 + 8 + 0.5)?.fade).toBeCloseTo(0.25);
    expect(b(105 + 8 + 1)?.fade).toBeCloseTo(0.5);
    expect(b(105 + 8 + 2)?.fade).toBe(1);
    expect(tracker.at(105 + 8 - 0.5).map((s) => s.id)).toEqual(["a"]);
  });

  it("does not fade an established aircraft in again when it reappears in the next snapshot", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 10, 0)));
    expect(only(tracker, 105 + 8 + 3).fade).toBe(1);
  });
});

describe("Tracker memory", () => {
  it("keeps only the samples the playback window needs", () => {
    const tracker = new Tracker(AT_8);
    for (let i = 0; i < 2000; i++) {
      const t = 100 + 5 * i;
      tracker.add(snapshot(t, aircraft("a", 10 * i, 0), aircraft("b", 0, 10 * i)));
    }
    // Two aircraft, each needing the segment around render time 8 s back plus a margin.
    expect(tracker.size).toBe(2);
    expect(tracker.sampleCount).toBeLessThanOrEqual(2 * 6);
    // Dropping old samples does not disturb what is on screen.
    const last = 100 + 5 * 1999;
    expect(tracker.at(last + 2.5).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("forgets an aircraft once it has faded out", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    for (let i = 1; i < 12; i++) tracker.add(snapshot(100 + 5 * i, aircraft("b", 0, 0)));
    expect(tracker.size).toBe(1);
    expect(tracker.sampleCount).toBeLessThanOrEqual(6);
  });
});

describe("Tracker corrections", () => {
  /** Frame-by-frame x positions of aircraft "a" from `from` to `to` on the clock, feeding each snapshot as it arrives. */
  function watch(tracker: Tracker, arrivals: TrafficSnapshot[], from: number, to: number, fps = 60) {
    const frames: { clock: number; x: number }[] = [];
    let next = 0;
    for (let clock = from; clock <= to; clock += 1 / fps) {
      while (next < arrivals.length && arrivals[next].time <= clock) tracker.add(arrivals[next++]);
      const s = tracker.at(clock).find((a) => a.id === "a");
      if (s) frames.push({ clock, x: s.x });
    }
    return frames;
  }

  const worstStep = (frames: { x: number }[]) => Math.max(...frames.slice(1).map((f, i) => Math.abs(f.x - frames[i].x)));

  // Eastbound at 100 m/s, heard at 100; the next report is 15 s late and shows it slowed, 900 m on at 110.
  const east = (x: number, age = 0, speed = 100) => aircraft("a", x, 0, { groundSpeedKt: speed * MPS, trackDeg: 90, positionAge: age });
  const late = [snapshot(100, east(0)), snapshot(115, east(900, 5, 80))];

  it("blends a late report in over a second or two instead of jumping to it", () => {
    const frames = watch(new Tracker(AT_8), late, 108, 125);
    // Dead reckoning had it at 700 m when the report put it near 650 m; no frame may jump that gap.
    expect(worstStep(frames)).toBeLessThan(4);
  });

  it("ends up on the reported track once the blend has run out", () => {
    const watched = watch(new Tracker(AT_8), late, 108, 125);
    // A tracker that nobody drew before the report arrived has nothing to blend from: its path is the reported one.
    const unwatched = new Tracker(AT_8);
    for (const s of late) unwatched.add(s);
    const at = (clock: number) => watched.reduce((best, f) => (Math.abs(f.clock - clock) < Math.abs(best.clock - clock) ? f : best));
    expect(Math.abs(at(115.2).x - only(unwatched, at(115.2).clock).x)).toBeGreaterThan(20);
    expect(at(118).x).toBeCloseTo(only(unwatched, at(118).clock).x, 0);
  });

  it("jumps straight to a report that is too far off to be the same track", () => {
    const frames = watch(new Tracker(AT_8), [snapshot(100, east(0)), snapshot(115, east(20_000, 5))], 108, 116);
    const last = frames.at(-1)!;
    const unwatched = new Tracker(AT_8);
    unwatched.add(snapshot(100, east(0)));
    unwatched.add(snapshot(115, east(20_000, 5)));
    expect(last.x).toBeCloseTo(only(unwatched, last.clock).x, 3);
  });
});

describe("Tracker corrections, large ones", () => {
  it("spreads a large correction over longer, so the catch-up stays a glide", () => {
    // Dead reckoning carries it to 700 m; the late report says it all but stopped at 150 m.
    const east = (x: number, age = 0, speed = 100) => aircraft("a", x, 0, { groundSpeedKt: speed * MPS, trackDeg: 90, positionAge: age });
    const tracker = new Tracker(AT_8);
    const arrivals = [snapshot(100, east(0)), snapshot(115, east(150, 5, 1))];
    const xs: number[] = [];
    let next = 0;
    for (let clock = 110; clock <= 125; clock += 1 / 60) {
      while (next < arrivals.length && arrivals[next].time <= clock) tracker.add(arrivals[next++]);
      xs.push(only(tracker, clock).x);
    }
    const worst = Math.max(...xs.slice(1).map((x, i) => Math.abs(x - xs[i])));
    // About 600 m to give back: at the shortest decay that is 17 m in the first frame.
    expect(worst).toBeLessThan(8);
  });
});

describe("Tracker dead reckoning limit", () => {
  it("carries an aircraft on as far as it is told to: the world map flies a recorded moment on", () => {
    const cruise = aircraft("a", 0, 0, { altitudeFt: 35000, groundSpeedKt: 200 * MPS, trackDeg: 90 });
    const usual = new Tracker(AT_8);
    usual.add(snapshot(100, cruise));
    // 60 s past the fix (plus the 8 s delay) is long past the usual 15 s of dead reckoning and its fade.
    expect(usual.at(168)).toEqual([]);
    const onward = new Tracker({ ...AT_8, deadReckonMax: Infinity });
    onward.add(snapshot(100, cruise));
    const s = only(onward, 168);
    expect(s.fade).toBe(1);
    expect(s.x).toBeCloseTo(12_000);
  });
});

describe("Tracker before its oldest fix", () => {
  it("holds a lone pruned fix when the drawn moment trails the feed, rather than throwing", () => {
    const tracker = new Tracker({ playbackDelay: 0 });
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(120, aircraft("a", 20, 0)));
    tracker.add(snapshot(135, aircraft("a", 35, 0)));
    // The same fix again, now 15 s old: no new sample, and pruning leaves only the fix at 135.
    tracker.add(snapshot(150, aircraft("a", 35, 0, { positionAge: 15 })));
    const s = only(tracker, 130);
    expect(s.fade).toBeGreaterThan(0);
    expect(s.x).toBeCloseTo(35);
  });
});

/** Slower than this, knots, an aircraft is at rest, and may set off in any direction. */
const AT_REST_KT = 1;
/** The least per-frame step bound, metres: a correction of an aircraft at rest still settles. */
const STEP_FLOOR_M = 5;

interface Frame {
  clock: number;
  /** A snapshot was added just before this frame was drawn. */
  read: boolean;
  aircraft: Map<string, TrackedAircraft>;
}

/** Plays `arrivals` through `tracker` as a page would, each added once the clock reaches its time, sampling every aircraft at `fps`. */
function play(
  tracker: Tracker,
  arrivals: Pick<TrafficSnapshot, "time" | "aircraft">[],
  from: number,
  to: number,
  fps = 60,
  read: (clock: number) => TrackedAircraft[] = (clock) => tracker.at(clock),
  listing?: Listing,
): Frame[] {
  const frames: Frame[] = [];
  let next = 0;
  for (let i = 0; from + i / fps <= to; i++) {
    const clock = from + i / fps;
    let heard = false;
    while (next < arrivals.length && arrivals[next].time <= clock) {
      tracker.add(arrivals[next++], listing);
      heard = true;
    }
    frames.push({ clock, read: heard, aircraft: new Map(read(clock).map((a) => [a.id, a])) });
  }
  return frames;
}

/**
 * Every frame-to-frame move that breaks the motion rules: a move back against the aircraft's move in the
 * frame before (unless it was at rest, where it may set off any way, as after a pushback), or a move
 * longer than about one second of its own speed, unless it is a snap over CORRECTION_SNAP as a read arrives.
 * `slack`, metres, is what a move held exactly square to its way may show against it once turned into another
 * view's metres (a geographic tracker draws in metres measured from near each aircraft).
 */
function violations(frames: Frame[], slack = 1e-6) {
  const out: string[] = [];
  const heading = new Map<string, [number, number]>();
  let moves = 0;
  for (let i = 1; i < frames.length; i++) {
    for (const [id, a] of frames[i].aircraft) {
      const before = frames[i - 1].aircraft.get(id);
      if (!before) {
        heading.delete(id);
        continue;
      }
      const dx = a.x - before.x;
      const dy = a.y - before.y;
      const step = Math.hypot(dx, dy);
      moves++;
      const speed = (before.groundSpeedKt ?? 0) * KNOTS;
      const atRest = before.groundSpeedKt !== null && before.groundSpeedKt < AT_REST_KT;
      const bound = Math.max(speed, STEP_FLOOR_M) * 1 + slack;
      const snapped = frames[i].read && step > CORRECTION_SNAP;
      if (step > bound && !snapped) out.push(`${id} stepped ${step.toFixed(1)} m at ${frames[i].clock.toFixed(2)} (bound ${bound.toFixed(1)} m)`);
      // In the air the reported track is the way it is going over the ground: it never moves against it.
      if (!before.onGround && before.headingKnown && !snapped) {
        const along = dx * Math.sin((before.headingDeg * Math.PI) / 180) + dy * Math.cos((before.headingDeg * Math.PI) / 180);
        if (along < -slack) out.push(`${id} flew ${(-along).toFixed(3)} m back along its track at ${frames[i].clock.toFixed(2)}`);
      }
      const travel = heading.get(id);
      if (travel && !atRest && !snapped && dx * travel[0] + dy * travel[1] < -slack) out.push(`${id} moved ${(-(dx * travel[0] + dy * travel[1])).toFixed(3)} m backward at ${frames[i].clock.toFixed(2)}`);
      // A frame it stood still in, or a snap, leaves it free to set off any way.
      if (snapped || step <= 1e-3) heading.delete(id);
      else heading.set(id, [dx / step, dy / step]);
    }
  }
  return { out, moves };
}

describe("Tracker motion over the recorded ATL sequence", () => {
  let snapshots: TrafficSnapshot[];
  beforeAll(async () => {
    // About six minutes of live ATL traffic, read every 15 s: well past the playback delay, so every
    // aircraft is dead reckoned and then corrected as each read arrives.
    const bytes = readFileSync(path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz"));
    snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
  });

  it("never moves a drawn aircraft backward along its travel, nor more than a second of its own speed in a frame", () => {
    const frames = play(new Tracker(AT_8), snapshots, snapshots[0].time, snapshots.at(-1)!.time + PLAYBACK_DELAY);
    const { out, moves } = violations(frames);
    expect(moves).toBeGreaterThan(100_000);
    expect(out.slice(0, 20), `${out.length} violations`).toEqual([]);
  });
});

describe("Tracker motion rules", () => {
  const east = (x: number, age = 0, speed = 100) => aircraft("a", x, 0, { groundSpeedKt: speed * MPS, trackDeg: 90, positionAge: age });
  const xs = (frames: Frame[]) => frames.flatMap((f) => (f.aircraft.has("a") ? [f.aircraft.get("a")!.x] : []));

  it("holds back an aircraft drawn ahead of a late report instead of running it backward", () => {
    // Dead reckoning carries it to 700 m; the late report says it slowed, so its path is now behind.
    const frames = play(new Tracker(AT_8), [snapshot(100, east(0)), snapshot(115, east(900, 5, 80))], 108, 130);
    const path = xs(frames);
    for (let i = 1; i < path.length; i++) expect(path[i]).toBeGreaterThanOrEqual(path[i - 1] - 1e-9);
    expect(violations(frames).out).toEqual([]);
  });

  it("blends a correction a little under the snap distance forward, and snaps one a little over it", () => {
    // Heard at 100 heading east and dead reckoned to 700 m when the next report arrives; that report's fix
    // (taken at 106) puts it at 1100 m and `north` metres off the line: an error of hypot(400, north).
    const off = (north: number) => [snapshot(100, east(0)), snapshot(115, aircraft("a", 1000, north, { groundSpeedKt: 100 * MPS, trackDeg: 90, positionAge: 9 }))];
    const blended = play(new Tracker(AT_8), off(1_400), 108, 130);
    expect(violations(blended).out).toEqual([]);
    const ys = blended.flatMap((f) => (f.aircraft.has("a") ? [f.aircraft.get("a")!.y] : []));
    expect(Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i])))).toBeLessThan(100);
    const snapped = play(new Tracker(AT_8), off(1_600), 108, 130);
    const snappedYs = snapped.flatMap((f) => (f.aircraft.has("a") ? [f.aircraft.get("a")!.y] : []));
    const jumps = snappedYs.slice(1).map((y, i) => Math.abs(y - snappedYs[i]));
    expect(Math.max(...jumps)).toBeGreaterThan(1_500);
    expect(jumps.filter((j) => j > 100)).toHaveLength(1);
  });

  it("holds to the rules for an aircraft that reports no ground speed, bounding its step by its path's own", () => {
    // No speed reported: its path between fixes is its only speed. The late report is off its line.
    const bare = (x: number, y: number, age = 0) => aircraft("a", x, y, { trackDeg: 90, positionAge: age });
    const frames = play(new Tracker(AT_8), [snapshot(100, bare(0, 0)), snapshot(105, bare(500, 0)), snapshot(120, bare(1000, 300, 5))], 108, 130);
    const path = xs(frames);
    expect(path.length).toBeGreaterThan(600);
    for (let i = 1; i < path.length; i++) expect(path[i]).toBeGreaterThanOrEqual(path[i - 1] - 1e-9);
    const ys = frames.flatMap((f) => (f.aircraft.has("a") ? [f.aircraft.get("a")!.y] : []));
    // Never more than a second of its 100 m/s path in a frame, and no jump onto the new line.
    expect(Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i])))).toBeLessThan(10);
    expect(ys.at(-1)).toBeCloseTo(300, 0);
  });

  it("keeps a taxiing aircraft moving across a gap between reads", () => {
    // Taxiing east at 10 m/s, read every 5 s, but two reads in a row are missed: 15 s between fixes.
    const taxi = (t: number) => aircraft("a", 10 * (t - 100), 0, { onGround: true, altitudeFt: 0, groundSpeedKt: 10 * MPS, trackDeg: 90 });
    const reads = [100, 105, 110, 125, 130, 135].map((t) => snapshot(t, taxi(t)));
    const frames = play(new Tracker(AT_8), reads, 108, 138);
    const path = xs(frames);
    // Every frame it moves on at close to its 10 m/s, never stalling at the end of its dead reckoning.
    for (let i = 1; i < path.length; i++) expect(path[i] - path[i - 1]).toBeGreaterThan((0.5 * 10) / 60);
    // And it is where it really was.
    expect(path.at(-1)).toBeCloseTo(10 * (138 - DELAY - 100), 0);
  });

  it("reckons a ground aircraft that is moving tail first, in a pushback, the way it is going", () => {
    // Nose to the west (track 270) but pushed back east at 1 m/s, as the recorded DAL3029 was.
    const push = (t: number) => aircraft("a", t - 100, 0, { onGround: true, altitudeFt: 0, groundSpeedKt: 1 * MPS, trackDeg: 270 });
    const frames = play(new Tracker(AT_8), [snapshot(100, push(100)), snapshot(110, push(110)), snapshot(125, push(125))], 112, 136);
    expect(violations(frames).out).toEqual([]);
    const path = xs(frames);
    for (let i = 1; i < path.length; i++) expect(path[i]).toBeGreaterThanOrEqual(path[i - 1] - 1e-9);
  });
});

describe("Tracker through a stale spell", () => {
  it("holds an aircraft standing on the ground for as long as the server serves its last answer, not 15 s", () => {
    const tracker = new Tracker(AT_8);
    const parked = aircraft("p1", 100, 200, { onGround: true, altitudeFt: 0, groundSpeedKt: 0 });
    tracker.add(snapshot(1000, parked));
    // A minute on, with no newer answer (adsb.lol answering 429), it is still there, where it stood.
    expect(only(tracker, 1000 + 8 + 60)).toMatchObject({ id: "p1", x: 100, y: 200, fade: 1 });
    // Past the 90 s the server stops serving it, it goes.
    expect(tracker.at(1000 + 8 + 90 + FADE_OUT + 1)).toHaveLength(0);
  });

  it("still lets a moving aircraft go after 15 s of flying on, as its position is only a guess", () => {
    const tracker = new Tracker(AT_8);
    tracker.add(snapshot(1000, aircraft("m1", 0, 0, { groundSpeedKt: 250, trackDeg: 90 })));
    expect(tracker.at(1000 + 8 + 15 + FADE_OUT + 1)).toHaveLength(0);
  });
});

describe("Tracker shared by every view", () => {
  const ATL = DEFAULT_AIRPORT;
  /** An aircraft `x` metres east and `y` north of Atlanta, as every feed lists it: by its latitude and longitude. */
  const at = (id: string, x: number, y: number, extra: Partial<Aircraft> = {}) => {
    const [latitude, longitude] = toGeo(ATL, x, y);
    return aircraft(id, x, y, { latitude, longitude, ...extra });
  };
  const listing = (time: number, ...list: Aircraft[]) => ({ time, aircraft: list });
  const ids = (list: TrackedAircraft[]) => list.map((a) => a.id).sort();

  it("plays the page 12 s behind live", () => {
    expect(PLAYBACK_DELAY).toBe(12);
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(110, aircraft("a", 1000, 0)));
    expect(only(tracker, 117).x).toBeCloseTo(500);
  });

  it("gives one pose for an aircraft whichever poll delivered each of its fixes", () => {
    // A fix every 2.5 s of an aircraft flying east at 200 m/s. Each poll answers on a clock of its own: the
    // region read's runs 0.7 s ahead of the airport feed's and the hex poll's 0.3 s, so each lists the same
    // fix as that much older.
    const fixes = [100, 102.5, 105, 107.5, 110, 112.5, 115, 117.5, 120];
    const polls = [
      { feed: "airport:atl", skew: 0 },
      { feed: "region", skew: 0.7 },
      { feed: "hex", skew: 0.3 },
    ];
    const run = (poll: (i: number) => number) => {
      const tracker = new Tracker({ geographic: true });
      const poses: (number[] | null)[] = [];
      let next = 0;
      for (let i = 0; 100 + i / 60 <= 136; i++) {
        const clock = 100 + i / 60;
        for (; next < fixes.length && fixes[next] <= clock; next++) {
          const { feed, skew } = polls[poll(next)];
          const t = fixes[next];
          tracker.add(listing(t + skew, at("a", 200 * (t - 100), 0, { groundSpeedKt: 200 * MPS, trackDeg: 90, verticalRateFpm: 600, positionAge: skew })), { feed });
        }
        const a = tracker.one("a", clock);
        poses.push(a ? [a.latitude!, a.longitude!, a.altitudeFt, a.headingDeg, a.fade] : null);
      }
      return poses;
    };
    const airportOnly = run(() => 0);
    expect(airportOnly.filter((p) => p !== null).length).toBeGreaterThan(1000);
    for (const poll of [(i: number) => i % 3, (i: number) => (2 * i + 1) % 3, (i: number) => (i < 4 ? 1 : 2)]) {
      const other = run(poll);
      expect(other.length).toBe(airportOnly.length);
      other.forEach((p, i) => {
        const q = airportOnly[i];
        expect(p === null).toBe(q === null);
        if (p && q) p.forEach((v, k) => expect(v).toBeCloseTo(q[k], 9));
      });
    }
  });

  it("uses an older fix from another poll that lands between the fixes it holds, and still drops a poll's stale repeat", () => {
    const tracker = new Tracker({ geographic: true, playbackDelay: DELAY });
    tracker.add(listing(100, at("a", 0, 0)), { feed: "airport:atl" });
    tracker.add(listing(110, at("a", 1000, 0)), { feed: "airport:atl" });
    // The region read answers on an older clock than the airport feed's newest: its fix, taken at 105, is real.
    tracker.add(listing(107, at("a", 500, 300, { positionAge: 2 })), { feed: "region" });
    expect(tracker.sampleCount).toBe(3);
    // The same region answer served again, and an older one, add nothing.
    tracker.add(listing(107, at("a", 9_999, 9_999, { positionAge: 2 })), { feed: "region" });
    tracker.add(listing(104, at("a", 9_999, 9_999)), { feed: "region" });
    expect(tracker.sampleCount).toBe(3);
    const a = tracker.one("a", 105 + DELAY, { frame: ATL })!;
    expect(a.x).toBeCloseTo(500, 3);
    expect(a.y).toBeCloseTo(300, 3);
  });

  it("hears the same fix from two polls, on two clocks, as one fix", () => {
    const tracker = new Tracker({ geographic: true });
    tracker.add(listing(100, at("a", 0, 0)), { feed: "airport:atl" });
    tracker.add(listing(105, at("a", 500, 0, { positionAge: 2 })), { feed: "airport:atl" });
    // The region read lists the fix taken at 103 as taken at 103.4: its clock runs a little ahead.
    tracker.add(listing(105.6, at("a", 500, 0, { positionAge: 2.2 })), { feed: "region" });
    expect(tracker.sampleCount).toBe(2);
  });

  it("draws each view's aircraft from the feeds it reads, and fades one out as those feeds lose it", () => {
    const tracker = new Tracker({ geographic: true, playbackDelay: DELAY });
    // The airport feed lists a and b once; the region read lists all three, and goes on listing them.
    const region = (t: number) => tracker.add(listing(t, at("a", 0, 0), at("b", 5_000, 0), at("c", 90_000, 0)), { feed: "region", reckon: 30 });
    tracker.add(listing(100, at("a", 0, 0), at("b", 5_000, 0)), { feed: "airport:atl" });
    region(100);
    expect(ids(tracker.at(100 + DELAY + 5, { feeds: ["airport:atl"] }))).toEqual(["a", "b"]);
    expect(ids(tracker.at(100 + DELAY + 5))).toEqual(["a", "b", "c"]);
    for (let t = 110; t <= 130; t += 10) region(t);
    // Past the airport feed's 15 s of flying on and its fade, the airport's view has let them go; the map has not.
    expect(ids(tracker.at(100 + DELAY + 15 + FADE_OUT + 1, { feeds: ["airport:atl"] }))).toEqual([]);
    expect(ids(tracker.at(100 + DELAY + 15 + FADE_OUT + 1))).toEqual(["a", "b", "c"]);
  });

  it("reads an aircraft in any view's metres where the airport's own tracker draws it", () => {
    const fix = at("a", 2_000, -3_000, { groundSpeedKt: 150 * MPS, trackDeg: 45 });
    const tracker = new Tracker({ geographic: true });
    tracker.add(listing(100, fix), { feed: "airport:atl" });
    const plain = new Tracker();
    plain.add(snapshot(100, fix));
    const inAtl = tracker.one("a", 120, { frame: ATL })!;
    const inMap = tracker.one("a", 120, { frame: MAP_ORIGIN })!;
    // Within half a metre: flown on 1.2 km from 3.6 km out, the airport's own metres turn its track a hundredth of a degree.
    expect(inAtl.x).toBeCloseTo(plain.at(120)[0].x, 0);
    expect(inAtl.y).toBeCloseTo(plain.at(120)[0].y, 0);
    const [lat, lon] = toGeo(MAP_ORIGIN, inMap.x, inMap.y);
    expect(lat).toBeCloseTo(inAtl.latitude!, 9);
    expect(lon).toBeCloseTo(inAtl.longitude!, 9);
  });

  it("flies an aircraft on along its true track, wherever it is from the point any view measures from", () => {
    // 300 km west of Atlanta, due north at 100 m/s, first heard 40 km west of the fix it is flown on from, so
    // north there is not north where it was first heard: 1.2 km on, it is due north of that fix, as the map has north.
    const far = at("a", -300_000, 0, { groundSpeedKt: 100 * MPS, trackDeg: 0 });
    const [startLat, startLon] = toGeo({ latitude: far.latitude, longitude: far.longitude }, -40_000, 0);
    const tracker = new Tracker({ geographic: true });
    tracker.add(listing(100, { ...far, latitude: startLat, longitude: startLon }));
    tracker.add(listing(500, far));
    const a = tracker.one("a", 500 + PLAYBACK_DELAY + 12)!;
    const [east, north] = toLocal({ latitude: far.latitude, longitude: far.longitude }, a.latitude!, a.longitude!);
    expect(Math.abs(east)).toBeLessThan(0.05);
    expect(north).toBeCloseTo(1_200, 1);
    expect(Math.min(a.headingDeg, 360 - a.headingDeg)).toBeLessThan(1e-3);
  });

  it("carries a flight that has come a long way from its first fix on without a step or a turn", () => {
    // East at 250 m/s for ten minutes, read every 5 s: 150 km, well past where its metres are measured from at first.
    const fixes = Array.from({ length: 121 }, (_, i) => listing(100 + 5 * i, at("a", 250 * 5 * i, 0, { groundSpeedKt: 250 * MPS, trackDeg: 90 })));
    const tracker = new Tracker({ geographic: true });
    const frames = play(tracker, fixes, 100, 700, 10, (clock) => tracker.at(clock, { frame: ATL }));
    expect(violations(frames).out).toEqual([]);
    const path = frames.flatMap((f) => (f.aircraft.has("a") ? [f.aircraft.get("a")!] : []));
    expect(path.length).toBeGreaterThan(5_000);
    for (let i = 1; i < path.length; i++) expect(path[i].x - path[i - 1].x).toBeGreaterThan(20);
    expect(Math.max(...path.map((a) => Math.abs(a.y)))).toBeLessThan(2_000);
  });
});

describe("Tracker shared by every view, over the recorded ATL sequence", () => {
  let snapshots: TrafficSnapshot[];
  beforeAll(async () => {
    const bytes = readFileSync(path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz"));
    snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
  });
  const ATL = DEFAULT_AIRPORT;
  const FEED = { feed: "airport:atl" };
  type Reader = (tracker: Tracker, clock: number) => TrackedAircraft[];
  const diorama: Reader = (tracker, clock) => tracker.at(clock, { frame: ATL, feeds: [FEED.feed] });
  const worldMap: Reader = (tracker, clock) => tracker.at(clock, { frame: MAP_ORIGIN });

  /** Plays the sequence into a tracker shared with the airport feed, read each frame by every reader in turn at that frame's one moment. */
  function shared(readers: Reader[], fps = 30) {
    const tracker = new Tracker({ geographic: true });
    const frames: { clock: number; read: boolean; views: TrackedAircraft[][] }[] = [];
    let next = 0;
    const from = snapshots[0].time;
    const to = snapshots.at(-1)!.time + PLAYBACK_DELAY;
    for (let i = 0; from + i / fps <= to; i++) {
      const clock = from + i / fps;
      let read = false;
      for (; next < snapshots.length && snapshots[next].time <= clock; next++, read = true) tracker.add(snapshots[next], FEED);
      frames.push({ clock, read, views: readers.map((r) => r(tracker, clock)) });
    }
    return frames;
  }

  it("gives the Diorama, the World map and the Journey the same pose in one frame, and keeps the motion rules for each", () => {
    const followed = snapshots[0].aircraft.find((a) => !a.onGround)!.id;
    const journey: Reader = (tracker, clock) => {
      const a = tracker.one(followed, clock);
      return a ? [a] : [];
    };
    const frames = shared([diorama, worldMap, journey]);
    let compared = 0;
    let journeyed = 0;
    for (const { views } of frames) {
      const [inAtl, onMap, followedOnly] = views;
      const mapById = new Map(onMap.map((a) => [a.id, a]));
      for (const a of inAtl) {
        const m = mapById.get(a.id)!;
        expect([m.latitude, m.longitude, m.altitudeFt, m.headingDeg]).toEqual([a.latitude, a.longitude, a.altitudeFt, a.headingDeg]);
        compared++;
      }
      for (const j of followedOnly) {
        expect(mapById.get(j.id)).toMatchObject({ latitude: j.latitude, longitude: j.longitude, altitudeFt: j.altitudeFt });
        journeyed++;
      }
    }
    expect(compared).toBeGreaterThan(50_000);
    expect(journeyed).toBeGreaterThan(1_000);
    // The rules of the replay test hold for what the Diorama draws, read alongside the others (and so for the
    // others, which draw the same poses: in the map's metres, measured from far off, north is turned some degrees).
    const { out, moves } = violations(
      frames.map((f) => ({ clock: f.clock, read: f.read, aircraft: new Map(f.views[0].map((a) => [a.id, a])) })),
      1e-3,
    );
    expect(moves).toBeGreaterThan(50_000);
    expect(out.slice(0, 20), `${out.length} violations`).toEqual([]);
  });

  it("smooths an aircraft the same whether one view reads it or three", () => {
    const alone = shared([diorama]);
    const together = shared([worldMap, diorama, (tracker, clock) => tracker.at(clock)]);
    expect(together.length).toBe(alone.length);
    alone.forEach((f, i) => expect(together[i].views[1]).toEqual(f.views[0]));
  });

  it("draws the Diorama where the airport's own tracker draws it, to within a metre for every 10 km from the field", () => {
    const end = snapshots.at(-1)!.time + PLAYBACK_DELAY;
    const plain = play(new Tracker(), snapshots, snapshots[0].time, end, 10);
    const tracker = new Tracker({ geographic: true });
    const geo = play(tracker, snapshots, snapshots[0].time, end, 10, (clock) => diorama(tracker, clock), FEED);
    let near = 0;
    let far = 0;
    plain.forEach((frame, i) => {
      expect([...geo[i].aircraft.keys()].sort()).toEqual([...frame.aircraft.keys()].sort());
      for (const [id, a] of frame.aircraft) {
        const g = geo[i].aircraft.get(id)!;
        const off = Math.hypot(g.x - a.x, g.y - a.y);
        const out = Math.hypot(a.x, a.y);
        if (out < 5_000) near = Math.max(near, off);
        else far = Math.max(far, off / (out / 10_000));
      }
    });
    // The airport's own tracker flies an aircraft on along its track as though north were north in Atlanta's
    // metres, which turn it about a twentieth of a degree for every 10 km from the field: over the kilometres an
    // aircraft is flown on, that is the gap (the shared tracker measures north where the aircraft is, as below).
    expect(near).toBeLessThan(2);
    expect(far).toBeLessThan(5);
  });
});
