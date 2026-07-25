/**
 * Optimistic roster overlay (AppRuntime._rosterOverlay): an admin action publishes a NIP-29
 * management event, but the roster UI derives from the relay's 39001 (admins) / 39002 (members) /
 * 39004 (pending) state — a full Tor round-trip away. The overlay makes promote/demote/kick/approve/
 * deny reflect INSTANTLY at the three UI-facing getters (getGroupMembers/getGroupAdmins/
 * getJoinRequestQueue), then reconciles against the relay's fresh state (dropping entries it now
 * reflects) and reverts the instant a publish is terminally 'rejected'.
 *
 * Harness idioms mirror AppRuntime.groups.test.ts / AppRuntime.membership.test.ts (enrolledRuntime,
 * relayState). Groups here are PUBLIC (no encryption) so no space-key machinery runs on add/kick.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});
// TIMING_JITTER ships default-ON but delays only the wire send; these assertions await a 0ms flush(),
// so disable the jitter (as the sibling optimistic/groups tests do) to observe the publish outcome.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import type {Event} from 'nostr-tools/pure';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {GroupKind} from '../channels/groups';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** Publish outcome the fake relay returns — flipped to reject for the revert test. */
type PublishResult = {accepted: boolean; message: string};

interface Harness {
  runtime: AppRuntime;
  store: InMemoryEventStore;
  published: Event[];
  /** Set to make EVERY subsequent publish a terminal relay rejection ('blocked: …' → markRejected). */
  reject: {on: boolean};
}

async function enrolledRuntime(): Promise<Harness> {
  const store = new InMemoryEventStore();
  const published: Event[] = [];
  const reject = {on: false};
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async (e: Event): Promise<PublishResult> => {
      published.push(e);
      return reject.on
        ? {accepted: false, message: 'blocked: rejected'} // non-retryable → outbox markRejected
        : {accepted: true, message: 'ok'};
    },
    subscribeGroup: () => {},
    unsubscribeGroup: () => {},
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return {runtime, store, published, reject};
}

let stateSeq = 0;
/** A relay-signed replaceable state event; monotonic created_at so a later one supersedes. */
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

/** Save an event to the store AND feed it through handleIncomingEvent, as relay ingestion does. */
function ingest(h: Harness, ev: Event): void {
  h.store.save(ev);
  h.runtime.handleIncomingEvent(ev);
}

/** Typed accessor for the private overlay + switch routine (mirrors AppRuntime.decryptCache.test.ts). */
function internals(runtime: AppRuntime): {
  _rosterOverlay: Map<string, Map<string, {op: string; eventId: string; at: number}>>;
  clearSwitchCaches(): void;
} {
  return runtime as unknown as {
    _rosterOverlay: Map<string, Map<string, {op: string; eventId: string; at: number}>>;
    clearSwitchCaches(): void;
  };
}

const GID = 'g1';
const BOB = 'b'.repeat(64);
const CAROL = 'c'.repeat(64);

/** Seed a public group's relay roster: admins=[me], members=[me,BOB], pending=[CAROL]. */
function seedRoster(h: Harness, me: string): void {
  h.store.save(relayState(GroupKind.Admins, [['d', GID], ['p', me]]));
  h.store.save(relayState(GroupKind.Members, [['d', GID], ['p', me], ['p', BOB]]));
  h.store.save(relayState(GroupKind.Pending, [['d', GID], ['p', CAROL]]));
}

describe('optimistic roster overlay — apply before the relay echoes', () => {
  it('kick removes the member from getGroupMembers immediately (publish never echoes 39002)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]);

    await h.runtime.kickGroupMember(GID, BOB);
    // No relay 39002 has arrived, yet BOB is gone from the members list at once.
    expect(h.runtime.getGroupMembers(GID)).toEqual([me]);
  });

  it('promote adds the pubkey to getGroupAdmins immediately', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    expect(h.runtime.getGroupAdmins(GID)).toEqual([me]);

    await h.runtime.addGroupMember(GID, BOB, true); // asAdmin → 'promote'
    expect(h.runtime.getGroupAdmins(GID)).toEqual([me, BOB]);
  });

  it('demote removes the pubkey from getGroupAdmins immediately', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    // BOB starts as an admin in the relay state.
    h.store.save(relayState(GroupKind.Admins, [['d', GID], ['p', me], ['p', BOB]]));
    expect(h.runtime.getGroupAdmins(GID)).toEqual([me, BOB]);

    await h.runtime.addGroupMember(GID, BOB, false); // no admin flag → 'demote'
    expect(h.runtime.getGroupAdmins(GID)).toEqual([me]);
  });

  it('approve adds the member AND drops the row from the join-request queue immediately', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    expect(h.runtime.getJoinRequestQueue(GID).map(r => r.pubkey)).toEqual([CAROL]);

    await h.runtime.approveJoin(GID, CAROL);
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB, CAROL]);
    expect(h.runtime.getJoinRequestQueue(GID)).toEqual([]); // no longer in the review queue
  });

  it('deny drops the row from the join-request queue immediately (members untouched)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);

    await h.runtime.denyJoin(GID, CAROL);
    expect(h.runtime.getJoinRequestQueue(GID)).toEqual([]);
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]); // deny is a no-op for the member set
  });
});

describe('optimistic roster overlay — reconcile against fresh relay state', () => {
  it('kick: an incoming 39002 without the member retires the overlay entry (no double-apply/stuck state)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    await h.runtime.kickGroupMember(GID, BOB);
    expect(internals(h.runtime)._rosterOverlay.get(GID)?.has(BOB)).toBe(true);

    // The relay's authoritative 39002 now reflects the removal.
    ingest(h, relayState(GroupKind.Members, [['d', GID], ['p', me]]));

    // The overlay entry is gone (the whole group map, since it was the only entry)...
    expect(internals(h.runtime)._rosterOverlay.get(GID)).toBeUndefined();
    // ...and a fresh snapshot reads straight from relay truth.
    expect(h.runtime.getGroupMembers(GID)).toEqual([me]);

    // No stuck state: a LATER independent 39002 re-adding BOB is reflected — the retired 'kick'
    // overlay does not resurrect and re-remove him.
    ingest(h, relayState(GroupKind.Members, [['d', GID], ['p', me], ['p', BOB]]));
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]);
  });

  it('promote: an incoming 39001 listing the admin retires the overlay entry', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    await h.runtime.addGroupMember(GID, BOB, true);
    expect(internals(h.runtime)._rosterOverlay.get(GID)?.get(BOB)?.op).toBe('promote');

    ingest(h, relayState(GroupKind.Admins, [['d', GID], ['p', me], ['p', BOB]]));

    expect(internals(h.runtime)._rosterOverlay.get(GID)).toBeUndefined();
    expect(h.runtime.getGroupAdmins(GID)).toEqual([me, BOB]);
  });

  it('approve: an incoming 39002 listing the member retires the overlay entry', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    await h.runtime.approveJoin(GID, CAROL);

    ingest(h, relayState(GroupKind.Members, [['d', GID], ['p', me], ['p', BOB], ['p', CAROL]]));

    expect(internals(h.runtime)._rosterOverlay.get(GID)).toBeUndefined();
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB, CAROL]);
  });

  it('deny: an incoming 39004 without the pubkey retires the overlay entry', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    await h.runtime.denyJoin(GID, CAROL);

    ingest(h, relayState(GroupKind.Pending, [['d', GID]])); // relay cleared CAROL from pending

    expect(internals(h.runtime)._rosterOverlay.get(GID)).toBeUndefined();
    expect(h.runtime.getJoinRequestQueue(GID)).toEqual([]);
  });
});

describe('optimistic roster overlay — revert on relay rejection', () => {
  it('a terminally rejected kick reverts getGroupMembers to the pre-op state (entry kept, not applied)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]);

    h.reject.on = true; // the relay will return OK(accepted=false) → markRejected (terminal)
    await h.runtime.kickGroupMember(GID, BOB);
    await flush(); // let deliver() classify the rejection

    // The overlay entry is KEPT (a rejected publish is not reconciled away)...
    expect(internals(h.runtime)._rosterOverlay.get(GID)?.get(BOB)?.op).toBe('kick');
    // ...but its publish is terminal 'rejected', so the getter no longer applies it — BOB is back.
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]);
  });

  it('a terminally rejected promote reverts getGroupAdmins to the pre-op state', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);

    h.reject.on = true;
    await h.runtime.addGroupMember(GID, BOB, true);
    await flush();

    expect(h.runtime.getGroupAdmins(GID)).toEqual([me]); // reverted — BOB never became an admin
  });

  it('a terminally rejected approve restores the join-request row', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);

    h.reject.on = true;
    await h.runtime.approveJoin(GID, CAROL);
    await flush();

    expect(h.runtime.getJoinRequestQueue(GID).map(r => r.pubkey)).toEqual([CAROL]); // row restored
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]); // and CAROL was never added
  });
});

// Incidental (in scope): a silently-bounced approve would recreate this whole incident invisibly —
// GroupView's resolved-request card reads getRosterActionStatus to notice its own optimistic
// "✓ Approved" didn't actually stick, the same outbox signal a message bubble's send-status ring reads.
describe('getRosterActionStatus — the UI-facing signal a bounced approve/deny didn\'t stick', () => {
  it('is undefined before any admin action has been taken on the pubkey', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    expect(h.runtime.getRosterActionStatus(GID, CAROL)).toBeUndefined();
  });

  it('reports a landed (accepted → confirmed) status once an approve succeeds', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    await h.runtime.approveJoin(GID, CAROL);
    await flush();
    // deliver() marks 'accepted' then immediately confirms (the relay's OK IS delivery) — by the
    // time flush() returns, the status has already advanced to 'confirmed'.
    expect(h.runtime.getRosterActionStatus(GID, CAROL)?.status).toBe('confirmed');
  });

  it('reports rejected + the relay reason once a terminally rejected approve settles', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    h.reject.on = true;
    await h.runtime.approveJoin(GID, CAROL);
    await flush();
    const status = h.runtime.getRosterActionStatus(GID, CAROL);
    expect(status?.status).toBe('rejected');
    expect(status?.reason).toBe('blocked: rejected');
  });

  it('a fresh retry (a new approve on the same pubkey) reports the new attempt, not the old rejection', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    h.reject.on = true;
    await h.runtime.approveJoin(GID, CAROL);
    await flush();
    expect(h.runtime.getRosterActionStatus(GID, CAROL)?.status).toBe('rejected');

    h.reject.on = false; // the retry succeeds this time
    await h.runtime.approveJoin(GID, CAROL);
    await flush();
    expect(h.runtime.getRosterActionStatus(GID, CAROL)?.status).toBe('confirmed');
  });
});

describe('optimistic roster overlay — cleared on identity/community switch', () => {
  it('clearSwitchCaches empties the overlay (no admin intent bleeds across communities/accounts)', async () => {
    const h = await enrolledRuntime();
    const me = h.runtime.getSnapshot().currentUserPubkey!;
    seedRoster(h, me);
    await h.runtime.kickGroupMember(GID, BOB);
    await h.runtime.addGroupMember(GID, BOB, true);
    expect(internals(h.runtime)._rosterOverlay.size).toBeGreaterThan(0);

    // clearSwitchCaches is the routine every community/account switch funnels through
    // (activateWorkspace / leave / duress) — exercise it directly, as the decrypt-cache test does.
    internals(h.runtime).clearSwitchCaches();

    expect(internals(h.runtime)._rosterOverlay.size).toBe(0);
    // With the overlay gone, the getters read straight from the (still-seeded) relay truth.
    expect(h.runtime.getGroupMembers(GID)).toEqual([me, BOB]);
    expect(h.runtime.getGroupAdmins(GID)).toEqual([me]);
  });
});
