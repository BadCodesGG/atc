import { describe, expect, it } from "vitest";
import { shiftClearOfCard } from "./clear-of-card";

const wide = { width: 1440, height: 900 };
const wideCard = { left: 1108, top: 104, right: 1408, bottom: 374 };
const phone = { width: 390, height: 844 };
const phoneCard = { left: 16, top: 430, right: 374, bottom: 612 };

describe("shiftClearOfCard", () => {
  it("leaves an aircraft that is clear of the card where it is", () => {
    expect(shiftClearOfCard({ x: 600, y: 400 }, wide, wideCard)).toEqual([0, 0]);
    expect(shiftClearOfCard({ x: 200, y: 300 }, phone, phoneCard)).toEqual([0, 0]);
  });

  it("does nothing with no card to keep clear of", () => {
    expect(shiftClearOfCard({ x: 1300, y: 200 }, wide, null)).toEqual([0, 0]);
  });

  it("moves an aircraft under the wide screen's column out to the left of it, along the way it was nearest", () => {
    const [dx, dy] = shiftClearOfCard({ x: 1250, y: 200 }, wide, wideCard);
    expect(1250 + dx).toBeLessThanOrEqual(wideCard.left - 12 - 22);
    expect(dy).toBe(0);
  });

  it("moves an aircraft under a phone's sheet up above it, and one under the header down below it", () => {
    const [, dy] = shiftClearOfCard({ x: 200, y: 520 }, phone, phoneCard);
    expect(520 + dy).toBeLessThanOrEqual(phoneCard.top - 12 - 22);
    const [, up] = shiftClearOfCard({ x: 200, y: 60 }, phone, phoneCard);
    expect(60 + up).toBeGreaterThanOrEqual(190 + 22);
  });

  it("keeps an aircraft off the screen's edges", () => {
    const [dx] = shiftClearOfCard({ x: -50, y: 400 }, wide, wideCard);
    expect(-50 + dx).toBeGreaterThanOrEqual(24 + 22);
  });

  it("stays put-able when the free area is smaller than the ring", () => {
    const short = { width: 800, height: 494 };
    const card = { left: 16, top: 188, right: 784, bottom: 322 };
    const [dx, dy] = shiftClearOfCard({ x: 400, y: 213 }, short, card);
    expect(Number.isFinite(dx) && Number.isFinite(dy)).toBe(true);
    expect(213 + dy).toBeLessThan(card.top);
  });
});
