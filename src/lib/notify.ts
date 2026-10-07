import type { Alert } from "./alerts";

/**
 * Browser alerts through the Notification API. Asking for permission is the reader's act and only ever
 * runs from a click (the control in the header); nothing here asks, or notifies, on its own.
 */

export type AlertsState = "unsupported" | "blocked" | "off" | "on";

/**
 * Where the alerts stand: `permission` is the browser's (null where there is no Notification API) and
 * `stored` is whether the reader turned them on here. Both are needed, so permission granted for some
 * other reason does not turn them on, and permission taken away turns them off.
 */
export function alertsState({ permission, stored }: { permission: NotificationPermission | null; stored: boolean }): AlertsState {
  if (permission === null) return "unsupported";
  if (permission === "denied") return "blocked";
  return permission === "granted" && stored ? "on" : "off";
}

const WHAT =
  "You get a notification when a flight you follow pushes back, takes off or lands, when an aircraft in view squawks 7700, 7600 or 7500, or when a military aircraft enters the area. Alerts only arrive while this page is open.";

/** What the alerts control says in each state. */
export function alertsMessage(state: AlertsState): string {
  switch (state) {
    case "unsupported":
      return "This browser does not support notifications, so alerts are not available here.";
    case "blocked":
      return "Notifications are blocked for this site. Allow them in your browser's site settings, then reload the page.";
    case "on":
      return `Alerts are on. ${WHAT}`;
    case "off":
      return `Alerts are off. ${WHAT}`;
  }
}

const KEY = "atc-alerts";
/** What the key was called before the product was renamed; read once, copied to KEY, then removed. */
const LEGACY_KEY = "apron-alerts";

/** The browser's permission, or null without the API. Read, never asked. */
export function currentPermission(): NotificationPermission | null {
  return typeof Notification === "undefined" ? null : Notification.permission;
}

export function storedOptIn(): boolean {
  try {
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy !== null) {
      // A choice already made under the new key wins; the old one is dropped either way.
      if (window.localStorage.getItem(KEY) === null) window.localStorage.setItem(KEY, legacy);
      window.localStorage.removeItem(LEGACY_KEY);
    }
    return window.localStorage.getItem(KEY) === "on";
  } catch {
    return false;
  }
}

export function storeOptIn(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Without storage the opt-in lasts the page's life only.
  }
}

/** Asks the browser for permission. Only ever called from the reader's click. */
export async function askPermission(): Promise<NotificationPermission | null> {
  if (typeof Notification === "undefined") return null;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Shows one alert. The tag lets the system replace a notification it already shows for the same event. */
export function showAlert(alert: Alert): void {
  try {
    new Notification(alert.title, { body: alert.body, tag: `${alert.kind}:${alert.id}`, icon: "/favicon.ico" });
  } catch {
    // Some mobile browsers have the constructor but refuse it; there is nothing else to show it with.
  }
}
