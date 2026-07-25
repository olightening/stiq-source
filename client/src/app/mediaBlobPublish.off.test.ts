/**
 * LAZY_MEDIA_BLOBS OFF — the SUPPORTED ROLLBACK. This was the committed default while the flag was
 * dark, waiting on the relay to allow-list kind 30351 on BOTH its gates; the relay was redeployed and
 * verified on 2026-07-15 and the flag flipped ON, so this file mocks the value it used to inherit
 * (the flag's committed value is now pinned in inlineMediaPost.repro.test.ts and feed/mediaBlob.test.ts,
 * neither of which mocks the config).
 *
 * OFF is not dead — it is the one-const revert if the split ever has to be backed out (a relay that
 * stops accepting 30351, a community on an npub-fallback signer, a bug in the fetch path), and a
 * rollback that half-works is worse than no rollback because it is only ever reached in an incident.
 * So its contract still has to hold exactly as written.
 *
 * The contract is not "mostly the same": it is BYTE-IDENTICAL to before the blob split existed. A
 * picture keeps riding inline in the body, no blob event is ever signed or published, no delivery is
 * gated on anything, and the recovery queue holds exactly the shape it always held. If any of that
 * drifts, a shipped build changes behaviour for a feature nobody has turned on.
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
import {KIND_MEDIA_BLOB} from '../contracts';
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

async function enrolled(ctx: ReturnType<typeof newRuntime>) {
  await ctx.runtime.init();
  await ctx.runtime.completeEnrollment(await makeSession(v3(RELAY_A, CK_A, ORG_A)), '1234', '9999');
  expect(await ctx.runtime.submitPin('1234')).toBe('unlocked');
  await seedWallet(ctx.secure, RELAY_A);
  ctx.published.length = 0;
  return ctx;
}

describe('LAZY_MEDIA_BLOBS off — the publish path is byte-identical to before blobs existed', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('publishes a picture post as ONE inline note — no blob event, ever', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`hello ${picToken('cat')}`);
    await flush();

    expect(ctx.published.filter(e => e.kind === KIND_MEDIA_BLOB)).toHaveLength(0);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]!.kind).toBe(1);
    ctx.runtime.dispose();
  });

  it('leaves the body verbatim — the base64 still rides inside the post', async () => {
    const ctx = await enrolled(newRuntime());
    const token = picToken('cat');
    await ctx.runtime.post(`hello ${token}`);
    await flush();

    const note = ctx.published[0]!;
    expect(note.content).toContain(token); // untouched, character for character
    const pics = extractInlinePictures(note.content);
    expect(pics).toHaveLength(1);
    expect(pics[0]!.source.kind).toBe('inline');
    ctx.runtime.dispose();
  });

  it('a MULTI-picture post is still one event with both pictures inline', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`${picToken('a')} ${picToken('b')}`);
    await flush();

    expect(ctx.published).toHaveLength(1);
    expect(extractInlinePictures(ctx.published[0]!.content).every(p => p.source.kind === 'inline')).toBe(true);
    ctx.runtime.dispose();
  });

  it('saves no blob into the local store', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`hello ${picToken()}`);
    await flush();
    expect(ctx.store.query({kinds: [KIND_MEDIA_BLOB]})).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('a picture post spends exactly ONE token, as it always did', async () => {
    const ctx = await enrolled(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    const before = await wallet.count();

    await ctx.runtime.post(`cost ${picToken()}`);
    await flush();

    expect(await wallet.count()).toBe(before - 1); // NOT two — no blob was signed
    ctx.runtime.dispose();
  });

  it('nothing is delivery-gated: the post is sent on its first attempt', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`hi ${picToken()}`);
    await flush();

    expect(ctx.published).toHaveLength(1);
    // The ring completes exactly as for a plain note — no dependency ever holds it back.
    const snap = ctx.runtime.getSnapshot();
    expect([...snap.sendStatus.values()].every(s => s !== 'rejected' && s !== 'failed')).toBe(true);
    ctx.runtime.dispose();
  });

  it('the recovery queue records no blob ids', async () => {
    const ctx = await enrolled(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 0) await wallet.spendMany(1);

    await expect(ctx.runtime.post(`queued ${picToken()}`)).rejects.toThrow();
    await flush();

    const queue = (ctx.runtime as unknown as {pendingPosts: Array<{blobIds?: string[]; content: string}>}).pendingPosts;
    expect(queue).toHaveLength(1);
    expect(queue[0]!.blobIds).toBeUndefined();
    expect(queue[0]!.content).toContain('[[pic:'); // still the inline body it was composed with
    ctx.runtime.dispose();
  });
});
