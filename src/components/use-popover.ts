import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";

/**
 * What a small popover over the page needs: open or not, closed by a press outside it, by focus
 * leaving it, and by Escape (which hands the focus back to its button). The caller spreads `rootProps`
 * on the element holding both the button and the panel.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const rootProps = {
    ref: rootRef,
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Escape" || !open) return;
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    },
  };

  return { open, setOpen, buttonRef, rootProps };
}
