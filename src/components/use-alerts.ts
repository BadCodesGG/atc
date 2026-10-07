import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { fixtureScript } from "@/lib/alert-fixtures";
import { type Alert, AlertDetector, type Sighting } from "@/lib/alerts";

type Listed = Omit<Sighting, "squawk" | "military">;
import { type AlertsState, alertsState, askPermission, currentPermission, showAlert, storedOptIn, storeOptIn } from "@/lib/notify";
import { EMERGENCY_SQUAWKS } from "@/lib/squawk";

/** How often the emergency squawks are read while alerts are on, ms: the feed behind them holds an answer for four seconds. */
const SQUAWK_MS = 30_000;
/** How often a fixture script's next list is played, ms. */
const SCRIPT_MS = 250;

export interface AlertsControl {
  state: AlertsState;
  /** Turns alerts on (asking the browser for permission, which must come from a click) or off. */
  toggle: () => void;
  /** The airport's feed, each poll: what changed for the followed flights, any emergency, military arriving. */
  feed: (time: number, list: Sighting[], watched: ReadonlySet<string>) => void;
  /** The map's view, while it leads: military aircraft that fly into it. `number` changes each time the map is moved. */
  view: (time: number, list: readonly Pick<Sighting, "id" | "callsign" | "typeCode">[], number: number) => void;
}

// The state is two things outside React (the browser's permission and the reader's stored opt-in), so it is read as an external store.
const listeners = new Set<() => void>();
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // A permission changed in the browser's own settings is noticed when the reader comes back to the page.
  window.addEventListener("focus", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("focus", listener);
  };
}
const changed = () => listeners.forEach((l) => l());
const read = (): AlertsState => alertsState({ permission: currentPermission(), stored: storedOptIn() });

/**
 * Browser alerts: opt-in from the control, never asked on load. While they are on, the airport's feed
 * (via `feed`) and the emergency squawks in `inArea` go through one detector, which says each event once;
 * `?alerts=` on a fixture plays a script through it instead of any feed.
 */
export function useAlerts(inArea: (latitude: number, longitude: number) => boolean): AlertsControl {
  const state = useSyncExternalStore(subscribe, read, () => "off" as const);
  const on = state === "on";
  const detector = useRef<AlertDetector | null>(null);
  const scripted = useRef(false);
  const area = useRef(inArea);
  useEffect(() => {
    area.current = inArea;
  });

  useEffect(() => {
    if (!on) return;
    // Each time alerts are turned on is a new baseline: what is already there is not news.
    const d = new AlertDetector();
    detector.current = d;
    const params = new URLSearchParams(window.location.search);
    const script = fixtureScript(params.get("alerts") ?? "");
    const say = (alerts: Alert[]) => alerts.forEach(showAlert);
    let timer = 0;
    let stopped = false;
    if (script) {
      scripted.current = true;
      const watched = new Set(script.watched);
      let i = 0;
      timer = window.setInterval(() => {
        const step = script.steps[i++];
        if (step) say(d.observe(step.time, step.list, watched));
        else window.clearInterval(timer);
      }, SCRIPT_MS);
    } else if (!params.has("fixture")) {
      // A fixture reads no network. Live, the three codes are read in turn, and kept to the area on show.
      const poll = async () => {
        for (const code of EMERGENCY_SQUAWKS) {
          try {
            const res = await fetch(`/api/squawk/${code}`);
            if (!res.ok || stopped) continue;
            const body = (await res.json()) as { time?: unknown; aircraft?: Listed[] };
            if (typeof body.time !== "number" || !Array.isArray(body.aircraft)) continue;
            say(d.observeSquawks(body.time, code, body.aircraft.filter((a) => area.current(a.latitude, a.longitude))));
          } catch {
            // The next read tries again; the airport's own feed still carries what is near it.
          }
        }
      };
      void poll();
      timer = window.setInterval(() => void poll(), SQUAWK_MS);
    }
    return () => {
      stopped = true;
      window.clearInterval(timer);
      scripted.current = false;
      if (detector.current === d) detector.current = null;
    };
  }, [on]);

  const feed = useCallback((time: number, list: Sighting[], watched: ReadonlySet<string>) => {
    if (scripted.current) return;
    detector.current?.observe(time, list, watched).forEach(showAlert);
  }, []);

  const view = useCallback((time: number, list: readonly Pick<Sighting, "id" | "callsign" | "typeCode">[], number: number) => {
    if (scripted.current) return;
    detector.current?.observeView(time, list, number).forEach(showAlert);
  }, []);

  const toggle = useCallback(() => {
    void (async () => {
      if (state === "on") storeOptIn(false);
      else if (state === "off") {
        // The one place permission is asked for: this runs from the reader's click.
        if ((await askPermission()) === "granted") storeOptIn(true);
      }
      changed();
    })();
  }, [state]);

  return { state, toggle, feed, view };
}
