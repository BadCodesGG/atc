import { type KeyboardEvent, type ReactNode, type Ref, useCallback, useState, useSyncExternalStore } from "react";
import type { FlightState, TrafficCounts } from "@/lib/aircraft-state";
import { type Airport, AIRPORTS } from "@/lib/airports";
import { currentFeedStatus, type FeedChannel, type FeedStatus, liveDot, type LiveState, type TrafficReadout, trafficReadout, watchFeed } from "@/lib/feed-health";
import { type NasStatus, programsFor } from "@/lib/faa-status";
import { describeWeather, describeWind, formatVisibility, type Metar } from "@/lib/metar";
import { cutMovements, MOVEMENT_ROWS, type Movements as MovementsData, movementsFoot } from "@/lib/movements";
import type { OpsBoardRow, OpsView } from "@/lib/path-pulse";
import type { CameraMode } from "@/lib/scene/cameras";
import type { ReplayRate } from "@/lib/replay";
import type { ThemeKey } from "@/lib/scene/theme";
import { TURN_STEP, ZOOM_STEP } from "@/lib/scene/view-keys";
import { type JourneyView as JourneyViewData, PHASE_STATE } from "@/lib/journey-view";
import type { FlightCard as FlightCardData } from "@/lib/traffic-view";
import { RADAR_CREDIT } from "@/lib/radar";
import { AirportPicker } from "./airport-picker";
import { CardPhoto } from "./card-photo";
import type { RadarControl } from "./use-radar";
import { RAISED, RING } from "./shadows";

/**
 * The UI around the model, in the light, dark (night ops) and satellite themes: one layout for wide
 * screens (xl and up) and a stacked one for phones and tablets. Every colour is a token from
 * globals.css, so the theme switches them all at once.
 */

export const STATE_LABEL: Record<FlightState, string> = {
  arriving: "Arriving",
  departing: "Departing",
  taxiing: "Taxiing",
  parked: "At gate",
};

export const STATE_SWATCH: Record<FlightState, string> = {
  arriving: "bg-arriving",
  departing: "bg-departing",
  taxiing: "bg-taxiing",
  parked: "bg-parked",
};

const STATE_BADGE: Record<FlightState, string> = {
  arriving: "bg-badge-arriving text-badge-arriving-ink",
  departing: "bg-badge-departing text-badge-departing-ink",
  taxiing: "bg-badge-taxiing text-badge-taxiing-ink",
  parked: "bg-badge-parked text-badge-parked-ink",
};

/** A media query for the wide layout (Tailwind's xl), for the code that has to know which layout is on. */
export const WIDE = "(width >= 80rem)";

/**
 * Where the flight card and the traffic tabs stand in a column at the right, as on a wide screen: wide, and on a landscape window too
 * short for the stacked rows to leave the model any room (globals.css, "A short landscape window"). The scene frames the airport left of it.
 */
export const COLUMN_BESIDE = `${WIDE}, (48rem <= width < 80rem) and (max-height: 40rem)`;

/**
 * The stacked layout as a phone or a tall tablet has it, in which the view buttons sit above the tabs and the flight card below them: not the
 * wide layout, and not the short landscape one (COLUMN_BESIDE), which has its own. The page puts its DOM in the order that is seen.
 */
export const STACKED = "(width < 80rem) and (not ((width >= 48rem) and (height <= 40rem)))";

/** Whether a media query matches now, as React state; false on the server, which has no window to ask. */
export function useMedia(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

interface HeaderProps {
  airport: Airport;
  /** Switches the page to another airport. */
  onAirport: (code: Airport["code"]) => void;
  /** Whether the picker takes focus as it appears: after a pick, the page below is rebuilt and the focus would be lost. */
  focusPicker: boolean;
  /** On the world map the header names the map, not the airport the picker is on. */
  onMap?: boolean;
  /** The aircraft the map draws in view, and how many of those the filters leave showing; null while it shows none (zoomed out past them, or none read yet). */
  inView?: { shown: number; total: number } | null;
  /** The alerts control, beside the picker. */
  alerts?: ReactNode;
}

export function Header({ airport, onAirport, focusPicker, onMap = false, inView = null, alerts }: HeaderProps) {
  const title = onMap ? "Live map" : `${airport.code.toUpperCase()} Live`;
  const subtitle = onMap ? [`${AIRPORTS.length} airports`, inView !== null ? `${inView.shown.toLocaleString("en-US")}${inView.shown === inView.total ? "" : ` of ${inView.total.toLocaleString("en-US")}`} aircraft in view` : ""].filter(Boolean).join(" · ") : airport.name;
  return (
    <>
      {/* Light and dark set the title straight on the model, so a fade in the colour the model clears to (the page colour, lit by the hour) keeps it legible over buildings; satellite has its own panel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[92px] bg-linear-to-b from-(--scene-clear) from-45% to-transparent in-data-[theme=satellite]:hidden xl:h-[120px]"
      />
      {/* Clicks pass through the row itself: on a short window the radar toggle sits in its gap (RadarToggle). The text and the picker with its bell take them back: the subtitle's tooltip and its selection need them. */}
      <div className="atc-title pointer-events-none absolute z-40 inset-x-4 top-4 flex items-center justify-between gap-4 xl:inset-x-auto xl:left-8 xl:top-7 xl:justify-start">
        {/* At 1280 the airport's name, the picker and the alerts bell leave the search box 3 px; a long name gives way to them. */}
        <div className="pointer-events-auto flex min-w-0 flex-col gap-0.5 xl:max-[1500px]:max-w-[220px]">
          <h1 className="text-xl font-bold tracking-[-0.01em] max-xl:leading-6">{title}</h1>
          {/* Two lines before it is cut, so a long airport name reads in full: the row keeps clear of the search box below it either way. */}
          <p title={subtitle} className="line-clamp-2 text-xs leading-[15px] text-muted xl:text-[13px] xl:leading-[17px]">{subtitle}</p>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <AirportPicker airport={airport} onPick={onAirport} focusOnMount={focusPicker} />
          {alerts}
        </div>
      </div>
    </>
  );
}

/** The header's search box lives in its own file; it is exported here with the rest of the chrome. */
export { Search } from "./search-box";

/** What the counts and lists say while there is nothing to count yet, and where there is no feed to count from. */
const READOUT_NOTE: Record<TrafficReadout, string | undefined> = { loading: "Reading traffic…", offline: "No aircraft read yet", ready: undefined };

/** The room a wide screen leaves the counts: from the right margin (32 px) to the filter button's badge (centre + 262 px, 6 px of badge, an 8 px gap). */
const COUNTS_ROOM = "xl:max-w-[calc(50vw-308px)]";

/**
 * The counts, or `note` in their place when there is no traffic to count (the fixture holds only Atlanta's).
 * With the filters on they count what is left showing, and the first says how many of all there are.
 */
export function Counts({ counts, total = null, note, readout = "ready" }: { counts: TrafficCounts | null; total?: number | null; note: string | null; readout?: TrafficReadout }) {
  if (note) {
    return (
      <div aria-live="polite" className={`counts absolute left-4 top-[132px] xl:left-auto xl:right-8 xl:top-7 ${COUNTS_ROOM}`}>
        <div className={`rounded-xl bg-surface px-3 py-2 text-[13px] text-ink-2 xl:px-3.5 xl:py-2.5 ${RING}`}>{note}</div>
      </div>
    );
  }
  // Until the feed has answered, or with nothing to read it from, the figures are a dash: a zero would say the airfield is empty.
  const counted = readout === "ready" ? counts : null;
  const filtered = counted !== null && total !== null && counted.tracked !== total;
  const items: [number | undefined, string, string?][] = [
    [counted?.tracked, "tracked", filtered ? `of ${total}` : undefined],
    [counted?.onGround, "on the ground"],
    [counted?.moving, "moving"],
  ];
  return (
    // On a wide screen the row is right-anchored and grows left toward the filter button, so it is held to the room between them (COUNTS_ROOM)
    // and each count is a two-line tile (the figure over its label), which keeps the widest readout narrower than that room at 1280 in every theme.
    // A phone narrower than 24rem has the same tiles: in one line each, the three are wider than the screen in the night theme and wrap in the others.
    <div aria-live="polite" aria-busy={readout === "loading"} title={READOUT_NOTE[readout]} className={`counts absolute left-4 top-[132px] flex gap-2 xl:left-auto xl:right-8 xl:top-7 xl:flex-wrap xl:justify-end ${COUNTS_ROOM}`}>
      {items.map(([n, label, of]) => (
        <div key={label} className={`rounded-xl bg-surface px-3 py-2 text-[13px] text-ink-2 max-[24rem]:flex max-[24rem]:flex-col max-[24rem]:py-[5px] max-[24rem]:text-[11px] max-[24rem]:leading-3.5 xl:flex xl:flex-col xl:px-3.5 xl:py-[5px] xl:text-[11px] xl:leading-3.5 ${RING}`}>
          <span className="max-[24rem]:text-[15px] max-[24rem]:leading-5 max-[24rem]:text-ink xl:text-[15px] xl:leading-5 xl:text-ink">
            <strong className="font-bold text-ink tabular-nums">{n ?? "—"}</strong> {of && <span className="tabular-nums">{of} </span>}
          </span>
          {label}
        </div>
      ))}
    </div>
  );
}

/**
 * The wind from the airport's METAR, as the counts read: the wind always, then the visibility when it
 * is under 10 miles and the weather when there is any. On phones only the wind, shortened, fits beside
 * the map-style switch.
 */
export function WeatherReadout({ metar }: { metar: Metar | null }) {
  if (!metar?.wind) return null;
  const weather = describeWeather(metar);
  const visibility = metar.visibilityM !== null && metar.visibilityM < 15_000 ? formatVisibility(metar.visibilityM) : null;
  return (
    <p
      data-weather
      title={metar.raw}
      className={`absolute left-4 top-[184px] flex gap-1.5 whitespace-nowrap rounded-xl bg-surface px-2.5 py-2 text-xs text-ink-2 min-[400px]:px-3 min-[400px]:text-[13px] xl:left-8 xl:top-[108px] xl:max-[1500px]:top-[124px] xl:px-3.5 xl:py-2.5 ${RING}`}
    >
      <span>
        Wind <strong className="font-bold text-ink tabular-nums xl:hidden">{describeWind(metar.wind, { short: true })}</strong>
        <strong className="hidden font-bold text-ink tabular-nums xl:inline">{describeWind(metar.wind)}</strong>
      </span>
      {visibility && <span className="hidden tabular-nums xl:inline">· {visibility}</span>}
      {weather && <span className="hidden xl:inline">· {weather}</span>}
    </p>
  );
}

interface FlightCardProps {
  card: FlightCardData | null;
  /** The published procedure its drawn approach or climb-out follows, cited: "Approach: ILS RWY 8L, from FAA CIFP cycle 2610". */
  procedure?: string | null;
  /** The card's flight followed gate to gate: the route line becomes the journey's progress. */
  journey?: JourneyViewData | null;
  /** Lower-case code of the airport on screen. */
  here: string;
  /** The FAA's delay programs: undefined while loading, null when the feed failed. */
  status: NasStatus | null | undefined;
  following: boolean;
  onFollow: (follow: boolean) => void;
  /** On the world map, what the flight is doing (the journey's phases) in the badge's place, and a quiet line under the facts. */
  phase?: string;
  note?: string | null;
  /** The flight cannot be followed (on the map, one that has left the feed): the toggle is dimmed and does nothing. */
  unavailable?: boolean;
}

const CHECK = (
  <svg aria-hidden viewBox="0 0 16 16" className="size-3.5 shrink-0">
    <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function FlightCard({ card, procedure = null, here, status, following, onFollow, journey = null, phase, note = null, unavailable = false }: FlightCardProps) {
  if (!card) return null;
  const { route, direction, gate } = card;
  const far = route ? (direction === "outbound" ? route.destination : route.origin) : null;
  const gateLabel = gate ? (gate.left ? `Left ${gate.kind}` : gate.kind === "gate" ? "Gate" : "Stand") : "";
  const place = gate ? `${gateLabel} ${gate.ref}` : null;
  // Parked at a gate, the badge already says "At gate" and the gate fact says which one.
  const headline = card.state === "parked" && gate && !gate.left ? null : card.headline;
  const farCity = route ? (direction === "outbound" ? `to ${route.destination.city}` : `from ${route.origin.city}`) : "";
  // On a journey the estimated time of arrival takes the heading's place, once there is one.
  const facts: [string, string][] = [
    ["Speed", card.speed],
    journey?.arrival ? ["ETA", journey.arrival] : ["Heading", card.heading],
    ["Altitude", card.altitude],
  ];
  // One name for the toggle in both states, so a screen reader hears "Follow this flight, pressed";
  // the tick and the selected colours (a picked movements row's) show the state.
  const toggle = following ? "bg-selected text-ink shadow-[0_0_0_1px_var(--color-selected-ring)]" : "bg-accent text-on-accent";
  return (
    <section
      aria-label={`Selected flight ${card.callsign}`}
      className="pointer-events-auto relative flex shrink-0 flex-col gap-2 rounded-2xl bg-surface px-4 py-3.5 shadow-[0_8px_24px_rgba(20,20,20,0.08),0_0_0_1px_var(--color-hairline)] max-xl:order-last max-xl:mt-auto cramped:group-has-[[data-open=true]]/side:hidden xl:p-4 roomy:gap-3 roomy:p-5"
    >
      <CardPhoto key={card.id} hex={card.id} />
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="truncate text-lg font-bold tracking-[-0.01em] xl:text-xl roomy:text-2xl">{card.callsign}</h2>
          {card.operator && (
            <p title={card.operator} className="line-clamp-2 text-[13px] text-muted xl:text-sm">
              {card.operator}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATE_BADGE[card.state]}`}>{phase ?? STATE_LABEL[card.state]}</span>
          {/* The compact toggle, so the card stays short enough to leave the map (or, on a short wide screen, the list) in view. */}
          <button
            type="button"
            aria-pressed={following}
            aria-label="Follow this flight"
            disabled={unavailable}
            onClick={() => onFollow(!following)}
            className={`flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold disabled:opacity-45 xl:min-h-9 roomy:hidden ${toggle}`}
          >
            {following && CHECK}
            Follow
          </button>
        </div>
      </div>
      {journey ? (
        <JourneyPanel journey={journey} />
      ) : route ? (
        <p data-route className="flex min-w-0 items-baseline gap-2 text-[15px] font-semibold tabular-nums xl:text-base">
          <span>{route.origin.code}</span>
          <span aria-hidden className="text-muted">
            →
          </span>
          <span className="sr-only">to</span>
          <span>{route.destination.code}</span>
          <span title={farCity} className="line-clamp-2 min-w-0 text-[13px] font-normal text-muted">
            {farCity}
          </span>
          {/* A short window hides the facts, so the gate comes up onto this line. */}
          {place && <span className="hidden shrink-0 text-[13px] text-ink-2 max-xl:short:inline">· {place}</span>}
        </p>
      ) : (
        place && <p className="hidden text-sm font-semibold max-xl:short:block">{place}</p>
      )}
      {headline && <p className="text-sm font-semibold max-xl:short:hidden roomy:text-[15px]">{headline}</p>}
      <dl className="flex justify-between gap-x-6 max-xl:short:hidden">
        {facts.map(([label, value]) => (
          <div key={label} title={label === "ETA" ? ESTIMATE : undefined} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="whitespace-nowrap text-[15px] font-semibold tabular-nums roomy:text-base">{value}</dd>
          </div>
        ))}
        {/* A gate makes a fourth fact on the same row, so it never makes the card taller. */}
        {gate && (
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted">{gateLabel}</dt>
            <dd data-gate className="whitespace-nowrap text-[15px] font-semibold tabular-nums roomy:text-base">
              {gate.ref}
            </dd>
          </div>
        )}
      </dl>
      {note && (
        <p data-note className="text-xs text-muted">
          {note}
        </p>
      )}
      {procedure && (
        <p data-procedure className="text-xs text-muted">
          {procedure}
        </p>
      )}
      {journey?.endLine && <p className={END_LINE}>{journey.endLine}</p>}
      <Delays here={here} status={status} direction={direction} far={far?.country === "US" ? far.code : null} />
      <button
        type="button"
        aria-pressed={following}
        disabled={unavailable}
        onClick={() => onFollow(!following)}
        className={`hidden min-h-11 items-center justify-center gap-2 rounded-[10px] text-[15px] font-semibold disabled:opacity-45 roomy:flex ${toggle}`}
      >
        {following && CHECK}
        Follow this flight
      </button>
    </section>
  );
}

/** What the ETA is, for its title: an estimated time of arrival, from the distance left and the ground speed now. */
const ESTIMATE = "Estimated time of arrival, from the distance left and the ground speed now";
/** What the map's faint, dashed lines are: the flight card and the journey card say it under the facts, while one is drawn. */
export const ESTIMATES_NOTE = "Faint and dashed lines are estimates.";
/** The line that says a journey ends on the map, in the delay note's box. */
const END_LINE = "text-[13px] text-note xl:rounded-[10px] xl:bg-well xl:px-3 xl:py-2 roomy:leading-[1.45]";

/**
 * A journey's progress, in the route line's place: the two codes with the way between them, the flown
 * part solid up to the aircraft, and the distance flown and left under it.
 */
function JourneyPanel({ journey }: { journey: JourneyViewData }) {
  const share = journey.share === null ? null : `${(Math.max(0, Math.min(1, journey.share)) * 100).toFixed(1)}%`;
  return (
    <div data-journey className="flex flex-col gap-1">
      <p className="flex min-w-0 items-center gap-2.5 text-[15px] font-semibold tabular-nums xl:text-base">
        <span className={journey.from ? undefined : "text-muted"}>{journey.from ?? "?"}</span>
        <span aria-hidden className="relative h-[3px] min-w-0 flex-1 rounded-full bg-hairline">
          {share && <span className="absolute inset-y-0 left-0 rounded-full bg-ink" style={{ width: share }} />}
          {share && <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-[0_0_0_2.5px_var(--color-surface)]" style={{ left: share }} />}
        </span>
        <span className="sr-only">to</span>
        <span className={journey.to ? undefined : "text-muted"}>{journey.to ?? "?"}</span>
      </p>
      <p className="flex justify-between gap-3 text-xs text-muted tabular-nums">
        <span>{journey.flown} flown</span>
        {journey.toGo && <span>{journey.toGo} to go</span>}
      </p>
    </div>
  );
}

/**
 * The followed flight on the map, between its two dioramas: the flight card's own panel, with the
 * journey's progress, speed, height and estimated arrival. Its toggle lets go of the journey there.
 */
export function JourneyCard({ journey, onStop }: { journey: JourneyViewData; onStop: () => void }) {
  const facts: [string, string][] = [
    ["Speed", journey.speed],
    ["Altitude", journey.altitude],
    ...(journey.arrival ? [["ETA", journey.arrival] as [string, string]] : []),
  ];
  const toggle = "bg-selected text-ink shadow-[0_0_0_1px_var(--color-selected-ring)]";
  return (
    <section
      aria-label={`Followed flight ${journey.callsign}`}
      className="pointer-events-auto flex shrink-0 flex-col gap-2 rounded-2xl bg-surface px-4 py-3.5 shadow-[0_8px_24px_rgba(20,20,20,0.08),0_0_0_1px_var(--color-hairline)] xl:p-4 roomy:gap-3 roomy:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="truncate text-lg font-bold tracking-[-0.01em] xl:text-xl roomy:text-2xl">{journey.callsign}</h2>
          {journey.operator && (
            <p title={journey.operator} className="line-clamp-2 text-[13px] text-muted xl:text-sm">
              {journey.operator}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${STATE_BADGE[PHASE_STATE[journey.phase]]}`}>{journey.phase}</span>
          <button type="button" aria-pressed aria-label="Follow this flight" onClick={onStop} className={`flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold xl:min-h-9 roomy:hidden ${toggle}`}>
            {CHECK}
            Follow
          </button>
        </div>
      </div>
      <JourneyPanel journey={journey} />
      <dl className="flex justify-between gap-x-6 max-xl:short:hidden">
        {facts.map(([label, value]) => (
          <div key={label} title={label === "ETA" ? ESTIMATE : undefined} className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted">{label}</dt>
            <dd className="whitespace-nowrap text-[15px] font-semibold tabular-nums roomy:text-base">{value}</dd>
          </div>
        ))}
      </dl>
      {/* What the map draws of the way ahead that is published, cited as the diorama's flight card cites its own. */}
      {journey.procedures.map((line) => (
        <p key={line} data-journey-procedure className="text-xs text-muted">
          {line}
        </p>
      ))}
      {journey.estimated && (
        <p data-note className="text-xs text-muted">
          {ESTIMATES_NOTE}
        </p>
      )}
      {journey.endLine && <p className={END_LINE}>{journey.endLine}</p>}
      <button type="button" aria-pressed onClick={onStop} className={`hidden min-h-11 items-center justify-center gap-2 rounded-[10px] text-[15px] font-semibold roomy:flex ${toggle}`}>
        {CHECK}
        Follow this flight
      </button>
    </section>
  );
}

/**
 * What the FAA says is slowing this flight's airports, or that nothing is. Airport-wide, so it says so.
 * At most two lines, the whole of it in the title, except on a wide screen with the height for the full box.
 * (One line cut "right now" off at 1280 in the satellite theme's wider type.)
 */
function Delays({ here, status, direction, far }: { here: string; status: NasStatus | null | undefined; direction: FlightCardData["direction"]; far: string | null }) {
  if (status === undefined) return null;
  const line =
    "line-clamp-2 text-[13px] text-note max-xl:short:hidden xl:rounded-[10px] xl:bg-well xl:px-3 xl:py-2 roomy:whitespace-normal roomy:p-3 roomy:leading-[1.45]";
  if (status === null) {
    const text = "FAA delay status is unavailable right now.";
    return (
      <p title={text} className={line}>
        {text}
      </p>
    );
  }
  const { programs, checked } = programsFor(status, here, direction, far);
  if (!programs.length) {
    const text = `No FAA delay programs at ${checked.join(" or ")} right now.`;
    return (
      <p data-delays title={text} className={line}>
        {text}
      </p>
    );
  }
  const text = programs.map((p) => `${p.airport} ${p.summary}${p.reason ? ` · ${p.reason}` : ""}`).join("; ");
  return (
    <ul data-delays aria-label="FAA delay programs" title={text} className={`${line} roomy:flex roomy:flex-col roomy:gap-1.5`}>
      {programs.map((p, i) => (
        <li key={i} className="inline">
          {i > 0 && <span className="roomy:hidden">; </span>}
          <strong className="font-semibold text-ink">{p.airport}</strong> {p.summary}
          {p.reason ? <span className="text-muted"> · {p.reason}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Turn, zoom and go back to the framed view: the buttons for what drags, the wheel, pinches and the
 * keyboard do. A column at the bottom left on wide screens, with the camera switch beside it along its
 * foot; on phones and tablets a row above or beside the traffic tabs, the camera picker first and
 * Reset view folded into the row as one more button.
 */
export function ViewControls({
  moved,
  onTurn,
  onZoom,
  onReset,
  before,
  children,
}: {
  moved: boolean;
  onTurn: (deg: number) => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
  /** Drawn ahead of the view buttons, in the DOM as on screen: the camera picker on phones. */
  before?: ReactNode;
  /** Drawn after them: the camera switch on wide screens. */
  children?: ReactNode;
}) {
  const btn = "flex size-11 items-center justify-center rounded-full text-ink-2 hover:bg-well xl:size-10";
  const icon = (d: string) => (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
  return (
    // On the world map the stacked layout has no counts or column to sit under: the buttons go to the
    // foot, in one row with the map style above the time bar, clear of the map (MAP_FOOT).
    <div data-map-foot className={`view-controls absolute right-4 top-[244px] flex flex-col items-end gap-2 xl:bottom-[84px] xl:left-8 xl:right-auto xl:top-auto xl:items-start ${MAP_FOOT} max-xl:in-data-on-map:left-4 max-xl:in-data-on-map:right-auto`}>
      <div className="flex items-center gap-2 xl:items-end xl:gap-3">
        {before}
        <div role="group" aria-label="View" className={`flex gap-0.5 rounded-full bg-surface p-1 xl:flex-col ${RAISED}`}>
          <button type="button" aria-label="Zoom in" title="Zoom in (scroll, +)" className={btn} onClick={() => onZoom(ZOOM_STEP)}>
            {icon("M8 3v10M3 8h10")}
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out (scroll, -)" className={btn} onClick={() => onZoom(1 / ZOOM_STEP)}>
            {icon("M3 8h10")}
          </button>
          {/* A phone turns the map with two fingers (and the keys Q and E turn it): on the map the row has room only for zoom and Reset view, and a phone narrower than 24rem has none for the turn buttons at their 44 px. */}
          <button type="button" aria-label="Turn left" title="Turn left (right-drag, Q)" className={`${btn} max-[24rem]:hidden max-sm:in-data-on-map:hidden`} onClick={() => onTurn(-TURN_STEP)}>
            {icon("M5.5 3.5 2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7")}
          </button>
          <button type="button" aria-label="Turn right" title="Turn right (right-drag, E)" className={`${btn} max-[24rem]:hidden max-sm:in-data-on-map:hidden`} onClick={() => onTurn(TURN_STEP)}>
            {icon("M10.5 3.5l3 3-3 3M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3")}
          </button>
          {moved && (
            <button type="button" aria-label="Reset view" title="Reset view" className={`${btn} xl:hidden`} onClick={onReset}>
              {icon("M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10")}
            </button>
          )}
        </div>
        {children}
      </div>
      {moved && (
        <button type="button" onClick={onReset} className={`hidden min-h-10 rounded-full bg-surface px-4 text-sm font-semibold text-ink-2 xl:block ${RAISED}`}>
          Reset view
        </button>
      )}
    </div>
  );
}

/**
 * The weather radar layer's switch, on the world map where the counts sit on a diorama. While it is on,
 * RainViewer's credit shows beside it, as their terms ask, with the age of the frame drawn.
 */
export function RadarToggle({ radar }: { radar: RadarControl }) {
  const sweep = (
    <svg aria-hidden viewBox="0 0 16 16" className="size-4 shrink-0">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="8" cy="8" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 8 12.4 3.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
  const note =
    radar.status === "unavailable" ? (
      <span>Radar unavailable right now</span>
    ) : radar.status === "loading" ? (
      <span>Loading radar · </span>
    ) : radar.age ? (
      <span className="max-xl:short:hidden">Radar · {radar.age} · </span>
    ) : null;
  // Under the search on phones and wide screens; on a short window, which has no room for another row,
  // in the header's row between the title and the airport picker, with the age of the frame left out.
  return (
    <div data-radar className="absolute left-4 top-[132px] flex items-center gap-2 max-xl:short:sm:left-[260px] max-xl:short:sm:top-4 max-xl:short:sm:z-45 xl:left-8 xl:top-[108px]">
      <div role="group" aria-label="Layers" className={`rounded-full bg-surface p-1 ${RAISED}`}>
        <button
          type="button"
          aria-pressed={radar.on}
          onClick={radar.toggle}
          title="Weather radar"
          className={`flex min-h-11 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold xl:min-h-9 ${radar.on ? "bg-accent text-on-accent" : "bg-transparent text-ink-2"}`}
        >
          {sweep}
          Radar
        </button>
      </div>
      {radar.on && (
        <p aria-live="polite" className={`max-w-[calc(100vw-9.5rem)] rounded-2xl bg-surface px-3 py-2 text-xs leading-snug text-ink-2 ${RING}`}>
          {note}
          {radar.status !== "unavailable" && (
            <a href={RADAR_CREDIT.href} target="_blank" rel="noopener" className="underline underline-offset-2">
              {RADAR_CREDIT.text}
            </a>
          )}
        </p>
      )}
    </div>
  );
}

const CAMERA_OPTIONS: { key: CameraMode; label: string; unavailable: string }[] = [
  { key: "orbit", label: "Orbit", unavailable: "" },
  { key: "tower", label: "Tower", unavailable: "This airport's map has no tower" },
  { key: "drone", label: "Drone", unavailable: "Select a flight first" },
  { key: "approach", label: "Approach", unavailable: "Select a flight arriving on a runway" },
];

interface CameraProps {
  camera: CameraMode;
  available: CameraMode[];
  onChange: (camera: CameraMode) => void;
}

/** Where the camera looks from: the orbit, the tower, a drone over the flight or its approach. Wide screens; phones get CameraMenu. */
export function CameraSwitch({ camera, available, onChange }: CameraProps) {
  return (
    <div role="group" aria-label="Camera" className={`hidden gap-1 rounded-full bg-surface p-1 xl:flex ${RAISED}`}>
      {CAMERA_OPTIONS.map(({ key, label, unavailable }) => {
        const off = !available.includes(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={key === camera}
            disabled={off}
            title={off ? unavailable : undefined}
            onClick={() => onChange(key)}
            className={`min-h-9 rounded-full px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:text-muted ${key === camera ? "bg-accent text-on-accent" : "bg-transparent text-ink-2"}`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The camera switch on phones and tablets: the platform's own picker, in the view buttons' row, ahead
 * of them (ViewControls' `before`).
 */
export function CameraMenu({ camera, available, onChange }: CameraProps) {
  return (
    <div className="xl:hidden">
      <label htmlFor="atc-camera" className="sr-only">
        Camera
      </label>
      <select
        id="atc-camera"
        value={camera}
        onChange={(e) => onChange(e.target.value as CameraMode)}
        className={`min-h-11 appearance-none rounded-full bg-surface bg-[length:10px] bg-[right_12px_center] bg-no-repeat pl-3.5 pr-8 text-sm font-semibold text-ink-2 outline-none focus-visible:shadow-[0_0_0_2px_var(--color-ink)] ${RAISED}`}
        style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 3.5 5 7l3.5-3.5' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")` }}
      >
        {CAMERA_OPTIONS.map(({ key, label }) => (
          <option key={key} value={key} disabled={!available.includes(key)}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The selected flight and the traffic panel. On wide screens, the right-hand column: the flight
 * above the panel, the panel taking what height is left above the map-style switch. On phones and
 * tablets, the band between the traffic tabs and the legend: the tabs at its top, the flight at
 * its foot, and the open panel only ever in the space between, so the two can never overlap; where
 * that space is too short for a useful list, the card steps aside while the panel is open. On a phone
 * narrower than `sm` the tabs and the view buttons do not fit side by side, so the band starts a row
 * lower, under the view buttons. On the world map the foot holds the view buttons and the map style
 * (in two rows on a narrow phone), and the map's credit above those, so the band ends above all of it. The scene
 * measures the wide column (`ref`) to frame the airport in what it leaves free; only the children take
 * clicks, so the empty part of the band never blocks the map.
 */
export function SideColumn({ children, ref }: { children: ReactNode; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className="side-column group/side pointer-events-none absolute inset-x-4 bottom-[132px] top-[296px] flex flex-col gap-2 max-xl:short:bottom-[76px] max-xl:in-data-on-map:bottom-[172px] max-xl:short:in-data-on-map:bottom-[172px] max-[28rem]:in-data-on-map:bottom-[232px] sm:top-[244px] max-xl:short:in-data-on-map:top-[128px] xl:bottom-[96px] xl:left-auto xl:right-8 xl:top-[104px] xl:w-[300px] xl:gap-3"
    >
      {children}
    </div>
  );
}

export const STATE_INK: Record<FlightState, string> = {
  arriving: "text-badge-arriving-ink",
  departing: "text-badge-departing-ink",
  taxiing: "text-badge-taxiing-ink",
  parked: "text-badge-parked-ink",
};

/**
 * The aircraft moving now, as in the night ops mock's ACTIVE MOVEMENTS: callsign, type, what it is
 * doing, a state tag and speed, each row selecting its flight. `movements` is every moving aircraft:
 * the first few rows show until the footer's "+ N more moving" expands the list to all of them. The list
 * only: the column's tabbed panel places it and folds it, and `onChosen` lets it fold again on phones,
 * to show the flight.
 */
export function Movements({ movements, onSelect, onChosen, filtered = false, readout = "ready" }: { movements: MovementsData | null; onSelect: (id: string) => void; onChosen: () => void; filtered?: boolean; readout?: TrafficReadout }) {
  const [expanded, setExpanded] = useState(false);
  if (!movements) return null;
  const { rows, more, atGates } = cutMovements(movements, expanded ? Infinity : MOVEMENT_ROWS);
  // No traffic at all (a fixture asked for at another airport, or an empty sky): one plain line, not a "0 at gates" pill.
  if (rows.length === 0 && more === 0 && atGates === 0) {
    return (
      <section aria-label="Active movements" className="movements flex min-h-0 flex-col">
        <p id="movements-list" className={`rounded-xl bg-surface px-3 py-2.5 text-[13px] text-ink-2 ${RING}`}>
          {READOUT_NOTE[readout] ?? (filtered ? "No aircraft match the filters." : "No aircraft moving or at the gates.")}
        </p>
      </section>
    );
  }
  const foot = movementsFoot(movements, expanded);
  return (
    <section aria-label="Active movements" className="movements flex min-h-0 flex-col">
      <div id="movements-list" className="flex min-h-0 w-full flex-col gap-1.5">
        <ul id="movements-rows" className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                aria-pressed={r.selected}
                onClick={() => {
                  onSelect(r.id);
                  onChosen();
                }}
                className={`grid min-h-11 w-full grid-cols-[4px_minmax(0,1fr)] overflow-hidden rounded-lg text-left ${
                  r.selected ? "bg-selected shadow-[0_0_0_1px_var(--color-selected-ring)]" : `bg-surface ${RING}`
                }`}
              >
                <span aria-hidden className={STATE_SWATCH[r.state]} />
                <span className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="flex justify-between gap-3 text-sm font-semibold text-ink">
                    <span className="truncate">
                      {r.callsign}
                      {r.route && <span className="font-normal text-muted"> {r.route}</span>}
                    </span>
                    <span className={`shrink-0 ${STATE_INK[r.state]}`}>{r.tag}</span>
                  </span>
                  <span className="flex justify-between gap-3 text-xs text-muted">
                    <span className="truncate">{[r.type, r.phrase].filter(Boolean).join(" · ")}</span>
                    <span className="shrink-0 tabular-nums">{r.speed}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        {(foot.toggle || foot.atGates) && (
          <p className="flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted">
            {foot.toggle && (
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls="movements-rows"
                onClick={() => setExpanded(!expanded)}
                className={`min-h-11 rounded-md bg-surface px-2.5 font-semibold text-ink-2 hover:text-ink xl:min-h-7 ${RING}`}
              >
                {foot.toggle}
              </button>
            )}
            {foot.atGates && <span className={`rounded-md bg-surface px-2.5 py-1 ${RING}`}>{foot.atGates}</span>}
          </p>
        )}
      </div>
    </section>
  );
}

const EVENT_INK: Record<OpsBoardRow["events"][number]["kind"], string> = {
  seen: "text-muted",
  pushback: "text-badge-departing-ink",
  takeoff: "text-badge-departing-ink",
  landing: "text-badge-arriving-ink",
  in: "text-badge-arriving-ink",
};

type ColumnTab = "movements" | "pulse" | "board";

const COLUMN_TABS: { key: ColumnTab; label: string; short: string }[] = [
  { key: "movements", label: "Movements", short: "Moving" },
  { key: "pulse", label: "Pulse", short: "Pulse" },
  { key: "board", label: "Board", short: "Board" },
];

/**
 * The column's lower panel: the active movements, the airport's pulse and the observed board, one at
 * a time behind a row of tabs, so the flight card above keeps its space. Open on wide screens; on
 * phones and tablets folded to its tabs at the top of the band, beside the view buttons, until one is
 * tapped (tapping the open one folds it again), and choosing a flight from the list folds it, to show
 * the flight. Arrow keys move between the tabs. `data-open` tells the card when to step aside.
 */
export function ColumnPanel({ movements, ops, onSelect, filtered = false, readout = "ready" }: { movements: MovementsData | null; ops: OpsView | null; onSelect: (id: string) => void; filtered?: boolean; readout?: TrafficReadout }) {
  const [tab, setTab] = useState<ColumnTab>("movements");
  // null: the default for the screen (open on xl, folded below), until a tab is tapped.
  const [open, setOpen] = useState<boolean | null>(null);
  const wide = useMedia(WIDE);
  if (!movements && !ops) return null;
  const shown = open ?? wide;
  const choose = (next: ColumnTab) => {
    setOpen(!(next === tab && shown && !wide));
    setTab(next);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = COLUMN_TABS.findIndex((t) => t.key === tab);
    const to = e.key === "ArrowRight" ? (i + 1) % COLUMN_TABS.length : e.key === "ArrowLeft" ? (i + COLUMN_TABS.length - 1) % COLUMN_TABS.length : e.key === "Home" ? 0 : e.key === "End" ? COLUMN_TABS.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setTab(COLUMN_TABS[to].key);
    setOpen(true);
    document.getElementById(`column-tab-${COLUMN_TABS[to].key}`)?.focus();
  };
  const count = movements ? movements.rows.length + movements.more : null;
  return (
    <section aria-label="Traffic" data-open={shown} className="pointer-events-none flex min-h-0 flex-col items-start gap-1.5 *:pointer-events-auto xl:items-stretch">
      <div role="tablist" aria-label="Traffic" onKeyDown={onKeyDown} className={`flex shrink-0 gap-0.5 rounded-full bg-surface p-1 ${RAISED}`}>
        {COLUMN_TABS.map((t) => {
          const on = t.key === tab;
          return (
            <button
              key={t.key}
              id={`column-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls="column-tabpanel"
              tabIndex={on ? 0 : -1}
              onClick={() => choose(t.key)}
              className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-[13px] font-semibold xl:min-h-8 ${on ? "bg-accent text-on-accent" : "bg-transparent text-ink-2"}`}
            >
              <span className="xl:hidden">{t.short}</span>
              <span className="hidden xl:inline">{t.label}</span>
              {t.key === "movements" && !!count && <span className="hidden tabular-nums opacity-80 xl:inline">{count}</span>}
            </button>
          );
        })}
      </div>
      <div id="column-tabpanel" role="tabpanel" aria-labelledby={`column-tab-${tab}`} className={`${shown ? "flex" : "hidden"} min-h-0 w-full max-w-sm flex-col xl:max-w-none`}>
        {tab === "movements" ? (
          <Movements
            movements={movements}
            filtered={filtered}
            readout={readout}
            onSelect={onSelect}
            onChosen={() => {
              if (!wide) setOpen(false);
            }}
          />
        ) : ops ? (
          tab === "pulse" ? (
            <PulseNow ops={ops} />
          ) : (
            <Board ops={ops} filtered={filtered} readout={readout} />
          )
        ) : null}
      </div>
    </section>
  );
}

/** The airport's pulse now: the runways in use with their hold queues, and this hour's movements and taxi times. */
function PulseNow({ ops }: { ops: OpsView }) {
  const figures: [string, string, string][] = [
    ["Arrivals", String(ops.arrivals), "Landings watched this hour"],
    ["Departures", String(ops.departures), "Takeoffs watched this hour"],
    ["Taxi out", ops.taxiOut ?? "—", "Median, pushback to takeoff"],
    ["Taxi in", ops.taxiIn ?? "—", "Median, landing to gate"],
  ];
  return (
    <div data-pulse className={`flex min-h-0 flex-col gap-2.5 overflow-y-auto rounded-xl bg-surface p-3 ${RING}`}>
      <p className="flex justify-between text-[11px] text-muted">
        <span>Runways in use</span>
        <span>
          measured since <time className="font-semibold">{ops.since}</time>
        </span>
      </p>
      <ul aria-label="Runways in use" className="flex flex-col gap-0.5">
        {ops.runways.length === 0 && <li className="text-[13px] text-muted">No runway seen in use yet.</li>}
        {ops.runways.map((r) => (
          <li key={r.runway} className="grid grid-cols-[4px_2.4rem_minmax(0,1fr)_auto] items-center gap-2 text-[13px] leading-5">
            <span aria-hidden className={`h-4 rounded-sm ${/Arrivals/.test(r.role) ? "bg-arriving" : "bg-departing"}`} />
            <strong className="font-bold text-ink tabular-nums">{r.runway}</strong>
            <span className="truncate text-muted">{r.role}</span>
            <span className="text-right text-xs text-ink-2 tabular-nums">
              {/Departures/.test(r.role) ? [r.holding ? `${r.holding} holding` : "", r.taxiingOut ? `${r.taxiingOut} taxiing` : ""].filter(Boolean).join(" · ") || "No queue" : ""}
            </span>
          </li>
        ))}
      </ul>
      <dl aria-label="This hour" className="grid grid-cols-4 gap-2 border-t border-hairline pt-2.5">
        {figures.map(([label, value, note]) => (
          <div key={label} title={note} className="flex flex-col">
            <dt className="text-[11px] text-muted">{label}</dt>
            <dd className="text-[15px] font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** The observed board: what each flight was seen to do and when, the latest news first. */
function Board({ ops, filtered, readout }: { ops: OpsView; filtered: boolean; readout: TrafficReadout }) {
  const empty = READOUT_NOTE[readout] ?? (filtered ? "No flight on the board matches the filters." : null);
  if (empty && ops.board.length === 0) {
    return (
      <p data-board className={`rounded-xl bg-surface px-3 py-2.5 text-[13px] text-ink-2 ${RING}`}>
        {empty}
      </p>
    );
  }
  return (
    <ol data-board aria-label="Observed board" className="flex min-h-0 flex-col gap-1.5 overflow-y-auto">
      {ops.board.map((f) => (
        <li key={f.id} className={`flex flex-col gap-0.5 rounded-lg bg-surface px-3 py-2 ${RING}`}>
          <span className="text-sm font-semibold text-ink">{f.callsign}</span>
          {f.events.map((e, i) => (
            <span key={i} className="flex gap-2 text-xs">
              <time className="shrink-0 text-muted tabular-nums">{e.time}</time>
              <span className={EVENT_INK[e.kind]}>{e.text}</span>
            </span>
          ))}
        </li>
      ))}
    </ol>
  );
}

export function Legend() {
  return (
    <ul className={`absolute bottom-[76px] left-1/2 flex max-xl:short:hidden -translate-x-1/2 gap-3 whitespace-nowrap rounded-xl bg-surface px-3.5 py-2.5 text-xs text-ink-2 xl:bottom-8 xl:left-8 xl:translate-x-0 xl:gap-4 xl:px-4 xl:py-3 xl:text-[13px] ${RING}`}>
      {(Object.keys(STATE_LABEL) as FlightState[]).map((state) => (
        <li key={state} className="flex items-center gap-1.5">
          <span aria-hidden className={`h-[7px] w-[18px] rounded ${STATE_SWATCH[state]}`} />
          {STATE_LABEL[state]}
        </li>
      ))}
    </ul>
  );
}

/**
 * Where the data comes from: adsb.lol's data is ODbL, which asks for attribution, and adsb.fi asks
 * for a citation with a link to its home page. The airport layouts are OpenStreetMap's, also ODbL,
 * which asks for the "OpenStreetMap contributors" credit with a link to its copyright page. A quiet
 * line along the foot of both views, under the time bar and the map style, in the look of the map's
 * own credit line (globals.css). On a phone the labels drop and OpenStreetMap takes its short
 * credit form, so the line stays one line inside the width.
 */
export function DataCredit() {
  // The text is 10 px, so each link's hit area is a pseudo-element grown past it, to 24 px or more each way (WCAG 2.5.8): it changes nothing that is drawn.
  // On a phone the line is 2 px off the foot of the page and 2 px under the time bar, whose controls start 4 px inside it: the area stops 4 px above the line and takes the rest of its height from below.
  const link = "relative hover:underline focus-visible:underline after:absolute after:-inset-x-1 after:-top-1 after:-bottom-2 after:content-['']";
  return (
    <p className="absolute bottom-0.5 right-4 whitespace-nowrap rounded bg-surface px-1.5 text-[10px] leading-3 text-label xl:bottom-2 xl:right-8">
      <span className="hidden sm:inline">Flight data: </span>
      <a href="https://adsb.lol" target="_blank" rel="noreferrer" className={link}>
        adsb.lol
      </a>{" "}
      (ODbL) &middot;{" "}
      <a href="https://adsb.fi" target="_blank" rel="noreferrer" className={link}>
        adsb.fi
      </a>{" "}
      &middot; <span className="hidden sm:inline">Airports: </span>&copy;{" "}
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className={link}>
        OpenStreetMap<span className="hidden sm:inline"> contributors</span>
      </a>
    </p>
  );
}

/** Where the replay is, for the time bar: seconds since the page's first snapshot, out of how many there are. */
export interface TimeBarReplay {
  live: boolean;
  rate: ReplayRate;
  position: number;
  span: number;
  /** The clock time the history starts at, "21:40". */
  since: string;
}

const RATES: ReplayRate[] = [10, 30];

/** The stacked layout on the world map: a control sits in the row at the foot, just above the time bar (globals.css lifts the map's credit above it). */
const MAP_FOOT = "max-xl:in-data-on-map:top-auto max-xl:in-data-on-map:bottom-[76px]";

/**
 * On a phone the map style and the view buttons cannot share that row (the night theme's wider type
 * needs 411 px for both): the map style takes its own row above (globals.css lifts the credit over it).
 */
const MAP_STYLE_ROW = "max-[28rem]:in-data-on-map:bottom-[136px]";

/** The feed's status when the page is rendered on the server: nothing known yet, so LIVE. */
const SERVER_FEED: FeedStatus = { ageS: null, failed: false };

/** What a screen reader hears for each state, said once as it changes rather than every second the age counts. */
const SPOKEN: Record<LiveState, string> = { fresh: "LIVE", stale: "LIVE, feed delayed", offline: "Offline", replay: "LIVE" };

/**
 * The LIVE dot and its label, which carry the feed's state: green with a slow pulse while the data is
 * current, orange with the age once it is late, red and steady when it is offline, grey while replaying.
 * The pulse stops under reduced motion (globals.css).
 */
/** The channel's feed status as React state, counting its age every second. */
function useFeedStatus(channel: FeedChannel): FeedStatus {
  return useSyncExternalStore(watchFeed, () => currentFeedStatus(channel), () => SERVER_FEED);
}

/**
 * What the counts and lists have to go on, from the airport's feed status. The status changes every second (its age counts up), and the page
 * only needs the three-way answer: subscribed to that, a string, the page re-renders when the answer changes and not each second.
 */
export function useTrafficReadout(heard: boolean, tracked: number): TrafficReadout {
  return useSyncExternalStore(watchFeed, () => trafficReadout({ heard, tracked }, currentFeedStatus("airport")), () => trafficReadout({ heard, tracked }, SERVER_FEED));
}

function LiveButton({ live, onLive, className, channel }: { live: boolean; onLive?: () => void; className: string; channel: FeedChannel }) {
  const { state, label } = liveDot(useFeedStatus(channel), !live);
  // Pressed, the chip is the live colour only while the feed is current: a late or offline label in green would contradict its dot.
  const pressed = state === "fresh" ? "bg-chip text-chip-ink" : "bg-selected text-ink";
  return (
    <button type="button" aria-pressed={live} onClick={onLive} className={`${className} flex shrink-0 items-center font-semibold ${live ? pressed : "text-ink-2"}`}>
      <span data-live={state} className="flex items-center gap-2">
        <span aria-hidden className="live-dot size-[7px] shrink-0 rounded-full" />
        <span aria-hidden className="whitespace-nowrap tabular-nums">
          {label}
        </span>
        <span aria-live="polite" className="sr-only">
          {SPOKEN[state]}
        </span>
      </span>
    </button>
  );
}
const IDLE = "Replay builds up while the page is open";

/**
 * LIVE, the replay speeds and a scrubber over everything since the page opened. LIVE is pressed while
 * the picture is live; a speed while it plays at that speed; neither while a scrubbed-to moment plays
 * in real time.
 */
export function TimeBar({
  clock,
  zone = "",
  replay,
  onLive,
  onRate,
  onSeek,
  liveOnly = false,
  share,
}: {
  clock: string;
  /** The clock's time zone, "EDT": the airport's own, which need not be the reader's. */
  zone?: string;
  replay?: TimeBarReplay | null;
  /** On the world map: the replay is the diorama's, so only LIVE and the clock are shown. */
  liveOnly?: boolean;
  onLive?: () => void;
  onRate?: (rate: ReplayRate) => void;
  /** Seconds since the page's first snapshot. */
  onSeek?: (position: number) => void;
  /** The share button, at the bar's end. */
  share?: ReactNode;
}) {
  const live = replay?.live ?? true;
  // Nothing to scrub yet: the page has just opened, or shows a frozen moment.
  const idle = !replay || replay.span < 1;
  const chip = "min-h-11 min-w-11 rounded-[10px] px-2.5 text-sm max-[26rem]:px-2 sm:px-3 min-[1400px]:px-4 xl:min-h-10";
  return (
    <div
      data-map-foot
      className={`absolute inset-x-4 bottom-4 flex items-center gap-1 rounded-[14px] bg-surface p-1 xl:inset-x-auto xl:bottom-8 xl:left-1/2 xl:-translate-x-1/2 ${liveOnly ? "max-xl:right-auto" : ""} ${RING}`}
    >
      {/* On the map the dot is the map's region reads; in the diorama, the airport's feed. */}
      <LiveButton live={live} onLive={onLive} className={chip} channel={liveOnly ? "map" : "airport"} />
      {!liveOnly && RATES.map((rate) => {
        const on = !live && replay?.rate === rate;
        return (
          <button
            key={rate}
            type="button"
            aria-pressed={on}
            title={`Replay at ${rate} times speed`}
            onClick={() => onRate?.(rate)}
            className={`${chip} shrink-0 ${on ? "bg-chip font-semibold text-chip-ink" : "font-medium text-ink-2"}`}
          >
            {rate}x
          </button>
        );
      })}
      {/* A phone narrower than 24rem has no room for a track (the bar's other controls take it all at 44 px), so it keeps the rate chips and LIVE, which replay and return; from 24rem the track has 55 px or more. The title sits on a wrapper as well: a disabled input shows no tooltip of its own. The track is short at 1280, where the bar, centred, has the legend on its left: "LIVE · 27 s" and the night theme's wider type leave the two 11 px apart at least. */}
      <span title={idle ? IDLE : `Since ${replay!.since}`} className={`mx-1 min-w-0 flex-1 max-[24rem]:hidden sm:mx-2 xl:w-[100px] xl:flex-none min-[1400px]:w-[240px] ${liveOnly ? "hidden" : "flex"}`}>
        <input
          type="range"
          aria-label={idle ? "Replay since the page opened" : `Replay since the page opened at ${replay!.since}`}
          aria-valuetext={idle ? IDLE : clock}
          aria-disabled={idle}
          title={idle ? IDLE : undefined}
          min={0}
          max={idle ? 1 : Math.round(replay!.span)}
          step={1}
          // Idle, the thumb rests at the live end.
          value={idle ? 1 : Math.round(live ? replay!.span : replay!.position)}
          disabled={idle}
          onChange={(e) => onSeek?.(Number(e.currentTarget.value))}
          className="h-11 w-full min-w-0 cursor-pointer accent-ink xl:h-10 disabled:cursor-not-allowed disabled:accent-muted disabled:opacity-50"
        />
      </span>
      <div aria-hidden className={`h-6 w-px shrink-0 bg-hairline max-[26rem]:hidden ${liveOnly ? "ml-1" : ""}`} />
      <time title={zone ? `Local time at the airport (${zone})` : undefined} className="shrink-0 px-3 text-sm font-semibold tabular-nums max-[26rem]:px-2 xl:px-3.5">
        {clock}
        {/* Under 22rem the chips leave no room for it, and it is only read out. */}
        {zone && " "}
        {zone && <span className="text-[11px] font-medium text-muted max-[22rem]:sr-only">{zone}</span>}
      </time>
      {share}
    </div>
  );
}

const THEME_OPTIONS: { key: ThemeKey; label: string; short?: string }[] = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  // On a phone narrower than 24rem the night theme's mono type leaves the wind chip 11 px or less beside the full word on the row they share (aria-label keeps the name).
  { key: "satellite", label: "Satellite", short: "Sat" },
];

/**
 * Picks the map's style: the same model in another light. It sits under the counts on phones and at
 * the bottom right on wide screens, so the page renders it twice, `className` showing each copy only
 * in its own layout, and the keyboard reaches it where it is seen in both.
 */
export function ThemeSwitch({ theme, onChange, className }: { theme: ThemeKey; onChange: (theme: ThemeKey) => void; className: string }) {
  return (
    <div data-map-foot role="group" aria-label="Map style" className={`theme-switch absolute right-4 top-[184px] flex gap-1 rounded-full bg-surface p-1 xl:bottom-8 xl:right-8 xl:top-auto ${MAP_FOOT} ${MAP_STYLE_ROW} ${RAISED} ${className}`}>
      {THEME_OPTIONS.map(({ key, label, short }) => (
        <button
          key={key}
          type="button"
          aria-label={short ? label : undefined}
          aria-pressed={key === theme}
          onClick={() => onChange(key)}
          className={`min-h-11 min-w-11 rounded-full px-2 text-[13px] font-semibold min-[400px]:px-3 min-[400px]:text-sm xl:min-h-9 xl:px-4 ${key === theme ? "bg-accent text-on-accent" : "bg-transparent text-ink-2"}`}
        >
          {short ? (
            <>
              <span className="min-[24rem]:hidden">
                {short}
              </span>
              <span className="max-[24rem]:hidden">
                {label}
              </span>
            </>
          ) : (
            label
          )}
        </button>
      ))}
    </div>
  );
}
