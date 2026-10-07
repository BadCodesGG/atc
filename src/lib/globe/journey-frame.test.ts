import { describe, expect, it } from "vitest";
import { freeBand, frameShift } from "./journey-frame";

const phone = { width: 390, height: 844 };
const card = { left: 16, right: 374, top: 133, bottom: 335 };
// The map style switch, the view buttons and the time bar, as a phone stacks them at the foot.
const foot = [
  { left: 166, right: 374, top: 660, bottom: 708 },
  { left: 16, right: 148, top: 720, bottom: 768 },
  { left: 16, right: 208, top: 780, bottom: 828 },
];

describe("freeBand", () => {
  it("is the strip between the card's foot and the highest control, with air at each", () => {
    expect(freeBand(phone, card, foot)).toEqual({ left: 16, right: 374, top: 347, bottom: 648 });
  });

  it("runs from the edge of the screen with no card, and to the foot with no controls", () => {
    expect(freeBand(phone, null, foot).top).toBe(16);
    expect(freeBand(phone, card, []).bottom).toBe(828);
  });

  it("ignores a control above the card's foot, such as the header's", () => {
    expect(freeBand(phone, card, [{ left: 16, right: 100, top: 20, bottom: 60 }, ...foot]).bottom).toBe(648);
  });

  it("keeps a usable height when the controls come close to the card", () => {
    const squeezed = freeBand(phone, card, [{ left: 16, right: 374, top: 360, bottom: 400 }]);
    expect(squeezed.bottom - squeezed.top).toBe(120);
  });
});

describe("frameShift", () => {
  const band = { left: 16, right: 374, top: 347, bottom: 648 };

  it("leaves points already inside the band, with the room for their marks, where they are", () => {
    expect(frameShift([{ x: 200, y: 400 }, { x: 250, y: 600 }], band)).toEqual({ scale: 1, dx: 0, dy: 0 });
  });

  it("moves them the shortest way in when they are under the card or past the controls", () => {
    // Two points 100 px apart, the upper under the card: the whole pair moves down by what puts it 22 px inside the top.
    expect(frameShift([{ x: 200, y: 300 }, { x: 230, y: 400 }], band)).toEqual({ scale: 1, dx: 0, dy: 347 + 22 - 300 });
    expect(frameShift([{ x: 200, y: 600 }, { x: 230, y: 700 }], band)).toEqual({ scale: 1, dx: 0, dy: 648 - 22 - 700 });
    expect(frameShift([{ x: 10, y: 450 }, { x: 40, y: 500 }], band)).toEqual({ scale: 1, dx: 16 + 22 - 10, dy: 0 });
  });

  it("shrinks them to fit when they are farther apart than the band is deep, and centres them in what is left", () => {
    // 600 px apart in a band 257 px deep once the marks have room: a scale of 257 / 600.
    const { scale, dy } = frameShift([{ x: 200, y: 100 }, { x: 220, y: 700 }], band);
    expect(scale).toBeCloseTo(257 / 600, 6);
    // Scaled about their middle (y 400), the pair spans 271.5 to 528.5; the inner band is 369 to 626.
    expect(dy).toBeCloseTo(369 - (400 - (257 / 2)), 6);
  });

  it("never asks to magnify", () => {
    expect(frameShift([{ x: 200, y: 450 }, { x: 201, y: 452 }], band).scale).toBe(1);
  });
});
