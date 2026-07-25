/**
 * Reaction exhaustion is a visible failure — never a silent vanish (the vote()/channel/group tap-
 * reaction bug this suite's first two describes now pin the fix for) — and, for DM reactions, still a
 * clean revert (a separate, still-open design choice covered by the last describe block).
 *
 * T-reactions (2026-07-22): vote()/reactToChannelMessage()/reactToGroupMessage() used to ride
 * signOptimisticWrite, whose catch DISCARDS the placeholder on exhaustion — so a tapped ✦ (or emoji,
 * or retraction) rendered instantly and then silently reverted seconds later whenever the blind wallet
 * was dry and the Tor draw failed/was slow. They now queue on the SAME durable PendingWrite pipeline
 * post/comment/channel/group writes use (see AppRuntime.sendReaction / PendingReactionWrite): on
 * exhaustion the optimistic tap STAYS rendered 'failed' (Retry), the reaction still counts in the
 * viewer's own tally (it is, after all, what they just tapped), and it drains automatically once
 * tokens arrive (reconnect / draw / pull-refresh) — exactly like a queued comment. The caller's own
 * promise still REJECTS on exhaustion (signPendingWrite rethrows), so App.tsx's runWrite still fires
 * its one-shot Alert same as before.
 *
 * reactToDM (a DM emoji reaction) deliberately stays OFF this pipeline — it has no feed placeholder to
 * hold, and its own thread-echo IS the optimistic state (see PendingWrite's doc) — so it still rides
 * signOptimisticWrite and still reverts cleanly on exhaustion; that describe block is unchanged.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import {BlindTokensExhausted} from '../blind/blindSigner';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {makePoolWallet} from '../blind/tokenPool';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {Purpose} from '../contracts';
import {Kind} from '../nostr/events';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(5)).toString('base64');
const ISSUER = 'aXNz';
const ISSUER_FP = walletKeyFingerprint(ISSUER);
const GID = 'g'.repeat(12);
const MSG_ID = 'e'.repeat(64);
const MSG_PK = 'f'.repeat(64);
// A real secp256k1 point — reactToDM's seal runs actual NIP-44 ECDH against it, so (unlike MSG_PK
// above, which is only ever used as an opaque tag value) a fabricated 'c'.repeat(64) is not valid.
const PEER = getPublicKey(generateSecretKey());
const RUMOR_ID = 'd'.repeat(64);

/** A blind-provisioned (v3) community — needed for the channel-reaction blind path (feedSigner). */
const v3 = (): Community => ({
  relayUrl: RELAY,
  issuerPublicKey: ISSUER,
  organizerPubkey: 'b'.repeat(64),
  communityKey: CK,
});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-REACTDURABLE');
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

/** Seed the active community's SPACE-WRITE wallet so a group reaction's bearer/pre-sign spend or a
 *  DM reaction's token attach can spend a space-write token. */
async function seedSpaceWallet(secure: InMemorySecureStorage, n = 5): Promise<void> {
  const wallet = makePoolWallet(Purpose.SpaceWrite, secure, await slotIdFor(secure), ISSUER_FP);
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
  await h.runtime.onRelayConnected(); // fetches + applies the mocked relay caps
  await flush();
  h.published.length = 0; // drop the kind-9011 binding-event publish from enrollment itself
  return h;
}

/** Drain the fire-and-forget promise chains the publish/draw path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});

/** The one still-'local-…'-keyed placeholder in the snapshot, or undefined if none (mirrors
 *  spaceWrites.durable.test.ts's helper of the same name). */
function placeholderId(snap: ReturnType<AppRuntime['getSnapshot']>): string | undefined {
  return [...snap.sendStatus.keys()].find(id => id.startsWith('local-'));
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('channel reaction (blind path) — durable: exhaustion keeps the tap queued, never vanishes silently (T-reactions)', () => {
  it('reactToChannelMessage rejects but keeps the optimistic reaction rendered "failed" (Retry), still counted', async () => {
    const {runtime, published} = await enrolled(() => capsDoc({enforced: {blind_required: true}}));
    // No posting wallet seeded, no drawTokensNow wired — feedSigner's blind sign throws
    // BlindTokensExhausted straight from BlindSigner.sign() (no on-demand draw-and-retry available).

    await expect(runtime.reactToChannelMessage(MSG_ID, MSG_PK, '\u{1f525}')).rejects.toThrow(BlindTokensExhausted);
    await flush();

    expect(published).toHaveLength(0); // nothing ever reached the relay
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    // Durable, not reverted: the tap the viewer just made still shows in their own tally — a like that
    // stayed queued must not look like it never happened.
    expect(runtime.getReactionsByTarget().get(MSG_ID) ?? []).toHaveLength(1);
    runtime.dispose();
  });

  it('drains once posting tokens arrive — exactly one reaction published, not a duplicate', async () => {
    const {runtime, secure, published} = await enrolled(() => capsDoc({enforced: {blind_required: true}}));

    await expect(runtime.reactToChannelMessage(MSG_ID, MSG_PK, '\u{1f525}')).rejects.toThrow(BlindTokensExhausted);
    await flush();
    expect(published).toHaveLength(0);

    const wallet = new EpochWallet(secure, await slotIdFor(secure), ISSUER_FP);
    await wallet.add(
      0,
      Array.from({length: 5}, () => {
        const {q, Q} = newTokenKeypair();
        return {token: Q, sig: new Uint8Array(32), secret: q};
      }),
    );
    await runtime.refreshFeed(); // drainPendingPosts runs from here
    await flush();

    const reactions = published.filter(e => e.kind === Kind.Reaction);
    expect(reactions).toHaveLength(1);
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined(); // placeholder swapped for the real event
    expect(runtime.getReactionsByTarget().get(MSG_ID) ?? []).toHaveLength(1);
    runtime.dispose();
  });

  it('a successful channel reaction (tokens available) is NOT reverted and stays in the tally', async () => {
    const {runtime, secure, published} = await enrolled(() => capsDoc({enforced: {blind_required: true}}));
    const wallet = new EpochWallet(secure, await slotIdFor(secure), ISSUER_FP);
    await wallet.add(
      0,
      Array.from({length: 5}, () => {
        const {q, Q} = newTokenKeypair();
        return {token: Q, sig: new Uint8Array(32), secret: q};
      }),
    );

    await runtime.reactToChannelMessage(MSG_ID, MSG_PK, '\u{1f525}');
    await flush();

    expect(published.some(e => e.kind === Kind.Reaction)).toBe(true);
    expect(runtime.getReactionsByTarget().get(MSG_ID) ?? []).toHaveLength(1);
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined();
    expect([...snap.sendStatus.values()]).not.toContain('failed');
    runtime.dispose();
  });

  it('a like, then a re-tap retraction while the like is STILL queued, collapses to ONE queued intent (dedupe)', async () => {
    const {runtime, published} = await enrolled(() => capsDoc({enforced: {blind_required: true}}));
    // No posting wallet — both taps exhaust and stay queued.

    await expect(runtime.reactToChannelMessage(MSG_ID, MSG_PK, '+')).rejects.toThrow(BlindTokensExhausted);
    await flush();
    const firstId = placeholderId(runtime.getSnapshot());
    expect(firstId).toBeDefined();

    // Re-tap: retract the same reaction while the first attempt is still sitting in the queue.
    await expect(runtime.reactToChannelMessage(MSG_ID, MSG_PK, '✖')).rejects.toThrow(BlindTokensExhausted); // ✖ RETRACT_MARKER
    await flush();

    const snap = runtime.getSnapshot();
    // Collapsed onto exactly ONE placeholder — the stale one was discarded, not left alongside a
    // second (the fresh retraction intent gets its OWN id; store.save is add-only, so reusing the
    // first tap's id would have silently kept ITS content instead of the retraction's).
    const liveIds = [...snap.sendStatus.keys()].filter(id => id.startsWith('local-'));
    expect(liveIds).toHaveLength(1);
    expect(liveIds[0]).not.toBe(firstId);
    // The rendered/stored reaction for this message reflects the LATEST intent (the retraction), and
    // there is exactly one — the earlier like never lingers as a second phantom write.
    const reactions = runtime.getReactionsByTarget().get(MSG_ID) ?? [];
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.content).toBe('✖');
    const priv = runtime as unknown as {pendingPosts: {type: string; targetId?: string}[]};
    expect(priv.pendingPosts.filter(p => p.type === 'reaction' && p.targetId === MSG_ID)).toHaveLength(1);
    expect(published).toHaveLength(0); // both taps stayed queued — neither ever reached the relay
    runtime.dispose();
  });
});

describe('group reaction (bearer/space-token path) — durable: exhaustion keeps the tap queued, never vanishes silently (T-reactions)', () => {
  it('reactToGroupMessage rejects but keeps the optimistic reaction rendered "failed" (Retry), still counted', async () => {
    const {runtime, published} = await enrolled(() =>
      capsDoc({enforced: {blind_required: true, space_tokens_required: true}}),
    );
    // No space wallet seeded — the pre-sign hook's spend throws BlindTokensExhausted (same setup as
    // spaceReactions.test.ts's "yields to the space-token chain" test; this suite adds the durable check).

    await expect(runtime.reactToGroupMessage(GID, MSG_ID, MSG_PK, '+')).rejects.toThrow(BlindTokensExhausted);
    await flush();

    expect(published).toHaveLength(0);
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    expect(runtime.getReactionsByTarget().get(MSG_ID) ?? []).toHaveLength(1);
    runtime.dispose();
  });

  it('drains once space tokens arrive — exactly one group reaction published, not a duplicate', async () => {
    const {runtime, secure, published} = await enrolled(() =>
      capsDoc({enforced: {blind_required: true, space_tokens_required: true}}),
    );

    await expect(runtime.reactToGroupMessage(GID, MSG_ID, MSG_PK, '+')).rejects.toThrow(BlindTokensExhausted);
    await flush();
    expect(published).toHaveLength(0);

    await seedSpaceWallet(secure);
    await runtime.refreshFeed();
    await flush();

    const reactions = published.filter(e => e.kind === Kind.Reaction);
    expect(reactions).toHaveLength(1);
    expect(reactions[0]!.tags).toContainEqual(['h', GID]);
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined();
    runtime.dispose();
  });
});

describe('DM reaction — exhaustion reverts the optimistic reaction AND now surfaces the failure (T4.3 fix)', () => {
  it('reactToDM rejects (previously swallowed silently) and rolls back the optimistic myDmReactions entry', async () => {
    const {runtime, published} = await enrolled(() => capsDoc({enforced: {space_tokens_required: true}}));
    // No space wallet seeded — dmTokenAttach's spendSpaceTokens throws BlindTokensExhausted. Nothing
    // has mined yet at this point (attachTokens runs, and throws, BEFORE mineGiftWrap's PoW loop).

    await expect(runtime.reactToDM(PEER, RUMOR_ID, '❤️')).rejects.toThrow(BlindTokensExhausted);
    await flush();

    expect(published).toHaveLength(0); // no wrap ever reached the outbox/relay
    // The optimistic entry (pushed before the seal attempt) must be rolled back — never a phantom
    // reaction stuck with no explanation, and never silently absorbed with no signal to the caller.
    const priv = runtime as unknown as {myDmReactions: {targetRumorId: string; emoji: string}[]};
    expect(priv.myDmReactions).toHaveLength(0);
    runtime.dispose();
  });

  it('a successful DM reaction (tokens available) is NOT reverted and stays recorded', async () => {
    const {runtime, secure, published} = await enrolled(() =>
      // Low dm_pow so the real (cheap, non-mocked) PoW mine stays fast in-test — mirrors dm.test.ts's
      // own "low for a fast test" convention rather than stubbing the seal.
      capsDoc({enforced: {space_tokens_required: true}, dm_pow: 8}),
    );
    await seedSpaceWallet(secure);

    await runtime.reactToDM(PEER, RUMOR_ID, '❤️');
    await flush();

    expect(published.some(e => e.kind === Kind.GiftWrap)).toBe(true);
    const priv = runtime as unknown as {myDmReactions: {targetRumorId: string; emoji: string}[]};
    expect(priv.myDmReactions).toHaveLength(1);
    runtime.dispose();
  });
});
