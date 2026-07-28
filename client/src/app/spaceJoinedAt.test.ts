/**
 * spaceJoinedAt — the "when did I join this space" mirror that lets a just-joined space (which has
 * no cached messages yet) surface at the top of the Spaces list instead of sorting at the 0 floor.
 * Same contract as feedSortPrefs/communityEntry: in-memory mirror hydrated once, synchronous reads,
 * best-effort async writes, keyed per identity slot. Each test takes a fresh slot → a fresh mirror
 * (dockPrefs.test / feedSortPrefs.test idiom).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ensureSpaceJoinedAtLoaded,
  joinedAt,
  markJoined,
  setSpaceJoinedAtSlot,
} from './spaceJoinedAt';

let seq = 0;
beforeEach(async () => {
  await AsyncStorage.clear();
  setSpaceJoinedAtSlot(`slot-${seq++}`);
  await ensureSpaceJoinedAtLoaded();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Let a fire-and-forget AsyncStorage write settle to disk. */
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('spaceJoinedAt', () => {
  it('joinedAt reads back synchronously immediately after markJoined (no await)', () => {
    markJoined('space-sync', 42);
    expect(joinedAt('space-sync')).toBe(42);
  });

  it('setSpaceJoinedAtSlot isolates accounts — a stamp under slot A is not visible after switching to slot B, with distinct persisted keys', async () => {
    const slotA = 'acct-A';
    const slotB = 'acct-B';

    setSpaceJoinedAtSlot(slotA);
    await ensureSpaceJoinedAtLoaded();
    markJoined('space-1', 1234);
    await flush(); // the fire-and-forget write lands on disk

    setSpaceJoinedAtSlot(slotB);
    await ensureSpaceJoinedAtLoaded();
    expect(joinedAt('space-1')).toBe(0); // B has no record of A's join

    const rawA = await AsyncStorage.getItem(`stiq.space.joinedAt.${slotA}`);
    const rawB = await AsyncStorage.getItem(`stiq.space.joinedAt.${slotB}`);
    expect(JSON.parse(rawA as string)).toEqual({'space-1': 1234});
    expect(rawB).toBeNull(); // slot B never wrote anything — distinct keys, nothing bled across
  });

  it('a hydrate that resolves after a live markJoined does not clobber the live stamp', async () => {
    let resolveGetItem!: (v: string | null) => void;
    const deferred = new Promise<string | null>(resolve => {
      resolveGetItem = resolve;
    });
    jest.spyOn(AsyncStorage, 'getItem').mockReturnValueOnce(deferred);

    setSpaceJoinedAtSlot('race-slot');
    const loadPromise = ensureSpaceJoinedAtLoaded(); // read is now in flight, not yet resolved

    markJoined('space-x', 5000); // live stamp arrives while the hydrate is still pending
    expect(joinedAt('space-x')).toBe(5000);

    resolveGetItem(JSON.stringify({'space-x': 100})); // stale disk value for the SAME id
    await loadPromise;

    expect(joinedAt('space-x')).toBe(5000); // the live stamp wins, not the stale hydrate
  });

  it('MAX_ENTRIES caps the map at 200, evicting the OLDEST stamps first', () => {
    const total = 205;
    for (let i = 0; i < total; i++) {
      markJoined(`space-${i}`, 1_000_000 + i); // strictly ascending — insertion order == recency order
    }

    let retained = 0;
    for (let i = 0; i < total; i++) {
      const at = joinedAt(`space-${i}`);
      if (i < 5) {
        expect(at).toBe(0); // the 5 lowest-timestamp ids were evicted
      } else {
        expect(at).toBe(1_000_000 + i); // the newest 200 survive intact
        retained++;
      }
    }
    expect(retained).toBe(200);
  });
});
