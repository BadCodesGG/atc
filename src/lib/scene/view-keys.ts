/**
 * The keyboard's way to move the view, for readers who cannot drag: arrows slide the ground, plus and
 * minus zoom, Q and E (or shift with left and right) turn, shift with up and down tilts. The steps are
 * the view buttons' own, so a key press and a button press move the camera alike.
 */

/** A button's zoom: below 1 moves in. */
export const ZOOM_STEP = 0.7;
/** A button's turn, degrees. */
export const TURN_STEP = 30;
/** A tilt from the keyboard, degrees. */
export const TILT_STEP = 10;

export type ViewKey =
  /** In steps of the pan distance: forward along the bearing the camera looks, right across it. */
  | { kind: "pan"; forward: number; right: number }
  | { kind: "zoom"; factor: number }
  | { kind: "turn"; deg: number; tilt: number };

type KeyPress = Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "altKey" | "metaKey">;

/** What a key press does to the view, or null for a key it leaves to the page (the browser's own zoom included). */
export function viewKey(e: KeyPress): ViewKey | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  switch (e.key) {
    case "ArrowUp":
      return e.shiftKey ? { kind: "turn", deg: 0, tilt: TILT_STEP } : { kind: "pan", forward: 1, right: 0 };
    case "ArrowDown":
      return e.shiftKey ? { kind: "turn", deg: 0, tilt: -TILT_STEP } : { kind: "pan", forward: -1, right: 0 };
    case "ArrowLeft":
      return e.shiftKey ? { kind: "turn", deg: -TURN_STEP, tilt: 0 } : { kind: "pan", forward: 0, right: -1 };
    case "ArrowRight":
      return e.shiftKey ? { kind: "turn", deg: TURN_STEP, tilt: 0 } : { kind: "pan", forward: 0, right: 1 };
    case "+":
    case "=":
      return { kind: "zoom", factor: ZOOM_STEP };
    case "-":
    case "_":
      return { kind: "zoom", factor: 1 / ZOOM_STEP };
    case "q":
    case "Q":
      return { kind: "turn", deg: -TURN_STEP, tilt: 0 };
    case "e":
    case "E":
      return { kind: "turn", deg: TURN_STEP, tilt: 0 };
    default:
      return null;
  }
}
