import { useId, useState } from "react";
import { ALTITUDE_BANDS, chosenCount, describeFilters, type Filters, type FilterOption, type FilterOptions, filtersActive, GROUND_STATES, type ListField, NO_FILTERS, SPEED_BANDS, toggleFilter } from "@/lib/filters";
import { RAISED, RING } from "./shadows";
import { usePopover } from "./use-popover";

/**
 * The filters: a button beside the search box that opens a panel of choices, grouped by what they
 * narrow. The choices are the page's (atc-app.tsx keeps them and writes them into the address); this
 * file is the button, the panel and its keyboard. A chip is a toggle, so a screen reader hears each one
 * pressed or not. The panel scrolls inside its own height, so on a phone it never pushes the card off.
 */

export interface FilterReadout {
  shown: number;
  total: number;
}

interface FilterControlProps {
  filters: Filters;
  /** The airlines, types, origins and destinations to offer: those in the traffic now, and any already chosen. */
  options: FilterOptions;
  /** What the filters leave showing out of everything there is; null while nothing is known yet. */
  readout: FilterReadout | null;
  onChange: (filters: Filters) => void;
}

const FUNNEL = (
  <svg aria-hidden viewBox="0 0 16 16" className="size-[18px]">
    <path d="M2.5 3.5h11L9.2 8.6v3.9l-2.4 1.2V8.6z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Chips shown in a group before the rest are folded behind "Show all"; the ones chosen are always shown. */
const FOLD_AT = 8;

const chip = (on: boolean) => `flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold xl:min-h-9 ${on ? "bg-accent text-on-accent" : `bg-surface text-ink-2 ${RING}`}`;

interface GroupProps {
  title: string;
  items: { key: string; name: string; count?: number }[];
  chosen: readonly string[];
  onToggle: (key: string) => void;
  /** Fold a long list behind "Show all". */
  fold?: boolean;
}

/** One group of chips under a heading. */
function ChipGroup({ title, items, chosen, onToggle, fold = false }: GroupProps) {
  const id = useId();
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  const folded = fold && !all && items.length > FOLD_AT;
  const shown = folded ? items.filter((item, i) => i < FOLD_AT || chosen.includes(item.key)) : items;
  return (
    <div role="group" aria-labelledby={id} className="flex flex-col gap-2">
      <p id={id} className="text-xs font-semibold tracking-[0.04em] text-muted">
        {title}
      </p>
      <ul className="-m-1 flex flex-wrap gap-1.5 p-1">
        {shown.map((item) => {
          const on = chosen.includes(item.key);
          return (
            <li key={item.key}>
              <button type="button" aria-pressed={on} onClick={() => onToggle(item.key)} className={chip(on)}>
                {item.name}
                {item.count !== undefined && <span className={`tabular-nums ${on ? "opacity-80" : "text-muted"}`}>{item.count}</span>}
              </button>
            </li>
          );
        })}
        {fold && items.length > FOLD_AT && (
          <li>
            <button type="button" aria-expanded={all} onClick={() => setAll((a) => !a)} className="flex min-h-11 items-center rounded-full px-2.5 text-xs font-semibold text-muted xl:min-h-9">
              {all ? "Show fewer" : `Show all ${items.length}`}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

const named = (list: readonly { key: string; label: string }[]) => list.map((i) => ({ key: i.key, name: i.label }));
const counted = (options: FilterOption[]) => options.map((o) => ({ key: o.key, name: o.name, count: o.count }));

export function FilterControl({ filters, options, readout, onChange }: FilterControlProps) {
  const { open, setOpen, buttonRef, rootProps } = usePopover();
  const panelId = useId();
  const active = filtersActive(filters);
  const n = chosenCount(filters);
  const summary = describeFilters(filters);
  const toggle = (field: ListField) => (key: string) => onChange(toggleFilter(filters, field, key));

  const count = readout ? (active ? `${readout.shown.toLocaleString("en-US")} of ${readout.total.toLocaleString("en-US")} aircraft shown` : `${readout.total.toLocaleString("en-US")} aircraft`) : "No aircraft read yet";

  return (
    <div {...rootProps} className="absolute right-4 top-[76px] z-30 xl:left-[calc(50%+218px)] xl:right-auto xl:top-7">
      <button
        ref={buttonRef}
        type="button"
        aria-label={active ? `Filters, ${n} chosen` : "Filters"}
        title={active ? summary : undefined}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`relative flex size-11 items-center justify-center rounded-xl outline-none focus-visible:shadow-[0_0_0_2px_var(--color-ink)] ${RAISED} ${active ? "bg-accent text-on-accent" : "bg-surface text-ink-2"}`}
      >
        {FUNNEL}
        {active && (
          <span aria-hidden className="absolute -right-1.5 -top-1.5 flex min-w-5 items-center justify-center rounded-full bg-surface px-1 text-[11px] font-bold leading-5 text-ink tabular-nums shadow-[0_0_0_1px_var(--color-hairline)]">
            {n}
          </span>
        )}
      </button>
      {open && (
        <section
          id={panelId}
          aria-label="Filters"
          className="popover-panel absolute right-0 top-full mt-2 flex max-h-[calc(100dvh-140px)] w-[calc(100vw-2rem)] flex-col gap-3 rounded-2xl bg-surface p-4 shadow-[0_8px_24px_rgba(20,20,20,0.08),0_0_0_1px_var(--color-hairline)] xl:max-h-[calc(100dvh-168px)] xl:w-[340px]"
        >
          <div className="flex shrink-0 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-0.5">
              <h2 className="text-lg font-bold tracking-[-0.01em]">Filters</h2>
              <p aria-live="polite" className="text-xs text-muted tabular-nums">
                {count}
              </p>
              {active && (
                <p data-filter-summary title={summary} className="truncate text-xs text-ink-2">
                  {summary}
                </p>
              )}
            </div>
            {active && (
              <button type="button" onClick={() => onChange(NO_FILTERS)} className={`flex min-h-11 shrink-0 items-center rounded-full px-3.5 text-xs font-semibold text-ink-2 xl:min-h-9 ${RING}`}>
                Clear
              </button>
            )}
          </div>
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-1 pb-1">
            <ChipGroup title="Airline" items={counted(options.airlines)} chosen={filters.airlines} onToggle={toggle("airlines")} fold />
            <ChipGroup title="Aircraft" items={counted(options.types)} chosen={filters.types} onToggle={toggle("types")} fold />
            <ChipGroup title="Ground state" items={named(GROUND_STATES)} chosen={filters.states} onToggle={toggle("states")} />
            <ChipGroup title="Altitude" items={named(ALTITUDE_BANDS)} chosen={filters.altitudes} onToggle={toggle("altitudes")} />
            <ChipGroup title="Speed" items={named(SPEED_BANDS)} chosen={filters.speeds} onToggle={toggle("speeds")} />
            <ChipGroup title="From" items={counted(options.origins)} chosen={filters.origins} onToggle={toggle("origins")} fold />
            <ChipGroup title="To" items={counted(options.destinations)} chosen={filters.destinations} onToggle={toggle("destinations")} fold />
            <ChipGroup title="Military" items={[{ key: "military", name: "Military only" }]} chosen={filters.military ? ["military"] : []} onToggle={() => onChange({ ...filters, military: !filters.military })} />
          </div>
        </section>
      )}
    </div>
  );
}
