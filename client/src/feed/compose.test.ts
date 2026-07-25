import {buildPost, buildArticle} from './compose';
import {Kind} from '../nostr/events';

describe('buildPost', () => {
  it('builds a kind-1 event', () => {
    const ev = buildPost('hello', ['news']);
    expect(ev.kind).toBe(Kind.Post);
    expect(ev.content).toBe('hello');
    expect(ev.tags).toContainEqual(['t', 'news']);
  });
  it('throws on empty content', () => {
    expect(() => buildPost('  ')).toThrow('empty');
  });
  it('carries a NIP-32 label tag when a label is given (tweet-like notes can be typed too)', () => {
    const ev = buildPost('hello', ['news'], [], undefined, 'insight');
    expect(ev.tags.find(t => t[0] === 'l')).toEqual(['l', 'insight', 'stiq.type']);
  });
  it('omits the label tag when no label is given', () => {
    const ev = buildPost('hello', ['news']);
    expect(ev.tags.find(t => t[0] === 'l')).toBeUndefined();
  });
});

describe('buildArticle', () => {
  it('builds a kind-30023 event with title and d-tag', () => {
    const ev = buildArticle('My Title', 'Body text', ['topic']);
    expect(ev.kind).toBe(Kind.Article);
    const titleTag = ev.tags.find(t => t[0] === 'title');
    const dTag = ev.tags.find(t => t[0] === 'd');
    expect(titleTag?.[1]).toBe('My Title');
    // d-tag is the title slug plus a unique suffix (so same-title posts don't collide).
    expect(dTag?.[1]).toMatch(/^my-title-[a-z0-9]+$/);
    expect(ev.tags).toContainEqual(['t', 'topic']);
  });
  it('includes summary and label tags when provided', () => {
    const ev = buildArticle('T', 'B', [], 'A short summary', 'insight');
    expect(ev.tags).toContainEqual(['summary', 'A short summary']);
    expect(ev.tags.find(t => t[0] === 'l')?.[1]).toBe('insight');
  });
  it('throws on empty title', () => {
    expect(() => buildArticle('  ', 'body')).toThrow('empty');
  });
  it('falls back the body to the title when content is empty', () => {
    const ev = buildArticle('Title', '  ');
    expect(ev.content).toBe('Title');
  });
});
