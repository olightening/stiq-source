/**
 * The per-(account, community) first-entry signal (communityEntry.ts): the timestamp that drives
 * land-on-Updates, the welcome countdown, and the first-entry unread nudge. Only the JOIN moment
 * (recordEntry) writes it; a reload of a known community is never a "first" entry.
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
  setCommunityEntrySlot,
  ensureCommunityEntryLoaded,
  firstEnteredAt,
  wasFirstEntry,
  recordEntry,
} from './communityEntry';

beforeEach(() => {
  for (const k of Object.keys(mockStore)) delete mockStore[k];
  setCommunityEntrySlot(undefined, undefined); // reset module state between tests
});

test('unknown community: no record, not a first entry, floor 0', async () => {
  setCommunityEntrySlot('slotA', 'cidA');
  await ensureCommunityEntryLoaded();
  expect(firstEnteredAt()).toBe(0);
  expect(wasFirstEntry()).toBe(false);
});

test('recordEntry marks first entry, sets the floor, and persists', async () => {
  setCommunityEntrySlot('slotA', 'cidA');
  await ensureCommunityEntryLoaded();
  recordEntry(1000);
  expect(firstEnteredAt()).toBe(1000);
  expect(wasFirstEntry()).toBe(true);
  // A reload of the SAME (slot,cid) sees the stored floor but is no longer a "first" entry.
  setCommunityEntrySlot('slotB', 'cidB'); // move away…
  setCommunityEntrySlot('slotA', 'cidA'); // …and back
  await ensureCommunityEntryLoaded();
  expect(firstEnteredAt()).toBe(1000);
  expect(wasFirstEntry()).toBe(false);
});

test('recordEntry is idempotent (never moves the floor)', async () => {
  setCommunityEntrySlot('slotA', 'cidA');
  await ensureCommunityEntryLoaded();
  recordEntry(1000);
  recordEntry(2000);
  expect(firstEnteredAt()).toBe(1000);
});

test('keys are namespaced per (slot,cid)', async () => {
  setCommunityEntrySlot('slotA', 'cidA');
  await ensureCommunityEntryLoaded();
  recordEntry(1000);
  setCommunityEntrySlot('slotA', 'cidB'); // same account, different community
  await ensureCommunityEntryLoaded();
  expect(firstEnteredAt()).toBe(0); // cidB has its own record
  expect(wasFirstEntry()).toBe(false);
});
