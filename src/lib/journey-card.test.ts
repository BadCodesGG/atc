import { describe, expect, it } from "vitest";
import type { FlightCard } from "./traffic-view";
import { arrivedCard, selectedOf } from "./journey-card";

const entry = (id: string) => ({ aircraft: { id } });
const [a, b, c] = [entry("aaaaaa"), entry("bbbbbb"), entry("cccccc")];
const card: FlightCard = { id: "aaaaaa", callsign: "DAL1947", operator: "Delta · Airbus A321", state: "taxiing", headline: "Taxiing", tag: "Taxiing · 4 kt", speed: "4 kt", heading: "180°", altitude: "Ground", route: null, direction: "inbound", gate: null };

describe("selectedOf", () => {
  it("is what the reader picked, else the featured flight, with no journey", () => {
    expect(selectedOf({ entries: [a, b], picked: "bbbbbb", featured: a, journey: null, held: null })).toBe(b);
    expect(selectedOf({ entries: [a, b], picked: "dddddd", featured: a, journey: null, held: null })).toBe(a);
    expect(selectedOf({ entries: [a, b], picked: null, featured: a, journey: null, held: null })).toBe(a);
    expect(selectedOf({ entries: [], picked: null, featured: null, journey: null, held: null })).toBeNull();
  });

  it("is the followed flight whenever a journey is on and the diorama has it, whatever was picked before", () => {
    expect(selectedOf({ entries: [a, b, c], picked: "bbbbbb", featured: c, journey: { hex: "aaaaaa" }, held: null })).toBe(a);
  });

  it("is never another flight while a journey's own has not reached this diorama's feed: a destination already on show opens on its featured flight otherwise", () => {
    // Nothing picked here (the page has shown this airport since before the journey began), the flight not yet in this feed.
    expect(selectedOf({ entries: [b, c], picked: null, featured: c, journey: { hex: "aaaaaa" }, held: null })).toBeNull();
    expect(selectedOf({ entries: [b, c], picked: "bbbbbb", featured: c, journey: { hex: "aaaaaa" }, held: null })).toBeNull();
  });

  it("is the flight as it was last drawn while a gap in the feed has lost it, so its card stays", () => {
    expect(selectedOf({ entries: [b, c], picked: "aaaaaa", featured: c, journey: { hex: "aaaaaa" }, held: a })).toBe(a);
    // A flight held from an earlier journey is not this one's.
    expect(selectedOf({ entries: [b, c], picked: "aaaaaa", featured: c, journey: { hex: "aaaaaa" }, held: b })).toBeNull();
    // Nor does a held flight outlast its journey.
    expect(selectedOf({ entries: [b, c], picked: "aaaaaa", featured: c, journey: null, held: a })).toBe(c);
  });
});

describe("arrivedCard", () => {
  it("shows a flight that went quiet by a gate as parked there, standing still, whatever it last said", () => {
    expect(arrivedCard(card, { place: { kind: "gate", ref: "B12" }, quiet: true })).toEqual({ ...card, state: "parked", headline: "At gate B12", tag: "At gate B12", speed: "0 kt", gate: { kind: "gate", ref: "B12", left: false } });
  });

  it("names no gate when the map names none", () => {
    expect(arrivedCard(card, { place: null, quiet: true })).toMatchObject({ state: "parked", headline: "Parked", tag: "Parked", speed: "0 kt", gate: null });
  });
});
