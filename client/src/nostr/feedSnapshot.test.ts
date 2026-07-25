import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from './store';
import {InMemorySecureStorage} from '../keys/keystore';
import {Kind} from './events';
import {
  buildFeedSnapshot,
  saveFeedSnapshot,
  loadFeedSnapshot,
  clearFeedSnapshot,
  feedSnapshotKey,
  LEGACY_FEED_SNAPSHOT,
  type FeedSnapshot,
} from './feedSnapshot';

const ev = (id: string, kind: number, created_at: number, pubkey = 'p'): Event => ({
  id,
  pubkey,
  created_at,
  kind,
  tags: [],
  content: '',
  sig: 's',
});

const FEED_KINDS_T = [Kind.Post, Kind.Reaction, Kind.Comment];

describe('buildFeedSnapshot', () => {
  it('records per-kind high-water and the newest post ids (newest first)', () => {
    const store = new InMemoryEventStore();
    store.save(ev('p1', Kind.Post, 100));
    store.save(ev('p2', Kind.Post, 300));
    store.save(ev('p3', Kind.Post, 200));
    store.save(ev('r1', Kind.Reaction, 500));

    const snap = buildFeedSnapshot(store, FEED_KINDS_T);
    expect(snap.highWater[Kind.Post]).toBe(300); // newest kind-1 created_at
    expect(snap.highWater[Kind.Reaction]).toBe(500);
    expect(Kind.Comment in snap.highWater).toBe(false); // no comments cached → omitted
    expect(snap.postIds).toEqual(['p2', 'p3', 'p1']); // created_at DESC
    expect(typeof snap.savedAt).toBe('number');
  });

  it('truncates postIds to the newest `limit`', () => {
    const store = new InMemoryEventStore();
    for (let i = 0; i < 5; i++) store.save(ev(`p${i}`, Kind.Post, i));
    const snap = buildFeedSnapshot(store, [Kind.Post], 3);
    expect(snap.postIds).toEqual(['p4', 'p3', 'p2']); // newest 3
  });

  it('is empty (no high-water, no ids) for a cold store', () => {
    const snap = buildFeedSnapshot(new InMemoryEventStore(), FEED_KINDS_T);
    expect(snap.highWater).toEqual({});
    expect(snap.postIds).toEqual([]);
  });
});

describe('saveFeedSnapshot / loadFeedSnapshot', () => {
  const snap: FeedSnapshot = {savedAt: 123, highWater: {1: 300, 7: 500}, postIds: ['a', 'b']};

  it('round-trips through a per-community key', async () => {
    const storage = new InMemorySecureStorage();
    await saveFeedSnapshot(storage, 'cid1', snap);
    expect(await storage.getItem(feedSnapshotKey('cid1'))).not.toBeNull();
    expect(await loadFeedSnapshot(storage, 'cid1')).toEqual(snap);
  });

  it('round-trips through the legacy global key when cid is omitted', async () => {
    const storage = new InMemorySecureStorage();
    await saveFeedSnapshot(storage, undefined, snap);
    expect(await storage.getItem(LEGACY_FEED_SNAPSHOT)).not.toBeNull();
    expect(await loadFeedSnapshot(storage)).toEqual(snap);
  });

  it('is per-community isolated (a snapshot for one cid never leaks into another)', async () => {
    const storage = new InMemorySecureStorage();
    await saveFeedSnapshot(storage, 'cid1', snap);
    expect(await loadFeedSnapshot(storage, 'cid2')).toBeNull();
  });

  it('is per-ACCOUNT isolated (finding #4): one slot\'s snapshot never seeds a sibling account', async () => {
    const storage = new InMemorySecureStorage();
    // Two accounts in the SAME community write DIFFERENT snapshot keys, so account A's high-water
    // floor never applies to account B's fresh store (which would make B under-fetch).
    await saveFeedSnapshot(storage, 'cid1', snap, 'slotA');
    expect(await loadFeedSnapshot(storage, 'cid1', 'slotA')).toEqual(snap);
    expect(await loadFeedSnapshot(storage, 'cid1', 'slotB')).toBeNull(); // sibling account — isolated
    expect(await loadFeedSnapshot(storage, 'cid1')).toBeNull(); // legacy per-cid key — distinct too
  });

  it('clears per-account without touching a sibling account\'s snapshot', async () => {
    const storage = new InMemorySecureStorage();
    await saveFeedSnapshot(storage, 'cid1', snap, 'slotA');
    await saveFeedSnapshot(storage, 'cid1', snap, 'slotB');
    await clearFeedSnapshot(storage, 'cid1', 'slotA');
    expect(await loadFeedSnapshot(storage, 'cid1', 'slotA')).toBeNull(); // wiped
    expect(await loadFeedSnapshot(storage, 'cid1', 'slotB')).toEqual(snap); // sibling intact
  });

  it('yields null for an absent snapshot', async () => {
    expect(await loadFeedSnapshot(new InMemorySecureStorage(), 'nope')).toBeNull();
  });

  it('yields null for a corrupt (non-JSON) blob', async () => {
    const storage = new InMemorySecureStorage();
    await storage.setItem(feedSnapshotKey('bad'), 'not json');
    expect(await loadFeedSnapshot(storage, 'bad')).toBeNull();
  });

  it('yields null for a structurally-malformed blob', async () => {
    const storage = new InMemorySecureStorage();
    await storage.setItem(feedSnapshotKey('s1'), JSON.stringify({savedAt: 1, highWater: 'x', postIds: []}));
    await storage.setItem(feedSnapshotKey('s2'), JSON.stringify({savedAt: 1, highWater: {}, postIds: 'nope'}));
    await storage.setItem(feedSnapshotKey('s3'), JSON.stringify({highWater: {}, postIds: []})); // no savedAt
    expect(await loadFeedSnapshot(storage, 's1')).toBeNull();
    expect(await loadFeedSnapshot(storage, 's2')).toBeNull();
    expect(await loadFeedSnapshot(storage, 's3')).toBeNull();
  });

  it('drops junk high-water / post-id entries defensively on load', async () => {
    const storage = new InMemorySecureStorage();
    await storage.setItem(
      feedSnapshotKey('mix'),
      JSON.stringify({savedAt: 9, highWater: {1: 300, 7: 'bad'}, postIds: ['ok', 42, null]}),
    );
    const loaded = await loadFeedSnapshot(storage, 'mix');
    expect(loaded).toEqual({savedAt: 9, highWater: {1: 300}, postIds: ['ok']});
  });
});

describe('clearFeedSnapshot', () => {
  it('removes a persisted snapshot (duress-wipe hook)', async () => {
    const storage = new InMemorySecureStorage();
    const snap: FeedSnapshot = {savedAt: 1, highWater: {1: 10}, postIds: ['a']};
    await saveFeedSnapshot(storage, 'cid1', snap);
    await clearFeedSnapshot(storage, 'cid1');
    expect(await loadFeedSnapshot(storage, 'cid1')).toBeNull();
  });
});
