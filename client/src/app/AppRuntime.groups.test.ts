// AppRuntime transitively imports native modules with no Jest mock in this repo; stub them so
// the runtime logic can be exercised in the test environment.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';
import {Kind} from '../nostr/events';
import type {GradientSpec} from '../media/gradient';
import {encodeGradient} from '../media/gradient';
import {encodeIdentityHeader, decodeNameHeader, decodeGradientHeader} from '../profile/displayName';
import {KIND_SPACE_INVITES} from '../channels/membership';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** An enrolled, unlocked runtime plus the store, published events, and group-subscription calls. */
async function enrolledRuntime(): Promise<{
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
  subscribed: string[];
  unsubscribed: string[];
}> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    subscribeGroup: (id: string) => subscribed.push(id),
    unsubscribeGroup: (id: string) => unsubscribed.push(id),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published, subscribed, unsubscribed};
}

function lastOfKind(published: Event[], kind: number): Event | undefined {
  return [...published].reverse().find(e => e.kind === kind);
}

let relayStateSeq = 0;
/** A relay-signed replaceable state event (mirrors AppRuntime.rosterOverlay.test.ts's relayState). */
function relayState(kind: number, tags: string[][]): Event {
  relayStateSeq += 1;
  return {
    id: (relayStateSeq.toString(36) + 'e'.repeat(64)).slice(0, 64),
    pubkey: 'f'.repeat(64),
    created_at: 1000 + relayStateSeq,
    kind,
    tags,
    content: '',
    sig: 's',
  } as Event;
}

/** Typed accessor for the private in-memory space-key cache (mirrors AppRuntime.rosterOverlay.
 *  test.ts's internals() pattern) — lets a test evict a key from MEMORY while leaving it persisted
 *  in the keystore, simulating a cold app restart without a second runtime/keystore pair. */
function internals(runtime: AppRuntime): {_spaceKeyCache: Map<string, Uint8Array>} {
  return runtime as unknown as {_spaceKeyCache: Map<string, Uint8Array>};
}

describe('AppRuntime NIP-29 group actions', () => {
  it('createGroup publishes a 9007 with metadata and returns the group id', async () => {
    const {runtime, published} = await enrolledRuntime();
    const groupId = await runtime.createGroup({name: 'My Group', closed: true});
    expect(groupId).toBeTruthy();

    const create = lastOfKind(published, GroupKind.Create);
    expect(create).toBeDefined();
    expect(create!.tags).toContainEqual(['h', groupId]);
    expect(create!.tags).toContainEqual(['name', 'My Group']);
    expect(create!.tags).toContainEqual(['closed']);
  });

  it('createGroup seeds OPTIMISTIC local state so a private channel works before the relay replies', async () => {
    const {runtime} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const groupId = (await runtime.createGroup({name: 'Secret Ops', private: true, broadcast: true, closed: true}))!;
    // No relay 39000-39003 has arrived, yet the space renders correctly from the optimistic seed:
    const state = runtime.getGroupState(groupId);
    expect(state?.name).toBe('Secret Ops');
    expect(state?.private).toBe(true);
    expect(state?.broadcast).toBe(true);
    expect(state?.owner).toBe(me);
    // Creator is owner + admin + member immediately (so GroupView shows the composer, not "Join").
    expect(runtime.getGroupMembers(groupId)).toEqual([me]);
    expect(runtime.getGroupAdmins(groupId)).toEqual([me]);
  });

  it('createGroup publishes ONLY the 9007 create — the optimistic 39000-39003 are local-only', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.createGroup({name: 'X', private: true, broadcast: true});
    // The relay rejects client-authored state, so it must never be sent; only the 9007 goes out.
    const stateSent = published.filter(
      e => e.kind === GroupKind.Metadata || e.kind === GroupKind.Admins || e.kind === GroupKind.Members,
    );
    expect(stateSent).toHaveLength(0);
    expect(published.some(e => e.kind === GroupKind.Create)).toBe(true);
  });

  it('a relay-authoritative 39000 supersedes the optimistic seed regardless of timestamp', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const groupId = (await runtime.createGroup({name: 'Draft Name', private: true, broadcast: true}))!;
    // Relay emits authoritative metadata (NO ['optimistic'] tag) with an OLDER created_at:
    store.save({
      id: 'b'.repeat(64), pubkey: 'f'.repeat(64), kind: GroupKind.Metadata, created_at: 1, sig: 's', content: '',
      tags: [['d', groupId], ['name', 'Relay Name'], ['private'], ['broadcast'], ['owner', me]],
    } as Event);
    // betterState prefers the relay copy even though the optimistic seed is newer.
    expect(runtime.getGroupState(groupId)?.name).toBe('Relay Name');
  });

  it('createChannel returns the new coordinate and the open community is optimistically listed', async () => {
    const {runtime} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const coord = await runtime.createChannel({name: 'Announcements', openCommunity: true});
    expect(coord).toBe(`${Kind.LiveActivity}:${me}:${coord!.split(':')[2]}`);
    const chans = runtime.getSnapshot().channels ?? [];
    expect(chans.some(c => c.id === coord && c.openCommunity)).toBe(true);
  });

  it('createGroup opens a scoped subscription so the new group becomes visible', async () => {
    const {runtime, subscribed} = await enrolledRuntime();
    const groupId = await runtime.createGroup({name: 'Visible'});
    // Without this subscription the relay never re-streams the 39002 member list and the
    // freshly-created group stays invisible — the bug this guards against.
    expect(subscribed).toContain(groupId);
  });

  it('joined groups are re-subscribed when each (re)connect sends its plan (onRelaySubscribed)', async () => {
    // onRelaySubscribed — NOT onRelayConnected — is the resubscribe moment: onRelayConnected runs at
    // relay construction, pre-open, and sendSubscribe()'s registry reset would wipe subs made there.
    const {runtime, subscribed} = await enrolledRuntime();
    const groupId = await runtime.createGroup({name: 'Persisted'});
    subscribed.length = 0; // clear the create-time subscribe
    runtime.onRelaySubscribed();
    expect(subscribed).toContain(groupId);
  });

  it('leaveGroup stops re-subscribing to the group', async () => {
    const {runtime, subscribed, unsubscribed} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Leaving'}))!;
    await runtime.leaveGroup(groupId);
    expect(unsubscribed).toContain(groupId);
    subscribed.length = 0;
    runtime.onRelaySubscribed();
    expect(subscribed).not.toContain(groupId);
  });

  it('leaving a group you own removes it from your list (relay forbids owner-leave)', async () => {
    const {runtime} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Mine'}))!;
    expect(runtime.getSnapshot().groups.map(g => g.id)).toContain(groupId);

    // Even though the relay rejects an owner's 9022, the group must disappear from the owner's
    // own view — the exact "leaving isn't leaving" bug.
    await runtime.leaveGroup(groupId);
    expect(runtime.getSnapshot().groups.map(g => g.id)).not.toContain(groupId);
  });

  it('postToGroup publishes an h-tagged kind-9 chat', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.postToGroup('g1', 'hello group');
    const chat = lastOfKind(published, GroupKind.Chat);
    expect(chat).toBeDefined();
    // A nameless user embeds no NAME header, but enrollment without a chosen gradient auto-claims a
    // random one (#9), so a gradient header rides every authored body regardless -- decodeNameHeader
    // strips BOTH leading headers (see parseHeaders), so .text is the literal body either way.
    expect(decodeNameHeader(chat!.content).name).toBeUndefined();
    expect(decodeGradientHeader(chat!.content)).toBeDefined();
    expect(decodeNameHeader(chat!.content).text).toBe('hello group');
    expect(chat!.tags).toContainEqual(['h', 'g1']);
  });

  // ── multi-user identity propagation (private channels / groups) ───────────────
  //
  // Group authored cards (private/broadcast channels) and chat bubbles must show each member's
  // chosen display name + gradient. Identity rides INSIDE the kind-9 body (relay-blind), so it has
  // to be embedded outbound and learned inbound — group chat is kind 9, NOT one of the feed kinds.

  it('postToGroup embeds the sender display name so other members can render it', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Alice');
    await runtime.postToGroup('g1', 'hello group');

    const chat = lastOfKind(published, GroupKind.Chat)!;
    expect(decodeNameHeader(chat.content).name).toBe('Alice');
    expect(decodeNameHeader(chat.content).text).toBe('hello group'); // body strips the header
    expect(chat.tags).toContainEqual(['h', 'g1']);
  });

  it('editGroupMessage keeps the sender display name embedded on the edit', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Alice');
    await runtime.editGroupMessage('g1', 'orig' + '0'.repeat(60), 'fixed text');

    const edit = lastOfKind(published, GroupKind.Chat)!;
    expect(decodeNameHeader(edit.content).name).toBe('Alice');
    expect(decodeNameHeader(edit.content).text).toBe('fixed text');
    // Still an edit marker so it folds over the original rather than rendering twice.
    expect(edit.tags).toContainEqual(['e', 'orig' + '0'.repeat(60), '', 'edit']);
  });

  it('learns another member display name from their incoming kind-9 group chat', async () => {
    const {runtime} = await enrolledRuntime();
    const bob = 'b'.repeat(64);
    // Before hearing from Bob he is anonymous (renders as bare npub).
    expect(runtime.getProfile(bob).name).toBeFalsy();

    const bobMsg: Event = {
      id: 'bobmsg' + '0'.repeat(58),
      pubkey: bob,
      created_at: 2_000,
      kind: GroupKind.Chat,
      tags: [['h', 'g1']],
      content: encodeIdentityHeader('hi everyone', 'Bob', ''),
      sig: '',
    } as Event;
    runtime.handleIncomingEvent(bobMsg);

    // The card/bubble resolves Bob's name via getProfile — proving cross-user identity now flows.
    expect(runtime.getProfile(bob).name).toBe('Bob');
  });

  it('join / leave / kick publish the right management kinds', async () => {
    const {runtime, published} = await enrolledRuntime();
    const target = 'b'.repeat(64);

    await runtime.joinGroup('g1');
    expect(lastOfKind(published, GroupKind.JoinRequest)!.tags).toContainEqual(['h', 'g1']);

    await runtime.leaveGroup('g1');
    expect(lastOfKind(published, GroupKind.LeaveRequest)).toBeDefined();

    await runtime.kickGroupMember('g1', target);
    const kick = lastOfKind(published, GroupKind.RemoveUser);
    expect(kick!.tags).toContainEqual(['p', target]);

    await runtime.addGroupMember('g1', target, true);
    const add = lastOfKind(published, GroupKind.AddUser);
    expect(add!.tags).toContainEqual(['p', target, 'admin']);
  });

  it('exposes member-of groups and admin status from cached relay state', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    expect(me).toBeTruthy();

    // The viewer joins g1 (local membership intent drives the visible list).
    await runtime.joinGroup('g1');

    // Seed the relay-generated state naming the current user as an admin+member of g1.
    const state = (kind: number, tags: string[][]): Event =>
      ({id: Math.random().toString(36), pubkey: 'relay', created_at: 1000, kind, tags, content: '', sig: ''} as Event);
    store.save(state(GroupKind.Metadata, [['d', 'g1'], ['name', 'Seeded']]));
    store.save(state(GroupKind.Admins, [['d', 'g1'], ['p', me, 'admin']]));
    store.save(state(GroupKind.Members, [['d', 'g1'], ['p', me]]));

    const groups = runtime.getSnapshot().groups;
    expect(groups.map(g => g.id)).toContain('g1');
    expect(groups.find(g => g.id === 'g1')).toMatchObject({name: 'Seeded', isAdmin: true});
    expect(runtime.isGroupAdmin('g1')).toBe(true);
    expect(runtime.getGroupMembers('g1')).toEqual([me]);
  });
});

// ── openGroup/closeGroup session set (openGroups) ────────────────────────────────────────────────
//
// resubscribeGroups() unions `joinedGroups` (persisted membership) with `openGroups` (session-only
// views currently on screen) so an OPEN-BUT-UNJOINED group — a locked preview, a space you're
// deciding whether to request — keeps its scoped subscription alive across a reconnect exactly like
// a joined one does, instead of losing it permanently the moment sendSubscribe() resets knownSubIds.

describe('AppRuntime openGroup/closeGroup session-set resubscribe (openGroups ∪ joinedGroups)', () => {
  it('openGroup on a group you have NOT joined keeps resubscribing it via the openGroups union', async () => {
    const {runtime, subscribed} = await enrolledRuntime();
    const groupId = 'discovered-unjoined-group-1';
    runtime.openGroup(groupId);
    subscribed.length = 0; // clear the open-time subscribe
    runtime.onRelaySubscribed();
    expect(subscribed).toContain(groupId);
  });

  it('closeGroup on an unjoined group removes it, so a later onRelaySubscribed no longer resubscribes it', async () => {
    const {runtime, subscribed} = await enrolledRuntime();
    const groupId = 'discovered-unjoined-group-2';
    runtime.openGroup(groupId);
    runtime.closeGroup(groupId);
    subscribed.length = 0;
    runtime.onRelaySubscribed();
    expect(subscribed).not.toContain(groupId);
  });

  it('a joined group still resubscribes alongside an unrelated open (unjoined) one — no regression', async () => {
    const {runtime, subscribed} = await enrolledRuntime();
    const joinedId = (await runtime.createGroup({name: 'Joined'}))!;
    const openOnlyId = 'discovered-unjoined-group-3';
    runtime.openGroup(openOnlyId);
    subscribed.length = 0; // clear the create-time + open-time subscribes
    runtime.onRelaySubscribed();
    expect(subscribed).toContain(joinedId);
    expect(subscribed).toContain(openOnlyId);
  });
});

// ── M32 field fix: invited+pending auto-approve sweep re-runs (Olene's incident) ────────────────
//
// Ground truth (verified live): admin invites Olene to a private/closed group; her request-to-join
// (9021) IS recorded in the relay's Pending set; the admin's JOIN REQUESTS panel never shows it
// because she's ALSO invited (autoApproveInvited should have silently promoted her, but never ran
// again once its one arrival-triggered shot bailed with an empty invited set). Root cause: for a
// PRIVATE space, getSpaceInvited can't decrypt the invited-set doc until the space key is hydrated
// into `_spaceKeyCache` (openGroup → hydrateSpaceKeys) — a pending 9021 arriving before that (e.g.
// connect-time backfill on a cold reconnect) sees an empty invited set and, since nothing re-ran the
// sweep, never got a second chance.
describe('M32 field fix: invited+pending auto-approve sweep re-runs (Olene repro)', () => {
  it('opening the group promotes an invited+pending member once its key re-hydrates (exact repro)', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    const olene = 'c'.repeat(64);
    const rt = runtime as unknown as {sendDM: () => Promise<void>};
    rt.sendDM = async () => {}; // PoW/crypto mining is exercised by the DM suites, not here.
    await runtime.inviteToSpace(groupId, [olene]);
    expect(runtime.getSpaceInvited(groupId).map(i => i.p)).toEqual([olene]); // sanity: invite recorded

    // Simulate the admin's app having restarted: the space key is evicted from MEMORY (it stays
    // persisted in the keystore — see internals()'s doc). getSpaceInvited can no longer decrypt the
    // invited-set doc, exactly the state autoApproveInvited's `if (invited.size === 0) return;` sees.
    internals(runtime)._spaceKeyCache.delete(`${groupId}:0`);
    expect(runtime.getSpaceInvited(groupId)).toEqual([]);

    // Olene's request WAS recorded on the relay (ground truth: groups.json Pending set) — her real
    // 9021 is already ingested. This is the ONE historic arrival-triggered sweep; it bails, keyless.
    const pending = relayState(GroupKind.Pending, [['d', groupId], ['p', olene]]);
    store.save(pending);
    runtime.handleIncomingEvent(pending);
    await new Promise(r => setTimeout(r, 0));
    expect(runtime.getGroupMembers(groupId)).not.toContain(olene); // reproduces the stuck state

    // The admin simply opens the group — sweepInvitedAfterKeys re-runs the sweep once the key,
    // recovered from the keystore, is back in memory. No further 9021/39004 arrival is needed: the
    // sweep re-reads EXISTING pending state straight from the local store.
    runtime.openGroup(groupId);
    await new Promise(r => setTimeout(r, 0)); // let hydrateSpaceKeys resolve + the chained sweep run

    const adds = published.filter(e => e.kind === GroupKind.AddUser);
    expect(adds).toHaveLength(1);
    expect(adds[0]!.tags).toContainEqual(['p', olene]);
  });

  it('a reconnect (the group list refreshing) also re-sweeps every joined group, not only an opened one', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const groupId = (await runtime.createGroup({name: 'Secret', private: true, closed: true}))!;
    const olene = 'd'.repeat(64);
    const rt = runtime as unknown as {sendDM: () => Promise<void>};
    rt.sendDM = async () => {};
    await runtime.inviteToSpace(groupId, [olene]);
    internals(runtime)._spaceKeyCache.delete(`${groupId}:0`);

    const pending = relayState(GroupKind.Pending, [['d', groupId], ['p', olene]]);
    store.save(pending);
    runtime.handleIncomingEvent(pending);
    expect(runtime.getGroupMembers(groupId)).not.toContain(olene);

    // A reconnect resubscribes every remembered group (onRelaySubscribed → resubscribeGroups) —
    // this is the "admin's overnight→morning" moment itself, with no explicit group-screen open.
    runtime.onRelaySubscribed();
    await new Promise(r => setTimeout(r, 0));

    const adds = published.filter(e => e.kind === GroupKind.AddUser);
    expect(adds.some(e => e.tags.some(t => t[0] === 'p' && t[1] === olene))).toBe(true);
  });

  it('a KIND_SPACE_INVITES doc arrival re-runs the sweep for an admin who receives it after the fact', async () => {
    // Admin A invites Olene to a PUBLIC group (no key machinery — isolates the doc-arrival trigger
    // from the key-hydration one, already covered above). Admin B is a second admin on a separate
    // device who has not yet received A's invited-set doc when Olene's Pending state reaches them.
    const a = await enrolledRuntime();
    const aPk = a.runtime.getSnapshot().currentUserPubkey!;
    const groupId = (await a.runtime.createGroup({name: 'Team', closed: true}))!;
    const olene = 'e'.repeat(64);
    const rtA = a.runtime as unknown as {sendDM: () => Promise<void>};
    rtA.sendDM = async () => {};
    await a.runtime.inviteToSpace(groupId, [olene]);
    const invitesDoc = lastOfKind(a.published, KIND_SPACE_INVITES)!;

    const b = await enrolledRuntime();
    const bPk = b.runtime.getSnapshot().currentUserPubkey!;
    b.store.save(relayState(GroupKind.Metadata, [['d', groupId], ['name', 'Team'], ['owner', aPk], ['closed']]));
    b.store.save(relayState(GroupKind.Admins, [['d', groupId], ['p', aPk], ['p', bPk]]));
    b.store.save(relayState(GroupKind.Members, [['d', groupId], ['p', aPk], ['p', bPk]]));

    const pending = relayState(GroupKind.Pending, [['d', groupId], ['p', olene]]);
    b.store.save(pending);
    b.runtime.handleIncomingEvent(pending); // arrival-triggered sweep runs; the doc is still unknown
    expect(b.runtime.getGroupMembers(groupId)).not.toContain(olene);

    // The invited-set doc finally reaches B's device (relay backfill) — its own arrival must be
    // enough, with no group open and no further 9021/39004 needed.
    b.store.save(invitesDoc);
    b.runtime.handleIncomingEvent(invitesDoc);
    await new Promise(r => setTimeout(r, 0));

    const adds = b.published.filter(e => e.kind === GroupKind.AddUser);
    expect(adds.some(e => e.tags.some(t => t[0] === 'p' && t[1] === olene))).toBe(true);
  });
});

// ── editChannel ───────────────────────────────────────────────────────────────

describe('AppRuntime channel + interaction actions', () => {
  it('editChannel publishes a kind-30311 reusing the channel d (stable coordinate)', async () => {
    const {runtime, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;

    // Build a channelId in the form 30311:<owner>:<d> with me as owner.
    const d = 'my-chan-d';
    const channelId = `${Kind.LiveActivity}:${me}:${d}`;

    await runtime.editChannel(channelId, {name: 'Updated Name'});

    const editEv = lastOfKind(published, Kind.LiveActivity);
    expect(editEv).toBeDefined();
    // The d tag must be the same as the original d (stable coordinate).
    const dTag = editEv!.tags.find(t => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe(d);
    // Title should be updated.
    expect(editEv!.tags).toContainEqual(expect.arrayContaining(['title', 'Updated Name']));
  });

  it('editChannel does nothing when the owner does not match the current user', async () => {
    const {runtime, published} = await enrolledRuntime();
    const initialLen = published.length;
    const wrongOwner = 'b'.repeat(64);
    const channelId = `${Kind.LiveActivity}:${wrongOwner}:some-d`;
    await runtime.editChannel(channelId, {name: 'Spoofed'});
    // Should NOT have published anything (owner guard).
    expect(published.length).toBe(initialLen);
  });

  it('editChannel preserves the open-community mode + admins across an edit that omits them', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const admin = 'c'.repeat(64);
    const d = 'open-community-d';
    const channelId = `${Kind.LiveActivity}:${me}:${d}`;
    // Seed the current open-community definition (owner = me) into the store.
    store.save({
      id: 'a'.repeat(64), pubkey: me, kind: Kind.LiveActivity, created_at: 1, sig: 's', content: '',
      tags: [['d', d], ['title', 'Commons'], ['status', 'live'], ['mode', 'open'], ['p', admin, 'admin']],
    } as Event);
    // A rename that carries NEITHER the mode flag NOR the admin roster — both must survive, or a
    // pin/rename would silently revert the open community to a plain public channel and drop admins.
    await runtime.editChannel(channelId, {name: 'Renamed Commons'});
    const editEv = lastOfKind(published, Kind.LiveActivity)!;
    expect(editEv.tags).toContainEqual(['title', 'Renamed Commons']);
    expect(editEv.tags).toContainEqual(['mode', 'open']);
    expect(editEv.tags).toContainEqual(['p', admin, 'admin']);
  });

  // ── setChannelInteractions ─────────────────────────────────────────────────

  it('setChannelInteractions publishes a kind-30078 with the correct d and flags', async () => {
    const {runtime, published} = await enrolledRuntime();
    const msgId = 'msg' + '0'.repeat(61);
    await runtime.setChannelInteractions(msgId, {comments: true, reactions: false});

    const ev = lastOfKind(published, Kind.AppData);
    expect(ev).toBeDefined();
    expect(ev!.tags).toContainEqual(['d', `stiq:interactions:${msgId}`]);
    expect(ev!.tags).toContainEqual(['comments', '1']);
    expect(ev!.tags).toContainEqual(['reactions', '0']);
  });

  it('setChannelInteractions with both flags true', async () => {
    const {runtime, published} = await enrolledRuntime();
    const msgId = 'msg' + '1'.repeat(61);
    await runtime.setChannelInteractions(msgId, {comments: true, reactions: true});

    const ev = lastOfKind(published, Kind.AppData);
    expect(ev!.tags).toContainEqual(['comments', '1']);
    expect(ev!.tags).toContainEqual(['reactions', '1']);
  });

  // ── setGroupInteractions ───────────────────────────────────────────────────

  it('setGroupInteractions publishes a kind-9009 with h and e tags plus flags', async () => {
    const {runtime, published} = await enrolledRuntime();
    const msgId = 'msg' + '2'.repeat(61);
    await runtime.setGroupInteractions('group1', msgId, {comments: true, reactions: false});

    const ev = lastOfKind(published, Kind.SetInteractions);
    expect(ev).toBeDefined();
    expect(ev!.kind).toBe(Kind.SetInteractions);
    expect(ev!.tags).toContainEqual(['h', 'group1']);
    expect(ev!.tags).toContainEqual(['e', msgId]);
    expect(ev!.tags).toContainEqual(['comments', '1']);
    expect(ev!.tags).toContainEqual(['reactions', '0']);
  });

  it('setGroupInteractions with reactions=true', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.setGroupInteractions('g1', 'post1', {comments: false, reactions: true});
    const ev = lastOfKind(published, Kind.SetInteractions);
    expect(ev!.tags).toContainEqual(['comments', '0']);
    expect(ev!.tags).toContainEqual(['reactions', '1']);
  });
});

// ── createGroup with broadcast ────────────────────────────────────────────────

describe('AppRuntime createGroup broadcast flag', () => {
  it('createGroup with broadcast:true results in a kind-9007 carrying the broadcast flag', async () => {
    const {runtime, published} = await enrolledRuntime();
    const groupId = await runtime.createGroup({name: 'Broadcast Group', broadcast: true});
    expect(groupId).toBeTruthy();

    const create = lastOfKind(published, GroupKind.Create);
    expect(create).toBeDefined();
    expect(create!.tags).toContainEqual(['h', groupId]);
    // The broadcast flag must be present in the metadata tags.
    expect(create!.tags).toContainEqual(['broadcast']);
  });

  it('createGroup without broadcast does NOT carry the broadcast flag', async () => {
    const {runtime, published} = await enrolledRuntime();
    await runtime.createGroup({name: 'Normal Group'});

    const create = lastOfKind(published, GroupKind.Create);
    expect(create).toBeDefined();
    expect(create!.tags.find(t => t[0] === 'broadcast')).toBeUndefined();
  });

  it('createGroup with gradient includes the gradient tag in the kind-9007', async () => {
    const {runtime, published} = await enrolledRuntime();
    const gradient: GradientSpec = {type: 'linear', angle: 135, stops: ['#7ec8ff', '#8a5bd0']};
    await runtime.createGroup({name: 'Gradient Group', gradient});

    const create = lastOfKind(published, GroupKind.Create);
    expect(create).toBeDefined();
    const gradTag = create!.tags.find(t => t[0] === 'gradient');
    expect(gradTag).toBeDefined();
    expect(gradTag![1]).toBe(encodeGradient(gradient));
  });
});
