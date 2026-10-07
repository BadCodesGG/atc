import { useEffect, useId, useRef, useState } from "react";
import { RING } from "./shadows";
import { usePopover } from "./use-popover";

/**
 * The share button at the end of the time bar: it makes a link to the view as it is (the page builds it,
 * see lib/share-link.ts), copies it with the Clipboard API, and shows it in a field either way. Where the
 * API is missing or refuses (an insecure origin, a denied permission), the field is selected and the
 * panel says to copy it by hand, so the link is never out of reach.
 */

const ICON = (
  <svg aria-hidden viewBox="0 0 16 16" className="size-4">
    <path d="M8 10V2.5M5 5l3-3 3 3M3.5 8.5v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type Copy = "copied" | "manual";

interface ShareControlProps {
  /** The link to the view as it is now, made when the button is pressed. */
  getLink: () => string;
  /** Replaying: the replay's time is not in the link, and the panel says so. */
  replaying: boolean;
}

export function ShareControl({ getLink, replaying }: ShareControlProps) {
  const { open, setOpen, buttonRef, rootProps } = usePopover();
  const panelId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState("");
  const [copy, setCopy] = useState<Copy | null>(null);

  const copyLink = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopy("copied");
    } catch {
      setCopy("manual");
    }
  };

  // Shown selected, so a press of Ctrl+C (or a long press) takes it where the Clipboard API would not.
  useEffect(() => {
    if (open) field.current?.select();
  }, [open, link, copy]);

  const press = () => {
    if (open) return setOpen(false);
    const made = getLink();
    setLink(made);
    setCopy(null);
    setOpen(true);
    void copyLink(made);
  };

  return (
    <div {...rootProps} className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-label="Share this view"
        title="Copy a link to this view"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={press}
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[10px] text-ink-2 xl:min-h-10 xl:min-w-10 outline-none hover:bg-well focus-visible:shadow-[0_0_0_2px_var(--color-ink)]"
      >
        {ICON}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Share this view"
          className="popover-panel absolute bottom-full right-0 mb-3 flex w-[min(340px,calc(100vw-2rem))] flex-col gap-2.5 rounded-2xl bg-surface p-4 shadow-[0_8px_24px_rgba(20,20,20,0.08),0_0_0_1px_var(--color-hairline)]"
        >
          <h2 className="text-base font-bold tracking-[-0.01em]">Share this view</h2>
          <p aria-live="polite" data-share-state={copy ?? "making"} className="text-[13px] text-ink-2">
            {copy === "copied" ? "Link copied. It opens this airport, flight, camera, style and filters." : copy === "manual" ? "Copy the link below: this browser would not let the page do it." : "Copying the link..."}
          </p>
          <div className="flex gap-2">
            <label htmlFor={`${panelId}-link`} className="sr-only">
              Link to this view
            </label>
            <input
              ref={field}
              id={`${panelId}-link`}
              readOnly
              value={link}
              onFocus={(e) => e.currentTarget.select()}
              className={`h-11 min-w-0 flex-1 rounded-xl bg-well px-3 text-[13px] text-ink outline-none focus-visible:shadow-[0_0_0_2px_var(--color-ink)] xl:h-10 ${RING}`}
            />
            <button type="button" onClick={() => void copyLink(link)} className="min-h-11 shrink-0 rounded-full bg-accent px-4 text-xs font-semibold text-on-accent xl:min-h-10">
              Copy
            </button>
          </div>
          {replaying && (
            <p data-share-replay className="text-xs text-muted">
              Replay time can&apos;t be shared: the link opens live.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
