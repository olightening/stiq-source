import type {Event} from 'nostr-tools/pure';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import {quotaFor, limitCategory, limitMessage} from './limits';
import type {Limits} from './organizerConfig';

const ME = 'a'.repeat(64);
const NOW = 1_000_000;

let seq = 0;
function evt(kind: number, ageSec: number, tags: string[][] = []): Event {
  return {
    id: `e${++seq}`,
    pubkey: ME,
    kind,
    created_at: NOW - ageSec,
    tags,
    content: '',
    sig: '',
  };
}

describe('limitCategory', () => {
  it('classifies posts, comments, and channel messages', () => {
    expect(limitCategory(evt(Kind.Post, 0))).toBe('posts');
    expect(limitCategory(evt(Kind.Post, 0, [['t', 'stiq-comment']]))).toBe('comments');
    expect(limitCategory(evt(Kind.Comment, 0))).toBe('comments');
    expect(limitCategory(evt(Kind.ChannelMessage, 0))).toBe('channel');
    expect(limitCategory(evt(Kind.LiveChat, 0))).toBe('channel');
    expect(limitCategory(evt(Kind.Reaction, 0))).toBeNull();
  });
});

const LIMITS: Limits = {posts: {daily: 2, weekly: 3, monthly: 5}};

describe('quotaFor', () => {
  it('counts the user own posts across windows and blocks when daily is exhausted', () => {
    const store = new InMemoryEventStore();
    store.save(evt(Kind.Post, 10));
    store.save(evt(Kind.Post, 20));
    const q = quotaFor(store, ME, 'posts', LIMITS, NOW);
    expect(q.daily.used).toBe(2);
    expect(q.daily.remaining).toBe(0);
    expect(q.blocked).toBe(true);
    expect(q.blockedWindow).toBe('daily');
    expect(limitMessage(q, 'posts')).toMatch(/daily post limit/);
  });

  it('treats older events as outside the daily window', () => {
    const store = new InMemoryEventStore();
    store.save(evt(Kind.Post, 2 * 86400)); // 2 days ago → weekly/monthly only
    const q = quotaFor(store, ME, 'posts', LIMITS, NOW);
    expect(q.daily.used).toBe(0);
    expect(q.weekly.used).toBe(1);
    expect(q.blocked).toBe(false);
  });

  it('reports unlimited when no policy is configured', () => {
    const store = new InMemoryEventStore();
    store.save(evt(Kind.Post, 1));
    const q = quotaFor(store, ME, 'posts', undefined, NOW);
    expect(q.daily.remaining).toBe(Infinity);
    expect(q.blocked).toBe(false);
    expect(limitMessage(q, 'posts')).toBeNull();
  });

  it('does not count other categories against posts', () => {
    const store = new InMemoryEventStore();
    store.save(evt(Kind.Comment, 1));
    const q = quotaFor(store, ME, 'posts', LIMITS, NOW);
    expect(q.daily.used).toBe(0);
  });
});
