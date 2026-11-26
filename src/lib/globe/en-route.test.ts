import { describe, expect, it } from "vitest";
import { toLocal } from "../geo";
import { aircraftMatrix, type AircraftPose, CHASE, EN_ROUTE_OFFERED, enRoutePose, enRouteShot, EnRouteRig, is3D, MAX_PITCH } from "./en-route";

const cruise: AircraftPose = { latitude: 35, longitude: -100, altitudeM: 10_000, trackDeg: 90, pitchDeg: 0 };

/** Where the shot's eye is from the aircraft: metres east, north and up. */
function eyeFrom(pose: AircraftPose, shot = enRouteShot(pose, "chase", 40)) {
  const [east, north] = toLocal(pose, shot.eye.latitude, shot.eye.longitude);
  return { east, north, up: shot.eye.altitudeM - pose.altitudeM };
}

describe("enRouteShot: Chase", () => {
  it("looks at the aircraft itself, at its altitude", () => {
    const shot = enRouteShot(cruise, "chase", 40);
    expect(shot.center).toEqual({ latitude: 35, longitude: -100 });
    expect(shot.elevationM).toBe(10_000);
  });

  it("stands behind the aircraft along its track, facing the way it flies", () => {
    for (const trackDeg of [0, 90, 200, 315]) {
      const pose = { ...cruise, trackDeg };
      const shot = enRouteShot(pose, "chase", 40);
      const eye = eyeFrom(pose, shot);
      const t = (trackDeg * Math.PI) / 180;
      const along = eye.east * Math.sin(t) + eye.north * Math.cos(t);
      const across = eye.east * Math.cos(t) - eye.north * Math.sin(t);
      expect(along).toBeLessThan(0);
      expect(Math.abs(across)).toBeLessThan(0.5);
      expect(shot.bearingDeg).toBeCloseTo(trackDeg, 6);
    }
  });

  it("stands above the aircraft and is pitched down toward it, within the map's tilt", () => {
    const shot = enRouteShot(cruise, "chase", 40);
    const eye = eyeFrom(cruise, shot);
    expect(eye.up).toBeGreaterThan(0);
    expect(shot.pitchDeg).toBeLessThan(90);
    expect(shot.pitchDeg).toBeLessThanOrEqual(MAX_PITCH);
    // The eye is on the line the pitch says: down from it to the aircraft at 90 - pitch degrees.
    const down = (Math.atan2(eye.up, Math.hypot(eye.east, eye.north)) * 180) / Math.PI;
    expect(down).toBeCloseTo(90 - shot.pitchDeg, 1);
    expect(Math.hypot(eye.east, eye.north, eye.up)).toBeCloseTo(shot.distanceM, 0);
  });

  it("stands back further for a bigger aircraft, and never closer than the minimum", () => {
    expect(enRouteShot(cruise, "chase", 70).distanceM).toBeGreaterThan(enRouteShot(cruise, "chase", 40).distanceM);
    expect(enRouteShot(cruise, "chase", 8).distanceM).toBe(CHASE.minDistanceM);
  });

  it("is the same framing whether the aircraft climbs or not: the camera follows the track, not the nose", () => {
    const climbing = enRouteShot({ ...cruise, pitchDeg: 8 }, "chase", 40);
    const level = enRouteShot(cruise, "chase", 40);
    expect(climbing.pitchDeg).toBe(level.pitchDeg);
    expect(climbing.bearingDeg).toBe(level.bearingDeg);
  });
});

describe("the cameras offered", () => {
  it("are Map and Chase for now, Map first, and only Chase is 3D", () => {
    expect(EN_ROUTE_OFFERED).toEqual(["map", "chase"]);
    expect(is3D("map")).toBe(false);
    expect(is3D("chase")).toBe(true);
  });
});

describe("enRoutePose", () => {
  const fix = { latitude: 35, longitude: -100, altitudeFt: 10_000, onGround: false, groundSpeedKt: 300, headingDeg: 45, verticalRateFpm: 2000 };

  it("turns the feed's feet into metres above sea level", () => {
    expect(enRoutePose(fix, 0).altitudeM).toBeCloseTo(3048, 3);
  });

  it("keeps the aircraft above the terrain under it, and on it on the ground", () => {
    expect(enRoutePose({ ...fix, altitudeFt: 1000 }, 900).altitudeM).toBe(900);
    expect(enRoutePose({ ...fix, onGround: true }, 412).altitudeM).toBe(412);
  });

  it("pitches the nose with the climb or descent, from vertical rate over ground speed", () => {
    // 2000 fpm at 300 kt: about 3.8 degrees.
    expect(enRoutePose(fix, 0).pitchDeg).toBeCloseTo((Math.atan2(2000 * 0.00508, 300 * 0.514444) * 180) / Math.PI, 6);
    expect(enRoutePose({ ...fix, verticalRateFpm: -1500 }, 0).pitchDeg).toBeLessThan(0);
    expect(enRoutePose({ ...fix, verticalRateFpm: null }, 0).pitchDeg).toBe(0);
    expect(enRoutePose({ ...fix, onGround: true }, 0).pitchDeg).toBe(0);
    // A climb at almost no speed (a bad read) is held to a sane attitude.
    expect(enRoutePose({ ...fix, groundSpeedKt: 1, verticalRateFpm: 6000 }, 0).pitchDeg).toBeLessThanOrEqual(20);
  });

  it("flies along its heading", () => {
    expect(enRoutePose(fix, 0).trackDeg).toBe(45);
  });
});

describe("aircraftMatrix", () => {
  /** Applies a column-major 4x4 matrix to a point. */
  const apply = (m: readonly number[], [x, y, z]: [number, number, number]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);
  const origin = { x: 0.25, y: 0.4, z: 0.001 };
  const metre = 1e-7;

  it("puts the model's origin (its wheels) at the aircraft's place", () => {
    expect(apply(aircraftMatrix(origin, metre, cruise, 1), [0, 0, 0])).toEqual([0.25, 0.4, 0.001]);
  });

  it("points the nose (model -z) along the track: north is -y in Mercator, east +x", () => {
    const north = apply(aircraftMatrix(origin, metre, { ...cruise, trackDeg: 0 }, 1), [0, 0, -10]);
    expect(north[0] - origin.x).toBeCloseTo(0, 12);
    expect(north[1] - origin.y).toBeCloseTo(-10 * metre, 12);
    const east = apply(aircraftMatrix(origin, metre, { ...cruise, trackDeg: 90 }, 1), [0, 0, -10]);
    expect(east[0] - origin.x).toBeCloseTo(10 * metre, 12);
    expect(east[1] - origin.y).toBeCloseTo(0, 12);
  });

  it("keeps the model's top up, and its right wing (model +x) on the right of the track", () => {
    const m = aircraftMatrix(origin, metre, { ...cruise, trackDeg: 0 }, 1);
    expect(apply(m, [0, 10, 0])[2] - origin.z).toBeCloseTo(10 * metre, 12);
    // Flying north, the right wing is to the east.
    expect(apply(m, [10, 0, 0])[0] - origin.x).toBeCloseTo(10 * metre, 12);
  });

  it("raises the nose in a climb and scales the model to the aircraft's size", () => {
    const m = aircraftMatrix(origin, metre, { ...cruise, pitchDeg: 10 }, 2);
    const nose = apply(m, [0, 0, -10]);
    expect(nose[2] - origin.z).toBeCloseTo(20 * Math.sin((10 * Math.PI) / 180) * metre, 12);
    expect(nose[0] - origin.x).toBeCloseTo(20 * Math.cos((10 * Math.PI) / 180) * metre, 12);
  });
});

describe("EnRouteRig", () => {
  const shot = enRouteShot(cruise, "chase", 40);

  it("takes the shot as it is when it has nothing to ease from", () => {
    const rig = new EnRouteRig();
    const { center, elevationM, distanceM, bearingDeg, pitchDeg } = shot;
    expect(rig.step(shot, 0)).toEqual({ center, elevationM, distanceM, bearingDeg, pitchDeg });
  });

  it("never tilts the camera past the map's limit, wherever it eases from", () => {
    const rig = new EnRouteRig();
    rig.start({ ...shot, pitchDeg: 85 }, shot, 0);
    expect(rig.step(shot, 16).pitchDeg).toBeLessThanOrEqual(MAX_PITCH);
  });

  it("eases from where the camera was toward the shot, never overshooting, and arrives", () => {
    const rig = new EnRouteRig();
    const from = { ...shot, center: { latitude: 35.1, longitude: -100 }, elevationM: 0, distanceM: 400_000, bearingDeg: 0, pitchDeg: 30 };
    rig.start(from, shot, 0);
    let last = rig.step(shot, 16);
    const firstDistance = last.distanceM;
    expect(firstDistance).toBeLessThan(400_000);
    expect(firstDistance).toBeGreaterThan(shot.distanceM);
    for (let t = 32; t <= 10_000; t += 16) {
      const next = rig.step(shot, t);
      expect(next.distanceM).toBeLessThanOrEqual(last.distanceM);
      expect(next.distanceM).toBeGreaterThanOrEqual(shot.distanceM - 1e-6);
      expect(next.pitchDeg).toBeGreaterThanOrEqual(last.pitchDeg - 1e-9);
      last = next;
    }
    expect(last.distanceM).toBeCloseTo(shot.distanceM, 1);
    expect(last.bearingDeg).toBeCloseTo(shot.bearingDeg, 2);
    expect(last.pitchDeg).toBeCloseTo(shot.pitchDeg, 2);
    expect(last.center.latitude).toBeCloseTo(shot.center.latitude, 5);
    expect(last.elevationM).toBeCloseTo(shot.elevationM, 0);
  });

  it("keeps the aircraft in the shot as it moves: what is eased is the offset from it, not a place", () => {
    const rig = new EnRouteRig();
    rig.start(shot, shot, 0);
    const moved = enRouteShot({ ...cruise, longitude: -99.9 }, "chase", 40);
    expect(rig.step(moved, 16).center.longitude).toBeCloseTo(-99.9, 9);
  });

  it("turns the short way round through north", () => {
    const rig = new EnRouteRig();
    const north = enRouteShot({ ...cruise, trackDeg: 10 }, "chase", 40);
    rig.start({ ...north, bearingDeg: 350 }, north, 0);
    const b = rig.step(north, 100).bearingDeg;
    const fromStart = (((b - 350) % 360) + 360) % 360;
    expect(fromStart).toBeGreaterThan(0);
    expect(fromStart).toBeLessThan(20);
  });

  it("takes a long gap between frames (a hidden tab) as a short step, not a jump to the end", () => {
    const rig = new EnRouteRig();
    rig.start({ ...shot, distanceM: 100_000 }, shot, 0);
    expect(rig.step(shot, 60_000).distanceM).toBeGreaterThan(shot.distanceM * 1.5);
  });
});
