import type { JourneyArrival } from "./journey-follow";
import type { FlightCard } from "./traffic-view";

/**
 * Which flight the diorama's card is of. While a journey is on, the card is the followed flight's from the
 * journey's first frame to its last, in whichever diorama shows it: the reader's pick is a tracker of what
 * was last clicked in this diorama, and a diorama on show before the journey began (a flight followed from
 * the map into the airport the page was already showing) was never told of the flight, so it would show its
 * featured one until the flight reached its own feed. A journey's flight missing from the feed (the feeds
 * drop an aircraft whose position is a minute old) keeps its card as it was last drawn, `held`, and never
 * gives way to another flight's.
 */
export function selectedOf<T extends { aircraft: { id: string } }>({
  entries,
  picked,
  featured,
  journey,
  held,
}: {
  entries: readonly T[];
  picked: string | null;
  featured: T | null;
  journey: { hex: string } | null;
  /** The journey's flight as it was last drawn by this diorama, if it ever was. */
  held: T | null;
}): T | null {
  const id = journey ? journey.hex : picked;
  const entry = id === null ? undefined : entries.find((e) => e.aircraft.id === id);
  if (entry) return entry;
  if (!journey) return featured;
  return held && held.aircraft.id === journey.hex ? held : null;
}

/** The card of a flight that went quiet by its stand: parked there and standing still, as an aircraft read parked would show. */
export function arrivedCard(card: FlightCard, { place }: JourneyArrival): FlightCard {
  const where = place ? `At ${place.kind} ${place.ref}` : "Parked";
  return { ...card, state: "parked", headline: where, tag: where, speed: "0 kt", gate: place && { ...place, left: false } };
}
