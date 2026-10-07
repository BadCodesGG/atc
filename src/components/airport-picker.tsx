import { type CSSProperties, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupAirports, matchAirports, placeOf } from "@/lib/airport-search";
import { type Airport, AIRPORTS } from "@/lib/airports";
import { RAISED, RING } from "./shadows";

/** Width of the popover on a wide screen, px; it sits under the button and is kept inside the window. */
const POPOVER_WIDTH = 380;
const EDGE = 16;

interface Anchor {
  left: number;
  top: number;
  /** Where the popup is mounted: the page's own root, so it carries the theme's colours. */
  root: HTMLElement;
}

/**
 * The airport switch: a button showing the current code that opens a search box over a list of airports
 * grouped by state. A full-width sheet from the top on phones (so the on-screen keyboard never covers
 * it), a popover under the button on wide screens. The popup is rendered in the page's root rather than
 * beside the button, because the satellite theme's blurred title panel would otherwise become the
 * containing block of its fixed positioning.
 */
export function AirportPicker({ airport, onPick, focusOnMount }: { airport: Airport; onPick: (code: Airport["code"]) => void; focusOnMount: boolean }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    if (focusOnMount) buttonRef.current?.focus();
  }, [focusOnMount]);

  const open = () => {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    setAnchor({
      left: Math.max(EDGE, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - EDGE)),
      top: rect.bottom + 8,
      root: button.closest("main") ?? document.body,
    });
  };
  const close = () => {
    setAnchor(null);
    buttonRef.current?.focus();
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={anchor !== null}
        aria-label={`${airport.code.toUpperCase()}, change airport`}
        onClick={() => (anchor ? close() : open())}
        className={`flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-surface px-4 text-sm font-semibold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink xl:min-h-9 ${RAISED}`}
      >
        {airport.code.toUpperCase()}
        <svg aria-hidden viewBox="0 0 10 10" className={`size-2.5 transition-transform ${anchor ? "rotate-180" : ""}`}>
          <path d="M1.5 3.5 5 7l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {anchor &&
        createPortal(
          <>
            {/* Above the title (z-40), the search and the filter (z-30) and the radar toggle (z-45), which all sit in the page and would otherwise draw over the list. */}
            <div aria-hidden onClick={close} className="fixed inset-0 z-50 bg-ink/30 xl:bg-transparent" />
            <AirportSearch
              current={airport}
              anchor={anchor}
              onClose={close}
              onPick={(next) => {
                if (next.code === airport.code) return close();
                setAnchor(null);
                onPick(next.code);
              }}
            />
          </>,
          anchor.root,
        )}
    </>
  );
}

/** The search box and its listbox: the ARIA combobox pattern, with the focus staying in the input and `aria-activedescendant` naming the highlighted option. */
function AirportSearch({ current, anchor, onClose, onPick }: { current: Airport; anchor: Anchor; onClose: () => void; onPick: (airport: Airport) => void }) {
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (code: string) => `${id}-option-${code}`;
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupAirports(matchAirports(AIRPORTS, query)), [query]);
  const flat = useMemo(() => groups.flatMap((group) => group.airports), [groups]);
  // Opens on the airport being shown, so a reader who wants a neighbour in the list starts there.
  const [active, setActive] = useState(() => Math.max(0, flat.findIndex((a) => a.code === current.code)));
  const activeAirport = flat[active] ?? null;
  const position = new Map(flat.map((a, i) => [a.code, i]));

  useEffect(() => {
    if (activeAirport) document.getElementById(`${id}-option-${activeAirport.code}`)?.scrollIntoView({ block: "nearest" });
  }, [id, activeAirport]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeAirport) onPick(activeAirport);
    } else if (e.key === "Escape" || e.key === "Tab") {
      // Tab leaves for the button rather than into the page behind the popup.
      e.preventDefault();
      onClose();
    }
  };

  const shown = query.trim();
  return (
    <div
      onKeyDown={onKeyDown}
      style={{ "--pop-left": `${anchor.left}px`, "--pop-top": `${anchor.top}px` } as CSSProperties}
      className="popover-panel fixed inset-x-0 top-0 z-50 sm:mx-auto sm:max-w-xl flex max-h-[85dvh] flex-col gap-2 rounded-b-2xl bg-surface p-3 shadow-[0_8px_24px_rgba(20,20,20,0.08),0_0_0_1px_var(--color-hairline)] xl:inset-x-auto xl:left-(--pop-left) xl:top-(--pop-top) xl:max-h-[min(560px,calc(100dvh-var(--pop-top)-16px))] xl:w-[380px] xl:rounded-2xl xl:p-2"
    >
      <label htmlFor={`${id}-input`} className="sr-only">
        Search airports by code, city, state or name
      </label>
      <input
        id={`${id}-input`}
        autoFocus
        type="text"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeAirport ? optionId(activeAirport.code) : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="go"
        placeholder="Search code, city, state or airport"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        className={`h-11 w-full shrink-0 rounded-xl bg-well px-[18px] text-[15px] text-ink outline-none placeholder:text-muted focus-visible:shadow-[0_0_0_2px_var(--color-ink)] ${RING}`}
      />
      <p role="status" className={flat.length ? "sr-only" : "px-3 py-6 text-center text-[15px] text-muted [overflow-wrap:anywhere]"}>
        {flat.length ? `${flat.length} ${flat.length === 1 ? "airport" : "airports"}` : `No airport matches “${shown}”`}
      </p>
      <ul id={listId} role="listbox" aria-label="Airports" className={`${flat.length ? "" : "hidden"} min-h-0 flex-1 overflow-y-auto overscroll-contain`}>
        {groups.map((group) => {
          const headingId = `${id}-group-${group.country}-${group.state}`;
          return (
            <li key={headingId} role="presentation">
              <div id={headingId} role="presentation" className="sticky top-0 bg-surface px-3 py-1.5 text-[13px] font-semibold tracking-[0.04em] text-muted">
                {group.name}
              </div>
              <ul role="group" aria-labelledby={headingId}>
                {group.airports.map((airport) => {
                  const i = position.get(airport.code)!;
                  const here = airport.code === current.code;
                  return (
                    <li
                      key={airport.code}
                      id={optionId(airport.code)}
                      role="option"
                      aria-selected={i === active}
                      // Keeps the focus in the input, which a click on a row would otherwise take.
                      onMouseDown={(e) => e.preventDefault()}
                      onMouseMove={() => setActive(i)}
                      onClick={() => onPick(airport)}
                      className={`flex min-h-11 scroll-mt-8 cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 xl:min-h-10 ${i === active ? "bg-selected shadow-[inset_0_0_0_1px_var(--color-selected-ring)]" : ""}`}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="flex items-baseline gap-3 text-[15px] text-ink">
                          <span className="w-9 shrink-0 font-bold tabular-nums">{airport.code.toUpperCase()}</span>
                          <span className="truncate">{placeOf(airport)}</span>
                        </span>
                        <span className="truncate pl-12 text-xs text-muted">{airport.name}</span>
                      </span>
                      {here && (
                        <>
                          <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0 text-ink">
                            <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                          <span className="sr-only">current airport</span>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
