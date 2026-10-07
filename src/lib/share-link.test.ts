import { describe, expect, it } from "vitest";
import { type Filters, NO_FILTERS } from "./filters";
import { formatMapHash, parseMapHash, readShareView, shareLink, type ShareView } from "./share-link";

const BASE = "http://atc.test/";

const view = (extra: Partial<ShareView> = {}): ShareView => ({ airport: "atl", theme: "light", flight: null, camera: "orbit", filters: NO_FILTERS, map: null, ...extra });

describe("parseMapHash", () => {
  it("reads the map's view out of the hash MapLibre writes, with or without bearing and pitch", () => {
    expect(parseMapHash("#map=14.14/33.64068/-84.42675/30/50")).toEqual({ zoom: 14.14, lat: 33.64068, lng: -84.42675, bearing: 30, pitch: 50 });
    expect(parseMapHash("#map=7/33.6/-84.4")).toEqual({ zoom: 7, lat: 33.6, lng: -84.4, bearing: 0, pitch: 0 });
    expect(parseMapHash("#map=7/33.6/-84.4/45")).toEqual({ zoom: 7, lat: 33.6, lng: -84.4, bearing: 45, pitch: 0 });
  });

  it("finds it among other hash parameters", () => {
    expect(parseMapHash("#foo=1&map=3/10/20")).toMatchObject({ zoom: 3, lat: 10, lng: 20 });
  });

  it("reads nothing from a hash that is missing, empty, not numbers, or out of range", () => {
    for (const hash of ["", "#", "#top", "#map=", "#map=NaN/NaN/NaN", "#map=7/NaN/-84", "#map=7/33.6", "#map=7/91/0", "#map=7/0/361", "#map=-1/0/0", "#map=99/0/0", "#map=7/0/0/0/90", "#map=7/0/0/x", "#map=Infinity/0/0", "#map=7/0/0/0/0/0"]) {
      expect(parseMapHash(hash), hash).toBeNull();
    }
  });
});

describe("formatMapHash", () => {
  it("writes a view back as the hash the map reads, leaving off a bearing and pitch of nothing", () => {
    expect(formatMapHash({ zoom: 7, lat: 33.6, lng: -84.4, bearing: 0, pitch: 0 })).toBe("#map=7/33.6/-84.4");
    expect(formatMapHash({ zoom: 14.14, lat: 33.64068, lng: -84.42675, bearing: 30, pitch: 50 })).toBe("#map=14.14/33.64068/-84.42675/30/50");
    expect(formatMapHash({ zoom: 7, lat: 33.6, lng: -84.4, bearing: 45, pitch: 0 })).toBe("#map=7/33.6/-84.4/45");
  });

  it("round trips through parseMapHash", () => {
    const h = { zoom: 5.5, lat: -12.25, lng: 130.125, bearing: -20, pitch: 30 };
    expect(parseMapHash(formatMapHash(h))).toEqual(h);
  });
});

describe("shareLink", () => {
  it("carries the airport, the theme, the selected flight, the camera and the filters", () => {
    const filters: Filters = { ...NO_FILTERS, airlines: ["DAL"], states: ["taxiing"] };
    const url = shareLink(BASE, view({ airport: "jfk", theme: "dark", flight: "DAL3104", camera: "drone", filters }));
    expect(url.searchParams.get("airport")).toBe("jfk");
    expect(url.searchParams.get("theme")).toBe("dark");
    expect(url.searchParams.get("flight")).toBe("DAL3104");
    expect(url.searchParams.get("camera")).toBe("drone");
    expect(url.searchParams.get("airline")).toBe("DAL");
    expect(url.searchParams.get("state")).toBe("taxiing");
    expect(url.hash).toBe("");
  });

  it("carries the flight selected on the map along with its view, and reads both back", () => {
    const map = { zoom: 7, lat: 33.2, lng: -86.4, bearing: 0, pitch: 0 };
    const url = shareLink(BASE, view({ theme: "dark", flight: "DAL1601", camera: "tower", map }));
    expect(url.searchParams.get("flight")).toBe("DAL1601");
    expect(url.searchParams.has("camera")).toBe(false);
    expect(url.hash).toBe("#map=7/33.2/-86.4");
    expect(readShareView(url.href)).toMatchObject({ flight: "DAL1601", map, theme: "dark" });
  });

  it("carries no flight from a map with nothing selected", () => {
    expect(shareLink(`${BASE}?flight=OLD1`, view({ map: { zoom: 7, lat: 33.2, lng: -86.4, bearing: 0, pitch: 0 } })).searchParams.has("flight")).toBe(false);
  });

  it("leaves out what is the default: the default airport, the light theme, the orbit, no flight, no filters", () => {
    expect(shareLink(BASE, view()).search).toBe("");
  });

  it("clears what an earlier address carried that the view no longer has", () => {
    const url = shareLink(`${BASE}?theme=dark&flight=OLD1&camera=tower&airline=UAL&mil=1#map=3/1/2`, view());
    expect(url.search).toBe("");
    expect(url.hash).toBe("");
  });

  it("keeps the other parameters of the address, such as a fixture", () => {
    expect(shareLink(`${BASE}?fixture=1&sun=08:30`, view({ theme: "satellite" })).search).toBe("?fixture=1&sun=08%3A30&theme=satellite");
  });

  it("puts the map's position in the hash on the map, with its selected flight but no camera, which is the diorama's", () => {
    const map = { zoom: 7, lat: 33.6, lng: -84.4, bearing: 0, pitch: 0 };
    const url = shareLink(BASE, view({ map, flight: "DAL3104", camera: "tower", filters: { ...NO_FILTERS, military: true } }));
    expect(url.hash).toBe("#map=7/33.6/-84.4");
    expect(url.searchParams.get("flight")).toBe("DAL3104");
    expect(url.searchParams.has("camera")).toBe(false);
    expect(url.searchParams.get("mil")).toBe("1");
  });

  it("drops a camera of the orbit and a flight with no callsign", () => {
    expect(shareLink(BASE, view({ flight: "", camera: "orbit" })).search).toBe("");
  });
});

describe("readShareView", () => {
  it("reads a link back to the view it was made from", () => {
    const filters: Filters = { airlines: ["DAL", "UAL"], types: ["B737"], states: ["taxiing", "holding"], altitudes: ["low"], speeds: ["slow"], origins: ["SRQ"], destinations: ["ATL"], military: true };
    const v = view({ airport: "dfw", theme: "satellite", flight: "AAL972", camera: "approach", filters });
    expect(readShareView(shareLink(BASE, v).href)).toEqual(v);
  });

  it("round trips a map view, and the flight selected on it", () => {
    const v = view({ airport: "pit", flight: "SWA1234", map: { zoom: 8.25, lat: 40.49, lng: -80.24, bearing: 15, pitch: 40 }, filters: { ...NO_FILTERS, airlines: ["SWA"] } });
    expect(readShareView(shareLink(BASE, v).href)).toEqual(v);
  });

  it("reads an address with nothing in it as the default view", () => {
    expect(readShareView(BASE)).toEqual(view());
  });

  it("falls back to the defaults for values that are not valid, and ignores a hash that is not a map view", () => {
    const v = readShareView(`${BASE}?airport=zzz&theme=neon&camera=chase&flight=%20&airline=!!#map=NaN/NaN/NaN`);
    expect(v).toEqual(view());
  });

  it("upper-cases a flight, as the page matches callsigns", () => {
    expect(readShareView(`${BASE}?flight=dal3104`).flight).toBe("DAL3104");
  });
});
