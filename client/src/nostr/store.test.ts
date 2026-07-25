import {
  InMemoryEventStore,
  SwappableEventStore,
  PersistentEventStore,
  serializeEventsCooperatively,
} from './store';
import type {SecureStorage} from '../keys/keystore';
import {InMemorySecureStorage} from '../keys/keystore';
import type {Event} from 'nostr-tools/pure';

function ev(id: string, kind: number, createdAt: number): Event {
  return {
    id,
    pubkey: 'pk',
    created_at: createdAt,
    kind,
    tags: [],
    content: '',
    sig: 'sig',
  };
}

describe('InMemoryEventStore', () => {
  it('dedupes by id', () => {
    const s = new InMemoryEventStore();
    expect(s.save(ev('a', 1, 100))).toBe(true);
    expect(s.save(ev('a', 1, 100))).toBe(false);
    expect(s.size()).toBe(1);
  });

  it('returns posts newest-first and filters by kind', () => {
    const s = new InMemoryEventStore();
    s.save(ev('a', 1, 100));
    s.save(ev('b', 1, 300));
    s.save(ev('c', 1, 200));
    s.save(ev('vote', 7, 999)); // reaction, not a post
    const posts = s.getPosts();
    expect(posts.map(p => p.id)).toEqual(['b', 'c', 'a']);
  });

  it('honors limit', () => {
    const s = new InMemoryEventStore();
    s.save(ev('a', 1, 100));
    s.save(ev('b', 1, 200));
    s.save(ev('c', 1, 300));
    expect(s.getPosts(2).map(p => p.id)).toEqual(['c', 'b']);
  });

  it('queries multiple kinds together, newest-first across buckets', () => {
    const s = new InMemoryEventStore();
    s.save(ev('post', 1, 100));
    s.save(ev('react', 7, 400));
    s.save(ev('article', 30023, 200));
    s.save(ev('mute', 10000, 300)); // a kind NOT requested
    const out = s.query({kinds: [1, 7, 30023]});
    expect(out.map(e => e.id)).toEqual(['react', 'article', 'post']);
  });

  it('unordered:true returns the SAME set but skips the DESC sort (P0-3/C1)', () => {
    const s = new InMemoryEventStore();
    // Saved out of created_at order, so natural (insertion) order differs from sorted DESC order.
    s.save(ev('old', 1, 100));
    s.save(ev('new', 1, 300));
    s.save(ev('mid', 1, 200));

    const sorted = s.query({kinds: [1]});
    const unordered = s.query({kinds: [1], unordered: true});

    expect(new Set(unordered.map(e => e.id))).toEqual(new Set(sorted.map(e => e.id)));
    expect(sorted.map(e => e.id)).toEqual(['new', 'mid', 'old']); // default unchanged: DESC
    expect(unordered.map(e => e.id)).toEqual(['old', 'new', 'mid']); // natural (insertion) order
  });

  it('unordered:true is ignored when limit is also set (limit needs the sort)', () => {
    const s = new InMemoryEventStore();
    s.save(ev('old', 1, 100));
    s.save(ev('new', 1, 300));
    s.save(ev('mid', 1, 200));
    expect(s.query({kinds: [1], unordered: true, limit: 2}).map(e => e.id)).toEqual(['new', 'mid']);
  });

  it('returns an empty array for a kind with no events', () => {
    const s = new InMemoryEventStore();
    s.save(ev('a', 1, 100));
    expect(s.query({kinds: [9999]})).toEqual([]);
  });

  it('keeps the kind index consistent after remove', () => {
    const s = new InMemoryEventStore();
    s.save(ev('a', 1, 100));
    s.save(ev('b', 1, 200));
    expect(s.remove('b')).toBe(true);
    expect(s.query({kinds: [1]}).map(e => e.id)).toEqual(['a']);
    // Removing the last event of a kind leaves a clean (empty) result, not a stale hit.
    expect(s.remove('a')).toBe(true);
    expect(s.query({kinds: [1]})).toEqual([]);
    expect(s.remove('a')).toBe(false); // already gone
  });

  it('clear() empties both the id map and the kind index', () => {
    const s = new InMemoryEventStore();
    s.save(ev('a', 1, 100));
    s.save(ev('b', 7, 200));
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.query({kinds: [1]})).toEqual([]);
    expect(s.query({kinds: [7]})).toEqual([]);
    // The index is usable again after clear (no leaked buckets).
    s.save(ev('c', 1, 300));
    expect(s.query({kinds: [1]}).map(e => e.id)).toEqual(['c']);
  });

  it('filters by author within a kind query', () => {
    const s = new InMemoryEventStore();
    const a = ev('a', 1, 100); a.pubkey = 'alice';
    const b = ev('b', 1, 200); b.pubkey = 'bob';
    s.save(a);
    s.save(b);
    expect(s.query({kinds: [1], authors: ['bob']}).map(e => e.id)).toEqual(['b']);
  });
});

describe('SwappableEventStore', () => {
  it('delegates to the inner store and swaps it on setInner', () => {
    const a = new InMemoryEventStore();
    a.save(ev('a1', 1, 100));
    const wrap = new SwappableEventStore(a);
    expect(wrap.query({kinds: [1]}).map(e => e.id)).toEqual(['a1']);

    const b = new InMemoryEventStore();
    b.save(ev('b1', 1, 200));
    wrap.setInner(b);
    // Reads now come from B; A's events are no longer visible through the wrapper.
    expect(wrap.query({kinds: [1]}).map(e => e.id)).toEqual(['b1']);
    // A write through the wrapper lands in the current inner (B).
    wrap.save(ev('b2', 1, 300));
    expect(b.has('b2')).toBe(true);
    expect(a.has('b2')).toBe(false);
  });

  it('version strictly increases across a swap so upstream caches invalidate', () => {
    const a = new InMemoryEventStore();
    a.save(ev('a1', 1, 100)); // bumps A's version
    const wrap = new SwappableEventStore(a);
    const before = wrap.version();
    const beforeKind = wrap.versionOf([1]);

    // A fresh inner store starts its own counters at 0, but the wrapper's base must keep the
    // combined version moving forward so the feed cache can't mistake B for an unchanged A.
    wrap.setInner(new InMemoryEventStore());
    expect(wrap.version()).toBeGreaterThan(before);
    expect(wrap.versionOf([1])).toBeGreaterThan(beforeKind);
  });
});

describe('serializeEventsCooperatively', () => {
  it('produces output byte-identical to JSON.stringify, including across the yield boundary', async () => {
    for (const n of [0, 1, 3, 249, 250, 251, 500, 501]) {
      const events = Array.from({length: n}, (_, i) => ev(`id${i}`, 1, i));
      const expected = JSON.stringify(events);
      const actual = await serializeEventsCooperatively(events);
      expect(actual).toBe(expected);
    }
  });
});

describe('PersistentEventStore flush', () => {
  it('single-flight: a flush requested while one is running marks dirty and re-runs once after it completes, instead of overlapping', async () => {
    // Fake timers so save()'s debounced scheduleFlush() never fires a real 1500ms timer in the
    // background (this test drives `flush()` directly and doesn't need the debounce at all).
    jest.useFakeTimers();
    try {
      const written: string[] = [];
      let releaseFirstWrite: (() => void) | undefined;
      const firstWriteGate = new Promise<void>(resolve => {
        releaseFirstWrite = resolve;
      });

      const storage: SecureStorage = {
        async setItem(_key: string, value: string) {
          written.push(value);
          if (written.length === 1) {
            await firstWriteGate; // hold the first write open until the test releases it
          }
        },
        async getItem() {
          return null;
        },
        async removeItem() {},
      };

      const store = await PersistentEventStore.create(storage);
      const flush = (store as unknown as {flush(): Promise<void>}).flush.bind(store);

      store.save(ev('a', 1, 100));
      const firstFlush = flush(); // begins writing (contains 'a'), then blocks on firstWriteGate

      // Let the first write actually start before a second flush is requested.
      await Promise.resolve();
      await Promise.resolve();
      expect(written.length).toBe(1);

      // A second event lands, and a second flush is requested, while the first is still in flight.
      store.save(ev('b', 1, 200));
      const secondFlush = flush();

      // The second call must NOT start a second concurrent write — it only marks the flush dirty.
      await Promise.resolve();
      await Promise.resolve();
      expect(written.length).toBe(1);

      // Release the first write; the dirty flag must cause exactly one more write, capturing 'b'.
      releaseFirstWrite!();
      await firstFlush;
      await secondFlush;

      expect(written.length).toBe(2);
      expect(JSON.parse(written[1]!).map((e: Event) => e.id)).toEqual(['b', 'a']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists the newest events, byte-identical to a direct JSON.stringify, after the debounce fires', async () => {
    jest.useFakeTimers();
    try {
      const storage = new InMemorySecureStorage();
      const store = await PersistentEventStore.create(storage);
      store.save(ev('a', 1, 100));
      store.save(ev('b', 1, 200));

      await jest.advanceTimersByTimeAsync(1500);
      // Allow any additional microtask/timer turns the (non-yielding, small) flush needs.
      await jest.advanceTimersByTimeAsync(0);

      const cacheItem = (store as unknown as {cacheItem: string}).cacheItem;
      const raw = await storage.getItem(cacheItem);
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!) as Event[];
      expect(parsed.map(e => e.id).sort()).toEqual(['a', 'b']);
    } finally {
      jest.useRealTimers();
    }
  });
});

// Scoped cache-clear (Settings → Manage data). SAFETY-CRITICAL: it must delete ONLY in-range,
// NON-EXEMPT received feed events, and NEVER a DM, a moderation report, or any durable-state event.
describe('EventStore scoped cache deletion (deleteCachedEvents / cachedEventCount)', () => {
  // One representative of every exempt family (see nostr/cacheExempt.ts): profile(0), delete-req(5),
  // channel-create(40), gift-wrap DM(1059), report(1984), NIP-51 list(10000), addressable state(30078).
  const EXEMPT: Array<[string, number]> = [
    ['profile', 0],
    ['delreq', 5],
    ['channel', 40],
    ['dm', 1059],
    ['report', 1984],
    ['list', 10000],
    ['addr', 30078],
  ];

  /** A store seeded with deletable posts/reactions across ages + one very-old event of every exempt kind. */
  function seeded(): InMemoryEventStore {
    const s = new InMemoryEventStore();
    s.save(ev('p-old', 1, 100)); // deletable, old
    s.save(ev('p-new', 1, 1000)); // deletable, new
    s.save(ev('r-old', 7, 200)); // reaction, old
    s.save(ev('r-new', 7, 1000)); // reaction, new
    for (const [id, kind] of EXEMPT) s.save(ev(id, kind, 1)); // ancient, but must NEVER be deleted
    return s;
  }

  it('deletes only NON-EXEMPT events older than the cutoff, keeping newer + every exempt kind', () => {
    const s = seeded();
    const removed = s.deleteCachedEvents({olderThanSeconds: 500});
    expect(removed).toBe(2); // p-old (100) + r-old (200); p-new/r-new (1000) survive
    expect(s.has('p-old')).toBe(false);
    expect(s.has('r-old')).toBe(false);
    expect(s.has('p-new')).toBe(true);
    expect(s.has('r-new')).toBe(true);
    // Every exempt kind is retained even though its created_at (1) is far below the cutoff.
    for (const [id] of EXEMPT) expect(s.has(id)).toBe(true);
  });

  it('is strictly-less-than the cutoff at the boundary (== cutoff is kept, cutoff-1 is deleted)', () => {
    const s = new InMemoryEventStore();
    s.save(ev('at', 1, 1000)); // exactly at the cutoff
    s.save(ev('below', 1, 999)); // one second older
    expect(s.deleteCachedEvents({olderThanSeconds: 1000})).toBe(1);
    expect(s.has('at')).toBe(true);
    expect(s.has('below')).toBe(false);
  });

  it('with no cutoff deletes ALL non-exempt events but never an exempt one', () => {
    const s = seeded();
    const removed = s.deleteCachedEvents(); // everything cached
    expect(removed).toBe(4); // both posts + both reactions
    expect(s.query({kinds: [1]})).toHaveLength(0);
    expect(s.query({kinds: [7]})).toHaveLength(0);
    for (const [id] of EXEMPT) expect(s.has(id)).toBe(true);
  });

  it('restricts to the requested kinds (still intersected with the non-exempt set)', () => {
    const s = seeded();
    // Ask to delete reactions AND DMs — the DM kind is silently dropped (exempt), reactions go.
    const removed = s.deleteCachedEvents({kinds: [7, 1059]});
    expect(removed).toBe(2); // both reactions
    expect(s.query({kinds: [7]})).toHaveLength(0);
    expect(s.query({kinds: [1]})).toHaveLength(2); // posts untouched (not requested)
    expect(s.has('dm')).toBe(true); // the exempt DM is never deleted even when named
  });

  it('bumps the per-kind version so the feed cache invalidates, and cachedEventCount agrees', () => {
    const s = seeded();
    expect(s.cachedEventCount({olderThanSeconds: 500})).toBe(2);
    const v1 = s.versionOf([1]);
    const v7 = s.versionOf([7]);
    s.deleteCachedEvents({olderThanSeconds: 500});
    expect(s.versionOf([1])).toBeGreaterThan(v1);
    expect(s.versionOf([7])).toBeGreaterThan(v7);
    expect(s.cachedEventCount({olderThanSeconds: 500})).toBe(0); // nothing left in range
  });

  it('cachedEventCount never counts exempt kinds and never mutates the store', () => {
    const s = seeded();
    const sizeBefore = s.size();
    expect(s.cachedEventCount()).toBe(4); // 4 deletable; the 7 exempt events are not counted
    expect(s.size()).toBe(sizeBefore); // counting is read-only
  });

  it('propagates through SwappableEventStore', () => {
    const inner = seeded();
    const wrap = new SwappableEventStore(inner);
    expect(wrap.cachedEventCount({olderThanSeconds: 500})).toBe(2);
    const v = wrap.versionOf([1]);
    expect(wrap.deleteCachedEvents({olderThanSeconds: 500})).toBe(2);
    expect(wrap.versionOf([1])).toBeGreaterThan(v);
    expect(inner.has('p-old')).toBe(false);
    expect(inner.has('dm')).toBe(true);
  });
});
