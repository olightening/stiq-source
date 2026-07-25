import type {Event} from 'nostr-tools/pure';
import {buildThread, countComments, flattenThread} from './thread';
import {visibleNodes} from './collapse';
import {InMemoryEventStore} from '../nostr/store';

function comment(id: string, parentId: string, rootId: string, createdAt: number): Event {
  return {
    id,
    pubkey: 'u',
    created_at: createdAt,
    kind: 1111,
    tags: [['E', rootId, '', 'a'], ['e', parentId, '', 'a']],
    content: id,
    sig: 's',
  };
}

describe('thread builder', () => {
  it('nests replies under their parent and survives from the cache', () => {
    const store = new InMemoryEventStore();
    store.save(comment('c1', 'p1', 'p1', 1)); // top-level on post p1
    store.save(comment('c2', 'c1', 'p1', 2)); // reply to c1
    store.save(comment('c3', 'p1', 'p1', 3)); // another top-level
    store.save(comment('x', 'q', 'q', 1)); // different thread

    const tree = buildThread(store, 'p1');
    expect(tree.map(n => n.event.id)).toEqual(['c1', 'c3']);
    expect(tree[0]!.children.map(n => n.event.id)).toEqual(['c2']);
    expect(tree[0]!.depth).toBe(0);
    expect(tree[0]!.children[0]!.depth).toBe(1);
    expect(countComments(tree)).toBe(3);
    expect(flattenThread(tree).map(n => n.event.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('excludes author\'s-note pins — a note lives in its own block, never in the thread', () => {
    const store = new InMemoryEventStore();
    store.save(comment('c1', 'p1', 'p1', 1));
    // An author's-note pin: a kind-1111 on the same post, carrying the stiq-pin marker.
    store.save({
      id: 'note1', pubkey: 'a', created_at: 2, kind: 1111,
      tags: [['E', 'p1', '', 'a'], ['e', 'p1', '', 'a'], ['stiq-pin', 'p1']],
      content: "author's note", sig: 's',
    });
    const tree = buildThread(store, 'p1');
    expect(tree.map(n => n.event.id)).toEqual(['c1']); // note1 is NOT a thread comment
    expect(countComments(tree)).toBe(1);
  });

  it('hides descendants of a collapsed node', () => {
    const store = new InMemoryEventStore();
    store.save(comment('c1', 'p1', 'p1', 1));
    store.save(comment('c2', 'c1', 'p1', 2));
    const tree = buildThread(store, 'p1');

    const collapsed = new Set(['c1']);
    expect(visibleNodes(tree, collapsed).map(n => n.event.id)).toEqual(['c1']); // c2 hidden
    expect(visibleNodes(tree, new Set()).map(n => n.event.id)).toEqual(['c1', 'c2']);
  });
});
