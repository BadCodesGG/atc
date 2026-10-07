import { readHex } from "./hex";

/**
 * An aircraft's photo, from Planespotters.net's free photo API (https://www.planespotters.net/photo/api).
 * Its terms shape everything here:
 *
 * - The browser asks the API itself, and shows the image straight from the CDN URL it is given. There
 *   is no route of ours in between: the terms forbid proxying, rewriting and re-exposing the API's data,
 *   and an image written to storage or passed on to another client.
 * - Each photo shows the photographer's name as text beside it, and the picture links to the photo's
 *   page (the API's `link`, unchanged, without `nofollow`).
 * - The JSON may be cached for up to 24 hours; it is kept in memory for six.
 * - Use stays within reasonable limits: one request per aircraft looked at, none for a fixture.
 */

const ENDPOINT = "https://api.planespotters.net/pub/photos/hex";
/** How long an answer is kept, ms: a quarter of the 24 hours the terms allow. */
const KEEP_MS = 6 * 3_600_000;
/** How long a failed request is remembered, ms, so a refusing API is not asked again at once. */
const RETRY_MS = 5 * 60_000;

export interface AircraftPhoto {
  /** The image, from Planespotters' CDN: used unchanged. */
  src: string;
  width: number;
  height: number;
  /** The photo's page on Planespotters.net, which the picture links to: used unchanged. */
  link: string;
  photographer: string;
}

/** The API's URL for the aircraft with this hex, or null when it is not one (nothing else reaches a URL). */
export function photoEndpoint(hex: string): string | null {
  const clean = readHex(hex);
  return clean ? `${ENDPOINT}/${clean}` : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The URL when it is https on exactly this host (or a subdomain of the registered one), else null. */
function onHost(value: unknown, allowed: (host: string) => boolean): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && allowed(url.hostname) ? value : null;
  } catch {
    return null;
  }
}

const within = (domain: string) => (host: string) => host === domain || host.endsWith(`.${domain}`);
/** The photo's page is on planespotters.net; the images come from its CDN, t.plnspttrs.net (as the API answered on 2026-10-01). */
const isPage = within("planespotters.net");
const isImage = (host: string) => isPage(host) || within("plnspttrs.net")(host);

/**
 * The first photo of an API answer, or null when there is none or it cannot be shown as the terms
 * require: a photographer to credit, and an image and a page on Planespotters' own hosts over https.
 */
export function parsePhoto(json: unknown): AircraftPhoto | null {
  if (!isRecord(json) || !Array.isArray(json.photos)) return null;
  const photo: unknown = json.photos[0];
  if (!isRecord(photo)) return null;
  const photographer = typeof photo.photographer === "string" ? photo.photographer.trim() : "";
  const link = onHost(photo.link, isPage);
  if (!photographer || !link) return null;
  const image = [photo.thumbnail_large, photo.thumbnail].find((t) => isRecord(t) && onHost(t.src, isImage));
  if (!isRecord(image)) return null;
  const size = isRecord(image.size) ? image.size : {};
  const width = typeof size.width === "number" && size.width > 0 ? size.width : 0;
  const height = typeof size.height === "number" && size.height > 0 ? size.height : 0;
  if (!width || !height) return null;
  return { src: image.src as string, width, height, link, photographer };
}

/**
 * Whether the page asks Planespotters at all: always, except on a fixture, whose checks must not depend
 * on a third party's answer (`&photos=1` brings them back, for looking at the card with one).
 */
export function photosEnabled(search: string): boolean {
  const params = new URLSearchParams(search);
  return !params.has("fixture") || params.has("photos");
}

interface Entry {
  photo: Promise<AircraftPhoto | null>;
  /** The clock time after which it is asked again. */
  until: number;
}

/** What the API was asked: the answer's JSON, or a throw for anything but a 200 with JSON. */
export type PhotoFetch = (url: string) => Promise<unknown>;

/** The photos asked for so far, by hex: one request each, kept for six hours, a failure for five minutes. */
export class PhotoCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly fetchJson: PhotoFetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** The aircraft's photo, or null when it has none, the API refused, or `hex` is not an address. */
  get(hex: string): Promise<AircraftPhoto | null> {
    const clean = readHex(hex);
    const url = photoEndpoint(hex);
    if (!clean || !url) return Promise.resolve(null);
    const have = this.entries.get(clean);
    if (have && have.until > this.now()) return have.photo;
    const entry: Entry = {
      photo: Promise.resolve().then(() => this.fetchJson(url)).then(parsePhoto),
      until: this.now() + KEEP_MS,
    };
    // A refusal or an outage reads as no photo, and is asked again soon rather than kept for hours.
    entry.photo = entry.photo.catch(() => {
      entry.until = this.now() + RETRY_MS;
      return null;
    });
    this.entries.set(clean, entry);
    return entry.photo;
  }
}

/** The page's own cache, asking the API from the browser (the terms need the request to carry the page's Origin). */
export const photos = new PhotoCache(async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`photo API ${res.status}`);
  return res.json();
});
