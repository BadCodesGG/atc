import { describe, expect, it } from "vitest";
import { type AircraftPhoto, PhotoCache, parsePhoto, photoEndpoint, photosEnabled } from "./aircraft-photo";

/** The shape Planespotters documents for a hit (photo API page, "Response"). */
const HIT = {
  photos: [
    {
      id: "000001",
      thumbnail: { src: "https://t.plnspttrs.net/33130/b-hoy_t.jpg", size: { width: 200, height: 133 } },
      thumbnail_large: { src: "https://t.plnspttrs.net/33130/b-hoy_280.jpg", size: { width: 420, height: 280 } },
      link: "https://www.planespotters.net/photo/000001/b-hoy-cathay-pacific-boeing-747-467",
      photographer: "Thomas Noack",
    },
  ],
};

describe("photoEndpoint", () => {
  it("asks by hex, lower-cased, and by nothing that is not six hex digits", () => {
    expect(photoEndpoint("A1B2C3")).toBe("https://api.planespotters.net/pub/photos/hex/a1b2c3");
    expect(photoEndpoint("a1b2c3/../x")).toBeNull();
    expect(photoEndpoint("~a1b2c3")).toBeNull();
    expect(photoEndpoint("")).toBeNull();
  });
});

describe("parsePhoto", () => {
  it("reads the large thumbnail, its size, the photo's page and the photographer", () => {
    expect(parsePhoto(HIT)).toEqual({
      src: "https://t.plnspttrs.net/33130/b-hoy_280.jpg",
      width: 420,
      height: 280,
      link: "https://www.planespotters.net/photo/000001/b-hoy-cathay-pacific-boeing-747-467",
      photographer: "Thomas Noack",
    });
  });

  it("falls back to the small thumbnail", () => {
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], thumbnail_large: undefined }] })?.src).toBe("https://t.plnspttrs.net/33130/b-hoy_t.jpg");
  });

  it("is null for no photos, an error body, or anything else", () => {
    expect(parsePhoto({ photos: [] })).toBeNull();
    expect(parsePhoto({ error: "nope" })).toBeNull();
    expect(parsePhoto(null)).toBeNull();
    expect(parsePhoto("photos")).toBeNull();
  });

  it("is null without a photographer to credit: the terms require the credit", () => {
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], photographer: "" }] })).toBeNull();
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], photographer: undefined }] })).toBeNull();
  });

  it("refuses a link or image that is not on Planespotters over https", () => {
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], link: "javascript:alert(1)" }] })).toBeNull();
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], link: "https://evil.example/photo/1" }] })).toBeNull();
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], link: "https://www.planespotters.net.evil.example/p" }] })).toBeNull();
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], thumbnail: undefined, thumbnail_large: { src: "http://t.plnspttrs.net/a.jpg", size: { width: 1, height: 1 } } }] })).toBeNull();
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], thumbnail: undefined, thumbnail_large: { src: "https://t.plnspttrs.net.evil.example/a.jpg", size: { width: 1, height: 1 } } }] })).toBeNull();
    expect(parsePhoto({ photos: [{ ...HIT.photos[0], thumbnail: undefined, thumbnail_large: { src: "https://evil.example/a.jpg", size: { width: 1, height: 1 } } }] })).toBeNull();
  });
});

describe("photosEnabled", () => {
  it("is on for the live page and off for a fixture, unless the fixture asks for photos", () => {
    expect(photosEnabled("")).toBe(true);
    expect(photosEnabled("?airport=atl")).toBe(true);
    expect(photosEnabled("?fixture=1")).toBe(false);
    expect(photosEnabled("?fixture=1&photos=1")).toBe(true);
  });
});

const PHOTO: AircraftPhoto = parsePhoto(HIT)!;

/** A cache on a fake clock whose upstream answers `answer()` and records the URLs it is asked. */
function harness(answer: (url: string) => Promise<unknown> = async () => HIT) {
  let clock = 0;
  const asked: string[] = [];
  const cache = new PhotoCache(
    (url) => {
      asked.push(url);
      return answer(url);
    },
    () => clock,
  );
  return { cache, asked, advance: (ms: number) => (clock += ms) };
}

describe("PhotoCache", () => {
  it("asks once for an aircraft however often it is looked at", async () => {
    const { cache, asked } = harness();
    expect(await cache.get("a1b2c3")).toEqual(PHOTO);
    expect(await cache.get("a1b2c3")).toEqual(PHOTO);
    expect(asked).toEqual(["https://api.planespotters.net/pub/photos/hex/a1b2c3"]);
  });

  it("shares one request between callers that ask at the same time", async () => {
    const { cache, asked } = harness();
    await Promise.all([cache.get("a1b2c3"), cache.get("A1B2C3")]);
    expect(asked).toHaveLength(1);
  });

  it("asks again after six hours, inside the terms' 24 hours", async () => {
    const { cache, asked, advance } = harness();
    await cache.get("a1b2c3");
    advance(5 * 3_600_000);
    await cache.get("a1b2c3");
    expect(asked).toHaveLength(1);
    advance(1.1 * 3_600_000);
    await cache.get("a1b2c3");
    expect(asked).toHaveLength(2);
  });

  it("remembers that an aircraft has no photo", async () => {
    const { cache, asked } = harness(async () => ({ photos: [] }));
    expect(await cache.get("a1b2c3")).toBeNull();
    expect(await cache.get("a1b2c3")).toBeNull();
    expect(asked).toHaveLength(1);
  });

  it("answers null at once, and asks nobody, for an address that is not a hex", async () => {
    const { cache, asked } = harness();
    expect(await cache.get("zzz")).toBeNull();
    expect(asked).toEqual([]);
  });

  it("treats a failed request as no photo, but tries again after five minutes rather than hammering", async () => {
    let fail = true;
    const { cache, asked, advance } = harness(async () => {
      if (fail) throw new Error("403");
      return HIT;
    });
    expect(await cache.get("a1b2c3")).toBeNull();
    advance(60_000);
    expect(await cache.get("a1b2c3")).toBeNull();
    expect(asked).toHaveLength(1);
    fail = false;
    advance(5 * 60_000);
    expect(await cache.get("a1b2c3")).toEqual(PHOTO);
    expect(asked).toHaveLength(2);
  });
});
