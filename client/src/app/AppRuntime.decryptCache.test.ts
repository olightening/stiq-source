// Finding #4 (efficiency audit 2026-07-03): a private group's history must decrypt ONCE per message
// per session, not on every getGroupMessages call. AppRuntime._spacePlaintextCache memoises the
// NIP-44 plaintext by event id, so repeat renders and search keystrokes over an open private space do
// ZERO decrypt work. These tests spy on the real decryptForSpace to count actual NIP-44 calls, and
// assert the plaintext cache is wiped on community switch and on duress.

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

// Wrap the REAL groupCrypto so encryption stays valid but every decryptForSpace call is counted.
// The `mock` prefix is REQUIRED: jest hoists jest.mock() factories above ordinary declarations, and
// only whitelists captures named mock* (evaluated lazily when the mocked module is first required).
const mockDecryptSpy = jest.fn();
jest.mock('../channels/groupCrypto', () => {
  const actual = jest.requireActual('../channels/groupCrypto');
  return {
    ...actual,
    decryptForSpace: (...args: unknown[]) => {
      mockDecryptSpy();
      return (actual.decryptForSpace as (...a: unknown[]) => string)(...args);
    },
  };
});

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

async function enrolledRuntime(): Promise<{runtime: AppRuntime; store: InMemoryEventStore}> {
  const store = new InMemoryEventStore();
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
    subscribeGroup: () => undefined,
    unsubscribeGroup: () => undefined,
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store};
}

/** Create a private (E2E) group and post `n` encrypted chat messages into it. */
async function privateGroupWithMessages(runtime: AppRuntime, n: number): Promise<string> {
  const groupId = (await runtime.createGroup({name: 'Secret', private: true, broadcast: true}))!;
  for (let i = 0; i < n; i++) await runtime.postToGroup(groupId, `secret message ${i}`);
  return groupId;
}

describe('AppRuntime private-space decrypt-once cache (finding #4)', () => {
  beforeEach(() => mockDecryptSpy.mockClear());

  it('decrypts each private-group message exactly once across multiple getGroupMessages calls', async () => {
    const {runtime} = await enrolledRuntime();
    const N = 3;
    const groupId = await privateGroupWithMessages(runtime, N);

    // First read decrypts all N; a second read (a re-render / snapshot) must hit the cache → 0 more.
    const first = runtime.getGroupMessages(groupId);
    const afterFirst = mockDecryptSpy.mock.calls.length;
    const second = runtime.getGroupMessages(groupId);
    const afterSecond = mockDecryptSpy.mock.calls.length;

    expect(first).toHaveLength(N);
    expect(first.map(m => m.content)).toEqual(second.map(m => m.content));
    // Two snapshots over N messages ⇒ exactly N decrypt calls total (once per message, ever).
    expect(afterFirst).toBe(N);
    expect(afterSecond).toBe(N);
    // The plaintext actually decrypted (not ciphertext passthrough).
    expect(first.some(m => m.content.includes('secret message 0'))).toBe(true);
  });

  it('a search keystroke over an open private group does ZERO NIP-44 decrypts', async () => {
    const {runtime} = await enrolledRuntime();
    const groupId = await privateGroupWithMessages(runtime, 4);

    // Warm the cache the way the UI does on open (one snapshot).
    runtime.getGroupMessages(groupId);
    expect(mockDecryptSpy.mock.calls.length).toBe(4);

    // Every subsequent keystroke re-drives getGroupMessages with the SAME store version — the memoised
    // group list AND the per-id plaintext cache both hit, so no decrypt runs. Drive it several times.
    mockDecryptSpy.mockClear();
    for (let k = 0; k < 5; k++) runtime.getGroupMessages(groupId);
    expect(mockDecryptSpy.mock.calls.length).toBe(0);
  });

  it('clears the decrypted-plaintext cache on community switch (no stale plaintext survives)', async () => {
    const {runtime} = await enrolledRuntime();
    const groupId = await privateGroupWithMessages(runtime, 2);
    runtime.getGroupMessages(groupId); // populate cache
    expect(mockDecryptSpy.mock.calls.length).toBe(2);

    // clearSwitchCaches is private; exercise it directly — it's the routine every community-switch
    // path funnels through (activateWorkspace / leave / duress all call it).
    (runtime as unknown as {clearSwitchCaches: () => void}).clearSwitchCaches();

    // The decrypted-plaintext cache must be empty after a switch so no plaintext bleeds across
    // communities (mirrors the DM decryptedWraps rule).
    const plaintextCache = (runtime as unknown as {_spacePlaintextCache: Map<string, string>})
      ._spacePlaintextCache;
    expect(plaintextCache.size).toBe(0);
  });

  it('wipes the decrypted-plaintext cache on duress (emergency wipe)', async () => {
    const {runtime} = await enrolledRuntime();
    const groupId = await privateGroupWithMessages(runtime, 2);
    runtime.getGroupMessages(groupId);
    const plaintextCache = (runtime as unknown as {_spacePlaintextCache: Map<string, string>})
      ._spacePlaintextCache;
    expect(plaintextCache.size).toBeGreaterThan(0);

    await runtime.wipeAllData();
    expect(plaintextCache.size).toBe(0);
  });
});
