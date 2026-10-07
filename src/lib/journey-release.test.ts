import { describe, expect, it } from "vitest";
import { LOST_MS } from "./journey-arrival";
import { journeyFrame, type ReaderAction, releasesJourney, restoresFollow } from "./journey-release";
import type { JourneyStage } from "./journey-follow";

const HEX = "a1b2c3";
const OTHER = "d4e5f6";

describe("releasesJourney: what the reader's own acts do to a journey", () => {
  it("ends it when Follow is toggled off, on the flight card or the journey card's Stop", () => {
    expect(releasesJourney({ kind: "unfollow" }, HEX)).toBe(true);
  });

  it("ends it when another flight is picked, by a click, the movements list or the search", () => {
    expect(releasesJourney({ kind: "pick", id: OTHER }, HEX)).toBe(true);
    expect(releasesJourney({ kind: "follow", id: OTHER }, HEX)).toBe(true);
  });

  it("ends it on a click on empty ground, which picks nothing", () => {
    expect(releasesJourney({ kind: "pick", id: null }, HEX)).toBe(true);
  });

  it("keeps it when the pick lands on the journey's own flight", () => {
    expect(releasesJourney({ kind: "pick", id: HEX }, HEX)).toBe(false);
    expect(releasesJourney({ kind: "follow", id: HEX }, HEX)).toBe(false);
  });

  it("ends it when the reader slides the view (a drag, a key pan, a place from the search) or picks another airport", () => {
    expect(releasesJourney({ kind: "slide" }, HEX)).toBe(true);
    expect(releasesJourney({ kind: "airport", to: "clt", here: "atl" }, HEX)).toBe(true);
  });

  it("keeps it when the airport picked is the one already shown: the pick goes nowhere", () => {
    expect(releasesJourney({ kind: "airport", to: "atl", here: "atl" }, HEX)).toBe(false);
  });

  it("ends it on Reset view, except in a camera mode, where Reset only goes back to the orbit", () => {
    expect(releasesJourney({ kind: "reset", inMode: false }, HEX)).toBe(true);
    expect(releasesJourney({ kind: "reset", inMode: true }, HEX)).toBe(false);
  });

  it("has nothing to end with no journey", () => {
    const acts: ReaderAction[] = [{ kind: "unfollow" }, { kind: "pick", id: null }, { kind: "slide" }, { kind: "airport", to: "clt", here: "atl" }];
    for (const act of acts) expect(releasesJourney(act, null)).toBe(false);
  });
});

describe("restoresFollow: a follow cleared for a reason that is not the reader's", () => {
  const base = { journey: { hex: HEX, stage: "origin" as JourneyStage }, followedId: null, drawn: true, cameraActive: false, mapLeads: false };

  /** The rule this replaces: the frame loop ended the journey whenever the follow was not the journey's flight. */
  const implicitStop = (j: { hex: string; stage: JourneyStage }, followedId: string | null, cameraActive: boolean) => j.stage !== "map" && followedId !== j.hex && !cameraActive;

  it("puts the follow back on the journey's flight once it is in the feed, and never ends the journey", () => {
    // A scene rebuilt by a theme switch, a Viewer remounted by a hand, a frame the feed had no fix for: the follow is null, the flight drawn.
    expect(restoresFollow(base)).toBe(true);
    // Regression: the old rule read exactly this state as the reader letting go.
    expect(implicitStop(base.journey, base.followedId, base.cameraActive)).toBe(true);
  });

  it("restores on the destination's diorama and at the gate too", () => {
    expect(restoresFollow({ ...base, journey: { hex: HEX, stage: "destination" } })).toBe(true);
    expect(restoresFollow({ ...base, journey: { hex: HEX, stage: "arrived" } })).toBe(true);
  });

  it("waits while the flight is not in this feed, a camera mode is in charge, or the map leads", () => {
    expect(restoresFollow({ ...base, drawn: false })).toBe(false);
    expect(restoresFollow({ ...base, cameraActive: true })).toBe(false);
    expect(restoresFollow({ ...base, mapLeads: true })).toBe(false);
    expect(restoresFollow({ ...base, journey: { hex: HEX, stage: "map" } })).toBe(false);
  });

  it("does nothing with no journey, or when something is already followed", () => {
    expect(restoresFollow({ ...base, journey: null })).toBe(false);
    expect(restoresFollow({ ...base, followedId: HEX })).toBe(false);
    expect(restoresFollow({ ...base, followedId: OTHER })).toBe(false);
  });
});

describe("journeyFrame: a journey whose flight has gone from every feed ends whatever the camera follows", () => {
  const lostMs = LOST_MS + 1;
  /** A fresh destination Viewer, or a scene rebuilt for a theme during a feed gap: the follow is null and the flight is not drawn. */
  const gap = { journey: { hex: HEX, stage: "destination" as JourneyStage, lostMs }, followedId: null, drawn: false, onGround: true, cameraActive: false, mapLeads: false };

  it("arrives at the destination with the follow cleared and the flight absent, which the follow-gated check never reached", () => {
    expect(journeyFrame(gap)).toEqual({ restore: false, lost: "arrive" });
  });

  it("lets go of a flight lost in the air, and waits for one lost on the ground at its origin", () => {
    expect(journeyFrame({ ...gap, onGround: false }).lost).toBe("release");
    expect(journeyFrame({ ...gap, journey: { hex: HEX, stage: "origin", lostMs }, onGround: false }).lost).toBe("release");
    expect(journeyFrame({ ...gap, journey: { hex: HEX, stage: "origin", lostMs } }).lost).toBe("hold");
  });

  it("holds through the hold and while the map has the journey, and judges under a camera mode too", () => {
    expect(journeyFrame({ ...gap, journey: { hex: HEX, stage: "destination", lostMs: LOST_MS } }).lost).toBe("hold");
    expect(journeyFrame({ ...gap, journey: { hex: HEX, stage: "map", lostMs } }).lost).toBe("hold");
    expect(journeyFrame({ ...gap, cameraActive: true }).lost).toBe("arrive");
  });

  it("restores the follow as restoresFollow does, and judges nothing with no journey", () => {
    expect(journeyFrame({ ...gap, drawn: true, journey: { hex: HEX, stage: "origin", lostMs: 0 } })).toEqual({ restore: true, lost: "hold" });
    expect(journeyFrame({ ...gap, journey: null })).toEqual({ restore: false, lost: "hold" });
  });
});
