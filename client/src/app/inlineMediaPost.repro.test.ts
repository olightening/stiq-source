/**
 * REPRO: "posting a tweet-like note with an inline picture or audio fails" (facts doc
 * INLINE_MEDIA_POST_FAILURE.md). This drives the REAL post() path — withMyName → publishPost →
 * feedSigner.sign (BlindSigner, community key loaded) → publishOptimistic → deliver — with the exact
 * content the composer hands over (a body carrying an inline `[[pic:…]]` / `[[voice:…]]` base64
 * token). Everything except the WebView editor runs here, so a logic-level failure would surface.
 *
 * ⚠️ THIS FILE IS ALSO THE ONLY PUBLISH TEST THAT READS THE COMMITTED LAZY_MEDIA_BLOBS. It mocks
 * TIMING_JITTER and nothing else, so `post()` here does what a real build does. That is now
 * load-bearing in a second way: LAZY_MEDIA_BLOBS was flipped ON on 2026-07-15, and every other blob
 * publish suite states the flag it wants (mediaBlobPublish.test.ts mocks it ON,
 * mediaBlobPublish.off.test.ts mocks it OFF). Without the assertions below, the shipped ON write path
 * would be proven only by suites that assert their own mock back to themselves. So these tests pin
 * the split end-to-end at REALISTIC sizes (60KB picture / 260KB voice, not the toy 2×2 the unit
 * suites use) against the config that actually ships.
 *
 * WHAT THE REPRO STILL GUARDS, unchanged: the composer hands over a body with the full base64 riding
 * inline — that has not changed and cannot, the editor knows nothing about blobs — and that body must
 * post: blind, optimistically rendered, confirmed. The ORIGINAL bug was that the payload was LOST in
 * transit (mediaRefs' WebView-bridge shim). So "the bytes still exist somewhere the reader can get
 * them" is the invariant, and the split moved WHERE that is: out of the note, into a blob event. The
 * assertions follow the bytes rather than pinning the wire shape they used to have.
 */
// TIMING_JITTER (T15) ships default-ON but delays only the background wire send; these delivery-timing
// assertions run against a synchronous flush(), so disable the jitter here (jest.mock hoists above the
// imports). Every other config value keeps its real value via requireActual — LAZY_MEDIA_BLOBS very
// much included; see the note above.
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
import {KIND_MEDIA_BLOB} from '../contracts';
import {readMediaBlobPayload} from '../feed/mediaBlob';
import {LAZY_MEDIA_BLOBS} from '../config';
import type {Community} from '../onboarding/community';
import {type Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ORG_PUB_A = 'a'.repeat(64);
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0));

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

/** base64 payload of ~`kb` KiB (valid alphabet, so extractInline* accepts it). */
function b64OfKiB(kb: number): string {
  return 'A'.repeat(kb * 1024);
}

function newRuntime() {
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
  });
  return {runtime, secure, published};
}

async function seedWallet(secure: InMemorySecureStorage, n = 5): Promise<void> {
  // The wallet is namespaced by the ACTIVE identity slot (per-account silo); this runs right after
  // enrollment, so the active slot is the one the runtime spends from.
  const ring = new KeyRing(secure);
  const slotId = (await ring.getActiveSlotId()) ?? communityId(RELAY_A);
  // Stamp the issuer-key fingerprint the runtime's key-siloed wallet expects (matches a real draw).
  const wallet = new EpochWallet(secure, slotId, walletKeyFingerprint('aXNz'));
  // Real holder-bound keypairs (P3): these tokens are spent + posted blind by the runtime.
  await wallet.add(
    0,
    Array.from({length: n}, () => {
      const {q, Q} = newTokenKeypair();
      return {token: Q, sig: new Uint8Array(32), secret: q};
    }),
  );
}

async function enrolledBlindRuntime() {
  const ctx = newRuntime();
  await ctx.runtime.init();
  await ctx.runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_PUB_A)), '1234', '9999');
  await ctx.runtime.submitPin('1234');
  await seedWallet(ctx.secure);
  ctx.published.length = 0;
  return ctx;
}

const isBlind = (e: Event): boolean => e.tags.some(t => t[0] === 'stiq_token' && !!t[1]);

/** Every kind-30351 blob the runtime actually put on the wire for this post. */
const blobsIn = (published: Event[]): Event[] => published.filter(e => e.kind === KIND_MEDIA_BLOB);

describe('REPRO: inline-media note posting', () => {
  it('is running against the committed LAZY_MEDIA_BLOBS, which is ON', () => {
    // The tripwire for THIS file. Everything below asserts the split; if the flag is ever rolled
    // back, they must be re-pointed at the inline wire shape deliberately (the payload assertions
    // would fail anyway, but by then this line has already named the reason). This file mocks only
    // TIMING_JITTER on purpose — see the header. Do not "fix" a failure here by mocking the flag:
    // that would delete the last committed-config proof that pictures split at publish.
    expect(LAZY_MEDIA_BLOBS).toBe(true);
  });

  it('posts a PICTURE-only note blind, splits the payload into a blob, renders it, and delivers', async () => {
    const {runtime, published} = await enrolledBlindRuntime();
    const payload = b64OfKiB(60);
    const picToken = `[[pic:16;4;${payload}]]`;

    await runtime.post(picToken); // exactly what the composer's onSubmit passes — still fully inline
    await flush();

    const post = published.find(e => e.kind === 1);
    expect(post).toBeDefined();
    expect(isBlind(post!)).toBe(true);
    expect(post!.content).toContain('[[pic:16;4;'); // token survived intact (chip renders with no fetch)

    // The 60KB left the note...
    expect(post!.content).not.toContain(payload);
    expect(post!.content.length).toBeLessThan(1024);
    expect(post!.content).toContain('STIQBLOB');
    // ...and landed in a blob, byte-for-byte. This is the repro's real invariant — the original bug
    // was the payload being LOST, and "it is not in the note" only counts if it is somewhere else.
    const blobs = blobsIn(published);
    expect(blobs).toHaveLength(1);
    expect(readMediaBlobPayload(blobs[0]!)).toBe(payload);
    expect(post!.content).toContain(`STIQBLOB${blobs[0]!.id}`); // the note points at THAT blob

    const snap = runtime.getSnapshot();
    const item = snap.feed.items.find(i => i.id === post!.id);
    expect(item).toBeDefined();                       // rendered optimistically
    // Confirmation is OK-driven (AppRuntime.deliver()) — no live-feed echo required.
    expect(snap.sendStatus.get(post!.id)).toBe('confirmed'); // delivered, not "failed"
    runtime.dispose();
  });

  it('posts a VOICE-only note (~270KB composed) blind, splits it into a blob, renders it, and delivers', async () => {
    const {runtime, published} = await enrolledBlindRuntime();
    const payload = b64OfKiB(260);
    const voiceToken = `[[voice:audio/mp4;30;${payload}]]`;

    await runtime.post(voiceToken);
    await flush();

    const post = published.find(e => e.kind === 1);
    expect(post).toBeDefined();
    expect(isBlind(post!)).toBe(true);
    expect(post!.content).toContain('[[voice:audio/mp4;30;'); // duration survives → idle player is real

    // The heaviest payload in the app does not ride the feed REQ. Asserted explicitly because the
    // prefix check above passes whether or not the split happened — it did not notice the bytes move
    // when the flag flipped, and a test that cannot tell those apart is not testing the transport.
    expect(post!.content).not.toContain(payload);
    expect(post!.content.length).toBeLessThan(1024);
    const blobs = blobsIn(published);
    expect(blobs).toHaveLength(1);
    expect(readMediaBlobPayload(blobs[0]!)).toBe(payload);
    expect(post!.content).toContain(`STIQBLOB${blobs[0]!.id}`);

    const snap = runtime.getSnapshot();
    expect(snap.feed.items.find(i => i.id === post!.id)).toBeDefined();
    expect(snap.feed.log.find(l => l.item.id === post!.id)).toBeUndefined(); // NOT auto-hidden to the log
    // Confirmation is OK-driven (AppRuntime.deliver()) — no live-feed echo required.
    expect(snap.sendStatus.get(post!.id)).toBe('confirmed'); // delivered, not "failed"
    runtime.dispose();
  });

  it('posts a MIXED prose+picture note blind, keeps the prose in the note, and renders it', async () => {
    const {runtime, published} = await enrolledBlindRuntime();
    const payload = b64OfKiB(50);
    const body = `check out my pixel art ${`[[pic:16;4;${payload}]]`} nice right?`;

    await runtime.post(body, ['art']);
    await flush();

    const post = published.find(e => e.kind === 1);
    expect(post).toBeDefined();
    expect(isBlind(post!)).toBe(true);
    // The split rewrites ONLY the media token: prose either side of it is untouched.
    expect(post!.content.startsWith('check out my pixel art ')).toBe(true);
    expect(post!.content.endsWith(' nice right?')).toBe(true);
    expect(post!.content).not.toContain(payload);
    expect(readMediaBlobPayload(blobsIn(published)[0]!)).toBe(payload);

    const snap = runtime.getSnapshot();
    expect(snap.feed.items.find(i => i.id === post!.id)).toBeDefined();
    // Confirmation is OK-driven (AppRuntime.deliver()) — no live-feed echo required.
    expect(snap.sendStatus.get(post!.id)).toBe('confirmed'); // delivered, not "failed"
    runtime.dispose();
  });
});
