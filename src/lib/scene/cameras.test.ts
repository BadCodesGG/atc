import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import atl from "../../data/airports/atl.json";
import type { AirportMap } from "../airport-map";
import { placeCamera } from "./camera";
import {
  approachView,
  CAMERA_EASE_MS,
  cameraModes,
  CameraRig,
  drawnScale,
  droneView,
  fogRange,
  HORIZON_REACH,
  LOOK_EASE_MS,
  LOOK_MAX_PITCH,
  LOOK_ZOOM,
  lookDrag,
  lookFrom,
  lookKey,
  minPitch,
  type ModeLook,
  modeShot,
  modeView,
  NO_LOOK,
  nearPlane,
  type Subject,
  subjectOf,
  towerView,
} from "./cameras";
import { ORBIT_FOV, type OrbitView } from "./orbit";

const ASPECT = 1440 / 900;
const map = atl as unknown as AirportMap;

/** A camera placed as the scene places it for a view. */
function cameraFor(view: OrbitView, aspect = ASPECT): PerspectiveCamera {
  const camera = new PerspectiveCamera(view.fovDeg ?? ORBIT_FOV, aspect, 1, 100_000);
  placeCamera(camera, { azimuthDeg: view.azimuthDeg, elevationDeg: view.elevationDeg, fovDeg: view.fovDeg ?? ORBIT_FOV }, view.target, view.distance, view.height);
  return camera;
}

/** Map point of a view's eye (x east, y north, h up). */
function eyeOf(view: OrbitView): [number, number, number] {
  const p = cameraFor(view).position;
  return [p.x, -p.z, p.y];
}

/** How far over the ground (metres from the eye) the ray through a point of the frame lands; Infinity above the horizon. */
function groundReach(camera: PerspectiveCamera, ndcX: number, ndcY: number): number {
  const dir = new Vector3(ndcX, ndcY, 0.5).unproject(camera).sub(camera.position).normalize();
  if (dir.y >= 0) return Infinity;
  const t = -camera.position.y / dir.y;
  return Math.hypot(dir.x * t, dir.z * t);
}

/** The farthest any part of the frame's top edge reaches over the ground. */
function topReach(view: OrbitView, aspect = ASPECT): number {
  const camera = cameraFor(view, aspect);
  return Math.max(groundReach(camera, -1, 1), groundReach(camera, 0, 1), groundReach(camera, 1, 1));
}

describe("lookFrom", () => {
  it("turns an eye and a point looked at into a view placeCamera puts back at the eye", () => {
    const view = lookFrom([0, -1000, 100], [0, 0, 0], 50);
    expect(view.azimuthDeg).toBeCloseTo(0);
    expect(view.elevationDeg).toBeCloseTo(5.711, 2);
    expect(view.distance).toBeCloseTo(1004.99, 1);
    expect(view.fovDeg).toBe(50);
    const eye = eyeOf(view);
    expect(eye[0]).toBeCloseTo(0, 3);
    expect(eye[1]).toBeCloseTo(-1000, 3);
    expect(eye[2]).toBeCloseTo(100, 3);
  });
});

describe("minPitch", () => {
  it("tilts down far enough that the whole top edge of the frame lands on the ground within reach", () => {
    const pitch = minPitch(40, ASPECT, 100, HORIZON_REACH);
    expect(pitch).toBeGreaterThan(20);
    const view = lookFrom([0, 0, 100], [0, 100 / Math.tan((pitch * Math.PI) / 180), 0], 40);
    expect(topReach(view)).toBeLessThanOrEqual(HORIZON_REACH);
  });

  it("asks for more tilt from higher up, and from a wider frame", () => {
    expect(minPitch(40, ASPECT, 1500, HORIZON_REACH)).toBeGreaterThan(minPitch(40, ASPECT, 100, HORIZON_REACH));
    expect(minPitch(40, 2.4, 100, HORIZON_REACH)).toBeGreaterThan(minPitch(40, 0.46, 100, HORIZON_REACH));
  });
});

describe("drawnScale", () => {
  it("draws an aircraft at true size up close and at the model's exaggeration from afar", () => {
    expect(drawnScale(150)).toBe(1);
    expect(drawnScale(300)).toBe(1);
    expect(drawnScale(5000)).toBeCloseTo(2.2);
    expect(drawnScale(1200)).toBeGreaterThan(1);
    expect(drawnScale(1200)).toBeLessThan(2.2);
    expect(drawnScale(2000)).toBeGreaterThan(drawnScale(1200));
  });
});

describe("subjectOf", () => {
  it("measures an aircraft at its true size: a narrowbody is 44 m", () => {
    const s = subjectOf({ id: "a", x: 1, y: 2, heightM: 3, headingDeg: 4, state: "taxiing", model: "narrow", size: 1, speedMps: 5, climbMps: 0, fade: 1 });
    expect(s).toEqual({ x: 1, y: 2, heightM: 3, headingDeg: 4, length: 44, speedMps: 5, climbMps: 0 });
  });
});

// A narrowbody taxiing east.
const taxiing: Subject = { x: 1000, y: 200, heightM: 0, headingDeg: 90, length: 44, speedMps: 8, climbMps: 0 };

describe("drone", () => {
  const distance = (view: OrbitView, s: Subject) => {
    const [x, y, h] = eyeOf(view);
    return Math.hypot(x - s.x, y - s.y, h - s.heightM);
  };

  it("follows 200 to 400 m back along the track, further at speed, looking down 15 to 25 degrees", () => {
    const view = droneView(taxiing, ASPECT);
    const [x, y] = eyeOf(view);
    expect(x).toBeLessThan(taxiing.x - 150);
    expect(Math.abs(y - taxiing.y)).toBeLessThan(1);
    expect(view.azimuthDeg).toBeCloseTo(90);
    expect(view.elevationDeg).toBeGreaterThanOrEqual(15);
    expect(view.elevationDeg).toBeLessThanOrEqual(25);
    expect(distance(view, taxiing)).toBeGreaterThanOrEqual(200);
    const rolling = { ...taxiing, speedMps: 77 };
    expect(distance(droneView(rolling, ASPECT), rolling)).toBeGreaterThan(distance(view, taxiing) + 50);
    expect(distance(droneView(rolling, ASPECT), rolling)).toBeLessThanOrEqual(400);
  });

  it("shows the aircraft about a fifth of the frame wide, in its lower third, with the airport ahead in view", () => {
    const camera = cameraFor(droneView(taxiing, ASPECT));
    const tip = (side: number) => new Vector3(taxiing.x, taxiing.heightM, -taxiing.y + side * 18).project(camera);
    // Heading east, the wings run north and south.
    const width = Math.abs(tip(1).x - tip(-1).x) / 2;
    expect(width).toBeGreaterThan(0.15);
    expect(width).toBeLessThan(0.25);
    const v = new Vector3(taxiing.x, taxiing.heightM, -taxiing.y).project(camera);
    expect(v.y).toBeLessThan(-1 / 3);
    expect(v.y).toBeGreaterThan(-1);
    // The middle of the top edge lands well over a kilometre ahead.
    expect(groundReach(camera, 0, 1)).toBeGreaterThan(1500);
  });

  it("keeps the aircraft in the middle on a phone, clear of the flight card", () => {
    const phone = 390 / 844;
    const p = new Vector3(taxiing.x, taxiing.heightM, -taxiing.y).project(cameraFor(droneView(taxiing, phone), phone));
    expect(Math.abs(p.y)).toBeLessThan(0.05);
  });

  it("draws every aircraft at true size, in proportion along the frame", () => {
    expect(droneView(taxiing, ASPECT).trueSize).toBe(1);
  });

  it("never shows the horizon low over the field, and over a high climb-out hazes it out rather than looking steeper", () => {
    const low = droneView(taxiing, ASPECT);
    expect(topReach(low)).toBeLessThanOrEqual(HORIZON_REACH);
    expect(low.haze).toBeLessThanOrEqual(HORIZON_REACH);
    const high = droneView({ ...taxiing, heightM: 914 }, 2.4);
    expect(high.elevationDeg).toBeLessThanOrEqual(25);
    expect(high.haze).toBeLessThanOrEqual(HORIZON_REACH);
    expect(topReach(high, 2.4)).toBeGreaterThan(high.haze!);
  });
});

describe("tower", () => {
  // ATL's tower, from the map data: (593.3, 557), 121 m tall; its tallest building 18 m, drawn 2.4 times.
  it("rises from the tower to a high oblique on the selected aircraft, clear of every roof", () => {
    const far: Subject = { ...taxiing, x: -1839, y: -543 };
    const view = towerView(map, far, [0, 0], ASPECT)!;
    const [x, y, h] = eyeOf(view);
    expect(Math.hypot(x - 593.3, y - 557)).toBeLessThan(1);
    expect(h).toBeGreaterThan(121 + 60);
    expect(h).toBeGreaterThan(18 * 2.4 + 150);
    expect(view.elevationDeg).toBeGreaterThanOrEqual(20);
    expect(view.target).toEqual([far.x, far.y]);
    expect(topReach(view)).toBeLessThanOrEqual(HORIZON_REACH);
  });

  it("backs away from the tower rather than look straight down on an aircraft beside it", () => {
    const near: Subject = { ...taxiing, x: 620, y: 560 };
    const view = towerView(map, near, [0, 0], ASPECT)!;
    expect(view.elevationDeg).toBeLessThanOrEqual(50);
    expect(eyeOf(view)[2]).toBeGreaterThan(18 * 2.4 + 150 - 0.01);
  });

  it("looks at the field with no flight selected, and is not offered without a tower", () => {
    expect(towerView(map, null, [100, -300], ASPECT)!.target).toEqual([100, -300]);
    expect(towerView({ ...map, towers: [] }, taxiing, [0, 0], ASPECT)).toBeNull();
  });
});

describe("approach", () => {
  // DAL3104 in the fixture: over 09R's end, (-1839.4, -543.2), landing east.
  const landing: Subject = { x: -1839.4, y: -543.2, heightM: 0, headingDeg: 90, length: 44, speedMps: 77, climbMps: -3 };

  it("sits above and behind an arrival on the runway's line, with the runway ahead in frame", () => {
    const view = approachView(map.runways, landing, "9R", ASPECT)!;
    const [x, , h] = eyeOf(view);
    expect(x).toBeLessThan(landing.x);
    expect(h - landing.heightM).toBeGreaterThanOrEqual(60);
    expect(h - landing.heightM).toBeLessThanOrEqual(150);
    expect(view.azimuthDeg).toBeCloseTo(90, 0);
    const camera = cameraFor(view);
    for (const along of [0, 600]) {
      const v = new Vector3(landing.x + along, 0, -landing.y).project(camera);
      expect(Math.abs(v.x)).toBeLessThan(1);
      expect(Math.abs(v.y)).toBeLessThan(1);
    }
    expect(topReach(view)).toBeLessThanOrEqual(HORIZON_REACH);
    expect(view.trueSize).toBe(1);
  });

  it("has nothing for a flight without a runway the map knows", () => {
    expect(approachView(map.runways, landing, null, ASPECT)).toBeNull();
    expect(approachView(map.runways, landing, "4", ASPECT)).toBeNull();
  });
});

describe("far arrivals keep their runway in frame", () => {
  // RPA4349 in the fixture: 3.8 km short of 8L, 146 m up, on the centreline; and DAL1488, 15 km out
  // north-west, 655 m up, heading 115 toward the 8L final.
  const final: Subject = { x: -4847, y: 1429, heightM: 146, headingDeg: 90, length: 30, speedMps: 64, climbMps: -4 };
  const far: Subject = { x: -15443, y: 2497, heightM: 655, headingDeg: 115, length: 42, speedMps: 112, climbMps: -5 };
  const threshold8L = map.runways.flatMap((r) => r.ends).find((e) => e.ref === "08L")!;
  const where = (view: OrbitView) => new Vector3(threshold8L.x, 0, -threshold8L.y).project(cameraFor(view));
  const picked = (s: Subject) => ({ scene: { x: s.x, y: s.y, heightM: s.heightM, headingDeg: s.headingDeg, model: "narrow", size: 1, speedMps: s.speedMps, climbMps: s.climbMps, fade: 1 }, runway: "8L", state: "arriving" as const });

  it("the drone, on final, has the threshold well inside the frame rather than on its top edge", () => {
    const shot = modeShot("drone", map, picked(final) as never, [0, 0], ASPECT, NO_LOOK)!;
    const v = where(shot.view);
    expect(Math.abs(v.x)).toBeLessThan(0.9);
    expect(v.y).toBeLessThan(0.75);
    expect(v.y).toBeGreaterThan(-0.5);
  });

  it("the drone turns from the track toward the runway an arrival 15 km out is making for", () => {
    const v = where(modeShot("drone", map, picked(far) as never, [0, 0], ASPECT, NO_LOOK)!.view);
    expect(Math.abs(v.x)).toBeLessThan(0.9);
    expect(v.y).toBeLessThan(0.75);
  });

  it("the approach camera, on final, has the threshold well inside the frame", () => {
    const v = where(modeShot("approach", map, picked(final) as never, [0, 0], ASPECT, NO_LOOK)!.view);
    expect(Math.abs(v.x)).toBeLessThan(0.9);
    expect(v.y).toBeLessThan(0.75);
    expect(v.y).toBeGreaterThan(-0.5);
  });

  it("leaves an arrival already over the field framed as before", () => {
    const over: Subject = { ...final, x: -1500, heightM: 20 };
    const p = picked(over);
    expect(modeShot("drone", map, p as never, [0, 0], ASPECT, NO_LOOK)!.view).toEqual(droneView(subjectOf(p.scene as never), ASPECT));
  });
});

describe("cameraModes", () => {
  it("offers the tower from the map, the drone for a selected flight, and the approach for an arrival on a runway", () => {
    expect(cameraModes(map, null)).toEqual(["orbit", "tower"]);
    expect(cameraModes(map, { runway: null, state: "taxiing" })).toEqual(["orbit", "tower", "drone"]);
    expect(cameraModes(map, { runway: "9L", state: "departing" })).toEqual(["orbit", "tower", "drone"]);
    expect(cameraModes(map, { runway: "9R", state: "arriving" })).toEqual(["orbit", "tower", "drone", "approach"]);
    expect(cameraModes({ ...map, towers: [] }, null)).toEqual(["orbit"]);
  });
});

describe("modeView", () => {
  const drawn = { id: "a", x: -1839.4, y: -543.2, heightM: 0, headingDeg: 90, state: "arriving" as const, model: "narrow" as const, size: 1, speedMps: 77, climbMps: -3, fade: 1 };
  const picked = { scene: drawn, runway: "9R", state: "arriving" as const };

  it("gives each mode its view of the selected flight, and the orbit none of its own", () => {
    expect(modeView("orbit", map, picked, [0, 0], ASPECT)).toBeNull();
    expect(modeView("drone", map, picked, [0, 0], ASPECT)).toEqual(droneView(subjectOf(drawn), ASPECT));
    expect(modeView("approach", map, picked, [0, 0], ASPECT)).toEqual(approachView(map.runways, subjectOf(drawn), "9R", ASPECT));
    expect(modeView("tower", map, picked, [0, 0], ASPECT)!.target).toEqual([drawn.x, drawn.y]);
  });

  it("has nothing for the aircraft's cameras once no flight is selected, or the approach once it is not arriving", () => {
    expect(modeView("drone", map, null, [0, 0], ASPECT)).toBeNull();
    expect(modeView("approach", map, null, [0, 0], ASPECT)).toBeNull();
    expect(modeView("approach", map, { ...picked, state: "departing" }, [0, 0], ASPECT)).toBeNull();
    expect(modeView("tower", map, null, [5, 6], ASPECT)!.target).toEqual([5, 6]);
  });
});

describe("CameraRig", () => {
  const orbitView: OrbitView = { azimuthDeg: 30, elevationDeg: 40, target: [0, 0], height: 0, distance: 8000 };
  const drone = droneView(taxiing, ASPECT);

  it("leaves the camera to the orbit until a mode is chosen", () => {
    const rig = new CameraRig();
    expect(rig.active).toBe(false);
    expect(rig.frame(0, orbitView, orbitView, null)).toBeNull();
  });

  it("eases into a mode from wherever the camera was, then rides with it", () => {
    const rig = new CameraRig();
    rig.set("drone");
    expect(rig.active).toBe(true);
    expect(rig.frame(1000, orbitView, drone, "a")).toMatchObject({ ...orbitView, fovDeg: ORBIT_FOV, eyeLevel: 0, trueSize: 0 });
    const mid = rig.frame(1000 + CAMERA_EASE_MS / 2, orbitView, drone, "a")!;
    expect(mid.distance).toBeLessThan(orbitView.distance);
    expect(mid.distance).toBeGreaterThan(drone.distance);
    expect(mid.eyeLevel).toBeGreaterThan(0);
    expect(mid.eyeLevel).toBeLessThan(1);
    expect(rig.frame(1000 + CAMERA_EASE_MS, mid, drone, "a")).toEqual(drone);
    const moved = droneView({ ...taxiing, x: taxiing.x + 50 }, ASPECT);
    expect(rig.frame(5000, drone, moved, "a")).toEqual(moved);
  });

  it("eases over again when the camera turns to another aircraft", () => {
    const rig = new CameraRig();
    rig.set("drone");
    rig.frame(0, orbitView, drone, "a");
    rig.frame(CAMERA_EASE_MS, orbitView, drone, "a");
    const other = droneView({ ...taxiing, x: -3000 }, ASPECT);
    expect(rig.frame(5000, drone, other, "b")).toEqual(drone);
  });

  it("hands the camera back to the orbit after easing back to it", () => {
    const rig = new CameraRig();
    rig.set("tower");
    rig.frame(0, orbitView, drone, null);
    rig.frame(CAMERA_EASE_MS, orbitView, drone, null);
    rig.set("orbit");
    expect(rig.active).toBe(true);
    expect(rig.frame(10_000, drone, orbitView, null)).toEqual(drone);
    expect(rig.frame(10_000 + CAMERA_EASE_MS / 2, drone, orbitView, null)!.eyeLevel).toBeLessThan(1);
    expect(rig.frame(10_000 + CAMERA_EASE_MS, drone, orbitView, null)).toBeNull();
    expect(rig.active).toBe(false);
  });
});

describe("close-up air", () => {
  const orbitView: OrbitView = { azimuthDeg: 30, elevationDeg: 40, target: [0, 0], height: 0, distance: 8000 };

  it("brings the near plane in as the camera comes down, so nothing near it is clipped", () => {
    expect(nearPlane(orbitView)).toBe(50);
    expect(nearPlane({ ...orbitView, elevationDeg: 1, distance: 100 })).toBe(2);
    const drone = droneView(taxiing, ASPECT);
    expect(nearPlane(drone)).toBeCloseTo(eyeOf(drone)[2] * 0.1, 3);
  });

  it("closes in a close view's haze with the weather, but never so far that what it looks at is lost", () => {
    const eye = { near: 3000, far: 10_000 };
    const tower: OrbitView = { ...orbitView, distance: 3000, eyeLevel: 1 };
    expect(fogRange(tower, { near: 1, far: 4 }, eye, 1)).toEqual(eye);
    const misty = fogRange(tower, { near: 1, far: 4 }, eye, 0.8);
    expect(misty.far).toBeCloseTo(8000);
    expect(misty.near).toBeCloseTo(2400);
    // Thick fog: held at the orbit's thickest, in the camera's own distance.
    const thick = fogRange(tower, { near: 1, far: 4 }, eye, 0.06);
    expect(thick.far).toBeCloseTo(6000);
    expect(thick.near).toBeCloseTo(840);
    // A drone's own haze closes in too.
    const drone: OrbitView = { ...orbitView, distance: 300, eyeLevel: 1, haze: 2500 };
    expect(fogRange(drone, { near: 1, far: 4 }, eye, 0.5).far).toBeCloseTo(1250);
    expect(fogRange(drone, { near: 1, far: 4 }, eye, 0.06).far).toBeCloseTo(600);
  });

  it("fogs by the orbit's distance from above and by the theme's metres close up", () => {
    const orbitFog = { near: 1, far: 2 };
    const eyeFog = { near: 4000, far: 30_000 };
    expect(fogRange(orbitView, orbitFog, eyeFog)).toEqual({ near: 8000, far: 16_000 });
    expect(fogRange({ ...orbitView, eyeLevel: 1 }, orbitFog, eyeFog)).toEqual(eyeFog);
    expect(fogRange({ ...orbitView, eyeLevel: 0.5 }, orbitFog, eyeFog)).toEqual({ near: 6000, far: 23_000 });
    // A mode's own haze, nearer than the theme's, starts at the same share of its end.
    expect(fogRange({ ...orbitView, eyeLevel: 1, haze: 3000 }, orbitFog, eyeFog)).toEqual({ near: 900, far: 3000 });
  });
});

describe("looking around inside a mode", () => {
  const drawn = { id: "a", x: -1839.4, y: -543.2, heightM: 0, headingDeg: 90, state: "arriving" as const, model: "narrow" as const, size: 1, speedMps: 20, climbMps: 0, fade: 1 };
  const picked = { scene: drawn, runway: "9R", state: "arriving" as const };
  const shot = (mode: "drone" | "approach" | "tower", look: Partial<ModeLook> = {}, aspect = ASPECT) => modeShot(mode, map, picked, [0, 0], aspect, { ...NO_LOOK, ...look })!;
  /** Where the aircraft sits in the frame, normalised device coordinates. */
  const onScreen = (view: OrbitView) => new Vector3(drawn.x, drawn.heightM, -drawn.y).project(cameraFor(view));
  const range = (view: OrbitView) => {
    const [x, y, h] = eyeOf(view);
    return Math.hypot(x - drawn.x, y - drawn.y, h - drawn.heightM);
  };
  /** The compass bearing from the eye to the aircraft. */
  const bearingTo = (view: OrbitView) => {
    const [x, y] = eyeOf(view);
    return ((Math.atan2(drawn.x - x, drawn.y - y) * 180) / Math.PI + 360) % 360;
  };

  it("with no offsets, frames exactly as the mode does", () => {
    expect(shot("drone").view).toEqual(modeView("drone", map, picked, [0, 0], ASPECT));
    expect(shot("approach").view).toEqual(modeView("approach", map, picked, [0, 0], ASPECT));
    expect(shot("tower").view).toEqual(modeView("tower", map, picked, [0, 0], ASPECT));
    expect(shot("drone").look).toEqual(NO_LOOK);
  });

  for (const mode of ["drone", "approach"] as const) {
    it(`${mode}: a bearing offset swings the camera round the aircraft, which keeps its place in the frame`, () => {
      const base = shot(mode).view;
      const swung = shot(mode, { bearingDeg: 90 }).view;
      // Behind an eastbound aircraft looks east; a quarter turn round it looks south.
      expect(bearingTo(base)).toBeCloseTo(90, 0);
      expect(bearingTo(swung)).toBeCloseTo(180, 0);
      expect(range(swung)).toBeCloseTo(range(base), 3);
      expect(onScreen(swung).x).toBeCloseTo(onScreen(base).x, 3);
      expect(onScreen(swung).y).toBeCloseTo(onScreen(base).y, 3);
    });

    it(`${mode}: a pitch offset looks more steeply down, never flatter than the mode allows nor straight down`, () => {
      const base = shot(mode).view;
      const steeper = shot(mode, { pitchDeg: 20 });
      expect(steeper.look.pitchDeg).toBe(20);
      expect(steeper.view.elevationDeg).toBeGreaterThan(base.elevationDeg + 10);
      expect(Math.abs(onScreen(steeper.view).y)).toBeLessThan(1);
      // The mode's own framing is already as flat as its rule allows: held there, and the offset with it.
      const flatter = shot(mode, { pitchDeg: -40 });
      if (mode === "drone") expect(flatter.look.pitchDeg).toBe(0);
      expect(flatter.look.pitchDeg).toBeLessThanOrEqual(0);
      expect(flatter.look.pitchDeg).toBeGreaterThan(-40);
      if (mode === "approach") expect(topReach(flatter.view)).toBeLessThanOrEqual(HORIZON_REACH + 1);
      const down = shot(mode, { pitchDeg: 89 });
      expect(down.look.pitchDeg).toBeLessThan(89);
      expect(down.view.elevationDeg).toBeLessThanOrEqual(LOOK_MAX_PITCH + 1e-6);
    });

    it(`${mode}: the zoom moves the camera in and out within the mode's range`, () => {
      const base = range(shot(mode).view);
      expect(range(shot(mode, { zoom: 2 }).view)).toBeCloseTo(2 * base, 0);
      const far = shot(mode, { zoom: 100 });
      expect(far.look.zoom).toBe(LOOK_ZOOM.max);
      const near = shot(mode, { zoom: 0.01 });
      expect(near.look.zoom).toBe(LOOK_ZOOM.min);
      expect(range(near.view)).toBeCloseTo(LOOK_ZOOM.min * base, 0);
    });
  }

  it("drone: the haze still ends before the model does, at any offset", () => {
    for (const look of [{ pitchDeg: 50 }, { zoom: LOOK_ZOOM.max }, { bearingDeg: 200, pitchDeg: -30 }]) {
      const view = shot("drone", look).view;
      expect(view.haze).toBeLessThanOrEqual(HORIZON_REACH);
      expect(view.elevationDeg).toBeGreaterThanOrEqual(15);
    }
  });

  it("approach: further back is higher, and looks down enough that the frame's top edge stays on the model", () => {
    const view = shot("approach", { zoom: LOOK_ZOOM.max, pitchDeg: -30 }).view;
    expect(topReach(view)).toBeLessThanOrEqual(HORIZON_REACH + 1);
  });

  it("approach: a floor raised by a high flight holds the view, but does not stick to the offset", () => {
    const high = modeShot("approach", map, { ...picked, scene: { ...drawn, heightM: 900 } }, [0, 0], ASPECT, NO_LOOK)!;
    expect(high.look.pitchDeg).toBe(0);
    expect(topReach(high.view)).toBeLessThanOrEqual(HORIZON_REACH + 1);
  });

  it("tower: looks around from the cab, the eye staying where it is", () => {
    const base = shot("tower").view;
    const turned = shot("tower", { bearingDeg: 120, pitchDeg: 10 });
    const [x0, y0, h0] = eyeOf(base);
    const [x1, y1, h1] = eyeOf(turned.view);
    expect(Math.hypot(x1 - x0, y1 - y0, h1 - h0)).toBeLessThan(0.5);
    expect(turned.view.azimuthDeg).toBeCloseTo((base.azimuthDeg + 120) % 360, 3);
    expect(turned.view.elevationDeg).toBeCloseTo(base.elevationDeg + 10, 3);
    expect(turned.look).toMatchObject({ bearingDeg: 120, zoom: 1 });
    expect(turned.look.pitchDeg).toBeCloseTo(10, 6);
  });

  it("tower: never looks flat enough to see past the mapped edge, nor down into its own walls", () => {
    for (const bearingDeg of [0, 90, 180, 270]) {
      const up = shot("tower", { bearingDeg, pitchDeg: -60 });
      expect(topReach(up.view)).toBeLessThanOrEqual(HORIZON_REACH + 1);
      expect(up.look.pitchDeg).toBeGreaterThan(-60);
    }
    const down = shot("tower", { pitchDeg: 80 });
    expect(down.view.elevationDeg).toBeLessThanOrEqual(LOOK_MAX_PITCH + 1e-6);
    expect(down.look.pitchDeg).toBeLessThan(80);
  });

  it("tower: keeps the middle of the frame on the mapped field, whichever way it turns", () => {
    const area = { home: [0, 0] as [number, number], radius: 2000 };
    for (const bearingDeg of [0, 60, 120, 180, 240, 300]) {
      const look = { ...NO_LOOK, bearingDeg, pitchDeg: -60 };
      const view = modeShot("tower", map, picked, [0, 0], ASPECT, look, area)!.view;
      expect(Math.hypot(view.target[0], view.target[1])).toBeLessThanOrEqual(area.radius + 1);
    }
    // An arrival out beyond the field is still looked at as the mode frames it.
    const final = { ...picked, scene: { ...drawn, x: -6000 } };
    expect(modeShot("tower", map, final, [0, 0], ASPECT, NO_LOOK, area)!.view).toEqual(towerView(map, subjectOf(final.scene), [0, 0], ASPECT));
    // Without a limit to keep to, only the horizon's rule applies, and it looks farther.
    const free = modeShot("tower", map, picked, [0, 0], ASPECT, { ...NO_LOOK, bearingDeg: 180, pitchDeg: -60 })!.view;
    expect(Math.hypot(free.target[0], free.target[1])).toBeGreaterThan(area.radius);
  });

  it("tower: the zoom narrows or widens the cab's lens within its range", () => {
    const base = shot("tower").view;
    expect(shot("tower", { zoom: 0.5 }).view.fovDeg).toBeCloseTo(base.fovDeg! * 0.5, 3);
    expect(shot("tower", { zoom: 0.01 }).look.zoom).toBeGreaterThan(0.01);
    expect(shot("tower", { zoom: 100 }).view.fovDeg).toBeLessThanOrEqual(45);
  });
});

describe("lookDrag and lookKey", () => {
  it("a drag across turns as the orbit does; down tilts the drone and approach down, and the tower's look up", () => {
    expect(lookDrag("drone", 100, 0)).toEqual({ bearingDeg: -30, pitchDeg: 0, zoom: 1 });
    expect(lookDrag("drone", 0, 100).pitchDeg).toBeCloseTo(30);
    expect(lookDrag("approach", 0, 100).pitchDeg).toBeCloseTo(30);
    expect(lookDrag("tower", 100, 0).bearingDeg).toBeCloseTo(-30);
    expect(lookDrag("tower", 0, 100).pitchDeg).toBeCloseTo(-30);
  });

  it("the view keys look around in a mode: arrows and Q/E turn, up and down tilt, plus and minus zoom", () => {
    expect(lookKey({ kind: "turn", deg: 30, tilt: 0 })).toEqual({ bearingDeg: 30, pitchDeg: 0, zoom: 1 });
    expect(lookKey({ kind: "turn", deg: 0, tilt: 10 })).toEqual({ bearingDeg: 0, pitchDeg: 10, zoom: 1 });
    expect(lookKey({ kind: "pan", forward: 0, right: -1 })).toEqual({ bearingDeg: -30, pitchDeg: 0, zoom: 1 });
    expect(lookKey({ kind: "pan", forward: 1, right: 0 })).toEqual({ bearingDeg: 0, pitchDeg: 10, zoom: 1 });
    expect(lookKey({ kind: "zoom", factor: 0.7 })).toEqual({ bearingDeg: 0, pitchDeg: 0, zoom: 0.7 });
  });
});

describe("CameraRig look", () => {
  it("adds turns and tilts and multiplies the zoom; a new mode starts from its own framing", () => {
    const rig = new CameraRig();
    rig.set("drone");
    rig.lookBy({ bearingDeg: 30, pitchDeg: 5, zoom: 0.5 });
    rig.lookBy({ bearingDeg: 30, pitchDeg: 0, zoom: 0.5 });
    expect(rig.look).toEqual({ bearingDeg: 60, pitchDeg: 5, zoom: 0.25 });
    rig.set("tower");
    expect(rig.look).toEqual(NO_LOOK);
  });

  it("follows a drag at once, and eases a stepped look (a key or a button)", () => {
    const rig = new CameraRig();
    const a: OrbitView = { azimuthDeg: 0, elevationDeg: 30, target: [0, 0], height: 0, distance: 300, fovDeg: 30, eyeLevel: 1 };
    const b: OrbitView = { ...a, azimuthDeg: 90 };
    rig.set("drone");
    rig.frame(0, a, a, "x");
    rig.frame(CAMERA_EASE_MS, a, a, "x");
    rig.lookBy({ bearingDeg: 90, pitchDeg: 0, zoom: 1 });
    expect(rig.frame(CAMERA_EASE_MS + 1, a, b, "x")).toEqual(b);
    rig.lookBy({ bearingDeg: -90, pitchDeg: 0, zoom: 1 }, true);
    expect(rig.frame(5000, b, a, "x")!.azimuthDeg).toBeCloseTo(90);
    expect(rig.frame(5000 + LOOK_EASE_MS / 2, b, a, "x")!.azimuthDeg).toBeCloseTo(45);
    expect(rig.frame(5000 + LOOK_EASE_MS, b, a, "x")).toEqual(a);
  });
});
