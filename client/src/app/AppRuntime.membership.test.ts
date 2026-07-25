/**
 * Membership handoff — runtime integration (MEMBERSHIP_HANDOFF_PLAN.md):
 *  requester: requestToJoin seals the intro note per admin into the 9021, records the LOCAL
 *  pending state that survives a silent decline, hides the space from the inbox until approved,
 *  withdraw = 9022 + back to 'none';
 *  admin: getJoinRequestQueue joins the relay's 39004 pending set with the raw 9021's sealed note
 *  (unsealed with the admin's own key), inviteToSpace DMs an invite frame + publishes the shared
 *  invited-set doc, revoke folds it away, and an invited accept is AUTO-approved (9000) while a
 *  cold request is not.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {getPublicKey, verifyEvent} from 'nostr-tools/pure';
import {bytesToUtf8} from '@noble/hashes/utils.js';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';
import {base64ToBytes} from '../util/base64';
import {
  parseJoinNoteContent,
  parseInvitePayload,
  spaceInvitesDTag,
  KIND_SPACE_INVITES,
} from '../channels/membership';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

interface Harness {
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
}

async function enrolledRuntime(): Promise<Harness> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    subscribeGroup: () => {},
    unsubscribeGroup: () => {},
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published};
}

function lastOfKind(published: Event[], kind: number): Event | undefined {
  return [...published].reverse().find(e => e.kind === kind);
}

let stateSeq = 0;
/** A relay-signed replaceable state event (the fake relay key never matters client-side). */
function relayState(kind: number, tags: string[][]): Event {
  stateSeq += 1;
  return {
    id: (stateSeq.toString(36) + 'e'.repeat(64)).slice(0, 64),
    pubkey: 'f'.repeat(64),
    created_at: 1000 + stateSeq,
    kind,
    tags,
    content: '',
    sig: 's',
  } as Event;
}

/** Seed a CLOSED public group with the given owner/admins/members (non-encrypted, so the shared
 *  invites doc rides plaintext and this test needs no key machinery). */
function seedClosedGroup(
  store: InMemoryEventStore,
  groupId: string,
  owner: string,
  admins: string[],
  members: string[],
): void {
  store.save(relayState(GroupKind.Metadata, [['d', groupId], ['name', 'Whisper network'], ['owner', owner], ['closed'], ['broadcast']]));
  store.save(relayState(GroupKind.Admins, [['d', groupId], ...admins.map(a => ['p', a])]));
  store.save(relayState(GroupKind.Members, [['d', groupId], ...members.map(m => ['p', m])]));
}

const GID = 'whisper1';
/** A VALID secp256k1 pubkey fixture — NIP-44 sealing derives a shared secret against it, so a
 *  made-up hex string like '1'.repeat(64) is (correctly) skipped by the seal loop. */
const pkOf = (n: number): string => getPublicKey(new Uint8Array(32).fill(n));

describe('requester side', () => {
  it('requestToJoin seals name+note PER ADMIN into the 9021 and goes pending (hidden from inbox)', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    await runtime.setMyDisplayName('Mara V.');
    const admin1 = pkOf(1);
    const admin2 = pkOf(2);
    seedClosedGroup(store, GID, admin1, [admin1, admin2], [admin1, admin2]);

    expect(runtime.joinRequestStateFor(GID)).toBe('none');
    await runtime.requestToJoin(GID, 'Robin said the Thursday coordination happens here.');

    const req = lastOfKind(published, GroupKind.JoinRequest)!;
    expect(req.tags).toContainEqual(['h', GID]);
    // The note NEVER rides plaintext: content is the per-admin seal envelope, one seal per admin,
    // and the note text is not readable off the wire.
    const seals = parseJoinNoteContent(req.content)!;
    expect(Object.keys(seals).sort()).toEqual([admin1, admin2].sort());
    expect(req.content).not.toContain('Thursday coordination');
    expect(req.content).not.toContain('Mara');

    expect(runtime.joinRequestStateFor(GID)).toBe('pending');
    // The requested space is tracked (subscribed) but NOT an inbox row until approved.
    expect(runtime.getSnapshot().groups.some(g => g.id === GID)).toBe(false);
  });

  it('a note-less request from a nameless account is byte-identical to a bare 9021', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    seedClosedGroup(store, GID, '1'.repeat(64), ['1'.repeat(64)], ['1'.repeat(64)]);
    await runtime.requestToJoin(GID);
    expect(lastOfKind(published, GroupKind.JoinRequest)!.content).toBe('');
  });

  it('withdraw publishes a 9022 (clears the relay Pending entry) and returns to none', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    seedClosedGroup(store, GID, '1'.repeat(64), ['1'.repeat(64)], ['1'.repeat(64)]);
    await runtime.requestToJoin(GID, 'hi');
    await runtime.withdrawJoinRequest(GID);
    expect(lastOfKind(published, GroupKind.LeaveRequest)!.tags).toContainEqual(['h', GID]);
    expect(runtime.joinRequestStateFor(GID)).toBe('none');
  });

  it('SILENT DECLINE: the relay clearing me from 39004 leaves the requester reading pending forever', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(store, GID, '1'.repeat(64), ['1'.repeat(64)], ['1'.repeat(64)]);
    await runtime.requestToJoin(GID, 'hi');

    // Relay listed me pending, then an admin silently declined (9001 → 39004 re-emitted WITHOUT me).
    const listed = relayState(GroupKind.Pending, [['d', GID], ['p', me]]);
    store.save(listed);
    runtime.handleIncomingEvent(listed);
    const cleared = relayState(GroupKind.Pending, [['d', GID]]);
    store.save(cleared);
    runtime.handleIncomingEvent(cleared);

    // Never a rejected state — the local record keeps the preview on "pending".
    expect(runtime.joinRequestStateFor(GID)).toBe('pending');
  });

  it('APPROVAL: a 39002 listing me flips to member, clears the record, and surfaces the inbox row', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const admin = '1'.repeat(64);
    seedClosedGroup(store, GID, admin, [admin], [admin]);
    await runtime.requestToJoin(GID, 'hi');
    expect(runtime.getSnapshot().groups.some(g => g.id === GID)).toBe(false);

    const membersNow = relayState(GroupKind.Members, [['d', GID], ['p', admin], ['p', me]]);
    store.save(membersNow);
    runtime.handleIncomingEvent(membersNow);

    expect(runtime.joinRequestStateFor(GID)).toBe('member');
    expect(runtime.getSnapshot().groups.some(g => g.id === GID)).toBe(true);
  });
});

describe('admin side', () => {
  it('getJoinRequestQueue joins 39004 with the raw 9021 and unseals MY copy of the note', async () => {
    // Two real runtimes: B (requester) seals to A's pubkey; A (admin) unseals with its own key.
    const a = await enrolledRuntime();
    const b = await enrolledRuntime();
    const adminPk = a.runtime.getSnapshot().currentUserPubkey!;
    const requesterPk = b.runtime.getSnapshot().currentUserPubkey!;

    seedClosedGroup(b.store, GID, adminPk, [adminPk], [adminPk]);
    await b.runtime.setMyDisplayName('Mara V.');
    await b.runtime.requestToJoin(GID, 'Happy to take over driver scheduling.');
    const wire = lastOfKind(b.published, GroupKind.JoinRequest)!;

    // A's client: group state + the pending set + the raw 9021 arrive on the scoped sub.
    seedClosedGroup(a.store, GID, adminPk, [adminPk], [adminPk]);
    a.store.save(wire);
    a.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', requesterPk]]));

    // First read kicks the async unseal; the runtime emits when it lands.
    let queue = a.runtime.getJoinRequestQueue(GID);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.pubkey).toBe(requesterPk);
    expect(queue[0]!.at).toBe(wire.created_at);
    await new Promise(r => setTimeout(r, 0));
    queue = a.runtime.getJoinRequestQueue(GID);
    expect(queue[0]!.note).toBe('Happy to take over driver scheduling.');
    expect(queue[0]!.name).toBe('Mara V.');
    expect(queue[0]!.invited).toBe(false);
  });

  it('inviteToSpace DMs each person an invite frame + publishes the shared invited-set doc; revoke folds it away', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(store, GID, me, [me], [me]);
    const carol = 'c'.repeat(64);

    // Intercept the DM layer (PoW mining is exercised by the DM suites, not here).
    const sent: {pk: string; text: string; wire?: string}[] = [];
    const rt = runtime as unknown as {
      sendDM: (pk: string, text: string, replyTo?: string, wire?: string) => Promise<void>;
    };
    rt.sendDM = async (pk, text, _replyTo, wire) => void sent.push({pk, text, wire});

    await runtime.inviteToSpace(GID, [carol]);

    // The recipient got a readable fallback + the offline space card + the machine frame.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.pk).toBe(carol);
    expect(sent[0]!.text).toContain('stiq:space:');
    expect(sent[0]!.wire).toBeTruthy();

    // The per-author doc is on the wire, and the folded strip lists carol.
    const doc = lastOfKind(published, KIND_SPACE_INVITES)!;
    expect(doc.tags).toContainEqual(['d', spaceInvitesDTag(GID)]);
    expect(runtime.getSpaceInvited(GID).map(i => i.p)).toEqual([carol]);

    // NEVER a direct add: no 9000 was published by inviting.
    expect(lastOfKind(published, GroupKind.AddUser)).toBeUndefined();

    await runtime.revokeSpaceInvite(GID, carol);
    expect(runtime.getSpaceInvited(GID)).toEqual([]);
  });

  it('an INVITED accept is auto-approved (9000); a cold request never is', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(store, GID, me, [me], [me]);
    const carol = 'c'.repeat(64);
    const dana = 'd'.repeat(64);
    const rt = runtime as unknown as {sendDM: () => Promise<void>};
    rt.sendDM = async () => {};
    await runtime.inviteToSpace(GID, [carol]);

    // Carol (invited) and Dana (cold) both land in the relay's pending set.
    const pending = relayState(GroupKind.Pending, [['d', GID], ['p', carol], ['p', dana]]);
    store.save(pending);
    runtime.handleIncomingEvent(pending);
    await new Promise(r => setTimeout(r, 0));

    const adds = published.filter(e => e.kind === GroupKind.AddUser);
    expect(adds).toHaveLength(1);
    expect(adds[0]!.tags).toContainEqual(['p', carol]);

    // Dana stays in the visible queue; Carol is flagged invited (strip, not queue).
    const queue = runtime.getJoinRequestQueue(GID);
    expect(queue.find(q => q.pubkey === dana)!.invited).toBe(false);
    expect(queue.find(q => q.pubkey === carol)!.invited).toBe(true);
  });

  it('acceptSpaceInvite publishes a 9021 marked ["invite"] and records the pending state', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    seedClosedGroup(store, GID, '1'.repeat(64), ['1'.repeat(64)], ['1'.repeat(64)]);
    await runtime.acceptSpaceInvite(GID);
    const req = lastOfKind(published, GroupKind.JoinRequest)!;
    expect(req.tags).toContainEqual(['h', GID]);
    expect(req.tags).toContainEqual(['invite']);
    expect(runtime.joinRequestStateFor(GID)).toBe('pending');
  });
});

describe('invite grant (relay-verifiable accept-first)', () => {
  it('inviteToSpace as an admin carries a signed kind-9010 grant for each recipient', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    seedClosedGroup(store, GID, me, [me], [me]); // me = owner + admin → I can mint a grant
    const carol = pkOf(7);

    const sent: {pk: string; wire?: string}[] = [];
    (runtime as unknown as {
      sendDM: (pk: string, t: string, r?: string, w?: string) => Promise<void>;
    }).sendDM = async (pk, _t, _r, w) => void sent.push({pk, wire: w});

    await runtime.inviteToSpace(GID, [carol]);

    expect(sent).toHaveLength(1);
    const payload = parseInvitePayload(sent[0]!.wire!)!;
    expect(payload.gr).toBeTruthy();
    // The grant decodes to a VALID signed event: kind 9010, signed by me, bound to THIS group and
    // THIS recipient, with a future expiry — exactly what the relay's inviteGrantAdmits verifies.
    const grant = JSON.parse(bytesToUtf8(base64ToBytes(payload.gr!))) as Event;
    expect(grant.kind).toBe(GroupKind.InviteGrant);
    expect(grant.pubkey).toBe(me);
    expect(grant.tags).toContainEqual(['h', GID]);
    expect(grant.tags).toContainEqual(['p', carol]);
    const exp = grant.tags.find(t => t[0] === 'exp');
    expect(exp && Number(exp[1]) > Math.floor(Date.now() / 1000)).toBe(true);
    expect(verifyEvent(grant)).toBe(true);
  });

  it('a NON-admin inviter sends a grantless invite (accept falls to pending)', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    // me is a MEMBER of a group chat but NOT an admin → the relay would ignore any grant I mint,
    // so the client must not attach one (the accept then rides the normal pending queue).
    seedClosedGroup(store, GID, pkOf(1), [pkOf(1)], [pkOf(1), me]);
    const sent: {wire?: string}[] = [];
    (runtime as unknown as {
      sendDM: (pk: string, t: string, r?: string, w?: string) => Promise<void>;
    }).sendDM = async (_pk, _t, _r, w) => void sent.push({wire: w});

    await runtime.inviteToSpace(GID, [pkOf(7)]);

    expect(sent).toHaveLength(1);
    expect(parseInvitePayload(sent[0]!.wire!)!.gr).toBeUndefined();
  });

  it('acceptSpaceInvite forwards a carried grant onto the 9021 invite_grant tag', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    seedClosedGroup(store, GID, pkOf(1), [pkOf(1)], [pkOf(1)]);
    // The invite DM populated the incoming-invite card with a grant (opaque base64 to the client).
    (runtime as unknown as {
      incomingInvites: Map<string, {payload: {g: string; gr?: string}; inviter: string; at: number}>;
    }).incomingInvites.set(GID, {payload: {g: GID, gr: 'R1JBTlRCNjQ='}, inviter: pkOf(1), at: 1});

    await runtime.acceptSpaceInvite(GID);

    const req = lastOfKind(published, GroupKind.JoinRequest)!;
    expect(req.tags).toContainEqual(['invite']);
    expect(req.tags).toContainEqual(['invite_grant', 'R1JBTlRCNjQ=']);
  });

  it('a grantless invite accept carries no invite_grant tag', async () => {
    const {runtime, store, published} = await enrolledRuntime();
    seedClosedGroup(store, GID, pkOf(1), [pkOf(1)], [pkOf(1)]);
    await runtime.acceptSpaceInvite(GID); // no incoming grant recorded
    const req = lastOfKind(published, GroupKind.JoinRequest)!;
    expect(req.tags).toContainEqual(['invite']);
    expect(req.tags.some(t => t[0] === 'invite_grant')).toBe(false);
  });
});

describe('getJoiningSpaces ("Joining…" row)', () => {
  // Covers the Accept→39002 gap: once accepted (or requested), a space is filtered OUT of
  // getIncomingInvites (see 'accepted already' in that method) but isn't YET in the members-only
  // inbox (inboxGroupIds excludes a pending non-member) — so without getJoiningSpaces the space is
  // in neither list for however long the admin's auto-approve + 39002 delivery takes.
  it('includes an accepted invite (name/kind from the invite payload) until a 39002 lists me', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const admin = pkOf(9);
    seedClosedGroup(store, GID, admin, [admin], [admin]);
    (runtime as unknown as {
      incomingInvites: Map<string, {payload: {g: string; n?: string; k?: 'group' | 'channel'}; inviter: string; at: number}>;
    }).incomingInvites.set(GID, {payload: {g: GID, n: 'Secret Society', k: 'channel'}, inviter: admin, at: 1});

    expect(runtime.getJoiningSpaces()).toEqual([]);
    await runtime.acceptSpaceInvite(GID);

    expect(runtime.getJoiningSpaces()).toEqual([
      {groupId: GID, name: 'Secret Society', kindWord: 'Private channel'},
    ]);
    // Also gone from the invitation-card list — accepted already, pending an admin's auto-approve —
    // the exact gap this row exists to cover.
    expect(runtime.getIncomingInvites().some(i => i.groupId === GID)).toBe(false);

    // A 39002 arrival that lists me fulfils the request (reconcileMyJoinRequests) → no longer "joining".
    const membersNow = relayState(GroupKind.Members, [['d', GID], ['p', admin], ['p', me]]);
    store.save(membersNow);
    runtime.handleIncomingEvent(membersNow);
    expect(runtime.getJoiningSpaces()).toEqual([]);
  });

  it('includes a manual requestToJoin (name/kind falls back to cached relay group state)', async () => {
    const {runtime, store} = await enrolledRuntime();
    seedClosedGroup(store, GID, pkOf(1), [pkOf(1)], [pkOf(1)]); // 'Whisper network', broadcast:true
    await runtime.requestToJoin(GID, 'hi');

    expect(runtime.getJoiningSpaces()).toEqual([
      {groupId: GID, name: 'Whisper network', kindWord: 'Private channel'},
    ]);
  });

  it('excludes a space once the viewer is already a member', async () => {
    const {runtime, store} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const admin = pkOf(1);
    seedClosedGroup(store, GID, admin, [admin], [admin]);
    await runtime.requestToJoin(GID, 'hi');
    expect(runtime.getJoiningSpaces()).toHaveLength(1);

    const membersNow = relayState(GroupKind.Members, [['d', GID], ['p', admin], ['p', me]]);
    store.save(membersNow);
    runtime.handleIncomingEvent(membersNow);
    expect(runtime.getJoiningSpaces()).toEqual([]);
  });
});
