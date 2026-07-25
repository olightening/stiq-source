import {feedItemKey} from './FeedList';
import type {FeedItem} from '../feed';

/**
 * The regression these lock: an optimistic post appeared, DISAPPEARED, then reappeared.
 *
 * The cause was never the data — AppRuntime's placeholder→real swap is synchronous and React batches
 * it into one commit, so the store is never observably empty. It was the row's React KEY changing in
 * that commit (`local-…` → the real event hash), which unmounts the cell and mounts a new one; on a
 * variable-height list with no getItemLayout the replacement re-measures from zero, which is the
 * flash the reporter saw.
 */
const item = (over: Partial<FeedItem>): FeedItem =>
  ({
    id: 'e'.repeat(64),
    author: 'npub1abc',
    content: 'hi',
    tags: [],
    createdAt: 100,
    score: 0,
    ...over,
  }) as FeedItem;

describe('feedItemKey', () => {
  it('THE REGRESSION: the key survives the placeholder -> real event swap', () => {
    // sortAt is what _ownPostOrder carries across the swap; the id is what changes underneath it.
    const placeholder = item({id: 'local-1712345678901-8f2a', sortAt: 1_712_345_678_901});
    const real = item({id: 'a'.repeat(64), sortAt: 1_712_345_678_901});

    expect(feedItemKey(placeholder)).toBe(feedItemKey(real));
  });

  it('keys own posts off sortAt, NOT the id that changes', () => {
    expect(feedItemKey(item({id: 'local-x', sortAt: 42}))).toBe('own-42');
  });

  it('falls back to the id for everyone else (no sortAt), which is already stable for them', () => {
    const other = item({id: 'b'.repeat(64)});
    expect(feedItemKey(other)).toBe('b'.repeat(64));
  });

  it('two of my own posts in the same millisecond still get distinct keys', () => {
    // recordOwnPostOrder is strictly monotonic precisely so a rapid burst cannot tie. If that ever
    // regressed to a raw Date.now(), duplicate keys would silently corrupt the list.
    const first = item({id: 'local-1', sortAt: 1_000});
    const second = item({id: 'local-2', sortAt: 1_001});
    expect(feedItemKey(first)).not.toBe(feedItemKey(second));
  });

  it('an own-post key cannot collide with another author\'s event id', () => {
    // The `own-` prefix is load-bearing: a bare number could in principle meet an id-shaped string.
    expect(feedItemKey(item({id: 'local-x', sortAt: 1}))).toMatch(/^own-/);
    expect(feedItemKey(item({id: 'c'.repeat(64)}))).not.toMatch(/^own-/);
  });
});
