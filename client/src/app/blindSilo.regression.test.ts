/**
 * Regression suite for blind posting × multi-community silo (from the fresh-v3-join E2E handoff).
 *
 * Covers three confirmed defects and their fixes:
 *  1. Bug 1 — a no-ck re-join of the SAME community used to CLOBBER the stored shared community key
 *     (toEnrolledCommunity emitted `communityKey: undefined`, upsert's `{...old,...new}` merge erased
 *     it), nulling the module key so the next blind post silently went out non-blind. Fixed by making
 *     toEnrolledCommunity omit absent fields (+ an upsert secret guard).
 *  2. Re-join field clobber — the same mechanism erased a live-learned tagPolicy on re-join.
 *  3. Shared wallet — AppRuntime used ONE un-namespaced EpochWallet for every community, so tokens
 *     drawn under community A's issuer bled into community B (wrong-issuer → rejected at B's relay,
 *     and A's balance suppressed B's top-up). Fixed by namespacing the wallet per community and
 *     rebuilding it in rebuildIdentity().
 */
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
import type {Community} from '../onboarding/community';
import type {TagPolicy} from '../feed/tagPolicy';
import {finalizeEvent, getPublicKey, type Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const CK_B = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
// Fixed organizer keys so we can sign a kind-30078 config event AS the active organizer.
const ORG_SK_A = new Uint8Array(32).fill(11);
const ORG_PUB_A = getPublicKey(ORG_SK_A);
const ORG_PUB_B = 'b'.repeat(64);

const LIVE_TAG_POLICY = {
  communityTags: ['news', 'ask'],
  pinCommunityTags: true,
  allowMemberTags: true,
  maxTags: 9,
  tagScopes: {},
} as unknown as TagPolicy;

async function makeSession(community: Community): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

const v3 = (relayUrl: string, ck: string, org: string): Community => ({
  relayUrl,
  issuerPublicKey: 'aXNz',
  organizerPubkey: org,
  communityKey: ck,
});
const noCk = (relayUrl: string, org: string): Community => ({
  relayUrl,
  issuerPublicKey: 'aXNz',
  organizerPubkey: org,
});

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

const isBlind = (e: Event): boolean => e.tags.some(t => t[0] === 'stiq_token' && !!t[1]);

// Every test community here shares the same issuer key 'aXNz', so a seeded wallet must carry the
// matching posting-key fingerprint — exactly as a real draw (runtime.drawTokens → wallet.add) stamps
// it — or the runtime's key-siloed wallet would treat the tokens as unknown-provenance and discard them.
const ISSUER_FP = walletKeyFingerprint('aXNz');

/**
 * Resolve the slot whose wallet the runtime will spend from. These tests always seed a community's
 * wallet right AFTER making it active (fresh enroll or switch), so target the ACTIVE account's slot —
 * which, after a same-community re-join, is the NEW account, not the first-match slot. Falls back to a
 * first-match-by-cid when nothing is active yet.
 */
async function slotIdFor(secure: InMemorySecureStorage, relayUrl: string): Promise<string> {
  const ring = new KeyRing(secure);
  const active = await ring.getActiveSlotId();
  if (active) return active;
  const cid = communityId(relayUrl);
  return (await ring.listSlots()).find(s => communityId(s.relayUrl) === cid)?.id ?? cid;
}

/** Seed a community's wallet (namespaced by its ACCOUNT slot after the per-account silo split). */
async function seedWalletFor(secure: InMemorySecureStorage, relayUrl: string, n = 5): Promise<void> {
  const wallet = new EpochWallet(secure, await slotIdFor(secure, relayUrl), ISSUER_FP);
  // Real holder-bound keypairs (P3): these tokens are spent + posted blind by the runtime.
  const tokens = Array.from({length: n}, () => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: new Uint8Array(32), secret: q};
  });
  await wallet.add(0, tokens);
}

/** A valid kind-30078 tag-policy config event signed by an organizer secret key. */
function orgConfigEvent(orgSk: Uint8Array): Event {
  return finalizeEvent(
    {
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'stiq:tag-policy']],
      content: JSON.stringify({communityTags: ['live'], pinCommunityTags: true, allowMemberTags: true, maxTags: 3, tagScopes: {}}),
    },
    orgSk,
  );
}

/** Drain the fire-and-forget promise chain (handleIncomingEvent's .then(upsert)). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('blind posting × multi-community silo — defect regressions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a no-ck re-join of the SAME community PRESERVES the shared key and keeps posting blind (Bug 1)', async () => {
    const {runtime, secure, published} = newSiloRuntime();
    await runtime.init();

    // Full v3 enroll: the shared community key is live.
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    expect(runtime.getActiveCommunityKey()).toBe(CK_A);

    // Re-join the SAME community (same relay onion) in add mode with a code that carried NO ck —
    // the confounded on-device scenario. This must NOT wipe the previously-learned key.
    await runtime.completeEnrollment(await makeSession(noCk(RELAY_A, ORG_PUB_A)), '1234', '');
    expect(runtime.getActiveCommunityKey()).toBe(CK_A); // preserved (was: undefined → non-blind)
    expect(moduleActiveKey()).not.toBeNull();

    await seedWalletFor(secure, RELAY_A);
    published.length = 0;
    await runtime.post('should still be blind');
    const post = published.find(e => e.kind === 1);
    expect(post).toBeDefined();
    expect(isBlind(post!)).toBe(true);
    runtime.dispose();
  });

  it('a re-join lacking tagPolicy PRESERVES the live-learned tagPolicy on the record', async () => {
    const {runtime} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(
      await makeSession({...v3(RELAY_A, CK_A, ORG_PUB_A), tagPolicy: LIVE_TAG_POLICY}),
      '1234',
      '9999',
    );
    expect(await runtime.submitPin('1234')).toBe('unlocked');

    // Re-join without a tagPolicy (a real join code never carries the live policy).
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '');

    const active = await (runtime as unknown as {communities: {active(): Promise<{tagPolicy?: TagPolicy}>}}).communities.active();
    expect((active?.tagPolicy as unknown as {maxTags: number})?.maxTags).toBe(9); // preserved
    runtime.dispose();
  });

  it('a live organizer config after a v3 enroll does NOT null the community key', async () => {
    const {runtime, secure, published} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    expect(moduleActiveKey()).not.toBeNull();

    // The fire-and-forget upsert({...active, ...patch}) must preserve ck.
    runtime.handleIncomingEvent(orgConfigEvent(ORG_SK_A));
    await flushMicrotasks();
    expect(runtime.getActiveCommunityKey()).toBe(CK_A);

    await seedWalletFor(secure, RELAY_A);
    published.length = 0;
    await runtime.post('after live config');
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    runtime.dispose();
  });

  it('each community keeps its OWN token wallet — no cross-issuer bleed across the silo', async () => {
    const {runtime, secure} = newSiloRuntime();
    await runtime.init();

    // Enroll A, seed A's (namespaced) wallet.
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await seedWalletFor(secure, RELAY_A, 3);
    expect(await runtime.walletBalance()).toBe(3);

    // Join + switch to a DIFFERENT community B. Its wallet is isolated → starts empty.
    await runtime.completeEnrollment(await makeSession(v3(RELAY_B, CK_B, ORG_PUB_B)), '1234', '');
    await runtime.switchCommunity(communityId(RELAY_B));
    expect(await runtime.walletBalance()).toBe(0); // was 3 (bug: shared pool bled A's tokens into B)

    // Seed B's own wallet; A's stays untouched across the switch back.
    await seedWalletFor(secure, RELAY_B, 2);
    expect(await runtime.walletBalance()).toBe(2);
    await runtime.switchCommunity(communityId(RELAY_A));
    expect(await runtime.walletBalance()).toBe(3); // A's pool intact, unaffected by B
    runtime.dispose();
  });

  it('B posts blind with its OWN tokens, leaving A’s wallet untouched', async () => {
    const {runtime, secure, published} = newSiloRuntime();
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    await seedWalletFor(secure, RELAY_A, 2);

    await runtime.completeEnrollment(await makeSession(v3(RELAY_B, CK_B, ORG_PUB_B)), '1234', '');
    await runtime.switchCommunity(communityId(RELAY_B));
    await seedWalletFor(secure, RELAY_B, 2);

    published.length = 0;
    await runtime.post('hello from B');
    expect(isBlind(published.find(e => e.kind === 1)!)).toBe(true);
    expect(await runtime.walletBalance()).toBe(1); // spent one of B's own tokens

    // A's wallet was never touched.
    await runtime.switchCommunity(communityId(RELAY_A));
    expect(await runtime.walletBalance()).toBe(2);
    runtime.dispose();
  });
});

describe('empty wallet never blocks a post — transparent on-demand token draw', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** A runtime whose drawTokensNow is built from its own secure store (so a draw can seed the wallet). */
  function runtimeWithDraw(makeDraw: (secure: InMemorySecureStorage) => () => Promise<boolean>) {
    const secure = new InMemorySecureStorage();
    const stores = new Map<string, EventStore>();
    const makeStore = async (cid: string | null): Promise<EventStore> => {
      const key = cid ?? '__none__';
      let s = stores.get(key);
      if (!s) { s = new InMemoryEventStore(); stores.set(key, s); }
      return s;
    };
    const published: Event[] = [];
    const runtime = new AppRuntime({
      secureStorage: secure,
      store: new SwappableEventStore(new InMemoryEventStore()),
      createStore: makeStore,
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => { published.push(e); return {accepted: true, message: 'ok'}; },
      drawTokensNow: makeDraw(secure),
    });
    return {runtime, published};
  }

  it('draws on demand when the wallet is empty at post time, then posts BLIND (no error, no prompt)', async () => {
    let drawCalls = 0;
    const {runtime, published} = runtimeWithDraw(secure => async () => {
      drawCalls++;
      // Mimic the host topping up the ACTIVE account's wallet over Tor (stamped under the issuer key).
      const sid = (await new KeyRing(secure).getActiveSlotId()) ?? communityId(RELAY_A);
      const {q, Q} = newTokenKeypair();
      await new EpochWallet(secure, sid, ISSUER_FP).add(0, [{token: Q, sig: new Uint8Array(32), secret: q}]);
      return true;
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    expect(await runtime.submitPin('1234')).toBe('unlocked');
    expect(await runtime.walletBalance()).toBe(0); // starts empty (nothing drawn yet)

    published.length = 0;
    await runtime.post('should just work'); // must NOT throw — the runtime tops up behind the scenes
    expect(drawCalls).toBe(1);
    const post = published.find(e => e.kind === 1);
    expect(post).toBeDefined();
    expect(isBlind(post!)).toBe(true); // went out blind, using the freshly-drawn token
    runtime.dispose();
  });

  it('votes also recover via the on-demand draw (every reaction spends a token)', async () => {
    let drawCalls = 0;
    const {runtime, published} = runtimeWithDraw(secure => async () => {
      drawCalls++;
      const sid = (await new KeyRing(secure).getActiveSlotId()) ?? communityId(RELAY_A);
      const {q, Q} = newTokenKeypair();
      await new EpochWallet(secure, sid, ISSUER_FP).add(0, [{token: Q, sig: new Uint8Array(32), secret: q}]);
      return true;
    });
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    await runtime.submitPin('1234');
    published.length = 0;
    await runtime.vote('some-post-id', 'f'.repeat(64), 'up'); // empty wallet → draws, then reacts blind
    expect(drawCalls).toBe(1);
    const reaction = published.find(e => e.kind === 7);
    expect(reaction).toBeDefined();
    expect(isBlind(reaction!)).toBe(true);
    runtime.dispose();
  });

  it('propagates the exhaustion when the on-demand draw cannot refill (offline / cap hit)', async () => {
    const {runtime} = runtimeWithDraw(() => async () => false); // draw yields nothing
    await runtime.init();
    await runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
    await runtime.submitPin('1234');
    // post() rejects so the composer can frame it as a transient hiccup — never a "draw tokens" prompt.
    await expect(runtime.post('nope')).rejects.toThrow();
    runtime.dispose();
  });
});
