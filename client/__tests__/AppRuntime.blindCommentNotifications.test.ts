// Blind-comment attribution in the notification center + foreground push trigger.
//
// A blind community signs every comment with a per-post THROWAWAY key (a spent anti-spam token);
// the real author lives in the encrypted `stiq_attr` attestation, recoverable only via
// resolveIdentity()/resolveAuthor() under the community key. The notification surfaces USED to read
// the raw `event.pubkey` (the throwaway), which produced two on-device bugs the user reported:
//   1. their OWN comments notified them (throwaway !== myPubkey defeated the self-skip guard), and
//   2. a commenter rendered as "Someone" over a stranger's gradient (nameFor(throwaway) is empty).
// Every fixture in AppRuntime.commentNotifications.test.ts signs with a REAL key (generateSecretKey /
// signAsMe), so the throwaway case was never covered. These tests build genuine blind comments.
jest.mock('../src/config', () => ({...jest.requireActual('../src/config'), TIMING_JITTER: false}));

import {finalizeEvent, generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import {AppRuntime} from '../src/app/AppRuntime';
import {InMemorySecureStorage, type UnsignedEvent} from '../src/keys/keystore';
import {InMemoryEventStore} from '../src/nostr/store';
import {Enrollment, type Session} from '../src/onboarding/enrollment';
import {MockBlindRsa} from '../src/onboarding/blindrsa';
import {Kind} from '../src/nostr/events';
import {buildPostComment, type EventRef} from '../src/feed/comments';
import {DRAFT_COMMENT_ROOT_KIND} from '../src/feed/draftAccess';
import {setActiveCommunityKey, mintCommunityKey} from '../src/blind/communityKey';
import {clearAuthorCache} from '../src/blind/identity';
import {encryptForSpace} from '../src/channels/groupCrypto';
import {
  TAG_TOKEN,
  TAG_ATTR,
  KIND_ATTESTATION,
  ATTR_BIND,
  ATTR_NAME,
  ATTR_GRAD,
} from '../src/blind/protocol';
import * as notificationsModule from '../src/notifications/notifications';

const identityHash = async (d: Uint8Array) => d;
const community = {relayUrl: `ws://${'a'.repeat(56)}.onion`, issuerPublicKey: 'aXNz'};

async function makeSession(): Promise<Session> {
  const {enrollment} = await Enrollment.begin(community, new MockBlindRsa(), 'STIQ-TEST-0001');
  const result = await enrollment.complete('stiq:cred-resp:1;AQIDBA==');
  if (!result.ok) {
    throw new Error('enrollment failed in setup');
  }
  return result.session;
}

async function enrolledRuntime(store: InMemoryEventStore): Promise<AppRuntime> {
  const runtime = new AppRuntime({
    secureStorage: new InMemorySecureStorage(),
    store,
    hash: identityHash,
    autoLockMs: 60_000,
    publish: async () => ({accepted: true, message: 'ok'}),
  });
  await runtime.init();
  await runtime.completeEnrollment(await makeSession(), '1234', '9999');
  await runtime.submitPin('1234');
  return runtime;
}

/**
 * A fully-enrolled runtime with an ACTIVE community key — so blind posts resolve their real author.
 * The key MUST be set AFTER enrollment: init()'s loadActiveCommunityPolicy calls
 * setActiveCommunityKey(null) for this mock community (its join code carries no `ck`), which would
 * clobber a key set earlier. (A real v3 community's key is set there from its own record.)
 */
async function enrolledBlindRuntime(store: InMemoryEventStore, communityKey: Uint8Array): Promise<AppRuntime> {
  const runtime = await enrolledRuntime(store);
  setActiveCommunityKey(communityKey);
  clearAuthorCache();
  return runtime;
}

/** Sign an UnsignedEvent as the runtime's own enrolled identity (used to attest a self-authored blind comment). */
function signAsMe(runtime: AppRuntime, unsigned: UnsignedEvent): Promise<Event> {
  return (runtime as unknown as {identity: {sign: (u: UnsignedEvent) => Promise<Event>}}).identity.sign(unsigned);
}

/**
 * Assemble a genuine BLIND comment: signed by a fresh throwaway key, with the real author sealed in
 * `stiq_attr` (an attestation, signed by `attest`, that binds the throwaway pubkey to the real npub).
 * `attest` signs the attestation as the REAL author — `signAsMe` for a self-comment, a raw
 * finalizeEvent(_, peerSk) for a peer. Mirrors blind/blindPost.ts's toBlindEvent without needing a
 * real token/wallet: the client-side resolver verifies the attestation's schnorr sig, not the token.
 */
async function blindComment(opts: {
  unsigned: UnsignedEvent;
  attest: (u: UnsignedEvent) => Promise<Event>;
  communityKey: Uint8Array;
  createdAt: number;
  name?: string;
  gradient?: string;
}): Promise<Event> {
  const throwSk = generateSecretKey();
  const throwPk = getPublicKey(throwSk);
  const attTags: string[][] = [[ATTR_BIND, throwPk]];
  if (opts.name) attTags.push([ATTR_NAME, opts.name]);
  if (opts.gradient) attTags.push([ATTR_GRAD, opts.gradient]);
  const attestation = await opts.attest({
    kind: KIND_ATTESTATION,
    created_at: opts.createdAt,
    tags: attTags,
    content: '',
  });
  const attr = encryptForSpace(JSON.stringify(attestation), opts.communityKey);
  return finalizeEvent(
    {
      kind: opts.unsigned.kind,
      created_at: opts.createdAt,
      tags: [...opts.unsigned.tags, [TAG_TOKEN, 'AAAA'], [TAG_ATTR, attr]],
      content: opts.unsigned.content,
    },
    throwSk,
  );
}

describe('AppRuntime — blind (throwaway-signed) comment notifications resolve the real author', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    setActiveCommunityKey(null); // the active key is a module global — never leak it across tests
    clearAuthorCache();
  });

  it('my OWN blind self-reply never notifies me — resolved via stiq_attr, not the throwaway event.pubkey', async () => {
    const store = new InMemoryEventStore();
    const communityKey = mintCommunityKey();
    const runtime = await enrolledBlindRuntime(store, communityKey);
    const me = runtime.getPubkey()!;

    const myPost = finalizeEvent({kind: Kind.Post, created_at: 100, tags: [], content: 'my post'}, generateSecretKey());
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const myBlindReply = await blindComment({
      unsigned: buildPostComment('replying to myself', rootRef, rootRef),
      attest: u => signAsMe(runtime, u),
      communityKey,
      createdAt: 200,
      name: 'Homer',
    });
    expect(myBlindReply.pubkey).not.toBe(me); // sanity: signed by the throwaway, NOT my npub

    store.save(myBlindReply);
    expect(runtime.deriveNotifications().some(i => i.id === myBlindReply.id)).toBe(false);
    runtime.dispose();
  });

  it('a peer\'s blind reply renders their real name + real-npub avatar from stiq_attr, never "Someone"', async () => {
    const store = new InMemoryEventStore();
    const communityKey = mintCommunityKey();
    const runtime = await enrolledBlindRuntime(store, communityKey);
    const me = runtime.getPubkey()!;

    const myPost = finalizeEvent({kind: Kind.Post, created_at: 100, tags: [], content: 'my post'}, generateSecretKey());
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const peerSk = generateSecretKey();
    const peerPk = getPublicKey(peerSk);
    const peerReply = await blindComment({
      unsigned: buildPostComment('nice post!', rootRef, rootRef),
      attest: u => Promise.resolve(finalizeEvent(u, peerSk)),
      communityKey,
      createdAt: 200,
      name: 'Marge',
    });
    expect(peerReply.pubkey).not.toBe(peerPk); // the throwaway signer, not the peer's real key

    store.save(peerReply);
    const row = runtime.deriveNotifications().find(i => i.id === peerReply.id);
    expect(row).toBeDefined();
    expect(row!.actor).toBe('Marge'); // real name from the attestation — not "Someone"
    expect(row!.avatar.seed).toBe(nip19.npubEncode(peerPk)); // the peer's REAL npub, not the throwaway
    runtime.dispose();
  });

  it('a reply to an embed-only post shows a readable title, never the raw stiq:draft: token', async () => {
    const store = new InMemoryEventStore();
    const communityKey = mintCommunityKey();
    const runtime = await enrolledBlindRuntime(store, communityKey);
    const me = runtime.getPubkey()!;

    // A post whose whole body is a draft embed token (like the on-device "Hehe" post).
    const embedBody = 'stiq:draft:eyJ2IjoyLCJpZCI6ImFiY2QifQ';
    const myPost = finalizeEvent({kind: Kind.Post, created_at: 100, tags: [], content: embedBody}, generateSecretKey());
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const peerReply = await blindComment({
      unsigned: buildPostComment('the rich text!', rootRef, rootRef),
      attest: u => Promise.resolve(finalizeEvent(u, generateSecretKey())),
      communityKey,
      createdAt: 200,
      name: 'Marge',
    });
    store.save(peerReply);

    const row = runtime.deriveNotifications().find(i => i.id === peerReply.id);
    expect(row).toBeDefined();
    expect(row!.targetText ?? '').not.toContain('stiq:draft:'); // never leak the base64 token
    expect(row!.targetText).toBe('“✍ Draft”'); // the embed's stand-alone label, curly-quoted
    runtime.dispose();
  });

  it('a peer\'s reply to my shared DRAFT reads "commented on your draft" (no stored post to title)', async () => {
    const store = new InMemoryEventStore();
    const communityKey = mintCommunityKey();
    const runtime = await enrolledBlindRuntime(store, communityKey);
    const me = runtime.getPubkey()!;

    // A draft has no published post — its comment thread hangs off a synthetic root (shareId + the
    // DRAFT_COMMENT_ROOT_KIND sentinel), so buildPostComment takes the plain kind-1111 branch.
    const draftRoot: EventRef = {id: 'share-id-abc', pubkey: me, kind: DRAFT_COMMENT_ROOT_KIND};
    const peerReply = await blindComment({
      unsigned: buildPostComment('love this draft', draftRoot, draftRoot),
      attest: u => Promise.resolve(finalizeEvent(u, generateSecretKey())),
      communityKey,
      createdAt: 200,
      name: 'Marge',
    });
    expect(peerReply.kind).toBe(Kind.Comment); // sanity: the kind-1111 (non-note-root) form
    store.save(peerReply);

    const row = runtime.deriveNotifications().find(i => i.id === peerReply.id);
    expect(row).toBeDefined();
    expect(row!.action).toBe('commented on your draft');
    expect(row!.actor).toBe('Marge');
    runtime.dispose();
  });

  it('foreground push: a blind SELF-reply does NOT fire notifyComment (resolved via stiq_attr)', async () => {
    const store = new InMemoryEventStore();
    const communityKey = mintCommunityKey();
    const runtime = await enrolledBlindRuntime(store, communityKey);
    const me = runtime.getPubkey()!;
    const spy = jest.spyOn(notificationsModule, 'notifyComment').mockResolvedValue(undefined);

    const myPost = finalizeEvent({kind: Kind.Post, created_at: 100, tags: [], content: 'my post'}, generateSecretKey());
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const myBlindReply = await blindComment({
      unsigned: buildPostComment('replying to myself', rootRef, rootRef),
      attest: u => signAsMe(runtime, u),
      communityKey,
      createdAt: 200,
      name: 'Homer',
    });
    store.save(myBlindReply);
    runtime.handleIncomingEvent(myBlindReply);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    runtime.dispose();
  });

  it('foreground push: a peer\'s blind reply fires notifyComment with their real name', async () => {
    const store = new InMemoryEventStore();
    const communityKey = mintCommunityKey();
    const runtime = await enrolledBlindRuntime(store, communityKey);
    const me = runtime.getPubkey()!;
    const spy = jest.spyOn(notificationsModule, 'notifyComment').mockResolvedValue(undefined);

    const myPost = finalizeEvent({kind: Kind.Post, created_at: 100, tags: [], content: 'my post'}, generateSecretKey());
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const peerReply = await blindComment({
      unsigned: buildPostComment('nice post!', rootRef, rootRef),
      attest: u => Promise.resolve(finalizeEvent(u, generateSecretKey())),
      communityKey,
      createdAt: 200,
      name: 'Marge',
    });
    store.save(peerReply);
    runtime.handleIncomingEvent(peerReply);

    expect(spy).toHaveBeenCalledWith(myPost.id, 'Marge', 'note', 200); // real name, not the throwaway's ''
    spy.mockRestore();
    runtime.dispose();
  });
});
