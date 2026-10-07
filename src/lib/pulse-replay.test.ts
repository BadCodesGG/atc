import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AirportMap } from "./airport-map";
import { DEFAULT_AIRPORT } from "./airports";
import { type OpsView, PathPulse } from "./path-pulse";
import { replayPulse } from "./pulse-replay";
import { readSequence } from "./sequence";
import { PLAYBACK_DELAY } from "./tracker";

const map = JSON.parse(readFileSync(path.join(import.meta.dirname, "../data/airports/atl.json"), "utf8")) as AirportMap;
/** About six minutes of live ATL traffic, polled every 15 s, recorded on 2026-10-01 from 03:18 UTC. */
const bytes = readFileSync(path.join(import.meta.dirname, "../../public/fixtures/atl-sequence.json.gz"));
const utc = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);

async function replay() {
  const snapshots = await readSequence(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), DEFAULT_AIRPORT);
  const ops = new PathPulse(map, { since: snapshots[0].time - PLAYBACK_DELAY, format: utc });
  const end = replayPulse(ops, snapshots, map, DEFAULT_AIRPORT);
  return ops.view(end - PLAYBACK_DELAY);
}

describe("replayPulse on the recorded ATL sequence", () => {
  let view: OpsView;
  beforeAll(async () => {
    view = await replay();
  });
  const event = (callsign: string, kind: string) => view.board.find((f) => f.callsign === callsign)?.events.find((e) => e.kind === kind);

  it("boards the takeoffs, landings and pushbacks that happened, with their times", () => {
    expect(event("DAL2224", "takeoff")).toEqual({ kind: "takeoff", time: "03:20", text: "Took off, runway 8R" });
    expect(event("LPE2483", "takeoff")?.text).toBe("Took off, runway 9L");
    expect(event("FFT3013", "landing")).toEqual({ kind: "landing", time: "03:20", text: "Landed, runway 9R" });
    expect(event("DAL3029", "pushback")?.text).toBe("Pushed back from gate B13");
  });

  it("counts this hour's movements from them", () => {
    expect(view).toMatchObject({ departures: 5, arrivals: 3 });
  });

  it("reads the runways in use from where flights actually took off and landed", () => {
    expect(view.runways.map((r) => [r.runway, r.role])).toEqual([
      ["8L", "Arrivals"],
      ["8R", "Arrivals and departures"],
      ["9L", "Departures"],
      ["9R", "Arrivals"],
    ]);
  });

  it("lists the flights with the latest news first", () => {
    const latest = view.board.map((f) => f.events[0].time);
    expect([...latest].sort().reverse()).toEqual(latest);
  });
});
