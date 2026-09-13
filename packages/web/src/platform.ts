/**
 * The seam between the web UI and its host. v1 only
 * runs in a browser; an Electron shell would provide its own `Platform` and
 * everything above this file stays unchanged.
 */

export interface PlatformStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface Platform {
  /** Open a URL outside the app (new tab in a browser, system browser in Electron). */
  openExternal(url: string): void;
  /** Surface a notification when the page is not focused (e.g. an ask is pending). */
  notify(title: string, body?: string): void;
  /** Durable per-user key/value storage (composer drafts, UI prefs). */
  storage: PlatformStorage;
}

/** `localStorage` can throw (private mode, blocked site data) — degrade to no-ops. */
function browserStorage(): PlatformStorage {
  return {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // storage unavailable — drop the write
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // storage unavailable — nothing to remove
      }
    },
  };
}

export function createBrowserPlatform(): Platform {
  return {
    openExternal(url) {
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    notify(title, body) {
      if (typeof Notification === 'undefined' || document.hasFocus()) return;
      const show = (): void => {
        new Notification(title, body === undefined ? {} : { body });
      };
      if (Notification.permission === 'granted') show();
      else if (Notification.permission === 'default') {
        void Notification.requestPermission().then((p) => {
          if (p === 'granted') show();
        });
      }
    },
    storage: browserStorage(),
  };
}

export const platform: Platform = createBrowserPlatform();
