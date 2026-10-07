import { describe, expect, it } from "vitest";
import { nextRadarRead, parseRadarIndex, radarAge, RADAR_STALE_S } from "./radar";

/** The shape RainViewer documents (and answered on 2026-10-01): host, then frames with a path each. */
function index(over: Record<string, unknown> = {}) {
  return {
    version: "2.0",
    generated: 1_790_853_023,
    host: "https://tilecache.rainviewer.com",
    radar: {
      past: [
        { time: 1_790_852_400, path: "/v2/radar/80c44280016f" },
        { time: 1_790_853_000, path: "/v2/radar/20ca960629a8" },
      ],
      nowcast: [],
    },
    ...over,
  };
}

const NOW = 1_790_853_100;

describe("parseRadarIndex", () => {
  it("takes the newest past frame and builds its tile URL: 256 px tiles, Universal Blue, smoothed, no snow", () => {
    expect(parseRadarIndex(index(), NOW)).toEqual({
      time: 1_790_853_000,
      tiles: "https://tilecache.rainviewer.com/v2/radar/20ca960629a8/256/{z}/{x}/{y}/2/1_0.png",
    });
  });

  it("does not trust frame order", () => {
    const frames = [
      { time: 1_790_853_000, path: "/v2/radar/20ca960629a8" },
      { time: 1_790_852_400, path: "/v2/radar/80c44280016f" },
    ];
    expect(parseRadarIndex(index({ radar: { past: frames } }), NOW)?.time).toBe(1_790_853_000);
  });

  it("is null for a frame older than the stale limit: tiles from before that are not 'now'", () => {
    expect(parseRadarIndex(index(), 1_790_853_000 + RADAR_STALE_S)).not.toBeNull();
    expect(parseRadarIndex(index(), 1_790_853_000 + RADAR_STALE_S + 1)).toBeNull();
  });

  it("is null for no frames, or for a body that is not the index", () => {
    expect(parseRadarIndex(index({ radar: { past: [] } }), NOW)).toBeNull();
    expect(parseRadarIndex(index({ radar: {} }), NOW)).toBeNull();
    expect(parseRadarIndex({}, NOW)).toBeNull();
    expect(parseRadarIndex(null, NOW)).toBeNull();
    expect(parseRadarIndex("radar", NOW)).toBeNull();
  });

  it("only builds URLs on RainViewer's own hosts over https", () => {
    expect(parseRadarIndex(index({ host: "http://tilecache.rainviewer.com" }), NOW)).toBeNull();
    expect(parseRadarIndex(index({ host: "https://evil.example" }), NOW)).toBeNull();
    expect(parseRadarIndex(index({ host: "https://tilecache.rainviewer.com.evil.example" }), NOW)).toBeNull();
    expect(parseRadarIndex(index({ host: "https://tilecache.rainviewer.com/x?" }), NOW)).toBeNull();
    expect(parseRadarIndex(index({ host: "https://other.rainviewer.com" }), NOW)?.tiles.startsWith("https://other.rainviewer.com/")).toBe(true);
  });

  it("refuses a path that is anything but /v2/radar/<id>", () => {
    for (const path of ["/v2/radar/../../x", "//evil.example/a", "/v2/radar/ab cd", "/v2/radar/", "v2/radar/abc", "/v2/radar/abc?x=1", "/v2/radar/{z}"]) {
      expect(parseRadarIndex(index({ radar: { past: [{ time: 1_790_853_000, path }] } }), NOW)).toBeNull();
    }
  });
});

describe("nextRadarRead", () => {
  it("reads again in five minutes once there is a frame, and in thirty seconds while there is none", () => {
    expect(nextRadarRead(true)).toBe(300_000);
    expect(nextRadarRead(false)).toBe(30_000);
  });
});

describe("radarAge", () => {
  const T = 1_790_853_000;
  it("says how old the frame is in whole minutes, not a clock time that would be in the viewer's zone", () => {
    expect(radarAge(T, T + 6 * 60 + 20)).toBe("6 min ago");
    expect(radarAge(T, T + 59 * 60)).toBe("59 min ago");
    expect(radarAge(T, T + 60 * 60 + 5 * 60)).toBe("1 h 5 min ago");
  });

  it("calls a frame under a minute old just now, and never negative for a clock a little behind", () => {
    expect(radarAge(T, T + 59)).toBe("just now");
    expect(radarAge(T, T - 30)).toBe("just now");
  });
});
