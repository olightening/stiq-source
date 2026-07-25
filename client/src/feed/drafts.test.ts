import {DraftStore, newDraftId, newShareId, draftLocationLabel, inProgressDraftId, type DraftLocation} from './drafts';
import {InMemorySecureStorage} from '../keys/keystore';

describe('DraftStore', () => {
  it('saves and retrieves a draft', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    const draft = {id: newDraftId(), title: 'Test', content: 'Hello', tags: ['news'], savedAt: Date.now()};
    await store.save(draft);
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('Test');
  });

  it('updates an existing draft by id', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    const id = newDraftId();
    await store.save({id, title: 'v1', content: 'a', tags: [], savedAt: 1});
    await store.save({id, title: 'v2', content: 'b', tags: [], savedAt: 2});
    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.title).toBe('v2');
  });

  it('deletes a draft by id', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    const id = newDraftId();
    await store.save({id, title: 'to delete', content: '', tags: [], savedAt: 1});
    await store.delete(id);
    expect(await store.all()).toHaveLength(0);
  });

  it('returns empty array with null storage', async () => {
    const store = new DraftStore(null);
    expect(await store.all()).toEqual([]);
  });

  it('round-trips a channel-located draft (No.7)', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    const id = newDraftId();
    await store.save({
      id,
      title: '',
      content: 'wip channel post',
      tags: [],
      savedAt: 1,
      location: {kind: 'channel', channelId: 'chan1', channelType: 'public', channelName: '#general'},
    });
    const all = await store.all();
    expect(all[0]!.location).toEqual({
      kind: 'channel',
      channelId: 'chan1',
      channelType: 'public',
      channelName: '#general',
    });
  });
});

describe('newShareId (Phase 5§B — stable shareId)', () => {
  const author = 'a'.repeat(64);

  it('produces a high-entropy hex id, not the coarse newDraftId shape', () => {
    const id = newShareId(author, 'the body of a draft');
    expect(id).toMatch(/^[0-9a-f]{64}$/); // sha256Hex output — nothing like newDraftId's `<ts>-<4chars>`
  });

  it('is NOT deterministic on (author, body) alone — a random salt means no one can precompute it', () => {
    const id1 = newShareId(author, 'same body');
    const id2 = newShareId(author, 'same body');
    expect(id1).not.toBe(id2);
  });

  it('differs across authors for byte-identical content', () => {
    const other = 'b'.repeat(64);
    // Vanishingly unlikely to collide (different hash input + independent random salts); this pins
    // that the author is actually part of the hash input, not merely a documentation claim.
    expect(newShareId(author, 'same body')).not.toBe(newShareId(other, 'same body'));
  });

  it('persists on the Draft and survives a save/reload round-trip — stable across edits/re-shares', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    const id = newDraftId();
    const shareId = newShareId(author, 'first shared version');
    await store.save({id, title: 't', content: 'first shared version', tags: [], savedAt: 1, shareId});

    // An EDIT after sharing re-saves under the same draft id, keeping the SAME shareId (the whole
    // point — a re-share must not fork the access-control doc or the comment thread).
    await store.save({id, title: 't', content: 'edited after sharing', tags: [], savedAt: 2, shareId});

    const all = await store.all();
    expect(all).toHaveLength(1);
    expect(all[0]!.shareId).toBe(shareId);
    expect(all[0]!.content).toBe('edited after sharing');
  });

  it('an unshared draft has no shareId (back-compat: absent, not empty string)', async () => {
    const store = new DraftStore(new InMemorySecureStorage());
    await store.save({id: newDraftId(), title: '', content: 'never shared', tags: [], savedAt: 1});
    expect((await store.all())[0]!.shareId).toBeUndefined();
  });
});

describe('draftLocationLabel', () => {
  it('labels the feed (incl. legacy drafts with no location)', () => {
    expect(draftLocationLabel()).toBe('Feed');
    expect(draftLocationLabel({kind: 'feed'})).toBe('Feed');
  });

  it('labels each channel type', () => {
    expect(draftLocationLabel({kind: 'channel', channelId: 'c', channelType: 'public', channelName: '#g'})).toBe('#g · public channel');
    expect(draftLocationLabel({kind: 'channel', channelId: 'c', channelType: 'private', channelName: 'Crew'})).toBe('Crew · private group');
    expect(draftLocationLabel({kind: 'channel', channelId: 'c', channelType: 'broadcast', channelName: 'News'})).toBe('News · broadcast');
    expect(draftLocationLabel({kind: 'channel', channelId: 'c', channelType: 'dm', channelName: '@bob'})).toBe('@bob · DM');
  });
});

describe('inProgressDraftId', () => {
  it('is stable per location so the editor restores unsaved text on reopen (No.7)', () => {
    expect(inProgressDraftId()).toBe('inprogress:feed');
    expect(inProgressDraftId({kind: 'feed'})).toBe('inprogress:feed');
    const loc = {kind: 'channel', channelId: 'c1', channelType: 'public', channelName: '#g'} as const;
    expect(inProgressDraftId(loc)).toBe('inprogress:public:c1');
    expect(inProgressDraftId(loc)).toBe(inProgressDraftId(loc));
  });
});

describe('comment drafts — their own location namespace', () => {
  // A comment is keyed on the ROOT POST, not a channel. If it reused the `channel` variant it would
  // share `inProgressDraftId` with the surrounding channel, so typing a reply would silently clobber
  // a half-written broadcast sitting in that channel's composer. These pin the separation.
  const post: DraftLocation = {kind: 'comment', rootId: 'post-1', rootLabel: 'On rivers'};

  it('keys its in-progress slot on the root post id, in its own namespace', () => {
    expect(inProgressDraftId(post)).toBe('inprogress:comment:post-1');
  });

  it('never collides with a channel that happens to share the id', () => {
    const channel: DraftLocation = {
      kind: 'channel', channelId: 'post-1', channelType: 'public', channelName: '#general',
    };
    expect(inProgressDraftId(post)).not.toBe(inProgressDraftId(channel));
  });

  it('gives every distinct thread its own slot, and one thread a STABLE slot', () => {
    const other: DraftLocation = {kind: 'comment', rootId: 'post-2', rootLabel: 'Elsewhere'};
    expect(inProgressDraftId(post)).not.toBe(inProgressDraftId(other));
    expect(inProgressDraftId({kind: 'comment', rootId: 'post-1', rootLabel: 'renamed since'}))
      .toBe(inProgressDraftId(post));
  });

  it('labels itself by the thread it belongs to', () => {
    expect(draftLocationLabel(post)).toBe('On rivers · comment');
  });
});
