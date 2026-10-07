import { describe, expect, it } from "vitest";
import { type Alert, AlertDetector } from "./alerts";
import { ALERT_FIXTURES, fixtureScript } from "./alert-fixtures";

/** Plays a script through a fresh detector the way the page does, collecting what it says. */
function play(name: string): Alert[] {
  const script = fixtureScript(name)!;
  const detector = new AlertDetector();
  const watched = new Set(script.watched);
  return script.steps.flatMap((step) => detector.observe(step.time, step.list, watched));
}

describe("fixtureScript", () => {
  it("knows each alert kind and 'all', and nothing else", () => {
    expect(ALERT_FIXTURES).toEqual(["pushback", "takeoff", "landing", "emergency", "military", "all"]);
    expect(fixtureScript("nope")).toBeNull();
    expect(fixtureScript("")).toBeNull();
  });

  it.each(["pushback", "takeoff", "landing", "emergency", "military"] as const)("%s: makes the detector say exactly one alert of that kind, however many polls the script runs", (kind) => {
    const alerts = play(kind);
    expect(alerts.map((a) => a.kind)).toEqual([kind]);
    expect(fixtureScript(kind)!.steps.length).toBeGreaterThan(3);
  });

  it("all: says each kind once, in turn", () => {
    expect(play("all").map((a) => a.kind)).toEqual(["pushback", "takeoff", "landing", "emergency", "military"]);
  });

  it("runs forward in feed time", () => {
    for (const name of ALERT_FIXTURES) {
      const times = fixtureScript(name)!.steps.map((s) => s.time);
      expect(times, name).toEqual([...times].sort((a, b) => a - b));
    }
  });
});
