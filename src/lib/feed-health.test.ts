import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_ANSWER_MAX_S, feedStatus, liveDot, recordFeedAnswer, recordFeedFailure, startFeed, subscribeFeed, summariseReads, trafficReadout } from "./feed-health";

describe("the LIVE dot", () => {
  const live = (ageS: number | null, failed = false) => liveDot({ ageS, failed }, false);

  it("is green, pulsing slowly and says LIVE while the last good data is 15 s old or less", () => {
    expect(live(0)).toEqual({ state: "fresh", label: "LIVE" });
    expect(live(15)).toEqual({ state: "fresh", label: "LIVE" });
  });

  it("is orange and gives the real age from 15 to 90 s", () => {
    expect(live(16)).toEqual({ state: "stale", label: "LIVE · 16 s" });
    expect(live(25)).toEqual({ state: "stale", label: "LIVE · 25 s" });
    expect(live(90)).toEqual({ state: "stale", label: "LIVE · 90 s" });
  });

  it("is red and says Offline past 90 s, or on a 502 with nothing to serve", () => {
    expect(live(91)).toEqual({ state: "offline", label: "Offline" });
    expect(live(3, true)).toEqual({ state: "offline", label: "Offline" });
  });

  it("is LIVE before the first answer, while the feed is still connecting", () => {
    expect(live(null)).toEqual({ state: "fresh", label: "LIVE" });
  });

  it("is grey while replaying, whatever the feed is doing", () => {
    expect(liveDot({ ageS: 40, failed: true }, true)).toEqual({ state: "replay", label: "LIVE" });
  });
});

describe("the feed's health", () => {
  afterEach(() => {
    startFeed(0);
    startFeed(0, {}, "map");
  });

  it("counts the age from the last good data, taking a stale answer's own age", () => {
    startFeed(0);
    recordFeedAnswer({}, 1_000);
    expect(feedStatus(13_000)).toEqual({ ageS: 12, failed: false });
    recordFeedAnswer({ stale: true, ageS: 20 }, 14_000);
    expect(feedStatus(14_000)).toEqual({ ageS: 20, failed: false });
    expect(feedStatus(19_400)).toEqual({ ageS: 25, failed: false });
  });

  it("is failed after a 502 and clears on the next good answer", () => {
    startFeed(0);
    recordFeedFailure(502);
    expect(feedStatus(1_000).failed).toBe(true);
    recordFeedAnswer({}, 2_000);
    expect(feedStatus(2_000)).toEqual({ ageS: 0, failed: false });
  });

  it("lets other failures age the data rather than turning red at once", () => {
    startFeed(0);
    recordFeedAnswer({}, 0);
    recordFeedFailure(504);
    recordFeedFailure(null);
    expect(feedStatus(5_000)).toEqual({ ageS: 5, failed: false });
  });

  it("with no answer yet, says nothing of age while the first answer can still come", () => {
    startFeed(10_000);
    expect(feedStatus(10_000)).toEqual({ ageS: null, failed: false });
    expect(feedStatus(10_000 + FIRST_ANSWER_MAX_S * 1000)).toEqual({ ageS: null, failed: false });
  });

  it("with no answer by the slowest the server answers, goes Offline rather than counting to 90 s", () => {
    startFeed(10_000);
    const late = feedStatus(10_000 + (FIRST_ANSWER_MAX_S + 1) * 1000);
    expect(late).toEqual({ ageS: FIRST_ANSWER_MAX_S + 1, failed: true });
    expect(liveDot(late, false)).toEqual({ state: "offline", label: "Offline" });
    // A rate-limited poll is no answer: the client keeps polling every 5 s, and with none by then it is Offline.
    startFeed(0);
    recordFeedFailure(429);
    expect(liveDot(feedStatus(30_000), false).state).toBe("offline");
    // One answer, however late, brings it back.
    recordFeedAnswer({}, 60_000);
    expect(liveDot(feedStatus(61_000), false).state).toBe("fresh");
  });

  it("held, as on a frozen fixture, stays current however long the page is open", () => {
    startFeed(0, { hold: true });
    expect(feedStatus(600_000)).toEqual({ ageS: 0, failed: false });
  });

  it("can start already stale or offline, for the checks", () => {
    startFeed(100_000, { ageS: 25 });
    expect(feedStatus(100_000)).toEqual({ ageS: 25, failed: false });
    startFeed(0, { failed: true });
    expect(feedStatus(0).failed).toBe(true);
  });

  it("tells subscribers when an answer or failure is recorded", () => {
    const listener = vi.fn();
    const off = subscribeFeed(listener);
    recordFeedAnswer({}, 0);
    recordFeedFailure(502);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
    recordFeedFailure(502);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("the world map's feed", () => {
  afterEach(() => startFeed(0, {}, "map"));

  it("is kept apart from the airport's, so the diorama's polls never colour the map's dot", () => {
    startFeed(0);
    startFeed(0, { hold: true }, "map");
    recordFeedFailure(502);
    expect(feedStatus(1_000).failed).toBe(true);
    expect(feedStatus(1_000, "map")).toEqual({ ageS: 0, failed: false });
    startFeed(1_000, {}, "map");
    recordFeedAnswer({ stale: true, ageS: 40 }, 1_000, "map");
    expect(feedStatus(1_000, "map")).toEqual({ ageS: 40, failed: false });
    expect(feedStatus(1_000).failed).toBe(true);
  });

  it("held (zoomed out past the aircraft), stays current until a read fails with nothing to serve", () => {
    startFeed(0, { hold: true }, "map");
    expect(feedStatus(600_000, "map")).toEqual({ ageS: 0, failed: false });
    recordFeedFailure(502, "map");
    expect(liveDot(feedStatus(600_000, "map"), false).state).toBe("offline");
    recordFeedAnswer({}, 600_000, "map");
    expect(liveDot(feedStatus(600_000, "map"), false).state).toBe("fresh");
  });
});

describe("a round of reads, as one answer", () => {
  it("is the freshest of the answers that came back: the map's feed is live while any cell is, and one rate-limited cell does not turn it red", () => {
    expect(summariseReads([{ ok: true }, { ok: true, stale: true, ageS: 88 }, { ok: false, status: 502 }])).toEqual({ answer: { stale: false, ageS: 0 } });
    expect(summariseReads([{ ok: true, stale: true, ageS: 40 }, { ok: true, stale: true, ageS: 30 }])).toEqual({ answer: { stale: true, ageS: 30 } });
  });

  it("with nothing back, is a 502 if the server had nothing to serve, else a failure that lets the data age", () => {
    expect(summariseReads([{ ok: false, status: 502 }, { ok: false, status: null }])).toEqual({ failure: 502 });
    expect(summariseReads([{ ok: false, status: 504 }])).toEqual({ failure: 504 });
    expect(summariseReads([{ ok: false, status: null }])).toEqual({ failure: null });
  });

  it("is nothing when nothing was read", () => {
    expect(summariseReads([])).toBeNull();
  });
});

describe("after the tab was hidden", () => {
  it("a fixture's feed, held current, is fresh however long the page sat hidden", () => {
    startFeed(0, { hold: true });
    expect(liveDot(feedStatus(30 * 60_000), false).state).toBe("fresh");
  });

  it("a live feed shows its true age on return, and is fresh again on the first answer", () => {
    startFeed(0);
    recordFeedAnswer({}, 1_000);
    // Ten minutes hidden, the throttled poll never ran: the dot says so.
    expect(liveDot(feedStatus(601_000), false).state).toBe("offline");
    // Back in view the page reads at once (FeedSource.every), and one answer brings it back.
    recordFeedAnswer({}, 601_500);
    expect(liveDot(feedStatus(602_000), false).state).toBe("fresh");
  });
});

describe("what the counts and lists can say", () => {
  const readout = (heard: boolean, tracked: number, ageS: number | null = null, failed = false) => trafficReadout({ heard, tracked }, { ageS, failed });

  it("is loading before the first answer while the feed is connecting, so the counts do not read a false zero", () => {
    expect(readout(false, 0)).toBe("loading");
    expect(readout(false, 0, 12)).toBe("loading");
  });

  it("is offline with no answer and the feed failing or silent past 90 s, so there is nothing to count", () => {
    expect(readout(false, 0, null, true)).toBe("offline");
    expect(readout(false, 0, 95)).toBe("offline");
  });

  it("is ready once an answer has come and aircraft are tracked, whatever the dot says", () => {
    expect(readout(true, 12)).toBe("ready");
    expect(readout(true, 12, 25)).toBe("ready");
    // A fixture can read offline with its recording on show: what is drawn is counted.
    expect(readout(true, 12, 3, true)).toBe("ready");
  });

  it("is ready with a genuinely empty sky once the feed has answered", () => {
    expect(readout(true, 0)).toBe("ready");
    expect(readout(true, 0, 30)).toBe("ready");
  });

  it("is offline when the feed went dark after an answer and the last aircraft have gone", () => {
    expect(readout(true, 0, null, true)).toBe("offline");
    expect(readout(true, 0, 120)).toBe("offline");
  });
});
