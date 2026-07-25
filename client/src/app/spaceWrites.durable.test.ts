/**
 * Durable optimistic-write + failed/Retry treatment for bound-npub SPACE content once the relay
 * requires space-write tokens (T0.2/T0.3, tokens-everywhere).
 *
 * Channel broadcasts+edits (T0.2) and group posts/edits/replies (T0.3) are signed by the bound npub,
 * not blind — but once `space_tokens_required` is on, their OWN signature spends a space-write token
 * via the `identity` pre-sign hook (spaceTokenTagsFor), and that spend is a Tor-bound draw that can
 * throw BlindTokensExhausted exactly like a feed post's blind signature can. Before this fix these
 * writes had NO optimistic placeholder and NO durable catch (F2/F3): a drought threw uncaught with
 * nothing on screen during the draw and no failure state after — a TEXT-ONLY broadcast in particular
 * took a separate instant-publish fast path with nothing to catch a bare-signature exhaustion at all.
 *
 * This suite pins the fix across all five new PendingWrite variants: an in-flight placeholder, a
 * 'failed'+Retry+CALM-reason on exhaustion with the content preserved, and a successful drain once
 * tokens arrive — for a text-only channel broadcast, a channel edit, a group post, a group edit, and a
 * group reply.
 */
jest.mock('../config', () => ({...jest.requireActual('../config'), TIMING_JITTER: false}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {makePoolWallet} from '../blind/tokenPool';
import {newTokenKeypair} from '../blind/holderProof';
import {Purpose} from '../contracts';
import {Kind} from '../nostr/events';
import {GroupKind} from '../channels/groups';
import {decodeNameHeader} from '../profile/displayName';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY = `ws://${'a'.repeat(56)}.onion`;
const CK = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ISSUER = 'aXNz';
// No `spaceWriteIssuerPublicKey` in this community ⇒ AppRuntime falls back to the single issuer key
// for the space wallet's fingerprint too (loadActiveCommunityPolicy: `active?.spaceWriteIssuerPublicKey
// ?? active?.issuerPublicKey`) — so the space wallet self-heals to the SAME fingerprint as the post
// wallet in this single-key deployment, and seeding under it is exactly what a live community would do.
const ISSUER_FP = walletKeyFingerprint(ISSUER);
const CHANNEL_ID = `30311:${'a'.repeat(64)}:mychan`;
const GROUP_ID = 'g1';

const v3 = (): Community => ({
  relayUrl: RELAY,
  issuerPublicKey: ISSUER,
  organizerPubkey: 'b'.repeat(64),
  communityKey: CK,
});

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(v3(), new MockBlindRsa(), 'STIQ-TEST-SPACEWRITES');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function newRuntime(relayInfo: () => unknown) {
  const secure = new InMemorySecureStorage();
  const {runtime, published} = newRuntimeOn(secure, relayInfo);
  return {runtime, secure, published};
}

/** Same construction as {@link newRuntime}, but over a CALLER-SUPPLIED SecureStorage — the piece
 *  needed to model an app restart: a fresh AppRuntime (fresh in-memory event store, empty
 *  pendingPosts, empty everything-in-JS-heap) that shares only what actually survives a process
 *  kill on a real device — the persisted SecureStorage. */
function newRuntimeOn(secure: InMemorySecureStorage, relayInfo: () => unknown) {
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
  return {runtime, published};
}

async function slotIdFor(secure: InMemorySecureStorage): Promise<string> {
  const ring = new KeyRing(secure);
  return (await ring.getActiveSlotId()) ?? communityId(RELAY);
}

/** Seed the active community's SPACE-WRITE wallet (a pool distinct from posting/read/media) so a
 *  channel/group write's own bound-npub signature can spend a space-write token. */
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

/** Seed the active community's POST wallet (feedSigner's blind wallet — distinct from the space-write
 *  wallet above) so a feed post/comment/vote's own blind signature can spend a posting token. Needed
 *  for promoteChannelPost's step 1 (the feed post rides feedSigner, not the space-write chain). */
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
  await h.runtime.onRelayConnected(); // fetches + applies the mocked relay caps
  await flush();
  // Drop the pending kind-9011 binding event onRelayConnected fires on first connect (onboarding) —
  // every assertion below is about the write under test, not the enrollment handshake.
  h.published.length = 0;
  return h;
}

/** Drain the fire-and-forget promise chains the publish/draw path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

const capsDoc = (stiq: Record<string, unknown>) => ({'stiq-capabilities': stiq});
const SPACE_TOKENS_ON = (): unknown => capsDoc({enforced: {space_tokens_required: true}});

/** The one still-'local-…'-keyed placeholder in the snapshot, or undefined if none. */
function placeholderId(snap: ReturnType<AppRuntime['getSnapshot']>): string | undefined {
  return [...snap.sendStatus.keys()].find(id => id.startsWith('local-'));
}

describe('channel broadcast — durable placeholder + failed/Retry under space_tokens_required (T0.2)', () => {
  it('a TEXT-ONLY broadcast renders an instant placeholder and stays queued (not silently lost) on exhaustion', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    // No space wallet seeded — the pre-sign hook's spend throws BlindTokensExhausted.

    await expect(runtime.postToChannel(CHANNEL_ID, 'hello channel')).rejects.toThrow();
    await flush();

    expect(published).toHaveLength(0); // nothing half-published to the relay
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    // Calm reason (T0.3's awaitingSign reason slot), never raw token/draw/allowance jargon (F4).
    const reason = snap.sendReasons.get(id!);
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).not.toMatch(/token|allowance|draw/);
    // Content preserved — still visible in its channel, folded/rendered from the placeholder, so the
    // Retry affordance has something to hang off.
    const msgs = runtime.getChannelMessages(CHANNEL_ID);
    expect(msgs).toHaveLength(1);
    expect(decodeNameHeader(msgs[0]!.content).text).toBe('hello channel');
    runtime.dispose();
  });

  it('drains once space tokens arrive — exactly one broadcast published, not a duplicate', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);

    await expect(runtime.postToChannel(CHANNEL_ID, 'soon')).rejects.toThrow();
    await flush();
    expect(published).toHaveLength(0);

    await seedSpaceWallet(secure);
    await runtime.refreshFeed(); // drainPendingPosts runs from here
    await flush();

    const casts = published.filter(e => e.kind === Kind.LiveChat);
    expect(casts).toHaveLength(1);
    expect(decodeNameHeader(casts[0]!.content).text).toBe('soon');
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined(); // placeholder swapped for the real event
    runtime.dispose();
  });

  it('a successful broadcast (tokens already available) publishes immediately with no placeholder left behind', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    await seedSpaceWallet(secure);

    await runtime.postToChannel(CHANNEL_ID, 'goes right through');
    await flush();

    const casts = published.filter(e => e.kind === Kind.LiveChat);
    expect(casts).toHaveLength(1);
    // The 'local-…' placeholder is gone (swapped for the real event); nothing is stuck 'failed'.
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined();
    expect([...snap.sendStatus.values()]).not.toContain('failed');
    runtime.dispose();
  });

  it('a channel EDIT (new channelEdit PendingWrite variant) is durable on exhaustion, content preserved', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    const originalId = 'orig' + '0'.repeat(60);

    await expect(runtime.editChannelMessage(CHANNEL_ID, originalId, 'fixed text')).rejects.toThrow();
    await flush();

    expect(published).toHaveLength(0);
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    expect(snap.sendReasons.get(id!)?.toLowerCase()).not.toMatch(/token|allowance|draw/);
    runtime.dispose();
  });

  it('a channel EDIT drains once space tokens arrive, carrying the edit marker', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    const originalId = 'orig' + '0'.repeat(60);

    await expect(runtime.editChannelMessage(CHANNEL_ID, originalId, 'fixed text')).rejects.toThrow();
    await flush();

    await seedSpaceWallet(secure);
    await runtime.refreshFeed();
    await flush();

    const edits = published.filter(e => e.kind === Kind.LiveChat);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.tags).toContainEqual(['e', originalId, '', 'edit']);
    runtime.dispose();
  });
});

describe('group writes — durable placeholder + failed/Retry under space_tokens_required (T0.3)', () => {
  it('postToGroup renders an instant placeholder and stays queued (not silently lost) on exhaustion', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);

    await expect(runtime.postToGroup(GROUP_ID, 'hello group')).rejects.toThrow();
    await flush();

    expect(published).toHaveLength(0);
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    const reason = snap.sendReasons.get(id!);
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).not.toMatch(/token|allowance|draw/);
    const msgs = runtime.getGroupMessages(GROUP_ID);
    expect(msgs).toHaveLength(1);
    expect(decodeNameHeader(msgs[0]!.content).text).toBe('hello group');
    runtime.dispose();
  });

  it('postToGroup drains once space tokens arrive — exactly one message published', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);

    await expect(runtime.postToGroup(GROUP_ID, 'soon group')).rejects.toThrow();
    await flush();
    expect(published).toHaveLength(0);

    await seedSpaceWallet(secure);
    await runtime.refreshFeed();
    await flush();

    const chats = published.filter(e => e.kind === GroupKind.Chat);
    expect(chats).toHaveLength(1);
    expect(decodeNameHeader(chats[0]!.content).text).toBe('soon group');
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined();
    expect([...snap.sendStatus.values()]).not.toContain('failed');
    runtime.dispose();
  });

  it('a successful group post (tokens already available) resolves and publishes with no error', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    await seedSpaceWallet(secure);

    await runtime.postToGroup(GROUP_ID, 'goes right through');
    await flush();

    expect(published.filter(e => e.kind === GroupKind.Chat)).toHaveLength(1);
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined();
    expect([...snap.sendStatus.values()]).not.toContain('failed');
    runtime.dispose();
  });

  it('editGroupMessage (new groupEdit PendingWrite variant) is durable on exhaustion, content preserved', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    const originalId = 'orig' + '0'.repeat(60);

    await expect(runtime.editGroupMessage(GROUP_ID, originalId, 'fixed group text')).rejects.toThrow();
    await flush();

    expect(published).toHaveLength(0);
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    runtime.dispose();
  });

  it('replyToGroupMessage (new groupReply PendingWrite variant) is durable on exhaustion, content preserved', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    const parentId = 'parent' + '0'.repeat(58);

    await expect(runtime.replyToGroupMessage(GROUP_ID, parentId, 'a reply')).rejects.toThrow();
    await flush();

    expect(published).toHaveLength(0);
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    runtime.dispose();
  });

  it('replyToGroupMessage drains once space tokens arrive, carrying the reply marker', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    const parentId = 'parent' + '0'.repeat(58);

    await expect(runtime.replyToGroupMessage(GROUP_ID, parentId, 'a reply')).rejects.toThrow();
    await flush();

    await seedSpaceWallet(secure);
    await runtime.refreshFeed();
    await flush();

    const replies = published.filter(e => e.kind === GroupKind.Reply);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.tags).toContainEqual(['e', parentId, '', 'reply']);
    runtime.dispose();
  });

  it('a manual Retry (AppRuntime.retry) re-signs a failed group post the same way drainPendingPosts does', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);

    await expect(runtime.postToGroup(GROUP_ID, 'retry me')).rejects.toThrow();
    await flush();
    const id = placeholderId(runtime.getSnapshot());
    expect(id).toBeDefined();

    await seedSpaceWallet(secure);
    await runtime.retry(id!);
    await flush();

    expect(published.filter(e => e.kind === GroupKind.Chat)).toHaveLength(1);
    const snap = runtime.getSnapshot();
    expect(snap.sendStatus.has(id!)).toBe(false); // the retried placeholder id is gone, swapped for real
    expect([...snap.sendStatus.values()]).not.toContain('failed');
    runtime.dispose();
  });
});

/**
 * promoteChannelPost's SECOND sign (T4.3/T4.4) — the in-place "promoted" edit on the source
 * channel/group message. Before T4.3 it was a bespoke direct `identity.sign()` with no
 * placeholder/catch at all: a space-token drought here threw uncaught, leaving a published feed post
 * whose source message never got marked promoted and no way to retry just that half. It now queues on
 * the SAME 'channelEdit'/'groupEdit' PendingWrite variant a plain author edit uses (via the
 * promotedFeedId field), so it inherits the identical durable treatment these tests already pin for
 * editChannelMessage/editGroupMessage above.
 *
 * Since T4.4, step 2 is derived and queued from INSIDE signPendingWrite the instant step 1 (the feed
 * post, now itself a durable 'post' PendingWrite — see promoteSource) actually signs, and a drought on
 * step 2 alone is swallowed there (it is durable on its own terms — placeholder, 'failed'+Retry,
 * drainPendingPosts — so it must never fail the feed post's already-succeeded promise). So
 * `promoteChannelPost()` now RESOLVES as soon as step 1 lands, even when step 2 is left queued on a
 * drought — the tests below no longer expect a rejection for a step-2-only exhaustion.
 */
describe("promoteChannelPost's in-place edit — durable on space-token exhaustion (T4.3)", () => {
  /** A minimal already-existing channel/group message to promote — the author's own prior send. */
  const sourceMessage = (kind: number, coordTagValue: string): Event => ({
    id: 'src0' + '0'.repeat(60),
    pubkey: 'x'.repeat(64),
    created_at: 1000,
    kind,
    tags: kind === Kind.LiveChat ? [['a', coordTagValue, '', 'root']] : [['h', coordTagValue]],
    content: 'original message',
    sig: '',
  });

  it('a CHANNEL promote: the feed post lands, but the in-place edit is durably queued (not a silent uncaught throw) on exhaustion', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    // Step 1 (the feed post) rides feedSigner/the POSTING wallet — seed it so it succeeds. Step 2
    // (the in-place edit) rides the space-write chain — its wallet stays EMPTY so it exhausts.
    await seedWallet(secure);

    const source = sourceMessage(Kind.LiveChat, CHANNEL_ID);
    // Resolves: step 1 (the feed post) succeeds; step 2's drought is queued+swallowed internally,
    // never surfaced as a rejection of the overall promotion (T4.4).
    await runtime.promoteChannelPost(source, 'promoted content');
    await flush();

    const feedPost = published.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined(); // step 1 succeeded — never blocked by step 2's later exhaustion
    expect(feedPost!.content).toContain('promoted content');
    expect(published.some(e => e.kind === Kind.LiveChat)).toBe(false); // edit NOT half-published

    // Step 2 is visible + retryable — never a silent drop of the promotion.
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    const reason = snap.sendReasons.get(id!);
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).not.toMatch(/token|allowance|draw/);
    runtime.dispose();
  });

  it('a CHANNEL promote edit drains once space tokens arrive, carrying the promoted marker to the real feed post', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    await seedWallet(secure);

    const source = sourceMessage(Kind.LiveChat, CHANNEL_ID);
    await runtime.promoteChannelPost(source, 'promoted content'); // resolves — step 2's drought is internal
    await flush();
    const feedPost = published.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined();

    await seedSpaceWallet(secure);
    await runtime.refreshFeed(); // drainPendingPosts runs from here
    await flush();

    const edits = published.filter(e => e.kind === Kind.LiveChat);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.tags).toContainEqual(['e', source.id, '', 'edit']);
    expect(edits[0]!.tags).toContainEqual(['promoted', feedPost!.id]);
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined(); // placeholder swapped for the real edit
    runtime.dispose();
  });

  it('a GROUP promote: durable on exhaustion (feed post lands, edit queued) and drains with the promoted marker', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    await seedWallet(secure);

    const source = sourceMessage(GroupKind.Chat, GROUP_ID);
    await runtime.promoteChannelPost(source, 'promoted group content'); // resolves — step 2's drought is internal
    await flush();

    const feedPost = published.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined();
    expect(published.some(e => e.kind === GroupKind.Chat)).toBe(false);
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');

    await seedSpaceWallet(secure);
    await runtime.refreshFeed();
    await flush();

    const edits = published.filter(e => e.kind === GroupKind.Chat);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.tags).toContainEqual(['promoted', feedPost!.id]);
    runtime.dispose();
  });

  // F-B regression: every test above drains the queued promote-edit off the SAME live AppRuntime
  // instance that queued it — its in-memory `pendingPosts` entry (built directly by
  // promoteChannelPost, `promotedFeedId` intact) never has to survive a round trip through
  // persistPendingCompose/loadPendingCompose. That misses a real bug: coercePendingWrite (the
  // rehydration path loadPendingCompose uses to rebuild each persisted intent on the NEXT app
  // launch) rebuilt a 'channelEdit'/'groupEdit' from only `{channelId/groupId, originalId}` and
  // silently dropped `promotedFeedId` — so a promoted edit queued during a space-token drought that
  // outlives the app process would come back after restart as a PLAIN edit, permanently missing its
  // `['promoted', feedId]` tag, with no error anywhere. This test forces the write through the
  // ACTUAL persist→reload path: dispose the runtime that queued the edit (its JS heap, including
  // pendingPosts, is gone — modeling a killed process) and drain it from a SECOND AppRuntime that
  // shares only the persisted SecureStorage.
  it('a promoted edit queued during a drought survives an app restart WITH its promoted tag intact (not just a live-queue drain)', async () => {
    const h = await enrolled(SPACE_TOKENS_ON);
    await seedWallet(h.secure); // step 1 (the feed post) succeeds; the space-write wallet stays empty
    const source = sourceMessage(Kind.LiveChat, CHANNEL_ID);

    await h.runtime.promoteChannelPost(source, 'promoted content'); // resolves — step 2's drought is internal
    await flush();
    const feedPost = h.published.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined();
    expect(h.published.some(e => e.kind === Kind.LiveChat)).toBe(false); // edit still queued, not sent

    // "Restart": the instance that queued the edit is gone — nothing in its JS heap (including
    // pendingPosts) survives. Only what it persisted to SecureStorage does.
    h.runtime.dispose();
    const {runtime: rt2, published: published2} = newRuntimeOn(h.secure, SPACE_TOKENS_ON);
    await rt2.init(); // loadWorkspaceState → loadPendingCompose → coercePendingWrite rehydrates the queue
    expect(await rt2.submitPin('1234')).toBe('unlocked');
    await rt2.onRelayConnected();
    await flush();

    // Now supply the space-write tokens the drought was missing and drain the REHYDRATED queue.
    await seedSpaceWallet(h.secure);
    await rt2.refreshFeed();
    await flush();

    const edits = published2.filter(e => e.kind === Kind.LiveChat);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.tags).toContainEqual(['e', source.id, '', 'edit']);
    // The regression this test pins: the promoted tag must still be there after a real restart.
    expect(edits[0]!.tags).toContainEqual(['promoted', feedPost!.id]);
    rt2.dispose();
  });
});

/**
 * promoteChannelPost's FIRST sign (T4.4) — the feed post itself. Before this fix it rode
 * signOptimisticWrite, the SAME bare instant-placeholder path vote() uses — deliberately NOT queued
 * for durable recovery there, because a vote is a cheap idempotent re-tap with nothing riding on it.
 * Reusing it for promoteChannelPost's step 1 was wrong: a drought on THIS signature (the ordinary
 * feed/POST wallet, not the space-write chain) threw straight out of promoteChannelPost with NOTHING
 * durable behind it — no feed post, no queued retry, and step 2 (the in-place edit) was never even
 * reached, so "allow replies" silently did nothing. Step 1 now queues on the ordinary 'post'
 * PendingWrite pipeline (the exact one post() uses) with a `promoteSource` recipe for step 2, so it
 * gets the identical placeholder/'failed'+Retry/drainPendingPosts/restart-persistence treatment as any
 * other post, and chains step 2 the moment it actually signs (live or post-restart).
 */
describe("promoteChannelPost's feed post — durable on its OWN (post-wallet) exhaustion (T4.4)", () => {
  const sourceMessage = (kind: number, coordTagValue: string): Event => ({
    id: 'src0' + '0'.repeat(60),
    pubkey: 'x'.repeat(64),
    created_at: 1000,
    kind,
    tags: kind === Kind.LiveChat ? [['a', coordTagValue, '', 'root']] : [['h', coordTagValue]],
    content: 'original message',
    sig: '',
  });

  it('STEP 1 droughts (no post wallet seeded): nothing half-published — no feed post, no edit, a visible failed+Retry placeholder', async () => {
    const {runtime, published} = await enrolled(SPACE_TOKENS_ON);
    // Neither wallet seeded: step 1's OWN blind signature (the feed/POST wallet, distinct from the
    // space-write chain) exhausts before step 2 is ever reached.
    const source = sourceMessage(Kind.LiveChat, CHANNEL_ID);

    await expect(runtime.promoteChannelPost(source, 'promoted content')).rejects.toThrow();
    await flush();

    expect(published).toHaveLength(0); // NOTHING published — not the feed post, not the edit
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');
    const reason = snap.sendReasons.get(id!);
    expect(reason).toBeTruthy();
    expect(reason!.toLowerCase()).not.toMatch(/token|allowance|draw/);
    // The failed placeholder IS the feed post's own render (not a bare uncaught throw with nothing on
    // screen) — visible in the feed, exactly like any other durable post.
    expect(snap.feed.items.some(i => i.content === 'promoted content')).toBe(true);
    runtime.dispose();
  });

  it('drains once BOTH wallets arrive after a STEP 1 drought: the feed post AND the promoted edit both land', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    const source = sourceMessage(Kind.LiveChat, CHANNEL_ID);

    await expect(runtime.promoteChannelPost(source, 'promoted content')).rejects.toThrow();
    await flush();
    expect(published).toHaveLength(0); // neither half published yet

    // Supply BOTH wallets: step 1's post wallet AND step 2's space-write wallet.
    await seedWallet(secure);
    await seedSpaceWallet(secure);
    await runtime.refreshFeed(); // drainPendingPosts re-signs the queued post, which chains step 2 itself
    // refreshFeed's drainPendingPosts is fire-and-forget (`void`), and step 2 here is chained off a
    // NESTED signPendingWrite call (post → chain → editIntent) — one extra async hop deeper than the
    // other tests in this file, so it needs a second flush() round to let the whole chain settle.
    await flush();
    await flush();

    const feedPost = published.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined();
    expect(feedPost!.content).toContain('promoted content');
    const edits = published.filter(e => e.kind === Kind.LiveChat);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.tags).toContainEqual(['e', source.id, '', 'edit']);
    expect(edits[0]!.tags).toContainEqual(['promoted', feedPost!.id]);
    const snap = runtime.getSnapshot();
    expect(placeholderId(snap)).toBeUndefined(); // both placeholders swapped for real events
    runtime.dispose();
  });

  it('a STEP 1 drought survives an app restart: the promoteSource recipe rehydrates and BOTH signatures eventually land', async () => {
    const h = await enrolled(SPACE_TOKENS_ON);
    const source = sourceMessage(Kind.LiveChat, CHANNEL_ID);
    // Neither wallet seeded — step 1 itself (the feed post's own blind signature) exhausts.
    await expect(h.runtime.promoteChannelPost(source, 'promoted content')).rejects.toThrow();
    await flush();
    expect(h.published).toHaveLength(0); // nothing published at all, not even the feed post

    // "Restart": the instance that queued the post is gone — nothing in its JS heap (including
    // pendingPosts) survives. Only what it persisted to SecureStorage does — which must include the
    // `promoteSource` recipe, or step 2 would come back after restart with no way to chain.
    h.runtime.dispose();
    const {runtime: rt2, published: published2} = newRuntimeOn(h.secure, SPACE_TOKENS_ON);
    await rt2.init(); // loadPendingCompose → coercePendingWrite rehydrates the 'post' intent + promoteSource
    expect(await rt2.submitPin('1234')).toBe('unlocked');
    await rt2.onRelayConnected();
    await flush();

    // Supply BOTH wallets and drain the rehydrated queue.
    await seedWallet(h.secure);
    await seedSpaceWallet(h.secure);
    await rt2.refreshFeed();
    // Extra flush round — step 2 chains off a NESTED signPendingWrite call one hop deeper than a plain
    // recovered post, and refreshFeed's drainPendingPosts is fire-and-forget (`void`).
    await flush();
    await flush();

    const feedPost = published2.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined();
    expect(feedPost!.content).toContain('promoted content');
    const edits = published2.filter(e => e.kind === Kind.LiveChat);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.tags).toContainEqual(['e', source.id, '', 'edit']);
    expect(edits[0]!.tags).toContainEqual(['promoted', feedPost!.id]);
    rt2.dispose();
  });

  // A restart-across-two-runtime-instances variant (like the CHANNEL test above) would additionally
  // need the private group's relay-synced metadata (39000-39003) to survive the "restart" — that's
  // group-membership persistence infrastructure orthogonal to this fix, so this test stays on ONE
  // runtime instance (mirrors AppRuntime.e2e.test.ts's own private-group promote coverage) and focuses
  // on what IS this fix's job: step 1's OWN drought must not lose the promotion, and the eventual drain
  // must still re-seal step 2 under the space key.
  it('promotes a post from a PRIVATE group through a step-1 drought: the feed post lands, and the edit re-seals AND carries the promoted tag', async () => {
    const {runtime, secure, published} = await enrolled(SPACE_TOKENS_ON);
    await seedSpaceWallet(secure); // the group's own initial message + its later promote-edit both spend space-write tokens
    const gid = (await runtime.createGroup({name: 'Inner', private: true, broadcast: true}))!;
    published.length = 0; // drop createGroup's own publish(es) — not under test

    await runtime.postToGroup(gid, 'internal announcement');
    const source = runtime.getGroupMessages(gid).find(m => m.tags.some(t => t[0] === 'encrypted'))!;
    expect(source).toBeDefined();
    published.length = 0; // isolate the promote flow that follows

    // No post wallet seeded ⇒ step 1 (the feed post) droughts before the edit is ever reached.
    await expect(runtime.promoteChannelPost(source, 'internal announcement')).rejects.toThrow();
    await flush();
    expect(published).toHaveLength(0); // nothing published — not the feed post, not the edit
    const snap = runtime.getSnapshot();
    const id = placeholderId(snap);
    expect(id).toBeDefined();
    expect(snap.sendStatus.get(id!)).toBe('failed');

    // Supply the post wallet the drought was missing (the space wallet still has its leftover balance
    // from the seed above — one token already spent on the group's initial message).
    await seedWallet(secure);
    await runtime.refreshFeed();
    await flush();
    await flush(); // second round — chained step 2 is one async hop deeper (see the CHANNEL test above)

    const feedPost = published.find(e => e.kind === Kind.Post);
    expect(feedPost).toBeDefined();
    expect(feedPost!.content).toContain('internal announcement'); // public by author choice
    const edit = published.find(e => e.kind === GroupKind.Chat && e.tags.some(t => t[0] === 'promoted'));
    expect(edit).toBeDefined();
    expect(edit!.tags).toContainEqual(['promoted', feedPost!.id]);
    expect(edit!.content).not.toContain('internal announcement'); // re-sealed, not a plaintext edit
    expect(edit!.tags).toContainEqual(['encrypted', 'nip44']);
    runtime.dispose();
  });
});
