import type { AirportMap } from "./airport-map";
import type { Airport } from "./airports";
import type { PathPulse } from "./path-pulse";
import { PLAYBACK_DELAY, Tracker } from "./tracker";
import type { TrafficSnapshot } from "./traffic";
import { TrafficView } from "./traffic-view";

/**
 * Plays a recorded run of snapshots (`?fixture=sequence`, read by `readSequence`) into the pulse, as
 * if the page had been open the whole time, so the board and the pulse show real pushbacks, takeoffs
 * and landings. It runs its own tracker and view, so nothing it remembers reaches the ones the page
 * draws with. Returns the last moment played. Pure apart from the time it takes: no network, no DOM.
 */

/** Seconds between the moments the pulse is shown: fine enough to catch each state change in a 15 s poll. */
const STEP = 1;

export function replayPulse(ops: PathPulse, snapshots: TrafficSnapshot[], map: AirportMap, airport: Airport): number {
  const tracker = new Tracker();
  const view = new TrafficView(map, airport);
  let end = 0;
  snapshots.forEach((snapshot, i) => {
    tracker.add(snapshot);
    view.addRoutes(snapshot.routes);
    const next = snapshots[i + 1]?.time ?? snapshot.time + STEP;
    for (let t = snapshot.time; t < next; t += STEP) {
      ops.observe(view.frame(tracker.at(t)).entries, t - PLAYBACK_DELAY);
      end = t;
    }
  });
  return end;
}
