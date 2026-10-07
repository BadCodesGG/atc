import { useEffect, useState } from "react";
import { type AircraftPhoto, photos, photosEnabled } from "@/lib/aircraft-photo";

/** A reader sweeping through the flights does not ask Planespotters about each: only the one they stop on. */
const SETTLE_MS = 400;

/** The aircraft's photo, or null while there is none to show (not asked yet, none exists, the API refused). */
function usePhoto(hex: string): AircraftPhoto | null {
  const [photo, setPhoto] = useState<AircraftPhoto | null>(null);
  useEffect(() => {
    if (!photosEnabled(window.location.search)) return;
    let current = true;
    const timer = window.setTimeout(() => {
      void photos.get(hex).then((found) => {
        if (current) setPhoto(found);
      });
    }, SETTLE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [hex]);
  return photo;
}

/**
 * The flight card's photo, from Planespotters.net, on terms that fix its shape: the photographer's name
 * is text beside the picture, and the picture is a plain link to the photo's page. With no photo, or one
 * that will not load, nothing is drawn: no empty box. Keyed by the aircraft, so a new flight starts clean.
 */
export function CardPhoto({ hex }: { hex: string }) {
  const photo = usePhoto(hex);
  const [shown, setShown] = useState(false);
  if (!photo) return null;
  return (
    // Not displayed until the picture has loaded, so a broken one never leaves a box. Short of height it
    // shrinks and moves into the heading row, which has room beside the name, rather than going.
    <figure data-photo hidden={!shown} className="flex items-center gap-3 max-xl:short:absolute max-xl:short:right-[200px] max-xl:short:top-3.5 max-xl:short:max-w-[200px] max-xl:short:max-sm:hidden">
      <a href={photo.link} target="_blank" rel="noopener" className="shrink-0 overflow-hidden rounded-[10px] bg-well outline-offset-2">
        {/* The CDN's own URL, as given: the terms allow no proxy, rewrite or copy. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={photo.src}
          alt={`Photo of aircraft ${hex.toUpperCase()}`}
          width={photo.width}
          height={photo.height}
          decoding="async"
          onLoad={() => setShown(true)}
          onError={() => setShown(false)}
          className="block h-14 w-[84px] object-cover max-xl:short:h-10 max-xl:short:w-[60px] roomy:h-[75px] roomy:w-[112px]"
        />
      </a>
      <figcaption className="min-w-0 text-xs text-muted max-xl:short:text-[11px] max-xl:short:leading-tight">
        <span className="block truncate">Photo: {photo.photographer}</span>
        <a href={photo.link} target="_blank" rel="noopener" className="underline underline-offset-2">
          Planespotters.net
        </a>
      </figcaption>
    </figure>
  );
}
