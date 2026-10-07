import { afterEach, describe, expect, it, vi } from "vitest";
import { alertsMessage, alertsState, storedOptIn, storeOptIn } from "./notify";

describe("alertsState", () => {
  it("is unsupported where the browser has no Notification API, whatever else is stored", () => {
    expect(alertsState({ permission: null, stored: true })).toBe("unsupported");
  });

  it("is blocked once the reader has denied notifications, even if alerts were left on", () => {
    expect(alertsState({ permission: "denied", stored: true })).toBe("blocked");
    expect(alertsState({ permission: "denied", stored: false })).toBe("blocked");
  });

  it("is on only with both the reader's opt-in and the browser's permission", () => {
    expect(alertsState({ permission: "granted", stored: true })).toBe("on");
    expect(alertsState({ permission: "granted", stored: false })).toBe("off");
    expect(alertsState({ permission: "default", stored: true })).toBe("off");
    expect(alertsState({ permission: "default", stored: false })).toBe("off");
  });
});

describe("alertsMessage", () => {
  it("says plainly that the browser cannot do alerts", () => {
    expect(alertsMessage("unsupported")).toBe("This browser does not support notifications, so alerts are not available here.");
  });

  it("says plainly that notifications are blocked and what to do", () => {
    expect(alertsMessage("blocked")).toBe("Notifications are blocked for this site. Allow them in your browser's site settings, then reload the page.");
  });

  it("names what the alerts are, and that they need the page open, when they are off and when they are on", () => {
    for (const state of ["off", "on"] as const) {
      const text = alertsMessage(state);
      expect(text).toContain("pushes back, takes off or lands");
      expect(text).toContain("7700, 7600 or 7500");
      expect(text).toContain("military");
      expect(text).toContain("while this page is open");
    }
  });
});

describe("the stored opt-in", () => {
  /** A Map-backed localStorage, since the unit tests run in Node. */
  function stubStorage(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    const localStorage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    vi.stubGlobal("window", { localStorage });
    return data;
  }

  afterEach(() => vi.unstubAllGlobals());

  it("is off with nothing stored", () => {
    stubStorage();
    expect(storedOptIn()).toBe(false);
  });

  it("reads and writes the atc-alerts key", () => {
    const data = stubStorage();
    storeOptIn(true);
    expect(data.get("atc-alerts")).toBe("on");
    expect(storedOptIn()).toBe(true);
  });

  it("carries a reader's opt-in over from the old apron-alerts key, and removes the old one", () => {
    const data = stubStorage({ "apron-alerts": "on" });
    expect(storedOptIn()).toBe(true);
    expect(data.get("atc-alerts")).toBe("on");
    expect(data.has("apron-alerts")).toBe(false);
  });

  it("carries over an old opt-out too", () => {
    const data = stubStorage({ "apron-alerts": "off" });
    expect(storedOptIn()).toBe(false);
    expect(data.get("atc-alerts")).toBe("off");
    expect(data.has("apron-alerts")).toBe(false);
  });

  it("never lets the old key override a choice already made under the new one", () => {
    const data = stubStorage({ "apron-alerts": "on", "atc-alerts": "off" });
    expect(storedOptIn()).toBe(false);
    expect(data.get("atc-alerts")).toBe("off");
  });
});
