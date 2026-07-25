/**
 * CHANNEL broadcasts on the lazy-media-blob transport, with LAZY_MEDIA_BLOBS forced ON.
 *
 * Channels were the surface the split originally missed. `postToChannel` signed directly through
 * `broadcastToChannel` and never touched the PendingWrite path, so a channel that allows pictures and
 * voice kept shipping ≤48KB + ≤267KB of base64 inline — to every member, from every channel, on the
 * feed REQ — which is the exact bug the split exists to fix, surviving on one surface.
 *
 * What makes this suite worth more than "the post tests, again with a channel":
 *
 *  1. **A broadcast is signed by the BOUND NPUB, on purpose.** The relay's GroupGuard authorises a
 *     1311 by its author's role, and `blindContentKinds` excludes 1311 precisely so a token can't
 *     launder a broadcast past that check. So the blind signer's free "fresh throwaway key per event"
 *     property — the thing that stops two addressable, tagless kind-30351 blobs from silently
 *     replacing each other — does NOT come from the broadcast's own signature. It comes from the fact
 *     that a blob is a SEPARATE event with its own signer. These tests pin BOTH halves at once: the
 *     blobs must have distinct throwaway keys AND the 1311 must still be signed by the real npub. A
 *     change that "fixed" one by breaking the other would pass a suite that only checked one.
 *  2. **A broadcast used to be instant** (a local schnorr sign, no network). Minting draws tokens over
 *     Tor, so the placeholder is what stops the message from simply being absent from the channel for
 *     seconds after the send — the draft is already cleared by then.
 *  3. **Recovery has a silent-corruption trap**: coercePendingWrite's fallthrough builds a POST from
 *     any unrecognised intent, so a mis-typed channel intent would come back from a restart as a
 *     kind-1 note in the public feed.
 *
 * The companion suite `mediaBlobPublish.channel.off.test.ts` pins that all of this is inert, and that
 * postToChannel is byte-identical to before, with the flag off.
 */
// TIMING_JITTER (T15) delays only the background wire send; these delivery-order assertions run
// against a synchronous publish, so disable it (jest.mock hoists above the imports). LAZY_MEDIA_BLOBS
// is the subject of this file. Every other config value keeps its real value via requireActual.
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  TIMING_JITTER: false,
  LAZY_MEDIA_BLOBS: true,
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
import {parseBlobTail} from '../feed/mediaBlob';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const ORG_A = 'a'.repeat(64);
const ISSUER_FP = walletKeyFingerprint('aXNz');

/** A blind-provisioned (v3) community — a community key is what makes the runtime blind-sign. */
const v3 = (relayUrl: string, ck: string, org: string): Community => ({
  relayUrl,
  issuerPublicKey: 'aXNz',
  organizerPubkey: org,
  communityKey: ck,
});

/** A community with NO shared key — the runtime falls back to plain npub signing there. */
const noCk = (relayUrl: string, org: string): Community => ({
  relayUrl,
  issuerPublicKey: 'aXNz',
  organizerPubkey: org,
});

async function makeSession(community: Community): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) throw new Error('enrollment failed in setup');
  return result.session;
}

/** A real, valid inline picture token (2x2, 2 colours) — the thing that must become a blob. */
function picToken(label?: string): string {
  return encodeInlinePicture(
    {res: 2, colours: 2, palette: [[0, 0, 0], [255, 255, 255]], indices: new Uint8Array([0, 1, 1, 0])},
    'none',
    label,
  );
}

interface PublishOutcome {
  accepted: boolean;
  message: string;
  offline?: boolean;
}

function newRuntime() {
  const secure = new InMemorySecureStorage();
  const published: Event[] = [];
  let verdict: (e: Event) => PublishOutcome = () => ({accepted: true, message: 'ok'});
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: secure,
    store,
    createStore: async (): Promise<EventStore> => new InMemoryEventStore(),
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async (e: Event) => {
      published.push(e);
      return verdict(e);
    },
  });
  return {
    runtime,
    secure,
    store,
    published,
    setVerdict: (v: (e: Event) => PublishOutcome) => {
      verdict = v;
    },
  };
}

async function slotIdFor(secure: InMemorySecureStorage, relayUrl: string): Promise<string> {
  const ring = new KeyRing(secure);
  const active = await ring.getActiveSlotId();
  if (active) return active;
  const cid = communityId(relayUrl);
  return (await ring.listSlots()).find(s => communityId(s.relayUrl) === cid)?.id ?? cid;
}

/** Seed the ACTIVE account's blind-token wallet. Each blob spends one. */
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

/** Drain the fire-and-forget promise chains the publish path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Enroll into a blind community, unlock, and open a channel to broadcast into. */
async function enrolledWithChannel(ctx: ReturnType<typeof newRuntime>, community: Community = v3(RELAY_A, CK_A, ORG_A)) {
  await ctx.runtime.init();
  await ctx.runtime.completeEnrollment(await makeSession(community), '1234', '9999');
  expect(await ctx.runtime.submitPin('1234')).toBe('unlocked');
  await seedWallet(ctx.secure, community.relayUrl);
  const channelId = await ctx.runtime.createChannel({name: 'Dispatch'});
  expect(channelId).toBeTruthy();
  await flush();
  ctx.published.length = 0; // drop the 30311 definition — every assertion below is about broadcasts
  return {...ctx, channelId: channelId!};
}

const blobs = (evts: Event[]): Event[] => evts.filter(e => e.kind === KIND_MEDIA_BLOB);
const casts = (evts: Event[]): Event[] => evts.filter(e => e.kind === Kind.LiveChat);

describe('channel broadcasts split their media — every blob gets its OWN throwaway key', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a TWO-picture broadcast yields two blobs with DISTINCT pubkeys', async () => {
    // THE test, and the one the bound-npub signing of a 1311 makes worth re-asserting here rather
    // than inheriting from the post suite: if channel blobs were signed by whatever signs the
    // broadcast, both would carry the author's single real npub, occupy the same addressable
    // (30351, pubkey, d='') slot, and the second would silently delete the first — a two-picture
    // broadcast losing a picture with no error raised anywhere.
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `one ${picToken('cat')} two ${picToken('dog')}`);
    await flush();

    const sent = blobs(ctx.published);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.pubkey).not.toBe(sent[1]!.pubkey);
    expect(new Set(sent.map(b => b.pubkey)).size).toBe(2);
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
    ctx.runtime.dispose();
  });

  it('holds across many pictures in one broadcast — no key is ever reused', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, [0, 1, 2, 3].map(i => picToken(`p${i}`)).join(' '));
    await flush();

    const sent = blobs(ctx.published);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map(b => b.pubkey)).size).toBe(4);
    ctx.runtime.dispose();
  });

  it('the blobs are throwaway-signed while the BROADCAST keeps its bound npub', async () => {
    // Both halves of the coherence requirement in one assertion pair. The 1311 must stay attributable
    // — GroupGuard authorises it by the author's role, and handleBlindPost would reject a tokenized
    // 1311 outright ("not permitted on the blind-post token path"), so blind-signing the broadcast
    // would make it unpublishable rather than private. The blobs must NOT be, or they collide.
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `look ${picToken()}`);
    await flush();

    const mine = ctx.runtime.getSnapshot().currentUserPubkey;
    expect(mine).toBeTruthy(); // guard the guard: a null here would make both assertions vacuous
    expect(casts(ctx.published)[0]!.pubkey).toBe(mine); // the broadcast: still the real npub
    expect(blobs(ctx.published)[0]!.pubkey).not.toBe(mine); // its bytes: a throwaway
    ctx.runtime.dispose();
  });

  it('the broadcast REFERENCES the blob and carries none of its bytes', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `hello ${picToken('cat')}`);
    await flush();

    const blob = blobs(ctx.published)[0]!;
    const cast = casts(ctx.published)[0]!;
    const pics = extractInlinePictures(cast.content);
    expect(pics).toHaveLength(1);
    expect(pics[0]!.source).toEqual({kind: 'blob', blobId: blob.id});
    // The payload moved: it is the blob's content now, and nowhere in the broadcast.
    expect(cast.content).not.toContain(blob.content);
    expect(blob.content.length).toBeGreaterThan(0);
    ctx.runtime.dispose();
  });

  it('the broadcast still addresses its own channel, and the blob names no channel at all', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `x ${picToken()}`);
    await flush();

    const cast = casts(ctx.published)[0]!;
    expect(cast.tags.some(t => t[0] === 'a' && t[1] === ctx.channelId)).toBe(true);
    // The blob carries no back-reference: the relay cannot walk blob → channel, and a blob that named
    // its channel would also hand GroupGuard a kind it does not gate.
    const blob = blobs(ctx.published)[0]!;
    expect(blob.tags.every(t => t[1] !== ctx.channelId)).toBe(true);
    expect(blob.tags.some(t => t[0] === 'a' || t[0] === 'e')).toBe(false);
    ctx.runtime.dispose();
  });

  it('keeps a broadcast INLINE when the community is not blind (no throwaway keys to mint)', async () => {
    // Without a community key the signer falls back to the real npub — every blob would share it and
    // they would delete each other. Staying inline is the only fallback that cannot lose a picture,
    // and the read path renders an inline token exactly as it always has.
    const ctx = newRuntime();
    await ctx.runtime.init();
    await ctx.runtime.completeEnrollment(await makeSession(noCk(RELAY_A, ORG_A)), '1234', '9999');
    expect(await ctx.runtime.submitPin('1234')).toBe('unlocked');
    const channelId = (await ctx.runtime.createChannel({name: 'Plain'}))!;
    await flush();
    ctx.published.length = 0;

    await ctx.runtime.postToChannel(channelId, `plain ${picToken()}`);
    await flush();

    expect(blobs(ctx.published)).toHaveLength(0);
    expect(extractInlinePictures(casts(ctx.published)[0]!.content)[0]!.source.kind).toBe('inline');
    ctx.runtime.dispose();
  });

  it('leaves a text-only broadcast completely alone', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, 'just words');
    await flush();

    expect(blobs(ctx.published)).toHaveLength(0);
    expect(casts(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });
});

describe('channel broadcasts split their media — the sender never waits', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('renders the placeholder BEFORE any blob is signed, so the message is never missing', async () => {
    // A broadcast used to be an instant local sign. Minting puts a Tor token draw in front of it, and
    // ChannelView clears the draft synchronously without awaiting this promise — so with no
    // placeholder the message would be absent from the channel for the whole draw and read as lost.
    const ctx = await enrolledWithChannel(newRuntime());
    const pending = ctx.runtime.postToChannel(ctx.channelId, `x ${picToken()}`);

    const placeholder = [...ctx.runtime.getSnapshot().sendStatus.keys()].find(id => id.startsWith('local-'));
    expect(placeholder).toBeDefined();
    expect(ctx.published).toHaveLength(0); // nothing has reached the wire yet

    await pending;
    await flush();
    expect(blobs(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });

  it('the placeholder is a real broadcast in its own channel, showing the picture immediately', async () => {
    // It renders from the INLINE body (the bytes are already in hand), which is what makes the
    // author's own picture appear instantly, and it carries the channel's `a` tag so it appears in
    // that channel and nowhere else.
    const ctx = await enrolledWithChannel(newRuntime());
    const pending = ctx.runtime.postToChannel(ctx.channelId, `mine ${picToken()}`);

    const shown = ctx.runtime.getChannelMessages(ctx.channelId);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.id.startsWith('local-')).toBe(true);
    expect(extractInlinePictures(shown[0]!.content)[0]!.source.kind).toBe('inline');

    await pending;
    await flush();
    ctx.runtime.dispose();
  });

  it('the placeholder is swapped for the real broadcast — never left behind as a duplicate', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `swap ${picToken()}`);
    await flush();

    const shown = ctx.runtime.getChannelMessages(ctx.channelId);
    expect(shown).toHaveLength(1); // one message, not a placeholder AND a real one
    expect(shown[0]!.id.startsWith('local-')).toBe(false);
    expect(shown[0]!.sig).not.toBe('');
    ctx.runtime.dispose();
  });

  it("saves each blob to the LOCAL store, so the author's own picture needs no fetch", async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `mine ${picToken()}`);
    await flush();

    const blob = blobs(ctx.published)[0]!;
    expect(ctx.store.getById(blob.id)?.content).toBe(blob.content);
    ctx.runtime.dispose();
  });
});

describe('channel broadcasts split their media — delivery is ordered blob → broadcast', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends every blob to the relay BEFORE the broadcast that references it', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `a ${picToken('1')} b ${picToken('2')}`);
    await flush();

    expect(ctx.published.map(e => e.kind)).toEqual([KIND_MEDIA_BLOB, KIND_MEDIA_BLOB, Kind.LiveChat]);
    const ids = blobs(ctx.published).map(b => b.id);
    const refs = extractInlinePictures(casts(ctx.published)[0]!.content).map(p =>
      p.source.kind === 'blob' ? p.source.blobId : null,
    );
    expect(refs).toEqual(ids);
    ctx.runtime.dispose();
  });

  it('a blob stuck OFFLINE holds the broadcast back entirely — it is never sent', async () => {
    // No member can meet a broadcast whose picture exists nowhere. That outcome is unfixable after
    // the fact, so it is designed out rather than compensated for.
    const ctx = newRuntime();
    const c = await enrolledWithChannel(ctx);
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB
        ? {accepted: false, message: 'relay not connected', offline: true}
        : {accepted: true, message: 'ok'},
    );

    await c.runtime.postToChannel(c.channelId, `stuck ${picToken()}`);
    await flush();

    expect(blobs(ctx.published).length).toBeGreaterThanOrEqual(1);
    expect(casts(ctx.published)).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('the broadcast goes out the moment its blob finally lands', async () => {
    const ctx = newRuntime();
    const c = await enrolledWithChannel(ctx);
    let blobOffline = true;
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB && blobOffline
        ? {accepted: false, message: 'relay not connected', offline: true}
        : {accepted: true, message: 'ok'},
    );

    await c.runtime.postToChannel(c.channelId, `later ${picToken()}`);
    await flush();
    expect(casts(ctx.published)).toHaveLength(0);

    blobOffline = false;
    await c.runtime.onRelayConnected();
    await flush();

    expect(casts(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });

  it('a REJECTED blob fails its broadcast loudly, carrying the relay’s reason', async () => {
    // A blob has no card of its own — it is an implementation detail of the message that shows it —
    // so its rejection has to surface on the BroadcastCard, which the sender can see and retry.
    const ctx = newRuntime();
    const c = await enrolledWithChannel(ctx);
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB
        ? {accepted: false, message: 'blocked: event kind 30351 not permitted'}
        : {accepted: true, message: 'ok'},
    );

    await c.runtime.postToChannel(c.channelId, `doomed ${picToken()}`);
    await flush();

    // Keyed to the BROADCAST's own id: the blob is in sendStatus too and is itself 'rejected', so a
    // search by value would find the blob and pass while the broadcast's status went untouched.
    const stored = ctx.store.query({kinds: [Kind.LiveChat]}).filter(e => e.sig !== '');
    expect(stored).toHaveLength(1);
    const snap = c.runtime.getSnapshot();
    expect(snap.sendStatus.get(stored[0]!.id)).toBe('rejected');
    expect(snap.sendReasons.get(stored[0]!.id)).toContain('30351 not permitted');
    expect(casts(ctx.published)).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('Retry on a rejected picture broadcast re-drives the BLOB first, then the broadcast', async () => {
    const ctx = newRuntime();
    const c = await enrolledWithChannel(ctx);
    let blobRejected = true;
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB && blobRejected
        ? {accepted: false, message: 'blocked: try later'}
        : {accepted: true, message: 'ok'},
    );

    await c.runtime.postToChannel(c.channelId, `retry me ${picToken()}`);
    await flush();
    const castId = ctx.store.query({kinds: [Kind.LiveChat]}).filter(e => e.sig !== '')[0]!.id;
    expect(c.runtime.getSnapshot().sendStatus.get(castId)).toBe('rejected');

    blobRejected = false;
    ctx.published.length = 0;
    await c.runtime.retry(castId);
    await flush();

    expect(ctx.published.map(e => e.kind)).toEqual([KIND_MEDIA_BLOB, Kind.LiveChat]);
    ctx.runtime.dispose();
  });

  it('a text-only broadcast is never gated — it goes straight out', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, 'no media here');
    await flush();
    expect(casts(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });
});

describe('channel broadcasts split their media — durability and recovery', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('an empty wallet leaves the broadcast durable + retryable, never lost', async () => {
    // This suite's failure mode is the broadcast's MEDIA: minting blobs (mintMediaBlobs) draws from the
    // POST wallet independently of the broadcast's own bound-npub signature, and that draw can exhaust
    // on its own — which is why a broadcast queues on the PendingWrite path even with space_tokens_
    // required off (T0.2's suite covers the OTHER reason: once that flag is on, the broadcast's own
    // signature can ALSO exhaust the separate space wallet via spaceTokenTagsFor — see
    // AppRuntime.groups.test.ts / channel-edit equivalents). Either way the sender must see a failed
    // message with a Retry, not a message that silently evaporated (F2).
    const ctx = await enrolledWithChannel(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 0) await wallet.spendMany(1);

    await expect(ctx.runtime.postToChannel(ctx.channelId, `dry ${picToken()}`)).rejects.toThrow();
    await flush();

    expect(ctx.published).toHaveLength(0); // nothing half-published
    const snap = ctx.runtime.getSnapshot();
    const placeholder = [...snap.sendStatus.keys()].find(id => id.startsWith('local-'));
    expect(placeholder).toBeDefined();
    expect(snap.sendStatus.get(placeholder!)).toBe('failed');
    // And it is still visible in its channel, so the Retry has something to hang off.
    expect(ctx.runtime.getChannelMessages(ctx.channelId)).toHaveLength(1);
    ctx.runtime.dispose();
  });

  it('the queued broadcast drains once tokens arrive, blob first', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 0) await wallet.spendMany(1);
    await expect(ctx.runtime.postToChannel(ctx.channelId, `soon ${picToken()}`)).rejects.toThrow();
    await flush();

    await seedWallet(ctx.secure, RELAY_A, 4);
    await ctx.runtime.refreshFeed(); // drainPendingPosts runs from here
    await flush();

    expect(ctx.published.map(e => e.kind)).toEqual([KIND_MEDIA_BLOB, Kind.LiveChat]);
    expect(casts(ctx.published)).toHaveLength(1); // exactly one broadcast, not two
    ctx.runtime.dispose();
  });

  it('a recovered broadcast comes back as a BROADCAST, never as a feed post', async () => {
    // coercePendingWrite's fallthrough builds a kind-1 note from any intent it doesn't recognise, so a
    // channel intent without its own branch would survive a restart by publishing the message into the
    // PUBLIC FEED: right body, right author, wrong surface, no error anywhere. This is that branch.
    const ctx = await enrolledWithChannel(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 0) await wallet.spendMany(1);
    await expect(ctx.runtime.postToChannel(ctx.channelId, `restart me ${picToken()}`)).rejects.toThrow();
    await flush();
    ctx.runtime.dispose();

    // Cold launch on the SAME secure storage — a new process, nothing carried over in memory.
    const afterKill: Event[] = [];
    const revived = new AppRuntime({
      secureStorage: ctx.secure,
      store: new SwappableEventStore(new InMemoryEventStore()),
      createStore: async () => new InMemoryEventStore(),
      hash: identityHash,
      autoLockMs: 60_000,
      publish: async (e: Event) => {
        afterKill.push(e);
        return {accepted: true, message: 'ok'};
      },
    });
    await revived.init();
    expect(await revived.submitPin('1234')).toBe('unlocked');
    await seedWallet(ctx.secure, RELAY_A, 4);
    await revived.onRelayConnected();
    await flush();

    // It went back to its channel, addressed to it — and NOT into the feed.
    const recovered = afterKill.filter(e => e.kind === Kind.LiveChat);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.tags.some(t => t[0] === 'a' && t[1] === ctx.channelId)).toBe(true);
    expect(afterKill.filter(e => e.kind === 1)).toHaveLength(0); // never a note
    revived.dispose();
  });

  it('a recovered broadcast does NOT re-mint its blobs', async () => {
    // The intent persists the already-rewritten body + its blob ids, so a retry re-signs only the
    // 1311: no second blob, no orphan on the relay, no tokens burned twice.
    const ctx = await enrolledWithChannel(newRuntime());
    // One token: enough for the blob, nothing left... the broadcast itself needs none, so instead
    // stall delivery to force the recovery path with the blob already minted.
    ctx.setVerdict(() => ({accepted: false, message: 'relay not connected', offline: true}));
    await ctx.runtime.postToChannel(ctx.channelId, `once ${picToken()}`);
    await flush();
    expect(blobs(ctx.published)).toHaveLength(1);

    ctx.setVerdict(() => ({accepted: true, message: 'ok'}));
    ctx.published.length = 0;
    await ctx.runtime.onRelayConnected();
    await flush();

    expect(blobs(ctx.published)).toHaveLength(1); // the same blob re-sent, not a newly minted second
    expect(casts(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });

  it('refuses to publish a broadcast whose blob has vanished, rather than shipping a dead reference', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    const wipe = jest.spyOn(ctx.store, 'getById').mockImplementation(() => undefined);

    await expect(ctx.runtime.postToChannel(ctx.channelId, `vanished ${picToken()}`)).rejects.toThrow(/missing/);
    await flush();

    expect(casts(ctx.published)).toHaveLength(0);
    expect(blobs(ctx.published)).toHaveLength(0);
    wipe.mockRestore();
    ctx.runtime.dispose();
  });
});

describe('channel broadcasts split their media — accounting and grammar', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('the picture allowance still meters the REAL bytes after the split', async () => {
    // postToChannel has always metered its pictures (accountPictures). The payload has now left the
    // body, so only `w=` carries its size forward — without it the organizer's per-period allowance
    // would meter a 72-char pointer and every picture cap would fail open, silently.
    const ctx = await enrolledWithChannel(newRuntime());
    const inlineBytes = extractInlinePictures(picToken('cat'))[0]!.weightBytes;

    await ctx.runtime.postToChannel(ctx.channelId, `meter ${picToken('cat')}`);
    await flush();

    const cast = casts(ctx.published)[0]!;
    expect(extractInlinePictures(cast.content)[0]!.weightBytes).toBe(inlineBytes);

    // Guard the guard: the assertion above is only worth anything if metering the POINTER instead of
    // the payload would give a different answer. A blob tail is a fixed 72 chars ('STIQBLOB' + 64 hex)
    // and this fixture's payload is not, so a collapse to tail length is genuinely detectable here.
    const tail = /\[\[pic:[^\]]*;([A-Za-z0-9+/=]+)\]\]/.exec(cast.content)![1]!;
    expect(parseBlobTail(tail)).not.toBeNull(); // it really did split — otherwise this proves nothing
    expect(tail.length).not.toBe(inlineBytes);
    ctx.runtime.dispose();
  });

  it('spends one token per blob, and none for the broadcast itself', async () => {
    // The real cost of the mix: a broadcast's pictures now spend blind tokens where inline ones spent
    // none. The 1311 keeps spending nothing — it is bound-npub signed and must stay that way.
    const ctx = await enrolledWithChannel(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    const before = await wallet.count();

    await ctx.runtime.postToChannel(ctx.channelId, `cost ${picToken()}`);
    await flush();

    expect(await wallet.count()).toBe(before - 1); // one blob, weight-pricing off; the 1311 is free
    ctx.runtime.dispose();
  });

  it('each token tail is a blob reference naming a blob that was really published', async () => {
    const ctx = await enrolledWithChannel(newRuntime());
    await ctx.runtime.postToChannel(ctx.channelId, `${picToken('a')} and ${picToken('b')}`);
    await flush();

    const sentIds = new Set(blobs(ctx.published).map(b => b.id));
    const tails = [...casts(ctx.published)[0]!.content.matchAll(/\[\[pic:[^\]]*;([A-Za-z0-9+/=]+)\]\]/g)].map(m => m[1]!);
    expect(tails).toHaveLength(2);
    for (const tail of tails) {
      const id = parseBlobTail(tail);
      expect(id).not.toBeNull();
      expect(sentIds.has(id!)).toBe(true); // a body can only ever reference a blob that exists
    }
    ctx.runtime.dispose();
  });
});
