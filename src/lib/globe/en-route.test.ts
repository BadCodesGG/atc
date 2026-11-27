import { describe, expect, it } from "vitest";
import { FEET, KNOTS, toGeo, toLocal } from "../geo";
import { MAX_PITCH, orbitToMap } from "./camera";
import { aircraftMatrix, type AircraftPose, bandPadding, blendPadding, CHASE, COCKPIT, EASE_S, EN_ROUTE_MAX_PITCH, EN_ROUTE_OFFERED, type EnRouteCamera, enRouteKey, type EnRoutePlacement, EnRoutePeek, enRouteShortcut, enRoutePose, type EnRouteShot, enRouteShot, EnRouteRig, eyeOf, fitDistance, is3D, mapCamera, mapEye, mapMetres, mapNearPlane, NO_PEEK, PEEK_DEG_PER_PX, peekPlacement, SIDE, SIGHT_MIN_M, sightPlacement, TOP } from "./en-route";

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

/** Metres of `eye` along and across the track from the aircraft (across: positive to the right). */
function alongAcross(pose: AircraftPose, eye: { east: number; north: number }) {
  const t = (pose.trackDeg * Math.PI) / 180;
  return { along: eye.east * Math.sin(t) + eye.north * Math.cos(t), across: eye.east * Math.cos(t) - eye.north * Math.sin(t) };
}

describe("enRouteShot: Cockpit", () => {
  it("has its eye just ahead of the nose, a little up, on the track, so the model is behind it", () => {
    for (const trackDeg of [0, 90, 200, 315]) {
      const pose = { ...cruise, trackDeg };
      const shot = enRouteShot(pose, "cockpit", 40);
      const eye = eyeFrom(pose, shot);
      const { along, across } = alongAcross(pose, eye);
      expect(along).toBeCloseTo(COCKPIT.aheadLengths * 40, 3);
      expect(along).toBeGreaterThan(20);
      expect(Math.abs(across)).toBeLessThan(0.01);
      expect(eye.up).toBeCloseTo(COCKPIT.upLengths * 40, 3);
      expect(shot.bearingDeg).toBeCloseTo(trackDeg, 6);
    }
  });

  it("looks forward along the track: the point it looks at is ahead of the eye, and below it in a descent", () => {
    const shot = enRouteShot({ ...cruise, pitchDeg: -3 }, "cockpit", 40);
    const [east, north] = toLocal(shot.eye, shot.center.latitude, shot.center.longitude);
    expect(east).toBeGreaterThan(0);
    expect(Math.abs(north)).toBeLessThan(0.01);
    expect(shot.elevationM).toBeLessThan(shot.eye.altitudeM);
  });

  it("is pitched with the attitude: level flight looks at the horizon, a climb above it, a descent below it", () => {
    expect(enRouteShot(cruise, "cockpit", 40).pitchDeg).toBe(90);
    expect(enRouteShot({ ...cruise, pitchDeg: 5 }, "cockpit", 40).pitchDeg).toBeCloseTo(95, 9);
    expect(enRouteShot({ ...cruise, pitchDeg: -15 }, "cockpit", 40).pitchDeg).toBeCloseTo(75, 9);
    // The steepest attitude drawn (enRoutePose holds it to 20 degrees) is within the En-route limit, so it is never cut short.
    expect(enRouteShot({ ...cruise, pitchDeg: 20 }, "cockpit", 40).pitchDeg).toBeCloseTo(110, 9);
    expect(enRouteShot({ ...cruise, pitchDeg: 20 }, "cockpit", 40).pitchDeg).toBeLessThanOrEqual(EN_ROUTE_MAX_PITCH);
  });

  it("looking level, the point it looks at is at the eye's own height", () => {
    const shot = enRouteShot(cruise, "cockpit", 40);
    expect(shot.elevationM).toBeCloseTo(shot.eye.altitudeM, 6);
  });
});

describe("enRouteShot: Side", () => {
  it("stands abeam on the left of the track and looks across at the aircraft", () => {
    for (const trackDeg of [0, 90, 200, 315]) {
      const pose = { ...cruise, trackDeg };
      const shot = enRouteShot(pose, "side", 40);
      expect(shot.center).toEqual({ latitude: 35, longitude: -100 });
      expect(shot.elevationM).toBe(10_000);
      const { along, across } = alongAcross(pose, eyeFrom(pose, shot));
      expect(across).toBeLessThan(-100);
      expect(Math.abs(along)).toBeLessThan(0.5);
      expect(shot.bearingDeg).toBeCloseTo((trackDeg + 90) % 360, 6);
    }
  });

  it("stands at wing height, looking level at the aircraft", () => {
    const shot = enRouteShot(cruise, "side", 40);
    expect(shot.pitchDeg).toBe(90);
    const eye = eyeFrom(cruise, shot);
    expect(Math.abs(eye.up)).toBeLessThan(1e-6);
    expect(Math.hypot(eye.east, eye.north)).toBeCloseTo(shot.distanceM, 0);
    expect(shot.distanceM).toBe(Math.max(SIDE.minDistanceM, SIDE.lengths * 40));
  });
});

describe("enRouteShot: Top", () => {
  it("looks straight down at the aircraft from above it, track up", () => {
    for (const trackDeg of [0, 90, 200]) {
      const pose = { ...cruise, trackDeg };
      const shot = enRouteShot(pose, "top", 40);
      expect(shot.pitchDeg).toBe(0);
      expect(shot.bearingDeg).toBeCloseTo(trackDeg, 6);
      expect(shot.center).toEqual({ latitude: 35, longitude: -100 });
      const eye = eyeFrom(pose, shot);
      expect(Math.hypot(eye.east, eye.north)).toBeLessThan(0.01);
      expect(eye.up).toBeCloseTo(Math.max(TOP.minDistanceM, TOP.lengths * 40), 3);
    }
  });
});

describe("enRouteShot: a drag's peek", () => {
  it("orbits Chase, Side and Top round the aircraft: it stays where they look, at the same distance", () => {
    for (const camera of ["chase", "side", "top"] as const) {
      const framed = enRouteShot(cruise, camera, 40);
      const peeked = enRouteShot(cruise, camera, 40, { bearingDeg: 40, pitchDeg: 10 });
      expect(peeked.center).toEqual(framed.center);
      expect(peeked.distanceM).toBe(framed.distanceM);
      expect(peeked.bearingDeg).toBeCloseTo((framed.bearingDeg + 40) % 360, 6);
      expect(peeked.pitchDeg).toBeCloseTo(Math.min(EN_ROUTE_MAX_PITCH, framed.pitchDeg + 10), 6);
      const eye = eyeFrom(cruise, peeked);
      expect(Math.hypot(eye.east, eye.north, eye.up)).toBeCloseTo(framed.distanceM, 0);
    }
  });

  it("turns Cockpit's look round its eye, which stays at the nose", () => {
    const framed = enRouteShot(cruise, "cockpit", 40);
    const peeked = enRouteShot(cruise, "cockpit", 40, { bearingDeg: -60, pitchDeg: -20 });
    // Within a centimetre: the local metres round a point are not quite a plane.
    expect(Math.hypot(...toLocal(framed.eye, peeked.eye.latitude, peeked.eye.longitude))).toBeLessThan(0.01);
    expect(peeked.eye.altitudeM).toBeCloseTo(framed.eye.altitudeM, 6);
    expect(peeked.bearingDeg).toBeCloseTo(30, 6);
    expect(peeked.pitchDeg).toBeCloseTo(70, 6);
  });

  it("tilts up past level to the En-route limit, never past it nor past straight down", () => {
    expect(enRouteShot(cruise, "side", 40, { bearingDeg: 0, pitchDeg: 10 }).pitchDeg).toBeCloseTo(100, 9);
    expect(enRouteShot(cruise, "side", 40, { bearingDeg: 0, pitchDeg: 30 }).pitchDeg).toBe(EN_ROUTE_MAX_PITCH);
    expect(enRouteShot(cruise, "top", 40, { bearingDeg: 0, pitchDeg: -30 }).pitchDeg).toBe(0);
  });

  it("with no peek is the framing", () => {
    expect(enRouteShot(cruise, "side", 40, NO_PEEK)).toEqual(enRouteShot(cruise, "side", 40));
  });
});

describe("the tilt limits", () => {
  it("are the map's 78 degrees on Map and in the Diorama, and past level for the En-route cameras, within MapLibre's 180", () => {
    expect(MAX_PITCH).toBe(78);
    expect(EN_ROUTE_MAX_PITCH).toBeGreaterThan(90);
    expect(EN_ROUTE_MAX_PITCH).toBeLessThanOrEqual(180);
  });
});

describe("sightPlacement: the map's centre moved along the camera's line of sight", () => {
  const fovDeg = 22;
  /** The eye and the look of a placement: what the picture is made from. */
  type Sight = { eye: { latitude: number; longitude: number; altitudeM: number }; bearingDeg: number; pitchDeg: number };
  const expectSameSight = (a: Sight, b: Sight) => {
    expect(Math.hypot(...toLocal(a.eye, b.eye.latitude, b.eye.longitude))).toBeLessThan(0.05);
    expect(b.eye.altitudeM).toBeCloseTo(a.eye.altitudeM, 3);
    expect(b.bearingDeg).toBeCloseTo(a.bearingDeg, 9);
    expect(b.pitchDeg).toBeCloseTo(a.pitchDeg, 9);
  };
  /**
   * MapLibre's world measures a metre by the latitude (one over its cosine, up and across alike), and the centre
   * goes out along the look in that world: a look across the parallels (Side's, here) takes the moved centre's
   * distance and height in the metres at the aircraft's latitude (`from`, the shot's centre), where its height is
   * given. Side's eye stands 200 m off it, across which that metre changes by 2e-5: centimetres in 10 km.
   */
  const atEye = (metres: number, moved: EnRouteShot, from = cruise.latitude) => (metres * Math.cos((from * Math.PI) / 180)) / Math.cos((moved.center.latitude * Math.PI) / 180);

  it("keeps the eye and the look, so the picture is the same", () => {
    for (const camera of ["chase", "cockpit", "side", "top"] as const) {
      const shot = enRouteShot(cruise, camera, 40);
      expectSameSight(shot, sightPlacement(shot, { groundM: 300, nearestM: 200, fovDeg }));
    }
  });

  it("puts Top's centre on the ground straight under the aircraft, so the map's zoom is the ground's", () => {
    const shot = enRouteShot(cruise, "top", 40);
    const moved = sightPlacement(shot, { groundM: 300, nearestM: shot.distanceM, fovDeg });
    expect(moved.elevationM).toBeCloseTo(300, 6);
    expect(moved.distanceM).toBeCloseTo(shot.distanceM + 10_000 - 300, 6);
    expect(Math.hypot(...toLocal(shot.center, moved.center.latitude, moved.center.longitude))).toBeLessThan(0.01);
  });

  it("goes no farther than keeps MapLibre's near plane at half the distance to the nearest thing drawn", () => {
    const high: AircraftPose = { ...cruise, altitudeM: 11_300 };
    for (const camera of ["chase", "side", "top"] as const) {
      const shot = enRouteShot(high, camera, 40);
      const moved = sightPlacement(shot, { groundM: 0, nearestM: shot.distanceM, fovDeg });
      expect(mapNearPlane(moved.distanceM, fovDeg), camera).toBeLessThanOrEqual(shot.distanceM / 2 + 1e-6);
      expectSameSight(shot, moved);
    }
  });

  it("moves a look at or above the horizon out along it too, never down to a ground it does not meet", () => {
    const side = enRouteShot(cruise, "side", 40);
    const moved = sightPlacement(side, { groundM: 0, nearestM: side.distanceM, fovDeg });
    expect(moved.distanceM).toBeGreaterThan(side.distanceM);
    expect(atEye(moved.elevationM, moved)).toBeCloseTo(side.elevationM, 2);
    const up = enRouteShot({ ...cruise, pitchDeg: 8 }, "cockpit", 40);
    expect(sightPlacement(up, { groundM: 0, nearestM: 10_000, fovDeg }).elevationM).toBeGreaterThan(up.eye.altitudeM);
  });

  it("takes a slanting or level look out only as far as the eye's height over the ground, not to where it meets the ground", () => {
    // Chase at cruise looks 15 degrees down: the ground is 37 km along the look, the eye 9.7 km over it.
    const chase = enRouteShot(cruise, "chase", 40);
    const moved = sightPlacement(chase, { groundM: 300, nearestM: 1_000, fovDeg });
    expect(moved.distanceM).toBeCloseTo(chase.eye.altitudeM - 300, 6);
    expectSameSight(chase, moved);
    // Side looks level, so never meets the ground: the same, not the near plane's farthest.
    const side = enRouteShot(cruise, "side", 40);
    const level = sightPlacement(side, { groundM: 300, nearestM: 1_000_000, fovDeg });
    expect(atEye(level.distanceM, level)).toBeCloseTo(side.eye.altitudeM - 300, 1);
  });

  it("takes the centre out at least SIGHT_MIN_M near the ground, so the terrain's skirts close the gaps between tiles", () => {
    const low: AircraftPose = { ...cruise, altitudeM: 800 };
    const side = enRouteShot(low, "side", 40);
    const out = sightPlacement(side, { groundM: 0, nearestM: 1_000, fovDeg });
    expect(atEye(out.distanceM, out)).toBeCloseTo(SIGHT_MIN_M, 1);
    // Unless the ground comes first: a look down meets it nearer.
    const top = enRouteShot(low, "top", 40);
    expect(sightPlacement(top, { groundM: 0, nearestM: 1_000, fovDeg }).elevationM).toBeCloseTo(0, 6);
  });

  it("never brings the centre nearer than the camera's own, nor moves it with the eye at or under the ground", () => {
    const shot = enRouteShot(cruise, "chase", 40);
    expect(sightPlacement(shot, { groundM: 0, nearestM: 1, fovDeg }).distanceM).toBe(shot.distanceM);
    expect(sightPlacement(shot, { groundM: 20_000, nearestM: 500, fovDeg })).toEqual(shot);
  });

  it("keeps MapLibre's own eye where it was, in its Mercator world, on any track and at any height", () => {
    for (const trackDeg of [0, 45, 90, 160, 225, 270, 330]) {
      for (const altitudeM of [3_000, 12_000, 15_500]) {
        for (const camera of ["chase", "cockpit", "side", "top"] as const) {
          const shot = enRouteShot({ ...cruise, trackDeg, altitudeM }, camera, 40);
          const moved = sightPlacement(shot, { groundM: 300, nearestM: 200, fovDeg });
          const [a, b] = [mapEye(shot), mapEye(moved)];
          // A millimetre of the world at this latitude is about 2e-10 of it.
          const mm = 1e-3 / (2 * Math.PI * 6_371_008.8 * Math.cos((cruise.latitude * Math.PI) / 180));
          expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), `${camera} ${trackDeg} ${altitudeM}`).toBeLessThan(mm);
        }
      }
    }
  });
});

/**
 * MapLibre's camera, built as the map builds it from what the controller hands jumpTo (MercatorTransform: the
 * centre and its elevation in the Web Mercator world, the camera back along the look by the camera-to-centre
 * distance over the world's size, an off-axis lens that draws the centre in the middle of the padded view), and
 * a point placed as MercatorCoordinate.fromLngLat places the aircraft's model: where on the screen it is drawn.
 * Written out apart from en-route.ts's mapEye and its helpers on purpose, from MapLibre's source, so a slip in
 * those is caught here rather than repeated.
 */
function mapPixel(cam: ReturnType<typeof mapCamera>, screen: { width: number; height: number; fovDeg: number }, padding: { top: number; bottom: number; left: number; right: number }, point: { latitude: number; longitude: number; altitudeM: number }) {
  const RADIUS = 6_371_008.8;
  const R2 = Math.PI / 180;
  const world = (lat: number, lng: number, alt: number) => ({ x: (180 + lng) / 360, y: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360, z: alt / (2 * Math.PI * RADIUS * Math.cos(lat * R2)) });
  const focal = screen.height / 2 / Math.tan((screen.fovDeg * R2) / 2);
  const d = focal / (512 * 2 ** cam.zoom);
  const [p, b] = [cam.pitch * R2, cam.bearing * R2];
  const look = { x: Math.sin(p) * Math.sin(b), y: -Math.sin(p) * Math.cos(b), z: -Math.cos(p) };
  const c = world(cam.center[1], cam.center[0], cam.elevation);
  const eye = { x: c.x - look.x * d, y: c.y - look.y * d, z: c.z - look.z * d };
  // The screen's right (east at bearing 0) and up, square to the look.
  const right = { x: Math.cos(b), y: Math.sin(b), z: 0 };
  const up = { x: right.y * look.z - right.z * look.y, y: right.z * look.x - right.x * look.z, z: right.x * look.y - right.y * look.x };
  const sign = up.z < 0 || (up.z === 0 && up.y > 0) ? -1 : 1;
  const q = world(point.latitude, point.longitude, point.altitudeM);
  const v = { x: q.x - eye.x, y: q.y - eye.y, z: q.z - eye.z };
  const dot = (a: typeof v, w: typeof v) => a.x * w.x + a.y * w.y + a.z * w.z;
  const ahead = dot(v, look);
  return {
    /** How far in front of the eye along its look, in world units: none or less is behind it. */
    ahead,
    x: (padding.left + screen.width - padding.right) / 2 + (focal * dot(v, right)) / ahead,
    y: (padding.top + screen.height - padding.bottom) / 2 - (focal * sign * dot(v, up)) / ahead,
  };
}

describe("the aircraft's place in the frame, from 1,000 to 51,000 ft (the controller's steer, drawn by MapLibre's maths)", () => {
  const fovDeg = 36.87;
  const lengthM = 37.6;
  const screens = [
    { name: "1440x900", width: 1440, height: 900, band: null },
    { name: "375x812", width: 375, height: 812, band: { left: 16, right: 359, top: 430, bottom: 613 } },
    { name: "320x700", width: 320, height: 700, band: { left: 16, right: 304, top: 354, bottom: 483 } },
  ];
  const own = { top: 0, bottom: 0, left: 420, right: 0 };

  /** What steer hands the map for a settled camera: the shot, fitted in the band, its centre out along the line of sight. */
  function placed(pose: AircraftPose, camera: "chase" | "side" | "top", groundM: number, screen: (typeof screens)[number]) {
    const lens = { height: screen.height, fovDeg };
    const ideal = enRouteShot(pose, camera, lengthM);
    const shot = screen.band ? { ...ideal, distanceM: fitDistance(ideal.distanceM, camera, lengthM, lens, screen.band) } : ideal;
    const [east, north] = toLocal(shot.eye, pose.latitude, pose.longitude);
    const nearestM = Math.min(Math.hypot(east, north, pose.altitudeM - shot.eye.altitudeM), shot.eye.altitudeM - groundM);
    const moved = sightPlacement(shot, { groundM, nearestM, fovDeg });
    return { cam: mapCamera(moved, lens), padding: screen.band ? bandPadding(screen, screen.band) : own };
  }

  for (const camera of ["chase", "side", "top"] as const) {
    it(`${camera}: the aircraft is drawn on the framing point at every height, track, latitude and ground, with and without the band's padding`, () => {
      for (const screen of screens) {
        for (const latitude of [0, 35, 62]) {
          for (const trackDeg of [0, 45, 90, 135, 200, 270, 315]) {
            for (const groundM of [0, 300, 1_500, 3_000]) {
              for (const feet of [1_000, 11_000, 25_000, 39_000, 40_000, 47_000, 51_000]) {
                const altitudeM = feet * FEET;
                if (altitudeM <= groundM + 50) continue;
                const pose: AircraftPose = { latitude, longitude: -100, altitudeM, trackDeg, pitchDeg: 0 };
                const { cam, padding } = placed(pose, camera, groundM, screen);
                const at = mapPixel(cam, { ...screen, fovDeg }, padding, pose);
                const want = { x: (padding.left + screen.width - padding.right) / 2, y: (padding.top + screen.height - padding.bottom) / 2 };
                const label = `${screen.name} lat ${latitude} track ${trackDeg} ground ${groundM} ${feet} ft`;
                expect(Math.abs(at.x - want.x), label).toBeLessThan(0.5);
                expect(Math.abs(at.y - want.y), label).toBeLessThan(0.5);
              }
            }
          }
        }
      }
    });
  }

  /** The shot steer frames `camera` on for `pose` on `screen`, fitted in its band. */
  function framing(pose: AircraftPose, camera: Exclude<EnRouteCamera, "map">, screen: (typeof screens)[number]) {
    const lens = { height: screen.height, fovDeg };
    const ideal = enRouteShot(pose, camera, lengthM);
    return screen.band ? { ...ideal, distanceM: fitDistance(ideal.distanceM, camera, lengthM, lens, screen.band) } : ideal;
  }

  /** Eases the rig from `from` to `shot` for 8 s of 60 Hz frames, placed as steer places it, and checks the aircraft is in front of the eye and on the screen in each. */
  function expectInFrameThroughout(from: EnRoutePlacement, shot: EnRouteShot, pose: AircraftPose, groundM: number, screen: (typeof screens)[number], label: string) {
    const lens = { height: screen.height, fovDeg };
    const padding = screen.band ? bandPadding(screen, screen.band) : own;
    const rig = new EnRouteRig();
    rig.start(from, shot, 0);
    for (let t = 16; t <= 8_000; t += 16) {
      const p = rig.step(shot, t);
      const eye = eyeOf(p);
      const [east, north] = toLocal(eye, pose.latitude, pose.longitude);
      const nearestM = Math.min(Math.hypot(east, north, pose.altitudeM - eye.altitudeM), eye.altitudeM - groundM);
      const cam = mapCamera(sightPlacement({ ...p, eye }, { groundM, nearestM, fovDeg }), lens);
      const at = mapPixel(cam, { ...screen, fovDeg }, padding, pose);
      const where = `${screen.name} ${label} at ${t} ms`;
      expect(at.ahead, where).toBeGreaterThan(0);
      expect(at.x, where).toBeGreaterThanOrEqual(0);
      expect(at.x, where).toBeLessThanOrEqual(screen.width);
      expect(at.y, where).toBeGreaterThanOrEqual(0);
      expect(at.y, where).toBeLessThanOrEqual(screen.height);
    }
  }

  for (const camera of ["chase", "side", "top"] as const) {
    it(`${camera}: eased in from the flat shot, the aircraft stays in front of the eye and inside the frame all the way`, () => {
      for (const screen of screens) {
        // Map's distance at zoom 8.5 (where it stood following a flight at cruise on hardware GL), from mapCamera's own zoom.
        const unit = { center: { latitude: 35, longitude: -100 }, elevationM: 0, distanceM: 1_000, bearingDeg: 0, pitchDeg: 40 };
        const flatM = 1_000 * 2 ** (mapCamera(unit, { height: screen.height, fovDeg }).zoom - 8.5);
        for (const groundM of [0, 300]) {
          for (const feet of [1_000, 11_000, 25_000, 39_000, 51_000]) {
            const pose: AircraftPose = { latitude: 35, longitude: -100, altitudeM: feet * FEET, trackDeg: 20, pitchDeg: 0 };
            // The flat map's centre: on the sea-level plane (no terrain on Map), a few kilometres off the flight's ground point.
            const [latitude, longitude] = toGeo(pose, 1_500, -3_000);
            const from = { center: { latitude, longitude }, elevationM: 0, distanceM: flatM, bearingDeg: 0, pitchDeg: 40 };
            expectInFrameThroughout(from, framing(pose, camera, screen), pose, groundM, screen, `ground ${groundM} ${feet} ft`);
          }
        }
      }
    });
  }

  it("keeps the aircraft in front of the eye and in the frame as one 3D camera eases into another", () => {
    const groundM = 300;
    for (const screen of screens) {
      for (const feet of [1_000, 11_000, 39_000, 51_000]) {
        const pose: AircraftPose = { latitude: 35, longitude: -100, altitudeM: feet * FEET, trackDeg: 20, pitchDeg: 0 };
        // Not from the Cockpit: its eye is in the aircraft's nose, so the aircraft starts round the eye, not in front of it.
        for (const from of ["chase", "side", "top"] as const) {
          for (const to of ["chase", "side", "top"] as const) {
            if (from !== to) expectInFrameThroughout(framing(pose, from, screen), framing(pose, to, screen), pose, groundM, screen, `${from} to ${to} ${feet} ft`);
          }
        }
      }
    }
  });

  it("takes the zoom in MapLibre's own metres, so the model's size and the camera's distance agree", () => {
    const lens = { height: 900, fovDeg };
    const cam = mapCamera({ center: { latitude: 35, longitude: -100 }, elevationM: 0, distanceM: 1_000, bearingDeg: 0, pitchDeg: 0 }, lens);
    const pxPerMetre = (512 * 2 ** cam.zoom) / (2 * Math.PI * 6_371_008.8 * Math.cos((35 * Math.PI) / 180));
    expect(pxPerMetre * 1_000).toBeCloseTo(lens.height / 2 / Math.tan((fovDeg * Math.PI) / 360), 6);
  });

  it("keeps the flat shot's zoom across the change of metres (mapMetres), so the share never steps the camera", () => {
    const lens = { height: 900, fovDeg };
    for (const latitude of [0, 35, 62]) {
      const orbit = orbitToMap({ azimuthDeg: 30, elevationDeg: 40, target: [0, 0], height: 0, distance: 25_000 }, { latitude, longitude: -100 }, lens);
      const cam = mapCamera({ center: { latitude, longitude: -100 }, elevationM: 0, distanceM: mapMetres(25_000), bearingDeg: 30, pitchDeg: 50 }, lens);
      expect(cam.zoom).toBeCloseTo(orbit.zoom, 9);
    }
  });
});

describe("peekPlacement", () => {
  it("leaves a placement as it is with no peek", () => {
    const p = enRouteShot(cruise, "chase", 40);
    expect(peekPlacement(p, "chase", NO_PEEK)).toBe(p);
  });
});

describe("EnRoutePeek", () => {
  it("holds a drag as dragged: right turns the bearing back, up tilts toward the horizon", () => {
    const peek = new EnRoutePeek();
    peek.drag(100, -20);
    expect(peek.dragging).toBe(true);
    expect(peek.at(0)).toEqual({ bearingDeg: -100 * PEEK_DEG_PER_PX, pitchDeg: 20 * PEEK_DEG_PER_PX });
    // Held, it does not ease back, however long.
    expect(peek.at(5_000)).toEqual({ bearingDeg: -100 * PEEK_DEG_PER_PX, pitchDeg: 20 * PEEK_DEG_PER_PX });
  });

  it("eases back to the framing once let go: never past it, always nearer, and arrives", () => {
    const peek = new EnRoutePeek();
    peek.drag(-200, 50);
    peek.release(1_000);
    expect(peek.dragging).toBe(false);
    let last = peek.at(1_000);
    expect(last.bearingDeg).toBeCloseTo(60, 9);
    for (let t = 1_016; t <= 8_000; t += 16) {
      const next = peek.at(t);
      expect(next.bearingDeg).toBeGreaterThanOrEqual(0);
      expect(next.bearingDeg).toBeLessThanOrEqual(last.bearingDeg);
      expect(next.pitchDeg).toBeLessThanOrEqual(0);
      expect(next.pitchDeg).toBeGreaterThanOrEqual(last.pitchDeg);
      last = next;
    }
    expect(last).toEqual(NO_PEEK);
  });

  it("is halfway back in about half a second, as the rig eases", () => {
    const peek = new EnRoutePeek();
    peek.drag(-100, 0);
    peek.release(0);
    for (let t = 16; t <= 480; t += 16) peek.at(t);
    expect(peek.at(EASE_S * Math.LN2 * 1000).bearingDeg).toBeCloseTo(15, 0);
  });

  it("goes at once on reset (a camera switch)", () => {
    const peek = new EnRoutePeek();
    peek.drag(300, 300);
    peek.reset();
    expect(peek.dragging).toBe(false);
    expect(peek.at(0)).toEqual(NO_PEEK);
  });

  it("is held to half a turn either way however far the drag", () => {
    const peek = new EnRoutePeek();
    peek.drag(-100_000, 100_000);
    expect(peek.at(0)).toEqual({ bearingDeg: 180, pitchDeg: -90 });
  });
});

describe("framing in the free band below the Journey card (phones and tablets)", () => {
  // 375x812: the card ends at 418, the foot's first control starts at 625; freeBand leaves 12 px of air each side.
  const phone = { width: 375, height: 812 };
  const band = { left: 16, right: 359, top: 430, bottom: 613 };
  const lens = { height: 812, fovDeg: 26 };
  /** How many CSS pixels a metre `distanceM` from the eye spans through `lens`. */
  const pxPerMetre = (distanceM: number, l = lens) => l.height / (2 * distanceM * Math.tan((l.fovDeg * Math.PI) / 360));

  it("pads the map so its centre, which every 3D camera looks at, is the middle of the band", () => {
    const p = bandPadding(phone, band);
    expect((p.top + phone.height - p.bottom) / 2).toBe((band.top + band.bottom) / 2);
    expect((p.left + phone.width - p.right) / 2).toBe((band.left + band.right) / 2);
    expect(Math.min(p.top, p.bottom, p.left, p.right)).toBeGreaterThanOrEqual(0);
  });

  it("eases from the map's own padding into the band's by the share of the 3D camera, so the flat shot never steps", () => {
    const flat = { top: 64, bottom: 0, left: 0, right: 0 };
    const padded = bandPadding(phone, band);
    expect(blendPadding(flat, padded, 0)).toEqual(flat);
    expect(blendPadding(flat, padded, 1)).toEqual(padded);
    expect(blendPadding(flat, padded, 0.5).top).toBeCloseTo((64 + padded.top) / 2, 9);
  });

  it("stands Chase, Side and Top back until the whole aircraft fits the band, never nearer than their own shot", () => {
    const narrow = { left: 16, right: 304, top: 354, bottom: 483 };
    const small = { height: 700, fovDeg: 26 };
    for (const camera of ["chase", "side", "top"] as const) {
      const shot = enRouteShot(cruise, camera, 37.6);
      const d = fitDistance(shot.distanceM, camera, 37.6, small, narrow);
      expect(d, camera).toBeGreaterThanOrEqual(shot.distanceM);
      // The span across, at most most of the band's width; and the aircraft's height on screen, most of its depth.
      expect(1.05 * 37.6 * pxPerMetre(d, small), camera).toBeLessThanOrEqual(0.8 * (narrow.right - narrow.left) + 1e-9);
    }
    // Top shows the aircraft's whole length up the screen: it fits the band's depth too.
    const top = fitDistance(enRouteShot(cruise, "top", 37.6).distanceM, "top", 37.6, small, narrow);
    expect(1.05 * 37.6 * pxPerMetre(top, small)).toBeLessThanOrEqual(0.8 * (narrow.bottom - narrow.top) + 1e-9);
  });

  it("leaves a shot that already fits as it is, and Cockpit (no model drawn) always", () => {
    const roomy = { left: 0, right: 1440, top: 0, bottom: 900 };
    for (const camera of ["chase", "side", "top"] as const) {
      const shot = enRouteShot(cruise, camera, 37.6);
      expect(fitDistance(shot.distanceM, camera, 37.6, { height: 900, fovDeg: 26 }, roomy), camera).toBe(shot.distanceM);
    }
    expect(fitDistance(300, "cockpit", 37.6, lens, { left: 0, right: 10, top: 0, bottom: 10 })).toBe(300);
  });
});

describe("the cameras offered", () => {
  it("are all five, Map first, and only Map is flat", () => {
    expect(EN_ROUTE_OFFERED).toEqual(["map", "chase", "cockpit", "side", "top"]);
    expect(is3D("map")).toBe(false);
    for (const camera of ["chase", "cockpit", "side", "top"] as const) expect(is3D(camera)).toBe(true);
  });
});

describe("enRouteKey", () => {
  const press = (key: string, mods: Partial<Record<"ctrlKey" | "altKey" | "metaKey", boolean>> = {}, code = "") => enRouteKey({ key, code, ctrlKey: false, altKey: false, metaKey: false, ...mods });

  it("picks the cameras with 1 to 5, in the card's order, each button showing its key", () => {
    expect(["1", "2", "3", "4", "5"].map((k) => press(k))).toEqual(["map", "chase", "cockpit", "side", "top"]);
    expect(EN_ROUTE_OFFERED.map(enRouteShortcut)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("reads the number row by its place on a layout that types something else there, and the number pad", () => {
    // AZERTY: the 3 key types a double quote unshifted.
    expect(press('"', {}, "Digit3")).toBe("cockpit");
    expect(press("4", {}, "Numpad4")).toBe("side");
    expect(press("&", { ctrlKey: true }, "Digit1")).toBeNull();
    expect(press("q", {}, "KeyA")).toBeNull();
  });

  it("leaves every other key, and the browser's own chords, alone", () => {
    for (const key of ["0", "6", "9", "q", "e", "/", "Escape", "ArrowUp", "+"]) expect(press(key)).toBeNull();
    expect(press("2", { ctrlKey: true })).toBeNull();
    expect(press("2", { altKey: true })).toBeNull();
    expect(press("2", { metaKey: true })).toBeNull();
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
    expect(enRoutePose(fix, 0).pitchDeg).toBeCloseTo((Math.atan2((2000 * FEET) / 60, 300 * KNOTS) * 180) / Math.PI, 6);
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

  it("never tilts the camera past the En-route limit, wherever it eases from", () => {
    const rig = new EnRouteRig();
    rig.start({ ...shot, pitchDeg: 150 }, shot, 0);
    expect(rig.step(shot, 16).pitchDeg).toBeLessThanOrEqual(EN_ROUTE_MAX_PITCH);
    // A level look eases in untouched.
    const side = enRouteShot(cruise, "side", 40);
    rig.start(shot, side, 0);
    expect(rig.step(side, 100_000).pitchDeg).toBeGreaterThan(MAX_PITCH);
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
