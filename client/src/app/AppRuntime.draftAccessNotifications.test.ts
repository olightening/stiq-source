/**
 * Draft access control in the notification center (Phase 5§G — deriveNotifications' two new
 * draft-access blocks). Follows the EXACT template the pre-existing "Pending join requests" block
 * set (see AppRuntime.joinRequestNotifications.test.ts) but exercises the draft-access domain:
 *
 *  - OWNER side ('draft_access_request'): pending DraftAccessRequests addressed to me across my
 *    shared drafts collapse into ONE row per draft (not one per request), routes to
 *    {kind:'draft_requests', draftId}, gated by the SAME prefs/mute machinery the join-request row
 *    uses (channels.byType.group + a per-source mute), and a silent deny removes it even though a
 *    deny publishes nothing (the _draftAccessDenyVersion cache-invalidation fix).
 *  - REQUESTER side ('draft_access_granted'): a DraftDelivery addressed to me that decrypts to a
 *    real (non-tombstone) snapshot, routed to {kind:'draft_reader', draftId, ownerPubkey}, gated by
 *    the dm prefs/mute machinery (a delivery is mechanically a private #p==me seal, same as a DM).
 *
 * Harness mirrors AppRuntime.draftAccess.test.ts: two REAL AppRuntime instances (owner + requester),
 * bridged by hand-copying published events into the other side's store (no real relay in these
 * tests) — exactly like AppRuntime.draftAccess.test.ts bridges a DraftAccessRequest/DraftDelivery.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {newShareId} from '../feed/drafts';
import {Kind} from '../contracts';
import {DEFAULT_PREFS, savePrefs} from '../notifications/prefs';
import {muteSource, draftMuteId, dmMuteId} from '../notifications/notifications';

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

// The notification-prefs module is a file-level singleton shared across every runtime built here —
// reset it to defaults before each test (mirrors AppRuntime.joinRequestNotifications.test.ts).
beforeEach(async () => {
  await savePrefs(DEFAULT_PREFS);
});

describe('draft-access-request notifications (owner side)', () => {
  it('N pending requesters on the SAME draft collapse into ONE row with the right count + NavTarget', async () => {
    const owner = await enrolledRuntime();
    const r1 = await enrolledRuntime();
    const r2 = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const r2Pk = r2.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'body for many requesters');
    await owner.runtime.drafts.save({
      id: 'd1', title: 'Many Requesters', content: 'body for many requesters', tags: [], savedAt: 1, shareId,
    });

    await r1.runtime.setMyDisplayName('Ada');
    await r1.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(r1.published, Kind.DraftAccessRequest)!);

    // r2's request must land STRICTLY later (whole-unix-second stamps) so it's deterministically the
    // "most recent" ask — mirrors the re-request idiom in AppRuntime.draftAccess.test.ts.
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    let r2Req: Event;
    try {
      await r2.runtime.setMyDisplayName('Bea');
      await r2.runtime.requestDraftAccess(shareId, ownerPk);
      r2Req = lastOfKind(r2.published, Kind.DraftAccessRequest)!;
    } finally {
      nowSpy.mockRestore();
    }
    owner.store.save(r2Req);

    // Prime the async name-unseal via a DIRECT getDraftAccessQueue call (uncached — recomputes every
    // call) rather than through deriveNotifications' MEMOIZED result: nothing bumps _notifCache's key
    // when an unseal resolves mid-flight (only emit() fires, which doesn't itself change `ver`), so a
    // name resolved AFTER the first deriveNotifications() call would never surface in a cached read —
    // exactly mirroring how a live "Manage access" screen would incidentally warm this same cache by
    // rendering its own queue. This is the FIRST-EVER deriveNotifications() call below, so it computes
    // fresh regardless.
    owner.runtime.getDraftAccessQueue(shareId);
    await flush(); // let both requesters' async name-unseal resolve

    const rows = owner.runtime.deriveNotifications().filter(i => i.target.kind === 'draft_requests');
    expect(rows).toHaveLength(1); // ONE actionable row per draft, not one per pending request
    const row = rows[0]!;
    expect(row.target).toEqual({kind: 'draft_requests', draftId: shareId});
    expect(row.kind).toBe('draft'); // its own notif-center source, not the join-request row's bucket
    expect(row.id).toBe(r2Req.id); // keyed on the MOST RECENT request (mirrors the DM "latest" idiom)
    expect(row.ts).toBe(r2Req.created_at);
    expect(row.actor).toBe('Bea'); // the most-recently-asking requester
    expect(row.action).toBe('and 1 other requested access to your draft'); // 2 pending, count = "1 other"
    expect(row.avatar).toEqual({
      shape: 'circle',
      seed: nip19.npubEncode(r2Pk),
      gradient: owner.runtime.gradientFor(r2Pk),
    });
  });

  it('a single pending requester reads as a plain (uncounted) request', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'solo requester body');
    await owner.runtime.drafts.save({id: 'd2', title: '', content: 'solo requester body', tags: [], savedAt: 1, shareId});

    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);

    const row = owner.runtime.deriveNotifications().find(i => i.target.kind === 'draft_requests');
    expect(row).toBeDefined();
    expect(row!.action).toBe('requested access to your draft'); // no "and N others" suffix
  });

  it('an already-GRANTED requester does not inflate the pending count (getDraftAccessQueue excludes them)', async () => {
    const owner = await enrolledRuntime();
    const r1 = await enrolledRuntime();
    const r2 = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const r1Pk = r1.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'grant then re-ask body');
    await owner.runtime.drafts.save({id: 'd3', title: '', content: 'grant then re-ask body', tags: [], savedAt: 1, shareId});

    await r1.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(r1.published, Kind.DraftAccessRequest)!);
    await owner.runtime.approveDraftAccess(shareId, r1Pk); // r1 is now GRANTED, not pending

    await r2.runtime.requestDraftAccess(shareId, ownerPk); // r2 is the only genuinely pending ask
    owner.store.save(lastOfKind(r2.published, Kind.DraftAccessRequest)!);

    const row = owner.runtime.deriveNotifications().find(i => i.target.kind === 'draft_requests');
    expect(row).toBeDefined();
    expect(row!.action).toBe('requested access to your draft'); // just r2 — r1 doesn't count
  });

  it('is suppressed by its OWN prefs category, and is independent of the group toggle it used to borrow', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'prefs-gated body');
    await owner.runtime.drafts.save({id: 'd4', title: '', content: 'prefs-gated body', tags: [], savedAt: 1, shareId});
    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);

    expect(owner.runtime.deriveNotifications().some(i => i.target.kind === 'draft_requests')).toBe(true);

    const prefs = owner.runtime.getNotificationPrefs();
    // Turning OFF group channels must no longer take draft requests with it — that coupling was an
    // artifact of borrowing the group descriptor before `drafts` existed.
    await owner.runtime.setNotificationPrefs({
      ...prefs,
      channels: {...prefs.channels, byType: {...prefs.channels.byType, group: false}},
    });
    expect(owner.runtime.deriveNotifications().some(i => i.target.kind === 'draft_requests')).toBe(true);

    // Its own switch is what silences it.
    await owner.runtime.setNotificationPrefs({...owner.runtime.getNotificationPrefs(), drafts: false});
    expect(owner.runtime.deriveNotifications().some(i => i.target.kind === 'draft_requests')).toBe(false);
  });

  it('is suppressed by draftMuteId (the mute key a future "mute requests" control would call)', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'muted draft body');
    await owner.runtime.drafts.save({id: 'd5', title: '', content: 'muted draft body', tags: [], savedAt: 1, shareId});
    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);

    // Muted BEFORE the very first deriveNotifications() call on this runtime: a per-source mute
    // toggle (unlike prefs/deny above) bumps no _notifCache version field, so this asserts the check
    // is wired correctly rather than asserting it invalidates an already-warm cache mid-session — the
    // SAME live-toggle limitation already exists, untested, for the pre-existing dm:/ch:/grp: mutes.
    await muteSource(draftMuteId(shareId));
    expect(owner.runtime.deriveNotifications().some(i => i.target.kind === 'draft_requests')).toBe(false);
  });

  it('a silent deny (which publishes NOTHING) still drops the row on the very next derive', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const requesterPk = requester.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'deny-notif body');
    await owner.runtime.drafts.save({id: 'd6', title: '', content: 'deny-notif body', tags: [], savedAt: 1, shareId});
    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);
    expect(owner.runtime.deriveNotifications().some(i => i.target.kind === 'draft_requests')).toBe(true);

    const publishedBefore = owner.published.length;
    await owner.runtime.denyDraftAccess(shareId, requesterPk);
    expect(owner.published.length).toBe(publishedBefore); // confirms the deny is genuinely silent

    // Without the _draftAccessDenyVersion cache-invalidation fix, this would still return the STALE
    // cached row (no store-visible event moved for storeVersionOf to catch).
    expect(owner.runtime.deriveNotifications().some(i => i.target.kind === 'draft_requests')).toBe(false);

    // The requester never learns anything either way (silent-decline contract) — no row, ever.
    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(false);
  });

  it('read/unread behaves like every other notif-center row', async () => {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'read state body');
    await owner.runtime.drafts.save({id: 'd7', title: '', content: 'read state body', tags: [], savedAt: 1, shareId});
    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);

    let row = owner.runtime.deriveNotifications().find(i => i.target.kind === 'draft_requests');
    expect(row!.read).toBe(false);

    await owner.runtime.markNotificationRead(row!.id);
    row = owner.runtime.deriveNotifications().find(i => i.target.kind === 'draft_requests');
    expect(row!.read).toBe(true);
  });
});

describe('draft-access-granted notifications (requester side)', () => {
  /** Bring a requester from `pending` all the way to a bridged (but NOT yet derived/decrypted)
   *  delivery — the raw state right after the wire bridge, before anything has touched
   *  deriveNotifications(). */
  async function grantFlow(title?: string): Promise<{
    owner: Harness; requester: Harness; ownerPk: string; requesterPk: string; shareId: string; delivery: Event;
  }> {
    const owner = await enrolledRuntime();
    const requester = await enrolledRuntime();
    const ownerPk = owner.runtime.getSnapshot().currentUserPubkey!;
    const requesterPk = requester.runtime.getSnapshot().currentUserPubkey!;
    const shareId = newShareId(ownerPk, 'granted-notif body');
    await owner.runtime.drafts.save({
      id: 'dg', title: title ?? '', content: 'granted-notif body', tags: [], savedAt: 1, shareId,
    });
    await requester.runtime.requestDraftAccess(shareId, ownerPk);
    owner.store.save(lastOfKind(requester.published, Kind.DraftAccessRequest)!);
    await owner.runtime.approveDraftAccess(shareId, requesterPk);
    const delivery = lastOfKind(owner.published, Kind.DraftDelivery)!;
    requester.store.save(delivery);
    return {owner, requester, ownerPk, requesterPk, shareId, delivery};
  }

  /**
   * grantFlow() PLUS priming: the first deriveNotifications() call is what discovers the delivery
   * and kicks getMyDraftDelivery's background decrypt (mirrors the owner-side getDraftAccessQueue
   * priming above) — nothing else would ever trigger it. Callers that don't care about the raw
   * "first pass is empty" contract itself (tested once, explicitly, below) should use this instead
   * of re-deriving the two-call dance in every test.
   */
  async function grantFlowSettled(title?: string): ReturnType<typeof grantFlow> {
    const result = await grantFlow(title);
    result.requester.runtime.deriveNotifications(); // kicks getMyDraftDelivery in the background
    await flush(); // decrypt resolves, bumps _draftDeliveryDecryptVersion, and emit()s
    return result;
  }

  it('a fresh DraftDelivery yields a draft_access_granted row once the background decrypt resolves', async () => {
    const {requester, ownerPk, shareId, delivery} = await grantFlow('A quiet Tuesday');

    // First call: the delivery is uncached, so getMyDraftDelivery is kicked in the background and
    // this pass skips the row (the fire-and-forget contract documented on the block).
    const firstPass = requester.runtime.deriveNotifications().find(i => i.target.kind === 'draft_reader');
    expect(firstPass).toBeUndefined();

    await flush(); // the decrypt resolves — bumps _draftDeliveryDecryptVersion and emit()s

    const row = requester.runtime.deriveNotifications().find(i => i.target.kind === 'draft_reader');
    expect(row).toBeDefined();
    expect(row!.target).toEqual({kind: 'draft_reader', draftId: shareId, ownerPubkey: ownerPk});
    expect(row!.kind).toBe('draft'); // its own source — no longer filed under DMs
    expect(row!.id).toBe(delivery.id);
    expect(row!.ts).toBe(delivery.created_at);
    expect(row!.action).toBe('approved your request to read');
    expect(row!.targetText).toBe('“A quiet Tuesday”');
  });

  it('omits targetText when the draft has no title', async () => {
    const {requester} = await grantFlowSettled(undefined);
    const row = requester.runtime.deriveNotifications().find(i => i.target.kind === 'draft_reader');
    expect(row).toBeDefined();
    expect(row!.targetText).toBeUndefined();
  });

  it('a REVOKE removes the row (the tombstone delivery decrypts to nothing)', async () => {
    const {owner, requester, requesterPk, shareId} = await grantFlowSettled();
    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(true);

    await owner.runtime.revokeDraftAccess(shareId, requesterPk);
    const tombstone = lastOfKind(owner.published, Kind.DraftDelivery)!;
    requester.store.save(tombstone); // a genuinely NEW DraftDelivery event — bumps storeVersionOf
    await flush();

    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(false);
  });

  it('is suppressed by its OWN prefs category, and is independent of the dms toggle it used to borrow', async () => {
    const {requester} = await grantFlowSettled();
    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(true);

    // Turning OFF DMs must no longer take draft approvals with it. A delivery is DM-SHAPED (a
    // private seal riding `#p == me`), which is why it borrowed the DM descriptor originally — but
    // shape is not category, and "no DMs" never meant "no draft approvals".
    const prefs = requester.runtime.getNotificationPrefs();
    await requester.runtime.setNotificationPrefs({...prefs, dms: {...prefs.dms, enabled: false}});
    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(true);

    // Its own switch is what silences it. (Muting the OWNER as a person still does too — that is a
    // separate axis, pinned by the dmMuteId test below.)
    await requester.runtime.setNotificationPrefs({...requester.runtime.getNotificationPrefs(), drafts: false});
    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(false);
  });

  it('is suppressed by muting the owner as a DM peer (dmMuteId), when muted before the delivery is ever derived', async () => {
    const {requester, ownerPk} = await grantFlow(); // raw — nothing derived/cached yet

    // Same live-toggle caveat as the owner-side mute test above: mute BEFORE the fresh compute that
    // the decrypt's resolution forces, rather than toggling an already-warm cache mid-session.
    await muteSource(dmMuteId(ownerPk));
    requester.runtime.deriveNotifications(); // kicks the decrypt
    await flush();

    expect(requester.runtime.deriveNotifications().some(i => i.target.kind === 'draft_reader')).toBe(false);
  });

  it('read/unread behaves like every other notif-center row', async () => {
    const {requester} = await grantFlowSettled();
    let row = requester.runtime.deriveNotifications().find(i => i.target.kind === 'draft_reader');
    expect(row!.read).toBe(false);

    await requester.runtime.markNotificationRead(row!.id);
    row = requester.runtime.deriveNotifications().find(i => i.target.kind === 'draft_reader');
    expect(row!.read).toBe(true);
  });
});
