/**
 * feedSortPrefs — the Rising/New feed sort must survive an app restart AND be readable synchronously
 * on the feed's first paint (no async flash of the default 'new'). Same contract as dockPrefs /
 * logPagePrefs: an in-memory mirror hydrated once, synchronous reads, best-effort async writes,
 * keyed per identity slot. Each test takes a fresh slot → a fresh mirror (dockPrefs.test idiom).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ensureFeedSortPrefsLoaded,
  feedSortPref,
  setFeedSortPref,
  setFeedSortPrefsSlot,
} from './feedSortPrefs';

let seq = 0;
beforeEach(async () => {
  await AsyncStorage.clear();
  setFeedSortPrefsSlot(`sort-${seq++}`);
  await ensureFeedSortPrefsLoaded();
});

/** Let a fire-and-forget AsyncStorage write settle to disk. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('feedSortPrefs', () => {
  it('defaults to New when nothing has been stored', () => {
    expect(feedSortPref()).toBe('new');
  });

  it('moves the in-memory mirror synchronously on change (the read needs no await)', () => {
    setFeedSortPref('hot');
    expect(feedSortPref()).toBe('hot');
  });

  it('remembers the chosen sort across a cold restart (drop the mirror, reload from disk)', async () => {
    const slot = 'restart-slot';
    setFeedSortPrefsSlot(slot);
    await ensureFeedSortPrefsLoaded();
    setFeedSortPref('hot');
    await flush(); // the fire-and-forget write lands on disk

    // Simulate a process restart: switch away (drops the mirror to the default) then back (reloads).
    setFeedSortPrefsSlot('elsewhere');
    await ensureFeedSortPrefsLoaded();
    expect(feedSortPref()).toBe('new'); // the switch cleared the mirror…

    setFeedSortPrefsSlot(slot);
    await ensureFeedSortPrefsLoaded();
    expect(feedSortPref()).toBe('hot'); // …and the choice came back off disk
  });

  it('reads the persisted value synchronously after load — the sort bar sees it on first paint', async () => {
    const slot = 'first-paint';
    setFeedSortPrefsSlot(slot);
    await ensureFeedSortPrefsLoaded();
    setFeedSortPref('hot');
    await flush();

    // Relaunch: a fresh mirror, then the eager load AppRuntime runs before the splash lifts.
    setFeedSortPrefsSlot('cleared');
    setFeedSortPrefsSlot(slot);
    await ensureFeedSortPrefsLoaded();
    // No further await needed — the bar's initial render can read this straight away.
    expect(feedSortPref()).toBe('hot');
  });

  it('keeps two accounts’ choices isolated (per-slot)', async () => {
    setFeedSortPrefsSlot('acct-A');
    await ensureFeedSortPrefsLoaded();
    setFeedSortPref('hot');
    await flush();

    setFeedSortPrefsSlot('acct-B');
    await ensureFeedSortPrefsLoaded();
    expect(feedSortPref()).toBe('new'); // B has its own default, not A's 'hot'

    setFeedSortPrefsSlot('acct-A');
    await ensureFeedSortPrefsLoaded();
    expect(feedSortPref()).toBe('hot'); // A's choice is intact
  });

  it('carries a pre-per-slot global choice over on the first launch after update', async () => {
    await AsyncStorage.setItem('stiq_sort_mode', 'hot'); // written by the OLD global-key build
    setFeedSortPrefsSlot('never-written-slot');
    await ensureFeedSortPrefsLoaded();
    expect(feedSortPref()).toBe('hot'); // adopted the legacy value rather than resetting to 'new'
  });

  it("ignores a stored value that isn't a feed sort ('top' is search-only)", async () => {
    const slot = 'malformed';
    setFeedSortPrefsSlot(slot);
    await AsyncStorage.setItem(`stiq_sort_mode.${slot}`, 'top');
    await ensureFeedSortPrefsLoaded();
    expect(feedSortPref()).toBe('new');
  });
});
