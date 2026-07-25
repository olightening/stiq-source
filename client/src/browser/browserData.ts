/**
 * Thin JS wrappers over the native browser launcher (StiqWebProxy), plus the catalogue of browsers
 * that keep a visit inside Tor.
 *
 * STIQ has no in-app browser: a link is handed to a real browser or it is not opened at all. This
 * module is what the link dialog and Settings both ask "which browsers are on this device, and which
 * of them are anonymous". All native calls fail soft: on a non-Android build or a missing method
 * they no-op / return empty, never throw.
 */
import {NativeModules} from 'react-native';

/** An installed browser the user can hand a link off to. `id` = package (Android) / scheme (iOS). */
export interface InstalledBrowser {
  id: string;
  label: string;
}

interface WebProxyNative {
  listInstalledBrowsers?(): Promise<Array<{package: string; label: string}>>;
  isAppInstalled?(id: string): Promise<boolean>;
  openInApp?(url: string, id: string): Promise<boolean>;
}

function webProxy(): WebProxyNative | undefined {
  return (NativeModules as {StiqWebProxy?: WebProxyNative}).StiqWebProxy;
}

/**
 * A browser that keeps the visit inside Tor — the "Open in a secure browser" catalogue.
 *
 * These are the only browsers STIQ names, because they are the only ones that answer the question
 * the dialog is really asking: will this site see my real address? A privacy-hardened clearnet
 * browser blocks trackers but still hands the site the reader's IP, so listing one here would sell
 * an anonymity it cannot deliver.
 */
export interface SecureBrowser {
  /** Launch id: Android package name / iOS URL-scheme id. Also the stored preference value. */
  id: string;
  label: string;
  blurb: string;
  /** Platform this entry is offered on (an Android package is not installable on iOS). */
  platform: 'android' | 'ios';
  /** Store deep link, tried first when installing (Android). */
  storeUrl?: string;
  /** Download page — the fallback when no store handles storeUrl, and the only iOS path. */
  siteUrl: string;
}

export const SECURE_BROWSERS: SecureBrowser[] = [
  {
    id: 'org.torproject.torbrowser',
    label: 'Tor Browser',
    blurb: 'Routes every page through Tor. The recommended way to open a link.',
    platform: 'android',
    storeUrl: 'market://details?id=org.torproject.torbrowser',
    siteUrl: 'https://www.torproject.org/download/',
  },
  {
    id: 'org.torproject.torbrowser_alpha',
    label: 'Tor Browser (Alpha)',
    blurb: 'The alpha channel of Tor Browser for Android.',
    platform: 'android',
    storeUrl: 'market://details?id=org.torproject.torbrowser_alpha',
    siteUrl: 'https://www.torproject.org/download/alpha/',
  },
  {
    id: 'onionbrowser',
    label: 'Onion Browser',
    blurb: 'Tor for iOS, from the Guardian Project.',
    platform: 'ios',
    siteUrl: 'https://onionbrowser.com/',
  },
];

/** Launch ids of every Tor-capable browser STIQ knows about. */
export const TOR_BROWSER_IDS: string[] = SECURE_BROWSERS.map(b => b.id);

export function isTorBrowserId(id: string): boolean {
  return TOR_BROWSER_IDS.includes(id);
}

/** List installed browsers (Android: any https-VIEW handler). Empty when unavailable. */
export async function listInstalledBrowsers(): Promise<InstalledBrowser[]> {
  try {
    const list = await webProxy()?.listInstalledBrowsers?.();
    return (list ?? []).map(b => ({id: b.package, label: b.label}));
  } catch {
    return [];
  }
}

/** Whether a specific browser (by launch id) is installed. */
export async function isBrowserInstalled(id: string): Promise<boolean> {
  if (!id) {
    return false;
  }
  try {
    return (await webProxy()?.isAppInstalled?.(id)) ?? false;
  } catch {
    return false;
  }
}

/** Launch a URL in a specific external browser. Resolves false if it couldn't be opened. */
export async function openInBrowser(url: string, id: string): Promise<boolean> {
  try {
    return (await webProxy()?.openInApp?.(url, id)) ?? false;
  } catch {
    return false;
  }
}

/** The first installed Tor-capable browser id, or null. */
export async function installedTorBrowser(): Promise<string | null> {
  for (const id of TOR_BROWSER_IDS) {
    if (await isBrowserInstalled(id)) {
      return id;
    }
  }
  return null;
}
