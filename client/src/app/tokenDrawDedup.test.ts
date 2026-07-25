/**
 * T-G3a — churn cap: on-demand draws for the SAME auxiliary token purpose (space-write, media-write)
 * must coalesce into ONE Tor round-trip when two writes find the wallet dry around the same moment —
 * e.g. a channel broadcast and a group post both spending space-write tokens. Before this round each
 * caller independently called drawForWallet, stacking concurrent draws for the identical purpose on
 * the single SOCKS circuit (the "unlock/draw churn saturating the Tor circuit" contributor to the
 * field report's 30s delay). drawForWalletDeduped (AppRuntime) fixes this: concurrent callers share
 * one in-flight draw and all resolve off it.
 *
 * Mirrors spaceWrites.durable.test.ts's harness (space-write wallet, blind-required-off community) and
 * drawDurability.test.ts's module-boundary mock of drawExchange.runTokenDraw (same convention: the
 * network/crypto plumbing is proven elsewhere; this suite proves the AppRuntime-level coalescing).
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import * as drawMod from '../blind/drawExchange';
import {InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {newTokenKeypair} from '../blind/holderProof';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ISSUER = 'aXNz';
const CHANNEL_ID = `30311:${'a'.repeat(64)}:mychan`;
const GROUP_ID = 'g1';

const v3 = (): Community => ({
  relayUrl: RELAY,
  issuerPublicKey: ISSUER,
  organizerPubkey: 'b'.repeat(64),
  communityKey: CK,
});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-DEDUP');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime(relayInfo: () => unknown) {
  const secure = new InMemorySecureStorage();
  const published: Event[] = [];
  const runtime = new AppRuntime({
    secureStorage: secure,
    store: new SwappableEventStore(new InMemoryEventStore()),
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

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});
const SPACE_TOKENS_ON = (): unknown => capsDoc({enforced: {space_tokens_required: true}});

async function enrolled(relayInfo: () => unknown) {
  const h = newRuntime(relayInfo);
  await h.runtime.init();
  await h.runtime.completeEnrollment(await makeSession(), '1234', '9999');
  expect(await h.runtime.submitPin('1234')).toBe('unlocked');
  await h.runtime.onRelayConnected(); // fetches + applies the mocked relay caps
  h.published.length = 0; // drop the enrollment binding event — irrelevant to this suite
  return h;
}

/** Real holder-bound keypairs (matches spaceWrites.durable.test.ts's seedSpaceWallet): a space-write
 *  token's `secret` is schnorr.sign'd inside buildSpaceTokenTags, so it must be an in-range secp256k1
 *  scalar, not an arbitrary filler byte string. */
function fakeSpaceTokens(n: number) {
  return Array.from({length: n}, () => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: new Uint8Array(32), secret: q};
  });
}

/** Drain the fire-and-forget promise chains the publish/draw path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('T-G3a: on-demand auxiliary-purpose draws dedupe per purpose', () => {
  it('a channel broadcast and a group post finding the SAME dry space-write wallet share ONE draw', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    // No space wallet seeded — both writes find it dry. connectForDraw's socket is never touched
    // (runTokenDraw is mocked at the module boundary below), only its mere presence matters.
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () => ({}) as never;

    // Hold the draw open until BOTH writes have had the chance to reach the dry spend and queue onto
    // the shared in-flight promise, so a broken (non-deduped) implementation would have already fired
    // a SECOND runTokenDraw call by the time we release this gate.
    let releaseDraw!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseDraw = resolve;
    });
    const drawSpy = jest.spyOn(drawMod, 'runTokenDraw').mockImplementation(async () => {
      await gate;
      return {ok: true, tokens: fakeSpaceTokens(50)};
    });

    const p1 = runtime.postToChannel(CHANNEL_ID, 'hello from the channel');
    const p2 = runtime.postToGroup(GROUP_ID, 'hello from the group');
    await flush(); // let both writes run up to (and block on) the shared draw

    releaseDraw();
    await Promise.all([p1, p2]);
    await flush();

    // ONE Tor round-trip served both writes — not two stacked draws for the identical purpose.
    expect(drawSpy).toHaveBeenCalledTimes(1);
    // Both writes still landed off that one draw — dedup must never drop a write.
    expect(published.length).toBe(2);
    runtime.dispose();
  });

  it('a THIRD write arriving after the shared draw already resolved triggers its own (separate) draw', async () => {
    // Not a churn bug: once the in-flight draw settles, a LATER drought is free to draw again — the
    // dedup is scoped to concurrent callers, not a permanent one-draw-ever cap.
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    (runtime as unknown as {deps: {connectForDraw?: () => unknown}}).deps.connectForDraw = () => ({}) as never;

    const drawSpy = jest.spyOn(drawMod, 'runTokenDraw').mockImplementation(async () => ({
      ok: true,
      tokens: fakeSpaceTokens(1), // exactly enough for one write per draw — forces the second write dry again
    }));

    await runtime.postToChannel(CHANNEL_ID, 'first');
    await flush();
    await runtime.postToGroup(GROUP_ID, 'second — wallet dry again, new draw');
    await flush();

    expect(drawSpy).toHaveBeenCalledTimes(2);
    expect(published.length).toBe(2);
    runtime.dispose();
  });
});
