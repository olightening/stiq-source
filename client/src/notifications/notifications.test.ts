/**
 * Notifications mute persistence — muteSource/unmuteSource/toggleMute + AsyncStorage revert-on-
 * failure (B15). AsyncStorage is mocked as a shared in-memory mockStore (the same pattern the
 * dm/channels suites use), with a `failNext` switch so a single setItem can be made to reject.
 */

// Shared in-memory mockStore + failure switch, declared with `var` so they survive the jest.mock hoist.
// (names prefixed with `mock` are the one exception jest allows inside a mock factory.)
// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};
// eslint-disable-next-line no-var
var mockFailNextWrite = false;

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => {
    if (mockFailNextWrite) {
      mockFailNextWrite = false;
      return Promise.reject(new Error('disk full'));
    }
    mockStore[k] = v;
    return Promise.resolve();
  },
  removeItem: (k: string) => {
    delete mockStore[k];
    return Promise.resolve();
  },
}));

// ./prefs is B5-owned (client/src/notifications/prefs.ts). Mock it here so this suite can control
// isNotifAllowed/isNameHidden/getPrefs per test without depending on the real pref-persistence
// logic. jest.resetModules() (used throughout this file to simulate fresh app-process module
// state) re-invokes this factory, producing fresh jest.fn()s each time — so per-test setup below
// always starts from a clean mock.
jest.mock('./prefs', () => ({
  ensurePrefsLoaded: jest.fn().mockResolvedValue(undefined),
  getPrefs: jest.fn(() => ({})),
  isNotifAllowed: jest.fn(() => true),
  // The push composers gate on isPushAllowed (isNotifAllowed AND the push sub-model, see prefs.ts).
  // Mocked independently so tests can flip push-suppression without touching isNotifAllowed at all.
  isPushAllowed: jest.fn(() => true),
  isNameHidden: jest.fn(() => false),
}));

const MUTE_KEY = 'stiq.notif.muted';

// Composer timestamps must sit at/after the session floor (stamped when setNotificationProvider is
// first called ≈ now) — only post-launch events raise an OS notification. Offsets are relative to NOW
// so relative ordering (for HWM-dedup tests) is preserved while every ts stays above the floor.
const NOW = Math.floor(Date.now() / 1000);

describe('notifications mute persistence', () => {
  beforeEach(() => {
    mockStore = {};
    mockFailNextWrite = false;
    jest.resetModules();
  });

  it('mutes and unmutes a source, persisting the set as a JSON array', async () => {
    const notif = require('./notifications');
    expect(await notif.isSourceMuted('ch:1')).toBe(false);

    await notif.muteSource('ch:1');
    expect(await notif.isSourceMuted('ch:1')).toBe(true);
    expect(JSON.parse(mockStore[MUTE_KEY] as string)).toEqual(['ch:1']);

    await notif.unmuteSource('ch:1');
    expect(await notif.isSourceMuted('ch:1')).toBe(false);
    expect(JSON.parse(mockStore[MUTE_KEY] as string)).toEqual([]);
  });

  it('toggleMute flips and returns the new state', async () => {
    const notif = require('./notifications');
    expect(await notif.toggleMute('ch:2')).toBe(true);
    expect(await notif.isSourceMuted('ch:2')).toBe(true);
    expect(await notif.toggleMute('ch:2')).toBe(false);
    expect(await notif.isSourceMuted('ch:2')).toBe(false);
  });

  it('muteSource reverts the in-memory mutation and rethrows on a failed write', async () => {
    const notif = require('./notifications');
    expect(await notif.isSourceMuted('ch:3')).toBe(false);

    mockFailNextWrite = true;
    await expect(notif.muteSource('ch:3')).rejects.toThrow('disk full');

    // Reverted: the source must NOT read as muted after the failed write.
    expect(await notif.isSourceMuted('ch:3')).toBe(false);
  });

  it('unmuteSource reverts the in-memory mutation and rethrows on a failed write', async () => {
    const notif = require('./notifications');
    await notif.muteSource('ch:4');
    expect(await notif.isSourceMuted('ch:4')).toBe(true);

    mockFailNextWrite = true;
    await expect(notif.unmuteSource('ch:4')).rejects.toThrow('disk full');

    // Reverted: the source must still read as muted after the failed write.
    expect(await notif.isSourceMuted('ch:4')).toBe(true);
  });

  it('toggleMute propagates a write failure instead of silently succeeding', async () => {
    const notif = require('./notifications');
    mockFailNextWrite = true;
    await expect(notif.toggleMute('ch:5')).rejects.toThrow('disk full');
    expect(await notif.isSourceMuted('ch:5')).toBe(false);
  });
});

describe('composer titles + NavTarget + prefs gating', () => {
  beforeEach(() => {
    mockStore = {};
    mockFailNextWrite = false;
    jest.resetModules();
    // Default: prefs allow everything, names shown. Individual tests override as needed.
    const prefs = require('./prefs');
    prefs.ensurePrefsLoaded.mockResolvedValue(undefined);
    prefs.getPrefs.mockReturnValue({});
    prefs.isNotifAllowed.mockReturnValue(true);
    prefs.isPushAllowed.mockReturnValue(true);
    prefs.isNameHidden.mockReturnValue(false);
  });

  function makeProvider() {
    return jest.fn().mockResolvedValue(undefined);
  }

  it('notifyDm shows "Message from {name}" when names are not hidden', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerA', 'Alice', NOW + 100);
    expect(provider).toHaveBeenCalledWith('Message from Alice', 'dm', {kind: 'dm', peer: 'peerA'});
  });

  it('notifyDm falls back to "Message from Someone" for an empty display name', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerB', '', NOW + 100);
    expect(provider).toHaveBeenCalledWith('Message from Someone', 'dm', {kind: 'dm', peer: 'peerB'});
  });

  it('notifyDm shows "New message" when hideNamesOnLockscreen is on', async () => {
    const notif = require('./notifications');
    const prefs = require('./prefs');
    prefs.isNameHidden.mockReturnValue(true);
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerC', 'Bob', NOW + 100);
    expect(provider).toHaveBeenCalledWith('New message', 'dm', {kind: 'dm', peer: 'peerC'});
  });

  it('notifyChannel builds the title + NavTarget and maps public -> channel descriptor', async () => {
    const notif = require('./notifications');
    const prefs = require('./prefs');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyChannel('chan1', 'general', 'public', NOW + 100);
    expect(provider).toHaveBeenCalledWith(
      '#general — new post',
      'channel',
      {kind: 'channel', channelId: 'chan1', channelType: 'public'},
    );
    expect(prefs.isPushAllowed).toHaveBeenCalledWith(
      expect.anything(),
      {kind: 'channel', channelId: 'chan1', channelType: 'channel'},
    );
  });

  it('notifyChannel maps group -> group descriptor while NavTarget keeps "group"', async () => {
    const notif = require('./notifications');
    const prefs = require('./prefs');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyChannel('chan2', 'mods', 'group', NOW + 200);
    expect(provider).toHaveBeenCalledWith(
      '#mods — new post',
      'channel',
      {kind: 'channel', channelId: 'chan2', channelType: 'group'},
    );
    expect(prefs.isPushAllowed).toHaveBeenCalledWith(
      expect.anything(),
      {kind: 'channel', channelId: 'chan2', channelType: 'group'},
    );
  });

  it('notifyComment shows "{name} replied" and targets the root post', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyComment('root1', 'Carol', 'note', NOW + 100);
    expect(provider).toHaveBeenCalledWith('Carol replied', 'comment', {kind: 'post', rootId: 'root1'});
  });

  it('notifyComment falls back to "Someone replied" for an empty display name', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyComment('root2', '', 'note', NOW + 100);
    expect(provider).toHaveBeenCalledWith('Someone replied', 'comment', {kind: 'post', rootId: 'root2'});
  });

  it('notifyComment shows "New reply" when hideNamesOnLockscreen is on', async () => {
    const notif = require('./notifications');
    const prefs = require('./prefs');
    prefs.isNameHidden.mockReturnValue(true);
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyComment('root3', 'Dave', 'article', NOW + 100);
    expect(provider).toHaveBeenCalledWith('New reply', 'comment', {kind: 'post', rootId: 'root3'});
  });

  it('every composer call passes exactly (title, channelId, target) — no body ever leaks through', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerZ', 'Zed', NOW + 100);
    for (const call of provider.mock.calls) {
      expect(call).toHaveLength(3);
      expect(typeof call[0]).toBe('string');
      expect(typeof call[1]).toBe('string');
      expect(typeof call[2]).toBe('object');
    }
  });

  it('isPushAllowed()===false suppresses the provider for all three composers', async () => {
    const notif = require('./notifications');
    const prefs = require('./prefs');
    prefs.isPushAllowed.mockReturnValue(false);
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerD', 'Eve', NOW + 100);
    await notif.notifyChannel('chan3', 'x', 'public', NOW + 100);
    await notif.notifyComment('root4', 'Eve', 'note', NOW + 100);
    expect(provider).not.toHaveBeenCalled();
  });

  it('isNotifAllowed()===true alone is NOT sufficient — the push composers still gate on isPushAllowed', async () => {
    // This is the push ⊆ in-app split's whole point: isNotifAllowed staying true (as it would for
    // the in-app notification-center list) must not be enough to raise an OS push on its own.
    const notif = require('./notifications');
    const prefs = require('./prefs');
    prefs.isNotifAllowed.mockReturnValue(true);
    prefs.isPushAllowed.mockReturnValue(false);
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerD2', 'Eve', NOW + 100);
    expect(provider).not.toHaveBeenCalled();
  });

  it('HWM dedup still suppresses repeat/older timestamps regardless of prefs', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.notifyDm('peerE', 'Frank', NOW + 100);
    expect(provider).toHaveBeenCalledTimes(1);
    await notif.notifyDm('peerE', 'Frank', NOW + 100); // same ts -> not newer
    await notif.notifyDm('peerE', 'Frank', NOW + 50);  // older ts
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it('legacy per-peer mute still suppresses DMs (push-only pre-filter ahead of prefs)', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.muteSource(notif.dmMuteId('peerF'));
    await notif.notifyDm('peerF', 'Gina', NOW + 100);
    expect(provider).not.toHaveBeenCalled();
  });

  it('legacy per-channel mute still suppresses channel notifications', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.muteSource(notif.chMuteId('chan9'));
    await notif.notifyChannel('chan9', 'y', 'public', NOW + 100);
    expect(provider).not.toHaveBeenCalled();
  });

  it('legacy allCommentsMuteId still suppresses reply notifications', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider);
    await notif.muteSource(notif.allCommentsMuteId);
    await notif.notifyComment('root5', 'Hank', 'note', NOW + 100);
    expect(provider).not.toHaveBeenCalled();
  });

  it('suppresses historical replay below the session floor but still fires post-launch events', async () => {
    const notif = require('./notifications');
    const provider = makeProvider();
    notif.setNotificationProvider(provider); // stamps the session floor at ~now
    // A historical event (created long before launch) — the first-sync/reconnect replay case — must
    // NOT raise an OS notification, even though it is "newer" than the fresh (zero) high-water mark.
    await notif.notifyDm('peerHist', 'Old', NOW - 100000);
    expect(provider).not.toHaveBeenCalled();
    // A genuinely post-launch event for the SAME source still fires — the floor never permanently mutes.
    await notif.notifyDm('peerHist', 'New', NOW + 100);
    expect(provider).toHaveBeenCalledWith('Message from New', 'dm', {kind: 'dm', peer: 'peerHist'});
  });

  it('is a no-op when no provider is registered', async () => {
    const notif = require('./notifications');
    await expect(notif.notifyDm('peerG', 'Ivy', NOW + 100)).resolves.toBeUndefined();
    await expect(notif.notifyChannel('chan10', 'z', 'public', NOW + 100)).resolves.toBeUndefined();
    await expect(notif.notifyComment('root6', 'Ivy', 'note', NOW + 100)).resolves.toBeUndefined();
  });
});

describe('encodeNavTarget / decodeNavTarget', () => {
  it('round-trips a dm target', () => {
    const notif = require('./notifications');
    const t = {kind: 'dm', peer: 'abc123'};
    expect(notif.decodeNavTarget(notif.encodeNavTarget(t))).toEqual(t);
  });

  it('round-trips a channel target', () => {
    const notif = require('./notifications');
    const t = {kind: 'channel', channelId: 'c1', channelType: 'group'};
    expect(notif.decodeNavTarget(notif.encodeNavTarget(t))).toEqual(t);
  });

  it('round-trips a post target', () => {
    const notif = require('./notifications');
    const t = {kind: 'post', rootId: 'r1'};
    expect(notif.decodeNavTarget(notif.encodeNavTarget(t))).toEqual(t);
  });

  it('round-trips a group_requests target', () => {
    const notif = require('./notifications');
    const t = {kind: 'group_requests', groupId: 'g1'};
    expect(notif.decodeNavTarget(notif.encodeNavTarget(t))).toEqual(t);
  });

  it('round-trips a draft_requests target (Phase 5§G owner-side manage-access queue)', () => {
    const notif = require('./notifications');
    const t = {kind: 'draft_requests', draftId: 'share123'};
    expect(notif.decodeNavTarget(notif.encodeNavTarget(t))).toEqual(t);
  });

  it('round-trips a draft_reader target (Phase 5§G requester-side unlocked draft)', () => {
    const notif = require('./notifications');
    const t = {kind: 'draft_reader', draftId: 'share123', ownerPubkey: 'owner456'};
    expect(notif.decodeNavTarget(notif.encodeNavTarget(t))).toEqual(t);
  });

  it('returns null for malformed or unrecognized input instead of throwing', () => {
    const notif = require('./notifications');
    expect(notif.decodeNavTarget(null)).toBeNull();
    expect(notif.decodeNavTarget(undefined)).toBeNull();
    expect(notif.decodeNavTarget('a string')).toBeNull();
    expect(notif.decodeNavTarget(42)).toBeNull();
    expect(notif.decodeNavTarget({})).toBeNull();
    expect(notif.decodeNavTarget({kind: 'dm'})).toBeNull(); // missing peer
    expect(notif.decodeNavTarget({kind: 'dm', peer: ''})).toBeNull(); // empty peer
    expect(notif.decodeNavTarget({kind: 'channel', channelId: 'x'})).toBeNull(); // missing channelType
    expect(notif.decodeNavTarget({kind: 'channel', channelId: 'x', channelType: 'weird'})).toBeNull();
    expect(notif.decodeNavTarget({kind: 'post'})).toBeNull(); // missing rootId
    expect(notif.decodeNavTarget({kind: 'group_requests'})).toBeNull(); // missing groupId
    expect(notif.decodeNavTarget({kind: 'group_requests', groupId: ''})).toBeNull(); // empty groupId
    expect(notif.decodeNavTarget({kind: 'draft_requests'})).toBeNull(); // missing draftId
    expect(notif.decodeNavTarget({kind: 'draft_requests', draftId: ''})).toBeNull(); // empty draftId
    expect(notif.decodeNavTarget({kind: 'draft_reader', draftId: 'x'})).toBeNull(); // missing ownerPubkey
    expect(notif.decodeNavTarget({kind: 'draft_reader', draftId: '', ownerPubkey: 'o'})).toBeNull(); // empty draftId
    expect(notif.decodeNavTarget({kind: 'draft_reader', draftId: 'x', ownerPubkey: ''})).toBeNull(); // empty ownerPubkey
    expect(notif.decodeNavTarget({kind: 'bogus', peer: 'x'})).toBeNull();
  });
});

describe('draftMuteId', () => {
  it('formats a stable draft-scoped mute id, mirroring dmMuteId/chMuteId', () => {
    const notif = require('./notifications');
    expect(notif.draftMuteId('share123')).toBe('draft:share123');
  });
});

describe('readState: notification-center per-item read state', () => {
  beforeEach(() => {
    mockStore = {};
    mockFailNextWrite = false;
    jest.resetModules();
  });

  it('everything is unread before anything is marked', async () => {
    const readState = require('./readState');
    await readState.ensureNotifReadLoaded();
    expect(readState.isNotifRead('a', 100)).toBe(false);
  });

  it('markNotifRead marks a single id read and persists it', async () => {
    const readState = require('./readState');
    await readState.markNotifRead('a');
    expect(readState.isNotifRead('a', 100)).toBe(true);
    expect(readState.isNotifRead('b', 100)).toBe(false);
    expect(JSON.parse(mockStore['stiq.notif.read']!)).toEqual({before: 0, ids: ['a']});
  });

  it('markAllNotifsRead reads everything at/before the watermark and persists it', async () => {
    const readState = require('./readState');
    await readState.markNotifRead('a');
    await readState.markAllNotifsRead(200);
    expect(readState.isNotifRead('x', 200)).toBe(true);
    expect(readState.isNotifRead('x', 201)).toBe(false);
    expect(JSON.parse(mockStore['stiq.notif.read']!)).toEqual({before: 200, ids: []});
  });

  it('markAllNotifsRead is monotonic — never moves backwards', async () => {
    const readState = require('./readState');
    await readState.markAllNotifsRead(200);
    await readState.markAllNotifsRead(150);
    expect(readState.isNotifRead('x', 180)).toBe(true);
  });

  it('reloads the persisted read state on a fresh module instance', async () => {
    let readState = require('./readState');
    await readState.markAllNotifsRead(300);
    await readState.markNotifRead('later');

    jest.resetModules();
    readState = require('./readState');
    await readState.ensureNotifReadLoaded();
    expect(readState.isNotifRead('x', 300)).toBe(true);
    expect(readState.isNotifRead('later', 999)).toBe(true);
    expect(readState.isNotifRead('other', 999)).toBe(false);
  });

  it('migrates the legacy lastOpened watermark into allBefore', async () => {
    mockStore['stiq.notif.opened'] = '500';
    const readState = require('./readState');
    await readState.ensureNotifReadLoaded();
    expect(readState.isNotifRead('x', 500)).toBe(true);
    expect(readState.isNotifRead('x', 501)).toBe(false);
  });

  it('prunes the read-id set FIFO past its cap', async () => {
    const readState = require('./readState');
    for (let i = 0; i < 305; i++) {
      await readState.markNotifRead(`id${i}`);
    }
    expect(readState.isNotifRead('id0', 999)).toBe(false); // pruned
    expect(readState.isNotifRead('id304', 999)).toBe(true);
    expect(JSON.parse(mockStore['stiq.notif.read']!).ids).toHaveLength(300);
  });
});
