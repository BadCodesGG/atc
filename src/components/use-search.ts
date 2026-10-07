import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AirportMap, Point } from "@/lib/airport-map";
import type { Airport } from "@/lib/airports";
import { type OrbitView, pan, zoom } from "@/lib/scene/orbit";
import type { AirportScene } from "@/lib/scene/airport-scene";
import { buildPlaces, flightDocs, type PlaceDoc } from "@/lib/search";
import type { TrafficEntry } from "@/lib/traffic-view";
import type { SearchProps } from "./search-box";

/**
 * What the header search does to the page: select or follow a flight, ease the camera to a gate or
 * runway and label it, and switch airports. The page hands over the refs its own buttons drive and its
 * own actions, so a search pick behaves like a click on the model.
 */

/**
 * How far out the camera stops over a gate or stand, metres, and the least it looks down by, degrees:
 * far enough that the gate's neighbours and its concourse are in view to place it by, steep enough that
 * the concourse does not hide it. A runway is framed by its length.
 */
export const PLACE_DISTANCE = 2400;
const PLACE_ELEVATION = 55;
const RUNWAY_FRAMING = 0.9;
/** How long a picked place's ring glows, ms; its name stays until the view is moved. */
const LIT_MS = 3_600;
/** How long a switched-to airport waits for a flight to appear in the feed, and how often it looks. */
const FLIGHT_WAIT_MS = 20_000;
const FLIGHT_POLL_MS = 500;

type Goal = { to: OrbitView | "home"; from: OrbitView | null; start: number };

export interface SearchHost {
  /** The airport's ground plan; null until it has loaded. */
  map: AirportMap | null;
  /**
   * What the draw loop drew last: the live traffic, or the replay's while replaying. Read, never worked
   * out again here, as a second `TrafficView.frame()` would advance the view's own state.
   */
  entriesRef: RefObject<TrafficEntry[]>;
  sceneRef: RefObject<AirportScene | null>;
  /** The layer the scene's labels sit on, which the picked place is drawn into. */
  labelsRef: RefObject<HTMLDivElement | null>;
  goalRef: RefObject<Goal | null>;
  /** Where the orbit camera rests; a picked place's name goes when this moves on. */
  viewRef: RefObject<OrbitView | null>;
  followRef: RefObject<unknown>;
  refreshRef: RefObject<boolean>;
  /** Selects a flight, and follows it when asked, as the page's own controls do. */
  onFlight: (id: string, follow: boolean) => void;
  /** Leaves a camera mode for the orbit, so the camera can be moved to a place. */
  leaveCamera: () => void;
  /** Switches the page to another airport, selecting `flight` there once it is in the feed. */
  onAirport: (code: Airport["code"], flight?: string) => void;
}

export function useSearch({ map, entriesRef, sceneRef, labelsRef, goalRef, viewRef, followRef, refreshRef, onFlight, leaveCamera, onAirport }: SearchHost): SearchProps {
  const places = useMemo(() => (map ? buildPlaces(map) : []), [map]);
  const [lit, setLit] = useState<{ place: PlaceDoc; goal: Goal } | null>(null);
  // The page's own action, which it makes anew each render; the arrival below reads the latest.
  const onFlightRef = useRef(onFlight);
  useEffect(() => {
    onFlightRef.current = onFlight;
  });

  // What is drawn now: the search finds what the reader can see, replaying or live.
  const read = useCallback(() => (map ? { here: map.code, places, flights: flightDocs(entriesRef.current) } : null), [map, places, entriesRef]);

  const onPlace = useCallback(
    (place: PlaceDoc) => {
      const scene = sceneRef.current;
      if (!scene) return;
      leaveCamera();
      const xs = place.points.map((p) => p[0]);
      const ys = place.points.map((p) => p[1]);
      const centre: Point = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      const length = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      const from = scene.currentView;
      const slid = pan(from, centre[0] - from.target[0], centre[1] - from.target[1], scene.bounds);
      const wanted = place.kind === "runway" ? length * RUNWAY_FRAMING : PLACE_DISTANCE;
      followRef.current = null;
      const goal: Goal = { to: zoom({ ...slid, height: 0, elevationDeg: Math.max(slid.elevationDeg, PLACE_ELEVATION) }, wanted / slid.distance, scene.bounds), from: null, start: 0 };
      goalRef.current = goal;
      refreshRef.current = true;
      setLit({ place, goal });
    },
    [sceneRef, followRef, goalRef, refreshRef, leaveCamera],
  );

  // A picked place glows for a few seconds (a ring on a gate, a bar along a runway) and is named, drawn
  // on the labels layer and kept on the ground as the camera eases there. The name stays while the
  // camera is on its way or resting where the search put it, and goes when the reader moves the view.
  useEffect(() => {
    const layer = labelsRef.current;
    if (!lit || !layer) return;
    const { place, goal } = lit;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "pointer-events-none absolute inset-0 size-full overflow-visible");
    const stroke = "fill:none;stroke:var(--color-taxiing);stroke-linecap:round";
    const shape = document.createElementNS(NS, place.points.length > 1 ? "line" : "circle");
    shape.setAttribute("style", `${stroke};stroke-width:${place.points.length > 1 ? 7 : 3.5};opacity:0.9`);
    if (place.points.length === 1) shape.setAttribute("r", "16");
    svg.appendChild(shape);
    layer.appendChild(svg);
    const name = document.createElement("div");
    name.dataset.searchPlace = place.ref;
    name.textContent = place.label;
    name.className = "scene-label absolute left-0 top-0 whitespace-nowrap text-[13px] font-bold tracking-[0.04em] text-ink will-change-transform";
    layer.appendChild(name);
    const fade = svg.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: LIT_MS, fill: "forwards" });
    let frame = 0;
    const track = () => {
      frame = requestAnimationFrame(track);
      const scene = sceneRef.current;
      if (!scene) return;
      if (goalRef.current !== goal && viewRef.current !== goal.to) {
        setLit(null);
        return;
      }
      const [a, b] = place.points.map((p) => scene.project(p[0], p[1], 0));
      if (b) {
        // A runway is longer than the view: its ends may be off screen while its middle is not, and the layer clips the rest.
        shape.setAttribute("x1", String(a.x));
        shape.setAttribute("y1", String(a.y));
        shape.setAttribute("x2", String(b.x));
        shape.setAttribute("y2", String(b.y));
      } else {
        shape.setAttribute("visibility", a.visible ? "visible" : "hidden");
        shape.setAttribute("cx", String(a.x));
        shape.setAttribute("cy", String(a.y));
      }
      // The name sits above the ring, or above the middle of a runway's bar.
      const x = b ? (a.x + b.x) / 2 : a.x;
      const y = (b ? (a.y + b.y) / 2 : a.y) - (b ? 14 : 24);
      name.style.visibility = b || a.visible ? "visible" : "hidden";
      name.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    };
    track();
    return () => {
      cancelAnimationFrame(frame);
      fade.cancel();
      svg.remove();
      name.remove();
    };
  }, [lit, labelsRef, sceneRef, goalRef, viewRef]);

  // Arriving from a flight search at another airport (`?flight=DAL3104`): select that flight once the
  // draw loop shows it, then drop the parameter so a reload does not do it again.
  useEffect(() => {
    if (!map) return;
    const wanted = new URLSearchParams(window.location.search).get("flight")?.toUpperCase();
    if (!wanted) return;
    const end = Date.now() + FLIGHT_WAIT_MS;
    const timer = window.setInterval(() => {
      const found = entriesRef.current.find((e) => (e.aircraft.callsign ?? e.aircraft.id.toUpperCase()) === wanted);
      if (!found && Date.now() < end) return;
      window.clearInterval(timer);
      if (found) onFlightRef.current(found.aircraft.id, false);
      const url = new URL(window.location.href);
      url.searchParams.delete("flight");
      window.history.replaceState(window.history.state, "", url);
    }, FLIGHT_POLL_MS);
    return () => window.clearInterval(timer);
  }, [map, entriesRef]);

  return { read, onFlight, onPlace, onAirport: (code) => onAirport(code), onRemote: (callsign, code) => onAirport(code, callsign) };
}
