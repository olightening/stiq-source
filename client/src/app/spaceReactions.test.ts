/**
 * Space/channel reaction routing under blind_required (the token_required reject fix).
 *
 * The relay's blind gate covers kind 7 REGARDLESS of tags, and prod ships blind_required=true —
 * so a tokenless npub-signed reaction is rejected [token_required]. The two reaction surfaces
 * need two different admissible shapes:
 *
 *  - a PUBLIC-CHANNEL reaction (no `h` tag) is indistinguishable from a feed vote and rides the
 *    BLIND path: throwaway signer + posting token + encrypted attribution (feedSigner);
 *  - a GROUP reaction (h-tagged) must stay npub-signed (GroupGuard requires the real member) and
 *    carries a BEARER posting token — plain stiq_token/stiq_sig pairs, no stiq_spend proofs —
 *    which handleBlindPost admits while holder proofs ship dark. Once the relay enforces space
 *    tokens the pre-sign hook's space chain takes over and the bearer attach must yield.
 */
// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {AppRuntime} from './AppRuntime';
import {BlindTokensExhausted} from '../blind/blindSigner';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {setBytesPerToken} from '../blind/tokenCost';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ISSUER = 'aXNz';
const ISSUER_FP = walletKeyFingerprint(ISSUER);
const GID = 'g'.repeat(12);
const MSG_ID = 'e'.repeat(64);
const MSG_PK = 'f'.repeat(64);

/** A blind-provisioned (v3) community — the community key is what makes the runtime blind-sign. */
const v3 = (): Community => ({
  relayUrl: RELAY,
  issuerPublicKey: ISSUER,
  organizerPubkey: 'b'.repeat(64),
  communityKey: CK,
});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime(relayInfo: () => unknown) {
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
  const runtime = new AppRuntime({
    secureStorage: secure,
    store: new SwappableEventStore(new InMemoryEventStore()),
    createStore: makeStore,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
    fetchRelayInfo: async () => relayInfo(),
  });
  return {runtime, secure, published};
}

async function slotIdFor(secure: InMemorySecureStorage): Promise<string> {
  const ring = new KeyRing(secure);
  return (await ring.getActiveSlotId()) ?? communityId(RELAY);
}

/** Seed the active community's blind-posting wallet so a reaction can spend a token. */
async function seedWallet(secure: InMemorySecureStorage, n = 5): Promise<void> {
  const wallet = new EpochWallet(secure, await slotIdFor(secure), ISSUER_FP);
  await wallet.add(
    0,
    Array.from({length: n}, () => {
      const {q, Q} = newTokenKeypair();
      return {token: Q, sig: new Uint8Array(32), secret: q};
    }),
  );
}

async function enrolled(relayInfo: () => unknown) {
  const h = newRuntime(relayInfo);
  await h.runtime.init();
  await h.runtime.completeEnrollment(await makeSession(), '1234', '9999');
  expect(await h.runtime.submitPin('1234')).toBe('unlocked');
  return h;
}

/** Drain the fire-and-forget promise chains the publish path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});
const tokenTags = (e: Event): string[][] => e.tags.filter(t => t[0] === 'stiq_token');
const hasTag = (e: Event, name: string): boolean => e.tags.some(t => t[0] === name && !!t[1]);
const lastReaction = (published: Event[]): Event | undefined =>
  [...published].reverse().find(e => e.kind === 7);

afterEach(() => {
  jest.restoreAllMocks();
  setBytesPerToken(0);
});

describe('public-channel reactions ride the blind path', () => {
  it('reactToChannelMessage publishes a throwaway-signed, tokened, attributed kind-7', async () => {
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({enforced: {blind_required: true}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure);

    await runtime.reactToChannelMessage(MSG_ID, MSG_PK, '🔥');
    await flush();

    const reaction = lastReaction(published);
    expect(reaction).toBeDefined();
    expect(reaction!.tags).toContainEqual(['e', MSG_ID]);
    // Blind shape: spends a posting token, carries the encrypted attribution, and is NOT signed
    // by the member's real npub (token 0 is the signer).
    expect(tokenTags(reaction!).length).toBeGreaterThan(0);
    expect(hasTag(reaction!, 'stiq_attr')).toBe(true);
    expect(reaction!.pubkey).not.toBe(runtime.getSnapshot().currentUserPubkey);
    runtime.dispose();
  });
});

describe('group reactions carry a bearer posting token under blind_required', () => {
  beforeEach(async () => {
    // Sticky enforcement (2026-07-28) persists an explicitly-advertised flag per community in
    // AsyncStorage — which the global jest mock keeps as a file-scoped singleton. Without a clear,
    // the first test's explicit `blind_required: true` advertisement leaks into the "never
    // advertised" fallback test below (same cid), whose tokenless expectation then fails. Same
    // hygiene as AppRuntime.capsSticky.test.ts's own beforeEach.
    await AsyncStorage.clear();
  });

  it('reactToGroupMessage stays npub-signed and attaches plain (token, sig) pairs, no proofs', async () => {
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({enforced: {blind_required: true}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure);

    await runtime.reactToGroupMessage(GID, MSG_ID, MSG_PK, '+');
    await flush();

    const reaction = lastReaction(published);
    expect(reaction).toBeDefined();
    expect(reaction!.tags).toContainEqual(['h', GID]);
    // Attributed bearer shape: the REAL member signs (GroupGuard needs it), one bearer pair pays
    // the blind gate, and there are no stiq_spend proofs and no stiq_attr (nothing to hide — the
    // event is npub-signed anyway).
    expect(reaction!.pubkey).toBe(runtime.getSnapshot().currentUserPubkey);
    expect(tokenTags(reaction!).length).toBe(1);
    expect(hasTag(reaction!, 'stiq_sig')).toBe(true);
    expect(hasTag(reaction!, 'stiq_spend')).toBe(false);
    expect(hasTag(reaction!, 'stiq_attr')).toBe(false);
    runtime.dispose();
  });

  it('stays tokenless when the relay does not enforce blind_required (caps fallback)', async () => {
    const {runtime, secure, published} = await enrolled(() => ({}));
    await runtime.onRelayConnected();
    await seedWallet(secure);

    await runtime.reactToGroupMessage(GID, MSG_ID, MSG_PK, '+');
    await flush();

    const reaction = lastReaction(published);
    expect(reaction).toBeDefined();
    expect(reaction!.pubkey).toBe(runtime.getSnapshot().currentUserPubkey);
    expect(tokenTags(reaction!).length).toBe(0);
    runtime.dispose();
  });

  it('yields to the space-token chain when space_tokens_required is on (no bearer attach)', async () => {
    const {runtime, secure} = await enrolled(() =>
      capsDoc({enforced: {blind_required: true, space_tokens_required: true}}),
    );
    await runtime.onRelayConnected();
    await seedWallet(secure);

    // The pre-sign hook owns the h-tagged kind-7 now; with an empty SPACE wallet and no draw
    // socket it fails loudly — proving the bearer attach did not fire (it would have succeeded
    // silently from the seeded POSTING wallet) and no mixed-chain event ever went out. T0.1: the
    // exhaustion throw is a typed, calm BlindTokensExhausted now, not a raw "out of space tokens" Error.
    await expect(runtime.reactToGroupMessage(GID, MSG_ID, MSG_PK, '+')).rejects.toThrow(
      BlindTokensExhausted,
    );
    runtime.dispose();
  });
});
