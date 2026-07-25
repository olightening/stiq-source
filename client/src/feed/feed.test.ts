import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {buildFeed, toFeedItem, itemsWithTag} from './feed';
import {InMemoryEventStore} from '../nostr/store';
import {setEpochUnlockUnavailable, clearEpochUnlockDisplay} from '../blind/unlockState';

function post(id: string, createdAt: number, tags: string[][] = []): Event {
  return {id, pubkey: 'a'.repeat(64), created_at: createdAt, kind: 1, tags, content: id, sig: 's'};
}

const modPub = getPublicKey(generateSecretKey());
const modNpub = nip19.npubEncode(modPub);

function report(postId: string): Event {
  return {
    id: `r-${postId}`,
    pubkey: modPub,
    created_at: 100,
    kind: 1984,
    tags: [['e', postId, 'other']],
    content: '',
    sig: 's',
  };
}

describe('feed view-model', () => {
  it('maps an event to a feed item with npub + tags', () => {
    const item = toFeedItem(post('A', 1, [['t', 'news']]));
    expect(item.id).toBe('A');
    expect(item.author).toBe(nip19.npubEncode('a'.repeat(64)));
    expect(item.tags).toEqual(['news']);
  });

  it('builds the main feed excluding moderated posts and logs them', () => {
    const store = new InMemoryEventStore();
    store.save(post('A', 300, [['t', 'news']]));
    store.save(post('B', 200));
    store.save(report('B'));

    const feed = buildFeed(store, [modNpub]);
    expect(feed.items.map(i => i.id)).toEqual(['A']);
    expect(feed.log).toHaveLength(1);
    expect(feed.log[0]!.item.id).toBe('B');
    expect(feed.log[0]!.moderatorNpub).toBe(modNpub);
  });

  it('filters items by tag', () => {
    const items = [toFeedItem(post('A', 1, [['t', 'news']])), toFeedItem(post('B', 2))];
    expect(itemsWithTag(items, 'news').map(i => i.id)).toEqual(['A']);
  });

  it('toFeedItem: a sortAt arg lands ONLY on the FeedItem, never on the source event (wire-safety)', () => {
    const ev = post('A', 1);
    const item = toFeedItem(ev, 0, undefined, undefined, undefined, undefined, undefined, 42);
    expect(item.sortAt).toBe(42);
    // The event that goes to the store/wire must be untouched — sortAt is a render-model field only.
    expect('sortAt' in ev).toBe(false);
    expect(ev.created_at).toBe(1);
    // Omitting sortAt leaves it absent (other authors → the item falls back to createdAt).
    expect(toFeedItem(post('B', 2)).sortAt).toBeUndefined();
  });

  it('buildFeed: commentCount includes hybrid kind-1 stiq-comment replies (C3 refactor — stiqComments are now split off by buildModeratedFeed\'s single combined query, not a second Post-kind query)', () => {
    const store = new InMemoryEventStore();
    const root = post('A', 300);
    store.save(root);
    // A hybrid kind-1 'stiq-comment' reply — NOT a top-level feed post. Deliberately kept in the
    // LEGACY pre-marker shape (unmarked 'p' tag), i.e. what is still on relays and in local stores
    // from before buildNoteComment marked its 'p' tags: buildFeed keys comments off the 'root'-marked
    // 'e' tag alone, so it must stay blind to the 'p'-tag format on both old and new events.
    store.save({
      id: 'C1',
      pubkey: 'b'.repeat(64),
      created_at: 310,
      kind: 1,
      tags: [
        ['e', 'A', '', 'root'],
        ['p', root.pubkey],
        ['t', 'stiq-comment'],
      ],
      content: 'a reply',
      sig: 's',
    });

    const feed = buildFeed(store);
    // The comment itself must not appear as a top-level feed item...
    expect(feed.items.map(i => i.id)).toEqual(['A']);
    // ...but must still be counted against its root.
    expect(feed.items[0]!.commentCount).toBe(1);
  });

  it('buildFeed: ownOrder sets sortAt on the matching item only, leaving the events unchanged', () => {
    const store = new InMemoryEventStore();
    const a = post('A', 300);
    const b = post('B', 200);
    store.save(a);
    store.save(b);
    // Local-only own-post order: only 'A' is one of the viewer's own posts.
    const ownOrder = new Map<string, number>([['A', 9999]]);
    const feed = buildFeed(store, [], undefined, undefined, undefined, undefined, undefined, undefined, ownOrder);
    expect(feed.items.find(i => i.id === 'A')!.sortAt).toBe(9999);
    expect(feed.items.find(i => i.id === 'B')!.sortAt).toBeUndefined();
    // Wire-safety invariant: the underlying events carry no sortAt after the build.
    expect('sortAt' in a).toBe(false);
    expect('sortAt' in b).toBe(false);
  });
});

// Members-only sealed bodies through the feed view-model (invisible auto-unlock): a sealed post's
// body/media must be WITHHELD while locked (never ciphertext), carry the epoch the runtime's
// background unlock needs, and resolve to plaintext once the epoch key lands.
describe('toFeedItem sealed-content lock flow', () => {
  // Isolated import so this block owns the epoch-key module state it mutates.
  const {mintContentKey, setContentEpochKey, clearActiveContentKeys} = require('../blind/contentKey') as typeof import('../blind/contentKey');
  const {encryptForSpace} = require('../channels/groupCrypto') as typeof import('../channels/groupCrypto');

  afterEach(() => clearActiveContentKeys());

  function sealedPost(key: Uint8Array, epoch: number, body: string): Event {
    return {
      id: 'sealed-1',
      pubkey: 'b'.repeat(64),
      created_at: 50,
      kind: 1,
      // A real sealed post is a BLIND post (token) + the nip44 marker + its `ke` epoch tag.
      tags: [['stiq_token', 'AA'], ['stiq_sig', 'BB'], ['encrypted', 'nip44'], ['ke', String(epoch)]],
      content: encryptForSpace(body, key),
      sig: 's',
    };
  }

  it('locked: withholds body + media, sets locked/lockedEpoch, never leaks ciphertext', () => {
    const key = mintContentKey();
    const ev = sealedPost(key, 3, 'secret body https://example.com/x.png');
    // Epoch 3 NOT unlocked on this device.
    const item = toFeedItem(ev);
    expect(item.locked).toBe(true);
    expect(item.lockedEpoch).toBe(3);
    expect(item.content).toBe('');
    expect(item.imageUrl).toBeUndefined();
    expect(item.voice).toBeUndefined();
  });

  it('unlocked: the same event resolves to plaintext with no lock flags', () => {
    const key = mintContentKey();
    const ev = sealedPost(key, 3, 'secret body');
    setContentEpochKey(3, key);
    const item = toFeedItem(ev);
    expect(item.locked).toBeUndefined();
    expect(item.lockedEpoch).toBeUndefined();
    expect(item.content).toBe('secret body');
  });

  it('a sealed post with a stripped/malformed ke tag is locked with NO lockedEpoch (nothing to unlock)', () => {
    const key = mintContentKey();
    const ev = sealedPost(key, 3, 'secret');
    ev.tags = ev.tags.filter(t => t[0] !== 'ke');
    const item = toFeedItem(ev);
    expect(item.locked).toBe(true);
    expect(item.lockedEpoch).toBeUndefined();
    expect(item.content).toBe('');
  });
});

// PostCard is React.memo'd on the CACHED FeedItem's identity (buildFeed → scoreFeedItem → _itemCache),
// so the pending→terminal (unlockUnavailable) flip driven by AppRuntime.noteLockedEpochs/markEpochTerminal
// must change the cache key (2026-07-22 fix: the terminal state added there is the SAME 'Lx' bit this
// key already carried for a plain organizer refusal) — otherwise the card would never repaint off a
// stable item reference even though isEpochUnlockUnavailable flipped underneath it.
describe('buildFeed item-cache key vs auto-unlock terminal state ("L" vs "Lx")', () => {
  afterEach(() => clearEpochUnlockDisplay());

  it('a still-locked item gets a NEW object identity when its epoch flips pending -> unavailable', () => {
    const store = new InMemoryEventStore();
    const ev: Event = {
      id: 'sealed-locked-1',
      pubkey: 'c'.repeat(64),
      created_at: 10,
      kind: 1,
      tags: [['stiq_token', 'AA'], ['stiq_sig', 'BB'], ['encrypted', 'nip44'], ['ke', '7']],
      content: 'ciphertext-not-decryptable-in-this-test',
      sig: 's',
    };
    store.save(ev);

    const before = buildFeed(store).items.find(i => i.id === ev.id)!;
    expect(before.locked).toBe(true);
    expect(before.lockedEpoch).toBe(7);

    // Same underlying event, same store, same build inputs — a cache HIT would return the identical
    // object were it not for the lock-state bit in the key.
    const stillPending = buildFeed(store).items.find(i => i.id === ev.id)!;
    expect(stillPending).toBe(before); // nothing changed yet -> cache hit, same reference

    setEpochUnlockUnavailable(7, true); // AppRuntime.markEpochTerminal's render-facing flip
    const afterTerminal = buildFeed(store).items.find(i => i.id === ev.id)!;
    expect(afterTerminal).not.toBe(before); // key bumped 'L' -> 'Lx' -> new object -> PostCard repaints

    // And it flips back to a fresh identity again on revival (reviveStuckEpochUnlocks/retryEpochUnlock).
    setEpochUnlockUnavailable(7, false);
    const afterRevive = buildFeed(store).items.find(i => i.id === ev.id)!;
    expect(afterRevive).not.toBe(afterTerminal);
  });
});
