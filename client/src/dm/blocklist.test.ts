/**
 * Local DM decision store — block/allow/isBlocked + AsyncStorage persistence round-trip.
 *
 * AsyncStorage is mocked as a shared in-memory mockStore (the same pattern the other dm/channels
 * suites use). The mockStore persists across jest.resetModules() so a freshly-required module instance
 * re-hydrates from what the first instance wrote — proving the round-trip.
 */

// Shared in-memory mockStore, declared with `var` so it survives the jest.mock hoist.
// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => {
    mockStore[k] = v;
    return Promise.resolve();
  },
  removeItem: (k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  },
}));

const KEY = 'stiq_dm_blocklist';

describe('blocklist block/unblock/isBlocked', () => {
  beforeEach(() => {
    mockStore = {};
    jest.resetModules();
  });

  it('blocks, reports membership, and unblocks idempotently', async () => {
    const bl = require('./blocklist');
    await bl.loadBlocklist();

    expect(bl.isBlocked('peerA')).toBe(false);

    await bl.blockPeer('peerA');
    expect(bl.isBlocked('peerA')).toBe(true);
    expect(bl.getBlocked()).toEqual(['peerA']);

    // Re-blocking is a no-op (idempotent, no duplicate).
    await bl.blockPeer('peerA');
    expect(bl.getBlocked()).toEqual(['peerA']);

    // Unblock records an explicit allow (not a delete), so the peer leaves the blocked set but keeps
    // a decision on record.
    await bl.unblockPeer('peerA');
    expect(bl.isBlocked('peerA')).toBe(false);
    expect(bl.getBlocked()).toEqual([]);
    expect(bl.localDecision('peerA')).toBe('allow');

    // Unblocking an already-allowed peer is a no-op.
    await bl.unblockPeer('peerA');
    expect(bl.getBlocked()).toEqual([]);
  });

  it('records the block time (localBlockedAt) and clears it on allow', async () => {
    const bl = require('./blocklist');
    await bl.loadBlocklist();

    const before = Math.floor(Date.now() / 1000);
    await bl.blockPeer('peerA');
    const at = bl.localBlockedAt('peerA');
    expect(typeof at).toBe('number');
    expect(at).toBeGreaterThanOrEqual(before);

    // A re-block keeps the ORIGINAL block time (idempotent).
    await bl.blockPeer('peerA');
    expect(bl.localBlockedAt('peerA')).toBe(at);

    // An allow clears the block time.
    await bl.unblockPeer('peerA');
    expect(bl.localBlockedAt('peerA')).toBeUndefined();
  });

  it('exposes the explicit local decision', async () => {
    const bl = require('./blocklist');
    await bl.loadBlocklist();

    expect(bl.localDecision('peerA')).toBeUndefined();
    await bl.blockPeer('peerA');
    expect(bl.localDecision('peerA')).toBe('block');
    await bl.unblockPeer('peerA');
    expect(bl.localDecision('peerA')).toBe('allow');
  });

  it('notifies subscribers on change and stops after unsubscribe', async () => {
    const bl = require('./blocklist');
    await bl.loadBlocklist();

    let calls = 0;
    const unsubscribe = bl.subscribe(() => {
      calls += 1;
    });

    await bl.blockPeer('peerB');
    await bl.unblockPeer('peerB');
    expect(calls).toBe(2);

    unsubscribe();
    await bl.blockPeer('peerC');
    expect(calls).toBe(2); // no further notifications after unsubscribe
  });

  it('persists decisions to AsyncStorage in the v2 format', async () => {
    const bl = require('./blocklist');
    await bl.loadBlocklist();

    await bl.blockPeer('peerA');
    await bl.unblockPeer('peerB');

    const saved = JSON.parse(mockStore[KEY] as string);
    expect(saved.v).toBe(2);
    // Each entry is [peer, decision, at].
    const byPeer = Object.fromEntries(saved.e.map((row: [string, string, number]) => [row[0], row[1]]));
    expect(byPeer).toEqual({peerA: 'block', peerB: 'allow'});
    for (const row of saved.e) expect(typeof row[2]).toBe('number');
  });
});

describe('blocklist persistence round-trip', () => {
  it('re-hydrates a fresh module instance from what a prior instance persisted', async () => {
    mockStore = {};
    jest.resetModules();
    {
      const bl = require('./blocklist');
      await bl.loadBlocklist();
      await bl.blockPeer('peerX');
      await bl.blockPeer('peerY');
      await bl.unblockPeer('peerZ'); // an explicit allow must survive too (moderator-mute override)
    }

    // Fresh module instance — its in-memory map starts empty and must reload from storage.
    jest.resetModules();
    const bl2 = require('./blocklist');
    await bl2.loadBlocklist();

    expect(bl2.isBlocked('peerX')).toBe(true);
    expect(bl2.isBlocked('peerY')).toBe(true);
    expect(bl2.getBlocked().sort()).toEqual(['peerX', 'peerY']);
    expect(bl2.localDecision('peerZ')).toBe('allow');
  });

  it('migrates a legacy v1 array of blocked peers to block decisions', async () => {
    mockStore = {};
    jest.resetModules();
    // Legacy format: a bare JSON array of blocked peer pubkeys.
    mockStore[KEY] = JSON.stringify(['peerL1', 'peerL2']);

    const bl = require('./blocklist');
    await bl.loadBlocklist();

    expect(bl.isBlocked('peerL1')).toBe(true);
    expect(bl.isBlocked('peerL2')).toBe(true);
    expect(bl.localDecision('peerL1')).toBe('block');
    // Migration stamps a block time so pre-existing history is kept, not deleted.
    expect(typeof bl.localBlockedAt('peerL1')).toBe('number');
  });
});
