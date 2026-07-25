/**
 * DM "Block user" semantics (owner-specified 2026-07-08):
 *
 * 1. Blocking a DM peer is PURELY LOCAL — nothing is published to the relay (no identity-signed
 *    kind-10000 mute list, which would deanonymise the "npub A muted npub B" relationship).
 * 2. A blocked peer's conversation is HIDDEN from the inbox; their pre-block history is KEPT (its
 *    gift wraps stay in the store) and restored on unblock, while DMs that arrive AFTER the block are
 *    DELETED on arrival.
 * 3. A MODERATOR removal (a moderator's kind-10000 mute list) auto-blocks that peer's DMs on every
 *    client, and a local unblock (an explicit allow) OVERRIDES it.
 *
 * These drive AppRuntime.effectiveDmBlocked / dmBlockSince / dropBlockedArrivals + the inbox filter.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@notifee/react-native', () => ({}), {virtual: true});

import {finalizeEvent, generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import {AppRuntime, type AppRuntimeDeps} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {sealDM} from '../dm/dm';
import {buildMuteList} from '../moderation/ownerComments';

const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

async function enrolledRuntime(
  moderators?: readonly string[],
): Promise<{runtime: AppRuntime; store: InMemoryEventStore; myPubkey: string}> {
  const store = new InMemoryEventStore();
  const deps: AppRuntimeDeps = {
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: async (d: Uint8Array) => d,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
    ...(moderators ? {moderators} : {}),
  };
  const runtime = new AppRuntime(deps);
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  const myPubkey = (runtime as unknown as {myPubkey: string}).myPubkey;
  return {runtime, store, myPubkey};
}

/** Peers of the conversation list, for terse assertions. */
function inboxPeers(runtime: AppRuntime): string[] {
  return runtime.getSnapshot().inbox.map(c => c.peer);
}

describe('AppRuntime DM block — local, device-only', () => {
  const BASE = 1_700_000_000_000; // ms
  let clock = BASE;
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    clock = BASE;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => nowSpy.mockRestore());

  it('hides the inbox, keeps pre-block history, deletes new arrivals, and restores on unblock', async () => {
    const {runtime, store, myPubkey} = await enrolledRuntime();
    const peerSK = generateSecretKey();
    const peer = getPublicKey(peerSK);

    // A DM received BEFORE the block (rumor created_at = now).
    const before = sealDM(peerSK, myPubkey, 'before block');
    store.save(before);
    await runtime.refreshInbox();
    expect(inboxPeers(runtime)).toEqual([peer]); // visible

    // Block the peer 60s later.
    clock = BASE + 60_000;
    await runtime.blockDmPeer(peer);
    expect(inboxPeers(runtime)).toEqual([]); // conversation hidden
    expect(store.has(before.id)).toBe(true); // pre-block history KEPT (just hidden)

    // A DM that arrives AFTER the block must be deleted on arrival.
    clock = BASE + 120_000;
    const after = sealDM(peerSK, myPubkey, 'after block');
    store.save(after);
    await runtime.refreshInbox();
    expect(store.has(after.id)).toBe(false); // deleted on arrival
    expect(inboxPeers(runtime)).toEqual([]); // still hidden

    // Unblock → the kept pre-block history reappears; the deleted new message stays gone.
    await runtime.unblockDmPeer(peer);
    expect(inboxPeers(runtime)).toEqual([peer]);
    const conv = runtime.getSnapshot().inbox.find(c => c.peer === peer)!;
    expect(conv.messages.map(m => m.text)).toEqual(['before block']);
    runtime.dispose();
  });

  it('publishes NOTHING to the relay when blocking (no kind-10000 mute list)', async () => {
    const published: unknown[] = [];
    const store = new InMemoryEventStore();
    const runtime = new AppRuntime({
      secureStorage: new InMemorySecureStorage(),
      store,
      hash: async (d: Uint8Array) => d,
      autoLockMs: 60_000,
      publish: async (ev: unknown) => {
        published.push(ev);
        return {accepted: true, message: 'ok'};
      },
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(), '1234', '9999');
    await runtime.submitPin('1234');
    const peer = getPublicKey(generateSecretKey());

    // Baseline after enrollment (which legitimately publishes a kind-9011 credential binding).
    const beforeCount = published.length;
    await runtime.blockDmPeer(peer);
    await runtime.unblockDmPeer(peer);
    await flush();

    // The whole point: the block/unblock actions emit NOTHING to the relay (a local, device-only
    // decision — an identity-signed mute would deanonymise the mute relationship).
    expect(published).toHaveLength(beforeCount);
    // And no kind-10000 mute list is signed into the local store either.
    expect(store.query({kinds: [10000]})).toHaveLength(0);
    runtime.dispose();
  });
});

describe('AppRuntime DM block — moderator propagation', () => {
  const BASE = 1_700_000_000_000;
  let clock = BASE;
  let nowSpy: jest.SpyInstance;

  beforeEach(() => {
    clock = BASE;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => nowSpy.mockRestore());

  it('auto-blocks a moderator-removed peer, deletes their new DMs, and lets a local unblock override it', async () => {
    const modSK = generateSecretKey();
    const modNpub = nip19.npubEncode(getPublicKey(modSK));
    const {runtime, store, myPubkey} = await enrolledRuntime([modNpub]);
    const peerSK = generateSecretKey();
    const peer = getPublicKey(peerSK);

    // A DM received BEFORE the moderator removal.
    const before = sealDM(peerSK, myPubkey, 'pre-removal');
    store.save(before);
    await runtime.refreshInbox();
    expect(inboxPeers(runtime)).toEqual([peer]);
    expect(runtime.isUserBlocked(peer)).toBe(false);

    // The moderator publishes a kind-10000 mute list naming the peer (created_at = now).
    clock = BASE + 60_000;
    store.save(finalizeEvent(buildMuteList([peer]) as never, modSK));
    // → auto-blocked on this client, without any local action.
    expect(runtime.isUserBlocked(peer)).toBe(true);
    await runtime.refreshInbox();
    expect(inboxPeers(runtime)).toEqual([]); // conversation hidden
    expect(store.has(before.id)).toBe(true); // pre-removal history kept

    // A DM arriving after the removal is deleted on arrival.
    clock = BASE + 120_000;
    const after = sealDM(peerSK, myPubkey, 'post-removal');
    store.save(after);
    await runtime.refreshInbox();
    expect(store.has(after.id)).toBe(false);

    // A local unblock (explicit allow) OVERRIDES the moderator auto-block.
    await runtime.unblockDmPeer(peer);
    expect(runtime.isUserBlocked(peer)).toBe(false);
    expect(inboxPeers(runtime)).toEqual([peer]);
    runtime.dispose();
  });
});
