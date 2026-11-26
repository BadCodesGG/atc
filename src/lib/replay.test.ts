import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import { KNOTS } from "./geo";
import { History } from "./history";
import { Replay, ReplayClock, Replayer } from "./replay";
import { readSequence } from "./sequence";
import { CORRECTION_SNAP, FADE_IN, PLAYBACK_DELAY, STEP_FLOOR, STEP_SECONDS, type TrackedAircraft, Tracker } from "./tracker";
import type { Aircraft, TrafficSnapshot } from "./traffic";
import { TrafficView } from "./traffic-view";

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

const snapshot = (time: number, ...list: Aircraft[]): TrafficSnapshot => ({ airport: "atl", time, aircraft: list });

/** Eastbound at 10 m/s from x = 0 at t = 0, polled every 5 s from t = 0 to `until`, with uneven fix ages. */
function eastbound(until: number): TrafficSnapshot[] {
  const out: TrafficSnapshot[] = [];
  for (let t = 0; t <= until; t += 5) {
    const age = [0.2, 1.4, 0.6, 2.1][(t / 5) % 4];
    out.push(snapshot(t, aircraft("a", 10 * (t - age), 0, { positionAge: age, groundSpeedKt: 10 * MPS, trackDeg: 90 })));
  }
  return out;
}

function recorded(list: TrafficSnapshot[]): History {
  const history = new History();
  for (const s of list) history.add(s);
  return history;
}

describe("Replayer", () => {
  it("draws any moment in the history where the aircraft was, forward and back", () => {
    const replayer = new Replayer(recorded(eastbound(3600)));
    for (const picture of [1800, 1800.5, 2400, 600, 601.25, 3000, 100]) {
      const [a] = replayer.at(picture);
      expect(a.id).toBe("a");
      expect(a.x).toBeCloseTo(10 * picture, 3);
      expect(a.fade).toBe(1);
    }
  });

  it("plays smoothly forward frame by frame at 30 times speed", () => {
    const replayer = new Replayer(recorded(eastbound(600)));
    let previous = -Infinity;
    for (let picture = 50; picture < 560; picture += 30 / 60) {
      const [a] = replayer.at(picture);
      expect(a.x).toBeGreaterThan(previous);
      expect(a.x).toBeCloseTo(10 * picture, 3);
      previous = a.x;
    }
  });

  it("shows an aircraft only while it was in the feed", () => {
    const list = eastbound(600).map((s) => (s.time >= 200 && s.time <= 300 ? { ...s, aircraft: [...s.aircraft, aircraft("b", 0, 0)] } : s));
    const replayer = new Replayer(recorded(list));
    const ids = (picture: number) => replayer.at(picture).map((a) => a.id);
    expect(ids(150)).toEqual(["a"]);
    expect(ids(250)).toEqual(["a", "b"]);
    expect(ids(400)).toEqual(["a"]);
    // And the same going back.
    expect(ids(250)).toEqual(["a", "b"]);
  });

  it("agrees with what the live tracker drew at the same moment", () => {
    const list = eastbound(300);
    const live = new Tracker();
    const replayer = new Replayer(recorded(list));
    let next = 0;
    for (let clock = 20; clock < 300; clock += 0.25) {
      while (next < list.length && list[next].time <= clock) live.add(list[next++]);
      const drawn = live.at(clock)[0];
      expect(replayer.at(clock - PLAYBACK_DELAY)[0].x).toBeCloseTo(drawn.x, 3);
    }
  });
});

describe("ReplayClock", () => {
  it("is live until asked to replay, and then shows the live moment", () => {
    const clock = new ReplayClock();
    expect(clock.live).toBe(true);
    expect(clock.picture(500, 0)).toBe(500);
  });

  it("plays from the start of the history at the chosen speed", () => {
    const clock = new ReplayClock();
    clock.play(30, { start: 100, live: 1000 }, 10);
    expect(clock.live).toBe(false);
    expect(clock.rate).toBe(30);
    expect(clock.picture(1000, 10)).toBe(100);
    expect(clock.picture(1002, 12)).toBe(160);
  });

  it("changes speed from where it is without jumping", () => {
    const clock = new ReplayClock();
    clock.play(10, { start: 100, live: 1000 }, 0);
    expect(clock.picture(1000, 5)).toBe(150);
    clock.play(30, { start: 100, live: 1005 }, 5);
    expect(clock.picture(1006, 6)).toBe(180);
  });

  it("goes back to live once it catches up with it", () => {
    const clock = new ReplayClock();
    clock.play(30, { start: 900, live: 1000 }, 0);
    expect(clock.picture(1003, 3)).toBe(990);
    expect(clock.picture(1004, 4)).toBe(1004);
    expect(clock.live).toBe(true);
    expect(clock.rate).toBe(1);
  });

  it("seeks to a moment and plays on from it at the speed it had, real time from live", () => {
    const clock = new ReplayClock();
    clock.seek(400, { start: 100, live: 1000 }, 0);
    expect(clock.live).toBe(false);
    expect(clock.rate).toBe(1);
    expect(clock.picture(1002, 2)).toBe(402);
    clock.play(10, { start: 100, live: 1002 }, 2);
    clock.seek(300, { start: 100, live: 1003 }, 3);
    expect(clock.picture(1004, 4)).toBe(310);
  });

  it("keeps a seek inside the history, and a seek to its end is live", () => {
    const clock = new ReplayClock();
    clock.seek(50, { start: 100, live: 1000 }, 0);
    expect(clock.picture(1000, 0)).toBe(100);
    clock.seek(999.5, { start: 100, live: 1000 }, 0);
    expect(clock.live).toBe(true);
  });

  it("goes back to live when asked", () => {
    const clock = new ReplayClock();
    clock.play(10, { start: 100, live: 1000 }, 0);
    clock.goLive();
    expect(clock.live).toBe(true);
    expect(clock.picture(1010, 10)).toBe(1010);
  });
});

describe("Replay", () => {
  function opened(until: number) {
    const live = new Tracker();
    const replay = new Replay(live, { elevationFt: 0 });
    for (const s of eastbound(until)) {
      live.add(s);
      replay.add(s);
    }
    return { live, replay };
  }

  it("draws live, the playback delay behind the clock, until asked to replay", () => {
    const { replay } = opened(600);
    const frame = replay.frame(600, 0);
    expect(frame.picture).toBe(600 - PLAYBACK_DELAY);
    expect(frame.aircraft[0].x).toBeCloseTo(10 * frame.picture, 3);
    expect(replay.status(600)).toMatchObject({ live: true, rate: 1, picture: 600 - PLAYBACK_DELAY, end: 600 - PLAYBACK_DELAY });
  });

  it("replays since the page opened, starting once the first aircraft are in", () => {
    const { replay } = opened(600);
    replay.play(30, 600, 0);
    const first = replay.frame(600, 0);
    expect(first.picture).toBe(FADE_IN);
    expect(replay.status(600).start).toBe(FADE_IN);
    const later = replay.frame(600, 4);
    expect(later.picture).toBe(FADE_IN + 120);
    expect(later.aircraft[0].x).toBeCloseTo(10 * later.picture, 3);
  });

  it("returns to the live playback delay after LIVE", () => {
    const { replay } = opened(600);
    replay.seek(300, 600, 0);
    expect(replay.frame(600, 1).picture).toBe(301);
    replay.goLive();
    expect(replay.frame(600, 2).picture).toBe(600 - PLAYBACK_DELAY);
  });

  it("says whether the picture is live, which the board and the predicted paths keep to", () => {
    const { replay } = opened(600);
    expect(replay.isLive).toBe(true);
    replay.play(10, 600, 0);
    expect(replay.isLive).toBe(false);
    replay.goLive();
    expect(replay.isLive).toBe(true);
  });

  it("draws light trails only in a time-lapse", () => {
    const { replay } = opened(600);
    expect(replay.trails(400, [])).toBeNull();
    replay.play(10, 600, 0);
    expect(replay.trails(400, [])).toBeNull();
    replay.play(30, 600, 0);
    expect(replay.trails(400, [])?.added.length).toBeGreaterThan(1);
  });

  describe("catching up with live", () => {
    /** Each aircraft's step from one frame to the next over `frames`, against the Tracker's bound for a frame (STEP_SECONDS of its speed, never under STEP_FLOOR). */
    function overSteps(frames: TrackedAircraft[][]): string[] {
      const out: string[] = [];
      for (let i = 1; i < frames.length; i++) {
        const before = new Map(frames[i - 1].map((a) => [a.id, a]));
        for (const a of frames[i]) {
          const b = before.get(a.id);
          if (!b) continue;
          const step = Math.hypot(a.x - b.x, a.y - b.y);
          const bound = Math.max((a.groundSpeedKt ?? 0) * KNOTS * STEP_SECONDS, STEP_FLOOR);
          if (step > bound + 1e-6 && step <= CORRECTION_SNAP) out.push(`${a.id} stepped ${step.toFixed(1)} m (bound ${bound.toFixed(1)} m) in frame ${i}`);
        }
      }
      return out;
    }

    /** Eastbound at 10 m/s in the history; the live picture has it `ahead` metres further on. */
    function disagreeing(ahead: number) {
      const history = recorded(eastbound(600));
      const live = { at: (clock: number): TrackedAircraft[] => [{ id: "a", x: 10 * (clock - PLAYBACK_DELAY) + ahead, y: 0, latitude: 0, longitude: (10 * (clock - PLAYBACK_DELAY) + ahead) / 111_320, altitudeFt: 3000, headingDeg: 90, headingKnown: true, groundSpeedKt: 10 * MPS, onGround: false, verticalRateFpm: null, callsign: null, typeCode: null, military: false, category: null, fade: 1 }] };
      return new Replay(live, { elevationFt: 0, history });
    }

    /** Plays at 10x from the start of the history until well past the moment it catches up with live, at 60 frames a second; the live clock runs on in real time. */
    function playToLive(replay: Replay): { frames: TrackedAircraft[][]; caughtUp: number } {
      replay.play(10, 300, 0);
      const frames: TrackedAircraft[][] = [];
      let caughtUp = -1;
      for (let i = 0; i < 60 * 40; i++) {
        const wall = i / 60;
        const { aircraft } = replay.frame(300 + wall, wall);
        if (caughtUp < 0 && replay.isLive) caughtUp = i;
        frames.push(aircraft);
      }
      return { frames, caughtUp };
    }

    it("eases each aircraft from where the replay drew it to where live has it, never stepping more in a frame than the Tracker allows", () => {
      const { frames, caughtUp } = playToLive(disagreeing(46));
      expect(caughtUp).toBeGreaterThan(0);
      expect(overSteps(frames)).toEqual([]);
      // It does get there: a few frames on it is drawn where live has it.
      const end = frames.at(-1)![0];
      expect(end.x).toBeCloseTo(10 * (300 + (frames.length - 1) / 60 - PLAYBACK_DELAY) + 46, 6);
      // The latitude and longitude move with it.
      const seam = frames[caughtUp][0];
      expect(seam.longitude! * 111_320).toBeCloseTo(seam.x, 0);
    });

    it("holds an aircraft live has behind where the replay drew it, rather than moving it back along its track, until live catches up", () => {
      const { frames, caughtUp } = playToLive(disagreeing(-46));
      expect(overSteps(frames)).toEqual([]);
      for (let i = caughtUp; i < frames.length; i++) expect(frames[i][0].x, `frame ${i}`).toBeGreaterThanOrEqual(frames[i - 1][0].x - 1e-6);
      const end = frames.at(-1)![0];
      expect(end.x).toBeCloseTo(10 * (300 + (frames.length - 1) / 60 - PLAYBACK_DELAY) - 46, 6);
    });

    it("does not ease a LIVE press or a seek: the picture jumped", () => {
      const replay = disagreeing(46);
      replay.seek(200, 300, 0);
      replay.frame(300, 0);
      replay.goLive();
      const live = replay.frame(300.02, 0.02).aircraft[0];
      expect(live.x).toBeCloseTo(10 * (300.02 - PLAYBACK_DELAY) + 46, 6);
    });

    it("keeps every aircraft of the recorded ATL sequence within the Tracker's step as a 10x replay catches up with live", async () => {
      const bytes = readFileSync(path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz"));
      const snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
      const live = new Tracker();
      const replay = new Replay(live, { elevationFt: 0 });
      const first = snapshots[0].time;
      let fed = 0;
      const feed = (clock: number) => {
        for (; fed < snapshots.length && snapshots[fed].time <= clock; fed++) {
          live.add(snapshots[fed]);
          replay.add(snapshots[fed]);
        }
      };
      // Live for two minutes, then a 10x replay from the start, played on until well past live.
      const opened = first + 120;
      feed(opened);
      replay.play(10, opened, 0);
      const frames: TrackedAircraft[][] = [];
      let caughtUp = -1;
      for (let i = 0; i < 60 * 30; i++) {
        const wall = i / 60;
        feed(opened + wall);
        const { aircraft } = replay.frame(opened + wall, wall);
        if (caughtUp < 0 && replay.isLive) caughtUp = i;
        frames.push(aircraft);
      }
      expect(caughtUp).toBeGreaterThan(0);
      expect(frames[caughtUp].length).toBeGreaterThan(10);
      // From the last frame of the replay on: the seam, and live after it.
      expect(overSteps(frames.slice(caughtUp - 1))).toEqual([]);
    });
  });

  describe("its own view of the traffic", () => {
    // One runway, 09 at the west end. Aircraft "a" lands on it at 55 and rolls out; at 400 it takes off again.
    const map: AirportMap = {
      code: "atl",
      source: "OpenStreetMap contributors (ODbL)",
      generated: "2026-09-30",
      origin: { latitude: 0, longitude: 0 },
      boundary: [],
      runways: [{ ref: "09/27", width: 45, surface: null, centerline: [], ends: [{ ref: "09", x: 0, y: 0 }, { ref: "27", x: 3000, y: 0 }] }],
      taxiways: [],
      aprons: [],
      terminals: [],
      buildings: [],
      gates: [],
      stands: [],
      holdingPositions: [],
      towers: [],
      windsocks: [],
      navaids: [],
    };
    const rolling = (x: number, mps: number) => aircraft("a", x, 0, { callsign: "DAL1", onGround: true, altitudeFt: 0, groundSpeedKt: mps * MPS, trackDeg: 90 });
    function landedThenLeft() {
      const list: TrafficSnapshot[] = [];
      // Touchdown 400 m in at 72 m/s, slowing at 2 m/s/s.
      for (let s = 0; s <= 45; s += 5) list.push(snapshot(55 + s, rolling(400 + 72 * s - s * s, 72 - 2 * s)));
      // Takeoff roll from the threshold, gaining 2 m/s/s from 10 m/s.
      for (let s = 0; s <= 40; s += 5) list.push(snapshot(400 + s, rolling(10 * s + s * s, 10 + 2 * s)));
      const live = new Tracker();
      const replay = new Replay(live, { elevationFt: 0 });
      for (const s of list) {
        live.add(s);
        replay.add(s);
      }
      return { live, replay, views: { live: new TrafficView(map, DEFAULT_AIRPORT), replay: new TrafficView(map, DEFAULT_AIRPORT) } };
    }
    /** Draws a frame as the page does, and reads the selected flight's card. */
    const card = (replay: Replay, views: { live: TrafficView; replay: TrafficView }, wall: number) => {
      const { aircraft } = replay.frame(520, wall);
      return replay.views(views.live, views.replay).frame(aircraft).entries.find((e) => e.aircraft.id === "a")?.card;
    };

    it("reads the landing as a landing after watching the later takeoff and seeking back across it", () => {
      const { replay, views } = landedThenLeft();
      replay.seek(425, 520, 0);
      for (let i = 0; i < 30; i++) expect(card(replay, views, i / 60)?.state).toBe("departing");
      expect(card(replay, views, 0.5)?.headline).toBe("Takeoff roll, runway 9");
      replay.seek(80, 520, 1);
      expect(card(replay, views, 1)).toMatchObject({ state: "arriving", headline: "Landing rollout, runway 9" });
    });
  });
});

describe("Replay of the recorded ATL sequence", () => {
  it("keeps every aircraft the feed kept listing on screen through a 30x time-lapse, gaps in the recording included", async () => {
    const bytes = readFileSync(path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz"));
    const snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
    const history = new History();
    for (const s of snapshots) history.add(s);
    const replayer = new Replayer(history);
    const first = snapshots[0].time;
    const last = snapshots.at(-1)!.time;
    const listed = (s: TrafficSnapshot | undefined, id: string) => s?.aircraft.some((a) => a.id === id) ?? false;
    let frames = 0;
    for (let picture = first + FADE_IN; picture < last; picture += 30 / 60) {
      // Listed in the two snapshots before this moment and the one after: it was there all along, and had faded in.
      const next = snapshots.findIndex((s) => s.time >= picture);
      const shown = new Map(replayer.at(picture).map((a) => [a.id, a]));
      for (const a of snapshots[next - 1].aircraft) {
        if (!listed(snapshots[next], a.id) || !listed(snapshots[next - 2], a.id)) continue;
        expect(shown.get(a.id)?.fade, `${a.id} at ${Math.round(picture - first)} s`).toBe(1);
      }
      frames++;
    }
    expect(frames).toBeGreaterThan(800);
  });
});
