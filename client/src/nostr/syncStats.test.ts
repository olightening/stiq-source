import type {ReconcileStats} from './RelayClient';
import {
  recordSyncStat,
  getSyncStats,
  subscribeSyncStats,
  clearSyncStats,
} from './syncStats';

/** Build a ReconcileStats with sane defaults; `over` overrides any field. */
function stat(over: Partial<ReconcileStats> = {}): ReconcileStats {
  return {
    subId: 'feed-neg',
    rounds: 1,
    wallMs: 10,
    need: 0,
    have: 0,
    frameBytesOut: 4,
    fellBack: false,
    at: Date.now(),
    ...over,
  };
}

describe('syncStats ring buffer (T10-S3, on-device diagnostics only)', () => {
  // The ring is module-level state shared across tests — reset before each so cases don't bleed.
  beforeEach(() => clearSyncStats());

  it('starts empty', () => {
    expect(getSyncStats()).toEqual([]);
  });

  it('records newest-last and returns them in insertion order', () => {
    recordSyncStat(stat({rounds: 1}));
    recordSyncStat(stat({rounds: 2}));
    recordSyncStat(stat({rounds: 3}));
    expect(getSyncStats().map(s => s.rounds)).toEqual([1, 2, 3]);
  });

  it('caps at RING_MAX (50) entries, dropping the oldest on overflow', () => {
    for (let i = 0; i < 55; i++) {
      recordSyncStat(stat({rounds: i}));
    }
    const stats = getSyncStats();
    expect(stats).toHaveLength(50);
    // The first 5 (rounds 0..4) were evicted; the ring holds rounds 5..54, newest-last.
    expect(stats[0]!.rounds).toBe(5);
    expect(stats[stats.length - 1]!.rounds).toBe(54);
  });

  it('notifies subscribers on each record', () => {
    let ticks = 0;
    const unsub = subscribeSyncStats(() => ticks++);
    recordSyncStat(stat());
    recordSyncStat(stat());
    expect(ticks).toBe(2);
    unsub();
    recordSyncStat(stat());
    expect(ticks).toBe(2); // unsubscribed — no further notifications
  });

  it('notifies subscribers on clear too', () => {
    let ticks = 0;
    subscribeSyncStats(() => ticks++);
    recordSyncStat(stat());
    expect(ticks).toBe(1);
    clearSyncStats();
    expect(ticks).toBe(2);
  });

  it('getSyncStats returns a frozen, defensively-copied snapshot', () => {
    recordSyncStat(stat({rounds: 7}));
    const snap = getSyncStats();
    expect(Object.isFrozen(snap)).toBe(true);
    // The snapshot is a copy: a later record does not mutate an already-returned array.
    recordSyncStat(stat({rounds: 8}));
    expect(snap).toHaveLength(1);
    expect(snap[0]!.rounds).toBe(7);
  });

  it('clearSyncStats empties the buffer', () => {
    recordSyncStat(stat());
    recordSyncStat(stat());
    expect(getSyncStats()).toHaveLength(2);
    clearSyncStats();
    expect(getSyncStats()).toEqual([]);
  });

  it('a throwing subscriber does not break recording or other subscribers', () => {
    const seen: number[] = [];
    subscribeSyncStats(() => {
      throw new Error('subscriber blew up');
    });
    subscribeSyncStats(() => seen.push(1));
    expect(() => recordSyncStat(stat())).not.toThrow();
    expect(getSyncStats()).toHaveLength(1); // record still landed
    expect(seen).toEqual([1]); // the healthy subscriber still fired
  });
});
