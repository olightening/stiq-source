/**
 * The PUBLISH half of lazy media blobs, with LAZY_MEDIA_BLOBS forced ON.
 *
 * Everything here is about the two things that can silently destroy a user's picture, both of which
 * are invisible to a passing typecheck:
 *
 *  1. **Key reuse.** Kind 30351 is in NIP-01's ADDRESSABLE range (30000-39999), so a relay keeps only
 *     the newest event per (kind, pubkey, d-tag) — and blobs are tagless, so `d` is ''. Two blobs
 *     under one key are ONE address: the second deletes the first and a two-picture post quietly
 *     loses a picture, with no error anywhere. The distinct-pubkey test below is the whole ballgame.
 *  2. **Half-fail on delivery.** A post that ships while its blob does not is a permanently broken
 *     picture for every reader, unfixable after the fact. So delivery is ORDERED: blob → landed →
 *     post. These tests drive the real outbox/deliver machinery, not a mock of it.
 *
 * The companion suite `mediaBlobPublish.off.test.ts` pins that all of this is inert with the flag off.
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
import {KIND_MEDIA_BLOB} from '../contracts';
import {encodeInlinePicture, extractInlinePictures} from '../feed/picture';
import {parseBlobTail} from '../feed/mediaBlob';
import type {Community} from '../onboarding/community';
import type {Event} from 'nostr-tools/pure';

const identityHash = async (d: Uint8Array) => d;
const RELAY_A = `ws://${'a'.repeat(56)}.onion`;
const RELAY_B = `ws://${'b'.repeat(56)}.onion`;
const CK_A = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
const CK_B = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
const ORG_A = 'a'.repeat(64);
const ORG_B = 'b'.repeat(64);
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

/**
 * A runtime wired to a controllable relay. `publish` records the exact WIRE ORDER of every delivery
 * attempt and answers from `verdict`, so a test can make one specific event fail and watch what the
 * rest of the pipeline does about it.
 */
function newRuntime() {
  const secure = new InMemorySecureStorage();
  const stores = new Map<string, EventStore>();
  const makeStore = async (cid: string | null): Promise<EventStore> => {
    const key = cid ?? '__none__';
    let s = stores.get(key);
    if (!s) {
      s = new InMemoryEventStore();
      stores.set(key, s);
    }
    return s;
  };
  const published: Event[] = [];
  let verdict: (e: Event) => PublishOutcome = () => ({accepted: true, message: 'ok'});
  const store = new SwappableEventStore(new InMemoryEventStore());
  const runtime = new AppRuntime({
    secureStorage: secure,
    store,
    createStore: makeStore,
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

/** Seed the ACTIVE account's blind-token wallet. A blob and a post each spend one. */
async function seedWallet(secure: InMemorySecureStorage, relayUrl: string, n = 8): Promise<void> {
  const wallet = new EpochWallet(secure, await slotIdFor(secure, relayUrl), ISSUER_FP);
  const tokens = Array.from({length: n}, () => {
    const {q, Q} = newTokenKeypair();
    return {token: Q, sig: new Uint8Array(32), secret: q};
  });
  await wallet.add(0, tokens);
}

/** Drain the fire-and-forget promise chains the publish path fans out into. */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** Enroll into a blind community and unlock, returning a ready-to-post runtime. */
async function enrolled(ctx: ReturnType<typeof newRuntime>, community: Community = v3(RELAY_A, CK_A, ORG_A)) {
  await ctx.runtime.init();
  await ctx.runtime.completeEnrollment(await makeSession(community), '1234', '9999');
  expect(await ctx.runtime.submitPin('1234')).toBe('unlocked');
  await seedWallet(ctx.secure, community.relayUrl);
  ctx.published.length = 0;
  return ctx;
}

const blobs = (evts: Event[]): Event[] => evts.filter(e => e.kind === KIND_MEDIA_BLOB);
const notes = (evts: Event[]): Event[] => evts.filter(e => e.kind === 1);

/**
 * The id of the REAL signed note sitting in the local store — which is where publishOptimistic put it
 * before deliver() ever ran, so it exists even for a post the relay never saw.
 *
 * Needed because a gated post and its blob BOTH land in `sendStatus`, and a blob that is rejected or
 * failed is itself 'rejected'/'failed' there. Searching sendStatus by value would happily find the
 * blob and pass while the post's own status was untouched — the exact bug these tests exist to catch.
 * So every status assertion below is keyed to this id explicitly.
 */
function storedNoteId(store: SwappableEventStore): string {
  const found = store.query({kinds: [1]}).filter(e => e.sig !== ''); // sig === '' is a placeholder
  expect(found).toHaveLength(1);
  return found[0]!.id;
}

describe('publish-side blob split — every blob gets its OWN throwaway key', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a TWO-picture post yields two blobs with DISTINCT pubkeys', async () => {
    // THE test. Two blobs sharing a key would occupy the same addressable (kind, pubkey, d='')
    // slot at the relay, so the second would silently delete the first and this post would come
    // back to its readers with one picture missing and no error raised anywhere.
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`one ${picToken('cat')} two ${picToken('dog')}`);
    await flush();

    const sent = blobs(ctx.published);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.pubkey).not.toBe(sent[1]!.pubkey);
    expect(new Set(sent.map(b => b.pubkey)).size).toBe(2);
    // Distinct EVENTS too, not just distinct keys — the ids are what the body references.
    expect(sent[0]!.id).not.toBe(sent[1]!.id);
    ctx.runtime.dispose();
  });

  it('holds across many pictures in one body — no key is ever reused', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post([0, 1, 2, 3].map(i => picToken(`p${i}`)).join(' '));
    await flush();

    const sent = blobs(ctx.published);
    expect(sent).toHaveLength(4);
    expect(new Set(sent.map(b => b.pubkey)).size).toBe(4);
    ctx.runtime.dispose();
  });

  it("a blob's pubkey is a throwaway, never the author's own npub", async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`look ${picToken()}`);
    await flush();

    const mine = ctx.runtime.getSnapshot().currentUserPubkey;
    expect(mine).toBeTruthy(); // guard the guard: a null here would make the assertion below vacuous
    const blob = blobs(ctx.published)[0]!;
    expect(blob.pubkey).not.toBe(mine);
    // Same key discipline as the post itself: neither carries the author on the wire.
    expect(notes(ctx.published)[0]!.pubkey).not.toBe(mine);
    ctx.runtime.dispose();
  });

  it('the published body REFERENCES the blobs and carries none of their bytes', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`hello ${picToken('cat')}`);
    await flush();

    const blob = blobs(ctx.published)[0]!;
    const note = notes(ctx.published)[0]!;
    const pics = extractInlinePictures(note.content);
    expect(pics).toHaveLength(1);
    expect(pics[0]!.source).toEqual({kind: 'blob', blobId: blob.id});
    // The payload moved: it is the blob's content now, and nowhere in the note.
    expect(note.content).not.toContain(blob.content);
    expect(blob.content.length).toBeGreaterThan(0);
    ctx.runtime.dispose();
  });

  it('keeps the picture INLINE when the community is not blind (no throwaway keys to mint)', async () => {
    // Without a community key the signer falls back to the real npub — every blob would share it and
    // they would delete each other. Staying inline is the only fallback that cannot lose a picture.
    const ctx = newRuntime();
    await ctx.runtime.init();
    await ctx.runtime.completeEnrollment(await makeSession(noCk(RELAY_A, ORG_A)), '1234', '9999');
    expect(await ctx.runtime.submitPin('1234')).toBe('unlocked');
    ctx.published.length = 0;

    await ctx.runtime.post(`plain ${picToken()}`);
    await flush();

    expect(blobs(ctx.published)).toHaveLength(0);
    const note = notes(ctx.published)[0]!;
    expect(extractInlinePictures(note.content)[0]!.source.kind).toBe('inline');
    ctx.runtime.dispose();
  });

  it('leaves a body with no media completely alone', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post('just words');
    await flush();

    expect(blobs(ctx.published)).toHaveLength(0);
    expect(notes(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });
});

describe('publish-side blob split — the author never waits and never fetches', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("saves each blob to the LOCAL store, so the author's own picture needs no fetch", async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`mine ${picToken()}`);
    await flush();

    const blob = blobs(ctx.published)[0]!;
    // peek() answers from exactly this store — a blob-backed chip on the author's own post therefore
    // renders straight away, as instantly as an inline one used to.
    expect(ctx.store.getById(blob.id)?.content).toBe(blob.content);
    ctx.runtime.dispose();
  });

  it('renders the optimistic placeholder BEFORE any blob is signed (no foreground stall)', async () => {
    // post() renders its durable placeholder synchronously, before its first await — the blob split
    // (a Tor token draw) must stay strictly behind that or the publish tap hangs again.
    const ctx = await enrolled(newRuntime());
    const pending = ctx.runtime.post(`x ${picToken()}`);

    const placeholder = [...ctx.runtime.getSnapshot().sendStatus.keys()].find(id => id.startsWith('local-'));
    expect(placeholder).toBeDefined();
    expect(ctx.published).toHaveLength(0); // nothing has reached the wire yet

    await pending;
    await flush();
    expect(blobs(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });
});

describe('publish-side blob split — delivery is ordered blob → post', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('sends every blob to the relay BEFORE the post that references it', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`a ${picToken('1')} b ${picToken('2')}`);
    await flush();

    const kinds = ctx.published.map(e => e.kind);
    expect(kinds).toEqual([KIND_MEDIA_BLOB, KIND_MEDIA_BLOB, 1]);
    // And the note that landed last is the one referencing both blobs that landed first.
    const ids = blobs(ctx.published).map(b => b.id);
    const refs = extractInlinePictures(notes(ctx.published)[0]!.content).map(p =>
      p.source.kind === 'blob' ? p.source.blobId : null,
    );
    expect(refs).toEqual(ids);
    ctx.runtime.dispose();
  });

  it('a blob stuck OFFLINE holds the post back entirely — it is never sent', async () => {
    const ctx = newRuntime();
    await enrolled(ctx);
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB ? {accepted: false, message: 'relay not connected', offline: true} : {accepted: true, message: 'ok'},
    );

    await ctx.runtime.post(`stuck ${picToken()}`);
    await flush();

    // The blob was attempted; the post was NOT — no reader can meet a post whose picture is missing.
    expect(blobs(ctx.published).length).toBeGreaterThanOrEqual(1);
    expect(notes(ctx.published)).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it("the post's ring reads 'queued offline' while its blob waits for a relay", async () => {
    const ctx = newRuntime();
    await enrolled(ctx);
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB ? {accepted: false, message: 'relay not connected', offline: true} : {accepted: true, message: 'ok'},
    );

    await ctx.runtime.post(`stuck ${picToken()}`);
    await flush();

    const snap = ctx.runtime.getSnapshot();
    const noteId = storedNoteId(ctx.store);
    expect(snap.sendStatus.get(noteId)).toBe('sending');
    // The user is told the truth — "Queued — connecting…", not a silent spinner and not a false send.
    expect(snap.sendQueuedOffline.has(noteId)).toBe(true);
    ctx.runtime.dispose();
  });

  it('the post goes out the moment its blob finally lands', async () => {
    const ctx = newRuntime();
    await enrolled(ctx);
    let blobOffline = true;
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB && blobOffline
        ? {accepted: false, message: 'relay not connected', offline: true}
        : {accepted: true, message: 'ok'},
    );

    await ctx.runtime.post(`later ${picToken()}`);
    await flush();
    expect(notes(ctx.published)).toHaveLength(0);

    // The relay comes back and the reconnect flush re-drives the queue.
    blobOffline = false;
    await ctx.runtime.onRelayConnected();
    await flush();

    expect(notes(ctx.published)).toHaveLength(1); // the blob landed, so the post followed
    expect(ctx.published.map(e => e.kind).lastIndexOf(KIND_MEDIA_BLOB)).toBeLessThan(
      ctx.published.map(e => e.kind).indexOf(1),
    );
    ctx.runtime.dispose();
  });

  it('a permanently REJECTED blob fails its post loudly, carrying the relay’s reason', async () => {
    // "blob fails ⇒ post never sent, user retries" — and the user must be able to SEE it. A blob has
    // no card of its own, so its rejection is reported on the post, which does.
    const ctx = newRuntime();
    await enrolled(ctx);
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB
        ? {accepted: false, message: 'blocked: event kind 30351 not permitted'}
        : {accepted: true, message: 'ok'},
    );

    await ctx.runtime.post(`doomed ${picToken()}`);
    await flush();

    const snap = ctx.runtime.getSnapshot();
    const noteId = storedNoteId(ctx.store); // the POST's id specifically — not its blob's
    expect(snap.sendStatus.get(noteId)).toBe('rejected');
    // The relay's own words, surfaced on the item the user can actually see and act on.
    expect(snap.sendReasons.get(noteId)).toContain('30351 not permitted');
    expect(notes(ctx.published)).toHaveLength(0); // never sent — no broken picture, ever
    ctx.runtime.dispose();
  });

  it('an ambiguously FAILED blob marks its post failed (Retry) and still never sends it', async () => {
    const ctx = newRuntime();
    await enrolled(ctx);
    ctx.setVerdict(e => {
      if (e.kind === KIND_MEDIA_BLOB) throw new Error('tor circuit died');
      return {accepted: true, message: 'ok'};
    });

    await ctx.runtime.post(`ambiguous ${picToken()}`);
    await flush();

    const snap = ctx.runtime.getSnapshot();
    expect(snap.sendStatus.get(storedNoteId(ctx.store))).toBe('failed'); // the POST, not just its blob
    expect(notes(ctx.published)).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('Retry on a rejected picture post re-drives the BLOB first, then the post', async () => {
    // The other half of the user's decision: "blob fails ⇒ post never sent, user retries". A Retry
    // has to reach the blob — the thing that actually failed — even though the user tapped the post.
    const ctx = newRuntime();
    await enrolled(ctx);
    let blobRejected = true;
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB && blobRejected
        ? {accepted: false, message: 'blocked: try later'}
        : {accepted: true, message: 'ok'},
    );

    await ctx.runtime.post(`retry me ${picToken()}`);
    await flush();
    const noteId = storedNoteId(ctx.store);
    expect(ctx.runtime.getSnapshot().sendStatus.get(noteId)).toBe('rejected');
    expect(notes(ctx.published)).toHaveLength(0);

    // Whatever was wrong is fixed; the user taps Retry on their post.
    blobRejected = false;
    ctx.published.length = 0;
    await ctx.runtime.retry(noteId);
    await flush();

    expect(ctx.published.map(e => e.kind)).toEqual([KIND_MEDIA_BLOB, 1]); // blob first, still
    ctx.runtime.dispose();
  });

  it('"Posted" waits for the POST, not for its blob — a landed blob confirms nothing', async () => {
    // The blob lands FIRST, always and by design (the ordering gate above). So "the blob is at the
    // relay" is the one moment during a picture post's life that looks most like success and isn't:
    // the post itself has not been sent yet, and may still be rejected. postsDelivered — the sole
    // trigger of the "✓ Posted" toast — must not move until the POST lands. Counting the blob would
    // congratulate the user on a picture post nobody can see.
    const ctx = newRuntime();
    await enrolled(ctx);
    ctx.setVerdict(e =>
      e.kind === KIND_MEDIA_BLOB
        ? {accepted: true, message: 'ok'} // the blob is safely at the relay…
        : {accepted: false, message: 'blocked: rejected'}, // …and the post is refused
    );

    await ctx.runtime.post(`doomed picture ${picToken()}`);
    await flush();

    expect(blobs(ctx.published)).toHaveLength(1); // the blob really did land
    expect(ctx.runtime.getSnapshot().sendStatus.get(storedNoteId(ctx.store))).toBe('rejected');
    expect(ctx.runtime.getSnapshot().postsDelivered).toBe(0); // and nothing was claimed
    ctx.runtime.dispose();
  });

  it('a picture post that fully lands confirms exactly ONCE — the post, not post + blob', async () => {
    const ctx = newRuntime();
    await enrolled(ctx);
    await ctx.runtime.post(`good picture ${picToken()}`);
    await flush();

    expect(blobs(ctx.published)).toHaveLength(1);
    expect(notes(ctx.published)).toHaveLength(1);
    // Two events landed for one post; the user made one post, so they get one confirmation.
    expect(ctx.runtime.getSnapshot().postsDelivered).toBe(1);
    ctx.runtime.dispose();
  });

  it('a post with NO blobs is never gated — it goes straight out', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post('no media here');
    await flush();
    expect(notes(ctx.published)).toHaveLength(1);
    ctx.runtime.dispose();
  });
});

describe('publish-side blob split — durability across an app kill', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a blob + its waiting post both survive a kill, and still deliver in order', async () => {
    // Killed after both were queued but before the relay took either: the outbox is persisted, and
    // the dependency rides ON the entry, so the order survives with them.
    const ctx = newRuntime();
    await enrolled(ctx);
    ctx.setVerdict(() => ({accepted: false, message: 'relay not connected', offline: true}));
    await ctx.runtime.post(`survive ${picToken()}`);
    await flush();
    ctx.runtime.dispose();

    // Cold launch on the SAME secure storage — a new process, nothing carried over in memory. The
    // relay is up this time, so whatever the outbox rehydrated is what actually reaches the wire.
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
    await revived.onRelayConnected();
    await flush();

    // Both survived, and the ORDER survived with them — the dependency rides on the outbox entry, so
    // it is restored by the same reload that restores the events.
    const kinds = afterKill.filter(e => e.kind === KIND_MEDIA_BLOB || e.kind === 1).map(e => e.kind);
    expect(kinds).toEqual([KIND_MEDIA_BLOB, 1]);
    revived.dispose();
  });

  it('a token-exhausted picture post recovers WITHOUT re-minting its blobs', async () => {
    // The blob signed, the post's own draw then exhausted. The intent is persisted carrying the
    // already-referencing body + its blob ids, so the retry re-signs only the POST: no second blob,
    // no orphan on the relay, no tokens burned twice.
    const ctx = await enrolled(newRuntime());
    // One token: enough for the blob, nothing left for the post.
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 1) await wallet.spendMany(1);

    await expect(ctx.runtime.post(`tight ${picToken()}`)).rejects.toThrow();
    await flush();
    expect(blobs(ctx.published)).toHaveLength(0); // nothing published — the post never signed
    const snap = ctx.runtime.getSnapshot();
    const placeholder = [...snap.sendStatus.keys()].find(id => id.startsWith('local-'));
    expect(placeholder).toBeDefined();
    expect(snap.sendStatus.get(placeholder!)).toBe('failed'); // durable, retryable — never lost

    // Tokens arrive; the durable queue drains.
    await seedWallet(ctx.secure, RELAY_A, 4);
    await ctx.runtime.refreshFeed();
    await flush();

    // Exactly ONE blob for the one picture — the recovery did not mint a second.
    expect(blobs(ctx.published)).toHaveLength(1);
    expect(notes(ctx.published)).toHaveLength(1);
    expect(ctx.published.map(e => e.kind)).toEqual([KIND_MEDIA_BLOB, 1]);
    ctx.runtime.dispose();
  });

  it('refuses to publish a post whose blob has vanished, rather than shipping a dead reference', async () => {
    // The delivery gate reads "dependency not in the outbox" as "delivered and swept" — sound only
    // because a blob is always queued first. If a blob could go missing between minting and
    // publishing, that premise would invert into the worst outcome available: a post shipped with a
    // picture that exists nowhere, forever. So the write fails instead. (Unreachable in practice — a
    // blob's kind is cache-exempt — which is exactly why it needs a test rather than trust.)
    const ctx = await enrolled(newRuntime());
    const wipe = jest.spyOn(ctx.store, 'getById').mockImplementation(() => undefined);

    await expect(ctx.runtime.post(`vanished ${picToken()}`)).rejects.toThrow(/missing/);
    await flush();

    expect(notes(ctx.published)).toHaveLength(0); // the post never went out
    expect(blobs(ctx.published)).toHaveLength(0); // and nothing was half-published
    wipe.mockRestore();
    ctx.runtime.dispose();
  });

  it('the picture allowance still meters the REAL bytes after the split', async () => {
    // The payload left the body; only `w=` carries its size forward. Without it every picture cap
    // would silently meter a 72-char pointer and fail open.
    const ctx = await enrolled(newRuntime());
    const inlineBytes = extractInlinePictures(picToken('cat'))[0]!.weightBytes;

    await ctx.runtime.post(`meter ${picToken('cat')}`);
    await flush();

    const note = notes(ctx.published)[0]!;
    expect(extractInlinePictures(note.content)[0]!.weightBytes).toBe(inlineBytes);
    ctx.runtime.dispose();
  });
});

describe('publish-side blob split — the silo guard covers blobs too', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("a switch mid-draw drops the write AND its blobs — B's relay sees neither", async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.completeEnrollment(await makeSession(v3(RELAY_B, CK_B, ORG_B)), '1234', '');
    await seedWallet(ctx.secure, RELAY_B);
    ctx.published.length = 0;

    // Compose against A while B is (now) active: the captured (cid, slotId) no longer match, which is
    // exactly the state a switch DURING the draw leaves behind.
    const stale = {
      type: 'post' as const,
      id: 'local-stale-1',
      content: `A's picture ${picToken()}`,
      tags: [],
      cid: communityId(RELAY_A),
      slotId: 'slot-that-is-not-active',
    };
    await (ctx.runtime as unknown as {signPendingWrite(i: unknown): Promise<void>}).signPendingWrite(stale);
    await flush();

    // Nothing of A's reached the wire — not the post, and not its picture bytes.
    expect(ctx.published).toHaveLength(0);
    expect(blobs(ctx.published)).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it("drops A's minted blobs out of the store rather than leaving them in B's silo", async () => {
    const ctx = await enrolled(newRuntime());
    const before = ctx.store.size();
    await ctx.runtime.completeEnrollment(await makeSession(v3(RELAY_B, CK_B, ORG_B)), '1234', '');
    await seedWallet(ctx.secure, RELAY_B);

    const stale = {
      type: 'post' as const,
      id: 'local-stale-2',
      content: `A's picture ${picToken()}`,
      tags: [],
      cid: communityId(RELAY_A),
      slotId: 'slot-that-is-not-active',
    };
    await (ctx.runtime as unknown as {signPendingWrite(i: unknown): Promise<void>}).signPendingWrite(stale);
    await flush();

    expect(ctx.store.query({kinds: [KIND_MEDIA_BLOB]})).toHaveLength(0);
    expect(ctx.store.size()).toBeLessThanOrEqual(before + 1);
    ctx.runtime.dispose();
  });
});

describe('publish-side blob split — the token wallet', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a picture post now draws for TWO events (a blob and a note)', async () => {
    const ctx = await enrolled(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    const before = await wallet.count();

    await ctx.runtime.post(`cost ${picToken()}`);
    await flush();

    expect(await wallet.count()).toBe(before - 2); // 1 blob + 1 note, weight-pricing off
    ctx.runtime.dispose();
  });

  it('exhausting BETWEEN the blob and the post loses neither — the post stays durable and retries', async () => {
    const ctx = await enrolled(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 1) await wallet.spendMany(1);

    await expect(ctx.runtime.post(`squeeze ${picToken()}`)).rejects.toThrow();
    await flush();

    // The blob signed; the post did not. The user sees their own post still sitting in the feed,
    // failed, with a Retry — not a vanished post, and not a post published without its picture.
    // Keyed to the compose PLACEHOLDER's id (nothing reached the outbox, so this is the only entry).
    const snap = ctx.runtime.getSnapshot();
    const placeholder = [...snap.sendStatus.keys()].find(id => id.startsWith('local-'));
    expect(placeholder).toBeDefined();
    expect(snap.sendStatus.get(placeholder!)).toBe('failed');
    expect(ctx.published).toHaveLength(0);
    ctx.runtime.dispose();
  });

  it('a blob-carrying post that exhausts is re-signed from the SAME placeholder, not duplicated', async () => {
    const ctx = await enrolled(newRuntime());
    const wallet = new EpochWallet(ctx.secure, await slotIdFor(ctx.secure, RELAY_A), ISSUER_FP);
    while ((await wallet.count()) > 1) await wallet.spendMany(1);
    await expect(ctx.runtime.post(`once ${picToken()}`)).rejects.toThrow();
    await flush();

    await seedWallet(ctx.secure, RELAY_A, 4);
    await ctx.runtime.refreshFeed();
    await flush();

    expect(notes(ctx.published)).toHaveLength(1); // exactly one post, not two
    ctx.runtime.dispose();
  });
});

describe('blob body grammar — what actually goes on the wire', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('each token tail is a blob reference naming a blob that was really published', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`${picToken('a')} and ${picToken('b')}`);
    await flush();

    const sentIds = new Set(blobs(ctx.published).map(b => b.id));
    const note = notes(ctx.published)[0]!;
    const tails = [...note.content.matchAll(/\[\[pic:[^\]]*;([A-Za-z0-9+/=]+)\]\]/g)].map(m => m[1]!);
    expect(tails).toHaveLength(2);
    for (const tail of tails) {
      const id = parseBlobTail(tail);
      expect(id).not.toBeNull();
      // The body can only ever reference a blob that exists — that is the invariant.
      expect(sentIds.has(id!)).toBe(true);
    }
    ctx.runtime.dispose();
  });

  it('a blob event carries the payload and nothing that points back at its post', async () => {
    const ctx = await enrolled(newRuntime());
    await ctx.runtime.post(`x ${picToken()}`);
    await flush();

    const blob = blobs(ctx.published)[0]!;
    const note = notes(ctx.published)[0]!;
    expect(blob.kind).toBe(KIND_MEDIA_BLOB);
    // No `e`/`a` tag naming the post: the join exists in ONE direction only, so the relay cannot walk
    // blob → post. (The blind machinery's own token/attribution tags are expected and unrelated.)
    expect(blob.tags.some(t => t[0] === 'e' || t[0] === 'a')).toBe(false);
    expect(blob.tags.every(t => t[1] !== note.id)).toBe(true);
    ctx.runtime.dispose();
  });
});
