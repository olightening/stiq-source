// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {getActiveCommunityKey as moduleActiveKey} from '../blind/communityKey';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
// A well-formed 32-byte community key (base64) → the v3 blind-post shared secret.
const CK = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');
const ORG_PUBKEY = 'a'.repeat(64);

/** A real v3 enrollment Session: community carries the shared community key (blind posting). */
async function makeV3Session(relayUrl: string): Promise<Session> {
  const {enrollment} = await Enrollment.begin(
    {relayUrl, issuerPublicKey: 'aXNz', organizerPubkey: ORG_PUBKEY, communityKey: CK},
    new MockBlindRsa(),
    'STIQ-TEST-0001',
  );
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newSiloRuntime() {
  const secure = new InMemorySecureStorage();
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
  const published: Event[] = [];
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: secure,
    store,
    createStore: makeStore,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
  });
  return {runtime, secure, published};
}

function isBlind(e: Event): boolean {
  return e.tags.some(t => t[0] === 'stiq_token' && !!t[1]);
}

/**
 * Put spendable tokens in the ACTIVE account's wallet (namespaced by the identity slot after the
 * per-account silo split). Called right after making the target community active, so the active slot
 * is the one the runtime will spend from. `relayUrl` is kept for the pre-active fallback.
 */
async function seedWallet(secure: InMemorySecureStorage, relayUrl: string, n = 5): Promise<void> {
  const ring = new KeyRing(secure);
  const slotId =
    (await ring.getActiveSlotId()) ??
    (await ring.listSlots()).find(s => communityId(s.relayUrl) === communityId(relayUrl))?.id ??
    communityId(relayUrl);
  // Stamp the issuer-key fingerprint the runtime's key-siloed wallet expects (matches a real draw).
  const wallet = new EpochWallet(secure, slotId, walletKeyFingerprint('aXNz'));
  // Real holder-bound keypairs (P3): these tokens are spent + posted blind, so token 0's secret must
  // be a valid key and `token` its matching x-only pubkey.
  const tokens = Array.from({length: n}, () => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: new Uint8Array(32), secret: q};
  });
  await wallet.add(0, tokens);
}

describe('v3 blind enrollment → active community key + blind posting', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('BUG1a: first v3 enroll activates the in-memory community key', async () => {
    const {runtime} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '9999');
    expect(runtime.getActiveCommunityKey()).toBe(CK);
    expect(moduleActiveKey()).not.toBeNull(); // BlindSigner reads THIS
    runtime.dispose();
  });

  it('BUG1b: ADD-MODE v3 join (2nd community) activates the new community key + posts BLIND', async () => {
    const {runtime, secure, published} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');

    // Add-mode join of a DIFFERENT v3 community.
    await runtime.completeEnrollment(await makeV3Session(RELAY_B), '1234', '');
    expect(runtime.getActiveCommunityKey()).toBe(CK);
    expect(moduleActiveKey()).not.toBeNull();

    await seedWallet(secure, RELAY_B);
    published.length = 0;
    await runtime.post('hello from B');
    const post = published.find(e => e.kind === 1);
    expect(post).toBeDefined();
    expect(isBlind(post!)).toBe(true); // ← Bug 1: was going out non-blind
    runtime.dispose();
  });

  it('BUG1c: ADD-MODE re-join of the SAME v3 community keeps the key active + posts BLIND', async () => {
    const {runtime, secure, published} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');

    // Re-join the SAME community (same relay onion) in add mode.
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '');
    expect(runtime.getActiveCommunityKey()).toBe(CK);
    expect(moduleActiveKey()).not.toBeNull();

    await seedWallet(secure, RELAY_A);
    published.length = 0;
    await runtime.post('hello again');
    const post = published.find(e => e.kind === 1);
    expect(isBlind(post!)).toBe(true);
    runtime.dispose();
  });

  it('(d) a re-enroll of the SAME community CLEARS its wallet — no tokens inherited from the prior account', async () => {
    const {runtime, secure} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await seedWallet(secure, RELAY_A, 5);
    expect(await runtime.walletBalance()).toBe(5);

    // Re-enroll the SAME community (a fresh membership credential). Even though the issuer key is
    // unchanged (so the fingerprint self-heal wouldn't fire), the prior account's tokens must not
    // carry over — completeEnrollment wipes the cid's wallet.
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '');
    expect(await runtime.walletBalance()).toBe(0);
    runtime.dispose();
  });

  it('BUG2: after ADD-MODE v3 join, a new post appears optimistically in the snapshot', async () => {
    const {runtime, secure} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeV3Session(RELAY_A), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await runtime.completeEnrollment(await makeV3Session(RELAY_B), '1234', '');

    await seedWallet(secure, RELAY_B);
    await runtime.post('optimistic body');
    const contents = runtime.getSnapshot().feed.items.map(i => i.content);
    expect(contents.some(c => c.includes('optimistic body'))).toBe(true); // ← Bug 2
    runtime.dispose();
  });
});
