/**
 * D1 (per-account notification isolation): the mute list, high-water marks, read/seen state, and
 * notification-center read state are namespaced PER ACCOUNT (KeyRing slot). Two identities on one
 * device must never share them — switching accounts must show each account's OWN state, and neither
 * must inherit the other's. setNotificationAccount(slotId) is the switch hook the runtime calls.
 */

// Shared in-memory AsyncStorage mock, declared with `var` so it survives the jest.mock hoist.
// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => { mockStore[k] = v; return Promise.resolve(); },
  removeItem: (k: string) => { delete mockStore[k]; return Promise.resolve(); },
}));

import {setNotificationAccount, muteSource, isSourceMuted} from './notifications';
import {markSeen, lastSeen, dmSeenId, markNotifRead, isNotifRead} from './readState';

describe('notification state is siloed per account (finding D1)', () => {
  it('does not leak one account\'s mute / seen / read state into another, and restores each on switch-back', async () => {
    const peer = dmSeenId('peerX');

    // ── Account A: mute a channel, mark a DM seen, read a notification ──
    await setNotificationAccount('slot-A');
    await markSeen(peer, 1000);
    await muteSource('chan1');
    await markNotifRead('notif1');
    expect(lastSeen(peer)).toBe(1000);
    expect(await isSourceMuted('chan1')).toBe(true);
    expect(isNotifRead('notif1', 5000)).toBe(true);

    // ── Switch to Account B: must start FRESH — none of A's state is visible ──
    await setNotificationAccount('slot-B');
    expect(lastSeen(peer)).toBe(0); // was 1000 for A — the bug this closes
    expect(await isSourceMuted('chan1')).toBe(false);
    expect(isNotifRead('notif1', 5000)).toBe(false);

    // B sets its OWN distinct state.
    await markSeen(peer, 2000);
    await muteSource('chan2');

    // ── Back to Account A: A's original state is restored; B's never leaks in ──
    await setNotificationAccount('slot-A');
    expect(lastSeen(peer)).toBe(1000); // A's value, NOT B's 2000
    expect(await isSourceMuted('chan1')).toBe(true); // A muted chan1
    expect(await isSourceMuted('chan2')).toBe(false); // chan2 was B's mute, not A's
    expect(isNotifRead('notif1', 5000)).toBe(true);

    // ── And B still has ITS state, not A's ──
    await setNotificationAccount('slot-B');
    expect(lastSeen(peer)).toBe(2000);
    expect(await isSourceMuted('chan2')).toBe(true);
    expect(await isSourceMuted('chan1')).toBe(false);
  });

  it('the pre-silo global keys are used when no slot is set (backward-compatible upgrade baseline)', async () => {
    // A fresh unslotted context reads the legacy global key names, so an un-enrolled install and the
    // one-time upgrade seed keep working.
    await setNotificationAccount(undefined);
    await markSeen(dmSeenId('legacy'), 42);
    expect(mockStore['stiq.read.seen']).toContain('42'); // legacy global key, not a slot-suffixed one
  });
});
