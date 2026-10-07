import { useEffect, useId, useRef, useState } from "react";
import { alertsMessage } from "@/lib/notify";
import type { AlertsControl } from "./use-alerts";
import { RAISED } from "./shadows";

const BELL = (
  <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0">
    <path d="M4 11.5h8l-1-1.6V7a3 3 0 0 0-6 0v2.9L4 11.5ZM6.6 13.3a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** What the button is called, state included, for a screen reader and for the tooltip. */
const NAME: Record<AlertsControl["state"], string> = {
  on: "Alerts, on",
  off: "Alerts, off",
  blocked: "Alerts, blocked in this browser",
  unsupported: "Alerts, not supported in this browser",
};

/**
 * The alerts control, in the header beside the airport picker: a bell that opens a short panel saying
 * what the alerts are and whether they are on, with the one button that turns them on or off (and so the
 * only place the browser is asked for permission). Where the browser blocks or lacks notifications, the
 * panel says so and offers nothing to press.
 */
export function AlertsMenu({ alerts }: { alerts: AlertsControl }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { state } = alerts;
  const usable = state === "on" || state === "off";

  // Escape or a click elsewhere closes it, as the airport picker's list does.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  return (
    <div ref={root} data-alerts={state} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={NAME[state]}
        title={NAME[state]}
        onClick={() => setOpen((was) => !was)}
        className={`relative flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full text-sm font-semibold xl:min-h-9 xl:min-w-9 min-[1500px]:px-3.5 ${RAISED} ${state === "on" ? "bg-accent text-on-accent" : usable ? "bg-surface text-ink-2" : "bg-surface text-muted"}`}
      >
        {BELL}
        {/* The label only where the header has the room: at 1280 it would run into the search box. */}
        <span className="max-[1500px]:hidden" aria-hidden>
          {usable ? "Alerts" : "Alerts unavailable"}
        </span>
      </button>
      {open && (
        <div id={panelId} role="group" aria-label="Alerts" className={`popover-panel absolute right-0 top-full z-30 mt-2 flex w-[min(320px,calc(100vw-32px))] flex-col gap-3 rounded-2xl bg-surface p-4 text-[13px] leading-[1.45] text-ink-2 xl:left-0 xl:right-auto ${RAISED}`}>
          <p data-alerts-message aria-live="polite">
            {alertsMessage(state)}
          </p>
          {usable && (
            <button
              type="button"
              onClick={alerts.toggle}
              className={`min-h-11 rounded-[10px] px-4 text-[15px] font-semibold ${state === "on" ? "bg-well text-ink" : "bg-accent text-on-accent"}`}
            >
              {state === "on" ? "Turn off alerts" : "Turn on alerts"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
