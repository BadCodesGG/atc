import { useCallback, useEffect, useState } from "react";
import { nextRadarRead, parseRadarIndex, RADAR_INDEX_URL, radarAge, type RadarFrame } from "@/lib/radar";

/** The weather radar layer's switch and the frame it draws. Nothing is asked of RainViewer until the reader turns the layer on. */
export interface RadarControl {
  on: boolean;
  /** `unavailable` only while there is no frame to show: a late read after one keeps the last. */
  status: "off" | "loading" | "ready" | "unavailable";
  /** The frame to draw; null while off, loading or unavailable. */
  frame: RadarFrame | null;
  /** How old that frame is, "6 min ago", kept current; null with no frame. */
  age: string | null;
  toggle: () => void;
}

export function useRadar(): RadarControl {
  const [on, setOn] = useState(false);
  const [frame, setFrame] = useState<RadarFrame | null>(null);
  const [failed, setFailed] = useState(false);
  // The clock the age is read against: moved on every half minute while the layer is on.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!on) return;
    const ctl = new AbortController();
    let timer = 0;
    // Reads the index, and again after nextRadarRead(): a failure keeps the frame it already has.
    const read = async (have: boolean) => {
      let haveNow = have;
      try {
        const res = await fetch(RADAR_INDEX_URL, { signal: ctl.signal });
        if (!res.ok) throw new Error(`radar index ${res.status}`);
        const next = parseRadarIndex(await res.json(), Date.now() / 1000);
        if (!next) throw new Error("no current radar frame");
        setFrame(next);
        setNow(Date.now());
        setFailed(false);
        haveNow = true;
      } catch {
        if (ctl.signal.aborted) return;
        if (!haveNow) setFailed(true);
      }
      timer = window.setTimeout(() => void read(haveNow), nextRadarRead(haveNow));
    };
    void read(false);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      window.clearInterval(tick);
      ctl.abort();
      window.clearTimeout(timer);
    };
  }, [on]);

  const toggle = useCallback(() => {
    // Off clears what was read, so turning it back on starts from the current weather.
    setOn((was) => !was);
    setFrame(null);
    setFailed(false);
  }, []);

  return { on, status: !on ? "off" : frame ? "ready" : failed ? "unavailable" : "loading", frame: on ? frame : null, age: on && frame ? radarAge(frame.time, now / 1000) : null, toggle };
}
