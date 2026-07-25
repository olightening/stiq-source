/**
 * The unread floor + first-entry nudge (readState.spaceBadge / unreadCount floor): a community's
 * firstEnteredAt() hides pre-join history and shows a single "1" nudge per not-yet-opened space,
 * which clears once the member opens it (lastSeen advances to >= floor).
 */

// Shared in-memory AsyncStorage mock, declared with `var` so it survives the jest.mock hoist.
// eslint-disable-next-line no-var
var mockStore: Record<string, string> = {};

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
  setItem: (k: string, v: string) => { mockStore[k] = v; return Promise.resolve(); },
  removeItem: (k: string) => { delete mockStore[k]; return Promise.resolve(); },
}));

import {
  unreadCount,
  spaceBadge,
  markSeen,
  chSeenId,
  setNotifReadSlot,
  ensureReadStateLoaded,
} from './readState';

const msg = (created_at: number, pubkey = 'other'): {created_at: number; pubkey: string} => ({created_at, pubkey});

let slotN = 0;
beforeEach(async () => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  setNotifReadSlot('t' + slotN++); // a fresh slot per test → clears the in-memory seen map
  await ensureReadStateLoaded();
});

test('floor hides pre-join history', () => {
  const id = chSeenId('c1');
  const msgs = [msg(100), msg(200), msg(900)]; // 100/200 are pre-join
  expect(unreadCount(id, msgs, 'me', 500)).toBe(1); // only the 900
});

test('floor default 0 preserves legacy counting', () => {
  const id = chSeenId('c2');
  expect(unreadCount(id, [msg(100), msg(200)], 'me')).toBe(2);
});

test('spaceBadge nudges 1 when no post-join unread and never opened', () => {
  const id = chSeenId('c3');
  expect(spaceBadge(id, [msg(100)], 'me', 500)).toBe(1); // history-only → nudge
});

test('spaceBadge shows the real count once post-join messages arrive', () => {
  const id = chSeenId('c4');
  expect(spaceBadge(id, [msg(100), msg(700), msg(800)], 'me', 500)).toBe(2);
});

test('opening (lastSeen >= floor) clears the nudge', async () => {
  const id = chSeenId('c5');
  await markSeen(id, 500); // opened, no newer messages
  expect(spaceBadge(id, [msg(100)], 'me', 500)).toBe(0);
});

test('floor 0 (existing member) never nudges', () => {
  const id = chSeenId('c6');
  expect(spaceBadge(id, [], 'me', 0)).toBe(0);
});

test('the viewer\'s own messages never count', () => {
  const id = chSeenId('c7');
  expect(unreadCount(id, [msg(700, 'me'), msg(800)], 'me', 500)).toBe(1);
});
