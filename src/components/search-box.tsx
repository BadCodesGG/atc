import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Airport } from "@/lib/airports";
import type { FlightAnswer } from "@/lib/flight-lookup";
import { type AirportHit, type FlightHit, type PlaceDoc, type PlaceHit, type RemoteSummary, remoteSummary, search, type SearchData } from "@/lib/search";
import { STATE_INK, STATE_LABEL, STATE_SWATCH } from "./chrome";
import { RAISED } from "./shadows";

/**
 * The header's search box: a combobox over a listbox of ranked results, grouped under headings. The
 * ranking is `lib/search.ts`; this file is the keyboard, the debounce, the flight-anywhere lookup and
 * the layout. "/" focuses it from anywhere outside an input.
 */

/** How long typing pauses before the results are worked out, and before a flight elsewhere is asked for. */
const DEBOUNCE_MS = 120;
const REMOTE_MS = 350;

export interface SearchProps {
  /** What can be found right now; null until the airport has loaded. Must be stable between renders. */
  read: () => SearchData | null;
  /** Select a flight on screen, and follow it when asked. */
  onFlight: (id: string, follow: boolean) => void;
  /** Ease the camera to a gate, stand or runway and light it. */
  onPlace: (place: PlaceDoc) => void;
  /** Switch to another airport. */
  onAirport: (code: Airport["code"]) => void;
  /** Open the airport a flight elsewhere is near and select the flight there. */
  onRemote: (callsign: string, airport: Airport["code"]) => void;
}

type Remote = "none" | "error" | { flight: FlightAnswer };

type Option =
  | { id: string; kind: "flight"; hit: FlightHit }
  | { id: string; kind: "place"; hit: PlaceHit }
  | { id: string; kind: "airport"; hit: AirportHit }
  | { id: string; kind: "remote"; callsign: string; summary: RemoteSummary };

interface Section {
  key: string;
  heading: string;
  options: Option[];
}

const PLACE_TAG = { gate: "Gate", stand: "Stand", runway: "Runway" } as const;

function isFlightAnswer(v: unknown): v is FlightAnswer {
  const f = v as Partial<FlightAnswer> | null;
  return typeof f === "object" && f !== null && typeof f.latitude === "number" && typeof f.longitude === "number" && typeof f.altitudeFt === "number";
}

/** Whether a "/" press belongs to a field the reader is typing in. */
function typing(target: EventTarget | null): boolean {
  const el = target instanceof HTMLElement ? target : null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function Search({ read, onFlight, onPlace, onAirport, onRemote }: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  /** Bumped on focus, so results are worked out again from what is in the sky now. */
  const [stamp, setStamp] = useState(0);
  const [cursor, setCursor] = useState({ query: "", index: 0 });
  const [remote, setRemote] = useState<{ key: string; outcome: Remote } | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), query ? DEBOUNCE_MS : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  // "/" from anywhere outside a field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const data = useMemo(() => {
    void stamp;
    return read();
  }, [read, stamp]);
  const results = useMemo(() => (data ? search(debounced, data) : { groups: [], remote: null }), [data, debounced]);
  const here = data?.here ?? "";

  // A flight elsewhere: asked for once typing settles, and only for a callsign the search has validated.
  const wanted = results.remote;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      let outcome: Remote = "error";
      try {
        const res = await fetch(`/api/flight/${encodeURIComponent(wanted)}`, { signal: controller.signal });
        if (res.status === 404) outcome = "none";
        else if (res.ok) {
          const body: unknown = await res.json();
          if (isFlightAnswer(body)) outcome = { flight: body };
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      setRemote({ key: wanted, outcome });
    }, REMOTE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [wanted]);
  const remoteOutcome = wanted && remote?.key === wanted ? remote.outcome : null;

  const sections = useMemo(() => {
    const out: Section[] = [];
    let n = 0;
    const id = () => `atc-search-opt-${n++}`;
    for (const g of results.groups) {
      out.push({
        key: g.kind,
        heading: g.heading,
        options: g.hits.map((hit): Option => (hit.kind === "flight" ? { id: id(), kind: "flight", hit } : hit.kind === "place" ? { id: id(), kind: "place", hit } : { id: id(), kind: "airport", hit })),
      });
    }
    if (wanted && remoteOutcome && remoteOutcome !== "none" && remoteOutcome !== "error" && here) {
      out.push({ key: "remote", heading: "Flight elsewhere", options: [{ id: id(), kind: "remote", callsign: wanted, summary: remoteSummary(remoteOutcome.flight, here) }] });
    }
    return out;
  }, [results, wanted, remoteOutcome, here]);
  const options = useMemo(() => sections.flatMap((s) => s.options), [sections]);

  const index = cursor.query === debounced ? Math.min(cursor.index, options.length - 1) : 0;
  const active = options[index];
  useEffect(() => {
    if (open && active) listRef.current?.querySelector(`#${active.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const show = open && debounced.trim() !== "";
  const finish = () => {
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };
  const choose = (option: Option, follow: boolean) => {
    if (option.kind === "remote") {
      if (!option.summary.openable) return;
      onRemote(option.callsign, option.summary.nearest);
    } else if (option.kind === "flight") onFlight(option.hit.id, follow);
    else if (option.kind === "place") onPlace(option.hit.place);
    else onAirport(option.hit.code);
    finish();
  };
  const move = (step: number) => {
    if (!options.length) return;
    setCursor({ query: debounced, index: (index + step + options.length) % options.length });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!show) setOpen(true);
      else move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && show && active) {
      e.preventDefault();
      choose(active, e.shiftKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (show) setOpen(false);
      else setQuery("");
    }
  };

  const message = !show
    ? ""
    : options.length
      ? `${options.length} ${options.length === 1 ? "result" : "results"}`
      : wanted
        ? remoteOutcome === "none"
          ? `${wanted} is not airborne right now.`
          : remoteOutcome === "error"
            ? `Could not look up ${wanted}. Try again in a moment.`
            : `Looking for ${wanted}...`
        : `No match${here ? ` at ${here.toUpperCase()}` : ""} for "${debounced.trim()}". Try a callsign, airline, gate or airport.`;

  return (
    <div
      className="absolute left-4 right-[68px] top-[76px] z-30 xl:inset-x-auto xl:left-1/2 xl:top-7 xl:w-[420px] xl:-translate-x-1/2"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor="atc-search" className="sr-only">
        Search flights, gates and airports
      </label>
      <input
        ref={inputRef}
        id="atc-search"
        type="search"
        role="combobox"
        aria-expanded={show}
        aria-controls="atc-search-list"
        aria-autocomplete="list"
        aria-activedescendant={show ? active?.id : undefined}
        aria-describedby="atc-search-help"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder="Search flights, airlines, gates"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setStamp((s) => s + 1);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        className={`peer h-11 w-full appearance-none rounded-xl bg-surface px-3.5 text-sm xl:px-[18px] xl:text-[15px] text-ink text-ellipsis outline-none placeholder:text-muted focus-visible:shadow-[0_0_0_2px_var(--color-ink)] [&::-webkit-search-cancel-button]:appearance-none xl:pr-11 ${RAISED}`}
      />
      <kbd
        aria-hidden
        className="pointer-events-none absolute right-3.5 top-1/2 hidden h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-md px-1.5 font-sans text-xs font-semibold text-muted shadow-[0_0_0_1px_var(--color-hairline)] xl:flex peer-focus:hidden peer-[:not(:placeholder-shown)]:hidden"
      >
        /
      </kbd>
      <p id="atc-search-help" className="sr-only">
        Type to search. Arrow keys move through the results, Enter picks one, Shift with Enter picks a flight and follows it, Escape closes the list. Press slash to search from anywhere.
      </p>
      <div role="status" className="sr-only">
        {message}
      </div>
      {show && (
        <div className="popover-panel absolute left-0 -right-[52px] top-full mt-2 flex max-h-[calc(100dvh-160px)] xl:right-0 flex-col overflow-hidden rounded-2xl bg-surface shadow-[0_8px_24px_rgba(20,20,20,0.08),0_0_0_1px_var(--color-hairline)] xl:max-h-[min(30rem,calc(100dvh-112px))]">
          <div ref={listRef} id="atc-search-list" role="listbox" aria-label="Search results" className={`min-h-0 overflow-y-auto p-1.5 ${options.length ? "" : "hidden"}`}>
            {sections.map((section) => (
              <div key={section.key} role="group" aria-labelledby={`atc-search-${section.key}`}>
                <div id={`atc-search-${section.key}`} role="presentation" className="px-3 pb-1 pt-2 text-xs font-semibold tracking-[0.04em] text-muted">
                  {section.heading}
                </div>
                {section.options.map((option) => (
                  <OptionRow
                    key={option.id}
                    option={option}
                    active={option.id === active?.id}
                    onHover={() => setCursor({ query: debounced, index: options.indexOf(option) })}
                    onChoose={(follow) => choose(option, follow)}
                  />
                ))}
              </div>
            ))}
          </div>
          {message && !options.length && (
            <p aria-hidden className="px-4 py-3.5 text-sm text-ink-2">
              {message}
            </p>
          )}
          {options.some((o) => o.kind === "flight") && (
            <p aria-hidden className="hidden shrink-0 border-t border-hairline px-4 py-2 text-xs text-muted xl:block">
              Enter selects a flight. Shift+Enter follows it.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function OptionRow({ option, active, onHover, onChoose }: { option: Option; active: boolean; onHover: () => void; onChoose: (follow: boolean) => void }) {
  const disabled = option.kind === "remote" && !option.summary.openable;
  return (
    <div
      id={option.id}
      role="option"
      aria-selected={active}
      aria-disabled={disabled || undefined}
      // Keep focus in the input, so choosing never closes the list by blurring it first.
      onMouseDown={(e) => e.preventDefault()}
      onPointerMove={onHover}
      onClick={() => onChoose(false)}
      className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5 text-left ${active ? "bg-selected shadow-[0_0_0_1px_var(--color-selected-ring)]" : ""} ${disabled ? "cursor-default" : ""}`}
    >
      <Row option={option} onFollow={() => onChoose(true)} />
    </div>
  );
}

function Row({ option, onFollow }: { option: Option; onFollow: () => void }) {
  if (option.kind === "flight") {
    const { hit } = option;
    return (
      <>
        <span aria-hidden className={`h-7 w-1 shrink-0 rounded-full ${STATE_SWATCH[hit.state]}`} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold tabular-nums text-ink">
            {hit.callsign}
            {hit.flightNumber && <span className="font-normal text-muted"> {hit.flightNumber}</span>}
            <span className="sr-only">, {STATE_LABEL[hit.state]}</span>
          </span>
          {hit.detail && <span className="truncate text-xs text-muted">{hit.detail}</span>}
        </span>
        <span aria-hidden className={`hidden shrink-0 text-xs font-semibold sm:inline ${STATE_INK[hit.state]}`}>
          {STATE_LABEL[hit.state]}
        </span>
        <span
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            onFollow();
          }}
          className="-my-1.5 -mr-1 flex min-h-11 shrink-0 items-center px-1"
        >
          <span className="rounded-full bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent">Follow</span>
        </span>
      </>
    );
  }
  if (option.kind === "place") {
    const { place } = option.hit;
    return (
      <>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold tabular-nums text-ink">{place.label}</span>
        <span aria-hidden className="shrink-0 text-xs text-muted">
          {PLACE_TAG[place.kind]}
        </span>
      </>
    );
  }
  if (option.kind === "airport") {
    const { hit } = option;
    return (
      <>
        <span className="w-10 shrink-0 text-sm font-bold tabular-nums text-ink">{hit.title}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold text-ink">{hit.where}</span>
          <span className="truncate text-xs text-muted">{hit.name}</span>
        </span>
        <span aria-hidden className="shrink-0 text-xs text-muted">
          Open
        </span>
      </>
    );
  }
  const { summary } = option;
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-semibold tabular-nums text-ink">
          {summary.callsign ?? option.callsign} <span className="font-normal text-muted">{summary.nearness}</span>
        </span>
        <span className="truncate text-xs text-muted">{[summary.aircraft, summary.altitude, summary.route].filter(Boolean).join(" · ")}</span>
      </span>
      <span aria-hidden className="shrink-0 text-xs text-muted">
        {summary.openable ? `Open ${summary.nearest.toUpperCase()}` : "Out of range"}
      </span>
    </>
  );
}
