/**
 * Feed-sort member preference — the Rising/New choice for the main feed.
 *
 * The choice must (a) survive an app restart and (b) be readable SYNCHRONOUSLY on the feed's very
 * first paint, so the sort bar and the feed's first arrangement never flash the default 'new' before
 * the stored 'hot' loads. That rules out the approach this replaces — a `useState('new')` plus an
 * async `getItem` INSIDE MainScreen, which paints the default first and corrects a frame later. On a
 * cold, Tor-connecting start (the JS thread heavily contended) that async read lands late and the
 * fire-and-forget write can be lost, so the member sees 'new' and reads it as "the app forgot my
 * sort". So this uses the same contract as {@link dockPrefs} / {@link logPagePrefs}: an in-memory
 * mirror loaded once (AppRuntime.loadWorkspaceState eagerly loads it on init AND every account switch,
 * before the splash lifts), synchronous reads, and best-effort async writes, keyed per identity slot.
 *
 * 'top' is deliberately NOT a feed sort — it is search-only (MainScreen.searchSort) and never
 * persisted, so only 'hot' | 'new' are ever stored or returned here.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

/** The persisted feed sort — the search-only 'top' is excluded by construction. */
export type FeedSort = 'hot' | 'new';

const SORT_KEY = 'stiq_sort_mode';
/**
 * Legacy GLOBAL key written by the pre-mirror MainScreen (a single un-slotted `stiq_sort_mode`).
 * Read once as a fallback when this slot has no per-slot value yet, so a member updating from that
 * build keeps the sort they already chose; their first per-slot write then supersedes it. It is the
 * same base string as SORT_KEY, but `keyFor` appends the slot to the per-slot one, so they differ.
 */
const LEGACY_KEY = SORT_KEY;

let _slot: string | undefined;
const keyFor = (base: string): string => (_slot ? `${base}.${_slot}` : base);

let _loaded = false;
let _sort: FeedSort = 'new';
/** Bumped by every live change. A hydration read that started BEFORE one must not land after it and
 *  clobber the newer value with what was on disk — the member's current choice always wins. */
let _generation = 0;

const isFeedSort = (v: unknown): v is FeedSort => v === 'hot' || v === 'new';

/** Load persisted state into memory once. Safe to await repeatedly. */
export async function ensureFeedSortPrefsLoaded(): Promise<void> {
  if (_loaded) { return; }
  _loaded = true;
  const gen = _generation;
  try {
    let raw = await AsyncStorage.getItem(keyFor(SORT_KEY));
    // One-time carry-over: a member updating from the pre-per-slot build has their choice under the
    // bare global key. Adopt it when this slot has none yet (only meaningful once a slot is set).
    if (raw === null && _slot) { raw = await AsyncStorage.getItem(LEGACY_KEY); }
    if (gen !== _generation) { return; } // superseded mid-read by a live change
    if (isFeedSort(raw)) { _sort = raw; }
  } catch {
    /* fresh state is fine */
  }
}

/** Switch the active account slot; drops the in-memory mirror so the next access reloads. */
export function setFeedSortPrefsSlot(slotId: string | undefined): void {
  if (slotId === _slot) { return; }
  _slot = slotId;
  _loaded = false;
  _sort = 'new';
  _generation++;
}

/** The persisted feed sort — the one the member last chose. Synchronous: call after load. */
export function feedSortPref(): FeedSort {
  return _sort;
}

/**
 * Record the feed sort the member just chose. The in-memory mirror moves SYNCHRONOUSLY — a sort
 * change can be the last thing that happens before the process dies, and `feedSortPref()` is read
 * synchronously at mount, so the value must never sit behind an await. The disk write is
 * fire-and-forget: losing it costs one remembered sort, and blocking the tap on storage would cost
 * far more.
 */
export function setFeedSortPref(sort: FeedSort): void {
  if (sort === _sort) { return; }
  _sort = sort;
  _generation++;
  AsyncStorage.setItem(keyFor(SORT_KEY), sort).catch(() => {
    /* best effort */
  });
}
