import { describe, expect, it } from "vitest";
import { finiteCamera, groundView, liftView, type MapCamera, mapHashCamera, mapToOrbit, MAX_PITCH, orbitToMap, paddingFor, seenOnGround, shotBounds, viewArea, withoutBadMapHash, worldFloor } from "./camera";

const equator = { latitude: 0, longitude: 0 };
const atl = { latitude: 33.6367, longitude: -84.4281 };

describe("mapToOrbit", () => {
  it("measures the camera's distance from the map's own scale and lens", () => {
    // A 90 degree lens on a 512 px frame stands 256 px from the centre; at zoom 0 the 512 px world
    // spans the equator's 40,075,016.7 m, so 256 px is half of it.
    const cam: MapCamera = { lng: 0, lat: 0, zoom: 0, bearing: 0, pitch: 0 };
    expect(mapToOrbit(cam, equator, { height: 512, fovDeg: 90 }).distance).toBeCloseTo(20_037_508.34, 0);
    // At 60 degrees north Web Mercator draws the ground twice as large, so the same frame is half as far.
    expect(mapToOrbit({ ...cam, lat: 60 }, { latitude: 60, longitude: 0 }, { height: 512, fovDeg: 90 }).distance).toBeCloseTo(10_018_754.17, 0);
    // Each zoom level halves it.
    expect(mapToOrbit({ ...cam, zoom: 3 }, equator, { height: 512, fovDeg: 90 }).distance).toBeCloseTo(20_037_508.34 / 8, 0);
  });

  it("takes the bearing as the view's bearing and the pitch from straight down", () => {
    const v = mapToOrbit({ lng: 0, lat: 0, zoom: 12, bearing: 30, pitch: 50 }, equator, { height: 900, fovDeg: 22 });
    expect(v.azimuthDeg).toBeCloseTo(30);
    expect(v.elevationDeg).toBeCloseTo(40);
    expect(v.height).toBe(0);
  });

  it("puts the map's centre in the airport's local metres", () => {
    const v = mapToOrbit({ lng: atl.longitude, lat: atl.latitude + 0.01, zoom: 12, bearing: 0, pitch: 0 }, atl, { height: 900, fovDeg: 22 });
    // A hundredth of a degree of latitude is 1.11 km.
    expect(v.target[0]).toBeCloseTo(0, 3);
    expect(v.target[1]).toBeCloseTo(1112, 0);
  });

  it("wraps a negative bearing into 0..360", () => {
    expect(mapToOrbit({ lng: 0, lat: 0, zoom: 5, bearing: -90, pitch: 0 }, equator, { height: 900, fovDeg: 22 }).azimuthDeg).toBeCloseTo(270);
  });
});

describe("orbitToMap", () => {
  it("is the inverse of mapToOrbit", () => {
    const frame = { height: 900, fovDeg: 22 };
    const cam: MapCamera = { lng: -84.41, lat: 33.65, zoom: 12.4, bearing: 30, pitch: 50 };
    const back = orbitToMap(mapToOrbit(cam, atl, frame), atl, frame);
    expect(back.lng).toBeCloseTo(cam.lng, 9);
    expect(back.lat).toBeCloseTo(cam.lat, 9);
    expect(back.zoom).toBeCloseTo(cam.zoom, 9);
    expect(back.bearing).toBeCloseTo(cam.bearing, 9);
    expect(back.pitch).toBeCloseTo(cam.pitch, 9);
  });

  it("gives MapLibre a bearing between -180 and 180", () => {
    const v = { azimuthDeg: 300, elevationDeg: 40, target: [0, 0] as [number, number], height: 0, distance: 10_000 };
    expect(orbitToMap(v, atl, { height: 900, fovDeg: 22 }).bearing).toBeCloseTo(-60);
  });
});

describe("paddingFor", () => {
  it("pads the frame so the middle of what is left is the anchor", () => {
    expect(paddingFor({ x: 500, y: 450 }, 1440, 900)).toEqual({ left: 0, right: 440, top: 0, bottom: 0 });
    expect(paddingFor({ x: 900, y: 300 }, 1440, 900)).toEqual({ left: 360, right: 0, top: 0, bottom: 300 });
  });
});

describe("worldFloor", () => {
  const frame = { width: 1440, height: 900, fovDeg: 22 };

  it("keeps the globe's outline at least as wide as the frame's short side, and its centre off the poles", () => {
    // Seen through a 22 degree lens from 450 / tan 11 = 2315 px, a globe fills the 900 px height when its
    // outline subtends 11 degrees: radius 2315 sin 11 / (1 - sin 11) = 545.9 px. MapLibre draws a globe
    // worldSize / 2pi / cos(lat) in radius, so at 75 degrees that is zoom log2(2pi 545.9 cos 75 / 512).
    const out = worldFloor({ lng: -96, lat: 85, zoom: -3.67, bearing: 0, pitch: 0 }, frame, true);
    expect(out.lat).toBe(75);
    expect(out.zoom).toBeCloseTo(0.794, 3);
    expect(out.lng).toBe(-96);
    // Over the equator the same globe needs log2(2pi 545.9 / 512).
    expect(worldFloor({ lng: 0, lat: 0, zoom: 0, bearing: 0, pitch: 0 }, frame, true).zoom).toBeCloseTo(2.744, 3);
  });

  it("keeps the flat map's world at least the long side across, so it never repeats nor leaves empty bands", () => {
    expect(worldFloor({ lng: 0, lat: 0, zoom: -1, bearing: 0, pitch: 0 }, { width: 390, height: 844, fovDeg: 22 }, false).zoom).toBeCloseTo(Math.log2(844 / 512), 6);
    expect(worldFloor({ lng: 0, lat: 0, zoom: -1, bearing: 0, pitch: 0 }, frame, false).zoom).toBeCloseTo(Math.log2(1440 / 512), 6);
  });

  it("leaves a camera already inside the floor alone", () => {
    const cam: MapCamera = { lng: -84.4, lat: 33.6, zoom: 9, bearing: 20, pitch: 40 };
    expect(worldFloor(cam, frame, true)).toEqual(cam);
  });
});

describe("groundView and liftView", () => {
  // Looking east (azimuth 90) and 30 degrees down at a point 1000 m up, from 5 km.
  const aloft = { azimuthDeg: 90, elevationDeg: 30, target: [200, -100] as [number, number], height: 1000, distance: 5000 };

  it("moves the target down the line of sight to the ground, so the map, which only looks at the ground, keeps the same camera", () => {
    const g = groundView(aloft);
    // 1000 m down at 30 degrees is 1000 / tan 30 = 1732.05 m farther along the ground, and 1000 / sin 30 = 2000 m farther from the camera.
    expect(g.target[0]).toBeCloseTo(1932.05, 2);
    expect(g.target[1]).toBeCloseTo(-100, 6);
    expect(g.distance).toBeCloseTo(7000, 6);
    expect(g.height).toBe(0);
    expect(g.azimuthDeg).toBe(90);
    expect(g.elevationDeg).toBe(30);
  });

  it("lifts it back up to a point at a height on the same line, the inverse", () => {
    const back = liftView(groundView(aloft), 1000);
    expect(back.target[0]).toBeCloseTo(200, 6);
    expect(back.target[1]).toBeCloseTo(-100, 6);
    expect(back.distance).toBeCloseTo(5000, 6);
    expect(back.height).toBe(1000);
  });

  it("leaves a view already on the ground alone", () => {
    const flat = { ...aloft, height: 0 };
    expect(groundView(flat)).toEqual(flat);
  });
});

describe("a frame with no size, and the address's map camera", () => {
  it("leaves the camera alone when the frame has no size (a hidden tab), rather than flooring it to NaN", () => {
    const cam: MapCamera = { lng: -84.4, lat: 33.6, zoom: 9, bearing: 20, pitch: 40 };
    expect(worldFloor(cam, { width: 0, height: 0, fovDeg: 22 }, true)).toEqual(cam);
  });

  it("reads #map= only when every part is a finite number, and drops one that is not", () => {
    expect(mapHashCamera("#map=6/33.6/-84.4/30/50")).toEqual({ zoom: 6, lat: 33.6, lng: -84.4, bearing: 30, pitch: 50 });
    expect(mapHashCamera("#map=6/33.6/-84.4")).toEqual({ zoom: 6, lat: 33.6, lng: -84.4, bearing: 0, pitch: 0 });
    expect(mapHashCamera("#map=NaN/NaN/NaN")).toBeNull();
    expect(mapHashCamera("#map=6/Infinity/-84.4")).toBeNull();
    expect(mapHashCamera("#other=1")).toBeNull();
    expect(withoutBadMapHash("#map=NaN/NaN/NaN")).toBe("");
    expect(withoutBadMapHash("#map=NaN/NaN/NaN&x=1")).toBe("#x=1");
    expect(withoutBadMapHash("#map=6/33.6/-84.4/30/50")).toBe("#map=6/33.6/-84.4/30/50");
  });

  it("names no camera for a tilt past the map's own limit (MAX_PITCH), which the map would refuse and open on the world instead", () => {
    // An En-route 3D camera's own view, as an address made before the address carried the journey's flat shot.
    expect(mapHashCamera("#map=15.6/33.7/-85.454916/-90/90")).toBeNull();
    expect(mapHashCamera(`#map=9/33.7/-85.4/0/${MAX_PITCH}`)).toEqual({ zoom: 9, lat: 33.7, lng: -85.4, bearing: 0, pitch: MAX_PITCH });
    expect(mapHashCamera(`#map=9/33.7/-85.4/0/${MAX_PITCH + 1}`)).toBeNull();
    expect(withoutBadMapHash("#map=15.6/33.7/-85.454916/-90/90&x=1")).toBe("#x=1");
  });

  it("lets a camera through only when all of it is finite", () => {
    expect(finiteCamera({ lng: 1, lat: 2, zoom: 3, bearing: 4, pitch: 5 })).toBe(true);
    expect(finiteCamera({ lng: 1, lat: 2, zoom: Number.NaN, bearing: 4, pitch: 5 })).toBe(false);
    expect(finiteCamera({ lng: 1, lat: 2, zoom: -Infinity, bearing: 4, pitch: 5 })).toBe(false);
  });
});

describe("seenOnGround", () => {
  // Looking north, 30 degrees down, at the ground point (0, 0) from 10 km: the camera is at (0, -8660) and 5,000 m up.
  const view = { azimuthDeg: 0, elevationDeg: 30, target: [0, 0] as [number, number], height: 0, distance: 10_000 };

  it("puts a point in the air where the camera's line of sight through it meets the ground", () => {
    // 1,000 m up on the line of sight to the target: it meets the ground at the target.
    const onAxis = seenOnGround(view, [0, -8660.254 + 8660.254 * 0.8], 1000);
    expect(onAxis[0]).toBeCloseTo(0, 3);
    expect(onAxis[1]).toBeCloseTo(0, 1);
    // 2 km to the side and 1,000 m up, a fifth of the way down from the camera's 5,000 m: the ground point
    // is 5/4 as far from the camera, so 2.5 km to the side.
    const aside = seenOnGround(view, [2000, -8660.254 + 8660.254 * 0.8], 1000);
    expect(aside[0]).toBeCloseTo(2500, 3);
  });

  it("leaves a point on the ground where it is", () => {
    expect(seenOnGround(view, [123, 456], 0)).toEqual([123, 456]);
  });
});

describe("shotBounds", () => {
  const frame = { width: 1280, height: 900, fovDeg: 36.87 };
  const none = { top: 0, bottom: 0, left: 0, right: 0 };
  const shot: MapCamera = { lng: -84.4281, lat: 33.6367, zoom: 9, bearing: 30, pitch: 40 };
  const inside = (b: { west: number; east: number; south: number; north: number }, lng: number, lat: number) => lng >= b.west && lng <= b.east && lat >= b.south && lat <= b.north;

  it("spans the frame's width and height at the map's scale, looking straight down", () => {
    // Zoom 0 is a 512 px world, so a 1280 px frame at zoom 2 spans 1280 / 2048 of the 360 degrees round.
    const b = shotBounds({ lng: 0, lat: 0, zoom: 2, bearing: 0, pitch: 0 }, frame, none);
    expect(b.east - b.west).toBeCloseTo((1280 / 2048) * 360, 6);
    expect(b.west).toBeCloseTo(-b.east, 6);
    expect(b.north).toBeCloseTo(-b.south, 6);
  });

  it("holds the flight it frames, padded or not", () => {
    expect(inside(shotBounds(shot, frame, none), shot.lng, shot.lat)).toBe(true);
    expect(inside(shotBounds(shot, frame, { top: 0, bottom: 0, left: 600, right: 0 }), shot.lng, shot.lat)).toBe(true);
  });

  it("holds an aircraft about 10 km off and not one 500 km off", () => {
    const b = shotBounds(shot, frame, none);
    expect(inside(b, shot.lng + 0.06, shot.lat + 0.05)).toBe(true);
    expect(inside(b, shot.lng + 5, shot.lat + 2)).toBe(false);
  });

  it("is a real, finite area at any pitch, straight at the horizon included", () => {
    for (const pitch of [0, 60, 78, 90, 110]) {
      const b = shotBounds({ ...shot, pitch }, frame, none);
      expect([b.west, b.east, b.south, b.north].every(Number.isFinite)).toBe(true);
      expect(b.east - b.west).toBeGreaterThan(0.01);
      expect(b.north - b.south).toBeGreaterThan(0.01);
      expect(inside(b, shot.lng, shot.lat)).toBe(true);
    }
  });
});

describe("viewArea", () => {
  const frame = { width: 1280, height: 900, fovDeg: 36.87 };
  const padding = { top: 0, bottom: 0, left: 0, right: 0 };
  const shot: MapCamera = { lng: -85.42, lat: 33.7, zoom: 9, bearing: 0, pitch: 0 };
  const near = { lng: -85.33, lat: 33.72 };
  const far = { lng: -80, lat: 36 };
  const inside = (b: { west: number; east: number; south: number; north: number }, p: { lng: number; lat: number }) => p.lng >= b.west && p.lng <= b.east && p.lat >= b.south && p.lat <= b.north;

  it("is the map's own bounds, unchanged, on Map", () => {
    const own = { west: -86, east: -85, south: 33, north: 34 };
    expect(viewArea(own, null)).toBe(own);
  });

  it("is the journey's flat shot in every 3D camera, whatever the map's own bounds are", () => {
    // Cockpit and Side at pitch 90 report a point; Chase and Top a small or odd area down the line of sight.
    const owns = [
      { west: -85.42, east: -85.42, south: 33.7, north: 33.7 },
      { west: -85.5, east: -85.41, south: 33.69, north: 33.75 },
      { west: -84, east: -83.5, south: 34, north: 34.2 },
    ];
    const areas = owns.map((own) => viewArea(own, { camera: shot, frame, padding }));
    for (const a of areas) {
      expect(a).toEqual(areas[0]);
      expect(a.east - a.west).toBeGreaterThan(0.01);
      expect(inside(a, near)).toBe(true);
      expect(inside(a, far)).toBe(false);
    }
  });
});
