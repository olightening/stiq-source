import {nip19} from 'nostr-tools';
import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import type {Session} from '../onboarding/enrollment';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;

/** A real enrollment Session bound to a specific community relay (→ a distinct community id). */
async function makeSessionFor(relayUrl: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin(
    {relayUrl, issuerPublicKey: 'aXNz'},
    new MockBlindRsa(),
    'STIQ-TEST-0001',
  );
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** A runtime whose event store is a SwappableEventStore fed by a per-community store factory. */
function newSiloRuntime() {
  const secure = new InMemorySecureStorage();
  // One persistent InMemory store per community id, so switching back to A returns A's data.
  const stores = new Map<string, EventStore>();
  const makeStore = async (cid: string | null): Promise<EventStore> => {
    const key = cid ?? '__none__';
    let store = stores.get(key);
    if (!store) {
      store = new InMemoryEventStore();
      stores.set(key, store);
    }
    return store;
  };
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: secure,
    store,
    createStore: makeStore,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  return {runtime, stores};
}

describe('AppRuntime multi-community silo', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('joining a second community swaps npub + feed with a complete silo, and switching restores each', async () => {
    const {runtime} = newSiloRuntime();
    await runtime.init();

    // Join community A, unlock, post.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    const npubA = runtime.getSnapshot().currentUserPubkey;
    expect(npubA).toBeTruthy();
    await runtime.post('from-A', ['a']);
    expect(runtime.getSnapshot().feed.items.map(i => i.content)).toContain('from-A');

    // Join community B (additive — a new identity slot + its own store). This switches to B.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    const npubB = runtime.getSnapshot().currentUserPubkey;

    // Different community ⇒ different on-device identity.
    expect(npubB).toBeTruthy();
    expect(npubB).not.toBe(npubA);

    // SILO: B's feed does NOT contain A's post. Post into B.
    let contents = runtime.getSnapshot().feed.items.map(i => i.content);
    expect(contents).not.toContain('from-A');
    await runtime.post('from-B', ['b']);
    contents = runtime.getSnapshot().feed.items.map(i => i.content);
    expect(contents).toContain('from-B');
    expect(contents).not.toContain('from-A');

    // Switch back to A: npub + feed flip back, and B's post is gone from view.
    await runtime.switchCommunity(communityId(RELAY_A));
    expect(runtime.getSnapshot().currentUserPubkey).toBe(npubA);
    contents = runtime.getSnapshot().feed.items.map(i => i.content);
    expect(contents).toContain('from-A');
    expect(contents).not.toContain('from-B');

    // Switch to B again: its own post is back, A's is hidden.
    await runtime.switchCommunity(communityId(RELAY_B));
    expect(runtime.getSnapshot().currentUserPubkey).toBe(npubB);
    contents = runtime.getSnapshot().feed.items.map(i => i.content);
    expect(contents).toContain('from-B');
    expect(contents).not.toContain('from-A');

    runtime.dispose();
  });

  it('leaving a community wipes its slot and switches away', async () => {
    const {runtime} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    await runtime.completeEnrollment(await makeSessionFor(RELAY_B), '1234', '');
    await runtime.submitPin('1234');

    // Two communities, two identity slots.
    expect((await runtime.getCommunities()).list).toHaveLength(2);
    expect((await runtime.listKeySlots()).slots).toHaveLength(2);

    // Leave B (the active one). Active flips to A; B's slot is wiped.
    await runtime.removeCommunity(communityId(RELAY_B));
    const {list, activeId} = await runtime.getCommunities();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(communityId(RELAY_A));
    expect(activeId).toBe(communityId(RELAY_A));
    expect((await runtime.listKeySlots()).slots).toHaveLength(1);

    runtime.dispose();
  });

  it('joining the SAME community twice keeps BOTH identities (the first is not lost)', async () => {
    const {runtime} = newSiloRuntime();
    await runtime.init();

    // First identity in community A.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '9999');
    await runtime.submitPin('1234');
    const npub1 = runtime.getSnapshot().currentUserPubkey;

    // Join the SAME community again with a different invite → a SECOND identity.
    await runtime.completeEnrollment(await makeSessionFor(RELAY_A), '1234', '');
    const npub2 = runtime.getSnapshot().currentUserPubkey;
    expect(npub2).not.toBe(npub1);

    // Two identity slots exist, but only ONE community entry (same relay onion).
    const {slots} = await runtime.listKeySlots();
    expect(slots).toHaveLength(2);
    expect((await runtime.getCommunities()).list).toHaveLength(1);

    // The FIRST identity is still reachable — switching back restores its npub (it was not lost).
    const slot1 = slots.find(s => s.npub === nip19.npubEncode(npub1!))!;
    expect(slot1).toBeDefined();
    await runtime.switchIdentity(slot1.id);
    expect(runtime.getSnapshot().currentUserPubkey).toBe(npub1);

    // Leaving the second identity keeps the first + the community (not the last identity there).
    const slot2 = (await runtime.listKeySlots()).slots.find(s => s.npub === nip19.npubEncode(npub2!))!;
    await runtime.removeIdentity(slot2.id);
    expect((await runtime.listKeySlots()).slots).toHaveLength(1);
    expect((await runtime.getCommunities()).list).toHaveLength(1);
    expect(runtime.getSnapshot().currentUserPubkey).toBe(npub1);

    // Leaving the last identity removes the community too.
    await runtime.removeIdentity(slot1.id);
    expect((await runtime.listKeySlots()).slots).toHaveLength(0);
    expect((await runtime.getCommunities()).list).toHaveLength(0);

    runtime.dispose();
  });
});
