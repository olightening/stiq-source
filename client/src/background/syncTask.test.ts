/**
 * Background-sync wiring tests. The heavy edges (Tor daemon, sockets, bridge network) are mocked;
 * we assert the two efficiency-critical decisions the task makes before it opens a socket:
 *   1. it opens the ACTIVE community's own encrypted cache file (per-cid), not the legacy shared DB;
 *   2. when enrolled, its subscription plan includes the user's NIP-17 gift-wrap (kind 1059) sub.
 * Plus: it closes the store handle when the task ends.
 */
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import type {SubscriptionPlan} from '../nostr/RelayClient';
import {Kind} from '../nostr/events';
import {Identity} from '../keys/identity';
import {communityId} from '../communities/communityStore';
import {InMemoryEventStore} from '../nostr/store';
// jest.mock calls below are hoisted above ALL imports, so importing the task here is safe.
import {runBackgroundSync} from './syncTask';

const RELAY_URL = 'wss://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.onion';
const OTHER_RELAY = 'wss://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.onion';

// Shared mutable capture state, referenced from inside the (hoisted) jest.mock factories. The
// `mock` name prefix is what babel-plugin-jest-hoist whitelists for out-of-scope factory refs.
const mockState: {
  storageMap: Map<string, string>;
  capturedPlan?: SubscriptionPlan;
  triggerSynced?: () => void;
  relayClose: jest.Mock;
  storeClose: jest.Mock;
  createStore: jest.Mock;
  torConnect: jest.Mock;
  torDisconnect: jest.Mock;
  // Cross-driver ownership bookkeeping (see foregroundLock.ts), mocked here so tests can assert the
  // task marks/releases ownership and honors an abort request re-checked before each connect().
  backgroundOwnsTorCalls: boolean[];
  abortRequested: boolean;
  // Lets a test simulate the foreground resuming (and requesting an abort) DURING the task's first
  // await, i.e. after the entry-point guard already passed but before the pre-connect re-check.
  simulateAbortDuringLoad: boolean;
  // T4 dormant-daemon adoption: the live-but-dormant daemon the foreground published (or null to
  // cold-start), plus counters for the SIGNAL ACTIVE / SIGNAL DORMANT calls the adopt path makes.
  adoptedDaemon: {isLive: jest.Mock; disconnect: jest.Mock} | null;
  torActiveCalls: number;
  torDormantCalls: number;
} = {
  storageMap: new Map(),
  relayClose: jest.fn(),
  storeClose: jest.fn(),
  createStore: jest.fn(),
  torConnect: jest.fn(),
  torDisconnect: jest.fn(),
  backgroundOwnsTorCalls: [],
  abortRequested: false,
  simulateAbortDuringLoad: false,
  adoptedDaemon: null,
  torActiveCalls: 0,
  torDormantCalls: 0,
};

const storage = {
  setItem: (k: string, v: string) => {
    mockState.storageMap.set(k, v);
    return Promise.resolve();
  },
  getItem: (k: string) => Promise.resolve(mockState.storageMap.get(k) ?? null),
  removeItem: (k: string) => {
    mockState.storageMap.delete(k);
    return Promise.resolve();
  },
};

// ── Mocks for the network edges (no real Tor / sockets in jest) ────────────────────────────────
jest.mock('../keys', () => ({createSecureStorage: () => storage}));
// Controllable per-test: defaults to false (the "backgrounded, headless task should proceed" case).
// mockForegroundOwnsTorNow is read lazily inside the factory so individual tests can flip it with
// mockReturnValueOnce without needing jest.resetModules().
const mockForegroundOwnsTorNow = jest.fn(() => false);
jest.mock('../tor/foregroundLock', () => ({
  foregroundOwnsTorNow: () => mockForegroundOwnsTorNow(),
  setBackgroundSyncOwnsTor: (owns: boolean) => {
    mockState.backgroundOwnsTorCalls.push(owns);
  },
  clearBackgroundSyncAbort: () => {
    mockState.abortRequested = false;
  },
  shouldBackgroundSyncAbort: () => mockState.abortRequested,
  // T4: the daemon (if any) the foreground left dormant-but-alive for this run to adopt.
  adoptableDormantDaemon: () => mockState.adoptedDaemon,
}));
// T4 dormancy signals (SIGNAL ACTIVE/DORMANT). Counters let the adopt-path tests assert the daemon
// is woken before the drain and re-idled (never disconnected) after.
jest.mock('../tor/dormancy', () => ({
  torActive: () => {
    mockState.torActiveCalls += 1;
    return true;
  },
  torDormant: () => {
    mockState.torDormantCalls += 1;
    return true;
  },
}));
jest.mock('../tor', () => ({
  createTorManager: () => ({
    connect: (...args: unknown[]) => mockState.torConnect(...args),
    disconnect: (...args: unknown[]) => mockState.torDisconnect(...args),
  }),
}));
jest.mock('../tor/bridgeCache', () => ({
  loadCachedBridges: () => {
    // Simulates the foreground resuming (and requesting an abort) mid-task, after the
    // entry-point guard already passed.
    if (mockState.simulateAbortDuringLoad) {
      mockState.abortRequested = true;
    }
    return Promise.resolve({transport: 'webtunnel', bridgeLines: ['x']});
  },
  saveCachedBridges: () => Promise.resolve(),
  clearCachedBridges: () => Promise.resolve(),
}));
jest.mock('../tor/bridgeFetch', () => ({fetchFreshBridges: () => Promise.resolve([])}));
// T15 startup jitter is default-ON (TIMING_JITTER) and uses a real timer up to 20s; pin it to 0 here
// so these wiring assertions don't wait out a random delay. The jitter's bounds/clamp are covered by
// syncSchedule.test.ts; this only removes the wall-clock sleep from the wiring harness.
jest.mock('./syncSchedule', () => ({
  ...jest.requireActual('./syncSchedule'),
  syncStartupJitterMs: () => 0,
}));
jest.mock('../nostr/torSocket', () => ({
  createTorRelaySocket: () => ({onClose: jest.fn(), close: jest.fn()}),
}));
jest.mock('../nostr/RelayClient', () => ({
  RelayClient: jest.fn((_socket: unknown, _store: unknown, opts: {plan: SubscriptionPlan}) => {
    mockState.capturedPlan = opts.plan;
    return {
      // Headless notify (T1) registers an onEvent listener to collect newly-stored events; a no-op
      // here keeps `collected` empty so deriveHeadlessNotifications is a no-op in these wiring tests.
      onEvent: jest.fn(),
      onSynced: (cb: () => void) => {
        mockState.triggerSynced = cb;
      },
      close: mockState.relayClose,
    };
  }),
}));
jest.mock('../nostr/sqliteFactory', () => ({
  createEncryptedEventStore: (...args: unknown[]) => mockState.createStore(...args),
}));

const {relayClose, storeClose} = mockState;
const createEncryptedEventStore = mockState.createStore;

/** Run the task and fire onSynced on the next tick so the EOSE drain resolves promptly. */
async function runAndSync(): Promise<void> {
  const p = runBackgroundSync();
  await new Promise(r => setImmediate(r));
  mockState.triggerSynced?.();
  await p;
}

beforeEach(() => {
  mockState.capturedPlan = undefined;
  mockState.triggerSynced = undefined;
  relayClose.mockClear();
  storeClose.mockClear();
  createEncryptedEventStore.mockReset();
  createEncryptedEventStore.mockImplementation(() => {
    const inner = new InMemoryEventStore() as InMemoryEventStore & {close: () => void};
    inner.close = storeClose;
    return Promise.resolve(inner);
  });
  mockForegroundOwnsTorNow.mockReset();
  mockForegroundOwnsTorNow.mockReturnValue(false);
  mockState.torConnect.mockReset();
  mockState.torConnect.mockResolvedValue('connected');
  mockState.torDisconnect.mockReset();
  mockState.torDisconnect.mockResolvedValue(undefined);
  mockState.backgroundOwnsTorCalls = [];
  mockState.abortRequested = false;
  mockState.simulateAbortDuringLoad = false;
  mockState.adoptedDaemon = null;
  mockState.torActiveCalls = 0;
  mockState.torDormantCalls = 0;
});

async function enroll(relayUrl: string): Promise<string> {
  // A KeyRing slot + community, so the task resolves an active cid AND an active identity.
  const sk = generateSecretKey();
  await storage.setItem('stiq.communities.active', communityId(relayUrl));
  await storage.setItem(
    'stiq.communities.list',
    JSON.stringify([{id: communityId(relayUrl), relayUrl, issuerPublicKey: 'x'}]),
  );
  await storage.setItem('stiq_active_slot', 'slot-1');
  await new Identity(storage, 'slot-1').enroll(sk, relayUrl, {
    token: new Uint8Array([1]),
    signature: new Uint8Array([2]),
  });
  return getPublicKey(sk);
}

describe('runBackgroundSync', () => {
  afterEach(async () => {
    // Reset persisted state between cases.
    for (const k of [
      'stiq.communities.active',
      'stiq.communities.list',
      'stiq_active_slot',
    ]) {
      await storage.removeItem(k);
    }
  });

  it('opens the ACTIVE account per-(cid, slot) cache, not the legacy shared DB', async () => {
    await enroll(RELAY_URL);
    await runAndSync();

    expect(createEncryptedEventStore).toHaveBeenCalledTimes(1);
    // 2nd arg is the cid — must be the active community's onion, never undefined (legacy file).
    expect(createEncryptedEventStore.mock.calls[0][1]).toBe(communityId(RELAY_URL));
    // 3rd arg is the ACTIVE identity slot (finding #4): the store is per-ACCOUNT, so background sync
    // must write the active account's OWN file (`stiq-cache-<cid>__<slot>.db`) — the exact file the
    // foreground reads on that account — resolved BEFORE the store open, not the shared per-cid DB.
    expect(createEncryptedEventStore.mock.calls[0][2]).toBe('slot-1');
  });

  it('subscribes to the user gift-wrap (kind 1059) DM sub when enrolled', async () => {
    await enroll(RELAY_URL);
    await runAndSync();

    const subs = mockState.capturedPlan!();
    const dm = subs.find(s => s.subId === 'dm');
    expect(dm).toBeDefined();
    expect(dm!.filter.kinds).toEqual([Kind.GiftWrap]);
  });

  it('closes the store handle when the task ends', async () => {
    await enroll(RELAY_URL);
    await runAndSync();
    expect(storeClose).toHaveBeenCalled();
  });

  it('tracks whichever community is active (per-cid, follows a switch)', async () => {
    await enroll(OTHER_RELAY);
    await runAndSync();
    expect(createEncryptedEventStore.mock.calls[0][1]).toBe(communityId(OTHER_RELAY));
  });

  describe('foreground/Tor-ownership guard', () => {
    it('runs the sync when the foreground does not own Tor (e.g. app is backgrounded)', async () => {
      mockForegroundOwnsTorNow.mockReturnValue(false);
      await enroll(RELAY_URL);
      await runAndSync();
      // Proves the task does NOT early-return in the backgrounded case — it reaches all the way
      // through to opening the per-community store, exactly like the "no guard" tests above.
      expect(createEncryptedEventStore).toHaveBeenCalledTimes(1);
    });

    it('early-returns without touching Tor/the store when the foreground genuinely owns it', async () => {
      mockForegroundOwnsTorNow.mockReturnValue(true);
      await enroll(RELAY_URL);
      await runBackgroundSync();
      expect(createEncryptedEventStore).not.toHaveBeenCalled();
    });

    it('marks itself as owning Tor while running and releases it when the task ends', async () => {
      await enroll(RELAY_URL);
      await runAndSync();
      // true when it starts driving Tor, false in the finally — in that order, and released only
      // once (not e.g. left dangling true).
      expect(mockState.backgroundOwnsTorCalls).toEqual([true, false]);
    });

    it('does not mark ownership at all when it early-returns for the foreground guard', async () => {
      mockForegroundOwnsTorNow.mockReturnValue(true);
      await enroll(RELAY_URL);
      await runBackgroundSync();
      expect(mockState.backgroundOwnsTorCalls).toEqual([]);
    });

    it('clears a stale abort request left over from a prior run before proceeding', async () => {
      mockState.abortRequested = true; // simulates a leftover request from a run this task aborted
      await enroll(RELAY_URL);
      await runAndSync();
      // The stale request must not block this fresh run's connect attempt.
      expect(mockState.torConnect).toHaveBeenCalled();
    });

    it('re-checks ownership immediately before connecting and skips the attempt if asked to abort mid-task', async () => {
      // Simulates the foreground resuming (and calling requestBackgroundSyncAbort()) after this
      // task's entry-point guard already passed but before its first native Tor connect.
      mockState.simulateAbortDuringLoad = true;
      await enroll(RELAY_URL);
      await runAndSync();
      expect(mockState.torConnect).not.toHaveBeenCalled();
      // Ownership is still released properly even though we never actually connected.
      expect(mockState.backgroundOwnsTorCalls).toEqual([true, false]);
    });

    // TS-2: the claim used to sit at the very top of the function, before either of these two exits —
    // an un-enrolled device's early `return` and a throwing createEncryptedEventStore — so both leaked
    // ownership forever (backgroundSyncActive stuck true for the process lifetime). The claim now sits
    // immediately before the try/finally that releases it, so neither exit should ever claim it at all.
    it('never claims ownership when there is no relay to sync (un-enrolled device, TS-2)', async () => {
      // No enroll() call: activeRelayUrl() falls back to RELAY_ONION_WS, which is '' in this build, so
      // the task must bail at `if (!relayUrl) return;` before ever touching Tor ownership.
      await runBackgroundSync();
      expect(createEncryptedEventStore).not.toHaveBeenCalled();
      expect(mockState.backgroundOwnsTorCalls).toEqual([]);
    });

    it('never claims ownership when opening the encrypted store throws (TS-2)', async () => {
      await enroll(RELAY_URL);
      createEncryptedEventStore.mockReset();
      createEncryptedEventStore.mockImplementation(() => Promise.reject(new Error('store boom')));
      await expect(runBackgroundSync()).rejects.toThrow('store boom');
      expect(mockState.backgroundOwnsTorCalls).toEqual([]);
    });
  });

  describe('EOSE-drain abort checkpoint (TS-1)', () => {
    it('unblocks the drain once the foreground requests an abort mid-drain, without waiting for onSynced', async () => {
      await enroll(RELAY_URL);
      const p = runBackgroundSync();
      // Let the task run past connect and reach the drain (RelayClient constructed, onSynced
      // registered) before the foreground asks it to abort — mirrors App.tsx's exit() calling
      // requestBackgroundSyncAbort() while this task is mid-drain.
      await new Promise(r => setImmediate(r));
      expect(mockState.triggerSynced).toBeDefined();
      mockState.abortRequested = true;
      // The task's own 500ms abort-poll checkpoint must resolve this without ever firing onSynced —
      // if the poll were missing, this would hang until the ~85s wall-clock timeout and the test
      // would time out.
      await p;
      expect(mockState.backgroundOwnsTorCalls).toEqual([true, false]);
    });
  });

  describe('dormant-daemon adoption (T4)', () => {
    // A live-but-dormant daemon the foreground published: still `connected` (isLive() true) because
    // enter() never disconnected it. createTorRelaySocket is mocked, so the drain never actually
    // touches this object beyond the isLive() re-check.
    const makeAdopted = () => ({isLive: jest.fn(() => true), disconnect: jest.fn()});

    it('adopts the dormant daemon instead of cold-starting a second one (ACTIVE → drain → DORMANT)', async () => {
      const adopted = makeAdopted();
      mockState.adoptedDaemon = adopted;
      await enroll(RELAY_URL);
      await runAndSync();

      // Woke the adopted daemon before draining, and re-idled it after — the SIGNAL ACTIVE/DORMANT pair.
      expect(mockState.torActiveCalls).toBe(1);
      expect(mockState.torDormantCalls).toBe(1);
      // Never cold-started a SECOND daemon (no createTorManager().connect()) …
      expect(mockState.torConnect).not.toHaveBeenCalled();
      // … and never disconnected the adopted one — it belongs to the foreground.
      expect(adopted.disconnect).not.toHaveBeenCalled();
      // It still ran the real sync: opened the per-account store and marked/released ownership.
      expect(createEncryptedEventStore).toHaveBeenCalledTimes(1);
      expect(mockState.backgroundOwnsTorCalls).toEqual([true, false]);
    });

    it('leaves the adopted daemon ACTIVE (no re-DORMANT) when the foreground resumes mid-sync', async () => {
      const adopted = makeAdopted();
      mockState.adoptedDaemon = adopted;
      await enroll(RELAY_URL);
      const p = runBackgroundSync();
      // Let the task run past the entry-point clearBackgroundSyncAbort() and reach the drain (onSynced
      // registered) before simulating the foreground's resume — in production this is App.tsx's exit()
      // calling requestBackgroundSyncAbort() via resumeFromDormant() while the drain is in flight. The
      // re-dormant guard is keyed off that abort request (TS-1 hardening), not foregroundOwnsTorNow()
      // — see syncTask.ts's finally comment — and the abort also doubles as what unblocks the drain
      // itself (no onSynced ever fires in this test).
      await new Promise(r => setImmediate(r));
      mockState.abortRequested = true;
      await p;

      expect(mockState.torActiveCalls).toBe(1); // still woke it to run the sync
      // The foreground now owns Tor, so the daemon must be LEFT ACTIVE for it — never re-idled …
      expect(mockState.torDormantCalls).toBe(0);
      // … and never disconnected.
      expect(adopted.disconnect).not.toHaveBeenCalled();
      expect(mockState.backgroundOwnsTorCalls).toEqual([true, false]);
    });

    it('cold-starts its own daemon (unchanged) when there is nothing to adopt', async () => {
      mockState.adoptedDaemon = null; // e.g. OS-killed app → fresh headless context, or dormancy off
      await enroll(RELAY_URL);
      await runAndSync();

      // Cold path: builds + connects its own daemon, and never issues a dormancy signal.
      expect(mockState.torConnect).toHaveBeenCalled();
      expect(mockState.torActiveCalls).toBe(0);
      expect(mockState.torDormantCalls).toBe(0);
    });
  });
});
