import {searchFeed} from './search';
import type {FeedItem} from './feed';

function item(overrides: Partial<FeedItem> & {id: string}): FeedItem {
  return {
    authorPubkey: 'aa'.repeat(32),
    author: 'npub1test',
    kind: 1,
    identifier: overrides.id,
    content: overrides.content ?? '',
    tags: overrides.tags ?? [],
    createdAt: 1000,
    score: 0,
    title: overrides.title,
    ...overrides,
  };
}

describe('searchFeed', () => {
  const items = [
    item({id: '1', content: 'Hello world', tags: ['news']}),
    item({id: '2', content: 'Privacy matters', tags: ['security']}),
    item({id: '3', title: 'Long article', content: 'Article body', kind: 30023}),
  ];

  it('returns all items for empty query', () => {
    expect(searchFeed(items, '  ')).toHaveLength(3);
  });

  it('filters by content substring', () => {
    const r = searchFeed(items, 'privacy');
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('2');
  });

  it('filters by tag', () => {
    const r = searchFeed(items, 'news');
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('1');
  });

  it('filters by article title', () => {
    const r = searchFeed(items, 'long');
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('3');
  });

  it('is case-insensitive', () => {
    expect(searchFeed(items, 'WORLD')).toHaveLength(1);
  });
});
