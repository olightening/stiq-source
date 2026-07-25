// Mirrors AppRuntime.test.ts's jitter kill-switch so timing-jitter delays never leak into these
// synchronous assertions (jest.mock hoists above the imports).
jest.mock('../src/config', () => ({...jest.requireActual('../src/config'), TIMING_JITTER: false}));

import {finalizeEvent, generateSecretKey, type Event} from 'nostr-tools/pure';
import {AppRuntime} from '../src/app/AppRuntime';
import {InMemorySecureStorage, type UnsignedEvent} from '../src/keys/keystore';
import {InMemoryEventStore} from '../src/nostr/store';
import {Enrollment, type Session} from '../src/onboarding/enrollment';
import {MockBlindRsa} from '../src/onboarding/blindrsa';
import {Kind} from '../src/nostr/events';
import {buildPostComment, type EventRef} from '../src/feed/comments';
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

/** A fresh, fully-enrolled + unlocked runtime — mirrors AppRuntime.test.ts's `enrolledRuntime`. */
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

/** Sign an UnsignedEvent as the runtime's own enrolled identity (for self-reply fixtures). */
function signAsMe(runtime: AppRuntime, unsigned: UnsignedEvent): Promise<Event> {
  return (runtime as unknown as {identity: {sign: (u: UnsignedEvent) => Promise<Event>}}).identity.sign(unsigned);
}

/**
 * Regression coverage for the comment double-representation bug (see feed/comments.ts): a comment
 * whose root is a plain Kind.Post publishes as a HYBRID kind-1 'stiq-comment' note
 * (buildNoteComment) — the majority case, since ordinary user posts are Kind.Post — while a comment
 * on any other root (article/poll/channel message) publishes as a NIP-22 kind-1111 Kind.Comment.
 * Both deriveNotifications() and the foreground push trigger (AppRuntime.handleIncomingEvent) used
 * to look ONLY at Kind.Comment, silently missing every reply to a normal post.
 */
describe('AppRuntime — reply notifications across both comment representations', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('a reply to a plain Kind.Post (hybrid stiq-comment) produces a reply notification row', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const hybridReply = finalizeEvent(buildPostComment('nice post!', rootRef, rootRef), generateSecretKey());
    expect(hybridReply.kind).toBe(Kind.Post); // confirms this really is the hybrid (kind-1) form
    store.save(hybridReply);

    const items = runtime.deriveNotifications();
    const row = items.find(i => i.id === hybridReply.id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('reply');
    expect(row?.target).toEqual({kind: 'post', rootId: myPost.id});
    runtime.dispose();
  });

  it('a kind-1111 reply to an Article root still produces a reply notification row', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const myArticle = finalizeEvent(
      {kind: Kind.Article, created_at: 100, tags: [['d', 'x']], content: 'my article'},
      generateSecretKey(),
    );
    store.save(myArticle);
    const rootRef: EventRef = {id: myArticle.id, pubkey: me, kind: Kind.Article};

    const kind1111Reply = finalizeEvent(buildPostComment('great read', rootRef, rootRef), generateSecretKey());
    expect(kind1111Reply.kind).toBe(Kind.Comment); // confirms the NIP-22 form (non-note root)
    store.save(kind1111Reply);

    const items = runtime.deriveNotifications();
    const row = items.find(i => i.id === kind1111Reply.id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('reply');
    runtime.dispose();
  });

  it('a self-reply (hybrid form, on my own post) never produces a notification', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const selfReply = await signAsMe(runtime, buildPostComment('replying to myself', rootRef, rootRef));
    store.save(selfReply);

    const items = runtime.deriveNotifications();
    expect(items.some(i => i.id === selfReply.id)).toBe(false);
    runtime.dispose();
  });

  it('a hybrid comment never double-counts as BOTH a reply row AND a "Posts"-source row', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const hybridReply = finalizeEvent(buildPostComment('nice post!', rootRef, rootRef), generateSecretKey());
    store.save(hybridReply);

    const items = runtime.deriveNotifications();
    const matches = items.filter(i => i.id === hybridReply.id);
    expect(matches).toHaveLength(1); // not one 'reply' row + one 'post' row for the same event
    expect(matches[0]?.kind).toBe('reply');
    runtime.dispose();
  });

  it('the foreground push trigger fires notifyComment for a hybrid reply, resolving the root via commentRootId', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;
    const spy = jest.spyOn(notificationsModule, 'notifyComment').mockResolvedValue(undefined);

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const unsigned = {...buildPostComment('nice post!', rootRef, rootRef), created_at: 200};
    const hybridReply = finalizeEvent(unsigned, generateSecretKey());
    store.save(hybridReply);
    runtime.handleIncomingEvent(hybridReply);

    // rootId resolves to the POST (myPost.id), never the comment's own id — commentRootId(), not a
    // (nonexistent on the hybrid form) uppercase 'E' tag read.
    expect(spy).toHaveBeenCalledWith(myPost.id, expect.any(String), 'note', 200);
    spy.mockRestore();
    runtime.dispose();
  });

  it('the foreground push trigger does NOT fire for a hybrid self-reply', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;
    const spy = jest.spyOn(notificationsModule, 'notifyComment').mockResolvedValue(undefined);

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const selfReply = await signAsMe(runtime, buildPostComment('replying to myself', rootRef, rootRef));
    store.save(selfReply);
    runtime.handleIncomingEvent(selfReply);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    runtime.dispose();
  });
});

/**
 * Widened "is this for me" gate (P1.3): a reply to MY COMMENT — even inside someone ELSE's thread —
 * must notify too, not just a reply to my own thread ROOT. Covers both comment representations, the
 * in-app list AND the foreground push trigger, plus the critical no-double-notify case where I am
 * BOTH the root author and the parent author (someone replies to my comment on my OWN post).
 */
describe('AppRuntime — reply-to-my-comment notifications (root author OR parent author === me)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('hybrid: a reply to my comment on SOMEONE ELSE\'s post notifies, with "replied to your comment on" copy', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const theirPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'their post'},
      generateSecretKey(),
    );
    store.save(theirPost);
    const rootRef: EventRef = {id: theirPost.id, pubkey: theirPost.pubkey, kind: Kind.Post};

    const myComment = await signAsMe(runtime, buildPostComment('my take', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const theirReply = finalizeEvent(buildPostComment('nice take!', rootRef, parentRef), generateSecretKey());
    store.save(theirReply);

    const items = runtime.deriveNotifications();
    const row = items.find(i => i.id === theirReply.id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('reply');
    expect(row?.target).toEqual({kind: 'post', rootId: theirPost.id});
    expect(row?.action).toBe('replied to your comment on');
    runtime.dispose();
  });

  it('kind-1111: a reply to my comment on someone else\'s ARTICLE notifies', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const theirArticle = finalizeEvent(
      {kind: Kind.Article, created_at: 100, tags: [['d', 'x']], content: 'their article'},
      generateSecretKey(),
    );
    store.save(theirArticle);
    const rootRef: EventRef = {id: theirArticle.id, pubkey: theirArticle.pubkey, kind: Kind.Article};

    const myComment = await signAsMe(runtime, buildPostComment('my take', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const theirReply = finalizeEvent(buildPostComment('interesting!', rootRef, parentRef), generateSecretKey());
    store.save(theirReply);

    const items = runtime.deriveNotifications();
    const row = items.find(i => i.id === theirReply.id);
    expect(row).toBeDefined();
    expect(row?.action).toBe('replied to your comment on');
    runtime.dispose();
  });

  it('foreground push trigger fires notifyComment for a reply to my comment on someone else\'s post', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;
    const spy = jest.spyOn(notificationsModule, 'notifyComment').mockResolvedValue(undefined);

    const theirPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'their post'},
      generateSecretKey(),
    );
    store.save(theirPost);
    const rootRef: EventRef = {id: theirPost.id, pubkey: theirPost.pubkey, kind: Kind.Post};

    const myComment = await signAsMe(runtime, buildPostComment('my take', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const unsigned = {...buildPostComment('nice take!', rootRef, parentRef), created_at: 200};
    const theirReply = finalizeEvent(unsigned, generateSecretKey());
    store.save(theirReply);
    runtime.handleIncomingEvent(theirReply);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(theirPost.id, expect.any(String), 'note', 200);
    spy.mockRestore();
    runtime.dispose();
  });

  it('a reply to my comment on MY OWN post (root===me AND parent===me) produces EXACTLY ONE row, not two', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const myComment = await signAsMe(runtime, buildPostComment('my own follow-up', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const theirReply = finalizeEvent(buildPostComment('replying to your comment', rootRef, parentRef), generateSecretKey());
    store.save(theirReply);

    const items = runtime.deriveNotifications();
    const matches = items.filter(i => i.id === theirReply.id);
    expect(matches).toHaveLength(1); // not two rows for root-match + parent-match
    runtime.dispose();
  });

  it('foreground push trigger fires notifyComment EXACTLY ONCE for a reply to my comment on my own post', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;
    const spy = jest.spyOn(notificationsModule, 'notifyComment').mockResolvedValue(undefined);

    const myPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'my post'},
      generateSecretKey(),
    );
    store.save(myPost);
    const rootRef: EventRef = {id: myPost.id, pubkey: me, kind: Kind.Post};

    const myComment = await signAsMe(runtime, buildPostComment('my own follow-up', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const unsigned = {...buildPostComment('replying to your comment', rootRef, parentRef), created_at: 200};
    const theirReply = finalizeEvent(unsigned, generateSecretKey());
    store.save(theirReply);
    runtime.handleIncomingEvent(theirReply);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    runtime.dispose();
  });

  it('I reply to my own comment (on someone else\'s post) — never notifies (self-reply, even as parent author)', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const theirPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'their post'},
      generateSecretKey(),
    );
    store.save(theirPost);
    const rootRef: EventRef = {id: theirPost.id, pubkey: theirPost.pubkey, kind: Kind.Post};

    const myComment = await signAsMe(runtime, buildPostComment('my take', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const myOwnFollowup = await signAsMe(runtime, buildPostComment('adding to my own comment', rootRef, parentRef));
    store.save(myOwnFollowup);

    const items = runtime.deriveNotifications();
    expect(items.some(i => i.id === myOwnFollowup.id)).toBe(false);
    runtime.dispose();
  });

  it('a reply to someone ELSE\'s comment on someone ELSE\'s post, not involving me, never notifies', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    await runtime.getPubkey(); // ensure identity loaded; not used directly below

    const postAuthorSk = generateSecretKey();
    const theirPost = finalizeEvent({kind: Kind.Post, created_at: 100, tags: [], content: 'their post'}, postAuthorSk);
    store.save(theirPost);
    const rootRef: EventRef = {id: theirPost.id, pubkey: theirPost.pubkey, kind: Kind.Post};

    const commentAuthorSk = generateSecretKey();
    const someonesComment = finalizeEvent(buildPostComment('their take', rootRef, rootRef), commentAuthorSk);
    store.save(someonesComment);
    const parentRef: EventRef = {id: someonesComment.id, pubkey: someonesComment.pubkey, kind: someonesComment.kind};

    const thirdPartyReply = finalizeEvent(buildPostComment('agreed', rootRef, parentRef), generateSecretKey());
    store.save(thirdPartyReply);

    const items = runtime.deriveNotifications();
    expect(items.some(i => i.id === thirdPartyReply.id)).toBe(false);
    runtime.dispose();
  });

  it('the `replies` pref set to false suppresses a reply-to-my-comment row too', async () => {
    const store = new InMemoryEventStore();
    const runtime = await enrolledRuntime(store);
    const me = runtime.getPubkey()!;

    const theirPost = finalizeEvent(
      {kind: Kind.Post, created_at: 100, tags: [], content: 'their post'},
      generateSecretKey(),
    );
    store.save(theirPost);
    const rootRef: EventRef = {id: theirPost.id, pubkey: theirPost.pubkey, kind: Kind.Post};

    const myComment = await signAsMe(runtime, buildPostComment('my take', rootRef, rootRef));
    store.save(myComment);
    const parentRef: EventRef = {id: myComment.id, pubkey: me, kind: myComment.kind};

    const theirReply = finalizeEvent(buildPostComment('nice take!', rootRef, parentRef), generateSecretKey());
    store.save(theirReply);

    // Sanity: with replies ON (default), it shows.
    expect(runtime.deriveNotifications().some(i => i.id === theirReply.id)).toBe(true);

    await runtime.setNotificationPrefs({...runtime.getNotificationPrefs(), replies: false});
    expect(runtime.deriveNotifications().some(i => i.id === theirReply.id)).toBe(false);
    runtime.dispose();
  });
});
