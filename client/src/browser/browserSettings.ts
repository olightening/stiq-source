/**
 * The user's default browser — where "Open in my browser" sends a link. The value is a launch id:
 *   - Android: an application package name (e.g. "org.torproject.torbrowser", "com.brave.browser").
 *   - iOS:     a URL-scheme id we know how to open (e.g. "onionbrowser").
 * Empty means "not set", in which case the link goes to the OS default handler instead.
 *
 * This one value also decides whether the link dialog still offers "Open in a secure browser": once
 * the chosen default IS a Tor browser, the recommendation has nothing left to say (see
 * [[./linkOpen]]). That is why choosing one has to be possible from the dialog itself, not only from
 * Settings — hence the writer hook below.
 *
 * Same shape as [[../media/mediaSettings]]: a persisted value (SecureStorage) mirrored into a
 * module-level accessor so the app-root link dialog can read it synchronously without prop-drilling.
 */
import type {SecureStorage} from '../keys/keystore';

const PREFERRED_KEY = 'stiq.browser.preferred';

// Live value, read synchronously by the link dialog. Empty until the user picks one.
let currentPreferred = '';

// Persistent writer, bound by App.tsx to AppRuntime's store. Null in tests / before init, where
// choosePreferredBrowser still updates the live value so the UI stays truthful.
let writer: ((id: string) => void) | null = null;

/** The default-browser launch id in effect right now ('' = none chosen). */
export function getPreferredBrowser(): string {
  return currentPreferred;
}

/** Set the in-memory value only (no persistence). For the store and tests. */
export function setPreferredBrowserRuntime(id: string): void {
  currentPreferred = id.trim();
}

/** Bind the persistent writer (AppRuntime). Called by App.tsx; null on teardown. */
export function setPreferredBrowserWriter(fn: ((id: string) => void) | null): void {
  writer = fn;
}

/**
 * Change the default browser from anywhere in the tree (the link dialog's "Make default"). Applies
 * to the live accessor immediately — so the dialog re-renders against the new choice even when no
 * writer is bound — and persists through the bound writer.
 */
export function choosePreferredBrowser(id: string): void {
  const v = id.trim();
  setPreferredBrowserRuntime(v);
  writer?.(v);
}

/**
 * Persistent store for the user's preferred external browser. Owned by AppRuntime; loaded at init()
 * and updated when the user picks a browser in Settings.
 */
export class BrowserSettingsStore {
  constructor(private readonly storage: SecureStorage | null) {}

  /** Load the persisted preference into the live accessor (empty when unset). */
  async load(): Promise<void> {
    if (!this.storage) {
      setPreferredBrowserRuntime('');
      return;
    }
    try {
      const saved = await this.storage.getItem(PREFERRED_KEY);
      setPreferredBrowserRuntime(saved ?? '');
    } catch {
      setPreferredBrowserRuntime('');
    }
  }

  getPreferred(): string {
    return getPreferredBrowser();
  }

  /** Apply to the live accessor and persist. */
  async setPreferred(id: string): Promise<void> {
    const v = id.trim();
    setPreferredBrowserRuntime(v);
    await this.storage?.setItem(PREFERRED_KEY, v);
  }
}
