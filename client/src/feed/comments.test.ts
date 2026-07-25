import {generateSecretKey, getPublicKey, verifyEvent, type Event} from 'nostr-tools/pure';
import {
  buildComment,
  buildNoteComment,
  buildPostComment,
  isStiqComment,
  publishComment,
  commentParentAuthor,
  commentParentId,
  commentRootAuthor,
  commentRootId,
  refOf,
  type EventRef,
} from './comments';
import {KeyStore, InMemorySecureStorage} from '../keys/keystore';

const post: Event = {
  id: 'post1',
  pubkey: 'author',
  created_at: 1,
  kind: 1,
  tags: [],
  content: 'p',
  sig: 's',
};

describe('comment event model', () => {
  it('builds a top-level comment with root = parent = the post', () => {
    const c = buildComment('nice', refOf(post), refOf(post));
    expect(c.kind).toBe(1111);
    expect(c.tags).toContainEqual(['E', 'post1', '', 'author']);
    expect(c.tags).toContainEqual(['e', 'post1', '', 'author']);
    expect(c.tags).toContainEqual(['K', '1']);
    expect(c.tags).toContainEqual(['k', '1']);
  });

  it('builds a reply: root = post, parent = the comment', () => {
    const comment: Event = {...post, id: 'c1', pubkey: 'commenter', kind: 1111};
    const reply = buildComment('agreed', refOf(post), refOf(comment));
    expect(reply.tags).toContainEqual(['E', 'post1', '', 'author']); // root
    expect(reply.tags).toContainEqual(['e', 'c1', '', 'commenter']); // parent
    expect(reply.tags).toContainEqual(['k', '1111']);
  });

  it('rejects empty content', () => {
    expect(() => buildComment('  ', refOf(post), refOf(post))).toThrow(/empty/);
  });

  it('NIP-22 hybrid: a comment on a kind-1 note is a kind-1 stiq-comment with NIP-10 tags', () => {
    const c = buildPostComment('hi', refOf(post), refOf(post));
    expect(c.kind).toBe(1);
    expect(c.tags).toContainEqual(['e', 'post1', '', 'root']);
    expect(c.tags).toContainEqual(['p', 'author', '', 'root']);
    expect(c.tags).toContainEqual(['t', 'stiq-comment']);
  });

  it('NIP-22 hybrid: a comment on a non-kind-1 root stays kind-1111', () => {
    const poll: Event = {...post, id: 'poll1', kind: 1068};
    const c = buildPostComment('hi', refOf(poll), refOf(poll));
    expect(c.kind).toBe(1111);
  });

  it('hybrid root/parent accessors + isStiqComment work on the kind-1 form', () => {
    const top = {...post, id: 'sc1', pubkey: 'u1', kind: 1,
      tags: [['e', 'post1', '', 'root'], ['p', 'author'], ['t', 'stiq-comment']]} as Event;
    const reply = {...post, id: 'sc2', pubkey: 'u2', kind: 1,
      tags: [['e', 'post1', '', 'root'], ['e', 'sc1', '', 'reply'], ['t', 'stiq-comment']]} as Event;
    expect(isStiqComment(top)).toBe(true);
    expect(isStiqComment(post)).toBe(false);
    expect(commentRootId(top)).toBe('post1');
    expect(commentParentId(top)).toBe('post1'); // top-level → parent is the root
    expect(commentRootId(reply)).toBe('post1');
    expect(commentParentId(reply)).toBe('sc1');  // reply → parent is the comment
  });

  it('signs a valid comment via the keystore', async () => {
    const store = new KeyStore(new InMemorySecureStorage());
    const sk = generateSecretKey();
    await store.enroll(sk);

    const event = await publishComment(store, 'hi', refOf(post), refOf(post));
    expect(verifyEvent(event)).toBe(true);
    expect(event.kind).toBe(1111);
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(commentParentId(event)).toBe('post1');
    expect(commentRootId(event)).toBe('post1');
  });

  it('returns null parent/root for a non-comment', () => {
    expect(commentParentId(post)).toBeNull();
    expect(commentRootId(post)).toBeNull();
  });

  describe('commentRootAuthor', () => {
    it('reads the uppercase P tag for a kind-1111 comment', () => {
      const comment: Event = {...post, id: 'c1', pubkey: 'commenter', kind: 1111,
        tags: [['E', 'post1', '', 'author'], ['K', '1'], ['P', 'author']]};
      expect(commentRootAuthor(comment)).toBe('author');
    });

    it("reads the 'root'-marked p tag for a hybrid reply, not the parent p tag", () => {
      const reply = {...post, id: 'sc2', pubkey: 'u2', kind: 1,
        tags: [
          ['e', 'post1', '', 'root'],
          ['e', 'sc1', '', 'reply'],
          ['p', 'author', '', 'root'],
          ['p', 'u1', '', 'reply'],
          ['t', 'stiq-comment'],
        ]} as Event;
      expect(commentRootAuthor(reply)).toBe('author');
    });

    it('LEGACY (unmarked p tags): falls back to the FIRST lowercase p tag as the root author', () => {
      // The pre-marker wire shape, which is still on relays and in local stores: role was carried by
      // emission ORDER alone. Readers must keep resolving it exactly as the old producer meant it.
      const reply = {...post, id: 'sc2', pubkey: 'u2', kind: 1,
        tags: [
          ['e', 'post1', '', 'root'],
          ['e', 'sc1', '', 'reply'],
          ['p', 'author'], // root author (first)
          ['p', 'u1'],     // parent author (second)
          ['t', 'stiq-comment'],
        ]} as Event;
      expect(commentRootAuthor(reply)).toBe('author');
    });

    it('returns null for a non-comment kind-1 note', () => {
      expect(commentRootAuthor(post)).toBeNull();
    });

    it('returns null for an untagged comment', () => {
      const untaggedNip22: Event = {...post, id: 'c2', pubkey: 'commenter', kind: 1111, tags: []};
      expect(commentRootAuthor(untaggedNip22)).toBeNull();

      const untaggedHybrid = {...post, id: 'sc3', pubkey: 'u3', kind: 1,
        tags: [['t', 'stiq-comment']]} as Event;
      expect(commentRootAuthor(untaggedHybrid)).toBeNull();
    });
  });

  describe('commentParentAuthor', () => {
    it('reads the lowercase p tag for a kind-1111 comment', () => {
      const comment: Event = {...post, id: 'c1', pubkey: 'commenter', kind: 1111,
        tags: [['E', 'post1', '', 'author'], ['P', 'author'], ['e', 'c0', '', 'prev'], ['p', 'prev-author']]};
      expect(commentParentAuthor(comment)).toBe('prev-author');
    });

    it("reads the 'reply'-marked p tag for a nested hybrid reply (root and parent differ)", () => {
      const reply = {...post, id: 'sc2', pubkey: 'u2', kind: 1,
        tags: [
          ['e', 'post1', '', 'root'],
          ['e', 'sc1', '', 'reply'],
          ['p', 'author', '', 'root'],
          ['p', 'u1', '', 'reply'],
          ['t', 'stiq-comment'],
        ]} as Event;
      expect(commentParentAuthor(reply)).toBe('u1');
      expect(commentRootAuthor(reply)).toBe('author'); // sanity: root/parent authors genuinely differ
    });

    it('resolves roles from MARKERS, not tag order (the whole point of the marked format)', () => {
      // Same event as above with the two 'p' tags emitted in the OPPOSITE order. Under the old
      // positional format this inverted root/parent and silently misattributed the thread; under the
      // marked format the roles are carried by the tags themselves, so order cannot change the answer.
      const reply = {...post, id: 'sc2', pubkey: 'u2', kind: 1,
        tags: [
          ['e', 'post1', '', 'root'],
          ['e', 'sc1', '', 'reply'],
          ['p', 'u1', '', 'reply'],     // parent FIRST this time
          ['p', 'author', '', 'root'],  // root SECOND
          ['t', 'stiq-comment'],
        ]} as Event;
      expect(commentParentAuthor(reply)).toBe('u1');
      expect(commentRootAuthor(reply)).toBe('author');
    });

    it('top-level hybrid comment (real builder): one marked p tag, parent author = root author', () => {
      // Exercises the ACTUAL builder, not a hand-rolled tag list. A top-level comment's parent IS the
      // root, so there is no 'reply' role to state and the single 'root'-marked tag answers both.
      const root: EventRef = {id: 'post1', pubkey: 'author', kind: 1};
      const unsigned = buildNoteComment('hi', root, root);
      expect(unsigned.tags.filter(t => t[0] === 'p')).toEqual([['p', 'author', '', 'root']]);
      const ev: Event = {...unsigned, id: 'sc-top', pubkey: 'commenter', sig: 's'};
      expect(commentParentAuthor(ev)).toBe('author');
      expect(commentParentAuthor(ev)).toBe(commentRootAuthor(ev));
    });

    it('nested hybrid reply whose parent is authored by the root author (real builder): states BOTH roles', () => {
      // The case the old format could not express: a daughter of a comment that the root author wrote.
      // It used to collapse to a single 'p' tag, making it indistinguishable from a top-level comment.
      // Both roles are now stated explicitly — the same pubkey twice, under different markers.
      const root: EventRef = {id: 'post1', pubkey: 'author', kind: 1};
      const parentComment: EventRef = {id: 'sc1', pubkey: 'author', kind: 1}; // same author as root
      const unsigned = buildNoteComment('nested', root, parentComment);
      expect(unsigned.tags.filter(t => t[0] === 'p')).toEqual([
        ['p', 'author', '', 'root'],
        ['p', 'author', '', 'reply'],
      ]);
      const ev: Event = {...unsigned, id: 'sc-nested', pubkey: 'commenter', sig: 's'};
      expect(commentParentAuthor(ev)).toBe('author');
      expect(commentRootAuthor(ev)).toBe('author');
      // ...and it is now distinguishable from a top-level comment, which the old format could not do.
      expect(commentParentId(ev)).toBe('sc1');
      expect(commentRootId(ev)).toBe('post1');
    });

    it('LEGACY (unmarked p tags): two tags → the SECOND is the parent author', () => {
      const reply = {...post, id: 'sc2', pubkey: 'u2', kind: 1,
        tags: [
          ['e', 'post1', '', 'root'],
          ['e', 'sc1', '', 'reply'],
          ['p', 'author'], // root author
          ['p', 'u1'],     // parent (the comment) author
          ['t', 'stiq-comment'],
        ]} as Event;
      expect(commentParentAuthor(reply)).toBe('u1');
      expect(commentRootAuthor(reply)).toBe('author');
    });

    it('LEGACY (unmarked p tags): one tag → the parent author IS the root author', () => {
      const top = {...post, id: 'sc1', pubkey: 'u1', kind: 1,
        tags: [['e', 'post1', '', 'root'], ['p', 'author'], ['t', 'stiq-comment']]} as Event;
      expect(commentParentAuthor(top)).toBe('author');
      expect(commentRootAuthor(top)).toBe('author');
    });

    it('returns null for a non-comment kind-1 note', () => {
      expect(commentParentAuthor(post)).toBeNull();
    });

    it('returns null for an untagged comment', () => {
      const untaggedNip22: Event = {...post, id: 'c2', pubkey: 'commenter', kind: 1111, tags: []};
      expect(commentParentAuthor(untaggedNip22)).toBeNull();

      const untaggedHybrid = {...post, id: 'sc3', pubkey: 'u3', kind: 1,
        tags: [['t', 'stiq-comment']]} as Event;
      expect(commentParentAuthor(untaggedHybrid)).toBeNull();
    });
  });
});
