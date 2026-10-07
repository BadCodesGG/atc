import { describe, expect, it } from "vitest";
import { KNOTS } from "./geo";
import { FADE_OUT, GROUND_DEAD_RECKON_MAX, Tracker } from "./tracker";
import type { Aircraft, TrafficSnapshot } from "./traffic";

/** Knots that make one metre per second, so positions in these tests read as plain arithmetic. */
const MPS = 1 / KNOTS;

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

/** The tracker's view of one aircraft at `time`, where the default playback delay is 8 s. */
function only(tracker: Tracker, time: number) {
  const states = tracker.at(time);
  expect(states.length).toBeLessThanOrEqual(1);
  return states[0];
}

describe("Tracker interpolation", () => {
  it("renders 8 s behind the clock, halfway between two samples", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    // This fix is 2 s old, so it belongs at t=103 and the segment 100..103 is what gets interpolated.
    tracker.add(snapshot(105, aircraft("a", 300, 0, { positionAge: 2 })));
    expect(only(tracker, 109.5).x).toBeCloseTo(150);
  });

  it("carries identity fields from the newest report", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 10, 0, { callsign: "DAL1", typeCode: "B752", category: "A4" })));
    expect(only(tracker, 110)).toMatchObject({ callsign: "DAL1", typeCode: "B752", category: "A4" });
  });

  it("takes the ground flag from the nearer sample", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0, { onGround: true, altitudeFt: 0 })));
    tracker.add(snapshot(110, aircraft("a", 500, 0, { onGround: false })));
    expect(only(tracker, 111).onGround).toBe(true);
    expect(only(tracker, 116).onGround).toBe(false);
  });

  it("turns through north when the heading passes 350 to 10", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 10 })));
    tracker.add(snapshot(105, aircraft("a", 0, 0, { trackDeg: 350 })));
    expect(only(tracker, 109.25).headingDeg).toBeCloseTo(5);
  });

  it("keeps the last known heading when a report has none", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 90 })));
    tracker.add(snapshot(105, aircraft("a", 50, 0)));
    expect(only(tracker, 113).headingDeg).toBeCloseTo(90);
  });

  it("never runs a steady aircraft backward, through late snapshots and uneven fix ages", () => {
    const speed = 100; // m/s due east
    const tracker = new Tracker();
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
    const tracker = new Tracker();
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
    const tracker = new Tracker();
    tracker.add(snapshot(105, aircraft("a", 500, 0)));
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 9999, 0)));
    expect(only(tracker, 115).x).toBeCloseTo(500);
    expect(tracker.sampleCount).toBe(1);
  });

  it("does not add a sample when a stale fix is repeated, and keeps such an aircraft on screen", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
    tracker.add(snapshot(100, cruising));
    const s = only(tracker, 100 + 8 + 5);
    expect(s.x).toBeCloseTo(500);
    expect(s.y).toBeCloseTo(0);
    expect(s.altitudeFt).toBeCloseTo(5050);
    expect(s.fade).toBe(1);
  });

  it("follows a northbound track up the y axis", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(100, { ...cruising, trackDeg: 0 }));
    const s = only(tracker, 100 + 8 + 4);
    expect(s.x).toBeCloseTo(0);
    expect(s.y).toBeCloseTo(400);
  });

  it("stops extrapolating after 15 s, then fades over 3 s and is removed", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 10, 20, { trackDeg: 45 })));
    const s = only(tracker, 100 + 8 + 6);
    expect(s).toMatchObject({ x: 10, y: 20 });
  });

  it("does not dead-reckon an aircraft whose direction was never reported, and says so", () => {
    // Taxiing aircraft often broadcast a speed with no track; guessing north would drive them off the taxiway.
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 10, 20, { onGround: true, altitudeFt: 0, groundSpeedKt: 18, positionAge: 40 })));
    const s = only(tracker, 100 + 8 + 6);
    expect(s).toMatchObject({ x: 10, y: 20, groundSpeedKt: 18, headingKnown: false });
  });

  it("marks the heading known once a report carries one, and keeps it known after a report without", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0, { trackDeg: 90 })));
    tracker.add(snapshot(105, aircraft("a", 50, 0)));
    expect(only(tracker, 113).headingKnown).toBe(true);
  });

  it("stops dead-reckoning a ground aircraft a few seconds past its fix, however old the fix", () => {
    // A taxiing aircraft's old fix, carried on for its whole 40 s age, would put it hundreds of metres off the taxiway.
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0, { onGround: true, altitudeFt: 0, groundSpeedKt: 10 * MPS, trackDeg: 90, positionAge: 40 })));
    const s = only(tracker, 100 + 8 + 2);
    expect(s.x).toBeCloseTo(10 * GROUND_DEAD_RECKON_MAX);
    expect(GROUND_DEAD_RECKON_MAX).toBeLessThanOrEqual(6);
  });


  it("does not climb an aircraft through the ground", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0, { altitudeFt: 100, verticalRateFpm: -3000, groundSpeedKt: 100 * MPS, trackDeg: 90 })));
    expect(only(tracker, 100 + 8 + 10).altitudeFt).toBe(0);
  });

  it("holds an aircraft that keeps reporting, however old the last fix is", () => {
    const tracker = new Tracker();
    for (let i = 0; i < 10; i++) tracker.add(snapshot(100 + 5 * i, { ...cruising, x: 0, positionAge: 30 }));
    // Fixes are 30 s old and never change, yet the aircraft is in every snapshot: it stays.
    expect(tracker.at(145 + 8)[0].fade).toBe(1);
  });

  it("fades an aircraft out when it stops appearing in snapshots", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
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
    const tracker = new Tracker();
    tracker.add(snapshot(100, aircraft("a", 0, 0)));
    tracker.add(snapshot(105, aircraft("a", 10, 0)));
    expect(only(tracker, 105 + 8 + 3).fade).toBe(1);
  });
});

describe("Tracker memory", () => {
  it("keeps only the samples the playback window needs", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
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
    const frames = watch(new Tracker(), late, 108, 125);
    // Dead reckoning had it at 700 m when the report put it near 650 m; no frame may jump that gap.
    expect(worstStep(frames)).toBeLessThan(4);
  });

  it("ends up on the reported track once the blend has run out", () => {
    const watched = watch(new Tracker(), late, 108, 125);
    // A tracker that nobody drew before the report arrived has nothing to blend from: its path is the reported one.
    const unwatched = new Tracker();
    for (const s of late) unwatched.add(s);
    const at = (clock: number) => watched.reduce((best, f) => (Math.abs(f.clock - clock) < Math.abs(best.clock - clock) ? f : best));
    expect(Math.abs(at(115.2).x - only(unwatched, at(115.2).clock).x)).toBeGreaterThan(20);
    expect(at(118).x).toBeCloseTo(only(unwatched, at(118).clock).x, 0);
  });

  it("jumps straight to a report that is too far off to be the same track", () => {
    const frames = watch(new Tracker(), [snapshot(100, east(0)), snapshot(115, east(20_000, 5))], 108, 116);
    const last = frames.at(-1)!;
    const unwatched = new Tracker();
    unwatched.add(snapshot(100, east(0)));
    unwatched.add(snapshot(115, east(20_000, 5)));
    expect(last.x).toBeCloseTo(only(unwatched, last.clock).x, 3);
  });
});

describe("Tracker corrections, large ones", () => {
  it("spreads a large correction over longer, so the catch-up stays a glide", () => {
    // Dead reckoning carries it to 700 m; the late report says it all but stopped at 150 m.
    const east = (x: number, age = 0, speed = 100) => aircraft("a", x, 0, { groundSpeedKt: speed * MPS, trackDeg: 90, positionAge: age });
    const tracker = new Tracker();
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
    const usual = new Tracker();
    usual.add(snapshot(100, cruise));
    // 60 s past the fix (plus the 8 s delay) is long past the usual 15 s of dead reckoning and its fade.
    expect(usual.at(168)).toEqual([]);
    const onward = new Tracker({ deadReckonMax: Infinity });
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

describe("Tracker through a stale spell", () => {
  it("holds an aircraft standing on the ground for as long as the server serves its last answer, not 15 s", () => {
    const tracker = new Tracker();
    const parked = aircraft("p1", 100, 200, { onGround: true, altitudeFt: 0, groundSpeedKt: 0 });
    tracker.add(snapshot(1000, parked));
    // A minute on, with no newer answer (adsb.lol answering 429), it is still there, where it stood.
    expect(only(tracker, 1000 + 8 + 60)).toMatchObject({ id: "p1", x: 100, y: 200, fade: 1 });
    // Past the 90 s the server stops serving it, it goes.
    expect(tracker.at(1000 + 8 + 90 + FADE_OUT + 1)).toHaveLength(0);
  });

  it("still lets a moving aircraft go after 15 s of flying on, as its position is only a guess", () => {
    const tracker = new Tracker();
    tracker.add(snapshot(1000, aircraft("m1", 0, 0, { groundSpeedKt: 250, trackDeg: 90 })));
    expect(tracker.at(1000 + 8 + 15 + FADE_OUT + 1)).toHaveLength(0);
  });
});
