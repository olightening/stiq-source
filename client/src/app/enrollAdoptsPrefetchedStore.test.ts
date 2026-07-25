/**
 * completeEnrollment adopts the first-run prefetch's PRE-MINTED account slot.
 *
 * This is the single joint the whole onboarding-prefetch feature hangs on, and it is invisible at
 * the call site: the slot id IS the event store's namespace (`createStore(cid, slotId)`), so if
 * enrollment mints its own instead of adopting the one the prefetch already filled, everything
 * downloaded during the connecting step is silently orphaned in a file nothing will ever open again.
 * Nothing else in the app would fail — the member would simply land on the empty Updates tab the
 * feature exists to prevent, which is exactly the kind of regression a test has to catch because a
 * human never will.
 *
 * See onboarding/prefetchCommunity.ts (the writer) and App.tsx's `onEnroll` (the handoff).
 */
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {communityId} from '../communities/communityStore';
import {newSlotId} from '../keys/keyRing';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import type {Session} from '../onboarding/enrollment';
import {Kind} from '../contracts';
import {AppRuntime} from './AppRuntime';
import type {Event} from 'nostr-tools/pure';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const identityHash = async (d: Uint8Array) => d;

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** A channel definition standing in for "everything the prefetch downloaded". */
function prefetchedEvent(): Event {
  return {
    id: 'f'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: 1_700_000_000,
    kind: Kind.LiveActivity,
    tags: [['d', 'lounge'], ['title', 'Lounge'], ['status', 'live']],
    content: '',
    sig: 'x'.repeat(128),
  };
}

/** A runtime whose per-(cid, slot) stores are real, distinct, and observable by namespace. */
function harness() {
  const stores = new Map<string, InMemoryEventStore>();
  const createStore = jest.fn(async (cid: string | null, slotId: string | null) => {
    const key = `${cid ?? '-'}|${slotId ?? '-'}`;
    let store = stores.get(key);
    if (!store) {
      store = new InMemoryEventStore();
      stores.set(key, store);
    }
    return store as EventStore;
  });
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    createStore,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  return {runtime, store, stores, createStore};
}

describe('completeEnrollment + first-run prefetch slot', () => {
  it('opens the PRE-MINTED slot, so everything the prefetch downloaded is live on entry', async () => {
    const h = harness();
    await h.runtime.init();
    const session = await makeSession();

    // Stand in for the prefetch: it minted this slot during the connecting step and filled that
    // namespace's store over Tor while the member picked a handle.
    const slotId = newSlotId();
    const cid = communityId(session.relayUrl);
    const warm = await h.createStore(cid, slotId);
    warm.save(prefetchedEvent());

    await h.runtime.completeEnrollment(session, '1234', '9999', undefined, {slotId});

    expect(h.createStore).toHaveBeenCalledWith(cid, slotId);
    // The runtime's live store IS the warm one — read through the swappable shell the whole app
    // (feed, Updates tab, channel list) reads through, not through the map, so this asserts what a
    // member actually sees rather than what the factory happened to return.
    expect(h.store.query({kinds: [Kind.LiveActivity]})).toHaveLength(1);
  });

  it('mints its own slot when none is supplied — the pre-prefetch behaviour, unchanged', async () => {
    const h = harness();
    await h.runtime.init();
    const session = await makeSession();

    // A store warmed under some OTHER slot must not leak into an enrollment that didn't ask for it:
    // a fresh slot is a fresh namespace, which is what keeps two accounts in one community siloed.
    const strangerSlot = newSlotId();
    const warm = await h.createStore(communityId(session.relayUrl), strangerSlot);
    warm.save(prefetchedEvent());

    await h.runtime.completeEnrollment(session, '1234', '9999');

    expect(h.store.query({kinds: [Kind.LiveActivity]})).toHaveLength(0);
  });

  it('is harmless when the prefetch failed and its slot names an empty namespace', async () => {
    const h = harness();
    await h.runtime.init();
    const session = await makeSession();

    // The prefetch hands its slot id over even when `createStore` threw and it never wrote a byte —
    // adopting an unused id must be indistinguishable from minting a fresh one.
    const slotId = newSlotId();
    await h.runtime.completeEnrollment(session, '1234', '9999', undefined, {slotId});

    expect(h.runtime.getSnapshot().enrolled).toBe(true);
    expect(h.store.query({kinds: [Kind.LiveActivity]})).toHaveLength(0);
  });
});
