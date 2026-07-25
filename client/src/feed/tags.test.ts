import {normalizeTag, normalizeTags, postTags} from './tags';
import type {Event} from 'nostr-tools/pure';

describe('tags', () => {
  it('normalizes a single tag (strip #, lowercase, trim)', () => {
    expect(normalizeTag('  #Announcements ')).toBe('announcements');
    expect(normalizeTag('NEWS')).toBe('news');
  });

  it('de-duplicates and drops empties', () => {
    expect(normalizeTags(['News', 'news', '#NEWS', '', '  '])).toEqual(['news']);
    expect(normalizeTags(['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('extracts t tags from an event', () => {
    const event = {tags: [['t', 'news'], ['e', 'x'], ['t', 'local']]} as Event;
    expect(postTags(event)).toEqual(['news', 'local']);
  });
});
