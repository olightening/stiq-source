// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so
// the runtime logic can be exercised in the test environment.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

// SCOPED_CHANNEL_SYNC forced ON. The flag shipped dark and was flipped ON on 2026-07-15, so this now
// AGREES with the committed value rather than overriding it — kept explicit anyway, because this file
// tests plumbing that only exists in the ON state (openChannel/closeChannel are no-ops when the flag
// is off), so it should state the precondition it needs instead of inheriting it and silently
// becoming vacuous if the flag is ever rolled back. The committed value itself is pinned, unmocked,
// in nostr/subscriptionPlan.channels.on.test.ts. TIMING_JITTER off for the same reason
// AppRuntime.groups.test.ts disables it: these assertions run against synchronous flushes.
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
  SCOPED_CHANNEL_SYNC: true,
}));

/**
 * Bug 8 — AppRuntime's channel-scoped subscription plumbing: the NIP-53 mirror of
 * openGroup/closeGroup/resubscribeGroups.
 *
 * The invariant under test is "a channel you can see, you can read". Once kind 1311 leaves the
 * firehose, the standing `channels` sub only carries channels the member is IN — so every other way
 * of reaching a channel (a profile's owned-channels list, a stiq:space embed, a deep link) depends
 * entirely on this plumbing. If it silently no-ops, those channels open blank.
 */
import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {Kind} from '../nostr/events';

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
  chatUnsubs: string[];
}> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const chatSubs: string[] = [];
  const chatUnsubs: string[] = [];
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
    unsubscribeChannelChat: (id: string) => chatUnsubs.push(id),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published, chatSubs, chatUnsubs};
}

describe('AppRuntime — channel-scoped subscription plumbing (bug 8)', () => {
  it('openChannel opens the channel\'s scoped sub; closeChannel closes it', async () => {
    const {runtime, chatSubs, chatUnsubs} = await enrolledRuntime();
    runtime.openChannel('30311:owner:c1');
    expect(chatSubs).toEqual(['30311:owner:c1']);
    expect(chatUnsubs).toEqual([]);
    runtime.closeChannel('30311:owner:c1');
    expect(chatUnsubs).toEqual(['30311:owner:c1']);
  });

  it('re-opens every OPEN channel on reconnect — the discovery case would go silent otherwise', async () => {
    // RelayClient.sendSubscribe() resets knownSubIds to the plan's subs on every (re)connect, so a
    // scoped sub does not survive it. A JOINED channel recovers automatically (the plan re-emits the
    // standing `channels` sub), but an open UNJOINED channel is carried by nothing else — without
    // resubscribeChannels its view would stop updating mid-read and never recover. The trigger is
    // onRelaySubscribed (fired AFTER sendSubscribe's reset), never onRelayConnected (pre-open).
    const {runtime, chatSubs} = await enrolledRuntime();
    runtime.openChannel('30311:owner:c1');
    runtime.openChannel('30311:owner:c2');
    chatSubs.length = 0;

    runtime.onRelaySubscribed();

    expect(chatSubs.sort()).toEqual(['30311:owner:c1', '30311:owner:c2']);
  });

  it('does NOT re-open a channel whose view has been closed', async () => {
    const {runtime, chatSubs} = await enrolledRuntime();
    runtime.openChannel('30311:owner:c1');
    runtime.closeChannel('30311:owner:c1');
    chatSubs.length = 0;

    runtime.onRelaySubscribed();

    expect(chatSubs).toEqual([]);
  });

  it('following a channel opens its sub immediately, not on the next reconnect', async () => {
    // The plan's standing `channels` sub is only rebuilt on (re)connect. Without this the member
    // would press Follow and then watch a channel that stays frozen until something else reconnected.
    const {runtime, chatSubs} = await enrolledRuntime();
    await runtime.subscribeChannel('30311:owner:c1');
    expect(chatSubs).toEqual(['30311:owner:c1']);
  });

  it('following a channel we already follow does not re-open the sub', async () => {
    const {runtime, chatSubs} = await enrolledRuntime();
    await runtime.subscribeChannel('30311:owner:c1');
    chatSubs.length = 0;
    await runtime.subscribeChannel('30311:owner:c1');
    expect(chatSubs).toEqual([]);
  });
});

/**
 * The decoy-inertness contract. The scoped `channels` sub deliberately fetches a few channels the
 * member is NOT in, as cover traffic — so those messages DO land in the store. Every read path that
 * surfaces channel activity to the user must therefore scope to the member's own channels, or cover
 * traffic becomes visible: the member gets pinged by a handful of arbitrary channels they never
 * joined, which is both nonsense UX and a tell that those channels are decoys.
 *
 * This mirrors how the existing decoys stay invisible: a decoy gift wrap simply fails to decrypt, and
 * a decoy's NIP-51 lists are read back filtered to `authors:[me]`. Channel messages have no such
 * natural filter — they decrypt and parse fine — so the scoping has to be explicit, which is exactly
 * why it needs a test.
 */
describe('AppRuntime — decoy channels stay INERT (bug 8)', () => {
  const OTHER = 'b'.repeat(64);

  function saveChannel(store: InMemoryEventStore, owner: string, d: string): string {
    store.save({
      id: `def${d}`.padEnd(64, '0'),
      pubkey: owner,
      created_at: 10,
      kind: Kind.LiveActivity,
      tags: [['d', d], ['title', `#${d}`]],
      content: '',
      sig: '',
    } as Event);
    return `30311:${owner}:${d}`;
  }

  function saveChat(store: InMemoryEventStore, coord: string, id: string): void {
    store.save({
      id: id.padEnd(64, '0'),
      pubkey: OTHER,
      created_at: 100,
      kind: Kind.LiveChat,
      tags: [['a', coord, '', 'root']],
      content: 'hello',
      sig: '',
    } as Event);
  }

  it('notifies for a channel the member IS in — badges must survive the scoping', async () => {
    // The product half of the trade-off: scoping WHO we sync must not cost the member notifications
    // for their own channels. This is precisely why the plan carries a STANDING cover sub rather than
    // relying on open/close alone — a joined channel's messages keep arriving unopened, so this row
    // still appears.
    const {runtime, store} = await enrolledRuntime();
    const mine = saveChannel(store, OTHER, 'mine');
    saveChat(store, mine, 'm1');
    await runtime.subscribeChannel(mine);

    const rows = runtime.deriveNotifications().filter(n => n.kind === 'channel');
    expect(rows.map(r => r.target)).toContainEqual(
      expect.objectContaining({channelId: mine}),
    );
  });

  it('does NOT notify for a decoy channel whose messages the cover set pulled in', async () => {
    const {runtime, store} = await enrolledRuntime();
    const mine = saveChannel(store, OTHER, 'mine');
    const decoy = saveChannel(store, OTHER, 'decoy');
    saveChat(store, mine, 'm1');
    saveChat(store, decoy, 'd1'); // arrived purely as cover traffic
    await runtime.subscribeChannel(mine);

    const rows = runtime.deriveNotifications().filter(n => n.kind === 'channel');
    const ids = rows.map(r => (r.target as {channelId?: string}).channelId);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(decoy);
  });

  it('refreshes the notification list when the member FOLLOWS a channel (cache key covers 10009)', async () => {
    // deriveNotifications is version-cached. Once its channel rows are scoped by the member's
    // kind-10009 follow list, that list becomes an INPUT — so following a channel must invalidate the
    // cache. It would not, without kind 10009 in the key: the derive reads no other kind that a
    // Follow bumps, so the member would press Follow and see the channel keep NOT notifying until
    // some unrelated event happened along.
    const {runtime, store} = await enrolledRuntime();
    const coord = saveChannel(store, OTHER, 'later');
    saveChat(store, coord, 'l1');

    // Warm the cache while we are NOT in the channel.
    expect(runtime.deriveNotifications().filter(n => n.kind === 'channel')).toHaveLength(0);

    await runtime.subscribeChannel(coord);

    const ids = runtime
      .deriveNotifications()
      .filter(n => n.kind === 'channel')
      .map(r => (r.target as {channelId?: string}).channelId);
    expect(ids).toContain(coord);
  });

  it('notifies for a channel the member ADMINISTERS without following', async () => {
    // channelSyncIds unions followed ∪ owned ∪ administered, and the notification scoping reads that
    // same set — so an admin isn't treated as a stranger to their own channel.
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getPubkey()!;
    store.save({
      id: 'adm'.padEnd(64, '0'),
      pubkey: OTHER,
      created_at: 10,
      kind: Kind.LiveActivity,
      tags: [['d', 'adm'], ['title', '#adm'], ['p', me, 'admin']],
      content: '',
      sig: '',
    } as Event);
    const coord = `30311:${OTHER}:adm`;
    saveChat(store, coord, 'a1');

    const rows = runtime.deriveNotifications().filter(n => n.kind === 'channel');
    expect(rows.map(r => (r.target as {channelId?: string}).channelId)).toContain(coord);
  });
});

describe('AppRuntime — the channel sets handed to the subscription plan (bug 8)', () => {
  it('channelSyncSet reports the channels I follow', async () => {
    const {runtime} = await enrolledRuntime();
    await runtime.subscribeChannel('30311:owner:c1');
    expect(runtime.channelSyncSet()).toContain('30311:owner:c1');
  });

  it('channelSyncSet is empty for a member in no channels — the plan then emits no sub at all', async () => {
    const {runtime} = await enrolledRuntime();
    expect(runtime.channelSyncSet()).toEqual([]);
  });

  it('knownChannelIds reports every cached channel definition — the decoy candidate universe', async () => {
    const {runtime, store} = await enrolledRuntime();
    // Channel definitions (30311) stay on the firehose, which is exactly what makes them usable as
    // decoy candidates: a decoy must be a channel the relay can believe we read.
    store.save({
      id: 'e1'.repeat(32),
      pubkey: 'a'.repeat(64),
      created_at: 1,
      kind: Kind.LiveActivity,
      tags: [['d', 'c9'], ['title', 'Nine']],
      content: '',
      sig: '',
    } as Event);
    expect(runtime.knownChannelIds()).toContain(`30311:${'a'.repeat(64)}:c9`);
  });
});
