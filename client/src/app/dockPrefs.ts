/**
 * Dock member preferences — the bottom dock's default tab (what the app opens on).
 *
 * Whichever top-level tab the member is on IS the default: MainScreen records every change — dock
 * press, stage swipe or a programmatic jump alike — so leaving the app and coming back lands them
 * where they left off. (The dock no longer has a collapsed state — it is always on when on — so
 * only the tab is persisted.)
 *
 * Mirrors logPagePrefs.ts: in-memory mirror loaded once (synchronous reads before first paint —
 * AppRuntime.loadWorkspaceState switches the slot + eagerly loads on init/account-switch so there
 * is no flash of the wrong state), async best-effort writes, per-account (KeyRing slot) keys.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const TAB_KEY = 'stiq.dock.defaultTab';

export type DockTab = 'feed' | 'channels' | 'log';

let _slot: string | undefined;
const keyFor = (base: string): string => (_slot ? `${base}.${_slot}` : base);

let _loaded = false;
let _tab: DockTab = 'feed';
/** Bumped by every live tab change. A hydration read that started BEFORE one must not land after it
 *  and clobber the newer value with what was on disk — the member's current tab always wins. */
let _generation = 0;

/** Load persisted state into memory once. Safe to await repeatedly. */
export async function ensureDockPrefsLoaded(): Promise<void> {
  if (_loaded) return;
  _loaded = true;
  const gen = _generation;
  try {
    const rawTab = await AsyncStorage.getItem(keyFor(TAB_KEY));
    if (gen !== _generation) return; // superseded mid-read by a live tab change
    if (rawTab === 'feed' || rawTab === 'channels' || rawTab === 'log') _tab = rawTab;
  } catch {
    /* fresh state is fine */
  }
}

/** Switch the active account slot; drops the in-memory mirror so the next access reloads. */
export function setDockPrefsSlot(slotId: string | undefined): void {
  if (slotId === _slot) return;
  _slot = slotId;
  _loaded = false;
  _tab = 'feed';
  _generation++;
}

/** The tab the app opens on — the one the member was last on. Synchronous: call after load. */
export function dockDefaultTab(): DockTab {
  return _tab;
}

/**
 * Record the tab the member is now on. The in-memory mirror moves SYNCHRONOUSLY — a tab change can
 * be the last thing that happens before the process dies, and `dockDefaultTab()` is read
 * synchronously at mount, so the value must never sit behind an await. The disk write is
 * fire-and-forget: losing it costs one remembered tab, and blocking navigation on storage would
 * cost far more.
 */
export function setDockDefaultTab(tab: DockTab): void {
  if (tab === _tab) return;
  _tab = tab;
  _generation++;
  AsyncStorage.setItem(keyFor(TAB_KEY), tab).catch(() => {
    /* best effort */
  });
}
