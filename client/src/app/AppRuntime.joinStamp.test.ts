// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so
// the runtime logic can be exercised in the test environment.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

// TIMING_JITTER only delays the background NETWORK send inside deliver() (fired-and-forgotten by
// publishOptimistic, per its own comment) — it never gates the synchronous markJoined stamp under
// test here. Disabled anyway, matching AppRuntime.groups.test.ts / AppRuntime.channelSync.test.ts,
// so no stray jittered setTimeout is left running past a test's assertions.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

/**
 * Regression coverage for the space-join-visibility fix (spaceJoinedAt.ts): subscribeChannel and
 * trackGroup both stamp the join moment so a just-joined space (no cached messages yet) sorts to
 * the TOP of the Spaces list instead of the 0 floor, dead last. See spaceJoinedAt.ts's own doc and
 * spaceJoinedAt.test.ts for the module's unit contract; this file covers the two AppRuntime call
 * sites and, in particular, the not-yet-joined guard that keeps a reconnect/restart from re-stamping
 * every already-joined group.
 */
import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {joinedAt, ensureSpaceJoinedAtLoaded, setSpaceJoinedAtSlot} from './spaceJoinedAt';
import AsyncStorage from '@react-native-async-storage/async-storage';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

async function enrolledRuntime(): Promise<{
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
  chatSubs: string[];
  subscribed: string[];
}> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const chatSubs: string[] = [];
  const subscribed: string[] = [];
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    subscribeChannelChat: (id: string) => chatSubs.push(id),
    subscribeGroup: (id: string) => subscribed.push(id),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published, chatSubs, subscribed};
}

describe('AppRuntime join stamps (spaceJoinedAt)', () => {
  const BASE = 1_700_000_000_000; // ms
  let clock = BASE;
  let nowSpy: jest.SpyInstance;
  let seq = 0;

  beforeEach(async () => {
    clock = BASE;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    // spaceJoinedAt holds module-level state keyed by slot, and AsyncStorage is the mock's own
    // in-memory map — both persist across tests in this file otherwise. Clear disk AND force a
    // fresh slot (spaceJoinedAt.test.ts idiom) so runtime.init()'s own setSpaceJoinedAtSlot(realSlot)
    // — called from loadWorkspaceState with whatever slot id this run's enrollment lands on — always
    // sees a slot change and actually reloads (from now-empty storage) rather than a same-slot no-op
    // that would leave a previous test's stamps in memory.
    await AsyncStorage.clear();
    setSpaceJoinedAtSlot(`joinstamp-test-${seq++}`);
    await ensureSpaceJoinedAtLoaded();
  });

  afterEach(() => nowSpy.mockRestore());

  describe('subscribeChannel', () => {
    it('stamps joinedAt for the channel synchronously, before the sign+publish round trip resolves', async () => {
      const {runtime} = await enrolledRuntime();
      const channelId = '30311:owner:c1';

      // markJoined sits before subscribeChannel's first `await` (identity.sign) — so the stamp is
      // already in memory in the synchronous continuation right after the call, well before the
      // publish this kicks off has any chance to resolve.
      const pending = runtime.subscribeChannel(channelId);
      expect(joinedAt(channelId)).toBeGreaterThan(0);
      await pending;
      expect(joinedAt(channelId)).toBeGreaterThan(0);
    });

    it('does NOT re-stamp a channel we are already subscribed to', async () => {
      const {runtime} = await enrolledRuntime();
      const channelId = '30311:owner:c1';

      await runtime.subscribeChannel(channelId);
      const first = joinedAt(channelId);
      expect(first).toBeGreaterThan(0);

      clock += 60_000; // an observable amount of time later
      await runtime.subscribeChannel(channelId); // already subscribed — early-returns before markJoined
      expect(joinedAt(channelId)).toBe(first); // unchanged — a re-tap must not re-pin the row
    });
  });

  describe('trackGroup (via joinGroup)', () => {
    it('stamps joinedAt once on a genuine first join', async () => {
      const {runtime} = await enrolledRuntime();
      await runtime.joinGroup('g1');
      expect(joinedAt('g1')).toBeGreaterThan(0);
    });

    it('does NOT re-stamp an already-tracked group across a reconnect/restart-shaped re-entry — regression guard for "every group jumps to the top of Spaces on every app start"', async () => {
      const {runtime, subscribed} = await enrolledRuntime();

      await runtime.joinGroup('g1');
      const first = joinedAt('g1');
      expect(first).toBeGreaterThan(0);

      clock += 3_600_000; // an hour later — well past any real reconnect

      // Reconnect shape: 'g1' is already in joinedGroups, so onRelaySubscribed's resubscribeGroups
      // re-opens the scoped sub by calling deps.subscribeGroup directly — it never re-enters
      // trackGroup at all, so this step alone proves nothing about the guard by itself; it's here to
      // show the stamp survives the part of "restart" this harness CAN exercise before the real test.
      subscribed.length = 0;
      runtime.onRelaySubscribed();
      expect(subscribed).toContain('g1');
      expect(joinedAt('g1')).toBe(first);

      // The guard actually under test: trackGroup has several call sites besides joinGroup
      // (requestToJoin, acceptSpaceInvite, adoptEventGroup re-processing a folded event on resync) —
      // any of them can re-enter trackGroup for a group already in joinedGroups. joinGroup is the
      // cheapest public path to force that re-entry. trackGroup's `if (!this.joinedGroups.has(groupId))`
      // must skip markJoined this second time; if a future edit ever hoisted the stamp out of that
      // guard, this call would re-pin 'g1' to the advanced clock — and since joinedGroups is rehydrated
      // wholesale on every cold start (loadWorkspaceState, ~line 2711) with every remembered group
      // already "joined", any such re-entry path firing during startup would re-stamp ALL of them,
      // i.e. every group jumps to the top of Spaces on every app start.
      await runtime.joinGroup('g1');
      expect(joinedAt('g1')).toBe(first);
    });
  });
});
