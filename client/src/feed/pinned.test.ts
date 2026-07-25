import {buildPinnedComment, loadPinnedHistory} from './pinned';
import {InMemoryEventStore} from '../nostr/store';
import {Kind} from '../nostr/events';
import type {EventRef} from './comments';
import type {Event} from 'nostr-tools/pure';

const AUTHOR = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const POST_ID = 'p'.repeat(64);

const postRef: EventRef = {id: POST_ID, pubkey: AUTHOR, kind: Kind.Post};

function makePin(content: string, pubkey: string, createdAt: number): Event {
  return {
    id: content.replace(/\s/g, '').slice(0, 8).padEnd(64, '0'),
    pubkey,
    created_at: createdAt,
    kind: Kind.Comment,
    tags: [
      ['E', POST_ID, '', AUTHOR],
      ['K', '1'],
      ['P', AUTHOR],
      ['e', POST_ID, '', AUTHOR],
      ['k', '1'],
      ['p', AUTHOR],
      ['stiq-pin', POST_ID],
    ],
    content,
    sig: 's'.repeat(128),
  };
}

describe('buildPinnedComment', () => {
  it('includes the stiq-pin marker tag', () => {
    const unsigned = buildPinnedComment('Hello', postRef);
    expect(unsigned.tags).toContainEqual(['stiq-pin', POST_ID]);
    expect(unsigned.kind).toBe(Kind.Comment);
  });
  it('throws on empty content', () => {
    expect(() => buildPinnedComment('  ', postRef)).toThrow('empty');
  });
});

describe('loadPinnedHistory', () => {
  it('returns null for a post with no pins', () => {
    const store = new InMemoryEventStore();
    const r = loadPinnedHistory(store, POST_ID, AUTHOR);
    expect(r.latest).toBeNull();
    expect(r.history).toHaveLength(0);
  });

  it('returns latest + history sorted oldest-first', () => {
    const store = new InMemoryEventStore();
    const p1 = makePin('first edit', AUTHOR, 1000);
    const p2 = makePin('second edit', AUTHOR, 2000);
    const p3 = makePin('third edit', AUTHOR, 3000);
    store.save(p1); store.save(p2); store.save(p3);

    const r = loadPinnedHistory(store, POST_ID, AUTHOR);
    expect(r.latest?.content).toBe('third edit');
    expect(r.history.map(e => e.content)).toEqual(['first edit', 'second edit']);
  });

  it('ignores pins from other authors', () => {
    const store = new InMemoryEventStore();
    store.save(makePin('imposter pin', OTHER, 1000));
    const r = loadPinnedHistory(store, POST_ID, AUTHOR);
    expect(r.latest).toBeNull();
  });
});
