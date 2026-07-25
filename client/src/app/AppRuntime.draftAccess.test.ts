/**
 * Draft access control — runtime integration (Phase 5§D + Phase 7§A's runtime half).
 *
 * Mirrors AppRuntime.membership.test.ts's shape: two REAL AppRuntime instances (owner + requester),
 * each with their own store, bridged by hand-copying the events one side published into the other's
 * store (there is no real relay in these tests) — exactly like the join-request admin-side tests
 * bridge a 9021 into the admin's store.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {newShareId} from '../feed/drafts';
import {DRAFT_COMMENT_ROOT_KIND} from '../feed/draftAccess';
import {Kind} from '../contracts';

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

/** Every write here is a durable async op; flush a microtask turn so unsealing/emits settle. */
const flush = () => new Promise(r => setTimeout(r, 0));

describe('requester side', () => {
  it('none → pending → approved, and the queue excludes an already-granted requester', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const requesterPk = requester.runtime.getSnapshot().currentUserPubkey!;

    const shareId = newShareId(ownerPk, 'the whole body of the piece');
    await owner.runtime.drafts.save({
      id: 'd1',
      title: 'A quiet Tuesday',
      content: 'the whole body of the piece',
      tags: ['t1'],
      savedAt: 1,
      shareId,
    });

    // Owner's own view of their own shared draft.
    expect(await owner.runtime.getDraftAccessState(shareId)).toBe('owner');

    // Requester starts at 'none'.
    expect(await requester.runtime.getDraftAccessState(shareId)).toBe('none');

    await requester.runtime.setMyDisplayName('Mara V.');
    await requester.runtime.requestDraftAccess(shareId, ownerPk, undefined);
    const reqWire = lastOfKind(requester.published, Kind.DraftAccessRequest)!;
    expect(reqWire.tags).toContainEqual(['d', shareId]);
    expect(reqWire.tags).toContainEqual(['p', ownerPk]);
    // The name never rides plaintext.
    expect(reqWire.content).not.toContain('Mara');

    expect(await requester.runtime.getDraftAccessState(shareId)).toBe('pending');

    // Bridge: the owner's client observes the request (a real relay would deliver it on the open
    // firehose — see contracts' FEED_KINDS wiring for DraftAccessRequest).
    owner.store.save(reqWire);

    let queue = owner.runtime.getDraftAccessQueue(shareId);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.pubkey).toBe(requesterPk);
    await flush(); // kicks the async unseal
    queue = owner.runtime.getDraftAccessQueue(shareId);
    expect(queue[0]!.name).toBe('Mara V.');

    await owner.runtime.approveDraftAccess(shareId, requesterPk);

    // The queue drops the now-granted requester (they belong in "Approved", not "Pending").
    expect(owner.runtime.getDraftAccessQueue(shareId)).toEqual([]);

    // Bridge: the requester's client observes the delivery (`#p == me`-scoped sub in production).
    const delivery = lastOfKind(owner.published, Kind.DraftDelivery)!;
    expect(delivery.tags).toContainEqual(['p', requesterPk]);
    requester.store.save(delivery);

    expect(await requester.runtime.getDraftAccessState(shareId)).toBe('approved');
    const snapshot = await requester.runtime.getMyDraftDelivery(shareId, ownerPk);
    expect(snapshot).toEqual({ti: 'A quiet Tuesday', b: 'the whole body of the piece', tg: ['t1']});
  });

  it('REVOKE: a fresh (future) state check reports none; an already-fetched snapshot is untouched', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const requesterPk = requester.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'revoke-me body');
    await owner.runtime.drafts.save({id: 'd2', title: '', content: 'revoke-me body', tags: [], savedAt: 1, shareId});

    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);
    await owner.runtime.approveDraftAccess(shareId, requesterPk);
    const firstDelivery = lastOfKind(owner.published, Kind.DraftDelivery)!;
    requester.store.save(firstDelivery);
    expect(await requester.runtime.getDraftAccessState(shareId)).toBe('approved');

    // The requester already fetched + cached the real snapshot (in this runtime's in-memory cache) —
    // that copy is NOT retroactively erased (forward-secrecy, not retroactive erasure).
    const cachedBeforeRevoke = await requester.runtime.getMyDraftDelivery(shareId, ownerPk);
    expect(cachedBeforeRevoke?.b).toBe('revoke-me body');

    await owner.runtime.revokeDraftAccess(shareId, requesterPk);
    // Bridge the tombstone delivery (a strictly-newer replaceable publish at the same slot).
    const tombstone = lastOfKind(owner.published, Kind.DraftDelivery)!;
    expect(tombstone.id).not.toBe(firstDelivery.id); // sanity: a genuinely new event superseded it
    expect(tombstone.created_at).toBeGreaterThan(firstDelivery.created_at);
    requester.store.save(tombstone);

    // A FRESH state check now reports 'none' — the whole point of the "→ none after revoke for
    // FUTURE checks" contract.
    expect(await requester.runtime.getDraftAccessState(shareId)).toBe('none');

    // The owner's own grant fold no longer lists them either.
    expect(owner.runtime.getDraftAccessQueue(shareId)).toEqual([]);
  });

  it('approveDraftAccess is a no-op when draftId does not name one of my own current drafts', async () => {
    const owner = await enrolledRuntime();
    const requesterPk = 'c'.repeat(64);
    const before = owner.published.length;
    await owner.runtime.approveDraftAccess('not-my-share-id', requesterPk);
    expect(owner.published.length).toBe(before); // nothing published — silently no-ops
  });
});

describe('owner side — silent deny', () => {
  it('DENY is silent (no publish); the queue stops re-showing it; a strictly-newer re-request re-surfaces', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const requesterPk = requester.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'deny-me body');
    await owner.runtime.drafts.save({id: 'd3', title: '', content: 'deny-me body', tags: [], savedAt: 1, shareId});

    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);
    expect(owner.runtime.getDraftAccessQueue(shareId)).toHaveLength(1);

    const before = owner.published.length;
    await owner.runtime.denyDraftAccess(shareId, requesterPk);
    expect(owner.published.length).toBe(before); // silent — publishes nothing

    expect(owner.runtime.getDraftAccessQueue(shareId)).toEqual([]);

    // The requester's own state stays 'pending' forever — the silent-decline contract (never a
    // rejected state anywhere), mirroring the space-join precedent exactly.
    expect(await requester.runtime.getDraftAccessState(shareId)).toBe('pending');

    // A strictly newer re-request (bigger created_at) re-surfaces in the owner's queue. Advance
    // Date.now() rather than sleeping a real second — denyDraftAccess/requestDraftAccess both stamp
    // whole-unix-second timestamps, so the re-request must land in a later second to out-rank it.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try {
      await requester.runtime.requestDraftAccess(shareId, ownerPk, 'asking again');
    } finally {
      nowSpy.mockRestore();
    }
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);
    expect(owner.runtime.getDraftAccessQueue(shareId)).toHaveLength(1);
  });
});

describe('Phase 7§A: getDraftThread / getDraftCommentCount', () => {
  it('a comment built off a synthetic shareId root is found by getDraftThread, keyed purely on shareId', async () => {
    const {runtime} = await enrolledRuntime();
    const me = runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(me, 'a draft nobody published yet');

    expect(runtime.getDraftThread(shareId)).toEqual([]);
    expect(runtime.getDraftCommentCount(shareId)).toBe(0);

    const draftRoot = {id: shareId, pubkey: me, kind: DRAFT_COMMENT_ROOT_KIND};
    await runtime.comment('first comment on the draft', draftRoot, draftRoot);
    await flush();

    const thread = runtime.getDraftThread(shareId);
    expect(thread).toHaveLength(1);
    // Content carries the standard display-name/gradient header (encodeIdentityHeader) every posted
    // event does — stripped by renderers via profile/displayName's header parser, not this runtime
    // layer — so assert containment rather than exact equality.
    expect(thread[0]!.event.content).toContain('first comment on the draft');
    expect(runtime.getDraftCommentCount(shareId)).toBe(1);

    const reply = {id: thread[0]!.event.id, pubkey: thread[0]!.event.pubkey, kind: thread[0]!.event.kind};
    await runtime.comment('a reply', draftRoot, reply);
    await flush();
    expect(runtime.getDraftCommentCount(shareId)).toBe(2);
    expect(runtime.getDraftThread(shareId)[0]!.children).toHaveLength(1);
  });
});
