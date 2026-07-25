/**
 * CHANNEL broadcasts with LAZY_MEDIA_BLOBS OFF — the SUPPORTED ROLLBACK, not the shipped state. This
 * was the committed default while the flag was dark, waiting on the relay to allow-list kind 30351 on
 * BOTH its gates; the relay was redeployed and verified on 2026-07-15 and the flag flipped ON, so
 * this file now mocks the value it used to inherit. The ON side is mediaBlobPublish.channel.test.ts.
 *
 * postToChannel's "second path" (for broadcasts whose media gets split out) is gone (T0.2, 2026-07-19):
 * EVERY broadcast — text-only, flag on or off — now goes through ONE durable pipeline (placeholder →
 * mint (no-op here) → sign → publish), because a bound-npub broadcast can ALSO spend a space-write
 * token once the relay requires one (F2 — a text-only broadcast used to have no placeholder to catch
 * that). So this file's contract is narrower than it used to be: with the flag off, `mintMediaBlobs`
 * is a no-op (nothing to split — LAZY_MEDIA_BLOBS gates the regex itself) and there is no
 * space_tokens_required enforcement configured in this harness, so the send still resolves on its
 * first attempt with no durable exhaustion detour — a placeholder renders and is swapped for the real
 * event in the SAME synchronous-to-first-await tick a broadcast always used to take, just via the
 * shared pipeline now rather than a bespoke fast path. What's still pinned here: no blob event, ever;
 * the body's base64 rides inline verbatim; no token is spent; nothing lingers in pendingPosts.
 *
 * Split into its own file rather than toggled inside one: `jest.mock('../config')` is module-level,
 * and resetModules + dynamic require desyncs module instances (see BUGROUND_STATE, Slot E).
 */
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
  LAZY_MEDIA_BLOBS: false,
}));

import {AppRuntime} from './AppRuntime';
import {InMemorySecureStorage} from '../keys/keystore';
import {KeyRing} from '../keys/keyRing';
import {InMemoryEventStore, SwappableEventStore, type EventStore} from '../nostr/store';
import {Enrollment, type Session} from '../onboarding/enrollment';
import {MockBlindRsa} from '../onboarding/blindrsa';
import {communityId} from '../communities/communityStore';
import {EpochWallet, walletKeyFingerprint} from '../blind/wallet';
import {newTokenKeypair} from '../blind/holderProof';
import {KIND_MEDIA_BLOB, Kind} from '../contracts';
import {encodeInlinePicture, extractInlinePictures} from '../feed/picture';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ORG_A = 'a'.repeat(64);
const ISSUER_FP = walletKeyFingerprint('aXNz');

const v3 = (relayUrl: string, ck: string, org: string): Community => ({
  relayUrl,
  issuerPublicKey: 'aXNz',
  organizerPubkey: org,
  communityKey: ck,
});

async function makeSession(community: Community): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

function picToken(label?: string): string {
  return encodeInlinePicture(
    {res: 2, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array([0, 1, 1, 0])},
    'none',
    label,
  );
}

function newRuntime() {
  const secure = new InMemorySecureStorage();
  const published: Event[] = [];
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: secure,
    store,
    createStore: async (): Promise<EventStore> => new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return {accepted: true, message: 'ok'};
    },
  });
  return {runtime, secure, store, published};
}

async function slotIdFor(secure: InMemorySecureStorage, relayUrl: string): Promise<string> {
  const ring = new KeyRing(secure);
  const active = await ring.getActiveSlotId();
  if (active) return active;
  const cid = communityId(relayUrl);
  return (await ring.listSlots()).find(s => communityId(s.relayUrl) === cid)?.id ?? cid;
}

async function seedWallet(secure: InMemorySecureStorage, relayUrl: string, n = 8): Promise<void> {
  const wallet = new EpochWallet(secure, await slotIdFor(secure, relayUrl), ISSUER_FP);
  await wallet.add(
    0,
    Array.from({length: n}, () => {
      const {q, Q} = newTokenKeypair();
      return {token: Q, sig: new Uint8Array(32), secret: q};
    }),
  );
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function enrolledWithChannel(ctx: ReturnType<typeof newRuntime>) {
  await ctx.runtime.init();
  await ctx.runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_A)), '1234', '9999');
  expect(await ctx.runtime.submitPin('1234')).toBe('unlocked');
  await seedWallet(ctx.secure, RELAY_A);
  const channelId = (await ctx.runtime.createChannel({name: 'Dispatch'}))!;
  await flush();
  ctx.published.length = 0;
  return {...ctx, channelId};
}

const casts = (evts: Event[]): Event[] => evts.filter(e => e.kind === Kind.LiveChat);

describe('LAZY_MEDIA_BLOBS off — postToChannel is byte-identical to before the split existed', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('publishes a picture broadcast as ONE inline 1311 — no blob event, ever', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `hello ${picToken('cat')}`);
    await flush();

    expect(ctx.published.filter(e => e.kind === KIND_MEDIA_BLOB)).toHaveLength(0);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]!.kind).toBe(Kind.LiveChat);
    ctx.runtime.dispose();
  });

  it('leaves the body verbatim — the base64 still rides inside the broadcast', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    const token = picToken('cat');
    await ctx.runtime.postToChannel(ctx.channelId, `hello ${token}`);
    await flush();

    const cast = ctx.published[0]!;
    expect(cast.content).toContain(token); // untouched, character for character
    expect(extractInlinePictures(cast.content)[0]!.source.kind).toBe('inline');
    ctx.runtime.dispose();
  });

  it('a MULTI-picture broadcast is still one event with both pictures inline', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `${picToken('a')} ${picToken('b')}`);
    await flush();

    expect(ctx.published).toHaveLength(1);
    expect(extractInlinePictures(ctx.published[0]!.content).every(p => p.source.kind === 'inline')).toBe(true);
    ctx.runtime.dispose();
  });

  it('a placeholder renders transiently (T0.2, uniform pipeline) then swaps for the real event — no lingering local-… id', async () => {
    // T0.2: postToChannel routes EVERY broadcast through the shared durable pipeline now, so a
    // placeholder renders synchronously (before the first await) exactly like a feed post's does —
    // this is no longer "strictly opt-in" to minting media (see the file header). What's still pinned:
    // the placeholder is TRANSIENT. With nothing to mint and no space-token enforcement configured
    // here, the sign settles on the very first attempt, so by the time the send resolves the
    // placeholder is gone — swapped for the real, non-`local-…` event — never left rendered or queued.
    const ctx = await enrolledWithChannel(newRuntime());
    const pending = ctx.runtime.postToChannel(ctx.channelId, `hi ${picToken()}`);

    // Rendered synchronously, before signPendingWrite's first await — same instant as a feed post's.
    expect([...ctx.runtime.getSnapshot().sendStatus.keys()].some(id => id.startsWith('local-'))).toBe(true);
    expect(ctx.runtime.getChannelMessages(ctx.channelId).some(m => m.id.startsWith('local-'))).toBe(true);

    await pending;
    await flush();
    // Swapped for the real event — nothing lingers 'sending'/'failed', and the shown message carries
    // its real (non-placeholder) id.
    expect([...ctx.runtime.getSnapshot().sendStatus.keys()].some(id => id.startsWith('local-'))).toBe(false);
    expect(ctx.store.query({kinds: [Kind.LiveChat]}).filter(e => e.sig === '')).toHaveLength(0);
    const shown = ctx.runtime.getChannelMessages(ctx.channelId);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.id.startsWith('local-')).toBe(false);
    ctx.runtime.dispose();
  });

  it('the broadcast keeps its bound npub and its channel tag', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `hi ${picToken()}`);
    await flush();

    const cast = ctx.published[0]!;
    expect(cast.pubkey).toBe(ctx.runtime.getSnapshot().currentUserPubkey);
    expect(cast.tags.some(t => t[0] === 'a' && t[1] === ctx.channelId)).toBe(true);
    ctx.runtime.dispose();
  });

  it('saves no blob into the local store', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `hello ${picToken()}`);
    await flush();
    expect(ctx.store.query({kinds: [KIND_MEDIA_BLOB]})).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('a picture broadcast spends NO tokens, exactly as it always did', async () => {
    // The bound-npub 1311 never spent one, and with no blobs to mint nothing else does either.
    const ctx = await enrolledWithChannel(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    const before = await wallet.count();

    await ctx.runtime.postToChannel(ctx.channelId, `cost ${picToken()}`);
    await flush();

    expect(await wallet.count()).toBe(before);
    ctx.runtime.dispose();
  });

  it('nothing is delivery-gated: the broadcast is sent on its first attempt', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `hi ${picToken()}`);
    await flush();

    expect(casts(ctx.published)).toHaveLength(1);
    const snap = ctx.runtime.getSnapshot();
    expect([...snap.sendStatus.values()].every(s => s !== 'rejected' && s !== 'failed')).toBe(true);
    ctx.runtime.dispose();
  });

  it('an empty wallet does not stop a picture broadcast — it never needed a token', async () => {
    // The durable/failed path exists only because MINTING can exhaust. With nothing to mint, a dry
    // wallet must be a non-event for a broadcast, exactly as before.
    const ctx = await enrolledWithChannel(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 0) await wallet.spendMany(1);

    await ctx.runtime.postToChannel(ctx.channelId, `dry ${picToken()}`); // resolves; does not throw
    await flush();

    expect(casts(ctx.published)).toHaveLength(1);
    expect((ctx.runtime as unknown as {pendingPosts: unknown[]}).pendingPosts).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('the recovery queue stays empty — a broadcast that never exhausts is never durably queued', async () => {
    // T0.2: the broadcast DOES run through the shared pending-write pipeline now (see the file
    // header) — but `pendingPosts` (the durable RECOVERY queue) only ever gains an entry on a
    // BlindTokensExhausted catch, and nothing here throws (no media to mint, no space-token
    // enforcement configured), so it stays empty exactly as before this pipeline was shared.
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `queued ${picToken()}`);
    await flush();

    expect((ctx.runtime as unknown as {pendingPosts: unknown[]}).pendingPosts).toHaveLength(0);
    ctx.runtime.dispose();
  });
});
