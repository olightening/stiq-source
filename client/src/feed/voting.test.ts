import {generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools/pure';
import {
  buildReaction,
  castVote,
  reactionValue,
  reactionTarget,
  scoreReactions,
  scoreForPost,
  myVote,
} from './voting';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';
import {InMemoryEventStore} from '../nostr/store';

function reaction(pubkey: string, postId: string, content: string, createdAt = 1): Event {
  return {
    id: `${pubkey}-${postId}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 7,
    tags: [['e', postId], ['p', 'author']],
    content,
    sig: 's',
  };
}

describe('voting', () => {
  it('builds a kind-7 reaction referencing the post', () => {
    const up = buildReaction('post1', 'authorhex', 'up');
    expect(up.kind).toBe(7);
    expect(up.content).toBe('+');
    expect(up.tags).toContainEqual(['e', 'post1']);
    expect(buildReaction('post1', 'authorhex', 'down').content).toBe('-');
  });

  it('signs a valid vote via the keystore', async () => {
    const store = new KeyStore(new InMemorySecureStorage());
    const sk = generateSecretKey();
    await store.enroll(sk);

    const event = await castVote(store, 'post1', 'authorhex', 'up');
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(7);
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(reactionTarget(event)).toBe('post1');
  });

  it('scores reactions, counting one (latest) vote per pubkey', () => {
    const reactions = [
      reaction('alice', 'p', '+', 1),
      reaction('bob', 'p', '+', 1),
      reaction('carol', 'p', '-', 1),
      reaction('alice', 'p', '-', 5), // alice changed her vote -> latest wins
    ];
    expect(scoreReactions(reactions)).toMatchObject({up: 1, down: 2, score: -1});
  });

  it('a downvote never becomes Rising velocity', () => {
    // voteTimestamps is read by the Rising sort as APPROVAL velocity (feed/sort.ts). Pushing a '-'
    // here made disliking a post promote it. Stiq has no downvote affordance at all, so a '-' can
    // only come from a patched client — it must contribute no engagement whatsoever.
    const reactions = [
      reaction('alice', 'p', '+', 100),
      reaction('bob', 'p', '-', 200),
      reaction('carol', 'p', '-', 300),
    ];
    const scored = scoreReactions(reactions);
    expect(scored.voteTimestamps).toEqual([100]); // only alice's upvote
    expect(scored).toMatchObject({up: 1, down: 2, score: -1}); // '-' still counts against score
  });

  it('reactionValue ignores custom-emoji reactions', () => {
    expect(reactionValue(reaction('a', 'p', '🔥'))).toBe(0);
    expect(reactionValue(reaction('a', 'p', ''))).toBe(1);
  });

  it('reports the viewer’s current vote', () => {
    const reactions = [reaction('me', 'p', '+', 1), reaction('me', 'p', '-', 9)];
    expect(myVote(reactions, 'me')).toBe('down');
    expect(myVote(reactions, 'someone')).toBeNull();
  });

  it('scores a post from the cache (persistence path)', () => {
    const cache = new InMemoryEventStore();
    cache.save(reaction('alice', 'p1', '+', 1));
    cache.save(reaction('bob', 'p1', '+', 1));
    cache.save(reaction('eve', 'p2', '+', 1)); // different post
    expect(scoreForPost(cache, 'p1')).toMatchObject({up: 2, down: 0, score: 2});
  });
});
